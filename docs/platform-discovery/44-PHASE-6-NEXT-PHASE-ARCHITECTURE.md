# 44 — Phase 6A Architecture: Mijn Werk (dashboard-uitbreiding)

**Status**: Discovery/architectuur, geen implementatie. Vervolg op
`43-PHASE-6-CRM-WORKFLOW-DISCOVERY.md` §28.

## 1. Probleemstelling

Het hoofddashboard (`src/app/(app)/page.tsx`) toont vandaag drie dingen
die relevant zijn voor "wat moet ik vandaag doen", maar geen ervan is
actionable:
- `TaskSummaryWidget` toont alleen tellingen (overdue/dueToday/…), geen
  titels of links.
- "Komende afspraken" toont een vaste top-5, chronologisch, zonder
  "vandaag"-scoping.
- De Verkoop-sectie toont een `attentionCount`, maar niet wélke
  opportunities aandacht nodig hebben.

Alle drie de onderliggende signalen bestaan al en zijn al correct
berekend (Task-model, `listUpcomingAppointments()`, de attention
engine). Het gat is uitsluitend presentatie/aggregatie, niet data.

## 2. Ontwerpprincipe: uitbreiden, niet dupliceren

Geen nieuwe route, geen nieuwe "derde dashboard" (expliciet vermeden
per discovery §18). Het hoofddashboard is al een server component die
in één `Promise.all()` meerdere onafhankelijke databronnen ophaalt
(`page.tsx:17-21`) — dit patroon wordt exact voortgezet, niet vervangen.

Drie nieuwe, kleine, puur-lezende functies worden toegevoegd aan
bestaande service-modules (geen nieuwe module):

```ts
// src/modules/tasks/task.service.ts
export async function listMyOverdueAndDueTodayTasks(actor: { id: string; role: Role }): Promise<TaskListItem[]>

// src/modules/appointments/appointment.service.ts
export async function listTodayAppointments(actor: { id: string; role: Role }): Promise<AppointmentListItem[]>

// src/modules/opportunities/opportunity.service.ts (of dashboard.ts)
export async function listOpportunitiesNeedingAttention(actor: { id: string; role: Role }, limit?: number): Promise<OpportunityAttentionItem[]>
```

Elke functie volgt het al bewezen `ownerUserId`/`assignedToId`-
scopingpatroon uit `dashboard.ts` (§14 van de Phase 4B-architectuur):
niet-ADMIN ziet alleen eigen werk, ADMIN ziet alles — exact zoals de
Verkoop-sectie dat vandaag al doet.

## 3. Waarom geen nieuwe API-route

`page.tsx` is een server component — het roept services rechtstreeks
aan, precies zoals `listUpcomingAppointments`/`getRecentActivity`/
`getSalesDashboardMetrics` dat vandaag al doen. Een nieuwe
`GET /api/dashboard/my-work`-route zou een ongebruikte, extra
HTTP-hop toevoegen zonder enig voordeel (niets client-side heeft deze
data apart nodig — er is geen polling, geen los widget dat dit los van
de paginalading ververst). Consistent met "geen nieuwe grote
oppervlakte", wordt er geen nieuwe API-route toegevoegd.

## 4. Datamodel-impact

**Geen.** Alle drie functies lezen uitsluitend bestaande kolommen op
`Task`, `Appointment`, `Opportunity` (+ de al bestaande
`attachAttention()`-berekening). Geen nieuwe kolom, geen nieuwe tabel,
geen nieuwe enum, geen migratie.

## 5. Performance

- **Taken**: `Task.assignedToId` en `Task.status`/`Task.dueAt` zijn al
  individueel geïndexeerd (`prisma/schema.prisma:396-400`) — voldoende
  voor het huidige en te verwachten datavolume; geen nieuwe index nodig
  (geconcretiseerd door directe schema-inspectie, niet aangenomen).
- **Afspraken**: `Appointment.assignedToId`/`startsAt`/`status` al
  geïndexeerd (`schema.prisma:463-466`) — idem.
- **Opportunities**: hergebruikt `listOpportunities()` +
  `attachAttention()` (al één gebatchte `groupBy`, geen per-rij query,
  `opportunity.service.ts:270-306`) — geen nieuwe queryvorm, geen N+1.
- Alle drie draaien binnen het al bestaande `Promise.all()` op
  `page.tsx` — nul extra sequentiële round-trips, nul nieuwe externe
  API-aanroepen (100% Control-Center-owned data).
- Elke sectie krijgt zijn eigen `try/catch` (fail-isolation-patroon,
  exact zoals `customers/[id]/page.tsx:90-173` al doet) zodat een fout in
  bijvoorbeeld de opportunity-aandachtslijst de taken-/afspraken-secties
  niet meeneemt.

## 6. RBAC/audit

Uitsluitend lezen, geen nieuwe schrijfactie, geen nieuwe permissie-
concept. Gated door de bestaande paginabeveiliging (`getSessionUser()`
in `page.tsx`) — geen wijziging aan `guards.ts` nodig. Geen nieuwe
`AuditAction` nodig: lezen genereert in deze applicatie nooit een
audit-event (bevestigd tijdens Phase 5A-productie-uitrol — paginabezoek
veroorzaakt structureel geen audit-records), dit blijft ongewijzigd.

