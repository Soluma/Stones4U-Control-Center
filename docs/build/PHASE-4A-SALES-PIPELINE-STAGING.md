# Phase 4A — Sales Pipeline & Opportunities: staging build report

**Status**: gebouwd, getest (274/274 tests groen, typecheck/lint/build groen),
gedeployed naar `stones4u-control-center-staging` (versie 19, migratie
`20260903125303_phase_4a_opportunity_pipeline` toegepast), volledig
gevalideerd met een echte staging-E2E tegen de bestaande echte testklant
("JS Verkoelen"). Niet gecommit, niet gepusht, geen productie-actie.

**Update (2026-09-03) — MUST FIX-ronde na pre-production data-semantics
review**: een gerichte review (zie §21 hieronder) vond zes concrete
MUST FIX-bevindingen in de WON/LOST/REOPEN-semantiek, geldvalidatie, en
Opportunity↔Shopify-koppelintegriteit. Alle zes zijn opgelost, getest
(nieuwe baseline: 320/320), en op staging versie 20 herbevestigd —
volledig rapport in §21. Geen nieuwe migratie was nodig. Nog steeds niet
gecommit, niet gepusht, geen productie-actie.

Vervolg op `docs/architecture/ADR-009-OPPORTUNITY-PIPELINE-MODEL.md`,
`docs/platform-discovery/31-PHASE-4-SALES-PIPELINE-DISCOVERY.md`,
`32-PHASE-4-SALES-PIPELINE-ARCHITECTURE.md`,
`33-PHASE-4A-BUILD-SPEC.md`.

## 1. Datamodel

Geïmplementeerd exact volgens ADR-009/build spec, met de business-
beslissingen uit de bouwopdracht (stage-codes, standaardkansen):

- `Opportunity` (`stage: OpportunityStage`, `status: OpportunityStatus`,
  `estimatedValue`/`finalValue: Decimal(12,2)`, `probability: Int?`,
  `expectedCloseDate`, `ownerUserId`, `createdById`, `wonAt`/`lostAt`/
  `lostReason`, `archivedAt`).
- `OpportunityExternalLink` (`linkType`, `externalRef`, `linkedById`,
  `linkedAt`, `unlinkedAt`) — lichte referentie, nooit een kopie van de
  offerte/order zelf.
- Additieve `opportunityId` op `Task`/`Note`/`Appointment`/`File`,
  additieve `relatedOpportunityId` op `Activity`.
- Enums: `OpportunityStage { NEW, CONTACTED, NEEDS_DEFINED,
  QUOTE_PREPARATION, QUOTE_SENT, NEGOTIATION }`,
  `OpportunityStatus { OPEN, WON, LOST }`,
  `OpportunityLinkType { OFFERTEAPP_QUOTE, S4U_QUOTE_APP_QUOTE,
  SHOPIFY_DRAFT_ORDER, SHOPIFY_ORDER }`.
- 5 nieuwe `ActivityType`-waarden: `OPPORTUNITY_CREATED`,
  `_STAGE_CHANGED`, `_WON`, `_LOST`, `_REOPENED`.

`src/modules/opportunities/labels.ts` bevat de Nederlandse UI-labels en de
standaardkansen per fase (10/25/40/60/75/90), gedeeld tussen server en
client (geen `server-only`-import) zodat ze maar op één plek staan.

## 2. Migration

Eén migratie, `prisma/migrations/20260903125303_phase_4a_opportunity_
pipeline/migration.sql`, handmatig gecontroleerd: uitsluitend `CREATE
TYPE`/`CREATE TABLE`/`ALTER TABLE ... ADD COLUMN` (nullable)/`ALTER TYPE
... ADD VALUE`/`CREATE INDEX`/`ADD CONSTRAINT`. Geen `DROP TABLE`, geen
`DROP COLUMN`, geen destructieve type-conversie, geen data-herschrijving.
Lokaal toegepast (bestaande rijen ongewijzigd, geverifieerd via
rij-tellingen vóór/na) en op staging toegepast via de normale
`release_command: npx prisma migrate deploy`-flow — geen `prisma db push`
gebruikt.

