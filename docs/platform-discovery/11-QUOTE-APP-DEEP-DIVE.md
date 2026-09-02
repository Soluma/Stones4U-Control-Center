# 11 — s4u-quote-app: Deep Dive

Bron: `D:\Shopify\s4u-quote-app` — git repo, remote `github.com/Soluma/s4u-quote-app`, branch `master`, working tree clean, 55 commits (2026-07-08 t/m 2026-07-12). Volledig gelezen: `shopify.app.toml`, `app/shopify.server.ts`, alle routes onder `app/routes/`, alle services onder `app/services/`, `prisma/schema.prisma` + migraties, de Theme App Extension, en de interne docs (`docs/RELEASE_SUMMARY.md`, `docs/DECISIONS.md`, `docs/ARCHITECTURE.md`, `docs/INTERNAL_RELEASES.md`).

## 1. Framework & architectuur

Klassieke **Shopify CLI / Remix embedded-app template** — bevestigt het vermoeden uit de eerdere Fly-secrets-only inventarisatie. Remix v2 + `@shopify/shopify-app-remix` v3, TypeScript, Polaris/App Bridge voor de admin-UI, Vite build, Vitest-tests (17 testbestanden, 255–278 tests). Node `>=20`, Docker op `node:20-alpine`. `app/routes/` (flat-file routing), `app/services/` (business logic), `app/lib/` (utilities), `prisma/`, `extensions/quote-theme-extension/`.

## 2. Shopify app-structuur

`shopify.app.toml`: `embedded = true`, `application_url = https://s4u-quote-app.fly.dev`, scopes `read_products,write_products,read_customers,write_draft_orders,read_draft_orders`, App Proxy op `apps/quote` → `/apps/quote/*`, en één Theme App Extension ("Quote Button"). `AppDistribution.AppStore` staat in code, maar de app draait volgens de eigen docs **uitsluitend als custom/development app op één shop** — geen App Store-billing/listing.

## 3. Embedded vs non-embedded

Hybride: een embedded Shopify Admin-app (Polaris/App Bridge) vóór het personeel, plus een Theme App Extension + App Proxy die de daadwerkelijke offerte-flow op de storefront afhandelt. De storefront laadt nooit een embedded iframe — vanilla JS/Liquid in het thema praat uitsluitend via `/apps/quote/*` met de backend.

## 4. Authenticatie

- **Merchant/admin**: standaard OAuth authorization-code flow (`@shopify/shopify-app-remix`), offline token opgeslagen op een eigen `Shop`-tabel (niet alleen de standaard Session-tabel).
- **Sessies**: `PrismaSessionStorage`, standaard `Session`-model.
- **Nieuwe embedded auth-strategie**: sessie-token (JWT)-gebaseerd, `removeRest: true` — uitsluitend GraphQL, geen REST Admin API meer.
- **Storefront/proxy**: zelfgebouwde HMAC-verificatie van de App Proxy query string (`app/lib/proxy-validator.server.ts`), plus een **"direct CORS" fallback-modus zonder HMAC** wanneer de proxy-route niet bereikbaar is — expliciet gedocumenteerd als een bewuste, zwakkere-security-afweging (`docs/DECISIONS.md` §9b).
- **CSRF**: double-submit HMAC-token (2 uur geldig) op de submit-mutation.
- Env-varnamen (geen waarden): `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SHOPIFY_SCOPES`, `SESSION_SECRET`, `DATABASE_URL`, optioneel `SHOP_CUSTOM_DOMAIN`.

## 5. Shopify scopes

`read_products, write_products, read_customers, write_draft_orders, read_draft_orders`. **`write_products` en `read_customers` zijn aangevraagd maar worden nergens in de code daadwerkelijk gebruikt** — door de eigen documentatie zelf gemarkeerd als een least-privilege-aandachtspunt.

## 6. Database (Prisma/Postgres)

Multi-tenant, één database, elke shop-specifieke rij heeft een `shopId`-FK (getest via toegewijde tenant-isolatietests). Modellen: `Session` (standaard shopify-app-remix), `Shop` (myshopifyDomain, shopifyShopId, accessTokenOffline, scopes), `ShopSettings` (knop/formulier/branding-configuratie per shop), `Quote` (het offerteverzoek zelf — publicQuoteNumber, status, source, volledige klant-/adresgegevens, projectvelden, totalen, `draftOrderId`/`draftOrderName`), `QuoteItem` (regel — snapshot van product/variant, prijs), `QuoteEvent` (audit-tijdlijn), `WebhookEvent` (log van elke ontvangen webhook), `QuoteFormFieldDefinition`/`QuoteFieldValue` (per-shop custom formuliervelden), `QuoteUpsellRule` (cross-sell-regels).

