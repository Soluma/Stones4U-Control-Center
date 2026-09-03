# 37 — Phase 4C Discovery: Contactpersonen & Commerciële Relaties

**Status**: Discovery, geen implementatie. Vervolg op Phase 4B (productie-
commit `4b92f32`). Basis voor `38-PHASE-4C-CONTACTS-ARCHITECTURE.md` en
`39-PHASE-4C-BUILD-SPEC.md`.

## 1. Huidige identiteitsmodellen — volledige inventarisatie

### 1.1 `CustomerProfile` (ADR-002)

`prisma/schema.prisma` — één rij per Shopify-klant (`shopifyCustomerGid
@unique`). Velden relevant voor Phase 4C: `displayName`, `companyName`,
`email`, `phone`, `phoneNormalized` — een **denormaliseerde Shopify-
snapshot**, ververst bij elk bezoek (`getOrCreateCustomerProfile()`), nooit
de bron van waarheid. Vandaag draagt dit model **precies één e-mailadres en
één telefoonnummer** — de Shopify-accounthouder's eigen gegevens. Er is geen
enkel bestaand mechanisme om een tweede persoon (bv. een medewerker van het
klantbedrijf) te registreren.

`companyName` bestaat al als apart veld naast `displayName` — Shopify's
eigen "company"-veld wordt dus al onderscheiden van de persoonsnaam, wat
bevestigt dat sommige `CustomerProfile`-rijen conceptueel al een organisatie
representeren met één bekende contactpersoon (de accounthouder), niet één
individu.

### 1.2 `ExternalContactMatch` (ADR-007)

Centrale matching-laag: koppelt een externe identiteit (genormaliseerd
telefoonnummer, e-mailadres, of extern record-ID) aan een `CustomerProfile`
— **uitsluitend op klantniveau**, nooit op persoonsniveau. Kritieke
bevinding uit het lezen van `src/modules/matching/matching.service.ts`:

```ts
export async function resolveAndRecordByEmail(emailRaw, source, externalRef) {
  const normalized = normalizeEmail(emailRaw);
  const candidates = await prisma.customerProfile.findMany({
    where: { email: { equals: normalized, mode: "insensitive" } },
    select: { id: true },
  });
  return recordCandidates(candidates.map((c) => c.id), source, externalRef, "EMAIL");
}
```

Dit zoekt **uitsluitend** in `CustomerProfile.email` (dezelfde beperking
geldt voor `resolveAndRecordByPhone()` op `phoneNormalized`). Een e-mail van
`piet@jansentuinen.nl` wordt vandaag **nooit** aan "Jansen Tuinen BV"
gekoppeld tenzij dat toevallig exact het Shopify-accountadres is — er is
domweg geen plek om te weten dat Piet bij die klant hoort.

`@@unique([customerProfileId, source, externalRef])` — één rij per
(klant, bron, externe referentie); `externalRef` is voor `PHONE`/`EMAIL`
altijd de genormaliseerde **contactidentiteit zelf** (nooit een bericht-ID,
zie ADR-007 rule 4 en de correctiegeschiedenis in
`docs/build/PHASE-3C-B-EMAIL-MATCH-FIX.md`).

### 1.3 Hoe matching daadwerkelijk gebruikt wordt (belangrijke asymmetrie)

`recordMatchesForMessages()` (`src/integrations/email/adapter.ts`) roept
`resolveAndRecordByEmail()` aan als **passief neveneffect** van het lezen van
berichten — niet als de manier waarop berichten gevonden worden. De
daadwerkelijke Graph/IMAP-zoekopdracht wordt uitgevoerd door
`getMessagesForAddresses(addresses)`, aangeroepen vanaf
`src/app/(app)/customers/[id]/page.tsx` met:

```ts
const emailAddresses = [data.profile.email].filter((e): e is string => !!e);
```

— **exact één adres**, altijd het Shopify-snapshotadres. Hetzelfde patroon
geldt voor telefonie: `phoneNumbers = [normalizeDutchPhone(data.profile.phone)]`.
Dit betekent: zelfs als Piet's e-mailadres via een andere weg ooit aan de
juiste klant gematcht zou worden, worden zijn e-mails **vandaag nog steeds
niet opgehaald** op Jansen Tuinen BV's Customer 360-pagina, omdat de
zoekopdracht zelf maar naar één adres kijkt. Dit is de kern van wat Phase 4C
moet oplossen — niet alleen "waar slaan we een contactpersoon op", maar ook
"hoe stroomt die data door naar de bestaande live-federated lookups."

### 1.4 Timeline-projectie (category B, ADR-008)

`src/modules/activity/timeline.ts`: `CALL_*`/`EMAIL_*` zijn **nooit
persisted** — ze worden bij elke paginalaad opnieuw geprojecteerd vanuit de
adapter-resultaten. `emailToTimelineItem()` bouwt de titel nu als "E-mail
van {from.name ?? from.address}" — puur uit de al opgehaalde
berichtdata, geen enkele database-lookup. Dit is het exacte patroon dat
Phase 4C moet hergebruiken om een contactnaam te tonen: een **pure,
in-memory cross-referentie** op het al opgehaalde bericht/gesprek, nooit een
nieuwe query per timeline-item, nooit een nieuwe persisted koppeltabel.

### 1.5 `User` (CRM-medewerker)

Volledig ongerelateerd — `User` is een Control-Center-inlogaccount
(`role: ADMIN|AGENT|VIEWER`), nooit een klant-gerelateerde persoon. Geen
overlap-risico; genoemd hier alleen om het onderscheid expliciet te
bevestigen zoals gevraagd.