## 3. Service layer

`src/modules/opportunities/opportunity.service.ts` — één centrale laag,
geen businesslogica in route handlers. Ondersteunt create/read/list/
update/changeStage/assignOwner/markWon/markLost/reopen/archive/
addExternalLink/removeExternalLink, plus `resolveCustomerProfileIdForOpportunity()`
— de ene plek waar Task/Note/Appointment/File de customerProfileId-
afleiding vandaan halen. Validaties: titel verplicht, kans 0–100, bedragen
≥0 (Decimal, geen JavaScript-float), owner/klant moeten bestaan
(owner: actieve gebruiker), gearchiveerde opportunity's weigeren elke
verdere mutatie, `lostReason` verplicht bij verlies.

## 4. Stage/status-semantiek

Geïmplementeerd exact conform ADR-009: `stage` en `status` zijn
gescheiden velden. Een fasewijziging is alleen toegestaan bij
`status = OPEN`. `markWon`/`markLost` bevriezen `stage` op de laatste
actieve waarde. `reopen()` herstelt `status = OPEN`, wist `lostReason`,
laat `stage` ongewijzigd, en behoudt `wonAt`/`lostAt` als "sticky"
historische tijdstempels (zelfde precedent als `Task.completedAt`) —
getest en bevestigd in `tests/opportunities.test.ts`.

## 5. Owner/RBAC

Standaard-eigenaar bij aanmaak: klant-accountmanager indien gezet, anders
de aanmaker — getest voor beide paden. Eigenaarwijziging is een losstaande
actie met eigen auditregel (`opportunity.owner_changed`). Autorisatie
mirrort `Task.assertCanModify` (eigenaar, aanmaker, of `ADMIN`); elke
`AGENT`/`ADMIN` mag aanmaken. `VIEWER` volledig read-only, bevestigd op elk
muterend pad (service-tests + staging-E2E: HTTP 403 op create/stage-
change).

## 6. Geld

`Decimal(12,2)`, geen `currency`-kolom (impliciet EUR). Weergave hergebruikt
`formatMoney({amount, currencyCode: "EUR"})` uit `src/lib/format.ts` — geen
nieuwe formatteerfunctie. Precisie bevestigd in tests (18500.5 blijft
18500.5, geen float-afronding).

## 7. Owned-record relations (Task/Note/Appointment/File)

Additieve `opportunityId` op alle vier. Servicelaag leidt `customerProfileId`
altijd af van `Opportunity.customerProfileId` zodra `opportunityId` gezet
is — nooit een door de aanroeper meegegeven waarde. Expliciet getest
(`tests/opportunity-relations.test.ts`): een taak/notitie/afspraak
aangemaakt met `opportunityId` van klant A en een (opzettelijk foutieve)
`customerProfileId` van klant B slaat altijd klant A op, nooit B. Op
staging bevestigd via een echte HTTP-aanroep
(`TASK_CUSTOMER_MATCHES_OPPORTUNITY=true`).

## 8. Externe links

`OpportunityExternalLink` met upsert-dedup op
`(opportunityId, linkType, externalRef)` — getest voor alle drie de
praktijkgevallen (offerte, conceptbestelling, bestelling) plus IDOR
(ontkoppelen via de verkeerde opportunity wordt geweigerd). Op staging
bevestigd end-to-end (toevoegen, dedupliceren, ontkoppelen — alle 3 HTTP
200/201).

## 9. Pipeline UI — `/opportunities`

Kanban (alleen open funnel-fases als kolommen, Gewonnen/Verloren nooit als
kolom) + lijstweergave, filters (fase/status/eigenaar/zoekterm/
gearchiveerd), geen drag-and-drop (bewust uitgesteld naar Phase 4B).
Opvolging-nodig-indicator volledig on-the-fly berekend (één batched
`Activity.groupBy`-query per paginalaad, geen achtergrondproces, geen
opgeslagen kolom).

## 10. Detail UI — `/opportunities/[id]`

