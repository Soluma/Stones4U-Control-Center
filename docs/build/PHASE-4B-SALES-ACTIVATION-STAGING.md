# Phase 4B — Sales Follow-up, Dashboard & Automation: staging build report

**Status**: gebouwd, getest (385/385 tests groen, typecheck/lint/build
groen), gedeployed naar `stones4u-control-center-staging` (versie 21, geen
nieuwe migratie — "Database schema is up to date!"), gevalideerd met een
echte staging-E2E (28/28 checks) plus een aparte regressie-smoke (6/6
checks). Niet gecommit, niet gepusht, geen productie-actie.

Vervolg op `docs/architecture/ADR-009-OPPORTUNITY-PIPELINE-MODEL.md`,
`docs/platform-discovery/34-PHASE-4B-SALES-ACTIVATION-DISCOVERY.md`,
`35-PHASE-4B-SALES-ACTIVATION-ARCHITECTURE.md`,
`36-PHASE-4B-BUILD-SPEC.md`. Geen nieuwe ADR (zie architectuurdoc §0 voor de
onderbouwing — Phase 4B introduceert geen nieuwe entiteit/state
machine/persistente relatie).

## 1. Attention engine

`src/modules/opportunities/attention.ts` (nieuw) — pure functies, geen
eigen queries:

- `deriveOpportunityAttention()`: `RED` (`OVERDUE_TASK`,
  `CLOSE_DATE_PASSED`) > `ORANGE` (`STALE`, `NO_NEXT_ACTION`) > `BLUE`
  (`SHOPIFY_ORDER_PLACED`, `QUOTE_AHEAD_OF_STAGE`). Sluit meteen het
  bestaande testgat rond Phase 4A's `needsFollowUp`/`attachFollowUpFlags()`
  — die had nul tests; het gedrag leeft nu volledig in deze, wél volledig
  geteste, functie.
- `deriveNextAction()`: `OVERDUE`/`TODAY`/`UPCOMING`/`UNSCHEDULED`/`NONE`,
  uitsluitend op basis van de al bestaande `Task`-include — geen nieuw veld.
- `formatNextAction()`: gedeelde Nederlandse presentatietekst, gebruikt door
  zowel de kanban-kaart (client) als de detailpagina (server) — één bron.
- `deriveShopifyOrderSignal()` / `deriveQuoteAheadOfStageSignal()`:
  uitgetrokken uit de detailpagina naar pure, los testbare functies (zie
  §5/§6) — puur cross-referentie over al opgehaalde `draftOrders`/`orders`/
  `quotes`-arrays, geen nieuwe Shopify/quote-aanroep.

## 2. Stale-drempels (per fase, definitief vastgesteld)

`STAGE_STALE_THRESHOLD_DAYS` in `src/modules/opportunities/labels.ts`:
`NEW: 3, CONTACTED: 5, NEEDS_DEFINED: 7, QUOTE_PREPARATION: 3, QUOTE_SENT: 7,
NEGOTIATION: 7` — de late-fase-afwijking (7 i.p.v. de oorspronkelijk
gesuggereerde 5 dagen) is expliciet door Fons bevestigd in de bouwopdracht.
Stale-anchor: `max(createdAt, laatste-opportunity-Activity)`, nooit een
klantbreed call/e-mail-tijdstip (zie §4).

## 3. Last-activity propagatie — gevonden en gedicht gat

Alleen de vier *aanmaak*-functies (`createTask`/`createNote`/
`createAppointment`/`uploadFile`) zetten `relatedOpportunityId` op hun
Activity-schrijfactie; elke andere mutatie (statuswijziging, bewerking,
reactie, checklist-afvinking, afspraak-afronding/annulering,
bestandsverwijdering, notitie-bewerking/-verwijdering) deed dat niet. Zonder
fix zou "laatste activiteit" alleen de *aanmaak* van een gekoppeld record
weerspiegelen, niet lopend werk erop — een reële nauwkeurigheidsfout voor de
nieuwe attention-engine. Gefixt in `task.service.ts`, `note.service.ts`,
`appointment.service.ts`, `file.service.ts` — elke Activity-schrijfactie die
al een opportunity-relatie kent, zet nu ook `relatedOpportunityId`.

## 4. "Laatste klantcontact" vs. "laatste activiteit"

Ongewijzigd t.o.v. het architectuurvoorstel — twee aparte begrippen, nooit
vermengd:

