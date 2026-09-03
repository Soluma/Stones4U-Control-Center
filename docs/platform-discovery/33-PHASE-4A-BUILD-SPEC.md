# 33 — Phase 4A Build Spec: Opportunity Foundation

**Status**: Bouwspecificatie, geen implementatie. Vervolg op
`31-PHASE-4-SALES-PIPELINE-DISCOVERY.md`,
`32-PHASE-4-SALES-PIPELINE-ARCHITECTURE.md`, en
`docs/architecture/ADR-009-OPPORTUNITY-PIPELINE-MODEL.md`. Dit document
beschrijft uitsluitend Phase 4A (fundament) — Phase 4B (koppelingen/
automatisering/dashboard/rapportage) en Phase 4C (eventuele verdere
uitbreidingen) zijn bewust apart gehouden (architectuurdoc §20).

## 1. Scope van 4A

**Wel in 4A**:
- `Opportunity` + `OpportunityExternalLink`-modellen, 3 nieuwe enums
- Optionele `opportunityId` op `Task`/`Note`/`Appointment`, optionele
  `relatedOpportunityId` op `Activity`, 5 nieuwe `ActivityType`-waarden
- Kernservice: aanmaken, bewerken, fase wijzigen, eigenaar wijzigen,
  winnen, verliezen, heropenen, archiveren, extern koppelen/ontkoppelen
- RBAC (hergebruik `requireWriteAccess`/`requireRole`) + audit (10 nieuwe
  `opportunity.*`-acties)
- `/opportunities` (kanban + lijst, filters, geen drag-and-drop)
- `/opportunities/[id]` (detail, hergebruik van bestaande panelen)
- Customer 360: Commercieel-sectie "Opportunities" + Overzicht-blok +
  header-badge
- Command-palette-groep `opportunities`
- Volledige teststrategie (§10)

**Expliciet niet in 4A** (Phase 4B/4C, architectuurdoc §20):
dashboardwidgets, afgeleide suggestiebanners (offerte-gekoppeld →
fasevoorstel, order geplaatst → win-voorstel), rapportagesectie,
drag-and-drop, configureerbare fases, concurrent-veld.

## 2. Voorgestelde datamodellen (Prisma, additief)

Zie `32-PHASE-4-SALES-PIPELINE-ARCHITECTURE.md` §1 voor het volledige,
becommentarieerde schema-voorstel (`Opportunity`, `OpportunityExternalLink`,
enums `OpportunityStage`/`OpportunityStatus`/`OpportunityLinkType`, plus de
additieve kolommen op `Task`/`Note`/`Appointment`/`Activity` en de 5 nieuwe
`ActivityType`-waarden). Niet herhaald hier om drift tussen twee kopieën
van hetzelfde schema te voorkomen.

## 3. Migratie (indicatief, niet gemaakt)

Eén additieve migratie:
- `CREATE TYPE "OpportunityStage"`, `"OpportunityStatus"`,
  `"OpportunityLinkType"`
- `CREATE TABLE "Opportunity"`, `"OpportunityExternalLink"`
- `ALTER TABLE "Task" ADD COLUMN "opportunityId" TEXT` (+ FK, nullable)
- `ALTER TABLE "Note" ADD COLUMN "opportunityId" TEXT` (+ FK, nullable)
- `ALTER TABLE "Appointment" ADD COLUMN "opportunityId" TEXT` (+ FK,
  nullable)
- `ALTER TABLE "Activity" ADD COLUMN "relatedOpportunityId" TEXT` (+ FK,
  nullable)
- `ALTER TYPE "ActivityType" ADD VALUE` × 5

Geen enkele bestaande kolom wijzigt van type of verplicht-status, geen
bestaande rij wordt herschreven — zelfde risicoklasse als de Phase 3C-
migratie die al drie keer (dev/staging/productie) probleemloos is
toegepast.

## 4. Routes (4A)

| Route | Methode | Doel |
|---|---|---|
| `/api/opportunities` | GET | Lijst, filters (eigenaar/fase/status/opvolging-nodig/zoekterm) |
| `/api/opportunities` | POST | Aanmaken (`requireWriteAccess`) |
| `/api/opportunities/[id]` | GET | Detail |
| `/api/opportunities/[id]` | PATCH | Titel/omschrijving/waarde/kans/verwachte sluitdatum bewerken (`requireWriteAccess` + eigenaar/aanmaker/ADMIN) |
| `/api/opportunities/[id]/stage` | PATCH | Fase wijzigen (alleen als `status=OPEN`) |
| `/api/opportunities/[id]/owner` | PATCH | Eigenaar wijzigen (eigen auditregel) |
| `/api/opportunities/[id]/won` | POST | Markeer gewonnen |
| `/api/opportunities/[id]/lost` | POST | Markeer verloren (verplicht `lostReason`) |
| `/api/opportunities/[id]/reopen` | POST | Heropenen |
| `/api/opportunities/[id]/archive` | POST | Archiveren |
| `/api/opportunities/[id]/links` | POST | Extern koppelen (offerte/order) |
| `/api/opportunities/[id]/links/[linkId]` | DELETE | Soft-ontkoppelen |
| `/api/customers/[id]/opportunities` | GET | Opportunities van één klant (voor Customer 360) |
| `/api/search` | GET | Uitgebreid met `opportunities`-groep (bestaande route, geen nieuw endpoint) |