Header, acties (fase/eigenaar wijzigen, gewonnen/verloren/heropenen/
archiveren), en maximaal hergebruik van bestaande Customer 360-
componenten (`TasksPanel`/`NotesPanel`/`AppointmentsPanel`/`FilesPanel`,
elk uitgebreid met een optionele `opportunityId`-prop in plaats van
herschreven) plus "klantcommunicatie" (calls/e-mails, expliciet gelabeld
als klantbreed, nooit gesuggereerd als opportunity-specifiek — er bestaat
geen mechanisme om een gesprek/e-mail aan één specifieke opportunity toe te
wijzen).

## 11. Customer 360

Geen nieuwe top-level tab. Commercieel-tab kreeg een "Verkoopkansen"-
sectie (incl. "Nieuwe verkoopkans"-actie); Overzicht-tab kreeg een "Open
verkoopkansen"-blok (elke opportunity los getoond, nooit samengevouwen);
`CustomerHeader` toont een badge bij >0 open verkoopkansen. Bevestigd met
een klant met 0/1/meerdere opportunities (staging-E2E maakte er twee
gelijktijdig voor dezelfde klant aan).

## 12. Timeline

`getOpportunityTimeline()` — uitsluitend Control-Center-eigen
`Activity`-rijen via `relatedOpportunityId`, nooit een gesimuleerd filter
op externe calls/e-mails/offertes (die blijven categorie B/live/
gefedereerd, ADR-008, ongewijzigd).

## 13. Command palette

Nieuwe `opportunities`-groep in `/api/search`, zoekend op titel én
klantnaam — beide bevestigd op staging. Bestaande vier groepen
(klanten/taken/orders/offertes) ongewijzigd en regressievrij bevestigd.

## 14. Audit/security

10 nieuwe `AuditAction`-waarden (TS-only union, geen migratie nodig —
`AuditEvent.action` is een `String`-kolom). Geen hard delete — alleen
`archivedAt`. IDOR-check op externe-link-verwijdering. Geen `dangerouslySetInnerHTML`
ergens toegevoegd. Geldinvoer server-side gevalideerd (nooit alleen
client-side).

## 15. Tests / typecheck / lint / build

**Nieuwe testbaseline: 274/274 groen** (was 235 na Phase 3C) — 39 nieuwe
tests over 2 nieuwe bestanden (`tests/opportunities.test.ts`,
`tests/opportunity-relations.test.ts`), plus `tests/fixtures.ts` uitgebreid
met Opportunity-cleanup (FK-veilig, RESTRICT-relaties naar User/
CustomerProfile). `npm run typecheck`, `npm run lint`, `npm run build`
(Turbopack) alle drie groen, geen nieuwe waarschuwingen.

## 16. Staging deploy

`fly deploy --app stones4u-control-center-staging` — build succesvol,
`release_command: npx prisma migrate deploy` succesvol (migratie
toegepast, geen fouten), rolling update over beide machines succesvol,
versie 19, beide machines `started`/`1 total, 1 passing`, `/api/health` →
200.

## 17. Staging E2E

Uitgevoerd tegen echte staging-data met de bekende echte testklant
("JS Verkoelen", `gid://shopify/Customer/25667205267788`) via een
throwaway AGENT- + throwaway VIEWER-testaccount (zelfde bewezen patroon
als Phase 3C: server-side aangemaakt, ingelogd via loopback-HTTP binnen
hetzelfde proces, wachtwoord nooit gelogd/geprint, volledig opgeruimd in
een `finally`-blok). Alle checks uit de bouwopdracht §26 doorlopen — twee
gelijktijdige opportunities voor dezelfde klant, fasewijziging,
eigenaarwijziging, lijst/kanban, detail, taak/notitie/afspraak met
correcte klant-afleiding, externe link toevoegen/dedupliceren/verwijderen,
Customer 360, command palette (titel én klantnaam), gewonnen, verloren,
heropend, gearchiveerd, VIEWER read-only (403 op elke muterende poging).

