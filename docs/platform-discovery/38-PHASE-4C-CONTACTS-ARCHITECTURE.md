# 38 — Phase 4C Architecture: Contactpersonen & Commerciële Relaties

**Status**: Architectuurvoorstel, geen implementatie. Vervolg op
`37-PHASE-4C-CONTACTS-DISCOVERY.md`. Het identiteitsvraagstuk
(`CustomerContact` ↔ `ExternalContactMatch`) is vastgelegd in
`docs/architecture/ADR-010-CUSTOMER-CONTACT-MODEL.md` — dit document herhaalt
die beslissing niet, maar bouwt erop voort.

## 1. Businesssemantiek: klant vs. contactpersoon

Een `CustomerProfile` blijft **de klantidentiteit** (Shopify-gekoppeld,
ADR-002) — ongeacht of die ene persoon of een bedrijf representeert.
`CustomerContact` is een **aanvullende, optionele verzameling personen**
onder die klant, nooit een vervanging. Een `CustomerProfile` zonder een
enkele `CustomerContact`-rij blijft volledig geldig en functioneel (de
Shopify-snapshot `displayName`/`email`/`phone` blijft altijd de impliciete
"standaard"-persoon zolang niemand expliciet contacten heeft toegevoegd) —
geen backfill, geen verplichting.

Eén-op-veel, nooit veel-op-veel (discovery §3/architectuurdoc ADR-010 §1):
een contactpersoon hoort bij precies één `CustomerProfile`.

## 2. Datamodel

```prisma
model CustomerContact {
  id                String          @id @default(cuid())
  customerProfileId String
  customerProfile   CustomerProfile @relation(fields: [customerProfileId], references: [id], onDelete: Cascade)

  displayName String
  jobTitle    String?

  email           String?
  emailNormalized String?
  phone           String?
  phoneNormalized String?

  isPrimary        Boolean @default(false)
  isDecisionMaker  Boolean @default(false)
  isBillingContact Boolean @default(false)

  archivedAt DateTime?
  createdAt  DateTime  @default(now())
  updatedAt  DateTime  @updatedAt

  createdById String
  createdBy   User     @relation(fields: [createdById], references: [id])

  externalMatches ExternalContactMatch[]
  // §12 — optioneel, zie daar voor welke modellen dit werkelijk krijgen.
  appointments    Appointment[]
  tasks           Task[]
  notes           Note[]

  @@index([customerProfileId])
  @@index([emailNormalized])
  @@index([phoneNormalized])
}
```

**Bewust weggelaten t.o.v. het geschetste voorbeeldmodel** (instructie §3
vroeg expliciet om dit niet klakkeloos over te nemen):

- **Geen `firstName`/`lastName`-splitsing.** Nergens elders in dit systeem
  wordt een naam gesplitst (`User.name`, `CustomerProfile.displayName` zijn
  beide één veld) — een tweede conventie invoeren voor precies één nieuw
  model levert geen aantoonbare waarde op (geen sortering-op-achternaam-
  functie is gevraagd) en kost wel complexiteit (Nederlandse
  tussenvoegsels: "de Vries" correct splitsen is notoir foutgevoelig).
- **Geen apart `mobile`-veld naast `phone`.** Het businessvoorbeeld noemt
  per persoon precies één nummer (mobiel óf vast) — nooit beide
  tegelijk relevant. Eén `phone`-veld (net als `CustomerProfile.phone`
  vandaag al doet) dekt zowel het weergave- als het matchdoel; een tweede
  nummerveld verdubbelt de matching-oppervlakte zonder een concreet
  gebruiksscenario dat dat vraagt. Als dat later wel nodig blijkt, is het
  een triviale additieve kolom — geen reden om nu vooruit te bouwen.
- **Geen apart `department`-veld.** Het voorbeeld "Administratie" als
  contactpersoon past prima als `displayName = "Administratie"` met een
  lege of vrije `jobTitle` — een los `department`-veld zou zelden anders
  ingevuld worden dan wat `displayName`/`jobTitle` al uitdrukken.
