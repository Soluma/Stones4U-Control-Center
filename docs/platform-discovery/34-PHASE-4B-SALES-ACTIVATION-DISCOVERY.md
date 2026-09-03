# 34 — Phase 4B Discovery: Sales Follow-up, Dashboard & Automation

**Status**: Discovery, geen implementatie. Vervolg op Phase 4A
(production-live sinds commit `31aa8cd`). Baseline voor dit document is de
**werkelijke productiecode**, niet de oorspronkelijke Phase 4A-architectuur-
documenten — waar die twee uiteenlopen (de pre-production-fixronde) is de
huidige code leidend.

## 1. Wat Phase 4A al werkelijk bevat (geverifieerd tegen productiecode)

### 1.1 Opportunity — state, geverifieerd tegen `opportunity.service.ts`

- `stage` (6 actieve fases) en `status` (`OPEN/WON/LOST`) volledig
  gescheiden. `changeStage()`/`markWon()`/`markLost()` alle drie strikt
  `status === "OPEN"`-gepoort; directe WON↔LOST is onmogelijk.
- `reopen()` wist `wonAt`/`lostAt`/`lostReason`/`finalValue` volledig — de
  Opportunity-rij is **altijd** de huidige canonical state, nooit "sticky"
  historie. Historie leeft uitsluitend in `AuditEvent` + `Activity`
  (`OPPORTUNITY_CREATED/_STAGE_CHANGED/_WON/_LOST/_REOPENED`).
- `estimatedValue`/`finalValue`: `Prisma.Decimal`, strikte
  `parseMoneyInput()`-validatie (regex + `Decimal(12,2)`-bovengrens), nooit
  een JS-float-pad naar opslag.
- `probability`: optioneel, expliciet mens-ingevoerd. `effectiveProbability()`
  (`labels.ts`) valt terug op `STAGE_DEFAULT_PROBABILITY` — een **pure
  weergavefunctie**, nooit opgeslagen.
- `ownerUserId`: standaard = actieve accountmanager, anders aanmaker (nooit
  stil een inactieve gebruiker). `assignOwner()` bewust NIET aan
  `status=OPEN` gebonden (ADR-009 §10) — expliciete, gedocumenteerde keuze.
- `archivedAt`: soft-close, geen hard delete.

### 1.2 Al bestaande derived-attention-mechaniek — **niet vanaf nul te bouwen**

`listOpportunities()` bevat al:

```ts
const FOLLOW_UP_INACTIVITY_DAYS = 7; // één vaste waarde voor alle fases

async function attachFollowUpFlags(opportunities) {
  // batched Activity.groupBy over alle zichtbare open opportunity-id's —
  // ÉÉN query voor de hele pagina, geen per-rij query.
  const lastActivityRows = await prisma.activity.groupBy({
    by: ["relatedOpportunityId"],
    where: { relatedOpportunityId: { in: openIds } },
    _max: { occurredAt: true },
  });
  // + de al meegeladen `tasks` (open taken, take:1, orderBy dueAt asc) voor
  //   overdue-detectie en "volgende actie"
  return opportunities.map((o) => ({
    ...o,
    needsFollowUp: overdueOpenTask || closeDatePassed || noRecentActivity,
  }));
}
```

Dit is **letterlijk** een eerste, werkende versie van wat de opdracht
"`deriveOpportunityAttention()`" noemt — inclusief de batching-strategie die
sectie 17/18 van de opdracht als eis stelt. Phase 4B **breidt dit uit**
(rijkere severity/redenen, per-fase drempels, gescheiden last-contact-
concept) — het bouwt niet opnieuw. Bevestigd: dit mechanisme heeft
**vandaag geen enkele test** (`grep needsFollowUp tests/` → geen
treffers) — een reële, te dichten testgat, niet nieuw gedrag.

De `tasks`-include in `listOpportunities()` (open taken, `take:1`,
`orderBy: dueAt asc`) is al exact de "volgende actie"-brondata die sectie 5
van de opdracht vraagt — ook hier is er niets nieuws te bouwen, alleen te
formaliseren en rijker te presenteren (overdue/vandaag/gepland).

