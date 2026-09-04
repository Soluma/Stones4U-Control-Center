# 47 — Phase 6B Architecture: Mijn Klanten & Klanttoewijzing

**Status**: Discovery/architectuur, geen implementatie. Vervolg op
`46-PHASE-6B-MY-CUSTOMERS-DISCOVERY.md`.

## 1. Kernontwerp

Eén nieuwe, lokale, gescoopte klantenlijst — géén tweede
`CustomerProfile`-model, géén nieuwe dataset. Drie scopes, allemaal een
`prisma.customerProfile.findMany()`-variant met een verschillende
`where`-clausule:

```ts
type CustomerListScope = "mine" | "unassigned" | "all";

function scopeWhere(scope: CustomerListScope, actorId: string): Prisma.CustomerProfileWhereInput {
  if (scope === "mine") return { accountManagerId: actorId };
  if (scope === "unassigned") return { accountManagerId: null };
  return {}; // "all" — alle lokaal bekende profielen, zie discovery §7
}
```

`actorId` komt altijd uit de server-side sessie (`getSessionUser()`),
nooit uit een querystring/body-parameter — exact het Phase 6A-patroon.

## 2. Waarom geen nieuwe dataset/model

`accountManagerId` bestaat al op `CustomerProfile`. Een tweede model
("CustomerAssignment" of vergelijkbaar) zou een tweede bron van waarheid
creëren voor exact dezelfde relatie — precies wat Phase 5A's
`companyNameConfirmed`-ontwerp al bewust vermeed voor een vergelijkbare
verleiding. Dit blijft één kolom, één relatie, meerdere presentaties.

## 3. "Alle klanten" — bevestigde scope (discovery §7, Optie A)

`scope=all` haalt uitsluitend lokaal-gematerialiseerde
`CustomerProfile`-rijen op — nooit een live Shopify-klantenlijst. De
bestaande `CustomerSearch`-zoekbalk (`src/app/(app)/customers/CustomerSearch.tsx`)
blijft **ongewijzigd** de enige weg naar een nog-niet-lokaal-bekende
Shopify-klant. De nieuwe tabs en de bestaande zoekbalk co-existeren op
dezelfde pagina, met een duidelijk visueel onderscheid (zie §7 UI).

## 4. Nieuwe service-functie

Eén functie in `src/modules/crm/customer-profile.service.ts` (bestaande
module, geen nieuwe — het is nog steeds `CustomerProfile`-domein):

```ts
export type CustomerListScope = "mine" | "unassigned" | "all";

export type CustomerListResult = {
  customers: (CustomerProfile & { accountManager: { id: string; name: string; active: boolean } | null })[];
  total: number;
};

export async function listCustomerProfiles(
  actor: { id: string },
  opts: { scope: CustomerListScope; search?: string; page?: number; pageSize?: number },
): Promise<CustomerListResult>
```

- `where` combineert `scopeWhere(scope, actor.id)` met een optionele
  zoekterm (`OR: [{displayName: {contains, mode: insensitive}}, {companyName: {contains, mode: insensitive}}]`)
  — **binnen dezelfde query**, nooit een aparte, ongescoopte zoekstap.
- `include: { accountManager: { select: { id, name, active } } }` — één
  join, geen N+1 (Prisma relatie-include, geen losse query per rij).
- `orderBy: { updatedAt: "desc" }` (discovery §14).
- `take`/`skip` voor paginering, **na** de where-clausule.
- `prisma.customerProfile.count({ where })` — apart, klein, voor de
  paginering-metadata én voor de tab-counts (§6).
- `select` bevat exact de velden die `customerDisplayName()`/
  `customerSecondaryName()` nodig hebben (`displayName`, `companyName`,
  `customerTypeOverride`) plus `id`, `crmStatus`, `accountManagerId`,
  `updatedAt`.

## 5. Nieuwe route

`GET /api/customers?scope=mine|unassigned|all&q=&page=` —
`requireUser()`-gated (matcht het al-open leesmodel, discovery §6). Geen
nieuwe route voor mutatie: "Aan mij toewijzen" hergebruikt de bestaande
`PATCH /api/customers/[id]`.

Waarom een nieuwe route (in tegenstelling tot Phase 6A, dat bewust geen
nieuwe route toevoegde): Phase 6A's dashboard-secties zijn server-
component-only, éénmalig geladen bij paginabezoek. Deze klantenlijst
heeft client-side interactiviteit nodig (tab-wisseling, zoeken binnen
scope, paginering) zonder een volledige paginaherlaad — een API-route is
hier de juiste, kleinste oplossing, consistent met hoe
`/api/tasks`/`/api/opportunities` al werken voor vergelijkbare
client-aangedreven lijsten.