## 7. Storefront-integratie

Theme App Extension met drie Liquid-blocks (`quote-button`, `quote-card-button`, `quote-header-badge`). Alle client-logica in één ongebundeld vanilla-JS-bestand (`assets/quote.js`) dat uitsluitend de eigen App Proxy aanroept (`/apps/quote/settings`, `/apps/quote/submit`) — geen enkele andere externe fetch-aanroep bestaat in de hele extensie.

## 8. Offertewinkelmand / offerte-aanvraag

De winkelmand leeft volledig **client-side in `localStorage`** — er is geen server-side sessie/cart-tabel. Vier oudere server-side cart-routes (`add`/`list`/`remove`/`update`) zijn **gedeprecieerd en geven HTTP 410** — dode code, bewust bewaard voor traceerbaarheid.

Indiening (`POST /apps/quote/submit`): rate-limit-check → HMAC-auth → CSRF-check → dynamische Zod-validatie (verplichte velden per shop instelbaar) → **server valideert en overschrijft client-prijzen met live Shopify-prijzen** → `QuoteService.createQuote` (schrijft Quote + QuoteItem[] + QuoteFieldValue[], logt een `QuoteEvent`) → fire-and-forget e-mail naar de winkelier → JSON-respons met offertenummer.

## 9. Klantgegevens

Voornaam/achternaam, e-mail (verplicht), telefoon, bedrijf, volledig postadres — elk apart instelbaar als verplicht per shop. Opgeslagen direct op de `Quote`-rij, **niet gesynchroniseerd naar Shopify Customer-records** (geen enkele `customers/*`-schrijfaanroep gevonden — consistent met het feit dat `read_customers` ongebruikt is).

## 10. Producten/varianten

Client stuurt `shopifyProductId`/`shopifyVariantId`; server herresolvet dit via een live GraphQL `nodes(ids:...)`-query en slaat een **snapshot** op (titel, varianttitel, SKU, handle, afbeelding) naast de live ID's — zodat historische offertes leesbaar blijven ook als het product later wijzigt/verdwijnt.

## 11. Prijsdata

**Shopify-doorgeef-prijzen met server-side hervalidatie**, geen eigen prijsberekening. Een mismatch tussen client- en server-prijs wordt alleen gelogd, nooit geblokkeerd of aan de winkelier getoond — een bekende, gedocumenteerde lacune. `QuoteItem.proposedPrice` bestaat in het schema voor een toekomstige handmatige prijsoverschrijving door de winkelier, maar er is **geen admin-UI** om dit veld ooit te zetten — in de praktijk altijd `null`.

## 12. Metafields

Geen. Metafields worden expliciet niet meegestuurd bij de Draft Order-mutatie (in-code commentaar bevestigt dit als bewuste keuze); nergens in de codebase wordt een metafield gelezen of geschreven.

## 13. E-mail

Alleen uitgaand, alleen **naar de winkelier** bij een nieuwe offerte (nodemailer/SMTP, fire-and-forget, faalt de indiening niet). **Geen bevestigingsmail naar de klant.** SMTP is optioneel — zonder configuratie wordt verzenden stil overgeslagen.

## 14. Draft orders

**Uitsluitend handmatig** door de winkelier vanuit de admin-detailpagina van een offerte — nooit automatisch bij indiening (bewuste ontwerpkeuze, expliciet gedocumenteerd). Bouwt regels met voorkeur voor een echte variant-ID, met een fallback naar een custom line item bij ontbrekende variant-ID of handmatige prijsoverschrijving. Voegt een `quote:{publicQuoteNumber}`-tag toe en schrijft `draftOrderId`/`draftOrderName` terug op de Quote.

## 15. Webhooks

`APP_UNINSTALLED`, `PRODUCTS_UPDATE`, `PRODUCTS_DELETE` (alleen gelogd, geen reactieve logica), plus de drie GDPR-topics (`CUSTOMERS_DATA_REQUEST`, `CUSTOMERS_REDACT`, `SHOP_REDACT`) met daadwerkelijke implementatie (anonimiseren/verwijderen). Alle webhooks worden gelogd in `WebhookEvent`.

## 16. API endpoints / callbacks

Volledige lijst inclusief methode en auth-vereiste is opgenomen in het onderliggende agent-rapport; kern: `/app/*` (admin-UI, sessie-geauthenticeerd), `/apps/quote/settings` en `/apps/quote/submit` (proxy-geauthenticeerd, de enige actieve publieke endpoints), `/apps/quote/{add,list,remove,update}` (gedeprecieerd, 410), `/webhooks`, `/health`, `/health/db`.

