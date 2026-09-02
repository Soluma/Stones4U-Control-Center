# 17 — Voorstel: AI/Claude-instructiestructuur per module

Dit is een **voorstel**, nog niet geschreven als daadwerkelijke `CLAUDE.md`-bestanden. Doel: een AI-agent kan later aan één module werken zonder per ongeluk door het hele Stones4U-platform te refactoren, en zonder aannames te maken over systemen die het niet zou moeten wijzigen.

Gebaseerd op de werkelijke bevindingen: vijf aparte repositories vandaag (`CRM`, `OfferteApp`, `s4u-quote-app`, `Kassa Systeem`, `TelefoonSysteem`), geen monorepo, geen gedeelde packages. De structuur hieronder is ontworpen om **nu al bruikbaar te zijn per losse repo**, en pas te verhuizen naar een `/packages/*`-vorm als er ooit een monorepo komt (niet iets wat deze opdracht voorstelt te doen).

> **ARCHITECTUURWIJZIGING 2026-09-01**: er is nu een concreet target voor de `modules/`/`packages/`-structuur vastgesteld — zie [24-UNIFIED-CONTROL-CENTER-TARGET.md](24-UNIFIED-CONTROL-CENTER-TARGET.md) §"Technische architectuur". Belangrijk verschil met het voorstel hieronder: die `modules/`/`packages/`-indeling leeft **uitsluitend binnen de nieuwe, losstaande Control Center-repository** — niet als een monorepo die OfferteApp/s4u-quote-app/TelefoonSysteem/POS samenvoegt. De `apps/crm`-, `apps/quotes`-, `apps/pos`-voorstellen hieronder blijven verder inhoudelijk geldig als beschrijving van eigenaarschap/grenzen per bestaande repo; lees ze naast (niet in plaats van) `24`'s concrete structuur voor de nieuwe Control Center-codebase zelf.

## Root: `CRM/CLAUDE.md` (platform-niveau, in de nieuwe workspace)

- **Eigenaar van**: niets in andere repo's. Dit bestand beschrijft alleen de spelregels voor werk *binnen* de CRM-workspace.
- **Read-only voor**: `docs/platform-discovery/` in deze repo mag gelezen worden als context door elke toekomstige CRM-module, maar mag niet zomaar herschreven worden zodra er echte CRM-code bestaat — discovery-documenten zijn een historisch record, geen levende spec.
- **Mag nooit zelf implementeren**: wijzigingen aan `OfferteApp`, `s4u-quote-app`, of `Kassa Systeem` se broncode. Deze drie repo's zijn, vanuit de CRM-workspace gezien, **altijd read-only referentiemateriaal**, tenzij een mens expliciet een cross-repo-taak geeft.
- **Gedeelde interfaces**: nog geen — dit bestand documenteert vooral wat nog niet gedeeld is en dus voorzichtig behandeld moet worden.

## `apps/crm/CLAUDE.md` (het nieuwe CRM zelf, zodra het gebouwd wordt)