## 6. Counts

`GET /api/customers/counts` (of drie velden in dezelfde response als
§5 — implementatiedetail, geen architectuurbeslissing) — drie
`count()`-aanroepen met dezelfde drie `where`-clausules. Geparalleliseerd
via `Promise.all()`, geen sequentiële round-trips.

## 7. UI

`/customers`-pagina uitgebreid: bestaande zoekbalk blijft bovenaan
(ongewijzigd gedrag — live Shopify, direct klant openen). Eronder een
nieuwe `Tabs`-component (zelfde conventie als Customer 360/opportunity-
detail) met de drie scopes + counts, en een compacte lijst (rij-per-
klant, `customerDisplayName()`/`customerSecondaryName()`,
accountmanager-badge op Niet-toegewezen/Alle, "Aan mij toewijzen"-knop
op Niet-toegewezen-rijen voor ADMIN/AGENT). Client component (zoals
`CustomerSearch.tsx` al is) die de nieuwe API-route bevraagt bij
tab-wissel/zoekterm/paginering — geen volledige page-reload nodig.

## 8. RBAC

- `GET /api/customers` (lijst): `requireUser()` — elke rol, inclusief
  VIEWER (discovery §6).
- "Aan mij toewijzen": hergebruikt `PATCH /api/customers/[id]` →
  `requireWriteAccess()` (ADMIN/AGENT, VIEWER 403) — ongewijzigd.
- Geen nieuwe privilege-escalatie: `scope=mine` resolvet altijd tegen de
  sessie-actor, nooit tegen een query-param-`userId`.

## 9. Audit

Geen nieuwe audit voor de lijst zelf (puur lezen — matcht het
Phase 6A-precedent: lezen genereert nooit een audit-event in deze
applicatie). "Aan mij toewijzen" hergebruikt `updateCustomerCrmFields()`
ongewijzigd, dus dezelfde bestaande `CUSTOMER_PROFILE_UPDATED`/
`customer_profile.updated`-audit met before/after-diff.

## 10. Performance

- Geen N+1: één query per lijst-call (where + include + take/skip),
  geen losse query per rij voor accountmanager-data.
- Geen externe aanroepen — 100% lokaal, `CustomerProfile`-eigen data.
- Geen nieuwe index nu (discovery §28) — bij het huidige/verwachte
  volume (tientallen tot enkele honderden lokale profielen, zelfde
  orde van grootte als de al geaccepteerde Opportunity-schaal) is een
  ongeïndexeerde `accountManagerId`-filter en een `ILIKE`-zoekopdracht
  op `displayName`/`companyName` geen probleem — zelfde precedent als
  de al-geaccepteerde ongeïndexeerde command-palette-zoekopdrachten
  (Phase 6-discovery §14 van doc 43). Als het klantenbestand ooit
  aanzienlijk groeit, is een `@@index([accountManagerId])` een
  triviale, geïsoleerde vervolgmigratie — niet nu.

## 11. Inactieve accountmanager — presentatie

`accountManager: { id, name, active }` wordt altijd meegegeven in de
`select`/`include` (geen aparte query). UI toont `{name}` +
`(inactief)` wanneer `active === false` — geen automatische
her-toewijzing, geen verborgen "Niet toegewezen"-suggestie.

## 12. Dashboard-link

Eén `<Link href="/customers?scope=mine">Mijn klanten →</Link>` in de
bestaande Phase 6A "Mijn Werk"-sectie (`src/app/(app)/page.tsx`) — geen
nieuwe widget, geen nieuwe data-fetch.

## 13. Expliciet buiten scope (en waarom)

- **Bulk assignment**: geen aantoonbare noodzaak (discovery §18).
- **ADMIN-medewerkerfilter**: reële extra scope, geen bestaande
  bouwsteen maakt het goedkoop (discovery §21) — kandidaat voor een
  latere iteratie.
- **Live Shopify-klantenlijst**: zou "Alle klanten" vervangen door een
  wezenlijk grotere, nieuwe integratiecapaciteit (discovery §7, Optie
  B) — expliciet afgewezen voor Phase 6B.
- **Territory management / workload balancing / auto-assignment**: geen
  bewijs van behoefte, buiten scope per de opdracht zelf.
- **Opportunity/Task-herverdeling gekoppeld aan accountmanager-wijziging**:
  bevestigd bewust gescheiden (discovery §24/§25) — geen koppeling.
- **Notificaties**: buiten scope per de opdracht zelf.
