# 39 — Phase 4C Build Spec: Contactpersonen & Commerciële Relaties

**Status**: Build spec, geen implementatie. Vervolg op
`37-PHASE-4C-CONTACTS-DISCOVERY.md`,
`38-PHASE-4C-CONTACTS-ARCHITECTURE.md`,
`docs/architecture/ADR-010-CUSTOMER-CONTACT-MODEL.md`.

## 1. Scope

Eén Phase 4C (architectuurdoc §20): `CustomerContact`-model, CRUD-service,
Customer 360-sectie, command-palette-zoekgroep, matching-laag-uitbreiding,
live-lookup-uitbreiding, timeline-verrijking, optionele
`customerContactId` op Task/Appointment/Note. **Niet** in scope:
Opportunity-contactrelatie (architectuurdoc §9, expliciet uitgesteld).

## 2. Migratie

Twee additieve wijzigingen, één migratie:

```prisma
model CustomerContact {
  // zie architectuurdoc §2 voor het volledige veldoverzicht
}

model ExternalContactMatch {
  // ...bestaande velden ongewijzigd...
  customerContactId String?
  customerContact    CustomerContact? @relation(fields: [customerContactId], references: [id])
}

model Appointment {
  // ...bestaande velden ongewijzigd...
  customerContactId String?
  customerContact    CustomerContact? @relation(fields: [customerContactId], references: [id])
}

model Task {
  // ...bestaande velden ongewijzigd...
  customerContactId String?
  customerContact    CustomerContact? @relation(fields: [customerContactId], references: [id])
}

model Note {
  // ...bestaande velden ongewijzigd...
  customerContactId String?
  customerContact    CustomerContact? @relation(fields: [customerContactId], references: [id])
}
```

Geen `DROP`, geen bestaande-kolom-wijziging, geen backfill. Vóór
implementatie: exact zoals bij Phase 4A/4B, handmatig controleren dat de
gegenereerde `migration.sql` uitsluitend `CREATE TABLE`/`ALTER TABLE ...
ADD COLUMN` (nullable) bevat.

## 3. Nieuwe/gewijzigde modules

| Bestand | Inhoud |
|---|---|
| `src/modules/crm/customer-contact.service.ts` (nieuw) | `createContact`, `updateContact`, `archiveContact`, `restoreContact`, `listContactsForCustomer`, `searchCustomerContacts`, primaire-contact-transactielogica (architectuurdoc §7) |
| `src/modules/matching/matching.service.ts` (gewijzigd) | `resolveAndRecordByEmail`/`resolveAndRecordByPhone`/`recordCandidates` doorzoeken ook `CustomerContact`, zetten `customerContactId` opportunistisch bij een exacte contact-match (architectuurdoc §4/ADR-010 §3-4) |
| `src/modules/activity/timeline.ts` (gewijzigd) | `emailToTimelineItem()` en de telefonie-item-opbouw krijgen een optionele `contacts`-parameter voor naamverrijking (architectuurdoc §12) — puur presentatie, geen nieuwe query |
| `src/app/(app)/customers/[id]/page.tsx` (gewijzigd) | `phoneNumbers`/`emailAddresses`-opbouw uitgebreid met contactadressen (architectuurdoc §5); nieuwe `ContactsSection`-component op de Overzicht-tab |
| `src/app/(app)/customers/[id]/ContactsSection.tsx` (nieuw) | Client component, zelfde patroon als `OpportunitiesSection.tsx` |
| `src/app/(app)/opportunities/[id]/page.tsx` (gewijzigd, klein) | Alleen-lezen "Contactpersonen bij deze klant"-blok (architectuurdoc §10) — geen nieuwe service-aanroep, hergebruikt `listContactsForCustomer` |
| `src/app/api/customers/[id]/contacts/route.ts` (nieuw) | `GET`/`POST` |
| `src/app/api/customers/[id]/contacts/[contactId]/route.ts` (nieuw) | `PATCH` (velden inclusief `isPrimary`, zie §4) |
| `src/app/api/customers/[id]/contacts/[contactId]/archive/route.ts` (nieuw) | `POST` |
| `src/app/api/customers/[id]/contacts/[contactId]/restore/route.ts` (nieuw) | `POST` |
| `src/app/api/search/route.ts` (gewijzigd) | nieuwe `contacts`-groep, eigen try/catch |
| `tests/customer-contacts.test.ts` (nieuw) | CRUD/RBAC/IDOR/primair/duplicaten |
| `tests/customer-contact-matching.test.ts` (nieuw) | matching-laag-uitbreiding |
| `tests/customer-contact-timeline.test.ts` (nieuw) | timeline-naamverrijking (pure functie) |

