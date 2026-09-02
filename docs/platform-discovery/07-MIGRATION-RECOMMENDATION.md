# 07 — Migratieadvies (evolutionair, geen big bang)

> **UPDATE 2026-09-01**: punt 1 hieronder ("ophelderen offerte-app-ambiguïteit") is inmiddels **opgehelderd** — OfferteApp en s4u-quote-app zijn geen concurrenten maar complementaire systemen zonder onderlinge koppeling (zie [13-END-TO-END-DATAFLOW.md](13-END-TO-END-DATAFLOW.md)). Een concrete, gefaseerde bouwvolgorde die hierop voortbouwt staat nu in [18-RECOMMENDED-BUILD-SEQUENCE.md](18-RECOMMENDED-BUILD-SEQUENCE.md) — lees dat rapport voor de actuele aanbeveling; dit rapport blijft staan voor de onderliggende evolutionaire principes, die nog steeds gelden.

Conform de opdracht: geen herschrijving vanaf nul, bestaande systemen blijven functioneel tijdens de ontwikkeling van CRM/platform.

## Voorgestelde volgorde

1. **Ophelderen offerte-app-ambiguïteit (met de gebruiker, niet technisch op te lossen).** `offerteapp` en `s4u-quote-app` zijn beide live; zonder te weten welke daadwerkelijk in gebruik is bij de business, kan geen enkel Quotes-gerelateerd ontwerp of Shared Core-werk verantwoord starten. Dit moet letterlijk de eerste stap zijn — alles daarna hangt hiervan af.
2. **Broncode-toegang regelen** voor de systemen zonder lokale bron die het meest relevant zijn voor het platform: de gekozen offerte-app, `customer-history-db`/`telefoon-api` (CRM-overlap), `transport-s4u` en `pallet-yard` (Operations-overlap).
3. **Shared Core ontwerpen** op basis van wat dan bekend is — te beginnen met de laagrisico-kandidaten die al tweemaal onafhankelijk zijn gebouwd (Shopify GraphQL-client, token-cache, shop-identity guard; zie 05-SHARED-CORE-CANDIDATES.md), zonder de bestaande apps meteen te verplichten hierop over te stappen.
4. **Nieuw CRM bouwen** als eigen module, met een eigen Customer-identiteit die bewust rekening houdt met `customer-history-db` (mogelijk hergebruiken/koppelen in plaats van dupliceren).
5. **Integraties gecontroleerd centraliseren** — het bestaande `offerteapp ↔ pallet-yard ↔ transport-s4u`-integratiepatroon (gedeelde bearer-tokens tussen apps) is een bruikbaar precedent; een toekomstige gedeelde interne-API-laag kan hierop voortbouwen in plaats van het te vervangen.
6. **Bestaande apps geleidelijk aansluiten** — te beginnen met POS, dat het meest volwassen en best gedocumenteerd is, maar ook het meest productie-kritiek (hardware-geteste betalingen). Elke aansluiting hier vereist expliciete, voorzichtige planning.
7. **Pas later eventueel naar monorepo migreren** — geen enkele aangetroffen app deelt vandaag code via een monorepo/workspace; dit is een losstaande, latere beslissing.

## Wat absoluut niet nu gemigreerd of aangeraakt moet worden

- **POS (`source2pos`)** — productie-systeem met een hardware-geteste CCV A920-pinbetaalflow. Regressie hier raakt de kassa aan de toonbank.
- **`offerteapp`** — laatst gedeployed 2026-08-26 (dagen oud), overduidelijk actief in gebruik.
- **De `offerteapp`↔`transport-s4u`↔`pallet-yard`-integratie** — werkt vandaag in productie via gedeelde secrets; wijzigen zonder eerst de broncode van alle drie te kennen is risicovol.
- **`transport-s4u`'s leverancier-koppeling** (`SUPPLIER_API_KEY`/`URL`) — een externe partij-integratie; onbekende impact van wijzigingen zonder broncode-inzage.

## Afhankelijkheden en risico's

- Het grootste risico is **niet technisch maar informationeel**: zonder de broncode van de offerte-app(s), telefonie en transport is elk verder ontwerp giswerk. De volgorde hierboven is daarom bewust "toegang eerst, ontwerp daarna".
- `locatie` (Voorraad Viewer) documenteert zichzelf als "v1.0 Released" maar is nooit gedeployed — als dit systeem alsnog relevant is voor Operations, moet eerst worden vastgesteld of de bedoeling was om het te deployen, of dat `pallet-yard` (het oudere, wél gedeployde prototype) inmiddels de facto de gebruikte versie is.
- Er is geen bewijs dat de user/auth-systemen van de verschillende apps compatibel te centraliseren zijn zonder herschrijving — dit vergroot de scope van een toekomstige Core-authenticatiestap aanzienlijk zodra de Fly-only apps in beeld komen.
