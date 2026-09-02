# 03 — Shopify-integratie overzicht

**Belangrijk uitgangspunt van de opdrachtgever**: server-side toegang tot de eigen Shopify-store moet via de **client-credentials flow** lopen, niet via een permanent handmatig `SHOPIFY_ADMIN_ACCESS_TOKEN`. De onderstaande bevindingen laten zien dat dit uitgangspunt **vandaag niet consistent wordt toegepast** — inmiddels **vier** verschillende authenticatiepatronen zijn tegelijk live in productie (was drie, ná onderzoek van de broncode van offerteapp bleek het geen Patroon A te zijn zoals eerder vermoed, maar een eigen vierde patroon — zie Patroon D hieronder).

> **UPDATE 2026-09-01**: OfferteApp en s4u-quote-app zijn inmiddels met volledige broncode onderzocht (zie [10-OFFERTEAPP-DEEP-DIVE.md](10-OFFERTEAPP-DEEP-DIVE.md), [11-QUOTE-APP-DEEP-DIVE.md](11-QUOTE-APP-DEEP-DIVE.md)). **Correctie**: offerteapp was eerder op basis van secret-namen (`SHOPIFY_CLIENT_ID`/`SECRET`) voorlopig bij Patroon A ingedeeld — de daadwerkelijke code laat een ander patroon zien (permanent, in de database opgeslagen token na een eenmalige OAuth authorization-code-uitwisseling, niet client-credentials). s4u-quote-app's Patroon C-indeling is bevestigd, niet langer een inferentie.

## Patroon A — OAuth client-credentials grant (voldoet aan het uitgangspunt)

Gebruikt door: **POS (source2pos)** en **Stones4U-Catalog-SEO**. (Niet langer offerteapp — zie Patroon D.)

- Env vars: `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_SHOP_DOMAIN`.
- Werking (bevestigd in POS `src/lib/shopify.ts` en onafhankelijk herbouwd in Catalog-SEO `src/shopify/auth.ts`): `POST https://{shop}/admin/oauth/access_token` met `grant_type=client_credentials`. Access token wordt **alleen in-memory** gecached (nooit naar disk/DB/frontend), ververst kort voor `expires_in`, met de-duplicatie van gelijktijdige ververs-requests.
- API-aanroepen: `POST https://{shop}/admin/api/{versie}/graphql.json`, token in `X-Shopify-Access-Token` header. **Uitsluitend GraphQL, geen REST.**
- API-versie: `2026-07` (POS en Catalog-SEO, bevestigd in `.env.example`/`fly.toml`).
- POS heeft daarnaast een expliciete **live shop-identity guard** (`src/lib/shopify-guard.ts`): elke schrijfactie doet eerst een live `shop { myshopifyDomain }`-query en vergelijkt die met `SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN`, plus een master-switch `SHOPIFY_WRITES_ENABLED` en featuregebonden flags (`ALLOW_SHOPIFY_ORDERS`, `ALLOW_SHOPIFY_RETURNS`, later ook customer-writes). Catalog-SEO heeft een vergelijkbare, onafhankelijk gebouwde guard (`src/shopify/safety.ts`): mutation-allowlist per veld, forbidden-mutation denylist, live identity-check, en een dubbele `ALLOW_SHOPIFY_WRITES=true` + `--apply`-vlag vereiste.

## Patroon B — Statisch, langlevend Admin API-token (wijkt af van het uitgangspunt)

Gebruikt door: **"locatie" (Voorraad Viewer)**, **telefoon-api**, **telefoon-ami-worker**.