## 17. Opslag

Geen enkele vorm van bestandsopslag. Geen S3/R2. `docs/ARCHITECTURE.md` noemt S3/R2 alleen als **toekomstig** idee voor PDF-bijlagen, niet geïmplementeerd.

## 18. Security

Zelfgebouwde HMAC-verificatie (proxy) + ingebouwde HMAC-verificatie (webhooks via shopify-app-remix), CSRF-token op submit, in-memory (dus niet multi-instance-veilige, expliciet zo gedocumenteerd) rate limiting, Zod-validatie overal, expliciete CORS-allowlist met een gedocumenteerde wildcard-fallback voor de "direct CORS"-bypass, tenant-isolatie via `shopId`-scoping met toegewijde tests (met één gedocumenteerde architecturale zwakte: sommige updates verifiëren eigendom via een voorafgaande `findFirst` in plaats van `shopId` in de `where`-clause van de update zelf op te nemen).

## 19. Deployment

Fly.io app `s4u-quote-app` (regio `ams`), `release_command = npx prisma migrate deploy`, health check op `/health`, `min_machines_running = 1`. **Komt overeen met de eerder gevonden Fly-app.** Backend en Theme App Extension worden **onafhankelijk gedeployed** (`fly deploy` vs. `shopify app deploy`) — dit heeft ooit een incident veroorzaakt (custom formuliervelden werkten in de admin maar niet op de storefront tot de extensie apart was gedeployed).

## 20. Status/maturity

Actief ontwikkeld in een korte, dichte periode (55 commits, 2026-07-08 t/m 2026-07-12); de eerste commit is expliciet een "baseline of existing quote app"-import, wat betekent dat de app al bestond vóór deze git-historie. Sinds de laatste commit (2026-07-12) zijn er, gerekend vanaf vandaag (2026-09-01), **circa 7 weken geen zichtbare activiteit** — eerder "laatst bekend goed, momenteel stil" dan "verlaten", gezien de grondige documentatie (14 docs incl. changelog, decisions, acceptatietests, deploy-checklist).

## 21. KRITIEK — hoe komt een offerteaanvraag in OfferteApp terecht?

**Bevinding: er bestaat geen enkel integratiemechanisme naar OfferteApp in deze codebase — en dat wordt expliciet bevestigd door de eigen documentatie van de app.**

- Geen enkele uitgaande HTTP-aanroep naar iets dat op een OfferteApp/ERP-endpoint lijkt (volledige repo-grep op "OFFERTE", externe base-URL-env-vars, en alle `fetch`/`axios`-aanroepen levert precies twee `fetch()`-calls op, beide in de storefront-JS naar de **eigen** App Proxy-endpoints).
- Geen gedeelde database — `DATABASE_URL` wijst naar de eigen Postgres van deze app.
- Draft orders zijn het enige Shopify-side artefact, en het aanmaken daarvan is **handmatig, door de winkelier geïnitieerd** — geen webhook-listener of polling-mechanisme dat OfferteApp zou kunnen voeden bestaat in deze repo.
- E-mail is eenrichtingsverkeer naar de winkelier, een platte notificatie ("er is een nieuwe offerte, log in op Shopify Admin") — geen gestructureerde payload, geen aanwijzing van een export-workflow.
- **`docs/RELEASE_SUMMARY.md` §6 zegt letterlijk**: *"Geen koppeling met een extern offerteprogramma/ERP. Offertes bestaan uitsluitend binnen deze app en als Shopify Draft Order na handmatige omzetting."* Punt 6 van de aanbevolen vervolgstappen (§8) noemt een externe offerteprogramma-koppeling expliciet als **toekomstig, nog niet gestart werk**.

**Conclusie**: vandaag is de koppeling naar OfferteApp **niet-bestaand — aspirationeel/onaf, precies zoals de eigen docs van de app stellen.** Een offerte leeft alleen in de eigen `Quote`/`QuoteItem`-tabellen van s4u-quote-app, zichtbaar alleen in de eigen embedded admin-UI, totdat een winkelier handmatig op "Maak Draft Order" klikt — waarna het een standaard Shopify Draft Order wordt die *in principe* door elke andere app met de juiste scope (waaronder OfferteApp, indien die scope heeft) gelezen zou kunnen worden. Niets in s4u-quote-app duwt, notificeert, of coördineert actief met OfferteApp. Zie [10-OFFERTEAPP-DEEP-DIVE.md](10-OFFERTEAPP-DEEP-DIVE.md) voor de andere kant van deze vraag: leest OfferteApp daadwerkelijk Shopify Draft Orders, of bestaat de koppeling ook daar niet?
