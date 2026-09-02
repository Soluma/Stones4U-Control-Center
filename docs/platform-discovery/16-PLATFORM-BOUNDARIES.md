# 16 — Domeingrenzen (bijgewerkt op basis van werkelijke code)

Dit vervangt/verfijnt [06-BOUNDARY-RECOMMENDATION.md](06-BOUNDARY-RECOMMENDATION.md) nu de broncode van OfferteApp en s4u-quote-app daadwerkelijk is onderzocht. De belangrijkste correctie op de eerdere aanname: **Quotes is geen enkelvoudig domein met één bestaande implementatie — het zijn twee ongekoppelde systemen** (zie [13-END-TO-END-DATAFLOW.md](13-END-TO-END-DATAFLOW.md)).

> **UPDATE 2026-09-01 (na TelefoonSysteem-onderzoek)**: een vijfde app (TelefoonSysteem) is onderzocht — zie [19](19-TELEFOONSYSTEEM-CRM-DEEP-DIVE.md)–[23](23-CRM-PHASE-1-FINAL-RECOMMENDATION.md). Belangrijkste wijziging: het CRM-domein hieronder is aangevuld met een bestaand, herbruikbaar Task-systeem en gespreks-/notitiedata — beide via [19](19-TELEFOONSYSTEEM-CRM-DEEP-DIVE.md).
>
> **ARCHITECTUURWIJZIGING 2026-09-01 (tweede update)**: er is een expliciete richtingsbeslissing genomen om **niet** permanent op TelefoonSysteem's Task/Note-API te leunen — zie `docs/architecture/ADR-001` t/m `ADR-006` en [24-UNIFIED-CONTROL-CENTER-TARGET.md](24-UNIFIED-CONTROL-CENTER-TARGET.md). Het CRM-domein hieronder ("hergebruiken via API") is op dat specifieke punt **herzien**: Tasks en Notes worden eigen, centrale Control Center-modellen (ADR-003), TelefoonSysteem blijft wel een read-only adapter voor gespreksdata in de Activity Timeline. De rest van dit document (Quotes-tweedeling, Operations-precedenten, POS-scheiding) blijft ongewijzigd geldig.

## CORE

- Shopify-integratielaag (client, token-acquisitie, GraphQL-transport, shop-identity-verificatie, write-guards) — zie [14-SHARED-CORE-DESIGN.md](14-SHARED-CORE-DESIGN.md).
- Product identity (variant-snapshot-type) en Shopify Order identity (order/draft-order-referentie-abstractie).
- User/Auth — met de kanttekening dat dit een bewuste keuze vereist tussen POS' en OfferteApp's technische aanpak (zie 14).
- Audit — generieke, herbruikbare audit-log-service.
- Internal service authentication — geformaliseerde versie van het al werkende `x-integration-key`/bearer-token-patroon tussen OfferteApp, Pallet Yard en Transport-S4U, **plus TelefoonSysteem's onafhankelijk gebouwde `x-internal-secret`-variant (ami-worker↔api)** — een derde bevestiging van hetzelfde patroon.
- Files (nieuw te bouwen, geen bestaand werkend voorbeeld — zie 15).
- **Nog geen Customer identity** — bewust buiten Core gehouden totdat de vraag "wordt het CRM de eerste lokale Customer-master, of blijft Shopify dat" is beantwoord (zie 14-SHARED-CORE-DESIGN.md).

## QUOTES

**Dit domein heeft vandaag twee eigenaren, niet één:**
- **Storefront-intake**: s4u-quote-app — Theme App Extension, App Proxy, `Quote`/`QuoteItem` (aanvraag-vorm, lichte klantgegevens, geen prijsonderhandeling).
- **Offerte-verwerking/orderdoorzet**: OfferteApp — `Quote`/`QuoteLine`/`QuoteVersion` (volwaardige prijsopbouw, kortingen, BTW, versiebeheer, Shopify draft-order/order-conversie, Mollie-betaling).

Een toekomstig Quotes-domein in het platform moet expliciet beide bronnen erkennen. Het is **niet vanzelfsprekend** dat deze twee samengevoegd moeten worden tot één technisch systeem — ze bedienen aantoonbaar verschillende stappen (klant-aanvraag vs. medewerker-offerte-opbouw). Wat wél ontbreekt is de **koppeling** ertussen (zie [18-RECOMMENDED-BUILD-SEQUENCE.md](18-RECOMMENDED-BUILD-SEQUENCE.md) voor een voorstel).

Quote-documenten (PDF) horen hier: OfferteApp's `_generate_pdf()` is de enige werkende implementatie in het landschap.

## CRM

