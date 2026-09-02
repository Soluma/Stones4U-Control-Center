# ADR-008 — Externe communicatie in de Activity Timeline (Phase 3)

**Status**: Voorgesteld (2026-09-03), onderdeel van Phase 3-architectuur. Nog niet geïmplementeerd.

## Context

Phase 3 breidt de Activity Timeline uit met gespreks-, e-mail-, en offerte-events (`docs/platform-discovery/27-PHASE-3-DISCOVERY.md`). De bestaande Timeline (`docs/platform-discovery/24-UNIFIED-CONTROL-CENTER-TARGET.md`, geïmplementeerd in `src/modules/activity/timeline.ts`) heeft al een A/B-onderscheid (Control-Center-owned vs. extern/geprojecteerd) voor Shopify-orders en de (nog uitgeschakelde) telefonie/Exact-adapters. Dit ADR legt vast hoe dat onderscheid **specifiek** toegepast wordt op de nieuwe Phase 3-brontypen, en wanneer caching wél gerechtvaardigd is.

## Besluit

**Alle nieuwe Phase 3-brontypen zijn categorie B (extern/geprojecteerd) — geen enkele wordt fysiek in de `Activity`-tabel opgeslagen.**

| Nieuw `ActivityType` | Bron | Opslag |
|---|---|---|
| `CALL_INBOUND`, `CALL_OUTBOUND`, `CALL_MISSED` | TelefoonSysteem (live API, zodra beschikbaar — zie ADR-004/`27` §1.2) | Nooit — live geprojecteerd per paginabezoek |
| `EMAIL_INBOUND`, `EMAIL_OUTBOUND` | Gmail API (live, per verbonden mailbox) | Nooit — live geprojecteerd, geen berichttekst opgeslagen |
| `QUOTE_CREATED`, `QUOTE_UPDATED` | OfferteApp / s4u-quote-app (live API, zodra beschikbaar) | Nooit |
| `DRAFT_ORDER_CREATED` | Shopify (live, al bereikbaar — `27` §3) | Nooit — zelfde patroon als het bestaande `SHOPIFY_ORDER`-type |

**Waarom uitsluitend B, geen A**: elk van deze bronnen blijft het systeem-van-waarheid voor zijn eigen data (Shopify voor orders, TelefoonSysteem voor gesprekken, Gmail voor e-mail, de offerte-apps voor offertes) — dit is een directe toepassing van het al vastgelegde principe in ADR-001/ADR-004 ("bestaande systemen blijven satellites, geen duplicatie zonder noodzaak") en vermijdt de bekende faalmodus die elders in het landschap al is aangetroffen: verouderde/gedupliceerde kopieën die uit sync raken met de bron (`docs/platform-discovery/14-SHARED-CORE-DESIGN.md`).

**Deduplicatie**: omdat niets lokaal wordt opgeslagen, is duplicatie **door constructie** onmogelijk — er is geen tweede rij die met een live-geprojecteerd item kan botsen. Elk geprojecteerd item krijgt een stabiele, samengestelde synthetische ID (`telefoon-call-{id}`, `gmail-{messageId}`, `offerte-{bron}-{id}`, `shopify-draftorder-{gid}`) — zelfde patroon als het bestaande `shopify-order-{gid}`.

**Caching/indexering — expliciet uitgesteld, niet vooraf gebouwd**:
- Fase 3 bouwt **geen** cache-laag. Elke adapter haalt live op bij elk Customer-360-paginabezoek.
- Een cache wordt pas overwogen **nadat** live-latentie in de praktijk een probleem blijkt (geen vooraf-optimalisatie) — en dan uitsluitend als een kortlevende (minuten, niet uren/dagen), niet-persistente metadata-cache (nooit berichttekst/gespreksinhoud), per de richtlijn in `27-PHASE-3-DISCOVERY.md` §2.4.
- Als caching ooit nodig blijkt, hoort de cache **in de adapter**, niet in de `Activity`-tabel — de Timeline-tabel blijft uitsluitend Control-Center-owned data bevatten, ook na een toekomstig cachebesluit.

**Timeline-rendering**: de bestaande `TimelineItem`-vorm (`src/modules/activity/timeline.ts`) — `{ id, occurredAt, source, kind, title, summary, actorName }` — is al generiek genoeg voor deze nieuwe kinds; geen wijziging aan de vorm zelf nodig, alleen nieuwe `kind`-waarden en nieuwe projectie-functies die er items van maken (zelfde patroon als de bestaande Shopify-order-projectie).

## Consequenties

- Geen nieuwe Prisma-migratie voor de Timeline zelf nodig — de uitbreiding zit volledig in de adapterlaag (`src/integrations/*`) en de rendering-laag (`src/modules/activity/timeline.ts`, `ActivityTimelineView.tsx`), niet in het datamodel. (`ExternalContactMatch` uit ADR-007 is de enige nieuwe tabel die Phase 3 aan de matching-kant toevoegt.)
- Een uitgeschakelde/onbereikbare bron (TelefoonSysteem/offerte-apps zolang hun service-auth-blokkade niet is opgelost) degradeert de Timeline naar "deze bron niet beschikbaar" voor dat brontype — nooit een crash, zelfde foutisolatie-patroon als de bestaande `Disabled*Adapter`'s (`src/integrations/telephony/adapter.ts`, `src/integrations/exact/adapter.ts`).
- Zodra een externe bron ooit **wél** fysiek in Control Center opgeslagen zou moeten worden (bijv. om compliance-/audit-redenen), is dat een **apart, later, expliciet besluit** — niet een sluipende uitbreiding van dit ADR.