Eén schijnbare afwijking onderzocht en verklaard: een statische
HTML-fetch van de Commercieel-tab toonde de nieuwe opportunity-titel niet
(`CUSTOMER360_SHOWS_OPPORTUNITY_TITLE=false`) — dit is een test-
methodologie-artefact (de "Verkoopkansen"-sectie is een client-component
die pas ná hydratie data ophaalt via `useEffect`, net als de bestaande
`TasksPanel`/`NotesPanel` dat al deden), geen echte fout. Expliciet
geverifieerd door het exacte endpoint dat de component zelf aanroept
(`GET /api/customers/[id]/opportunities`) rechtstreeks te bevragen — dat
retourneerde de opportunity correct (`CLIENT_FETCH_ENDPOINT_CONTAINS_TITLE=true`).

## 18. Regressie

Dashboard, klantenlijst, takenlijst, Customer 360 (overzicht/activiteit/
bestanden-tabs), alles HTTP 200 op staging na de deploy. Bestaande 235
tests uit Phase 1–3C allemaal nog steeds groen (onderdeel van de 274).

## 19. Cleanup

Alle door het E2E-script aangemaakte data (2 testaccounts, 2 test-
opportunity's, 1 test-taak, 1 test-notitie, 1 test-afspraak, 1 test-
externe-link) verwijderd in de `finally`-afhandeling — bevestigd met een
losse, na afloop uitgevoerde databasecontrole
(`testOpportunities=0, testUsers=0, totalOpportunities=0,
totalOpportunityExternalLinks=0` — de laatste twee bevestigen dat er vóór
dit E2E-run al geen enkele opportunity op staging bestond en er na cleanup
weer geen enkele bestaat). Scratchscripts verwijderd van zowel de
staging-machine als lokaal.

## 20. Openstaande punten voor Phase 4B (bewust uitgesteld, geen scope creep)

Dashboardwidgets (pipeline-waarde, gewogen pipeline, opvolging-tellingen),
automatiserings-suggestiebanners (offerte gekoppeld → fasevoorstel; order
geplaatst → win-voorstel via het al bestaande `completedOrder`-signaal),
rapportagesectie, drag-and-drop-kanban — allemaal expliciet uitgesteld
per `32-PHASE-4-SALES-PIPELINE-ARCHITECTURE.md` §20 en niet in deze
bouwronde aangeraakt.

## 21. MUST FIX-ronde (2026-09-03) — pre-production data-semantics review

Een gerichte pre-production review (drie focusgebieden: WON/LOST/REOPEN-
semantiek, Decimal/geld-semantiek, Customer↔Opportunity↔owned-record-
integriteit) leverde de eindconclusie "SHOULD CHANGE BEFORE PRODUCTION" met
zes concrete MUST FIX-bevindingen op. Alle zes zijn in deze ronde opgelost
in `src/modules/opportunities/opportunity.service.ts`, uitsluitend
service-laag-wijzigingen — **geen schema-/migratiewijziging nodig**.

### 21.1 Reopen-semantiek (fix 1)

`reopen()` wist nu ook `wonAt`, `lostAt`, en `finalValue` (niet alleen
`lostReason`) — een Opportunity-rij is daarmee altijd de HUIDIGE canonical
state; volledige historie blijft onvoorwaardelijk beschikbaar via
`AuditEvent` (`opportunity.won`/`.lost`/`.reopened`) en `Activity`
(`OPPORTUNITY_WON`/`_LOST`/`_REOPENED`), die door deze wijziging niet
geraakt worden. Zie ADR-009 §1 voor de volledige onderbouwing.

### 21.2 Strikte state-transitions (fix 2)

`markWon()`/`markLost()` weigeren nu een aanroep wanneer de opportunity
niet `status=OPEN` is (`OpportunityValidationError`, "heropen eerst") —
een directe LOST→WON of WON→LOST kan niet meer, symmetrisch met
`changeStage()`'s bestaande guard. Herhaalde aanroepen op de reeds-bereikte
doelstatus blijven een idempotente no-op (geen dubbele audit/Activity).

