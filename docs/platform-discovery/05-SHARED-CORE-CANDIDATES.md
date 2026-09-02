# 05 — Shared Core kandidaten

> **UPDATE 2026-09-01**: dit rapport is geschreven vóór OfferteApp en s4u-quote-app onderzocht konden worden. Het is nu grotendeels **vervangen** door [14-SHARED-CORE-DESIGN.md](14-SHARED-CORE-DESIGN.md), dat dezelfde classificatiemethode toepast maar met bevestigde data over alle drie de nu onderzochte apps (inclusief een vierde Shopify-authenticatiepatroon en de bevestiging dat OfferteApp geen shop-identity-guard/write-kill-switch heeft, in tegenstelling tot wat hier nog niet bekend kon zijn). De onderstaande inhoud blijft staan als historisch record van de eerste discovery-ronde.

Classificatie: **A** = duidelijk app-specifiek, **B** = kandidaat voor Shared Core, **C** = onduidelijk/nader onderzoek nodig. Niets is gewijzigd — dit is uitsluitend een classificatie op basis van wat is aangetroffen.

## B — Duidelijke Shared Core-kandidaten

### 1. Shopify GraphQL-clientlaag (fetch-wrapper, foutafhandeling, response-envelope)
Onafhankelijk, bijna identiek herbouwd in POS (`src/lib/shopify.ts`) en Stones4U-Catalog-SEO (`src/shopify/graphql.ts`). Beide: `POST .../admin/api/{versie}/graphql.json`, token in `X-Shopify-Access-Token`, dezelfde foutafhandelingsstructuur. Zuivere transportlaag, geen business-logica — laag risico om te consolideren.

### 2. OAuth client-credentials token-cache
In-memory cache + expiry-marge + in-flight de-duplicatie, apart geïmplementeerd in dezelfde twee apps. Zelfde patroon, zelfde env-varnamen (`SHOPIFY_CLIENT_ID`/`SHOPIFY_CLIENT_SECRET`). Vermoedelijk ook gebruikt door `offerteapp` (zelfde secret-namen, broncode niet bevestigd).

### 3. Shop-identity safety-guard
Live `shop { myshopifyDomain }`-check vóór elke schrijfactie, in beide apps aanwezig met verschillende implementatie maar identieke intentie (voorkom dat een dev-run per ongeluk tegen productie schrijft). Een gedeelde, geteste implementatie van dit patroon zou toekomstige write-capable modules (CRM, Operations) direct veiliger maken vanaf dag één.

### 4. Interne server-to-server API-integratiepatroon (offerteapp ↔ pallet-yard ↔ transport-s4u)
Al **werkend in productie**: `offerteapp` roept `pallet-yard` aan via `PALLET_YARD_BASE_URL`/`PALLET_YARD_INTEGRATION_KEY`, en `transport-s4u` via `TRANSPORT_APP_BASE_URL`/`TRANSPORT_INTERNAL_API_TOKEN` — met een **gedeeld bearer-secret** tussen `offerteapp` en `transport-s4u` (identieke secret-digest bevestigd via `fly secrets list`). Dit is een reëel precedent voor hoe Shared Core-API's tussen modules kunnen werken — eerder een patroon om van te léren dan iets nieuw te ontwerpen. Broncode van geen van beide apps is beschikbaar, dus het exacte contract (REST? welke payloads?) is onbekend.

### 5. Klant-interactiehistorie (customer-history-db + telefoon-api)
Een database die vermoedelijk al klant-interactiedata bevat, gekoppeld aan het telefoniesysteem. Overlapt direct met de geplande CRM-domeinen "Customer timeline" en "Interactions". **Voordat het CRM zijn eigen interactie-tijdlijn ontwerpt, moet dit systeem eerst onderzocht worden** — mogelijk is het (deels) herbruikbaar in plaats van te dupliceren.

### 6. Audit-logging patroon
POS heeft een Prisma `AuditLog`-model (append-only, DB-backed); Stones4U-Catalog-SEO heeft een functioneel vergelijkbaar maar technisch incompatibel patroon (timestamped JSON-bestanden in `audit-logs/`). Zelfde intentie ("bewijs wat er precies veranderd is en wanneer"), twee implementaties. Een gedeelde audit-log-service/library zou beide vervangen en direct bruikbaar zijn voor CRM/Operations.

## C — Onduidelijk, nader onderzoek nodig

### 7. Shopify-embedded-app-familie
`s4u-quote-app`, `maten-en-meters`, `maten-en-meters-s4u`, `productcards`, `stones4u-calculator`, `s4u-import-app`, `transport-s4u` delen allemaal hetzelfde env-varpatroon (`SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET`/`SCOPES`/`SHOPIFY_APP_URL`), wat wijst op een gedeelde scaffolding-oorsprong (Shopify CLI/Remix-template). Of er ook daadwerkelijk gedeelde code bestaat kan **niet bevestigd worden zonder broncode** — dit is een vermoeden op basis van secret-namen, geen bevestigde duplicatie.

### 8. Offerte/quote-domein zelf
Twee apps (`offerteapp`, `s4u-quote-app`) claimen mogelijk hetzelfde domein. Voordat er over Shared Core voor "Quotes" wordt nagedacht, moet eerst worden vastgesteld welke van de twee (of beide) daadwerkelijk in gebruik is.

## A — Duidelijk app-specifiek

- POS-specifieke concepten: kassa/terminal-beheer, dagafsluiting (`DailyClosing`), CCV-pinintegratie (OPI-NL-protocol), retourbon-afdruk — dit zijn balie-specifieke workflows, geen generieke platformfunctionaliteit.
- "Locatie"'s Konva-canvas/yard-visualisatie — specifiek voor het visueel plaatsen van pallets op een 2D-kaart, geen herbruikbaar patroon voor andere modules.
- Stones4U-Catalog-SEO's campagnegerichte SEO-auditscripts (zwembadranden/graniet-specifiek) — eenmalig, projectgebonden gereedschap.

## Nog niet geclassificeerd (geen bron)

Formatting/currency/BTW-berekening, validatie, file storage-abstracties, UI-componenten: geen van de Fly-only apps kon hierop worden geïnspecteerd. POS heeft eigen `pricing.ts` (incl. een niet-triviale "largest remainder"-kortingsverdeling over regels) — of dit generiek genoeg is voor Shared Core kan pas beoordeeld worden zodra ook het offerte-domein (met eigen prijsberekening/BTW-logica) bekend is.
