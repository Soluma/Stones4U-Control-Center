# 10 — OfferteApp: Deep Dive

Bron: `D:\Shopify\OfferteApp` — git repo, remote `github.com/Soluma/OfferteApp.git`, branch `master`, working tree clean, 121 commits, laatste commit `88dd2c8` (2026-08-26). Eigen levende statusdocumentatie: `docs/PROJECT_STATUS.md` (bevestigt productie-release **v455** op Fly.io, "gezond"), `docs/PRODUCTION.md`, `CHANGELOG.md`. Dit is een **volwassen, actief onderhouden, momenteel in productie draaiende applicatie** — geen prototype.

Classificatieschema per feature: **A** = primair Quotes/Sales, **B** = eigenlijk CRM, **C** = eigenlijk Operations, **D** = Shared Core kandidaat, **E** = legacy/technische schuld.

## 1. Framework & architectuur — **D**

**Flask** (bevestigt het vermoeden uit `SECRET_KEY`), niet Django. Flask 3.1 / SQLAlchemy 2.0 (Flask-SQLAlchemy) / Alembic (Flask-Migrate) / Flask-Login / Flask-WTF (CSRF) / Gunicorn. Postgres in productie, SQLite lokaal/tests. `cryptography` (Fernet) voor het versleuteld opslaan van secrets in de database — een patroon dat nergens anders in het landschap is aangetroffen. Geen Mollie-SDK, geen OpenAI-SDK — beide zijn handgeschreven `requests`-clients.

Structuur: `app/models/` (17 modellen), `app/services/` (per domein: shopify, quotes, auth, audit, customers, visit_reports, files, email, payment, transport_integration, warehouse, security), `app/blueprints/` (13 Flask blueprints, elk met `routes.py` + `api.py`), `app/templates/` (Jinja2, server-rendered), `app/static/js/` (vanilla JS, geen frontend-framework, geen JS-testtooling).

Tests: pytest, 28 testbestanden, **367 testfuncties**, 4 bekende/geaccepteerde pre-existing failures (gedocumenteerd, geen regressies).

## 2. Klanten — **B**

**Geen lokaal "master" Customer-model** — Shopify blijft bron van waarheid. In plaats daarvan een read-through **cache**: `CustomerCache` (sleutel `shopify_customer_id`, gedenormaliseerde velden, `last_synced_at`). Klant-zoeken in de UI bevraagt **parallel** zowel de lokale cache als live Shopify. Een `flask sync-customer-cache` CLI-commando doet een bulk pull vanuit Shopify (pull/polling, geen webhook). `Quote` bevat daarnaast een eigen bevroren snapshot van klantgegevens op het moment van opslaan, onafhankelijk van de cache. Dit is een dunne laag — puur een zoeksnelheid-cache plus een activiteiten-tijdlijn, geen onafhankelijke klant-stamgegevens.

## 3. Offertes / offerte-regels — **A**

`Quote`: identiteit (`uuid`, `quote_number` formaat `OFF-YYYY-MMDD-NNN`), Shopify-koppelingen (`shopify_customer_id`, `shopify_draft_order_id`, `shopify_order_id`), lokale FK naar `CustomerCache`, bevroren klant-snapshot + volledig parallel verzendadres-blok, transportvelden **direct op Quote** (Hoefnagels-pad, zie §9), financiën (`vat_percent` default 21.00, `order_discount_type/value`, `subtotal_inc`/`discount_total_inc`/`total_inc` — alle bedragen **inclusief BTW**), weergave-/printvlaggen, `source_store` (multi-store).

`QuoteLine`: sortering, `shopify_variant_id` (nullable — ondersteunt custom regels), volledige productsnapshot, prijsvelden (`quantity` Numeric 12,4 — ondersteunt m²-hoeveelheden), `unit` (stuk/m²/m¹/kg/pallet/set), kortingsvelden, marge-tooling (`inkoopprijs`, `marge_percent`, alleen zichtbaar met `field_inkoopprijs`-permissie), `raw_payload_json`.