### 1.3 Wat Phase 4A op de detailpagina al live ophaalt (zonder extra kosten te maken voor 4B)

`src/app/(app)/opportunities/[id]/page.tsx` haalt vandaag, één keer per
paginabezoek, al op:

- `getShopifyCustomerOrders(customer.shopifyCustomerGid)` — echte orders,
  inclusief `currentTotalPriceSet` (bedrag + valuta).
- `getShopifyCustomerDraftOrders(customer.shopifyCustomerGid)` — inclusief
  `completedOrder: {gid, name, adminUrl} | null` — **het al bestaande
  win-signaal uit sectie 6 van de opdracht, vandaag al beschikbaar, nul
  nieuwe Shopify-aanroepen nodig.**
- `createQuotesAdapter().getQuotesForCustomer(...)` — `QuoteSummary[]`,
  inclusief `status`, `createdAt`, `shopifyDraftOrderGid`.
- `createTelephonyAdapter().getActivityForPhoneNumbers(...)` en
  `createEmailAdapter().getMessagesForAddresses(...)` — klantniveau, live,
  al eerlijk gelabeld als "klantcommunicatie" (niet opportunity-specifiek)
  in de huidige UI.

Al deze data wordt **uitsluitend op de detailpagina** opgehaald (één
paginabezoek = één fetch per bron) — nergens per-kaart in de pipeline. Dit
is exact het patroon dat sectie 17/18 van de opdracht als eis stelt, en het
bestaat al.

### 1.4 Wat nog ontbreekt (de eigenlijke Phase 4B-scope)

- Geen rijkere attention-severity (alleen een boolean `needsFollowUp`).
- Geen per-fase stale-drempels (één vaste 7-dagenwaarde voor alle fases).
- Geen gescheiden "laatste klantcontact" vs. "laatste activiteit"-concept.
- Geen salesdashboard-sectie (dashboard bevat vandaag alleen Taken, Komende
  afspraken, Recente CRM-activiteit — geen enkele pipeline-metric).
- Geen drag-and-drop (bewust uitgesteld in Phase 4A).
- Geen Shopify-completed-order-suggestiebanner (de brondata bestaat al, de
  UI-suggestie nog niet).
- Geen quote-aanwezig-maar-fase-loopt-achter-suggestie.

## 2. Waarom dit geen dubbel werk wordt

- `deriveOpportunityAttention()` is een **uitbreiding** van
  `attachFollowUpFlags()`, geen nieuw systeem ernaast.
- "Volgende actie" blijft `Task` als enige bron van waarheid — geen nieuw
  veld, geen kopie.
- Het Shopify-win-signaal hergebruikt exact de al opgehaalde
  `draftOrders`/`orders`-arrays op de detailpagina — geen nieuwe Shopify-
  integratie.
- Het dashboard hergebruikt de bestaande `listOpportunities()`-filters
  (`status`, `stage`, `ownerUserId`, `archived`) — geen nieuwe query-laag.
- Drag-and-drop roept de bestaande, al volledig geauditeerde
  `changeStage()`-servicefunctie aan via de bestaande
  `PATCH /api/opportunities/[id]/stage`-route — geen nieuwe mutatielogica.

## 3. Scope-grenzen bevestigd (uit de opdracht, herhaald voor volledigheid)

Geen AI, geen automatische commerciële beslissingen (stage/status wordt
nooit door code gewijzigd — uitsluitend door een mens die een suggestie
expliciet bevestigt via de bestaande `markWon`/`changeStage`-acties), geen
achtergrondproces tenzij aantoonbaar noodzakelijk (zie §18/§19 van de
architectuurdoc voor de onderbouwing waarom dat hier niet het geval is),
geen configureerbare rules-engine, geen Microsoft 365, geen nieuwe sibling-
API's tenzij strikt noodzakelijk (gebleken: niet noodzakelijk — alle
signalen zijn al beschikbaar via bestaande adapters).
