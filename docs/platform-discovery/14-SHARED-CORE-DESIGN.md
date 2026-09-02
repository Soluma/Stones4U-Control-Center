# 14 — Shared Core: ontwerpvoorstel

Classificatie: **A** = direct sterke Shared Core kandidaat, **B** = waarschijnlijk Shared Core, **C** = voorlopig app-specifiek houden, **D** = nader onderzoek noodzakelijk.

> **ARCHITECTUURWIJZIGING 2026-09-01**: er is een expliciete richtingsbeslissing genomen — zie `docs/architecture/ADR-001` t/m `ADR-006` en [24-UNIFIED-CONTROL-CENTER-TARGET.md](24-UNIFIED-CONTROL-CENTER-TARGET.md). De classificaties hieronder blijven geldig als **analyse van bestaande code**, maar de strategische conclusie verandert op één belangrijk punt: "Shared Core" is niet langer primair een package die losse apps *optioneel* adopteren terwijl het CRM permanent via API's van bestaande apps afhankelijk blijft — het wordt de **interne fundamentlaag van het nieuwe Stones4U Control Center zelf** (de `packages/*` binnen de nieuwe Control Center-repository, zie `24`), met `User`/`CustomerProfile`/`Task`/`Note`/`AuditEvent` als eigen, centrale modellen (ADR-002, ADR-003) in plaats van permanente doorverwijzingen naar bijvoorbeeld TelefoonSysteem's Task-API. De classificaties A/B/C/D hieronder blijven het beste beschikbare bewijs voor *wat er al bestaat en hoe goed het is* — lees ze als input voor het nieuwe ontwerp, niet als "dit wordt letterlijk overgenomen."

**Uitgangspunt: geen big-bang migratie.** Elk onderdeel hieronder is ontworpen om **naast** de bestaande apps te kunnen bestaan — een nieuwe, gedeelde implementatie die apps één voor één, vrijwillig en op hun eigen tempo kunnen adopteren, zonder dat een bestaande app ooit verplicht wordt in te schrijven om te blijven werken.

## Shopify-laag

### Authentication — **D, met een noodzakelijke voorafgaande keuze**
Vier levende patronen (client-credentials/POS, authorization-code-met-permanent-token/OfferteApp, embedded-app-OAuth/s4u-quote-app, **statisch admin-token/TelefoonSysteem — bevestigd met broncode, zie [22-CUSTOMER-IDENTITY-STRATEGY.md](22-CUSTOMER-IDENTITY-STRATEGY.md)**) kunnen niet zomaar samengevoegd worden — ze dienen deels verschillende doelen (POS/OfferteApp praten namens de eigen backend tegen één vaste store; s4u-quote-app is een installeerbare Shopify-app die in principe op elke shop kan draaien; TelefoonSysteem gebruikt het eenvoudigste, minst veilige patroon — precies wat de opdrachtgever voor nieuwe modules wil vermijden). **Voorstel**: Shared Core biedt een client die de twee productie-waardige strategieën als pluggable adapter ondersteunt (client-credentials én authorization-code-met-opgeslagen-token), niet één afgedwongen patroon, en behandelt het statische-token-patroon expliciet als **niet** de standaard voor nieuwe modules. De vraag welke strategie de "voorkeursstandaard" wordt voor nieuwe modules (CRM, Operations) moet apart met de gebruiker worden besloten — dit is bewust **D**, niet **A**, omdat het een architecturale keuze is, geen pure extractie van bestaande code.

> **UPDATE (na TelefoonSysteem-onderzoek)**: TelefoonSysteem is bovendien de **enige** onderzochte app die daadwerkelijk naar Shopify schrijft met dit statische-token-patroon (`customerCreate`-mutatie) — een reëel risico, aangezien een statisch token geen expiry/rotatie kent. Dit versterkt het advies om nieuwe modules nooit dit patroon te laten adopteren.

### Token acquisition/cache — **A**
POS' implementatie (in-memory cache, expiry-marge, in-flight de-duplicatie) is klein, goed getest, en direct herbruikbaar als de client-credentials-adapter. Geen wijziging aan POS nodig om dit te extraheren — puur kopiëren/generaliseren.

### GraphQL client (transport, foutafhandeling) — **A**
Alle drie apps implementeren vrijwel hetzelfde: POST naar `/admin/api/{versie}/graphql.json`, token in header, JSON-parse, foutcontrole. OfferteApp's retry-met-backoff is een verbetering die in de gedeelde versie meegenomen kan worden. Laag risico, hoge herbruikwaarde.

### API-versie — **B**
Vandaag drie verschillende versies in gebruik (`2026-07` POS, `2025-01` OfferteApp, onbekend/library-bepaald s4u-quote-app). Een Shared Core-client zou één centraal gepinde versie moeten hanteren voor **nieuwe** modules; bestaande apps hoeven niet mee te upgraden totdat zij zelf de gedeelde client adopteren.