### 21.3 Update geblokkeerd op gesloten opportunity (fix 3)

`updateOpportunity()` weigert nu elke inhoudelijke veldwijziging
(titel/omschrijving/`estimatedValue`/`probability`/`expectedCloseDate`)
zolang `status !== OPEN`. `assignOwner()` is bewust NIET op dezelfde manier
begrensd — zie ADR-009 §10 voor de expliciete, gedocumenteerde
onderbouwing (eigenaarschap is een administratief feit, geen commercieel
feit van de deal).

### 21.4 Geldvalidatie (fix 4)

Eén centrale `parseMoneyInput()` vervangt de oude, te losse
`Number()`-validatie: strikt unsigned-decimaal patroon (max 2 decimalen,
geen exponentnotatie, geen minteken), geverifieerd tegen `Decimal(12,2)`'s
bovengrens (`9999999999.99`) via `Prisma.Decimal`-rekenkunde. Ongeldige
invoer resulteert nu altijd in een nette `OpportunityValidationError` → 400,
nooit meer in een onafgevangen database-overflow (500). Getal-invoer blijft
ondersteund, defensief genormaliseerd (zie ADR-009 §11).

### 21.5 Inactieve standaard-eigenaar (fix 5)

`createOpportunity()`'s standaardpad (klant-accountmanager, geen expliciete
`ownerUserId`) controleert nu ook actieve status — inactief of ontbrekend
valt terug op de aanmaker. Het expliciete-eigenaar-pad had deze controle
al.

### 21.6 Shopify-koppelintegriteit (fix 6)

`addExternalLink()` verifieert nu, voor `SHOPIFY_ORDER`/
`SHOPIFY_DRAFT_ORDER`, dat de `externalRef` daadwerkelijk bij de
Shopify-klant van de opportunity hoort, via de bestaande
`getShopifyCustomerOrders()`/`getShopifyCustomerDraftOrders()`-adapters —
geen nieuwe Shopify-integratie, geen lokale documentkopie. Quote-links
(`OFFERTEAPP_QUOTE`/`S4U_QUOTE_APP_QUOTE`) hebben deze verificatie bewust
nog niet — gedocumenteerde beperking, zie ADR-009 §13.

### 21.7 Tests — nieuwe baseline: 320/320