- **Geen `notes`-tekstveld op het model zelf.** `Note` bestaat al als
  volwaardig, doorzoekbaar, geauditeerd model (ADR-003). §12 hieronder geeft
  `Note` een optionele `customerContactId` — dat is de juiste plek voor
  vrije context bij een contactpersoon, niet een schaduw-tekstveld dat
  dezelfde informatie dupliceert zonder de bestaande Notities-tab, -zoekfunctie
  of -audit te delen.

**Wel bewust behouden**: drie losse booleans i.p.v. een rollen-enum (zie §8
hieronder voor de onderbouwing) en zowel het ruwe als het genormaliseerde
e-mail/telefoonveld — exact hetzelfde patroon als `CustomerProfile.phone`/
`phoneNormalized`, nodig omdat matching (§4/ADR-010 §3) altijd op de
genormaliseerde vorm zoekt, terwijl de UI het origineel toont.

## 3. Normalisatie

Hergebruikt **exact** de bestaande, centrale normalizers — geen tweede
implementatie:

- `normalizeDutchPhone()` (`src/lib/phone.ts`) → `phoneNormalized`.
- `normalizeEmail()` (`src/lib/email.ts`) → `emailNormalized`.

Beide worden **server-side** herberekend bij elke create/update (nooit
vertrouwd vanuit de client), exact zoals `CustomerProfile.phoneNormalized`
en `ExternalContactMatch.externalRef` dat al doen. Ontbrekende e-mail of
telefoon is toegestaan (beide velden nullable) — een contactpersoon met
alleen een naam en functietitel is een geldige rij (bv. iemand die je wilt
vastleggen voordat je zijn gegevens hebt).

## 4. `ExternalContactMatch`-relatie en matching

Vastgelegd in `ADR-010-CUSTOMER-CONTACT-MODEL.md` §2–§4: optionele
`customerContactId` op de bestaande `ExternalContactMatch`-rij, geen nieuwe
identiteitstabel; `resolveAndRecordByEmail()`/`resolveAndRecordByPhone()`
doorzoeken voortaan ook `CustomerContact.emailNormalized`/`phoneNormalized`
(niet-gearchiveerd) naast `CustomerProfile.email`/`phoneNormalized`. Zie
ADR-010 §4 voor de volledige waarheidstabel (exacte klant+contact, exacte
klant zonder contact, contact-ambigu-binnen-klant, klant-ambigu-tussen-
klanten, gearchiveerd contact).

## 5. Live-federated lookups moeten de contactadressen meekrijgen

De kern-bevinding uit discovery §1.3: zonder deze aanpassing blijft een
correct geregistreerd contact **onzichtbaar** in e-mail/bel-secties, ook al
is de matching-laag zelf uitgebreid. `src/app/(app)/customers/[id]/page.tsx`
bouwt vandaag:

```ts
const phoneNumbers = [normalizeDutchPhone(data.profile.phone)].filter(Boolean);
const emailAddresses = [data.profile.email].filter(Boolean);
```

Wordt:

```ts
const contacts = await listContactsForCustomer(id); // niet-gearchiveerd
const phoneNumbers = [data.profile.phone, ...contacts.map((c) => c.phone)]
  .map(normalizeDutchPhone).filter((p): p is string => !!p);
const emailAddresses = [data.profile.email, ...contacts.map((c) => c.email)]
  .filter((e): e is string => !!e);
```

Eén extra, goedkope query (`listContactsForCustomer`, al gebatcht nodig voor
de Contactpersonen-sectie zelf, §6 — geen extra databasekosten). Dezelfde
uitbreiding geldt voor de Opportunity-detailpagina, die vandaag hetzelfde
enkelvoudige patroon gebruikt voor `phoneNumbers`/`emailAddresses` op
klantniveau.

**Geen wijziging** aan `getMessagesForAddresses()`/
`getActivityForPhoneNumbers()` zelf — ze ontvangen gewoon een langere array,
exact zoals hun bestaande signatuur al toestaat.

## 6. Contactpersonen op Customer 360

Nieuwe sectie op de **Overzicht**-tab (geen nieuwe top-level tab — instructie
§8 expliciet, en consistent met hoe `OpenOpportunitiesBlock` daar al staat):