Elke schrijvende route: Zod-validatie (zelfde patroon als
`src/app/api/tasks/route.ts`), `requireWriteAccess()`/eigen
autorisatiecheck, `logAudit()`, `toErrorResponse()` bij fouten.

## 5. Schermen (4A)

- `/opportunities` — kanban (standaard) + lijst-toggle, filters, geen
  drag-and-drop in 4A (dropdown-fasewijziging via de detailpagina of een
  inline select)
- `/opportunities/[id]` — header, quick actions, hergebruikte panelen
  (§32 §8)
- Customer 360 (`/customers/[id]`): Commercieel-tab krijgt een
  "Opportunities"-sectie; Overzicht-tab krijgt een "Open opportunities"-
  blok; `CustomerHeader` krijgt een badge
- `src/components/layout/nav-config.ts`: nieuw item onder "Sales"
  (bijv. `{ label: "Pipeline", href: "/opportunities", icon: ... }`),
  bestaande `comingSoon`-items ongewijzigd

## 6. Permissions

- `VIEWER`: alleen lezen (lijst, kanban, detail) — geen enkele
  schrijfroute toegankelijk, zelfde centrale gate als de rest van de app.
- `AGENT`/`ADMIN`: aanmaken altijd toegestaan; bewerken/fase/eigenaar/
  winnen/verliezen/heropenen/archiveren/koppelen alleen door eigenaar,
  aanmaker, of `ADMIN` (zelfde vorm als `Task.assertCanModify`, apart
  geïmplementeerd voor `Opportunity` — geen gedeelde generieke functie,
  om de twee domeinen niet onnodig te koppelen).

## 7. Audit

Alle 10 acties uit architectuurdoc §15, plus de 2 nieuwe
`AuditEntityType`-waarden (`Opportunity`, `OpportunityExternalLink`).
Zuiver een TypeScript-uniontypewijziging in
`src/platform/audit/audit.ts` — geen migratie nodig (`AuditEvent.action`
is een `String`-kolom, geen databank-enum).

## 8. Benodigde env vars / scopes / connections

Geen. Phase 4A introduceert geen nieuwe externe integratie — alles is
lokaal (nieuwe modellen) of hergebruikt bestaande, al geconfigureerde
adapters (Shopify draft orders/orders, federated quotes) uitsluitend voor
weergave bij het koppelen. Geen nieuwe secrets, geen nieuwe Fly-config.

## 9. Buildvolgorde (4A, concreet)

1. Schema-uitbreiding + migratie (lokaal, dev-DB) — `Opportunity`,
   `OpportunityExternalLink`, enums, additieve kolommen.
2. `src/modules/opportunities/opportunity.service.ts` — kernfuncties
   (`createOpportunity`, `updateOpportunity`, `changeStage`,
   `changeOwner`, `markWon`, `markLost`, `reopen`, `archive`,
   `addExternalLink`, `removeExternalLink`, `listOpportunities`,
   `listOpportunitiesForCustomer`, `getOpportunityDetail`,
   `needsFollowUp`-helper), met dezelfde `Actor`-typering en
   `ForbiddenError`/`logAudit`-conventies als `task.service.ts`.
3. `Task`/`Note`/`Appointment`-services uitbreiden met de optionele
   `opportunityId`-parameter + afleidingsregel (§32 §4/§9).
4. `Activity`-schrijfpunten uitbreiden: elke opportunity-mutatie schrijft
   zijn eigen `Activity`-rij (`OPPORTUNITY_CREATED`/`_STAGE_CHANGED`/
   `_WON`/`_LOST`/`_REOPENED`), zelfde transactiepatroon als
   `task.service.ts` (`prisma.$transaction`).
5. API-routes (§4) met Zod-schema's per route.
6. `/opportunities`- en `/opportunities/[id]`-schermen.
7. Customer 360-uitbreidingen (Commercieel-sectie, Overzicht-blok,
   header-badge) — kleine, additieve wijzigingen aan bestaande
   componenten/`page.tsx`, geen herschrijving.
8. `nav-config.ts`-item.
9. Command-palette-groep in `/api/search/route.ts`.
10. Volledige teststrategie (§10).
11. `npm run typecheck && npm run lint && npm run test && npm run build`
    — moeten alle vier groen zijn vóór enige staging-stap (project-conventie).

## 10. Teststrategie