**Versiebeheer**: `QuoteVersion` — elke save triggert een volledige JSON-snapshot van offerte + regels, oplopend versienummer. Append-only, geen diff — staff kan de volledige historie doorbladeren.

## 4. Prijzen, kortingen, BTW — **A**

Alle opgeslagen bedragen zijn **inclusief BTW** (`_inc`-suffix overal, geen aparte excl.-BTW-kolom). Drie kortingstypen (percentage/fixed/fixed_m2, laatste alleen op regelniveau — korting per m² i.p.v. per stuk). Berekening centraal in `quote_service.py` (`_build_line`, `_recalc_totals`, `_calculate_order_discount`).

**Zelf-gedocumenteerde technische schuld (E)**: dezelfde rekenlogica is **bewust 5× gedupliceerd** (drie plekken in `bezoekrapport.js` + de backend `quote_service.py`) — vereist gesynchroniseerde wijzigingen, expliciet zo benoemd in `PROJECT_STATUS.md`.

BTW-weergave (`prices_excl_btw`) is puur een print/PDF-weergaveschakelaar, wijzigt niets aan opgeslagen data. `round_price_5ct` is een Nederlandse contant-afrondingsconventie, eveneens alleen bij weergave/print toegepast.

## 5. Shopify-integratie — **A (draft order/order-logica) / D (client, StoreManager, OAuth-flow)**

**API-versie `2025-01`, uitsluitend GraphQL.** Auth is **structureel anders dan POS**: OAuth **authorization-code flow** (niet client-credentials), permanent access-token per shop opgeslagen in Postgres (`ShopifyStore`-model), via een eigen OAuth-blueprint (`/shopify/auth`, `/shopify/callback` met eigen HMAC-verificatie, `/shopify/install`, `/shopify/disconnect`). **Geen client-credentials-patroon, geen live shop-identity safety guard** zoals in POS gevonden — een echte architecturale divergentie.

**Genuinely multi-tenant/multi-shop**: `StoreManager` bouwt een registry uit actieve `ShopifyStore`-rijen plus env-var-fallback (`SHOPIFY_SHOP_DOMAIN_DEFAULT`/`SHOPIFY_ACCESS_TOKEN_DEFAULT` + arbitraire extra `_<KEY>`-paren) — anders dan elke andere onderzochte app in dit landschap, die allemaal single-shop zijn.

Gelezen/geschreven: klanten (create/update), producten (rijke zoekfunctie incl. metafields/unit-pricing/voorraadstatus, 2-fase zoekstrategie met throttle-awareness), **productcreatie** vanuit de offerte-UI (publiceert automatisch naar POS + Inbox, expliciet niet naar Online Store), draft orders (create/update/complete/invoice-send, met retry-on-"still calculating"), orders (rijke query incl. custom metafields `status_bestelling`/`levering`/`gewenste_leverdatum`/print-tellers), **order editing na plaatsing** (volledige Order Editing API-wrapper — **A, maar E**: geïmplementeerd, nog aan geen enkele route/UI gekoppeld, voor de "bestellingen op rekening"-feature).

**Geen uitgaande Shopify-webhooks geregistreerd** — de app initieert zelf al het Shopify-verkeer (poll/pull), ontvangt alleen webhooks van Mollie en Pallet Yard.

## 6. Interne notities — **A/B**

`Quote.internal_note` (apart van het klant-zichtbare `note`-veld, gated door `field_internal_notes`-permissie) en `VisitReport.internal_only`. Geen losstaand Note-model onafhankelijk van een offerte/bezoekrapport.

## 7. Betalingen — Mollie — **A**

Een echte, volledig geïmplementeerde, **live productie-geverifieerde** opt-in tweede betaalroute naast Shopify's eigen betaallinks. Handgeschreven `requests`-client (geen officiële SDK) tegen Mollie's Payment Links API (altijd single-use) en Payments API (statusverificatie). API-key/mode staan **niet in env vars maar versleuteld in de database** (`Setting`), beheerd via Instellingen → Betalingen, met een expliciete mode/key-mismatch-check.