## 4. Routes

| Route | Methode | RBAC | Doel |
|---|---|---|---|
| `/api/customers/[id]/contacts` | `GET` | `requireUser()` | Lijst (niet-gearchiveerd, primair eerst) |
| `/api/customers/[id]/contacts` | `POST` | `requireWriteAccess()` | Aanmaken (inclusief `isPrimary` — de primair-transactielogica draait al bij het aanmaken) |
| `/api/customers/[id]/contacts/[contactId]` | `PATCH` | `requireWriteAccess()` | Veldwijzigingen, inclusief `isPrimary` |
| `/api/customers/[id]/contacts/[contactId]/archive` | `POST` | `requireWriteAccess()` | Archiveren |
| `/api/customers/[id]/contacts/[contactId]/restore` | `POST` | `requireWriteAccess()` | Herstellen |

**Afwijking t.o.v. de oorspronkelijke build-spec-tekst**: die stelde één
overloaded `PATCH` voor (archive/restore via velden). Tijdens implementatie
bleek de rest van dit project consequent **losse actie-routes** te
gebruiken voor precies dit soort state-overgangen —
`/api/opportunities/[id]/archive`, `/reopen`, `/won`, `/lost`, `/stage`,
`/owner` zijn stuk voor stuk aparte `POST`-routes, nooit een overloaded
`PATCH`. Om consistent te blijven met dat al gevestigde patroon is hiervan
afgeweken: archive/restore kregen alsnog hun eigen route. `isPrimary` blijft
wél gewoon een veld op de gewone `PATCH`/`POST` (geen apart
`primary`-endpoint) — een primair-wissel is geen aparte "actie" in dezelfde
zin, en dat spaart een route zonder de consistentie-afweging te breken.

Elke route (`PATCH`/`archive`/`restore`) geeft de `id` uit de URL door aan
de service-laag, die intern verifieert dat `contact.customerProfileId ===
id` vóór elke schrijfactie (IDOR-check, architectuurdoc §17) — een mismatch
komt terug als "niet gevonden" (Prisma P2025 → 404 via `toErrorResponse`),
nooit een stille cross-customer mutatie.

## 5. Permissions

- **VIEWER**: alleen `GET` — overal (route, Customer 360-sectie,
  command-palette, Opportunity-detail-blok).
- **AGENT/ADMIN**: volledige CRUD, geen auteur-restrictie (architectuurdoc
  §15) — elke schrijfgerechtigde gebruiker mag elk contact van elke klant
  bewerken/archiveren/herstellen.

## 6. Audit

Nieuwe, ongetypeerde string-acties (geen schemawijziging,
`AuditEvent.action: String`):

- `customer_contact.created`
- `customer_contact.updated`
- `customer_contact.primary_changed` (apart van `.updated`, geschreven
  wanneer `isPrimary` van `false` naar `true` gaat)
- `customer_contact.archived`
- `customer_contact.restored`

Elke `Activity`-schrijfactie op Task/Appointment/Note die nu ook
`customerContactId` kan dragen, hoeft **geen** nieuwe `ActivityType` —
bestaande types (`TASK_CREATED`, `APPOINTMENT_CREATED`, `NOTE_CREATED`, ...)
blijven ongewijzigd; `customerContactId` is puur een extra, optioneel veld
op de onderliggende rij, geen nieuw soort gebeurtenis.

## 7. Benodigde env vars / scopes

Geen. Alles is lokale CRM-data + hergebruik van bestaande normalizers en
bestaande externe adapters (geen nieuwe Shopify-scope, geen nieuwe
IMAP/Graph-permissie).

## 8. Duplicate-waarschuwing — implementatiedetail