- **Service-laag** (spiegelbeeld van `tests/matching.test.ts`/
  `tests/email-matching-identity.test.ts`-stijl — directe DB-tests, geen
  mocking van Prisma): stage-overgangen alleen bij `status=OPEN`; won/lost
  zetten `wonAt`/`lostAt` correct en bevriezen `stage`; reopen wist
  `lostReason` maar behoudt `wonAt`/`lostAt` als historie; RBAC
  (`VIEWER` overal geweigerd; niet-eigenaar/niet-aanmaker/niet-ADMIN
  geweigerd bij bewerken); `opportunityId` op Task/Note/Appointment leidt
  `customerProfileId` correct af en weigert een inconsistente combinatie;
  `OpportunityExternalLink`-uniqueconstraint (geen dubbele koppeling per
  fase); `needsFollowUp()`-logica met tijdgemanipuleerde fixtures (drie
  triggers apart getest: geen activiteit, overdue taak, verstreken
  sluitdatum).
- **API-routes**: Zod-validatiefouten, 401/403-paden, 201/200-happy-path,
  zelfde `toErrorResponse()`-conventie als bestaande routes.
- **Command palette**: nieuwe groep verschijnt correct, faalt niet de
  bestaande vier groepen bij een opzettelijke opportunity-zoekfout
  (fail-isolation, zelfde patroon als de bestaande `quotes`/`orders`-
  try/catches in `route.ts`).
- **Migratie**: `prisma migrate deploy` tegen een kopie van de
  productie-schemastand (zelfde controle als elke eerdere fase) —
  bevestigt zuiver additief, geen data-impact.
- **Regressie**: bestaande Task/Note/Appointment-tests moeten ongewijzigd
  slagen met de nieuwe optionele kolom aanwezig maar leeg (backwards-
  compatibel, zelfde garantie als Phase 2's additieve Task-velden).

## 11. Concrete buildvolgorde-samenvatting

Schema → service → API → UI (pipeline-scherm → detail-scherm →
Customer 360-integratie → navigatie → command palette) → tests →
kwaliteitspoorten (`typecheck`/`lint`/`test`/`build`) → pas dan staging.

## 12. Explicit out-of-scope (herbevestigd uit de opdracht)

Microsoft 365/`info@stones4u.nl`, marketing automation, nieuwsbrieven, AI
lead scoring, AI-geschreven e-mails, voorraadplanning, volledige ERP,
financiële administratie, SMTP/e-mail versturen, PBX-wijzigingen,
herschrijven van OfferteApp/Kassa Systeem/TelefoonSysteem. Ook binnen
Phase 4 zelf out-of-scope voor 4A specifiek: dashboardwidgets,
automatiserings-suggestiebanners, rapportagesectie, drag-and-drop,
configureerbare fases, concurrent-veld (allemaal Phase 4B/4C).

## 13. Open beslissingen — input van Fons nodig

1. **Exacte Nederlandse labels/volgorde van de zes fases** — het voorstel
   (Nieuw / Contact gehad / Behoefte bepaald / Offerte voorbereiden /
   Offerte uitgebracht / Onderhandeling) is direct overgenomen uit de
   opdracht, maar verdient een expliciete bevestiging dat dit ook echt het
   Stones4U-verkoopproces dekt (bijvoorbeeld: is er een aparte fase nodig
   vóór "Nieuw" voor een nog-niet-gekwalificeerde lead, of is dat altijd al
   een `CrmStatus=LEAD`-klant en dus buiten de opportunity-scope?).
2. **Standaard-kansen per fase** (§32 §14-tabel) zijn een redelijke eerste
   schatting, geen Stones4U-specifieke data — bijstellen na de eerste
   maanden echte pipeline-data is verstandiger dan nu proberen te
   optimaliseren zonder historie.
3. **Wie mag een opportunity aanmaken voor een andere accountmanager's
   klant** — het voorstel (elke `AGENT`/`ADMIN` mag aanmaken, alleen
   eigenaar/aanmaker/ADMIN mag wijzigen) volgt Task's precedent, maar is
   niet expliciet in de opdracht bevestigd.
4. **Plek van het nieuwe navigatie-item** — voorstel is onder de
   bestaande "Sales"-sectie naast de `comingSoon`-items; een ander label
   dan "Pipeline" (bv. "Verkoopkansen") is een puur cosmetische keuze die
   net zo goed nu vastgelegd kan worden.

Geen van deze vier is blokkerend voor het starten van de bouw — ze zijn
allemaal binnen de bestaande architectuur op te lossen zonder
schema-impact, en kunnen dus tijdens de bouw of vlak vóór de eerste
staging-test worden afgestemd.

## 14. Eindconclusie

Phase 4A is, zoals ontworpen, een kleine, volledig additieve uitbreiding:
twee nieuwe modellen, vier nieuwe optionele kolommen op bestaande
modellen, één servicebestand naar bestaand patroon, en UI die voor het
grootste deel bestaande Customer 360-componenten hergebruikt met een
filterprop. Geen enkele bestaande integratie, tabel, of gebruikersstroom
wordt gewijzigd op een manier die vandaag al werkende functionaliteit kan
breken.