`MolliePayment`-model volgt de volledige levenscyclus tot en met de gekoppelde Shopify-order. Webhook (`POST /api/payment/mollie/webhook`, csrf-exempt, geen login) is defensief correct: vertrouwt nooit de webhook-payload zelf, haalt altijd de echte status live op bij Mollie, is idempotent, en **auto-completeert** de draft order naar een echte Shopify Order zodra betaald.

## 8. Bezoekrapporten — **A (het scherm) / B (het model)**

Let op: "bezoekrapport" is in deze app tegelijk de naam van het hoofdscherm waarin offertes worden gebouwd (dus feitelijk **A**) én een apart, smaller `VisitReport`-model (titel, vrije tekst, `internal_only`-vlag, optionele koppeling aan quote/klant — dit is echt **B**, CRM). Elke aanmaak logt een `CustomerActivity`, zichtbaar in het klantdossier/tijdlijn naast offertes.

## 9. Warehouse / Pallet Yard / Transport-S4U — **C**

Twee **structureel gescheiden** integraties, bevestigd door directe codelezing (bevestigt de eerdere discovery-inferentie):

**Pallet Yard**: `PALLET_YARD_BASE_URL`/`PALLET_YARD_INTEGRATION_KEY`, altijd geregistreerd (geen feature flag). `create_fulfillment_plan()` stuurt een order-payload naar `POST {base}/api/fulfillment/plans` (header `x-integration-key`). **Inbound**: `POST /api/warehouse/callback` — een echt werkend, geauthenticeerd (dezelfde integration-key) webhook-ontvangstpatroon, al aanwezig in deze codebase. Status bijgehouden in `WarehouseFulfillmentLink`.

**Transport-S4U (Van Eijk/Babeldat)**: `TRANSPORT_APP_BASE_URL`/`TRANSPORT_INTERNAL_API_TOKEN` (kan ook via DB `Setting` overschreven worden, die voorrang heeft op de env var). Bearer-token client, volledige shipment-CRUD + label-ophalen. Ondersteunt ook **standalone transport**, niet gekoppeld aan een Shopify-order. Lokale tracking via `TransportJob` (volledige levenscyclus) + `TransportEvent` (append-only log).

**`ENABLE_TRANSPORT_IN_OFFERTES`**: een **dubbele poort** — zowel de env var (deployment-niveau, default `false` in productie) als een admin-instelbare DB-setting (`transport_integration_active`) moeten beide aan staan. De blueprints zelf zijn altijd geregistreerd; de vlag regelt UI-zichtbaarheid en server-side validatie, niet route-registratie.

**Belangrijke architecturale notitie (E, uit `PROJECT_STATUS.md` zelf)**: Van Eijk/Babeldat en Hoefnagels-transport **delen géén datamodel** — Hoefnagels gebruikt uitsluitend `Quote.hoefnagels_*`-velden + een Shopify order-metafield + planning per e-mail, zonder ooit een `TransportJob`-rij aan te maken.

## 10. Labels, pikbon, pakbon, printers — **C (D voor de PDF-engine, zie §12)**

Pikbon/pakbon zijn print-vriendelijke HTML-weergaven, print-tellers bijgehouden via Shopify order-metafields. **Printarchitectuur leunt op een lokale Windows-companion-app buiten deze repo**: browser bouwt HTML client-side → POST naar OfferteApp's eigen `/api/offerte/render-pdf` (zelfde PDF-engine als de offerte-e-mail, zie §12) → browser base64-encodeert de PDF → POST naar een lokale helper-proces op `localhost:9876` die stil afdrukt via SumatraPDF. Per-gebruiker printervoorkeur op `User`. Alternatief: QZ Tray (in-browser signed silent printing, opt-in per gebruiker, certificaat/private key versleuteld in `Setting`). Geen ZPL/raw-label-protocol gevonden — altijd via gerenderde PDF/HTML.

## 11. E-mail — **A (gebruik) / D (de SMTP-client zelf)**

