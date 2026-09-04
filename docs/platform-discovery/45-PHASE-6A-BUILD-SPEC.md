# 45 — Phase 6A Build Spec: Mijn Werk (dashboard-uitbreiding)

**Status**: Build spec, geen implementatie. Vervolg op
`44-PHASE-6-NEXT-PHASE-ARCHITECTURE.md`. Klaar om te bouwen na expliciete
opdracht — dit document zelf bouwt niets.

## 1. IN scope

1. `listMyOverdueAndDueTodayTasks(actor)` in `task.service.ts` — retourneert
   open taken (status ∈ OPEN/IN_PROGRESS/WAITING) waarvan `dueAt` in het
   verleden ligt (overdue) of vandaag valt (dueToday), toegewezen aan
   `actor.id` tenzij `actor.role === "ADMIN"` (dan alle toegewezen taken,
   gegroepeerd per medewerker of ongefilterd — te bepalen bij bouw, geen
   architectuurbeslissing). Sortering: overdue eerst (oudste eerst), dan
   dueToday. Retourneert `{ id, title, dueAt, status, priority,
   customerProfile: { id, displayName, companyName, customerTypeOverride } | null,
   assignedTo: { id, name } }` — customerProfile-select bevat
   `customerTypeOverride` zodat `customerDisplayName()` direct bruikbaar is.
2. `listTodayAppointments(actor)` in `appointment.service.ts` — variant/
   parameter op het bestaande `listUpcomingAppointments()`-patroon,
   gescoped op `startsAt` binnen vandaag (00:00–23:59 lokale tijd),
   status SCHEDULED, zelfde actor-scoping als hierboven.
3. `listOpportunitiesNeedingAttention(actor, limit = 8)` in
   `opportunity.service.ts` (of `dashboard.ts`, te bepalen bij bouw naar
   waar de bestaande `attachAttention()`-helper al leeft) — filtert de
   output van de bestaande, centrale attention-engine op
   `severity !== "NONE"`, zelfde actor-scoping, gesorteerd op severity
   (RED vóór ORANGE vóór BLUE, generiek — geen aparte behandeling per
   severity).

   **Scopebeslissing (vastgesteld tijdens de final review vóór commit,
   2026-09-04) — Optie A, definitief**: Mijn Werk hergebruikt de centrale
   opportunity-attention-engine ongewijzigd via `listOpportunities()`/
   `attachAttention()`. Binnen die aggregate read-path worden
   `shopifyOrderPlacedSignal`/`quoteAheadOfStageSignal` niet geladen —
   die twee zijn de enige bronnen van een BLUE-reden
   (`deriveOpportunityAttention()`, `attention.ts`) — dus zijn **RED en
   ORANGE de enige severities die de huidige runtime daadwerkelijk kan
   opleveren**. Dit is een bewuste, vastgestelde grens van deze fase, geen
   toevallige omissie:

   - BLUE vereist per-opportunity/per-klant live commerciële signalen
     (Shopify-conceptbestelling-voltooiing, offerte-aanwezigheid) die
     vandaag uitsluitend op de opportunity-detailpagina live worden
     opgehaald (single-customer-scoped adapterfuncties — geen
     multi-klant/gebatchte variant bestaat).
   - Die signal-loading toevoegen aan een lijstweergave zou ofwel een
     live externe aanroep per opportunity/klant vereisen (expliciet
     verboden — dezelfde "geen externe call per card"-eis als elders in
     dit document), ofwel een geheel nieuwe, gebatchte multi-klant
     Shopify-/quote-ophaalcapaciteit die vandaag nergens bestaat.
   - Beide zouden deze kleine, gecontroleerde dashboarduitbreiding
     omzetten in een nieuwe integratie-architectuur — expliciet buiten
     scope voor Phase 6A.
   - **Dit is geen Phase 6A-regressie.** Dezelfde beperking bestaat al
     sinds Phase 4B in elk ander aggregate opportunity-pad dat
     `listOpportunities()` hergebruikt: de pipeline-board
     (`/opportunities`, via `/api/opportunities`) en de
     `attentionCount`-tegel op het bestaande hoofddashboard
     (`getSalesDashboardMetrics()`) hebben nooit een BLUE-opportunity
     getoond. Phase 6A erft dit ongewijzigd, net als die twee bestaande
     views. Zie ook de korte implementation-note toegevoegd aan de
     relevante Phase 4B-documentatie (final-review-rapport §5/§7).

   **Future-compatible code, geen dubbele logica**: `getMyWorkOpportunityAttention()`
   en `MyWorkOpportunitiesList.tsx` filteren/sorteren/renderen generiek op
   `attention.severity` (via het al bestaande, nu geëxporteerde
   `SEVERITY_RANK`, en `AttentionBadge`, die alle vier severities al
   ondersteunt) — er is **geen** aparte "alleen RED/ORANGE"-filtering of
   -weergavelogica toegevoegd. Zodra een toekomstige uitbreiding van de
   centrale `listOpportunities()`/`attachAttention()`-laag ooit
   betrouwbare, gebatchte BLUE-signalen aanlevert, verschijnt een
   BLUE-opportunity automatisch en correct gesorteerd in Mijn Werk, zonder
   dat deze module ooit opnieuw aangepast hoeft te worden. Geen
   codewijziging was hiervoor nodig — dit was al zo gebouwd.