Bij `createContact`/`updateContact`: vóór het schrijven, een query op
`emailNormalized`/`phoneNormalized` binnen dezelfde `customerProfileId`
(niet-gearchiveerd, exclusief de eigen rij bij een update). Bij een hit:
**geen fout** — de service retourneert het aangemaakte/bijgewerkte contact
mét een `duplicateWarning`-veld in de response (bv.
`{ field: "email", conflictingContactId: "..." }|null`), de UI toont dit als
een niet-blokkerende melding. Nooit een `OpportunityValidationError`-achtige
harde afwijzing hiervoor — alleen structurele fouten (ontbrekende
verplichte `displayName`, ongeldig e-mailformaat) blokkeren.

## 9. Teststrategie

**CRUD** (`tests/customer-contacts.test.ts`):
- create/update/archive/restore — elk schrijft de juiste `AuditAction`.
- `displayName` verplicht, lege/whitespace-only wordt geweigerd.
- e-mail/telefoon optioneel — een contact met alleen naam+functietitel is
  geldig.

**Primary-uniciteit**:
- eerste contact met `isPrimary: true` wordt primair.
- tweede contact met `isPrimary: true` zet de eerste automatisch op
  `false` binnen dezelfde transactie — expliciete test dat na afloop
  precies één actief primair contact bestaat.
- archiveren van het huidige primaire contact laat géén ander contact
  automatisch primair worden (geen verrassende impliciete promotie) — de
  klant heeft dan tijdelijk geen primair contact, wat een geldige staat is.

**RBAC**:
- VIEWER geblokkeerd op create/update/archive/restore (403).
- VIEWER kan wel lezen (200).
- AGENT (geen speciale eigendomsrelatie nodig) kan elk contact van elke
  klant bewerken.

**IDOR**:
- een `PATCH` op `/api/customers/{A}/contacts/{contactVanKlantB}` wordt
  geweigerd (contact hoort niet bij klant A in de URL) — expliciete
  regressietest voor exact het scenario dat architectuurdoc §17 als
  verplichting noemt.

**Normalisatie/duplicaten**:
- e-mail/telefoon consistent genormaliseerd (hergebruikt bestaande
  `normalizeEmail`/`normalizeDutchPhone`-tests, geen nieuwe normalizer).
- twee contacten van dezelfde klant met hetzelfde genormaliseerde e-mailadres
  → aangemaakt, met `duplicateWarning` gezet, geen fout.
- hetzelfde e-mailadres bij twee **verschillende** klanten → geen
  waarschuwing (architectuurdoc §16).

**Matching** (`tests/customer-contact-matching.test.ts`):
- exact e-mailadres van een niet-gearchiveerd contact →
  `MatchResolution.status === "exact"`, `ExternalContactMatch.customerContactId`
  gezet.
- e-mailadres staat alleen op `CustomerProfile.email` (geen contact-rij) →
  exact, `customerContactId` blijft `null`.
- e-mailadres staat op twee contacten **binnen dezelfde klant** → klant
  exact, `customerContactId` blijft `null` (persoon ambigu, ADR-010 §4).
- e-mailadres staat op contacten van **twee verschillende klanten** →
  `status === "ambiguous"` (ongewijzigd bestaand gedrag, regressietest).
