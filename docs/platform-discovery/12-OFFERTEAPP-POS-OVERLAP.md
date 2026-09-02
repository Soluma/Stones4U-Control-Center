# 12 — Overlap: OfferteApp ↔ Kassa Systeem (POS) ↔ s4u-quote-app

Kassa Systeem dient hier uitsluitend ter vergelijking (zoals gevraagd) — het is geen kandidaat om te wijzigen. Waar relevant is ook s4u-quote-app toegevoegd als derde datapunt, omdat het een derde, weer andere Shopify-authenticatiestrategie gebruikt.

## Shopify-client / client-credentials-flow / tokencaching

| Aspect | POS (Kassa Systeem) | OfferteApp | s4u-quote-app |
|---|---|---|---|
| Auth-model | **OAuth client-credentials grant** (`grant_type=client_credentials`) | **OAuth authorization-code flow**, permanent token per shop in DB | Shopify-embedded-app OAuth (authorization-code, via `@shopify/shopify-app-remix`) |
| Token-opslag | In-memory only (module-level cache, nooit persistent) | **Permanent in Postgres** (`ShopifyStore.access_token`) | Sessie-tabel (`PrismaSessionStorage`-equivalent, offline token op `Shop.accessTokenOffline`) |
| Token-refresh | Automatisch, ~60s marge vóór expiry, in-flight de-duplicatie | Niet van toepassing (permanent token, geen expiry-cyclus) | Niet van toepassing (permanent offline token na eenmalige OAuth) |
| Multi-shop | Nee, single-shop | **Ja — `StoreManager`, genuinely multi-tenant**, registry van meerdere `ShopifyStore`-rijen + env-var-fallback | Ja, multi-tenant per ontwerp (Shopify-app-template), maar in de praktijk vandaag op één shop |
| Client-bestand | `src/lib/shopify.ts` | `app/services/shopify/graphql_client.py` + `store_manager.py` | `@shopify/shopify-app-remix` (library, niet zelfgebouwd) |
| GraphQL | Ja, uitsluitend | Ja, uitsluitend | Ja, uitsluitend (REST expliciet uitgeschakeld: `removeRest: true`) |
| API-versie | `2026-07` | `2025-01` | Niet expliciet vastgesteld in de agent-rapportage; via de shopify-app-remix library, doorgaans de nieuwste ondersteunde versie tijdens installatie |
| Retry/foutafhandeling | `ShopifyApiError`-klasse, 10s timeout, generiek | Timeout 15s, **tot 2 retries met lineaire backoff** op transiënte netwerkfouten — rijker dan POS | Library-ingebouwd (shopify-app-remix) |
| Shop-identity guard | **Ja** — live `shop.myshopifyDomain`-check vóór elke schrijfactie (`shopify-guard.ts`) | **Nee — niet gevonden.** Geen equivalent van de POS-guard. | Niet van toepassing op dezelfde manier (embedded apps zijn inherent shop-gescoped via de sessie) |
| Write-guards | Master-switch (`SHOPIFY_WRITES_ENABLED`) + featurevlaggen (`ALLOW_SHOPIFY_ORDERS`/`ALLOW_SHOPIFY_RETURNS`) | **Geen equivalent gevonden** — schrijfacties (draft order create/update/complete, customer create/update, order editing) hebben geen centrale aan/uit-schakelaar | Server valideert/overschrijft prijzen bij submit, maar geen globale write-kill-switch |

**Belangrijkste bevinding**: drie apps, drie verschillende Shopify-authenticatiestrategieën, en de POS-app is de **enige** met een live shop-identity-guard én een centrale write-kill-switch. Dit is een reëel, aantoonbaar risico-verschil tussen de apps — niet alleen een stijlverschil.

## Customer

- POS: geen lokale Customer-tabel, alleen `shopifyCustomerId` + snapshotvelden op `Cart`.
- OfferteApp: `CustomerCache` (read-through cache, gesleuteld op `shopify_customer_id`) + bevroren snapshot op `Quote`. Rijker dan POS (heeft een echte cache-tabel + timeline via `CustomerActivity`), maar nog steeds geen stamgegevens-eigenaarschap.
- s4u-quote-app: geen enkele klant-cache — klantgegevens leven alleen op de `Quote`-rij zelf, nooit gesynchroniseerd naar Shopify of naar een lokale cache.

**Overlap**: alle drie apps behandelen Shopify als de enige bron van waarheid voor klanten, en alle drie hebben een eigen, onderling incompatibele manier om een "snapshot op het moment van de transactie" vast te leggen.

## Producten

- POS: leest `productVariants`, snapshot op `CartLine`.
- OfferteApp: rijkere zoekfunctie (2-fase, metafield-scan, throttle-aware), leest ook Shopify's native unit-pricing (`unitPriceMeasurement`) — vergelijkbaar met POS' `unitMeasureLabel`/`unitMeasurePrice`/`unitMeasureContentPerPiece`-velden op `CartLine`, mogelijk dezelfde onderliggende Shopify-functionaliteit apart geïnterpreteerd.
- OfferteApp kan bovendien **nieuwe Shopify-producten aanmaken** vanuit de UI (geen enkele andere app in dit landschap doet dit).

## Orders / draft orders