## 7. UI

Drie kleine, presentatie-only componenten naast de bestaande
dashboard-secties, qua stijl consistent met bestaande lijst-
componenten (`OpenOpportunitiesBlock.tsx` als directe stijlreferentie):

- `MyTasksList.tsx` — titel, klantlink (via `customerDisplayName()`),
  vervaldatum, status-indicator; splitst visueel "te laat" vs "vandaag".
- Aanpassing van de bestaande "Komende afspraken"-sectie in `page.tsx`
  zelf (geen nieuw bestand nodig, kleine wijziging) — vervangt de
  vaste top-5 door een expliciete "vandaag"-lijst.
- `AttentionOpportunitiesList.tsx` — titel, klantlink, attention-
  severity-badge (hergebruikt `AttentionBadge.tsx`, al bestaand),
  next-action-tekst (hergebruikt `formatNextAction()`, al bestaand).

Elke lijst is gecapt (bijv. 8-10 items) met een "bekijk alles"-link naar
de bestaande volledige pagina (`/tasks`, `/opportunities`) — geen nieuwe
volledige-lijst-pagina nodig.

## 8. Expliciet buiten scope (en waarom)

- **Cross-klant recente communicatie (mail/bellen)**: vereist een
  gebatchte multi-klant adapter-aanroep richting TelefoonSysteem/IMAP
  die vandaag niet bestaat (huidige adapters zijn per-klant/per-contact
  ontworpen) — bouwen zou ofwel een N+1-patroon zijn (in strijd met het
  gevestigde performance-precedent) ofwel een nieuwe, grotere
  integratie-wijziging vereisen (buiten scope voor één gecontroleerde
  build).
- **"Needs response"-signaal**: de onderliggende data is niet
  betrouwbaar genoeg (zie discovery §5) — dit blijft een open vraag
  voor een latere fase, niet iets om nu te bouwen op onbetrouwbare
  aannames.
- **Quote-vervaldatum/staleness**: geen `validUntil`-veld in de
  brondata; niet bouwbaar zonder een wijziging in OfferteApp/
  s4u-quote-app zelf (andere repository, expliciet buiten scope).
- **"Mijn klanten"-weergave, taak-vanuit-timeline-item,
  tel:/mailto:-links, reminders, pinning**: alle vier hebben duidelijke
  waarde (zie discovery §27) maar raken andere schermen (klantenlijst,
  Customer 360, Appointment-model) dan het dashboard — bewust niet
  gebundeld, om deze fase klein en gecontroleerd te houden.
- **BLUE-severity opportunity-attention in Mijn Werk** (vastgesteld
  tijdens de final review vóór commit, 2026-09-04): de centrale
  attention-engine kent BLUE als severity, maar de aggregate
  `listOpportunities()`-laag die Mijn Werk (en de pipeline-board, en de
  dashboard-tegel) hergebruikt, laadt de twee benodigde commerciële
  signalen (Shopify-conceptbestelling-voltooiing,
  offerte-aanwezigheid-vs-stage) niet — die zijn vandaag uitsluitend op
  de opportunity-detailpagina beschikbaar, via een live, single-klant-
  scoped fetch. Optie A gekozen: Phase 6A levert RED/ORANGE op de
  huidige, betrouwbare aggregate runtime; BLUE-signal-loading wordt
  bewust niet toegevoegd (zou een nieuwe, gebatchte multi-klant Shopify-/
  quote-ophaalcapaciteit vereisen — een aparte, grotere fase, geen
  dashboarduitbreiding). De code blijft future-compatible: zodra die
  laag ooit BLUE-signalen aanlevert, verschijnt een BLUE-opportunity
  automatisch in Mijn Werk, zonder wijziging aan deze module.

  **Kandidaat-vervolgfase** (niet ontworpen, niet gebouwd, uitsluitend
  hier benoemd als toekomstige kandidaat): "Batched commercial
  opportunity signals" — een gebatchte, bounded, fail-isolated manier om
  Shopify-conceptbestelling-voltooiing en offerte-aanwezigheid-signalen
  voor een lijst van opportunities/klanten tegelijk op te halen (nooit
  één externe aanroep per opportunity), zodat aggregate views (pipeline,
  dashboard, Mijn Werk) BLUE betrouwbaar kunnen tonen. Vereist eigen
  discovery/architectuur/build-spec-traject, niet iets om terloops aan
  Phase 6A toe te voegen.

## 9. Testplan (kort, uitgewerkt in de build spec)

Voor elke nieuwe functie: actor-scoping (AGENT ziet alleen eigen werk,
ADMIN ziet alles), grensgevallen (overdue vs. due-today op precies
middernacht), lege-staat, sortering. Staging-E2E met synthetische
taken/afspraken/opportunities gekoppeld aan een tijdelijke testgebruiker.