```
Contactpersonen                              [ + Contactpersoon ]
┌─────────────────────────────────────────────┐
│ Jan Jansen              Eigenaar · Primair   │
│ jan@jansentuinen.nl · 06 12345678            │
│                                [bewerk] [⋯]  │
├─────────────────────────────────────────────┤
│ Piet de Vries           Uitvoerder           │
│ piet@jansentuinen.nl · 06 87654321           │
│                                [bewerk] [⋯]  │
└─────────────────────────────────────────────┘
```

Sortering: primair contact eerst, dan op `displayName`. Quick actions
(instructie §8, alleen wat de bestaande UI al ondersteunt):

- E-mailadres: `mailto:`-link + kopieerknop (bestaand patroon, zie
  `RecentEmailsBlock`/`OpportunityCommercialLinks` voor vergelijkbare
  kopieerknoppen elders).
- Telefoonnummer: `tel:`-link indien de bestaande UI dat al elders doet
  (te bevestigen tijdens bouw — geen nieuwe belfunctionaliteit bouwen, puur
  een link).
- Bewerken (dialoog, zelfde patroon als `NewOpportunityDialog`).
- Archiveren/herstellen (§16).

**Geen** SMTP/mail-verzendfunctionaliteit — expliciet buiten scope (instructie
§8/§26).

## 7. Primair contact

Server-side afgedwongen: maximaal één actief (niet-gearchiveerd) primair
contact per `CustomerProfile`. Bij het instellen van een nieuwe primaire
contactpersoon (op create met `isPrimary: true`, of via een expliciete
`setPrimaryContact()`-actie):

```ts
await prisma.$transaction(async (tx) => {
  await tx.customerContact.updateMany({
    where: { customerProfileId, isPrimary: true, id: { not: newPrimaryId } },
    data: { isPrimary: false },
  });
  await tx.customerContact.update({ where: { id: newPrimaryId }, data: { isPrimary: true } });
});
```

Zelfde patroon als `confirmMatch()` (matching.service.ts) en
`changeStage()`/`markWon()` (opportunity.service.ts) — een bestaande,
bewezen aanpak in deze codebase, geen nieuw concept. Een aparte
`AuditAction` (`customer_contact.primary_changed`) markeert dit expliciet
(instructie §9), los van de generieke `customer_contact.updated`.

