# 36 — Phase 4B Build Spec: Sales Follow-up, Dashboard & Automation

**Status**: Bouwspecificatie, geen implementatie. Vervolg op
`34-PHASE-4B-SALES-ACTIVATION-DISCOVERY.md` en
`35-PHASE-4B-SALES-ACTIVATION-ARCHITECTURE.md`.

## 1. Scope van 4B

Zie architectuurdoc §23 voor de volledige onderbouwing. Samengevat:
attention engine, dashboard sales-metrics, pipeline-verbeteringen,
drag-and-drop, Shopify-completed-order-banner. Quote-signaal is
laagste-prioriteit binnen 4B (mag als laatste, kan uitgesteld zonder de
rest te blokkeren).

## 2. Geen migratie

Bevestigd in architectuurdoc §22 — geen schemawijziging. Alle 4B-werk is
service-/UI-laag bovenop het bestaande Phase 4A-schema.

## 3. Nieuwe/gewijzigde modules (indicatief)

| Bestand | Wijziging |
|---|---|
| `src/modules/opportunities/labels.ts` | + `STAGE_STALE_THRESHOLD_DAYS` |
| `src/modules/opportunities/attention.ts` (nieuw) | `deriveOpportunityAttention()`, `deriveNextAction()` — pure functies, geen `server-only`-afhankelijkheid nodig tenzij ze ook server-side aggregatie bevatten (dan wel) |
| `src/modules/opportunities/opportunity.service.ts` | `attachFollowUpFlags()` vervangen door een aanroep naar `deriveOpportunityAttention()` per rij; `needsFollowUp: boolean` op de teruggegeven rijen vervangen/aangevuld door `attention: OpportunityAttention` (backwards-compatibele overweging: bestaande UI die op `needsFollowUp` leunt moet meeveranderen, geen dubbele velden laten hangen) |
| `src/modules/opportunities/dashboard.ts` (nieuw) | de in architectuurdoc §9 uitgeschreven metric-functies |
| `src/app/api/opportunities/dashboard/route.ts` (nieuw) | GET, retourneert de sales-dashboardmetrics, met dezelfde filter-query-params als `/api/opportunities` waar relevant (owner/periode) |
| `src/app/(app)/page.tsx` | + Sales-sectie |
| `src/app/(app)/opportunities/OpportunitiesBoard.tsx` | aandacht-indicator + volgende-actie op kaarten, periodefilter, "Mijn verkoopkansen", drag-and-drop |
| `src/app/(app)/opportunities/[id]/page.tsx` | + "Opvolging"-sectie, Shopify-signaal-banner (leest uit al opgehaalde `draftOrders`/`orders`), quote-signaal-banner |
| `src/app/(app)/customers/[id]/OpenOpportunitiesBlock.tsx` | + aandacht-indicator per rij |
| `tests/opportunity-attention.test.ts` (nieuw) | volledige dekking van architectuurdoc §24 |
| `tests/opportunity-dashboard.test.ts` (nieuw) | dashboard-metric-tests |

Geen wijziging nodig aan: schema, migraties, audit-actielijst, RBAC-guards,
externe adapters (Shopify/quotes/telefonie/e-mail blijven exact zoals ze
zijn — 4B leest er alleen al-opgehaalde data uit).

## 4. Routes

Eén nieuwe route: `GET /api/opportunities/dashboard` (query-params:
`ownerUserId?`, `periode?`). Alle overige mutaties (drag → stage, won-
bevestiging) hergebruiken **exact** de bestaande Phase 4A-routes — geen
nieuwe mutatie-endpoints.

## 5. Permissions

Ongewijzigd uit Phase 4A. `canEdit` (`role !== VIEWER`) bepaalt of
drag-handles/actieknoppen renderen; alle daadwerkelijke mutaties blijven
server-side gegateerd door de bestaande `requireWriteAccess()`/
`assertCanModify()`-laag.

## 6. Audit

Geen nieuwe `AuditAction`-waarden nodig (architectuurdoc §20).

## 7. Benodigde env vars / scopes

Geen. Geen nieuwe externe integratie.

## 8. Buildvolgorde

Zie architectuurdoc §25 — herhaald hier als de canonieke volgorde:

1. `deriveOpportunityAttention()` + `STAGE_STALE_THRESHOLD_DAYS` +
   `deriveNextAction()`, met tests (sluit ook het Phase 4A-testgat rond
   `needsFollowUp`).
2. Dashboard-metric-functies + route + UI-sectie.
3. Pipeline-kaartverbeteringen + filters + "Mijn verkoopkansen".
4. Opportunity-detail "Opvolging"-sectie.
5. Shopify completed-order-suggestiebanner.
6. Quote-aanwezig-suggestiebanner (optioneel binnen 4B, laagste prioriteit).
7. Drag-and-drop.
8. Volledige teststrategie + kwaliteitspoorten
   (`typecheck`/`lint`/`test`/`build`), zelfde patroon als Phase 4A.

## 9. Teststrategie

Volledige lijst in architectuurdoc §24 — niet herhaald om drift tussen twee
kopieën te voorkomen.

## 10. Open beslissingen — input van Fons nodig

1. **Stale-drempels voor `QUOTE_SENT`/`NEGOTIATION`**: dit voorstel wijkt
   af van de oorspronkelijke opdracht (7 dagen i.p.v. 5, architectuurdoc
   §2) — verdient expliciete bevestiging of Fons de kortere, striktere
   opdracht-waarde toch prefereert.
2. **Quote-signaal wel/niet in 4B**: laagste prioriteit, kan zonder risico
   naar een latere ronde als de bouwtijd beperkt is — vraagt een keuze,
   geen blokkade.
3. **DnD-bibliotheek**: architectuurdoc §10 noemt `@dnd-kit/core` als
   kandidaat vanwege ingebouwde keyboard-sensor — een bouwbeslissing, geen
   architectuurbeslissing, maar de introductie van een nieuwe dependency
   verdient een korte bevestiging.
4. **Dashboard-periode-opties**: welke vaste periodes precies ("deze
   maand"/"komende 30 dagen"/"dit kwartaal"/anders) — een cosmetische
   keuze die net zo goed nu vastgelegd kan worden.

Geen van deze vier is blokkerend voor het starten van de bouw.

## 11. Eindconclusie

Phase 4B is, zoals ontworpen, uitsluitend service-/UI-laagwerk bovenop het
bestaande, production-live Phase 4A-schema: geen nieuwe tabel, geen nieuwe
kolom, geen nieuwe externe integratie, geen nieuwe audit-actie, geen
achtergrondproces. Het enige echte nieuwe concept is de rijkere
`deriveOpportunityAttention()` — een directe uitbreiding van een reeds
werkende, reeds gebatchte Phase 4A-functie, niet een nieuw systeem.