- e-mailadres hoort **uitsluitend** bij een **gearchiveerd** contact →
  klant blijft exact matchbaar (het adres is nog steeds bewijs van de
  klant), maar `customerContactId` blijft `null` — nooit automatisch als
  actieve specifieke contactpersoon gematcht. **Correctie t.o.v. een eerdere
  versie van dit build spec** (die hier nog "mag gezet worden" zei, gespiegeld
  aan ADR-010's oorspronkelijke tekst): bij implementatie is bewust gekozen
  voor de striktere variant — zie ADR-010 §4 (bijgewerkt) en
  `docs/build/PHASE-4C-CONTACTS-STAGING.md` §5 voor de volledige
  onderbouwing.

**Customer 360**:
- nul contacten → sectie toont een lege staat, geen fout.
- één contact, geen primair gezet → sectie rendert zonder "Primair"-label.
- meerdere contacten, één primair → primair contact eerst gesorteerd.

**Search**:
- zoeken op contactnaam → resultaat met klantnaam als subtitel.
- zoeken op e-mailadres/telefoonnummer → zelfde.
- zoeken op klantnaam alleen → **geen** contactresultaten (dat is de
  bestaande `customers`-groep, architectuurdoc §13).

**Timeline** (`tests/customer-contact-timeline.test.ts`, pure functie,
geen database nodig):
- e-mailbericht van een bekend contactadres → titel toont de contactnaam.
- e-mailbericht van een onbekend adres → ongewijzigd bestaand gedrag
  (headernaam/adres).
- gearchiveerd contact → **niet** gebruikt voor naamverrijking (dezelfde
  regel als de matching-laag, consistent toegepast).

**Security**:
- cross-customer contact-IDOR (zie hierboven).
- gearchiveerd contact blijft leesbaar voor audit/geschiedenisdoeleinden
  maar niet in de standaard "actieve contacten"-lijst.
- VIEWER-mutatie overal geblokkeerd (route + service-laag, dubbele
  verdediging zoals overal elders in dit project).

## 10. Kwaliteitspoorten

`npm run test && npm run typecheck && npm run lint && npm run build` — alle
vier groen vereist, zelfde gate als elke voorgaande fase. Nieuwe
testbaseline wordt gerapporteerd t.o.v. de huidige 385.

## 11. Buildvolgorde

Zie architectuurdoc §20 voor de volledige onderbouwing — samengevat:

1. Migratie + `CustomerContact`-service (CRUD, primair-transactie,
   duplicate-waarschuwing) + RBAC/audit + volledige testdekking.
2. Customer 360-sectie (`ContactsSection.tsx`) + command-palette-groep +
   Opportunity-detail-leesblok.
3. Matching-laag-uitbreiding (`matching.service.ts`) + live-lookup-
   uitbreiding (`phoneNumbers`/`emailAddresses`-opbouw) — laatst vóór
   timeline, want dit raakt de door alle Phase 3-adapters gedeelde module.
4. Timeline-naamverrijking (puur cosmetisch, laagste risico, laatst).
5. Volledige kwaliteitspoorten + staging-deploy + staging-E2E (zelfde
   patroon als Phase 4A/4B) — **niet onderdeel van deze discovery-ronde**,
   pas bij een expliciete bouwopdracht.

## 12. Open beslissingen — input van Fons nodig

1. **Restore-functionaliteit voor contacten** (architectuurdoc §15): dit
   wijkt af van het bestaande `Opportunity`-precedent (geen restore-pad).
   Onderbouwing staat in de architectuurdoc — verdient een korte
   bevestiging omdat het een nieuw patroon in dit project introduceert.
2. **Eén `phone`-veld i.p.v. apart `mobile`+`vast`** (architectuurdoc §2):
   een bewuste vereenvoudiging t.o.v. het geschetste voorbeeldmodel —
   bevestigen dat dit voor de praktijk voldoende is, of dat een tweede
   nummerveld toch gewenst is.
3. **Opportunity-contactrelatie uitgesteld** (architectuurdoc §9): geen
   blokkerende vraag, maar een expliciete scope-keuze die Fons wellicht
   toch al in Phase 4C wil, ondanks het ontbreken van een concreet
   aangedragen scenario.
4. **`tel:`-koppelfunctionaliteit** (architectuurdoc §6): te bevestigen of
   de bestaande UI dit patroon al ergens gebruikt, anders vervalt dit
   quick-action-onderdeel stilzwijgend tot alleen een leesbare
   telefoonnummerweergave.

Geen van deze vier is blokkerend voor het starten van de bouw.

## 13. Eindconclusie

Phase 4C is volledig additief (twee schemawijzigingen, geen bestaande-
kolomwijziging, geen backfill), bouwt uitsluitend voort op al bewezen
patronen in deze codebase (optionele `<x>Id`-relaties, transactie-
afgedwongen enkelvoudige toestand, pure cross-referentie-verrijking,
fail-isolated command-palette-groepen, soft-archivering), en introduceert
geen nieuwe identiteitslaag naast `ExternalContactMatch` (ADR-010). Geen
van de vier open beslissingen blokkeert de start van de bouw.