- **Laatste activiteit** (Control-Center-eigen, opportunity-niveau,
  gebatcht via `Activity.groupBy`) — gebruikt op pipeline/dashboard/detail
  als stale-anchor.
- **Laatste klantcontact** (call/e-mail/afspraak, klantniveau, alleen live
  op de detailpagina/Customer 360 beschikbaar) — **nooit** benaderd op de
  pipeline/dashboard met een halfcorrecte waarde. Prestatie/juistheid boven
  extra informatie, exact zoals gevraagd.

## 5. Dashboard-metrics

`src/modules/opportunities/dashboard.ts` (nieuw), `getSalesDashboardMetrics
(filter: {ownerUserId?, stage?})`:

- **A/B** open pipeline-waarde / gewogen pipeline-waarde: native Postgres
  `SUM` resp. `Prisma.Decimal`-accumulatie (fase-standaardkans bestaat
  alleen in TS) — nooit een JS-`Number`-optelling.
- **C/D** aandacht-telling / achterstallige-opvolgingen-telling: hergebruikt
  `listOpportunities()` zelf, zodat het dashboardcijfer nooit kan afwijken
  van wat de pipeline voor hetzelfde filter toont.
- **E** verwachte sluitingen komende 30 dagen (vaste horizon).
- **F/G** gewonnen/verloren deze kalendermaand: filtert altijd op `status`
  (canonical-state-autoriteit, ADR-009), gecombineerd met `wonAt`/`lostAt` —
  nooit `wonAt/lostAt IS NOT NULL` alleen (directe regressie-borging tegen
  de Phase 4A MUST-FIX-bevinding).
- **H** recent gewonnen/verloren: apart vast 30-dagen-venster.

`GET /api/opportunities/dashboard` (nieuw, `requireUser()`, dus ook
VIEWER-leesbaar) — query-params `ownerUserId`/`stage`.

## 6. Pipeline-UI

- `AttentionBadge` (nieuw, gedeeld): icoon + tekst (nooit kleur-alleen),
  `compact`-modus (icoon + `sr-only`-tekst) voor de kanban-kaart/Customer
  360-rijen.
- `OpportunitiesBoard.tsx`: volledig herschreven — aandacht-indicator +
  volgende-actie op elke kaart (in de praktijk uitsluitend RED/ORANGE —
  zie de implementation note in architectuurdoc §17, toegevoegd tijdens
  Phase 6A's final review: het gebatchte pipeline-pad laadt de externe
  commerciële signalen voor BLUE niet, alleen de detailpagina doet dat),
  eigenaarfilter met "Mijn verkoopkansen"
  (standaard voor AGENT/USER, "alle" standaard voor ADMIN), lijstweergave nu
  een volledige tabel met "Volgende actie"/"Aandacht"-kolommen.
- Drag-and-drop: `@dnd-kit/core`/`@dnd-kit/utilities` (nieuwe dependency,
  ingebouwde keyboard-sensor). `canEdit`-prop bepaalt of drag-handles
  gerenderd worden; optimistische verplaatsing met rollback bij een
  fout-response; roept exact `PATCH /api/opportunities/[id]/stage` aan —
  dezelfde route/service/audit als de bestaande detailpagina-dropdown, die
  ongewijzigd blijft bestaan als gegarandeerd toetsenbord-alternatief.

## 7. Opportunity-detail — "Opvolging"-sectie

Nieuw paneel in `src/app/(app)/opportunities/[id]/page.tsx` (sidebar, naast
`OpportunityActions`): aandachtredenen (via `AttentionBadge`), volgende
actie (`formatNextAction`), laatste opportunity-activiteit
(`formatDateTime`), en de twee BLUE-suggestiebanners. Geen tweede
dashboard — hergebruikt uitsluitend al bestaande, al opgehaalde data.

- `ShopifyOrderSignalBanner.tsx` (nieuw): toont wanneer een gekoppelde,
  al cross-customer-geverifieerde `SHOPIFY_DRAFT_ORDER`-link een
  `completedOrder` heeft. Opent het bestaande `markWon()`-dialoogvenster met
  een **voorgestelde**, aanpasbare `finalValue` uit de echte Shopify-
  orderwaarde — nooit blind ingevuld/opgeslagen, altijd een expliciete
  bevestigingsklik.