- Customer 360, tijdlijn/interacties, klantafspraken — grotendeels **nieuw te bouwen** (zie [15-CRM-GAP-ANALYSIS.md](15-CRM-GAP-ANALYSIS.md)).
- **Herbruikbaar als startpunt, niet als eindpunt**: OfferteApp's `CustomerCache` + `CustomerActivity`-patroon (read-through cache + append-only tijdlijn) is het meest volwassen bestaande fragment van wat een CRM-Customer-360 nodig heeft, maar dekt maar een fractie van de gewenste functionaliteit en is vandaag ingebed in OfferteApp, niet losstaand.
- `VisitReport` (het smalle model, niet het hele bezoekrapport-scherm) hoort functioneel in CRM, niet in Quotes — een kandidaat om op termijn te ontkoppelen van OfferteApp's Quotes-georiënteerde bezoekrapport-UI.
- **Taken — nieuw centraal Control Center-model (ADR-003), TelefoonSysteem als referentie.** TelefoonSysteem's `Task`/`TaskUpdate`-systeem (status/prioriteit, audit-log, creator/assignee/admin-autorisatie) is productie-getest en levert waardevolle businessregels, maar wordt **niet** de permanente bron van waarheid voor CRM-taken — het CRM krijgt een eigen, breder `Task`-model met relaties naar Customer/Order/Quote/Call/Supplier/PurchaseOrder/ProductionJob/Complaint. Zie [21-TASKS-NOTES-REUSE-ANALYSIS.md](21-TASKS-NOTES-REUSE-ANALYSIS.md) voor de referentie-analyse en `docs/architecture/ADR-003` voor het besluit.
- **Notities — deels herbruikbaar als concept.** TelefoonSysteem's `CallNote`/`ContactNote` (naast OfferteApp's `Quote.internal_note`/`VisitReport`) tonen hetzelfde basispatroon (auteur+tijdstip+entiteit) drie keer onafhankelijk gebouwd, telkens platte tekst zonder bijlagen. Geen van drieën dekt de CRM-wens (rich text, tags, bijlagen) — nieuwe implementatie nodig, met hergebruik van het datamodel-idee. Zie [21](21-TASKS-NOTES-REUSE-ANALYSIS.md).
- **Gespreksgeschiedenis (Calls)** — TelefoonSysteem's `Call`-model levert kant-en-klare tijdlijn-events (wie belde wanneer, welke medewerker) — hergebruiken via API, niet herbouwen. Zie [19-TELEFOONSYSTEEM-CRM-DEEP-DIVE.md](19-TELEFOONSYSTEEM-CRM-DEEP-DIVE.md).
- **TelefoonSysteem's `Contact`-model hoort NIET als centrale Customer-identiteit** gebruikt te worden door het CRM — het is telefoonnummer-gesleuteld, zonder Shopify-GID, zonder dedup. Zie [22-CUSTOMER-IDENTITY-STRATEGY.md](22-CUSTOMER-IDENTITY-STRATEGY.md) voor de aanbevolen identiteitsstrategie.

## OPERATIONS

Aangetroffen, werkende systemen die hier horen — **niet vervangen, wel eventueel op termijn beter ontsloten**:
- Warehouse/fulfillment via Pallet Yard (aangeroepen vanuit OfferteApp).
- Transport via Transport-S4U/Van Eijk (`TransportJob`/`TransportEvent`, aangeroepen vanuit OfferteApp).
- Hoefnagels-transport (geen apart systeem, alleen velden op `Quote` + e-mail — een operationeel proces dat vandaag "verstopt" zit in de Quotes-datamodel van OfferteApp; kandidaat om bij een toekomstige Operations-module eigen datamodel te geven in plaats van velden op Quote).
- Pikbon/pakbon/labels/printen (OfferteApp + lokale Print Agent).
- Purchase orders, productieopdrachten, "materiaal naar leverancier" — **volledig nieuw te bouwen**, geen bestaande code.

## SERVICE

Complaints/Cases/Photos/Resolutions — **geen enkel aangetroffen systeem dekt dit**. Zuiver nieuw domein, geen bestaande code om rekening mee te houden of te consolideren.

## POS

Volledig gedekt door Kassa Systeem — Cart/Payments/Receipts/Terminal/Cash register/Daily closing, met een hardware-geteste CCV-betaalflow. **Bevestigd in deze onderzoeksronde: geen aantoonbare koppeling tussen POS en OfferteApp/s4u-quote-app** — POS' orders lopen via een eigen, onafhankelijke Shopify Draft Order-stroom.

## TELEFONIE — een niet in het opdracht-model voorzien, eigen domein

TelefoonSysteem (PBX/AMI-integratie, gespreksroutering, Windows-popup) is functioneel geen onderdeel van CRM, Quotes, Operations, Service of POS — het is een **eigen, infrastructureel domein** (vergelijkbaar met hoe POS een eigen domein is), dat wél **data levert aan** CRM (gesprekken, notities, taken — zie boven) zonder zelf een CRM-submodule te worden. Aanbeveling: behandel TelefoonSysteem als een zesde bounded context naast de vijf uit de opdracht, met een eigen `CLAUDE.md` (zie [17-AI-MODULE-BOUNDARIES.md](17-AI-MODULE-BOUNDARIES.md)), niet als iets dat in CRM opgaat.

## Wat het opdracht-model niet voorzag, maar wel is aangetroffen

- **Twee gescheiden secret-opslag-niveaus in OfferteApp** (Fly-deploy-secrets vs. versleutelde DB-`Setting`-rijen) — relevant voor hoe Core straks configuratie/secrets voor nieuwe modules zou moeten beheren.
- **Een genuinely multi-tenant Shopify-laag in OfferteApp** (`StoreManager`, meerdere shops) — geen van de andere apps heeft dit; als het platform ooit meerdere Shopify-stores moet bedienen, is dit het enige bestaande precedent om van te leren.
- **Order editing na plaatsing** (OfferteApp's Order Editing API-wrapper, nog niet aangesloten) — een mogelijkheid die noch POS noch s4u-quote-app heeft, relevant voor een toekomstige "bestellingen op rekening"-flow in Quotes of Operations.