### Retry/error handling — **A**
OfferteApp's 2-retry-met-lineaire-backoff is een strikt betere basis dan POS' geen-retry — combineren tot één gedeelde `ShopifyApiError`-achtige klasse plus retry-policy is laag risico.

### Shop identity verification — **A**
POS' live `shop.myshopifyDomain`-check vóór elke schrijfactie is de enige van de drie apps die dit heeft, en is precies het soort veiligheidsnet dat nieuwe modules vanaf dag één zouden moeten hebben. Direct herbruikbaar, geen aanpassing aan POS nodig.

### Write guards — **A**
POS' master-switch + featurevlaggen-patroon is beproefd en ontbreekt zowel in OfferteApp als (in dezelfde vorm) in s4u-quote-app. Een gedeelde write-guard-library zou nieuwe modules direct dit veiligheidsniveau geven.

## Platform-laag

### Customer identity — **D**
Geen enkele app heeft vandaag een eigen, gezaghebbende Customer-tabel — allemaal verwijzen naar Shopify, met eigen, onderling incompatibele cache-/snapshotstrategieën (POS: alleen snapshot; OfferteApp: cache + snapshot + activity-timeline; s4u-quote-app: alleen snapshot, geen cache; **TelefoonSysteem: telefoonnummer-gesleuteld `Contact`, geen Shopify-GID bewaard — zie [22-CUSTOMER-IDENTITY-STRATEGY.md](22-CUSTOMER-IDENTITY-STRATEGY.md)**). Een CRM dat zijn eigen Customer 360 wil bouwen, moet hier een bewuste keuze maken: wordt het CRM de eerste echte lokale Customer-master, of blijft Shopify dat en bouwt het CRM alleen een rijkere cache/timeline erbovenop? **Dit is de belangrijkste open architecturale vraag in dit hele onderzoek** — vandaar D, niet A/B, ondanks de duidelijke behoefte. **Update na TelefoonSysteem-onderzoek**: het besluit "Shopify blijft bron van waarheid, apps houden alleen een dunne lokale verwijzing" wordt door een vierde onafhankelijke app bevestigd, niet weersproken — zie 22 voor de volledige onderbouwing en de concrete verbeterpunten die het CRM moet toepassen (wél de GID bewaren, consistente telefoonnormalisatie, expliciete ambiguïteitsafhandeling).

### Product identity — **B**
Elke app doet zijn eigen variant-snapshot (titel/SKU/prijs/afbeelding op het moment van gebruik) — functioneel gelijk, technisch gescheiden. Een gedeeld "Shopify product/variant snapshot"-type (niet per se een database, gewoon een gedeeld TypeScript/Python-type + ophaal-functie) zou drie keer dezelfde logica vervangen.

### Shopify Order identity — **B**
Alle offerte-/order-gerelateerde apps volgen uiteindelijk `shopify_order_id`/`shopify_draft_order_id` als sleutel. Een gedeelde "Order reference"-abstractie (inclusief hoe je consistent van draft-order naar order navigeert) zou nuttig zijn zodra een CRM ook orders wil tonen — maar moet wachten tot bekend is hoe OfferteApp's en s4u-quote-app's draft orders zich tot elkaar verhouden (zie 13-END-TO-END-DATAFLOW.md).

### User/Auth — **B**
Zie [12-OFFERTEAPP-POS-OVERLAP.md](12-OFFERTEAPP-POS-OVERLAP.md): beide apps herbouwen login/sessie/rollen met verschillende technische keuzes. Sterke kandidaat, maar vereist eerst een bewuste keuze (argon2 vs. Werkzeug-hashing, DB-sessies vs. cookie-sessies, vast-3-rollen vs. granulair permissiesysteem — OfferteApp's granulaire model is functioneel rijker en een goed startpunt). Een nieuw CRM kan het beste **meteen** de gekozen gedeelde standaard gebruiken in plaats van een vierde variant te bouwen.

> **UPDATE (na TelefoonSysteem-onderzoek)**: TelefoonSysteem voegt een **derde** onafhankelijke wachtwoord-hashing-keuze toe (`bcryptjs`, naast POS' argon2 en OfferteApp's Werkzeug-hasher), en een **stateless JWT** zonder DB-sessietabel/revocatie/refresh (7 dagen geldig, rolwijzigingen pas effectief na herinloggen). Dit is nu het derde, weer andere auth-systeem in het landschap — het onderstreept dat "welke standaard wordt gekozen" (nog steeds D in Fase 0) belangrijker is dan ooit, en dat geen van de drie bestaande implementaties zomaar de winnaar zou moeten zijn zonder de zwaktes van de andere twee te dichten (POS mist granulaire permissies, OfferteApp mist DB-sessies/revocatie, TelefoonSysteem mist beide plus heeft een te lange, niet-intrekbare tokenlevensduur).

### Audit — **A**
Drie incompatibele implementaties met identieke intentie (POS' `AuditLog`, OfferteApp's drievoudige `AuditLog`+`QuoteVersion`+`CustomerActivity`, Catalog-SEO's JSON-bestanden). Een gedeelde, generieke audit-log-service (actie/entiteit/gebruiker/context, met optionele full-snapshot-variant zoals OfferteApp's `QuoteVersion` voor entiteiten die dat nodig hebben) is direct bruikbaar voor elke nieuwe module.

### Files — **D**
Geen enkele bestaande app heeft vandaag een werkende bestandsopslag-oplossing: POS slaat alleen een logo als base64-in-Postgres op, OfferteApp's `Attachment`-model is expliciet een niet-geïmplementeerde placeholder ("fase 2"), s4u-quote-app heeft niets. Dit is **geen extractie-kandidaat** (er is niets bruikbaars om te extraheren) maar wel een **noodzakelijk nieuw Shared Core-onderdeel** voor het CRM (foto's, tekeningen, documenten — zie sectie 9/10 van de oorspronkelijke opdracht en [15-CRM-GAP-ANALYSIS.md](15-CRM-GAP-ANALYSIS.md)). D omdat de technische keuze (Cloudflare R2, zoals de gebruiker voorstelt) nog niet tegen een concrete implementatie getoetst is.