- `QuoteAheadOfStageBanner.tsx` (nieuw): toont wanneer de klant een offerte
  heeft terwijl de fase nog vóór `QUOTE_SENT` staat en er nog geen actieve
  offerte-link is. Roept op bevestiging de bestaande `changeStage()`-route
  aan naar `QUOTE_SENT`.

## 8. Customer 360

`OpenOpportunitiesBlock` (Overzicht-tab, server-gerenderd) en
`OpportunitiesSection` (Commercieel-tab, client-fetched) tonen beide nu een
`AttentionBadge` per opportunity — geen samengevouwen/globale status, geen
wijziging aan `CustomerProfile.crmStatus` of enige andere klantbrede status.

## 9. Hoofddashboard — nieuwe Sales-sectie

`src/app/(app)/page.tsx`: nieuwe "Verkoop"-sectie naast de bestaande Taken/
Afspraken/Activiteit-secties — open/gewogen pipeline-waarde, aandacht-
telling + achterstallig, verwachte sluitingen komende 30 dagen, gewonnen/
verloren deze maand + de bijbehorende korte lijsten. Standaard-eigenaarfilter
volgt hetzelfde patroon als de pipeline (ADMIN: iedereen, AGENT/USER: eigen
verkoopkansen) — geen aparte periodekiezer op deze compacte kaart, wel een
link naar de volledige pijplijn.

## 10. Performance / geen N+1

Geverifieerd via codelezing (geen automatische query-tellingstest — dit
project heeft daar geen bestaande infrastructuur voor, en de gedeelde
`prisma`-singleton logt standaard geen queries; een aparte
instrumentatie-client zou de eigenlijke servicelaag-aanroepen niet
waarnemen): `attachAttention()` gebruikt exact één gebatchte
`Activity.groupBy` voor alle rijen in een pipeline-call, nooit een query per
rij; `getSalesDashboardMetrics()` voert een vaste `Promise.all` van 6
queries uit, ongeacht N. Nergens een Shopify/IMAP/PBX-aanroep per
kaart/rij — die blijven, zoals in Phase 4A, exclusief voor de detailpagina.

## 11. Audit / RBAC

Geen nieuwe `AuditAction`-waarde nodig: drag hergebruikt
`opportunity.stage_changed`, mens-bevestigde signalen hergebruiken
`opportunity.won`/`opportunity.stage_changed`. Afgeleide aandachtstatus zelf
schrijft geen audit (leesweergave). VIEWER: dashboard/pipeline volledig
leesbaar, geen drag-handles, geen mutatieknoppen — bestaande
`requireWriteAccess()`-gates ongewijzigd.

## 12. Migratie/schema

**Geen wijziging.** `git diff prisma/schema.prisma` en
`git status prisma/migrations` blijven leeg gedurende deze hele ronde —
elke nieuwe waarde is een pure berekening over bestaande kolommen.

## 13. Tests — nieuwe baseline

385/385 groen (was 320 vóór Phase 4B; +65 nieuwe tests), typecheck/lint/
build alle groen.

- `tests/opportunity-attention.test.ts` (nieuw, 53 tests): pure-functie-
  dekking van `deriveNextAction`/`deriveOpportunityAttention`/
  `formatNextAction`/`deriveShopifyOrderSignal`/
  `deriveQuoteAheadOfStageSignal` (alle 6 fase-drempels individueel, op en
  net over de grens; RED/ORANGE/BLUE-prioriteit; WON/LOST/archived altijd
  `NONE`), plus een integratieblok tegen een echte database
  (`attachAttention` via `listOpportunities()`,
  `getOpportunityAttentionContext()`).
- `tests/opportunity-dashboard.test.ts` (nieuw, 10 tests): open-pipeline
  sluit archief/WON/LOST uit, gewogen pipeline met expliciete 0%/100%/
  fase-standaard-kans en een overgeslagen `null`-waarde, cent-precisie
  zonder float-drift, gewonnen/verloren-deze-maand met een directe
  regressietest voor de heropend-toch-niet-meegeteld-bevinding uit de
  Phase 4A MUST-FIX-ronde, eigenaarfilter-isolatie.