4. Dashboardwijzigingen in `src/app/(app)/page.tsx`:
   - Vervang `TaskSummaryWidget`'s tellingen-only weergave door een
     samengevoegde sectie met de daadwerkelijke lijst (nieuw component
     `MyTasksList.tsx`), tellingen blijven ook zichtbaar.
   - Wijzig de bestaande "Komende afspraken"-sectie om `listTodayAppointments()`
     te gebruiken i.p.v. de generieke top-5.
   - Nieuwe sectie "Verkoopkansen die aandacht nodig hebben" (nieuw
     component `AttentionOpportunitiesList.tsx`), onder de bestaande
     Verkoop-metrics.
5. Elke sectie eigen `try/catch` rond de service-aanroep, met een
   gedegradeerde lege-staat bij falen (fail-isolation-patroon).

## 2. OUT of scope (expliciet, zie architectuurdoc §8 voor de motivatie)

- Cross-klant recente communicatie (mail/bellen)
- "Needs response"-signaal
- Quote-vervaldatum/staleness
- "Mijn klanten"/niet-toegewezen-klanten-weergave
- Taak-aanmaken vanuit een timeline-item
- `tel:`/`mailto:`-quickactions
- Appointment-reminders
- Notitie-pinning/zoeken
- Elke vorm van externe integratie-wijziging (Exact, kalendersync,
  levering/logistiek, quote-aanmaak)
- Nieuwe API-route
- Nieuwe Prisma-modellen/kolommen/migratie

## 3. Datamodel-impact

Geen. Geen migratie.

## 4. API-impact

Geen nieuwe route. Bestaande server-component data-fetching in
`page.tsx` wordt uitgebreid met drie extra entries in het al bestaande
`Promise.all()`.

## 5. UI-impact

Twee nieuwe presentatiecomponenten (`MyTasksList.tsx`,
`AttentionOpportunitiesList.tsx`), één gewijzigde bestaande sectie
("Komende afspraken" in `page.tsx`), stijl consistent met
`OpenOpportunitiesBlock.tsx`.

## 6. RBAC

Alleen lezen, bestaande paginabeveiliging (`getSessionUser()`), geen
wijziging aan `guards.ts`. Actor-scoping exact zoals de bestaande
Verkoop-sectie: niet-ADMIN ziet alleen eigen werk.

## 7. Audit

Geen nieuwe `AuditAction` — puur lezen genereert nooit een audit-event
in deze applicatie (bevestigd, zie architectuurdoc §6).

## 8. Performance

Geen nieuwe index nodig (bevestigd via directe schema-inspectie — zie
architectuurdoc §5). Geen nieuwe externe API-aanroep. Alles binnen het
bestaande `Promise.all()`, elke sectie fail-isolated.

## 9. Tests

Nieuwe/uitgebreide Vitest-tests, minimaal:
- `listMyOverdueAndDueTodayTasks`: AGENT ziet alleen eigen taken, ADMIN
  ziet alle; grensgeval taak die exact om middernacht vervalt
  (overdue vs. dueToday-classificatie); lege staat; DONE/CANCELLED-taken
  nooit meegenomen.
- `listTodayAppointments`: zelfde actor-scoping; een afspraak morgen
  vroeg wordt niet meegenomen, een afspraak vanavond laat wel; CANCELLED
  nooit meegenomen.
- `listOpportunitiesNeedingAttention`: severity-filter correct, RED
  gesorteerd vóór ORANGE, no-attention uitgesloten, actor-scoping,
  archived/closed opportunities nooit meegenomen (bestaand gedrag van de
  onderliggende attention-berekening, alleen bevestigen dat het
  doorwerkt). **Niet eisen** dat een live (staging-)E2E een BLUE-resultaat
  produceert — de huidige aggregate runtime kan dat niet leveren (§1). Een
  pure/unit-test die aantoont dat de presentatielaag een BLUE-object
  correct zou renderen (severity-styling, sortering) mag bestaan, maar
  moet expliciet gekaderd zijn als "toekomst-bestendigheid van de
  presentatie", nooit als bewijs dat de huidige runtime BLUE genereert.
- Regressietest: bestaande dashboard-tests (indien aanwezig) blijven
  groen; geen wijziging aan `getSalesDashboardMetrics()`'s bestaande
  return-shape.

## 10. Staging E2E

Zelfde gevestigde patroon als Phase 4A–5A: tijdelijke ADMIN- en AGENT-
testgebruiker, synthetische Task/Appointment/Opportunity-rijen gekoppeld
aan een bestaande, veilige Shopify-testklant (of een bestaande echte
klant zoals eerder gebruikt, uitsluitend lezend), verificatie dat:
- AGENT alleen eigen werk ziet, ADMIN alles.
- Overdue/dueToday-classificatie correct rendert.
- "Vandaag"-afspraken correct gefilterd worden.
- Attention-opportunities correct gesorteerd en gelinkt zijn.
- Lege staten correct renderen (nieuwe testgebruiker zonder taken).
- Geen regressie op de rest van het dashboard (Verkoop-metrics,
  Recente CRM-activiteit blijven ongewijzigd werken).
Cleanup van alle synthetische data + scratch-scripts, zoals elke eerdere
fase in dit project.

## 11. Openstaande beslissingen bij bouw (geen architectuurwijziging)

- Exacte cap-grootte per lijst (voorstel: 8–10, geen harde eis).
- Precieze plaatsing van `listOpportunitiesNeedingAttention()`:
  `opportunity.service.ts` of `dashboard.ts` — functioneel equivalent,
  te kiezen op basis van waar `attachAttention()` al het makkelijkst
  herbruikbaar is zonder een circulaire import.
- Of ADMIN's "alle taken/afspraken"-weergave gegroepeerd per medewerker
  getoond wordt of ongefilterd — puur presentatiedetail, geen
  datamodel-impact.