39 nieuwe/aangepaste tests in `tests/opportunities.test.ts` (27→66):
canonical-state-na-reopen (OPEN→WON→REOPEN en OPEN→WON→REOPEN→LOST),
volledige transitiematrix (OPEN→WON, OPEN→LOST, WON→LOST geblokkeerd,
LOST→WON geblokkeerd, WON→reopen→LOST, LOST→reopen→WON, herhaalde
markWon/markLost idempotent), update-geblokkeerd-bij-gesloten (WON/LOST,
plus bevestiging dat het weer werkt na reopen, plus bevestiging dat
owner-wijziging wél blijft werken op een gesloten opportunity), volledige
geldvalidatie-matrix (`it.each` voor alle geaccepteerde/geweigerde
strings/getallen uit de opdracht, plus Infinity/-Infinity/NaN als ruwe
getallen, plus number-input-normalisatie inclusief float-ruis-tolerantie),
inactieve-accountmanager-fallback + expliciet-inactieve-eigenaar-geweigerd.
Eén bestaand test-scenario (`opportunity-relations.test.ts`, "adds a draft
order link and an order link independently") is herschreven naar de twee
offerte-linktypes (die geen Shopify-mocking nodig hebben) — de
Shopify-specifieke dekking verhuisde naar het nieuwe, correct-gemockte
`tests/opportunity-shopify-links.test.ts` (7 tests: same-customer/
cross-customer/nonexistent voor zowel order als conceptbestelling, lege
ref zonder Shopify-aanroep, quote-links onaangeraakt). Alle 274 bestaande
tests blijven groen. Eén test (`email-matching-identity.test.ts`) faalde
één keer met een FK-fout bij parallelle bestandsuitvoering, geverifieerd
als bestaande, dit-bestand-vooraf-al-bestaande test-parallellisme-
flakiness (niet gerelateerd aan deze wijzigingen — bevestigd door het
bestand geïsoleerd te draaien, waar het altijd slaagt) en verdwenen bij
een volledige hertest.

### 21.8 Quality gates

`npm run test` (320/320), `npm run typecheck`, `npm run lint`,
`npm run build` (Turbopack) — alle vier groen.

### 21.9 Staging deploy

`fly deploy --app stones4u-control-center-staging` — versie 20, beide
machines `started`/gezond, release_command meldde letterlijk
`"5 migrations found in prisma/migrations" / "No pending migrations to
apply."` — bevestigt dat er geen nieuwe migratie nodig of gemaakt is.

### 21.10 Staging E2E-hervalidatie

Uitgevoerd tegen echte Shopify-data: twee echte klanten met elk een echte
order (Robert Vossen, `gid://shopify/Customer/26510064779596`, en Wiel
Pelzer, `gid://shopify/Customer/26494886707532`) specifiek om de
cross-customer-linkweigering met échte, niet-gesimuleerde Shopify-
identiteit te bewijzen. Alle 12 gevraagde scenario's (A–L) bevestigd
groen: create, WON, reopen, canonical-state-na-reopen (alle vier velden
null), LOST, directe WON↔LOST-blokkade in beide richtingen, update-
geblokkeerd-op-gesloten + weer-toegestaan-na-reopen, inactieve-
accountmanager-fallback, geldgrens (`9999999999.99` geaccepteerd), overflow
+ exponent (nette 400, geen 500), Shopify same-customer-link (200/201),
Shopify cross-customer-link geblokkeerd (400, nul rijen aangemaakt).
Regressie (pipeline, opportunity-detail, Customer 360 incl. Commercieel-
tab, timeline, bestanden, taken, dashboard, opportunity-scoped taak/
notitie/afspraak aanmaken) allemaal HTTP 200/201. Eén schijnbare afwijking
(`REGRESSION_COMMAND_PALETTE_FINDS_OPPORTUNITY=false`) onderzocht en
verklaard als test-scriptfout (het script had de opportunity-titel al
hernoemd tijdens de eigen update-na-reopen-stap vóórdat het naar de
oorspronkelijke titel zocht) — expliciet geverifieerd met een aparte,
schone zoekopdracht op een verse titel, die correct slaagde.

### 21.11 Cleanup

Twee tijdelijke testaccounts (agent + inactieve-manager-simulatie), alle
tijdens deze ronde aangemaakte test-opportunity's/links/taken/notities/
afspraken verwijderd. Definitieve databasecontrole:
`testOpportunities=0, testUsers=0, verifyUsers=0, totalOpportunities=0,
totalOpportunityExternalLinks=0` — bevestigt zowel volledige opruiming als
dat er vóór en na deze ronde geen enkele opportunity op staging bestond.
Scratchscripts verwijderd van beide staging-machines en lokaal. De echte
Shopify-`CustomerProfile`-rijen voor Robert Vossen/Wiel Pelzer zijn NIET
verwijderd (dezelfde precedent als eerdere fases: een lazily aangemaakt
klantprofiel via `/api/customers/resolve` is een normale, echte
gebruiksflow, geen testartefact).

### 21.12 Resterende bekende beperkingen

- Quote-links (`OFFERTEAPP_QUOTE`/`S4U_QUOTE_APP_QUOTE`) hebben nog geen
  server-side klantidentiteit-verificatie — bewust uitgesteld (ADR-009
  §13), zou een sibling-API-uitbreiding vergen.
- Owner-wijziging blijft bewust mogelijk op gesloten opportunities
  (deliberate, gedocumenteerde keuze — ADR-009 §10), geen beperking maar een
  expliciete ontwerpbeslissing.
- Archived opportunities blokkeren nog steeds geen nieuwe
  taak/notitie/afspraak/bestand-aanmaak — ongewijzigd uit de oorspronkelijke
  Phase 4A-bouwronde, buiten scope van deze fix-ronde (geen MUST FIX).