- **Eigenaar van**: Customer 360, klanttijdlijn/interacties, notities, taken, klantafspraken, complaints/service (zie [15-CRM-GAP-ANALYSIS.md](15-CRM-GAP-ANALYSIS.md)), en het universele-zoek-scherm.
- **Read-only op**: Shopify-data (via de Core Shopify-client, nooit een eigen client bouwen), en — zodra gekoppeld — offerte-data uit OfferteApp/s4u-quote-app (lezen, nooit een offerte-status vanuit CRM direct in hun database wijzigen; wijzigingen lopen via hun eigen API's).
- **Mag nooit zelf implementeren**: een eigen Shopify-client, een eigen offerte-rekenmotor (BTW/kortingslogica hoort bij Quotes), een eigen betaalintegratie (Mollie hoort bij Quotes), een eigen kassa-/POS-logica.
- **Verplichte gedeelde interfaces (zodra die bestaan)**: Core Shopify-client, Core Audit-service, Core User/Auth (indien geconsolideerd), Core Files-service voor foto's/tekeningen/documenten.

## `apps/quotes/CLAUDE.md` — let op: dit domein heeft vandaag twee code-eigenaren

Omdat Quotes vandaag uit twee gescheiden systemen bestaat, stelt dit rapport voor **twee aparte instructiebestanden** te behouden totdat (indien ooit) een bewuste consolidatie plaatsvindt:

### `OfferteApp/CLAUDE.md` (bestaat al, zie hieronder — dit is een aanvulling, geen vervanging)
- **Eigenaar van**: offerte-opbouw, prijzen/kortingen/BTW, Shopify draft-order/order-conversie voor offertes, Mollie-betalingen, pikbon/pakbon/labels, Pallet Yard- en Transport-S4U-integratie, bezoekrapporten.
- **Read-only op**: Shopify-productcatalogus (leest live, muteert alleen producten via de expliciete "maak nieuw product"-flow), s4u-quote-app-data (vandaag: geen toegang — als een koppeling gebouwd wordt, expliciet als read-only inbound integratie behandelen, niet als gedeelde database).
- **Mag nooit zelf implementeren**: kassafunctionaliteit, CRM-taken/-afspraken, service/klachtenbeheer.

### `s4u-quote-app/CLAUDE.md` (bestaat nog niet, voorstel)
- **Eigenaar van**: storefront-offerteaanvraag-intake (Theme App Extension, App Proxy), aanvraag-opslag, upsell-regels, merchant-notificatiemail.
- **Read-only op**: Shopify-productcatalogus (voor prijs-hervalidatie).
- **Mag nooit zelf implementeren**: offerte-prijsopbouw/kortingen/BTW voorbij eenvoudige doorgeef-prijzen, betaalintegraties, warehouse/transport-logica — dat hoort allemaal bij OfferteApp, niet hier.
- **Verplichte gedeelde interface, zodra gebouwd**: een geformaliseerde "nieuwe offerteaanvraag"-integratie naar OfferteApp (zie [18-RECOMMENDED-BUILD-SEQUENCE.md](18-RECOMMENDED-BUILD-SEQUENCE.md)) — tot die tijd blijft dit een volledig zelfstandige app.

## `apps/pos/CLAUDE.md` (Kassa Systeem — bestaat al als CLAUDE.md/AGENTS.md in die repo)

- **Eigenaar van**: toonbankverkoop, kassageld/dagafsluiting, CCV-pinbetaling, kassabonnen, retouren aan de balie.
- **Read-only op**: Shopify-productcatalogus en -klanten.
- **Mag nooit zelf implementeren**: offerte-logica, CRM-functionaliteit, warehouse/transport-integraties — POS blijft bewust een zelfstandig, smal domein.
- Dit bestand bestaat al in de praktijk (`Kassa Systeem/CLAUDE.md`) en toont hoe strak zo'n instructiebestand kan zijn — een goed voorbeeld voor de andere modules om van te leren qua toon en striktheid (expliciete regels rond productie-mutaties, verplichte guard-checks vóór elke Shopify-schrijfactie).

## `TelefoonSysteem/CLAUDE.md` (bestaat nog niet, voorstel — nieuw na dit onderzoek)

- **Eigenaar van**: PBX/AMI-integratie, gespreksroutering en -correlatie, `Contact`/`Call`/`CallNote`/`ContactNote`/`Task`-data, de Windows-popup, de read-only Exact-historie-proxy.
- **Read-only op**: Shopify-productcatalogus is niet relevant; Shopify-klanten wordt wél **geschreven** (customer-create) — dit moet in het instructiebestand expliciet als bestaande, bewuste bevoegdheid worden vastgelegd, niet als iets dat een AI-agent zelf zou mogen uitbreiden.
- **Mag nooit zelf implementeren**: offerte-logica, CRM-taken/-notities als *vervanging* van het eigen Task/Note-systeem (andere modules lézen dit systeem, TelefoonSysteem bouwt zelf geen CRM-schermen), kassafunctionaliteit.
- **Verplichte gedeelde interface, zodra gebouwd**: een echte service-tot-service-auth voor CRM-toegang (in plaats van het tijdelijke `VIEWER`-serviceaccount uit [23-CRM-PHASE-1-FINAL-RECOMMENDATION.md](23-CRM-PHASE-1-FINAL-RECOMMENDATION.md)) — een uitbreiding van het bestaande `INTERNAL_SECRET`-patroon.
- **Bekende, met de hand te repareren gebreken die een toekomstige agent aan dit systeem NIET stilzwijgend zou moeten "oplossen" zonder expliciete opdracht**: de inconsistente telefoonnormalisatie tussen `/contacts/ensure` en de AMI-worker se exacte-match-lookup (zie [22-CUSTOMER-IDENTITY-STRATEGY.md](22-CUSTOMER-IDENTITY-STRATEGY.md)) — dit is precies het soort "voor de hand liggende bugfix" die buiten een expliciete opdracht om vermeden moet worden, omdat het productiegedrag van een live telefoniesysteem raakt.

## `apps/operations/CLAUDE.md` (nog te bouwen)

- **Eigenaar van**: purchase orders, productieopdrachten, materiaal-naar-leverancier, en — op termijn — een genormaliseerd leverplanningsmodel dat zowel het Van Eijk- als het Hoefnagels-pad kan bedienen (zie [16-PLATFORM-BOUNDARIES.md](16-PLATFORM-BOUNDARIES.md)).
- **Read-only op**: Shopify Order-data, OfferteApp's transport-/warehouse-koppelstatus (totdat eventueel overgedragen).
- **Mag nooit zelf implementeren**: offerte-prijslogica, CRM-klantdossiers, kassafunctionaliteit.
- **Verplichte gedeelde interface**: het al-bewezen `x-integration-key`/bearer-token-patroon (zie 14-SHARED-CORE-DESIGN.md), geformaliseerd als Core internal-service-auth.

## `packages/shopify/CLAUDE.md` (nog te bouwen — het eerste concrete Shared Core-pakket)

- **Eigenaar van**: token-acquisitie/cache, GraphQL-transport, shop-identity-verificatie, write-guards, product/order-snapshot-types (zie [14-SHARED-CORE-DESIGN.md](14-SHARED-CORE-DESIGN.md), de A/B-geclassificeerde onderdelen).
- **Read-only op**: niets — dit is een pure library, geen eigen data.
- **Mag nooit zelf implementeren**: business-logica van welke module dan ook (geen offerte-berekening, geen kassa-logica, geen CRM-regels) — alleen generieke Shopify-toegang.
- Bestaande apps (POS, OfferteApp, s4u-quote-app) **adopteren dit pakket vrijwillig en op eigen tempo** — dit bestand mag nooit code in die repo's wijzigen om ze te forceren over te stappen.

## `packages/db/CLAUDE.md` (nog te bouwen, alleen indien/wanneer relevant)

- Vandaag heeft geen enkele app een gedeelde database — dit pakket zou hooguit gedeelde types/migraties-conventies kunnen bevatten, geen gedeelde runtime-database, tenzij daar later expliciet toe besloten wordt (buiten scope van deze discovery).

## `packages/ui/CLAUDE.md` (nog te bouwen)

- Geen enkele bestaande app deelt UI-componenten vandaag (POS: React/Next.js, OfferteApp: Jinja2/vanilla JS, s4u-quote-app: Remix/Polaris) — een gedeeld UI-pakket is pas zinvol voor **nieuwe** modules (CRM, Operations) die dezelfde stack kiezen; het is geen realistisch doel om bestaande apps' UI's te migreren.

## Algemeen principe voor elk instructiebestand

Elk `CLAUDE.md` hierboven moet minstens drie dingen expliciet maken, naar het voorbeeld van het al bestaande `Kassa Systeem/CLAUDE.md`:
1. Welke Shopify-schrijfacties wel/niet zijn toegestaan, en onder welke guard.
2. Welke andere modules/repo's alleen gelezen mogen worden, nooit gewijzigd.
3. Welke gedeelde Core-interfaces verplicht gebruikt moeten worden zodra ze bestaan, in plaats van een eigen variant te bouwen.