Geen database-partial-unique-index nodig bovenop de transactie — dit
patroon bestaat nergens anders in dit schema (geen precedent) en de
transactie-garantie is voor de verwachte schaal (tientallen contacten per
klant, geen hoogfrequente concurrency) voldoende, dezelfde afweging als
elders in dit project (Phase 4B §19: geen achtergrondproces "tenzij
aantoonbaar noodzakelijk").

## 8. Contact roles

Drie booleans (`isPrimary`, `isDecisionMaker`, `isBillingContact`) +
vrije-tekst `jobTitle`, **geen enum**. Onderbouwing: de drie rollen zijn
niet wederzijds exclusief (de eigenaar is vaak ook de beslisser én
degene die facturen ontvangt bij een klein bedrijf) — een enum zou een
kunstmatige "kies er één"-beperking opleggen die de praktijk (instructie's
eigen voorbeeld: Jan is eigenaar én impliciet beslisser én mogelijk
primair) tegenspreekt. `jobTitle` blijft vrije tekst ("Eigenaar",
"Uitvoerder", "Inkoop") — een rollen-enum zou nooit alle functietitels
kunnen dekken zonder voortdurend uitgebreid te worden (exact de
"enum-explosie" die de instructie wil vermijden).

## 9. Opportunity-contactrelatie — bewust (nog) niet bouwen

Instructie §11 vraagt expliciet: bouw dit alleen als het echte waarde heeft,
niet omdat een CRM dat "meestal heeft." Er is in de gegeven businesscase
geen concreet, wrijvingspunt aangetoond dat een aparte
`Opportunity.primaryContactId`-koppeling zou oplossen — de opportunity-
detailpagina kan de klant se contactenlijst gewoon **leesbaar tonen**
(§10 hieronder) zonder een eigen koppelveld. **Aanbeveling: niet in Phase
4C-A bouwen.** Mocht een latere fase een concreet scenario aandragen (bv.
"stuur de offerte automatisch naar de juiste contactpersoon"), dan is een
enkele nullable `Opportunity.primaryContactId String?` (zelfde eenvoud als
`ownerUserId`) de juiste minimale toevoeging — nooit een
many-to-many-`OpportunityContact`-tabel, waarvoor geen enkel gegeven
scenario in de opdracht een concrete meervoudige relatie aantoont.

## 10. Opportunity-detail — leesweergave

Toont (indien de klant contacten heeft) een compacte, alleen-lezen lijst
"Contactpersonen bij deze klant" — identieke brondata als Customer 360,
opgehaald via dezelfde `listContactsForCustomer()`, **geen duplicaat-opslag
op Opportunity** (instructie §20 expliciet). Quick action "contact
koppelen" is **uitgesteld** samen met §9 — zonder een koppelveld op
`Opportunity` is er niets om te "koppelen"; deze actie hoort bij een
eventuele latere `primaryContactId`-toevoeging, niet bij deze fase.

## 11. Task / Appointment / Note

Alle drie krijgen een optionele `customerContactId String?` (nullable FK),
**exact hetzelfde bewezen patroon** als `opportunityId` op dezelfde drie
modellen (ADR-009 §5: service-laag leidt/valideert af, nooit
caller-vertrouwd — hier: `customerContactId` moet, indien gezet, bij
dezelfde `customerProfileId` horen als de rij zelf, anders
`OpportunityValidationError`-achtige fout, geen stille foutieve koppeling).

- **`Appointment`**: duidelijke waarde — "met wie is deze afspraak" is een
  natuurlijke vraag die vandaag niet te beantwoorden is.
- **`Task`**: duidelijke waarde — "Jan terugbellen"-achtige taken krijgen een
  klikbare koppeling naar Jan's gegevens i.p.v. alleen vrije tekst.
- **`Note`**: duidelijke waarde — vervangt het overwogen-en-verworpen
  `notes`-veld op `CustomerContact` zelf (§2).
- **`File`**: **niet toegevoegd** in 4C-A — geen concreet scenario
  aangedragen (instructie §12 noemt File niet expliciet), en "dit bestand
  hoort bij deze persoon" is zelden een onderscheidende vraag t.o.v. "dit
  bestand hoort bij deze klant." Kan later alsnog additief toegevoegd worden
  als een concreet gebruiksgeval opduikt.

Geen wijziging aan bestaande verplichte/optionele velden — puur additief,
zelfde migratie-vorm als de vier bestaande `opportunityId`-kolommen.

## 12. Activity/Timeline-verrijking

Pure, in-memory cross-referentie op al-opgehaalde data — **geen nieuwe
query per timeline-item**, zelfde principe als Phase 4B's Shopify/quote-
signalen (`src/modules/opportunities/attention.ts`):

```ts
function matchContactForAddress(contacts: CustomerContactSummary[], normalizedEmail: string | null) {
  if (!normalizedEmail) return null;
  return contacts.find((c) => c.emailNormalized === normalizedEmail && !c.archivedAt) ?? null;
}
```

`emailToTimelineItem()` (`src/modules/activity/timeline.ts`) gebruikt dit om
de titel te verrijken: "E-mail van Jan Jansen" i.p.v. de rauwe
berichtkop-naam, **alleen** bij een exacte match — bij geen match blijft het
bestaande gedrag (headernaam/adres) ongewijzigd. Zelfde voor
telefoongesprek-items (`call.title`/nummer → contactnaam indien exact
bekend). Nooit een nieuwe externe aanroep, nooit een gefabriceerde naam.

## 13. Search / command palette

Nieuwe command-palette-groep `contacts` in `src/app/api/search/route.ts`,
zelfde fail-isolatiepatroon als de bestaande groepen (eigen try/catch):

```ts
try {
  const contacts = await searchCustomerContacts(term, 8);
  if (contacts.length > 0) {
    groups.push({
      key: "contacts",
      label: "Contactpersonen",
      items: contacts.map((c) => ({
        id: c.id,
        kind: "contact" as const,
        title: c.displayName,
        subtitle: [c.customerProfile.displayName ?? c.customerProfile.companyName, c.email].filter(Boolean).join(" · "),
        href: `/customers/${c.customerProfileId}`,
      })),
    });
  }
} catch (error) { console.error("contact_search_failed", error); }
```

Zoekt op `displayName`/`email`/`phone`/`jobTitle` (contains, insensitive) —
**niet** op de klantnaam zelf (die vindt de gebruiker al via de bestaande
`customers`-groep). `take: 8`, geïndexeerde kolommen
(`customerProfileId`/`emailNormalized`/`phoneNormalized`) — geen zware
query, in lijn met instructie §19's expliciete waarschuwing.

**Bestaande klantzoekfunctie (`searchCustomers()`) blijft ongewijzigd** —
die is een live Shopify-zoekopdracht (ADR-002), geen plek om lokale
`CustomerContact`-data in te mengen. De command-palette-groep hierboven is
het juiste, aparte kanaal voor "zoek op contactpersoonnaam."

## 14. Shopify-relatie

Zie `ADR-010-CUSTOMER-CONTACT-MODEL.md` §5 — geen automatische promotie van
een Shopify-klant tot `CustomerContact`.

## 15. CRUD / RBAC

`requireWriteAccess()` (ADMIN/AGENT) voor create/update/archive/restore —
**geen** auteur-beperking zoals `Note` heeft (`assertCanModifyNote`).
Onderbouwing: een contactpersoon is een gedeeld "bedrijfstelefoonboek"-
record, geen persoonlijke aantekening van wie hem invoerde — elke
schrijfgerechtigde collega moet Piet's nieuwe mobiele nummer kunnen
bijwerken, ongeacht wie hem oorspronkelijk aanmaakte (zelfde redenering als
`CustomerTag`, dat ook geen auteur-restrictie heeft). VIEWER: uitsluitend
lezen, overal (Customer 360-sectie, command palette, API), consistent met
elke andere entiteit in dit systeem.

**Geen hard delete** — `archivedAt` (soft), met een expliciete
`restoreContact()` (in tegenstelling tot `Opportunity`, dat vandaag geen
restore-pad heeft): het risicoprofiel is anders. Een verkeerd gearchiveerde
opportunity zou een commerciële staatswijziging ongedaan maken die
rapportage-gevolgen heeft (vandaar bewust uitgesteld in Phase 4A); een
verkeerd gearchiveerde contactpersoon is puur data-hygiëne — een
onmiddellijk, laagrisico "oeps, verkeerde knop"-herstel is hier wél
gerechtvaardigd en voorkomt nodeloze frustratie.

Audit (nieuwe, ongetypeerde string-acties — geen schemawijziging nodig,
`AuditEvent.action: String`): `customer_contact.created`,
`customer_contact.updated`, `customer_contact.primary_changed`,
`customer_contact.archived`, `customer_contact.restored`.

## 16. Duplicates

**Geen database-unique-constraint** op (klant, e-mail) of (klant, telefoon)
— een gedeeld algemeen adres (`info@jansentuinen.nl` voor zowel Jan als
Piet) is legitiem en moet niet geblokkeerd worden (instructie §17
expliciet). In plaats daarvan: een **servicelaag-waarschuwing** (geen harde
blokkade) bij create/update wanneer dezelfde `emailNormalized`/
`phoneNormalized` al op een andere actieve contact van **dezelfde klant**
staat — de UI toont dit als een bevestigingsstap ("Piet heeft al dit
e-mailadres — toch doorgaan?"), nooit als een blokkerende fout. Cross-klant
duplicaten (hetzelfde adres bij twee verschillende klanten) worden **niet**
gewaarschuwd — dat is een normaal, verwacht scenario (een leverancier-
contactpersoon die ook bij een andere klant relevant is) en buiten de scope
van wat deze waarschuwing moet vangen.

## 17. Audit / privacy

Contactgegevens zijn persoonsgegevens (naam, e-mail, telefoon,
functietitel) — dezelfde gevoeligheidsklasse als `CustomerProfile.email`/
`phone`, die vandaag al door elke ingelogde rol (incl. VIEWER) gelezen kan
worden. Geen nieuwe blootstellingscategorie, dus geen nieuwe RBAC-laag
nodig bovenop wat al bestaat. **IDOR-verplichting**: elke
contact-mutatieroute (`/api/customers/[id]/contacts/[contactId]`) moet
verifiëren dat `contact.customerProfileId === id` uit de URL, vóór elke
schrijfactie — anders kan een geldig ingelogde gebruiker met het juiste
`contactId` maar het verkeerde `id` in de URL een contact van een andere
klant raken. Geen wachtwoorden/secrets betrokken. Geen exportfunctie, geen
GDPR-module — puur nette architectuur (soft-archivering, volledige
audittrail, geen ongeautoriseerde blootstelling).

## 18. Migration

Additief, twee wijzigingen:

1. Nieuw model `CustomerContact` (zie §2).
2. Nieuwe kolom `ExternalContactMatch.customerContactId String?` (nullable
   FK naar `CustomerContact`).

Geen wijziging aan bestaande kolommen op `CustomerProfile` of
`ExternalContactMatch`. Geen backfill — bestaande klanten zonder
contactpersonen blijven volledig geldig (`CustomerContact[]` leeg is de
normale, verwachte staat voor een particuliere klant of een bedrijf waarvan
nog niemand een contact heeft ingevoerd).

## 19. Performance

`listContactsForCustomer(customerProfileId)` — één query, geïndexeerd op
`customerProfileId`, gebruikt zowel door de Customer 360-sectie (§6) als
door de uitgebreide `phoneNumbers`/`emailAddresses`-opbouw (§5) — geen
dubbele query op dezelfde paginalaad. Command-palette-zoekopdracht (§13)
geïndexeerd op `emailNormalized`/`phoneNormalized`, `take: 8`. Geen enkele
nieuwe externe aanroep (Shopify/IMAP/PBX) per contact — matching-uitbreiding
(§4) draait uitsluitend binnen bestaande matching-aanroepen, timeline-
verrijking (§12) is pure in-memory cross-referentie.

## 20. Fasering — aanbeveling: één Phase 4C, interne buildvolgorde bepaalt risicospreiding

De instructie stelt een 4C-A/4C-B-knip voor, maar staat expliciet toe om
alles in één fase te bouwen als het klein en veilig genoeg blijft.
**Aanbeveling: één Phase 4C** (geen aparte sub-fase), om dezelfde reden als
Phase 4B in één fase gebouwd is: elk onderdeel is additief, laag-risico, en
het matching-laag-onderdeel (§4/§5) is wat deze feature daadwerkelijk
waardevol maakt — zonder dat blijft "contactpersonen" een statisch
telefoonboek zonder herkenning, een half afgemaakt gevoel. Risicospreiding
gebeurt via de **interne buildvolgorde** (§22 build spec), niet via een
formele fase-knip:

1. Datamodel + migratie + service-CRUD + RBAC/audit (laagste risico, geen
   afhankelijkheden).
2. Customer 360-sectie + command-palette-zoekgroep (UI, leest alleen de
   nieuwe data).
3. Matching-laag-uitbreiding (§4) + live-lookup-uitbreiding (§5) — het
   gevoeligste onderdeel, want het raakt `matching.service.ts`, dat door
   elke Phase 3-adapter gedeeld wordt; laatst gebouwd zodat het bovenop een
   al werkende, al geteste basis komt (zelfde volgorde-redenering als Phase
   4B's drag/drop, dat ook als laatste, meest UI-risicovolle onderdeel
   kwam).
4. Timeline-verrijking (§12) — puur cosmetisch, kan zonder risico als
   laatste.

**Wel expliciet uitgesteld naar een latere, nog niet geplande fase** (§9):
Opportunity-contactrelatie — geen concreet bewijs van noodzaak vandaag.

## 21. Wat expliciet niet gebouwd wordt

Bevestigd, ongewijzigd t.o.v. instructie §26: LinkedIn-verrijking, AI-
contactdetectie, mail-signature-parsing, Outlook-synchronisatie,
marketinglijsten/nieuwsbrieven/bulkmail, WhatsApp-integratie, complexe
organisatiehiërarchieën, leads zonder `CustomerProfile`,
huishouden-relaties, een generieke custom-contactvelden-engine.