- POS: `draftOrderCreate`/`draftOrderComplete`, geen order-editing na plaatsing.
- OfferteApp: dezelfde twee mutaties, plus **volledige Order Editing API-wrapper** (nog niet aan een route gekoppeld) — een mogelijkheid die POS niet heeft en ook niet nodig heeft (kassatransacties worden niet achteraf bewerkt, wel geretourneerd via een apart `Return`-model).
- s4u-quote-app: alleen `draftOrderCreate`, handmatig getriggerd, geen `complete`/editing.

## Users/Auth

| Aspect | POS | OfferteApp |
|---|---|---|
| Wachtwoord-hashing | **argon2** (`@node-rs/argon2`) | **Werkzeug default** (scrypt/pbkdf2, niet argon2) |
| Sessie-opslag | DB-backed (`Session`-tabel, tokenHash) | Cookie-based (Flask-Login), **geen DB-sessietabel** |
| Rollen | 3 vaste rollen, ~5 hardcoded rolchecks, geen permissietabel | 3 vaste rollen **plus** een granulair, admin-overschrijfbaar permissiesysteem (`FEATURE_GROUPS`, runtime aanpasbaar via een DB-setting) — rijker dan POS |
| Wachtwoord-reset | Niet gevonden in eerdere discovery | Volledig geïmplementeerd (admin-getriggerd, gehasht token, expiry, eenmalig) |

**Overlap**: beide apps herbouwen onafhankelijk hetzelfde probleem (login, sessie, rol-gebaseerde autorisatie) met verschillende technische keuzes op bijna elk punt — een sterke Shared Core-kandidaat, mits bewust gekozen wordt welke keuzes (argon2? DB-sessies? granulaire permissies?) de gezamenlijke standaard worden.

## BTW / prijsformattering

- POS: `taxRate: Decimal(5,2)` per `CartLine`, geen aparte BTW-rond­ings­logica gevonden buiten de generieke `round2()`-hulpfunctie in `pricing.ts`. Kortingsberekening is **één centrale, goed geteste functie** (`calculateLineAmounts()`) — expliciet gedocumenteerd als "single source of truth," met een apart largest-remainder-algoritme (`splitDiscountAcrossQuantity()`) om Shopify's per-eenheid-kortingsbeperking correct te modelleren.
- OfferteApp: `vat_percent` per offerte (niet per regel), alle bedragen inclusief BTW opgeslagen, **dezelfde berekening bewust 5× gedupliceerd** (drie plekken in JS + de backend) — het exacte probleem dat POS' `calculateLineAmounts()`-aanpak voorkomt.
- Beide apps gebruiken decimale (niet floating-point) rekenkunde voor geld — een gedeeld, goed onderbouwd principe, alleen anders geïmplementeerd (Prisma.Decimal vs. Python `Decimal`/string).

**Sterke Shared Core-kandidaat**: een gedeelde, geteste "regel-/orderkorting + BTW"-rekenmodule zou OfferteApp's zelf-erkende 5×-duplicatieprobleem direct oplossen én POS' bestaande aanpak (die al bewezen correct en single-source-of-truth is) elders herbruikbaar maken.

## Audit logging

- POS: `AuditLog`-Prisma-model, append-only, gebruikt voor prijswijzigingen/kortingen/retours.
- OfferteApp: **drievoudig** — `AuditLog` (generieke actielog, plus een gestructureerde `log_event()`-laag erbovenop), `QuoteVersion` (volledige contentsnapshot per save), `CustomerActivity` (leesbare tijdlijn). Rijker maar ook fragmentarischer dan POS' ene tabel.
- Stones4U-Catalog-SEO (uit eerdere discovery): flat JSON-audit-bestanden, weer een derde, incompatibel patroon.

**Drie apps, drie audit-implementaties, zelfde intentie** ("bewijs wat er veranderd is") — een van de duidelijkste Shared Core-kandidaten in het hele landschap.

## Locations

- POS heeft een expliciet `Location`-model (vestiging, `shopifyLocationId` nog niet ingevuld) en `Terminal`-model.
- OfferteApp heeft **geen** locatie-concept in de onderzochte modellen — bedrijfsgegevens zijn een singleton in `Setting`, geen multi-vestiging-model. Logisch, aangezien OfferteApp geen fysieke kassa/toonbank-concept heeft.

**Geen overlap** — dit blijft terecht POS-specifiek.

## Error handling

- POS: één centrale `ShopifyApiError`-klasse, consistente foutstructuur.
- OfferteApp: `ValueError` bij GraphQL-fouten in de basis-client, maar rijkere retry-logica (2 pogingen, lineaire backoff) dan POS.
- Beide loggen bewust nooit secrets, alleen Shopify's eigen foutrespons (die geen secrets bevat) — een gedeeld, goed veiligheidsprincipe, apart geïmplementeerd.

## Shared types/utilities

Geen enkele gedeelde package/module bestaat vandaag tussen de drie apps — elke Shopify-client, elk Customer/Product/Order-type, elke BTW-berekening, elke audit-log, elk auth-systeem is **onafhankelijk van nul opgebouwd**, ondanks sterk overlappende intentie. Dit is het kernbewijs voor de Shared Core-aanbeveling in [14-SHARED-CORE-DESIGN.md](14-SHARED-CORE-DESIGN.md).