### Notifications — **D**
Geen enkele app heeft een generiek notificatiesysteem — alleen ad-hoc, use-case-specifieke e-mail (OfferteApp's SMTP-client, s4u-quote-app's nodemailer-gebruik). Geen gedeelde in-app-notificatie/alert-laag bestaat. Nader onderzoek nodig naar wat het CRM-dashboard ("alerts", sectie 8 van de opdracht) precies nodig heeft voordat dit ontworpen kan worden.

### Internal service authentication — **B, met een werkend precedent**
OfferteApp's `x-integration-key`-patroon (Pallet Yard callback) en bearer-token-patroon (Transport-S4U) zijn **al bewezen, live werkende** voorbeelden van server-to-server-auth tussen Stones4U-apps. **TelefoonSysteem voegt een derde, onafhankelijk gebouwd voorbeeld toe**: een gedeeld `INTERNAL_SECRET` via een `x-internal-secret`-header, vergeleken met `crypto.timingSafeEqual` (ami-worker → api). Drie apps, drie keer hetzelfde idee, drie keer apart gebouwd — een Shared Core "internal API client/server"-library die dit patroon formaliseert (gedeeld secret of key-per-integratie, HMAC/bearer-verificatie, timing-safe compare) zou toekomstige CRM↔Operations- of CRM↔Quotes-integraties direct een beproefd fundament geven in plaats van een vierde ad-hoc variant. Zie ook [23-CRM-PHASE-1-FINAL-RECOMMENDATION.md](23-CRM-PHASE-1-FINAL-RECOMMENDATION.md) voor een concreet, tijdelijk alternatief (een `VIEWER`-serviceaccount) dat Fase 1 al bruikbaar maakt vooruitlopend op deze formalisatie.

## Samenvattend classificatie-overzicht

| Onderdeel | Classificatie |
|---|---|
| Token acquisition/cache | A |
| GraphQL client (transport/foutafhandeling) | A |
| Retry/error handling | A |
| Shop identity verification | A |
| Write guards | A |
| Audit | A |
| Product identity (snapshot-type) | B |
| Shopify Order identity | B |
| User/Auth | B |
| Internal service authentication | B |
| Authentication (welke strategie standaard wordt) | D |
| API-versie (welke wordt standaard) | B |
| Customer identity | D |
| Files | D |
| Notifications | D |
| Locations/Terminal (POS-specifiek) | C |
| Kassa/dagafsluiting/CCV-betaling (POS-specifiek) | C |
| Transport-pricing-tabellen, Hoefnagels-planning (OfferteApp-specifiek) | C |
| Theme App Extension/storefront-widget (s4u-quote-app-specifiek) | C |

## Evolutionair invoeringspad (geen big bang)

1. Bouw de **A-onderdelen** (token cache, GraphQL-client, retry, shop-identity-guard, write-guards, audit) als een nieuwe, losstaande package/module — zonder enige bestaande app aan te raken.
2. Het **nieuwe CRM** wordt de eerste consument van deze package — het bewijst de package werkt, zonder productierisico voor POS/OfferteApp/s4u-quote-app.
3. **B-onderdelen** worden pas ontworpen zodra de A-onderdelen in gebruik zijn en er een concrete tweede consument is (bijv. wanneer Operations-functionaliteit wordt gebouwd die ook Shopify Order-identity nodig heeft).
4. **D-onderdelen** vereisen eerst een expliciete beslissing met de gebruiker (Customer identity-strategie, Files-technologie, welke auth-strategie standaard wordt) voordat er code voor geschreven wordt.
5. Bestaande apps (POS, OfferteApp, s4u-quote-app) worden **nooit verplicht** om over te stappen — dat is een aparte, latere, per-app afweging (zie [07-MIGRATION-RECOMMENDATION.md](07-MIGRATION-RECOMMENDATION.md) en [18-RECOMMENDED-BUILD-SEQUENCE.md](18-RECOMMENDED-BUILD-SEQUENCE.md)).