- `tests/opportunities.test.ts`: +2 tests (drag/drop-audit, no-op-op-
  dezelfde-kolom) — VIEWER/gesloten/gearchiveerd/eigendom voor
  fasewijziging waren al gedekt, bewust niet herhaald (build spec §24: "geen
  overmatig fragile DOM-drag simulation als service/API-tests dezelfde
  garantie beter bewijzen").
- `tests/fixtures.ts`: `createTestCustomerProfile()`'s `displayName` is nu
  gerandomiseerd (was een vaste `"Fixture Klant"`-literal) — de vaste naam
  liet parallel draaiende testbestanden elkaars
  `searchOpportunities(term, take: 8)`-resultaten verdringen; blootgelegd
  door het toegenomen testvolume van deze ronde, geen Phase 4B-productiecode.

**Bewust niet geautomatiseerd** (build spec §24, met reden): UI-rollback bij
een fout-response (client-side `OpportunitiesBoard.tsx`-logica, geen
DOM-drag-simulatie per user-instructie) en query-tellingsinstrumentatie
(geen bestaande infrastructuur, zie §10) — beide zijn wel via staging-E2E en
codelezing geverifieerd, zie §14.

## 14. Staging-deploy en E2E

Gedeployed naar `stones4u-control-center-staging` (beide machines versie
21, gezond); `npx prisma migrate status` bevestigt "Database schema is up
to date!" — geen migratie uitgevoerd, zoals verwacht.

Een op-maat E2E-script (tsx, binnen de container, loopback-HTTP tegen de
echte gedeployde routes; alleen fixture-setup/opruiming via directe Prisma-
toegang) dekte 28 checks, allemaal groen:

- Login als ADMIN/VIEWER-testaccounts.
- Vijf synthetische verkoopkansen (vers/stale/achterstallige-taak/
  verstreken-sluitdatum/gewogen) via de echte `POST /api/opportunities`-
  route.
- Pipeline-lijst (`GET /api/opportunities`): juiste aandachtredenen en
  `nextAction`-status per scenario.
- Eigenaarfilter: correct uitgesloten/inbegrepen op `ownerUserId`.
- Dashboard-metrics (`GET /api/opportunities/dashboard`): pipeline-waarde,
  gewogen pipeline, aandacht-telling, achterstallige-telling.
- Drag/drop (`PATCH /api/opportunities/[id]/stage`): succesvolle
  fasewijziging + AuditEvent, ongeldige fase geweigerd (400), VIEWER
  geweigerd (403), VIEWER ook geweigerd bij het aanmaken van een
  verkoopkans (403).
- Detailpagina: "Opvolging"-sectie zichtbaar in de echte gerenderde HTML,
  inclusief de achterstallige-taak-titel als volgende-actie-tekst.
- Customer 360 (Overzicht-tab, tegen de bestaande echte testklant "JS
  Verkoelen" — een volledig synthetische Shopify-gid laat de pagina in zijn
  fail-safe-tak vallen, dus hergebruikt zoals in Phase 4A): de nieuwe
  verkoopkans zichtbaar met aandachtindicator.
- Hoofddashboard: nieuwe "Verkoop"-sectie zichtbaar.
- VIEWER kan de pipeline nog gewoon lezen (alleen schrijven geblokkeerd).
- Opruiming: alle testverkoopkansen/-taken/-gebruikers verwijderd,
  onafhankelijk geverifieerd met een tweede controlescript (0 achtergebleven
  rijen). De hergebruikte klant ("JS Verkoelen") is niet aangeraakt.

Een aparte regressie-smoke (6/6 groen) bevestigde dat de kernpagina's
(`/opportunities`, `/tasks`, `/customers`, `/`, command-palette-zoeken,
health-check) nog gewoon 200 teruggeven na de deploy. Volledige Phase
4A-regressie wordt daarnaast al gedekt door de 68 groene tests in
`tests/opportunities.test.ts` (ongewijzigde staat-machine/RBAC/geld-
semantiek) plus de overige 300+ ongewijzigde bestaande tests.

Alle scratchscripts zijn na gebruik van de staging-container verwijderd.

## 15. Afwijkingen van het architectuurvoorstel

Geen. Fasering exact zoals voorgesteld in architectuurdoc §23 (inclusief het
oorspronkelijk als "later, niet in 4B" gemarkeerde quote-signaal — de
bouwopdracht heeft dit alsnog expliciet in scope gezet, zonder verdere
aanpassingen aan het voorstel). §25's buildvolgorde is gevolgd.

## 16. Git

Niet gecommit, niet gepusht — alleen lokale werkboom-wijzigingen plus deze
staging-deploy. `git status --short` toont uitsluitend de verwachte
Phase 4B-bestanden (zie onder), geen geheimen, geen scratchbestanden.