- Env vars: `SHOPIFY_ADMIN_TOKEN` (locatie) / `SHOPIFY_ACCESS_TOKEN` (telefoon-*), plus `SHOPIFY_SHOP_DOMAIN`.
- Werking: token wordt direct als statische waarde uit env gelezen, geen OAuth-handshake, geen expiry/refresh-logica — precies het patroon dat de opdrachtgever wil vermijden.
- API-versie bij "locatie": `2025-07` (ouder dan patroon A's `2026-07`).
- Alleen leesoperaties gevonden bij "locatie" (variant-search, voorraadniveaus); telefoon-* broncode niet beschikbaar om te bevestigen wat er gelezen/geschreven wordt.

## Patroon C — Shopify-embedded app OAuth (Remix/CLI-template) — **s4u-quote-app bevestigd, overige nog afgeleid**

Env-vormpatroon `SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET`/`SCOPES`/`SHOPIFY_APP_URL` — de standaard Shopify CLI/Remix-app-template-vorm.

- **`s4u-quote-app` — bevestigd** met broncode: `@shopify/shopify-app-remix`, standaard OAuth authorization-code flow, offline-token opgeslagen via `PrismaSessionStorage`, sinds kort met de nieuwe sessie-token(JWT)-strategie (`removeRest: true` — uitsluitend GraphQL, geen REST Admin API meer).
- `maten-en-meters`, `maten-en-meters-s4u`, `productcards`, `stones4u-calculator`, `s4u-import-app`, `transport-s4u` — **nog steeds alleen afgeleid uit secret-namen, geen broncode beschikbaar.**

## Patroon D — OAuth authorization-code met permanent, in DB opgeslagen token (nieuw, na onderzoek van offerteapp)

Gebruikt door: **offerteapp** (bevestigd met broncode, zie [10-OFFERTEAPP-DEEP-DIVE.md](10-OFFERTEAPP-DEEP-DIVE.md) §5).

- Env vars: `SHOPIFY_CLIENT_ID`/`SHOPIFY_CLIENT_SECRET` (zelfde namen als Patroon A, maar **andere flow** — vandaar de eerdere, onjuiste voorlopige indeling bij Patroon A), plus optioneel `SHOPIFY_SHOP_DOMAIN_DEFAULT`/`SHOPIFY_ACCESS_TOKEN_DEFAULT` als env-var-fallback.
- Werking: eenmalige OAuth **authorization-code**-uitwisseling per shop (`/shopify/auth` → `/shopify/callback`, met eigen HMAC-verificatie van Shopify's callback-parameters), resulterend token wordt **permanent in Postgres** opgeslagen (`ShopifyStore.access_token`) — geen expiry-cyclus, geen refresh-logica nodig, maar ook geen automatische rotatie.
- **Enige app in dit landschap die genuinely multi-shop is**: `StoreManager` bouwt een registry van alle actieve `ShopifyStore`-rijen plus env-var-overrides.
- API-versie: `2025-01` (ouder dan Patroon A's `2026-07`).
- **Geen live shop-identity-guard, geen write-kill-switch** gevonden — een reëel verschil met POS' Patroon A-implementatie, zie [12-OFFERTEAPP-POS-OVERLAP.md](12-OFFERTEAPP-POS-OVERLAP.md).

## Resources gelezen/geschreven (bijgewerkt)

| App | Gelezen | Geschreven | Webhooks |
|---|---|---|---|
| POS | product variants, customers | draft orders (`draftOrderCreate`/`draftOrderComplete`), refunds (`refundCreate`), customers (`createSimpleCustomer`, achter guard) | Geen — bevestigd via grep + expliciete vermelding in `docs/PRODUCTION_SETUP.md`: "Geen webhooks nodig" |
| Stones4U-Catalog-SEO | products, collections, metafields, shop identity, app-installatie scopes | products, collections, metafields (`metafieldsSet`) — via allowlist/denylist-gate | Geen (los CLI-gereedschap, geen server) |
| "locatie" | product variants (zoeken), voorraadniveaus (`inventoryLevels`) | Niets — bevestigd: geen `mutation` in de hele codebase | Geen |
| **offerteapp** | producten (rijke zoekfunctie + metafields/unit-pricing/voorraadstatus), klanten, draft orders, orders (incl. custom metafields), order-transactions | producten (create!), klanten (create/update), draft orders (create/update/complete/invoice-send), order-tags/metafields (Mollie-markering), order-metafields (`status_bestelling` e.d.), **order editing na plaatsing** (gebouwd, nog niet aangesloten) | **Geen uitgaande** (ontvangt wel inbound webhooks van Mollie en Pallet Yard, geen Shopify-webhooks) |
| **s4u-quote-app** | producten/varianten (herresolutie bij submit) | draft orders (`draftOrderCreate`, handmatig getriggerd) | `APP_UNINSTALLED`, `PRODUCTS_UPDATE`, `PRODUCTS_DELETE`, 3× GDPR-topics |
| telefoon-*, transport-s4u, maten-en-meters(-s4u), productcards, stones4u-calculator, s4u-import-app | **Onbekend — geen broncode** | **Onbekend — geen broncode** | **Onbekend** |

## Scopes

Alleen af te leiden uit code waar broncode beschikbaar is:
- POS: impliciet `read_products`, `read_customers`/`write_customers`, `write_draft_orders`, `read_payment_terms`/`write_payment_terms` (voor rekening-checkout).
- Catalog-SEO: `read_products`/`write_products`, `read_content`/`write_content` (collections), metafield-scopes — niet expliciet als scope-lijst vastgelegd in code, af te leiden uit de gebruikte mutaties.
- Overige apps: `SHOPIFY_SCOPES`/`SCOPES` env var **namen** zijn bevestigd aanwezig bij de patroon-C-apps, maar de daadwerkelijke scope-waarden zijn niet opgevraagd (zouden geen geheim zijn, maar zijn niet nodig gebleken voor deze inventarisatie en zijn niet ingezien).

## Synchronisatie

- **Geen enkele lokaal onderzochte app gebruikt webhooks.** Alles is realtime/on-demand GraphQL-verkeer.
- **Geen lokale caching-tabellen** voor Shopify-data — wel point-in-time **snapshot-velden** (POS: prijs/titel/SKU op `CartLine`; "locatie": `sku`/`title`/`imageUrl` op `Stack`/`MapObject`) die eenmalig worden vastgelegd en nooit live worden ververst.
- Geen enkele lokaal onderzochte app gebruikt REST — uitsluitend GraphQL Admin API.

## Dubbele implementaties (nog niet wijzigen — alleen signaleren)

1. **De GraphQL-transportlaag** (fetch-wrapper, foutafhandeling, response-envelope) is vrijwel identiek onafhankelijk herbouwd in POS en Catalog-SEO.
2. **De client-credentials token-cache-logica** (in-memory cache, expiry-marge, in-flight de-duplicatie) is eveneens apart herbouwd in beide apps.
3. **De shop-identity safety-guard** (live `shop.myshopifyDomain`-check vóór elke schrijfactie) bestaat in beide apps, met verschillende implementaties maar identieke intentie.
4. Patronen B, C en D zijn structureel incompatibel met Patroon A en met elkaar — een echte Shared Core Shopify-client zou meerdere authenticatiestrategieën pluggable moeten ondersteunen, tenzij bewust wordt gekozen om apps naar één patroon te migreren (grote impact, buiten scope van deze discovery). Zie [14-SHARED-CORE-DESIGN.md](14-SHARED-CORE-DESIGN.md) voor het evolutionaire voorstel: een gedeelde client die zowel Patroon A als Patroon D als adapter ondersteunt, zonder bestaande apps te dwingen te migreren.
5. **OfferteApp's retry-met-backoff (2 pogingen, lineaire backoff) is rijker dan POS' geen-retry-aanpak** — bij het bouwen van een gedeelde client is OfferteApp's foutafhandeling het betere uitgangspunt, POS' shop-identity-guard en write-kill-switch zijn het betere veiligheidsuitgangspunt. Een gedeelde client zou beide moeten combineren.
