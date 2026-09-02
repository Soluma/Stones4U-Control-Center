# 06 — Voorstel domeingrenzen

> **UPDATE 2026-09-01**: dit rapport is geschreven vóór OfferteApp en s4u-quote-app onderzocht konden worden, en gaat er daardoor nog van uit dat "Quotes" een enkelvoudig, ongeïdentificeerd domein is. Het is **vervangen** door [16-PLATFORM-BOUNDARIES.md](16-PLATFORM-BOUNDARIES.md), dat vaststelt dat Quotes vandaag twee complementaire (niet concurrerende) eigenaren heeft — s4u-quote-app voor storefront-intake, OfferteApp voor interne verwerking — zonder geautomatiseerde koppeling ertussen. De onderstaande inhoud blijft staan als historisch record.

Dit voorstel gaat uit van het model in de opdracht (Core / Quotes / CRM / Operations / Service / POS), aangepast op basis van wat daadwerkelijk is aangetroffen. Niets hiervan is geïmplementeerd — dit is een voorstel ter bespreking.

## Core

Aangetroffen bouwstenen die hier passen: de Shopify OAuth/GraphQL-clientlaag, de shop-identity safety-guard, en (zodra onderzocht) het interne server-to-server API-integratiepatroon dat `offerteapp`↔`pallet-yard`↔`transport-s4u` al gebruikt. **Geen enkele lokaal onderzochte app heeft vandaag een eigen Customer-identiteit** — Shopify is voor iedereen de bron van waarheid voor klanten. Een Core "Customer identity"-concept zou dus voor het eerst een lokale klant-identiteit introduceren; dat moet bewust en met aandacht voor `customer-history-db` gebeuren (zie hieronder), niet als bijproduct.

Users/Authentication: POS heeft een werkend, redelijk eenvoudig auth-model (argon2 + DB-sessions + 3 rollen, geen fijnmazige permissies) dat **technisch bruikbaar lijkt** als basis voor gedeelde platform-authenticatie — maar "locatie" gebruikt een totaal ander model (gedeeld wachtwoord, geen accounts), en van de Fly-only apps is niets bekend. Centraliseren nu zou POS' auth herschrijven zonder zicht op wat de andere apps nodig hebben.

## Quotes — status: geblokkeerd totdat opgehelderd

De opdracht gaat uit van "de bestaande offerte-app", maar er zijn **twee kandidaten** (`offerteapp`, `s4u-quote-app`) zonder lokale broncode, dus zonder zicht op functionaliteit, datamodel of maturiteit. **Een Quotes bounded context kan pas ontworpen worden nadat is vastgesteld welke app (of beide) de bron van waarheid is.** Forceer dit domein nu niet in een ontwerp — dat zou giswerk zijn.

## CRM

De opdracht verwacht hier Notes/Timeline/Interactions/Tags/Tasks/Agreements — geen van deze bestaat vandaag lokaal. Wél bestaat er al een **customer-history-db**, gekoppeld aan het telefoniesysteem (`telefoon-api`) — dit is vermoedelijk een vroege, smalle vorm van precies het "Customer timeline/Interactions"-concept uit de opdracht. Aanbeveling: onderzoek dit systeem eerst (zie 08-ACCESS-GAPS.md) voordat het CRM zijn eigen interactie-tijdlijn from scratch bouwt — mogelijk kan het CRM hierop voortbouwen of ernaast bestaan met een duidelijke datastroom, in plaats van een parallelle, concurrerende bron te worden.

## Operations

De opdracht verwacht hier Purchase Orders/Production Jobs/Pickup/Deliveries. Er bestaan al **twee live systemen** die hier logisch in vallen: `transport-s4u` (levering, koppelt met een externe leverancier-API) en de pallet-yard/locatie-lijn (materiaal-locatie op het terrein). **Een nieuw Operations-domein moet deze systemen integreren, niet vervangen** — `transport-s4u` is actief in productie en heeft al een werkende leverancier-koppeling die niet lichtzinnig herbouwd moet worden.

## Service

Geen enkel aangetroffen systeem dekt Complaints/Cases/Photos/Resolutions. Dit lijkt een oprecht nieuw domein zonder bestaande code om mee te consolideren of rekening mee te houden — het model uit de opdracht kan hier grotendeels ongewijzigd worden aangehouden.

## POS

Volledig gedekt door het bestaande `source2pos`-systeem — Cart/Payments/Receipts/Terminal/Cash register/Daily closing bestaan allemaal al, met een hardware-geteste CCV-pinintegratie. Dit domein hoeft niet opnieuw ontworpen te worden; de vraag is uitsluitend hoe het later, gecontroleerd, aan een gedeelde Core kan koppelen (bijv. gedeelde auth, gedeelde audit-logging) zonder de productie-kritieke betaalflow te verstoren.

## Niet in het opdracht-model, wel aangetroffen — nader te positioneren

- **Telefonie** (`telefoon-api`/`web`/`ami-worker`) — raakt zowel CRM (klanthistorie) als mogelijk Service (klachten via telefoon). Positionering vereist eerst broncode-onderzoek.
- **Product-/catalogustools** (Stones4U-Catalog-SEO, `s4u-import-app`, `maten-en-meters(-s4u)`, `productcards`, `stones4u-calculator`) — vallen buiten het voorgestelde model; vermoedelijk horen deze bij een toekomstig "Product identity"-concept binnen Core, maar zonder broncode van de Fly-only apps is dit een aanname.