Handgerolde SMTP via Python's stdlib (`smtplib`), geen third-party library. Config (incl. versleuteld wachtwoord) in `Setting`. Bouwt een correcte `multipart/alternative`-boodschap, stuurt **losse, individueel geadresseerde berichten** per ontvanger (bewuste keuze voor per-adres trackbaarheid). Gebruikt voor offerte/factuur-PDF-verzending en Hoefnagels-planningsmails. Geen queue/retry — synchroon, in-request.

## 12. Documenten/PDF — **D (engine) / A (offerte-gebruik) / C (pikbon/pakbon-gebruik)**

Engine: **xhtml2pdf**, één gedeelde `_generate_pdf()`-functie hergebruikt voor zowel offerte-e-mailbijlagen als de pikbon/pakbon/label-renderpijplijn — één functie die twee domeinen bedient, een bruikbaar signaal voor hoe een gedeelde "document rendering"-service er later uit zou kunnen zien.

**PDF's zijn volledig vluchtig** — nooit opgeslagen (niet op filesystem, niet in DB, niet in S3/R2). De enige duurzame vastlegging van een offerte's historische inhoud is de JSON-snapshot in `QuoteVersion`, niet een gerenderd bestand. Het `Attachment`-model bestaat al (met `storage_backend`/`storage_path`), maar de service is expliciet een **placeholder voor "fase 2"** — geen daadwerkelijke upload/opslagcode bestaat. **E/gepland**: `docs/PRODUCTION.md` bevestigt: "Bestandsbijlagen nog niet geïmplementeerd (fase 2)."

## 13. Gebruikers, authenticatie, rollen — **D**

