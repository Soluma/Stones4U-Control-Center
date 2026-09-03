# Phase 4C — Contactpersonen & Commerciële Relaties: staging build report

**Status**: gebouwd, getest (451/451 tests groen, typecheck/lint/build
groen), gedeployed naar `stones4u-control-center-staging` (versie 23,
migratie `20260903174521_phase_4c_customer_contacts` toegepast), volledig
gevalideerd met een echte staging-E2E (22/22 checks) plus een aparte
regressie-smoke (14/14 checks) tegen bestaande echte testklanten ("JS
Verkoelen", "Robert Vossen"). Niet gecommit, niet gepusht, geen
productie-actie.

Vervolg op `docs/platform-discovery/37-PHASE-4C-CONTACTS-DISCOVERY.md`,
`38-PHASE-4C-CONTACTS-ARCHITECTURE.md`, `39-PHASE-4C-BUILD-SPEC.md`,
`docs/architecture/ADR-010-CUSTOMER-CONTACT-MODEL.md`.

## 1. Datamodel

Nieuw model `CustomerContact` (`prisma/schema.prisma`) — exact het in
ADR-010/build spec vastgelegde veldenoverzicht, zonder afwijking:
`displayName`, `jobTitle`, `email`+`emailNormalized`,
`phone`+`phoneNormalized`, `isPrimary`/`isDecisionMaker`/
`isBillingContact` (booleans, geen rollen-enum), `archivedAt`,
`createdById`. Geen `firstName`/`lastName`-splitsing, geen `department`,
geen vrij `notes`-veld — precies zoals besloten.

Additieve kolommen: `ExternalContactMatch.customerContactId`,
`Task.customerContactId`, `Note.customerContactId`,
`Appointment.customerContactId` — alle nullable, alle `onDelete: SetNull`
waar van toepassing. `File` bewust ongewijzigd (geen contactrelatie,
architectuurdoc §11).

## 2. Migratie

Eén migratie, `prisma/migrations/20260903174521_phase_4c_customer_contacts/
migration.sql` — handmatig gecontroleerd: uitsluitend `CREATE TABLE`/`ALTER
TABLE ... ADD COLUMN` (nullable)/`CREATE INDEX`/`ADD CONSTRAINT`. Geen
`DROP`, geen bestaande-kolomwijziging, geen backfill. Bestaande
`CustomerProfile`-rijen zijn ongewijzigd en volledig geldig zonder één
contact.

**Eén handmatige toevoeging** aan de gegenereerde migratie: een partial
unique index —

```sql
CREATE UNIQUE INDEX "CustomerContact_one_active_primary_per_customer"
ON "CustomerContact"("customerProfileId")
WHERE "isPrimary" = true AND "archivedAt" IS NULL;
```

Prisma's schema-DSL ondersteunt geen `WHERE`-clausule op `@@unique`, dus dit
staat uitsluitend in de migratie-SQL, niet in `schema.prisma` zelf (met een
expliciete `NOTE`-comment op de `CustomerContact`-index-regels die dit
uitlegt, zodat een toekomstige `prisma db push` dit niet per ongeluk
probeert terug te draaien — dit project gebruikt `db push` sowieso nergens
in de normale flow).

## 3. Primary-invariant — race-safety

Servicelaag (`setPrimaryContact`-logica in `createContact`/`updateContact`,
`src/modules/crm/customer-contact.service.ts`): binnen één `$transaction`
wordt eerst elk ander actief primair contact van dezelfde klant ontzet,
daarna het nieuwe contact primair gemaakt. Dit dekt het normale,
sequentiële geval volledig.

De partial unique index (§2) dekt de resterende **echte
concurrency-race**: twee tegelijk lopende requests die allebei "er is nu
geen actief primair contact" waarnemen vóórdat de ander commit. Bij een
botsing gooit Postgres een unique-violation, die de servicelaag
(`runPrimaryTransaction`) vangt en vertaalt naar een nette
`CustomerContactValidationError` ("probeer het opnieuw") — nooit een
onafgehandelde 500. Getest met een expliciete `Promise.allSettled` van twee
gelijktijdige `createContact({isPrimary: true})`-aanroepen
(`tests/customer-contacts.test.ts`): na afloop is er hooguit één actief
primair contact, en elke afgewezen aanroep faalt met precies deze
`CustomerContactValidationError`, nooit een andere foutsoort.

## 4. Archive/restore-semantiek

Bevestigd exact volgens de definitieve productbeslissing (instructie §0.A/§4):

- Archiveren zet `archivedAt` én **`isPrimary = false`** — geen automatische
  promotie van een ander contact. Een klant kan tijdelijk zonder primair
  contact zitten; dat is een geldige staat.
- Herstellen (`restoreContact`) zet uitsluitend `archivedAt = null` —
  **nooit** automatisch weer primair. Een gebruiker moet dat expliciet
  opnieuw instellen.
- Beide acties zijn idempotent (herhaalde aanroep = no-op, geen dubbele
  audit-rij) — zelfde precedent als `Opportunity.markWon`/`markLost`.
- **Afwijking t.o.v. het `Opportunity`-precedent** (dat geen restore-pad
  heeft): bewust, want het risicoprofiel is anders — een verkeerd
  gearchiveerde contactpersoon is data-hygiëne, geen commerciële
  staatswijziging met rapportagegevolgen. Bevestigd door Fons in de
  bouwopdracht §0.A.
- Nieuwe audit-acties (`src/platform/audit/audit.ts`'s `AuditAction`-type,
  geen schemawijziging nodig — `AuditEvent.action` is een kolom van het type
  `String`): `customer_contact.created`, `.updated`, `.primary_changed`,
  `.archived`, `.restored`.

## 5. Matching truth table — geïmplementeerd en getest

`src/modules/matching/matching.service.ts`'s `resolveAndRecordByEmail`/
`resolveAndRecordByPhone` doorzoeken nu zowel `CustomerProfile.email`/
`phoneNormalized` als (niet-gearchiveerde ken-status apart bijgehouden)
`CustomerContact.emailNormalized`/`phoneNormalized`. Alle vijf scenario's
uit instructie §8, letterlijk getest in
`tests/customer-contact-matching.test.ts` (13 tests):

| # | Scenario | Resultaat |
|---|---|---|
| A | Identity exact op één actief contact | Klant exact, `customerContactId` = dat contact |
| B | Identity alleen op `CustomerProfile` | Klant exact, `customerContactId` = null |
| C | Identity op twee actieve contacten **binnen** dezelfde klant | Klant exact, `customerContactId` = null (persoon ambigu) |
| D | Identity op contacten van **verschillende** klanten | Volledig `ambiguous`, nooit auto-confirmed |
| E | Identity uitsluitend op een **gearchiveerd** contact | Klant blijft exact bekend (identiteit is bewijs van de klant), `customerContactId` blijft null — nooit automatisch als actieve specifieke persoon |

**Bewuste precisering t.o.v. ADR-010 §4's oorspronkelijke tekst**: ADR-010
zei voor scenario E nog "gezet, maar UI onderdrukt het" — de definitieve
bouwopdracht (§8E) koos expliciet voor de striktere variant
("customerContactId nooit gezet voor een gearchiveerd contact"), wat ook
enige UI-complexiteit vermijdt. Geïmplementeerd volgens de striktere,
laatste instructie.

**Nooit overschrijven van menselijke keuzes (§9)**: automatische
her-resolutie is strikt monotoon (`null` → gezet, nooit andersom) en raakt
nooit een rij met `confidence = MANUAL` of een gezette
`confirmedByUserId` — expliciet getest (`tests/customer-contact-matching.test.ts`
"never overwrites a human-confirmed row" / "never touches a MANUAL row").

**Identity vs. interactie-ID's blijven gescheiden** (instructie §13/§14):
`ExternalContactMatch.externalRef` is en blijft de genormaliseerde
contactidentiteit (e-mailadres/telefoonnummer) — nooit een bericht- of
gesprek-ID. `stableEmailId()` (Timeline) en het call-`externalId` blijven
losse, interactie-scoped concepten, ongewijzigd. Geen regressie op de
Phase 3C-fix die dit onderscheid ooit brak (`docs/build/PHASE-3C-B-EMAIL-MATCH-FIX.md`).

## 6. Live lookup-uitbreiding (Customer 360)

`src/app/(app)/customers/[id]/page.tsx`: `phoneNumbers`/`emailAddresses`
bevatten nu de klant se eigen Shopify-snapshotgegevens **plus** alle actieve
(niet-gearchiveerde) contactadressen/-nummers, gededupliceerd. Zonder deze
wijziging zou een correct geregistreerd contact nooit zichtbaar worden in
de e-mail/bel-secties, ook al is de matching-laag zelf uitgebreid
(discovery §1.3's kernbevinding).

**Cap**: `MAX_ADDITIONAL_LOOKUP_IDENTITIES = 10` extra contactadressen/
-nummers per paginalaad. Onderbouwing: de IMAP-adapter doet al één
verbinding per mailbox ongeacht het aantal adressen (één `SEARCH` met alle
adressen in de criteria) — de cap beschermt vooral de telefonie-adapter,
die wél één HTTP-aanroep per nummer doet (TelefoonSysteem heeft geen
batch-endpoint; niet herschreven, per instructie). 10 is ruim boven de
realistische schaal (een handvol contacten per bedrijf, zoals het eigen
praktijkvoorbeeld toont) terwijl het worst-case aantal gelijktijdige
requests begrensd en review-baar blijft.

## 7. Timeline-verrijking

Nieuw, puur functioneel modul `src/modules/crm/contact-timeline.ts`
(`matchContactByEmail`/`matchContactByPhone`) — geen database-toegang, geen
nieuwe externe aanroep. `emailToTimelineItem()`
(`src/modules/activity/timeline.ts`) en de telefonie-itembouw gebruiken dit
om, uitsluitend bij een **exacte, ondubbelzinnige** match, de contactnaam
te tonen i.p.v. de rauwe header-naam/nummer. Bij twee actieve contacten met
hetzelfde adres (ambigu binnen de klant): nooit een naam tonen — 13
pure-functie-tests in `tests/customer-contact-timeline.test.ts` dekken dit,
inclusief het `contacts`-parameter-optioneel-blijven voor bestaande callers.

## 8. Duplicate-waarschuwing

Geen database-unique-constraint op (klant, e-mail)/(klant, telefoon) — een
gedeeld algemeen adres is legitiem. Servicelaag retourneert een
niet-blokkerende `duplicateWarning` bij create/update wanneer dezelfde
genormaliseerde waarde al op een ander **actief** contact van dezelfde
klant staat; nooit bij een andere klant, nooit tegen een gearchiveerd
contact. UI (`ContactDialog.tsx`) toont dit als een waarschuwingstekst,
geen blokkerende fout.

## 9. Customer 360 / detail / command palette

- Nieuwe "Contactpersonen"-sectie op de bestaande Overzicht-tab
  (`ContactsSection.tsx`, client component, zelfde self-fetching patroon
  als `OpportunitiesSection.tsx`) — geen nieuwe top-level tab.
- `ContactDialog.tsx` — klein formulier (naam, functie, e-mail, telefoon,
  drie checkboxen), geen enorme modal.
- Quick actions: `mailto:`/`tel:`-links + kopieerknoppen, bewerken,
  archiveren, herstellen (alleen zichtbaar voor `canEdit`).
- Opportunity-detail: alleen-lezen "Contactpersonen bij deze klant"-blok
  (`OpportunityContactsPanel`), hergebruikt `listContactsForCustomer` —
  geen dubbele opslag, geen "koppelen"-actie (er is geen
  `OpportunityContact`-relatie om aan te koppelen, architectuurdoc §9).
- Command palette: nieuwe `contacts`-groep (`/api/search`), fail-isolated
  eigen try/catch, zoekt op naam/e-mail/telefoon/functietitel — niet op de
  klantnaam zelf (die blijft de bestaande `customers`-groep).

## 10. RBAC / IDOR

`requireWriteAccess()` (ADMIN/AGENT) voor create/update/archive/restore,
`requireUser()` voor lezen — geen auteur-restrictie (gedeeld
telefoonboek-record, zelfde redenering als `CustomerTag`). Elke
mutatieroute geeft de `customerProfileId` uit de URL door aan de
servicelaag, die met `findFirstOrThrow({ id, customerProfileId })`
verifieert dat het contact daadwerkelijk bij die klant hoort — een mismatch
komt terug als "niet gevonden" (Prisma P2025 → 404), nooit een stille
cross-customer mutatie. Expliciet getest (`tests/customer-contacts.test.ts`
IDOR-blok) en herbevestigd in de staging-E2E.

## 11. Routing — kleine, onderbouwde afwijking van de build spec

De build spec stelde oorspronkelijk één overloaded `PATCH` voor
(archive/restore via velden). Tijdens implementatie bleek de rest van dit
project consequent **losse actie-routes** te gebruiken voor dit soort
overgangen (`/api/opportunities/[id]/archive`, `/reopen`, `/won`, `/lost`,
`/stage`, `/owner`) — nooit een overloaded `PATCH`. Om consistent te
blijven: `archiveContact`/`restoreContact` kregen alsnog hun eigen
`POST`-route (`.../[contactId]/archive`, `.../restore`). `isPrimary` bleef
wél gewoon een veld op de normale `PATCH`/`POST` — geen aparte "actie" in
dezelfde zin. Build spec doc 39 is bijgewerkt met deze afwijking en de
onderbouwing.

## 12. Task/Note/Appointment-koppeling — gevonden en gedicht API-gat

Tijdens de staging-E2E-voorbereiding bleek een reëel gat: de
service-laag-uitbreiding (`customerContactId` op `createTask`/
`updateTaskDetails`/`createNote`/`updateNote`/`createAppointment`/
`updateAppointment`) was compleet, maar **negen API-routes** (`/api/tasks`,
`/api/tasks/[id]`, `/api/customers/[id]/notes`, `/api/notes/[id]`,
`/api/customers/[id]/appointments`, `/api/appointments/[id]`,
`/api/opportunities/[id]/tasks`, `/api/opportunities/[id]/notes`,
`/api/opportunities/[id]/appointments`) gaven `customerContactId` nog niet
door in hun Zod-schema's — het veld zou stilzwijgend genegeerd zijn bij een
API-aanroep. Gevonden vóórdat het naar staging ging (lokale
quality-gates + typecheck bleven groen, want dit was geen type-fout — pas
zichtbaar bij een daadwerkelijke E2E-aanroep). Gefixt in alle negen routes,
opnieuw gebouwd, opnieuw gedeployed, opnieuw geverifieerd. Volledig
regressievrij (451/451 tests, staging-E2E 22/22).

## 13. Performance / geen N+1

`listContactsForCustomer()` — één query, geïndexeerd op
`customerProfileId`, hergebruikt zowel voor de Contactpersonen-sectie als
voor de live-lookup-adresopbouw (§6) — geen dubbele query per paginalaad.
`searchCustomerContacts()` — geïndexeerd op `emailNormalized`/
`phoneNormalized`, `take: 8`. Matching-laag-uitbreiding voegt per
klant-resolutie twee extra, geïndexeerde queries toe (contact-kandidaten op
e-mail/telefoon) — geen N+1, geen query-per-rij-in-een-lus. Timeline-
verrijking is pure in-memory cross-referentie, geen nieuwe query per
timeline-item.

## 14. Tests — nieuwe baseline

**451/451 groen** (was 385 vóór Phase 4C — de Phase 4B-eindstand; +66
nieuwe tests), typecheck/lint/build alle groen.

- `tests/customer-contacts.test.ts` (31): CRUD, primaire-invariant (incl.
  concurrency-race), duplicaten, RBAC, IDOR, `listContactsForCustomer`,
  `searchCustomerContacts`.
- `tests/customer-contact-matching.test.ts` (13): volledige waarheidstabel
  (A–E) voor e-mail en telefoon, plus "nooit overschrijven"-regressietests.
- `tests/customer-contact-timeline.test.ts` (13): pure-functie
  naamverrijking, inclusief ambiguïteit en het optioneel-blijven van de
  `contacts`-parameter.
- `tests/tasks.test.ts`/`notes.test.ts`/`appointments.test.ts`: elk +2 tests
  voor de cross-customer-`customerContactId`-invariant (zelfde klant
  toegestaan, andere klant geblokkeerd, incl. de opportunity-afgeleide
  klant-variant voor Task).

## 15. Staging-deploy en E2E

Gedeployed naar `stones4u-control-center-staging` (beide machines versie
23, gezond na de route-fix-herdeploy); `npx prisma migrate status`
bevestigt "Database schema is up to date!".

Staging-E2E (tsx, binnen de container, loopback-HTTP tegen de echte
gedeployde routes) — **22/22 checks groen**: meerdere contacten aanmaken,
primair wisselen (met verificatie dat de oude primair automatisch ontzet
wordt), duplicate-waarschuwing, bewerken, archiveren (met
primair-clearing), herstellen (zonder auto-primair), Customer 360-rendering,
Task/Note/Appointment met `customerContactId`, cross-customer IDOR
(geblokkeerd), VIEWER-RBAC (geblokkeerd op schrijven, wél lezen),
activiteit-tab rendert zonder crash, command-palette vindt het contact.
Matching (exact e-mail/telefoon → `customerContactId`) is bewust **niet**
via deze E2E herbevestigd — een directe aanroep van de `server-only`
matching-service crashte de eerste run van het E2E-script (bevestigt dat
dit soort module niet los van de Next.js-serverruntime aan te roepen is);
die garantie is al exhaustief gedekt door de 13 losstaande, tegen een
echte database draaiende tests in `tests/customer-contact-matching.test.ts`.

Aparte regressie-smoke: **14/14 checks groen** — hoofddashboard, klanten,
alle zeven Customer 360-tabs, pipeline, sales-dashboard, taken,
command-palette, health-check.

Alle synthetische testdata (contacten, taak/notitie/afspraak, testaccounts)
volledig opgeruimd en onafhankelijk herverifieerd (0 achtergebleven rijen).
De hergebruikte echte testklanten ("JS Verkoelen", "Robert Vossen") zijn
niet aangeraakt. Alle scratchscripts van de staging-container verwijderd.

## 16. Afwijkingen van architectuurdoc/build spec

1. Scenario E (gearchiveerd contact) — `customerContactId` blijft altijd
   null, striktere keuze dan ADR-010 §4's oorspronkelijke "gezet maar
   onderdrukt" (zie §5 hierboven).
2. Archive/restore-routes als losse `POST`-endpoints i.p.v. één overloaded
   `PATCH` (zie §11 hierboven) — consistentie met het bestaande
   Opportunity-routepatroon.
3. Negen API-routes kregen alsnog `customerContactId` in hun Zod-schema
   (zie §12) — geen architectuurwijziging, een gevonden en gedicht gat
   tussen servicelaag en routelaag.

Geen van deze drie is een afwijking van een productbeslissing — alle drie
zijn implementatiedetails, onderbouwd en hier vastgelegd.
