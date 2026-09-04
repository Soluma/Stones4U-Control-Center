# Phase 6A — Mijn Werk: staging build report

**Status**: gebouwd, getest (500/500 tests groen, typecheck/lint/build
groen), gedeployed naar `stones4u-control-center-staging` (versie 25,
geen nieuwe migratie — `release_command` bevestigde "Database schema is
up to date!"), gevalideerd met een staging-E2E (27/27 checks groen).
**Gecommit en gepusht** na een expliciete scopebeslissing (Optie A) over
opportunity-attention — zie hieronder.

**Definitieve scopebeslissing (final review vóór commit, 2026-09-04) —
Optie A**: de final review stelde vast dat de opportunity-
aandachtslijst BLUE-severity **structureel nooit** kan tonen via het
huidige, hergebruikte aggregate `listOpportunities()`-pad — niet
incidenteel, niet alleen een beperking van de synthetische staging-E2E.
Volledig bewijs in §21 hieronder. Er is expliciet besloten: **Phase 6A
levert RED/ORANGE op, BLUE wordt niet binnen deze fase gebouwd** —
geen Shopify-/quote-batch-integratie, geen externe aanroep per
opportunity, geen nieuwe architectuur. Dit is geen Phase 6A-regressie:
dezelfde beperking bestond al sinds Phase 4B in elk ander aggregate
opportunity-pad (pipeline-board, dashboard-tegel) — zie
`docs/platform-discovery/45-PHASE-6A-BUILD-SPEC.md` §1 voor de volledige
onderbouwing en `44-PHASE-6-NEXT-PHASE-ARCHITECTURE.md` §8 voor de
vastgelegde toekomstige kandidaat-fase ("Batched commercial opportunity
signals" — niet ontworpen, niet gebouwd). De code zelf vereiste geen
enkele wijziging: `getMyWorkOpportunityAttention()` en
`MyWorkOpportunitiesList.tsx` filteren/sorteren/renderen al generiek op
`attention.severity` — zodra de centrale attention-laag ooit BLUE-
signalen aanlevert, verschijnt een BLUE-opportunity automatisch en
correct gesorteerd in Mijn Werk.

Vervolg op `docs/platform-discovery/43-PHASE-6-CRM-WORKFLOW-DISCOVERY.md`,
`44-PHASE-6-NEXT-PHASE-ARCHITECTURE.md`, `45-PHASE-6A-BUILD-SPEC.md`.

## 1. Architectuur

Geen tweede dashboard-architectuur — de bestaande server-component
data-loading in `src/app/(app)/page.tsx` (één `Promise.all()`) is
uitgebreid, niet vervangen. Eén nieuwe, duidelijke read-laag:
`src/modules/dashboard/my-work.ts` (geen bestaande generieke
dashboard-module aanwezig om te hergebruiken — `dashboard.ts` in
`modules/opportunities/` is sales-specifiek, geen goede plek voor
cross-domain code). Drie functies (`getMyWorkTasks`, `getMyWorkAppointments`,
`getMyWorkOpportunityAttention`), geen enkele nieuwe route (server-side
aanroep, exact zoals `listUpcomingAppointments`/`getSalesDashboardMetrics`
dat vandaag al doen).

## 2. Mijn Werk data module

`getMyWorkTasks`/`getMyWorkAppointments`/`getMyWorkOpportunityAttention` —
puur lezend, geen mutatie, geen side effects, geen Activity/Audit-writes,
geen lazy Shopify-sync, geen matching. `getMyWorkOpportunityAttention`
hergebruikt `listOpportunities()` ongewijzigd (dezelfde ene-gebatchte-
groupBy, geen-N+1, geen-externe-call-per-kaart-implementatie als de
pipeline-board) — filtert/sorteert/capt alleen het resultaat, herberekent
nooit zelf attention. `SEVERITY_RANK` is geëxporteerd vanuit
`attention.ts` (was een private const) om duplicatie van de RED/ORANGE/
BLUE-rangorde te voorkomen — de enige wijziging aan `attention.ts` zelf,
puur een export-toevoeging, geen gedragswijziging.

## 3. Task query/scoping

`assignedToId: actor.id` (nooit `createdById`, en nooit een OR-conditie)
— consistent met de bestaande `getTaskSummary()`-tellingen op het
dashboard, zodat de nieuwe lijst nooit een ander aantal impliceert dan de
bestaande tegels. Status altijd `OPEN/IN_PROGRESS/WAITING`. Taken zonder
`dueAt` worden nooit getoond (build spec 45 definieert ze niet als
actionable — niet zelf verzonnen). Cap 10, `take: 10` op databaseniveau.

## 4. Appointment query/scoping

`assignedToId: actor.id` — een directe, betrouwbare relatie (geen gokken
nodig, `Appointment.assignedToId` bestaat al en is al geïndexeerd).
**Belangrijke, bewuste keuze**: uitsluitend "vandaag", geen fallback naar
de eerstvolgende afspraak wanneer vandaag leeg is — build spec 45
definieert die fallback niet, en de opdracht van vandaag maakte hem
conditioneel ("indien build spec dit al definieert"). Niet toegevoegd.
Bevestigd in staging-E2E scenario E: een afspraak van morgen verschijnt
niet in het Mijn Werk-blok (wél, terecht, in de bestaande, ongewijzigde
"Komende afspraken"-widget ernaast — zie §26).

## 5. Opportunity attention — hergebruik

`listOpportunities({ ownerUserId: actor.id, status: "OPEN", archived:
"exclude" })`, gefilterd op `attention.severity !== "NONE"`, gesorteerd
via het nu-geëxporteerde `SEVERITY_RANK`. RED/ORANGE/BLUE-logica, stale-
drempels, overdue-task-logica, expected-close-logica,
Shopify-completed-order-signaal en quote-signaal zijn **niet**
opnieuw geïmplementeerd — allemaal ongewijzigd uit Phase 4B.

## 6. ADMIN-semantiek

Definitieve productbeslissing van vandaag: ADMIN krijgt in Mijn Werk
**geen** teamweergave — exact dezelfde `assignedToId`/`ownerUserId: actor.id`-
scoping als elke andere rol, zonder uitzondering. Dit wijkt af van de
bestaande `listUpcomingAppointments()` (die ADMIN wél alles laat zien,
gebruikt door de bestaande "Komende afspraken"-widget) — dat bestaande
gedrag is **niet** gewijzigd, alleen niet hergebruikt voor het nieuwe
Mijn Werk-blok, dat zijn eigen, altijd-actor-scoped query heeft. Bevestigd
in staging-E2E scenario J: een ADMIN-testgebruiker zag alleen eigen taken,
nooit die van actor A of B.

## 7. Timezone/date-semantiek

Exact dezelfde dag-grens-berekening als de bestaande
`getTaskSummary()`-tegels: `new Date(); setHours(0,0,0,0)` voor
`startOfToday`, `+1 dag` voor `endOfToday` — servergebonden "lokale" tijd
(op Fly.io effectief UTC), bewust hergebruikt in plaats van een nieuwe
strategie te verzinnen. Grensgeval expliciet getest (unit + staging E2E):
een afspraak om 23:59 vandaag wordt meegenomen, een afspraak om 00:01
morgen niet.

## 8. Cap/sortering

Cap 10 op alle drie de lijsten, `take: 10` op databaseniveau voor taken
en afspraken. Voor opportunities is databaseniveau-`take` niet mogelijk
op de severity-filter (severity is een afgeleide, niet-opgeslagen waarde)
— filteren/sorteren gebeurt in-memory ná `listOpportunities()`, exact
hetzelfde patroon als de bestaande `dashboard.ts`'s
`attentionCount`/`overdueFollowUpsCount`
(`openOpportunities.filter((o) => o.attention.severity !== "NONE").length`)
al gebruikt — geen nieuw "fetch-all-then-slice"-antipatroon, precedent-
hergebruik. Sortering: taken/afspraken chronologisch (meest urgent/
vroegst eerst, geen aparte urgency-sort nodig — `dueAt`/`startsAt`
oplopend geeft dit al vanzelf); opportunities severity-eerst (RED voor
ORANGE), daarbinnen de volgorde die `listOpportunities()` al oplevert.

## 9. UI

Eén nieuwe sectie "Mijn Werk" op het bestaande hoofddashboard (geen
nieuwe route, geen derde dashboard), met drie compacte kolommen (Taken/
Afspraken/Verkoopkansen) via drie nieuwe, kleine presentatiecomponenten
(`MyWorkTasksList.tsx`, `MyWorkAppointmentsList.tsx`,
`MyWorkOpportunitiesList.tsx`), stijl consistent met
`OpenOpportunitiesBlock.tsx`/de bestaande "Komende afspraken"-sectie.
`AttentionBadge` (Phase 4B) hergebruikt ongewijzigd voor de
opportunity-severity-indicator.

## 10. Empty states

Exact de in de opdracht gegeven Nederlandse teksten: "Geen openstaande
taken voor vandaag.", "Geen afspraken vandaag.", "Geen verkoopkansen die
aandacht nodig hebben." — bevestigd in staging-E2E scenario K met een
verse testgebruiker zonder enige data.

## 11. Navigatie/acties

Elke rij is een link naar een bestaande route: taak → `/tasks/{id}`,
afspraak → `/customers/{customerProfileId}?tab=appointments` (exact het
patroon van de bestaande "Komende afspraken"-widget), opportunity →
`/opportunities/{id}`. Geen nieuwe detailpagina's. `customerDisplayName()`
(Phase 5A) hergebruikt voor klantpresentatie — geen dubbele
identity-logica.

## 12. Fail isolation

Elk van de drie Mijn Werk-reads heeft een eigen `try/catch` in `page.tsx`
(degradeert naar een lege lijst + `console.error` bij een fout) — een
storing in bijvoorbeeld de opportunity-aandachtslijst kan de taken-/
afspraken-blokken of de rest van het dashboard niet meenemen. Consistent
met het bestaande fail-isolation-patroon op `customers/[id]/page.tsx`.

## 13. Query count/performance

Geen externe aanroepen (100% Control-Center-owned data: Task/Appointment/
Opportunity). Geen N+1: taken/afspraken zijn elk één `findMany` met
`take: 10`; opportunities hergebruiken `listOpportunities()`'s al-
gebatchte `attachAttention()` (één `groupBy` voor de hele pagina, geen
per-rij query). Alle drie draaien binnen het al bestaande `Promise.all()`
op het dashboard — nul extra sequentiële round-trips.

## 14. Security/RBAC

Actor komt uitsluitend uit `getSessionUser()` (server-side, cookie-
gebaseerde sessie) — geen enkel userId/filter-argument komt van de
client. Geen nieuwe schrijfactie, dus geen nieuwe IDOR-oppervlakte:
elke query is hard gescoped op `actor.id` uit de sessie. VIEWER kan het
dashboard lezen (bevestigd, staging-E2E scenario N) maar heeft geen
enkele muterende actie in Mijn Werk (er is er ook geen — puur
navigatie-links). Detail-routes (`/tasks/{id}`, `/opportunities/{id}`,
`/customers/{id}`) voeren hun eigen, al-bestaande autorisatie uit,
ongewijzigd.

## 15. Schema/migratie

Geen wijziging. `git diff -- prisma/schema.prisma` leeg, geen nieuw
bestand onder `prisma/migrations/`. Staging-deploy's `release_command`
bevestigde expliciet "Database schema is up to date!" met het
migratie-aantal ongewijzigd op 7.

## 16. Tests + nieuwe baseline

`tests/my-work.test.ts` (nieuw, 24 tests): actor-scoping (inclusief het
expliciete "ADMIN krijgt geen bypass"-scenario), overdue/due-today-
classificatie, grensgevallen (geen due date, toekomstige taak, afgeronde
taak), cap-10, sortering, dag-grens voor afspraken (23:59/00:01-test),
RED/ORANGE-opportunities, eigenaarschap-scoping, cap-10. **Eén
bijvangst tijdens het testen**: `tests/fixtures.ts`'s `cleanupUser()`
verwijderde nooit Task/Appointment-rijen die aan een gebruiker
gekoppeld waren zonder een `customerProfileId` (niet gedekt door
`cleanupCustomerProfile()`'s eigen, `customerProfileId`-gescoopte
verwijdering) — dit blokkeerde `prisma.user.delete()` via de
`Task_assignedToId_fkey`-constraint (silently geslikt door de bestaande
`.catch(() => undefined)`, dus geen testfout, wel een echte, stille
opruim-lek voor elke toekomstige test die een klantloze taak aanmaakt).
Gerepareerd in `tests/fixtures.ts` zelf (twee `deleteMany`-regels
toegevoegd, zelfde defensieve stijl als de bestaande
Opportunity/File/CustomerTag-regels) — een test-only bugfix, geen
productiecode gewijzigd. **Nieuwe baseline: 500/500 tests groen** (was
476 na Phase 5A, +24 nieuw).

## 17. Typecheck

Schoon (`npx tsc --noEmit -p .`).

## 18. Lint

Schoon (`npm run lint`).

## 19. Build

Slaagt (`npm run build`, Turbopack) — geen nieuwe route toegevoegd,
routetabel ongewijzigd op 26 pagina's/API-routes.

## 20. Staging deploy/versie

`fly deploy --config fly.toml -a stones4u-control-center-staging` —
versie 24 → 25, beide machines gezond (`1 total, 1 passing`). Geen
migratie toegepast (bevestigd, zie §15). DNS-verificatiewaarschuwing
(bekend, cosmetisch, zie eerdere fases) — `/api/health` bevestigde
achteraf 200 OK.

## 21. Staging E2E

27 scenario's (A–N, inclusief een expliciete H-toelichting), allemaal
groen, tegen de draaiende staging-app via tijdelijke ADMIN/AGENT/AGENT/
VIEWER/lege-AGENT-testgebruikers en één synthetisch `CustomerProfile`
met een nep-Shopify-GID (veilig: geen enkel pad in Mijn Werk raakt
Shopify, dus geen echte klant nodig — "geen externe testdata nodig" uit
de opdracht is hiermee letterlijk voldaan). Eén test-scriptfout
onderweg gevonden en gecorrigeerd (zie §26) — geen productiecodefout.

**Scenario H (BLUE-opportunity) — definitieve conclusie na de final
review** (opnieuw, dieper onderzocht vóór commit; dit vervangt de eerdere,
te vage "architectuurgrens"-formulering hierboven):

**BLUE is structureel onbereikbaar, geen fixture-beperking van de
synthetische E2E.** Bewijs, statisch geverifieerd in de exacte,
gedeployde code:

- `deriveOpportunityAttention()` (`attention.ts`) zet een BLUE-reden
  uitsluitend wanneer `input.shopifyOrderPlacedSignal` of
  `input.quoteAheadOfStageSignal` truthy is.
- De **enige** aanroep van deze functie binnen `listOpportunities()`'s
  pad is `attachAttention()` (`opportunity.service.ts:294-303`) — die
  geeft exact 7 velden door (`status, archivedAt, stage,
  expectedCloseDate, createdAt, nextAction, lastOpportunityActivityAt,
  now`); `shopifyOrderPlacedSignal`/`quoteAheadOfStageSignal` worden
  **nooit** meegegeven, dus zijn ze altijd `undefined` → altijd falsy →
  een BLUE-reden kan hier nooit ontstaan, in geen enkele productie- of
  stagingtoestand.
- Dit is geen Phase 6A-regressie: `getMyWorkOpportunityAttention()`
  hergebruikt `listOpportunities()` ongewijzigd, dus erft exact dit
  gedrag. Dezelfde `listOpportunities()` voedt ook de pipeline-board
  (`/opportunities`, via `/api/opportunities`) en de
  `attentionCount`-tegel op het bestaande hoofddashboard
  (`getSalesDashboardMetrics()`) — **beide hebben sinds Phase 4B nooit
  een BLUE-opportunity getoond.** Dit is een al bestaande, systeembrede
  eigenschap, niet iets dat deze fase introduceert.
- De twee BLUE-signalen worden uitsluitend berekend op de opportunity-
  detailpagina (`src/app/(app)/opportunities/[id]/page.tsx:132-133`),
  gevoed door per-opportunity live `getShopifyCustomerDraftOrders()`,
  `getShopifyCustomerOrders()`, en `QuotesAdapter.getQuotesForCustomer()`
  — stuk voor stuk single-customer-scoped functies. Geen enkele
  multi-klant/gebatchte variant bestaat vandaag ergens in de
  integratielaag.
- Toevoegen zou dus ofwel een live externe aanroep per opportunity/klant
  vereisen (expliciet verboden — "geen Shopify call per opportunity,
  geen quote-service call per opportunity"), ofwel een geheel nieuwe,
  gebatchte multi-klant Shopify-/quote-ophaalcapaciteit die vandaag
  nergens bestaat (een nieuwe, substantiële architectuurwijziging).

Conform de final-review-instructie was dit **geen documentatiedetail**:
de oorspronkelijke formulering ("RED/ORANGE/BLUE hergebruiken") suggereerde
ten onrechte dat BLUE al runtime-bereikbaar was. Er bestaat geen
kleinst-mogelijke fix binnen bestaande Phase 4B-bouwstenen (die bestaan
simpelweg niet voor een lijst). **Definitieve beslissing: Optie A** —
Phase 6A levert RED/ORANGE op de huidige, betrouwbare aggregate runtime;
BLUE-signal-loading wordt bewust niet toegevoegd (zie de scopebeslissing
bovenaan dit document en `docs/platform-discovery/45-PHASE-6A-BUILD-SPEC.md`
§1). Geen code was hiervoor nodig — `getMyWorkOpportunityAttention()`/
`MyWorkOpportunitiesList.tsx` waren al generiek over alle severities
gebouwd, dus BLUE verschijnt automatisch zodra de centrale attention-laag
het ooit aanlevert.

## 22. Regressie

Volledige lokale Vitest-suite (500 tests, alle Phase 1–5A-modules
inbegrepen) groen vóór de staging-deploy. Op staging zelf: `/customers`,
`/opportunities`, `/tasks`, `/customers/{id}` (Customer 360 — rendert
zowel Contacts als Activity-timeline, beide ongewijzigd deze fase),
`/api/search` allemaal 200, dashboard's bestaande "Verkoop"- en "Komende
afspraken"-secties functioneren ongewijzigd naast het nieuwe Mijn
Werk-blok.

## 23. Cleanup

Alle door de E2E aangemaakte rijen (5 testgebruikers, meerdere Task/
Appointment/Opportunity-rijen, 1 CustomerProfile) zijn verwijderd —
geverifieerd met een aparte controlequery (`leftover users: 0`, `tasks:
0`, `appointments: 0`, `opportunities: 0`, `customer profiles: 0`). Alle
scratch-scripts (`phase6a-e2e.ts`, `phase6a-verify-cleanup.ts`,
`phase6a-verify-appt.ts` — de laatste nooit daadwerkelijk gebruikt, wel
geüpload en weer verwijderd) zijn van de staging-container verwijderd en
geverifieerd afwezig.

## 24. Documentatie

Dit bestand. Doc 45 is niet gewijzigd — de implementatie volgt hem
exact; de enige toevoegingen zijn de drie definitieve
productbeslissingen die vandaag expliciet zijn gegeven (cap 10, module-
locatie, ADMIN-scoping) — geen van drieën was een open vraag meer bij
het bouwen.

## 25. Git-status

Alleen de verwachte bestanden gewijzigd/toegevoegd: Phase 6-discoverydocs
(43-45), `src/modules/dashboard/my-work.ts` (nieuw), drie nieuwe UI-
componenten, `src/app/(app)/page.tsx` (uitgebreid), `attention.ts` (één
export-toevoeging), `tests/fixtures.ts` (cleanup-fix), `tests/my-work.test.ts`
(nieuw), dit staging-rapport. Geen secrets, geen scratch-scripts, geen
staging-dumps, geen synthetische PII in de repo zelf (alleen op de
tijdelijke, inmiddels opgeruimde staging-database). **Niet gecommit,
niet gepusht.**

## 26. Afwijkingen

1. `tests/fixtures.ts`'s `cleanupUser()` uitgebreid met Task/Appointment-
   opruiming (zie §16) — test-only, geen architectuurwijziging.
2. Eerste versie van de staging-E2E-appointment-uitsluitingscheck
   scande de hele pagina-HTML in plaats van specifiek het Mijn
   Werk-blok, en gaf daardoor een valse FAIL (de bestaande, ongewijzigde
   "Komende afspraken"-widget toont terecht ook een afspraak van morgen
   voor dezelfde acteur — een ander scherm-element met een andere,
   eerder al bestaande scope). Gecorrigeerd door de check te scoping
   naar de Mijn Werk-sectie specifiek — geen productiecodewijziging
   nodig.
3. `SEVERITY_RANK` in `attention.ts` van `const` naar `export const`
   gewijzigd — puur een zichtbaarheidswijziging, geen gedragswijziging,
   om duplicatie van de RED/ORANGE/BLUE-rangorde te voorkomen.

## Blockers

Geen. De final-review vóór commit identificeerde een scope-vraag
(BLUE-severity is structureel onbereikbaar in de aggregate
opportunity-aandachtslijst — zie de scopebeslissing bovenaan dit
document) die is opgelost met een expliciete product/architectuurbeslissing
(Optie A: RED/ORANGE nu, BLUE bewust niet in Phase 6A) — geen openstaande
blocker meer.

---

**PHASE 6A STAGING: GO.** Definitieve scope: RED/ORANGE
opportunity-attention in Mijn Werk, future-compatible voor BLUE zodra de
centrale attention-laag dat ooit aanlevert (zie boven).