`User`: email, `password_hash` (via **Werkzeug**, niet argon2 — een divergentie t.o.v. POS, zie [12-OFFERTEAPP-POS-OVERLAP.md](12-OFFERTEAPP-POS-OVERLAP.md)), `role` (admin/sales/readonly), printervoorkeuren. Sessiebeheer via Flask-Login, **cookie-based, geen DB-sessietabel** (anders dan POS' DB-backed sessions). 8 uur sessieduur, secure/httponly/samesite-cookies in productie.

Rollen: drie vaste rollen + een **rijker granulair permissiesysteem** erbovenop (`FEATURE_GROUPS` van `menu_*`/`field_*`-sleutels, per-rol defaults, **door een admin runtime overschrijfbaar** via een DB-setting) — dit is een echt werkend RBAC-met-overrides-systeem, rijker dan POS' vaste 3-rollen-check. Wachtwoord-reset: admin-getriggerde flow met gehasht, verlopend, eenmalig token.

## 14. Instellingen — **D (het patroon) / A+C (de inhoud)**

Generiek `Setting` key/value-model — niet verspreid over losse tabellen. Een vaste allowlist gevoelige sleutels wordt **transparant versleuteld** via Fernet (`SETTINGS_ENCRYPTION_KEY`), met fail-open-gedrag bij ontbrekende key voor legacy plaintext-waarden. Dekt bedrijfsgegevens, logo (base64-in-Setting), transportprijstabellen (tot 50 aangepaste PAL-maten!), betaalinstellingen (provider-keuze, Mollie-mode/key gemaskeerd in API-responses), statusiconen, e-mail/SMTP, QZ Tray-certificaten, rolpermissies.

## 15. Audit/logging — **D**

`AuditLog` (generieke actielog: user/action/entity/request-context/IP/user-agent/`metadata_json`), met een tweede, gestructureerde laag erbovenop (`log_event()`, versioned JSON-envelope `event.v1`) — vandaag alleen gebruikt voor printgebeurtenissen, niet overal. Quote-historie is in feite **drievoudig gedekt**: `AuditLog` (generiek), `QuoteVersion` (volledige contentsnapshot), `CustomerActivity` (leesbare tijdlijn-entry) — drie overlappende maar losse mechanismen. Applicatielogging verder via Python stdlib naar stdout/Gunicorn/`fly logs`; **geen externe logaggregatie/APM** (geen Sentry) — zelf gemarkeerd als openstaand risico.

## 16. Dashboard — **A met zware C-inhoud**

`/offerte`-route: statistieken (open/factuur-verzonden draft orders, betaald/openstaand bij echte orders), en een **Kanban-achtig statusbord** gegroepeerd op de custom `status_bestelling`-metafield, samengevoegd met Van Eijk transport-jobstatus én Pallet Yard-koppelstatus, plus vier print/transport-statusvlaggen per order. Dit dashboard is zelf het bewijs dat Sales- en Operations-verantwoordelijkheden vandaag in één scherm versmolten zijn.

## 17. Statussen — **A/C-split, géén unified state machine**

Belangrijke bevinding: `Quote.status` heeft een modelcommentaar dat een nette flow claimt (`draft→saved→synced_draft_order→invoiced→converted_to_order→archived`), maar in de praktijk worden **alleen** `'draft'` en `'archived'` (bij legacy-import) daadwerkelijk gezet — geen enkel codepad transitioneert via de tussenliggende statussen. Het echte "is dit al een Shopify-order geworden"-signaal loopt via het al-dan-niet-gevuld-zijn van `shopify_draft_order_id`/`shopify_order_id`, niet via dit statusveld. Behandel het modelcommentaar als aspirationeel, niet als afgedwongen enum (**E**).

Status leeft in werkelijkheid op minstens **vijf onafhankelijke plekken**: `Quote.status` (grotendeels ongebruikt), Shopify's eigen Draft Order-status, de custom order-metafield `status_bestelling` (vrije, admin-uitbreidbare lijst), `MolliePayment.status`, `TransportJob.status`, `WarehouseFulfillmentLink.status` — gestikt aan elkaar alleen via de gedeelde `shopify_order_id`, niet via een gedeelde status-enum.

## 18. Leverdata — **C**

Drie onafhankelijke mechanismen, bevestigt dat Van Eijk en Hoefnagels geen datamodel delen: Shopify order-metafield `custom.gewenste_leverdatum` (algemeen "klant wil het voor X"-veld, dashboard-badge), `TransportJob.delivery_date/delivery_time_from/to` (Van Eijk-specifieke planning), `Quote.hoefnagels_delivery_date/hoefnagels_planned_at` (Hoefnagels-specifiek).

## 19. Deployment

Dockerfile: `python:3.12-slim`, Gunicorn (`--workers 2 --timeout 120 --preload`). `fly.toml`: app `offerteapp`, regio `ams` — **bevestigt exact** de eerder gevonden Fly-app. `release_command = flask db upgrade`. Confirmerend: `offerteapp-db` als Fly Postgres-naam.

**Env-varnamen (alle bevestigd, plus twee correcties op de eerdere Fly-secrets-only inventarisatie)**: Core Flask (`FLASK_ENV`, `SECRET_KEY`, `HOST`, `PORT`), `DATABASE_URL`, `SESSION_COOKIE_SECURE`, Shopify OAuth (`SHOPIFY_CLIENT_ID`/`SHOPIFY_CLIENT_SECRET`), Shopify default-store fallback (`SHOPIFY_SHOP_DOMAIN_DEFAULT`/`SHOPIFY_ACCESS_TOKEN_DEFAULT` + `_<KEY>`-patroon — **niet eerder gezien in de Fly-secrets-lijst**), `SHOPIFY_PRODUCT_CREATE_DEBUG`, `STORE_WEBSITE_URL`, spraak-naar-offerte (`VOICE_QUOTE_ENABLED`, `OPENAI_API_KEY` — lijkt ongebruikt/niet afgemaakt), Pallet Yard (`PALLET_YARD_BASE_URL`/`PALLET_YARD_INTEGRATION_KEY`), Transport-S4U (`ENABLE_TRANSPORT_IN_OFFERTES`/`TRANSPORT_APP_BASE_URL`/`TRANSPORT_INTERNAL_API_TOKEN`), `SETTINGS_ENCRYPTION_KEY`.

**Belangrijke nuance voor het platform-ontwerp**: deze app heeft **twee gescheiden secret-opslag-niveaus** — Fly secrets (deployment/infra) én DB `Setting` (business/integratie, versleuteld, door een admin runtime aanpasbaar zonder redeploy: `mollie_api_key`, `mollie_webhook_secret`, `smtp_password`, `qz_tray_private_key`, en optioneel `transport_internal_api_token`). Die laatste categorie was **niet zichtbaar** in de eerdere Fly-secrets-only inventarisatie en moet worden meegenomen als deze app ooit input geeft aan een Shared Core secrets-strategie.

## 20. Status/maturity

Volwassen, actief onderhouden, in productie (v455, "gezond"). Rijke, gedisciplineerde documentatiecultuur, inclusief een expliciet gedocumenteerd werkproces (research → plan → bouwen na goedkeuring → testen → tonen → goedkeuring → committen → goedkeuring → deployen → productie-verificatie) met de harde regel dat echte Shopify/Mollie-muterende acties altijd door een mens in de browser gebeuren, nooit gesimuleerd. Losse eenmalige debug-/fix-scripts in de repo-root (`_check_env.py`, `_fix_alt_shipping.py`, etc.) — kleine housekeeping-schuld, niet architecturaal significant.

Zelf-gedocumenteerde technische schuld: geen JS-testframework; twee parallelle productzoek-implementaties handmatig gesynchroniseerd; kortingslogica bewust 5× gedupliceerd; Van Eijk/Hoefnagels delen geen datamodel; ~37 verweesde draft orders en oudere quote-version-conflicten bewust uitgesteld; geen rate limiting op login; geen APM/error-tracking; attachments-feature niet geïmplementeerd.

## 21. KRITIEK — hoe komt een offerteaanvraag van s4u-quote-app hier terecht?

**Het gebeurt niet. Er bestaat nergens in deze codebase een geautomatiseerd intake-mechanisme vanuit s4u-quote-app (of enige andere storefront-app).**

Uitputtend gecontroleerd: een repo-brede zoekopdracht naar "s4u" levert alleen ongerelateerde treffers op (shop-domeinvoorbeelden, een hardcoded logo-URL, en de `TRANSPORT_APP_BASE_URL=transport-s4u.fly.dev`-default — dat is de Van Eijk-transportapp, geen offerte-bron). Elke geregistreerde Flask-route vereist ofwel een ingelogde staff-sessie, ofwel is een van precies drie smal-gescoopte, CSRF-vrijgestelde publieke endpoints: Mollie-webhook (alleen betaalstatus), Pallet Yard-callback (alleen warehouse-status), en Shopify's eigen OAuth-callback — geen van drieën verwerkt iets dat op een klant-offerteaanvraag lijkt.

Het enige mechanisme dat `Quote`-rijen aanmaakt buiten de interactieve staff-UI om is `flask import-legacy-quotes` — een **handmatig, door een operator gestart, offline JSON-bestandsimport-commando** voor historische migratie (elke geïmporteerde offerte krijgt forceerd `status='archived'`) — expliciet backfill, geen live integratie.

**Conclusie, direct te combineren met de conclusie in [11-QUOTE-APP-DEEP-DIVE.md](11-QUOTE-APP-DEEP-DIVE.md)**: beide apps bevestigen onafhankelijk van elkaar, vanuit hun eigen code én eigen documentatie, dat er **geen geautomatiseerde koppeling bestaat**. Elke offerte in OfferteApp wordt vandaag door een ingelogde medewerker met de hand aangemaakt via het bezoekrapport-scherm — te beginnen met live zoeken in Shopify-producten/klanten. Als de aanname was dat s4u-quote-app-aanvragen automatisch in OfferteApp belanden, is die aanname **onjuist**. Zie [13-END-TO-END-DATAFLOW.md](13-END-TO-END-DATAFLOW.md) voor de volledige gereconstrueerde werkelijkheid.