### 1.6 Opportunity, Task, Note, Appointment, File (ADR-003, ADR-009)

Alle vier dragen een gevestigd **optioneel `opportunityId`**-patroon,
consistent herhaald: `String?`, een relatie naar `Opportunity?`, met de
service-laag die (nooit de caller) garandeert dat een afgeleid veld
(`customerProfileId`) altijd correct wordt afgeleid zodra `opportunityId`
gezet is (ADR-009 §5). Dit is het directe sjabloon voor een eventueel
`customerContactId` op dezelfde modellen (§12 hieronder).

### 1.7 Quotes/orders/draft orders

Federated, nooit lokaal gekopieerd (ADR-004/008) — `QuoteSummary`/
`ShopifyOrderSummary`/`ShopifyDraftOrderSummary` hebben geen enkel
persoonsniveau-veld beschikbaar buiten wat de bron zelf teruggeeft
(doorgaans alleen het klantadres). Geen aanknopingspunt voor
contactmatching hier — buiten scope voor Phase 4C matching (wel relevant
voor Opportunity-detail UI, zie §12/§20 van de architectuurdoc).

### 1.8 Customer 360 / command palette / RBAC/audit

- Customer 360 (`src/app/(app)/customers/[id]/page.tsx`): tabs Overzicht/
  Commercieel/Activiteit/Notities/Taken/Afspraken/Bestanden. `OverviewTab`
  bouwt `phoneNumbers`/`emailAddresses`/`quoteMatchRefs` één keer, gedeeld
  door meerdere secties — het juiste punt om een uitgebreide adressenlijst
  (klant + contacten) te injecteren.
- Command palette (`src/app/api/search/route.ts`): groepen `customers`/
  `tasks`/`orders`/`quotes`/`opportunities`, elk in een eigen try/catch
  (fail-isolatie), elk een aparte servicefunctie. Rechtstreeks herbruikbaar
  sjabloon voor een `contacts`-groep.
- RBAC (`src/platform/auth/guards.ts`): `requireWriteAccess()` (ADMIN/AGENT)
  vs. `requireUser()` (elke ingelogde rol, incl. VIEWER, alleen lezen) —
  simpel, geen granulaire permissies. `Note` heeft daarbovenop een
  auteur-beperkte bewerkrestrictie (`assertCanModifyNote`); `Task`/
  `Appointment`/`Opportunity` hebben een eigenaar/aanmaker/beheerder-
  restrictie. Geen van beide patronen is vanzelfsprekend het juiste voor een
  gedeeld "bedrijfstelefoonboek"-record — zie architectuurdoc §16.
- Audit (`src/platform/audit/audit.ts`, `AuditEvent.action: String` — **geen
  enum**, dus nieuwe audit-acties vergen geen schemawijziging).

## 2. Wat vandaag ontbreekt (de eigenlijke Phase 4C-scope)

- Geen manier om meerdere personen bij één `CustomerProfile` vast te leggen.
- Matching (telefoon/e-mail) kijkt uitsluitend naar het enkele Shopify-
  snapshotadres/-nummer op `CustomerProfile` — geen tweede-persoon-matching
  mogelijk, ook niet als die data ooit zou bestaan.
- Live-federated lookups (Customer 360's e-mail/bel-secties) doorzoeken
  uitsluitend het klant-eigen adres/nummer — zelfs een correct opgeslagen
  contactpersoon zou zonder aanpassing van de lookup-aanroep zelf nooit
  zichtbaar worden.
- Geen "primair contact"-concept, geen rol/functie-aanduiding.
- Command-palette en klantzoekfunctie doorzoeken geen persoonsnamen.
- Opportunity heeft geen contactpersoon-relatie.

## 3. Waarom dit geen dubbel werk wordt / geen nieuw identiteitssysteem

`ExternalContactMatch` blijft **ongewijzigd** het mechanisme dat beantwoordt
"bij welke klant hoort deze externe identiteit" (ADR-007, niet heropend).
`CustomerContact` (voorgesteld) beantwoordt een andere vraag: "welke
personen kennen we bij deze klant, en welke van hun eigen contactgegevens
kennen we." Het samenspel tussen de twee — zonder een derde identiteits-
tabel te introduceren — is de kern van
`38-PHASE-4C-CONTACTS-ARCHITECTURE.md` §4 en het nieuwe ADR-010.

## 4. Referentiepatronen die hergebruikt worden

| Patroon | Bron | Hergebruik voor Phase 4C |
|---|---|---|
| Optioneel `<x>Id` + service-laag-afgeleide FK, nooit caller-vertrouwd | `Task.opportunityId` (ADR-009 §5) | `customerContactId` op Task/Appointment/Note |
| Eén rij per unieke sleutel, upsert i.p.v. duplicaat | `ExternalContactMatch.@@unique` | Contact-duplicate-waarschuwing (niet DB-constraint, zie architectuurdoc §11) |
| Pure cross-referentie op al-opgehaalde data, geen nieuwe externe call | Phase 4B Shopify/quote-signalen (`src/modules/opportunities/attention.ts`) | E-mail/call-timeline-contactherkenning (architectuurdoc §9) |
| `$transaction`-afgedwongen enkelvoudige toestand | `changeStage()`/`markWon()`/`confirmMatch()` | Primair-contact-wissel (architectuurdoc §7) |
| Server-fail-isolated command-palette-groep | `/api/search` orders/quotes/opportunities | Nieuwe `contacts`-groep |
| Soft-verwijderen via `archivedAt`/`unlinkedAt`, nooit hard delete | `Opportunity.archivedAt`, `ExternalContactMatch.unlinkedAt` | `CustomerContact.archivedAt` |
