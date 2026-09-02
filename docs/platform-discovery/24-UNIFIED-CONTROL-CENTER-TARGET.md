# 24 — Stones4U Control Center: high-level target architecture

Dit document is het nieuwe, leidende architectuurdoel, vastgesteld na alle discovery tot nu toe (`01`–`23`) en de expliciete richtingsbeslissing vastgelegd in `docs/architecture/ADR-001` t/m `ADR-006`. Het beschrijft **waar we naartoe werken**, niet wat vandaag al gebouwd is — voor de huidige stand van zaken, zie de eerdere discovery-rapporten.

## Visie

Eén intern bedrijfsplatform, **Stones4U Control Center**, met voor medewerkers: één login, één navigatie, één Customer 360, één centrale zoekfunctie, één centrale Activity Timeline, één centraal Task-model, één centraal Note-model, één centrale CRM-database. Onderliggend: modulaire domeinen met duidelijke, AI/Claude-afdwingbare grenzen. Bestaande applicaties blijven voorlopig zelfstandig functioneren en worden evolutionair geïntegreerd — geen big-bang rewrite (zie ADR-001, ADR-004).

## Fundamenteel principe (herbevestigd)

Bestaande code is bron van bewezen businesslogica, integratiekennis, en tijdelijke operationele systemen — **niet automatisch** het toekomstige system-of-record. "Het bestaat al" ≠ "we moeten het hergebruiken als centrale implementatie". Voor CRM-kernfunctionaliteit wegen kwaliteit en consistentie zwaarder dan maximale code-hergebruik (zie ADR-003).

## Modules (binnen het nieuwe Control Center)

- **CRM** — Customer 360, notities, tags, accountmanager, klantstatus.
- **Sales** — offerte-/orderoverzicht (aanvankelijk read-only projecties vanuit OfferteApp/s4u-quote-app, zie ADR-004).
- **Tasks** — het centrale Task-model (ADR-003), domeinoverstijgend inzetbaar.
- **Operations** — leveranciers, purchase orders, productieopdrachten, ophalen/leveren (Phase 3+).
- **Service** — klachten/service-cases (Phase 6).
- **Telephony** — projectie van TelefoonSysteem-gespreksdata in de tijdlijn; geen herbouw van de PBX-integratie zelf.
- **POS integration** — projectie van kassacontext waar relevant voor Customer 360 (latere fase).
- **Admin** — gebruikers/rollen, instellingen, audit-inzicht.

## Shared platform capabilities

Eén set gedeelde bouwstenen, gebruikt door alle modules hierboven:

| Capability | Inhoud | Bron/precedent |
|---|---|---|
| **database** | Eén centrale PostgreSQL-database voor alle Control Center-modellen | Nieuw — geen bestaande app deelt vandaag een database |
| **auth** | Centrale login/gebruikers/rollen voor het Control Center | Nieuw ontwerp; leert van POS (argon2, DB-sessies), OfferteApp (granulair permissiesysteem), TelefoonSysteem (wat te vermijden: stateless JWT zonder revocatie) — zie `platform-discovery/14` |
| **shopify** | Gedeelde Shopify-client (client-credentials, zie ADR-006) | Geëxtraheerd uit POS' bewezen patroon |
| **file storage** | Cloudflare R2 + Postgres-metadata (zie ADR-005) | Nieuw — geen bestaande app heeft dit werkend |
| **audit** | Generieke, herbruikbare audit-log-service | Geïnspireerd door POS' `AuditLog` en TelefoonSysteem's `TaskUpdate`-patroon |
| **search** | Centrale zoekfunctie (Ctrl/Cmd+K, command-palette-stijl) over Customers/Tasks/Notes/Activities | Nieuw — geen bestaande app heeft cross-systeem zoeken |
| **notifications** | In-app + toekomstig push/e-mail | Nieuw, met TelefoonSysteem's Web-Push-patroon als referentie |
| **activity timeline** | Het centrale Activity-concept (zie hieronder) | Nieuw, kernonderdeel van het platform |
| **internal service authentication** | Gedeeld patroon voor toekomstige adapter-koppelingen die verder gaan dan read-only polling | Geïnspireerd door OfferteApp's `x-integration-key` en TelefoonSysteem's `x-internal-secret` — beide onafhankelijk gebouwde precedenten, hier voor het eerst geformaliseerd |

## External / transitional adapters

Bestaande systemen leveren data aan het Control Center zonder zelf vervangen te worden (zie ADR-004 voor het volledige besluit):

- **Shopify** — customer/product/order-identiteit (commercieel, blijvend).
- **TelefoonSysteem** — calls + bestaande call-notes/-historie (read-only, eerste adapter — heeft al een bruikbare API).
- **Exact / customer-history** — factuur-/omzethistorie (read-only, via TelefoonSysteem's bestaande proxy — zie `platform-discovery/20`).
- **OfferteApp** — interne offertes/orders/sales-processen (read-only zodra veilig mogelijk — heeft vandaag nog geen geschikte read-API, zie `platform-discovery/10`).
- **s4u-quote-app** — webshop-offerteaanvragen (idem, zie `platform-discovery/11`).
- **Transport-S4U / Pallet Yard** — operations-data (latere fase).
- **POS** — kassaverkoop/betaalcontext (latere fase).

## Centrale Activity Timeline: adapter-/projectiestrategie

Eén Activity-concept voor Customer 360, met een expliciet onderscheid:

- **A. Control Center-owned activities** — fysiek in de Control Center-database aangemaakt (een CRM-notitie, een taak-statuswijziging, een afspraak). Dit zijn "gewone" rijen in de `Activity`-tabel (of een gerelateerd model), met volledige CRUD/audit binnen het platform.
- **B. External/source activities** — **niet** gemigreerd naar de Control Center-database, maar **geprojecteerd**: op het moment dat een Customer 360-pagina geladen wordt, haalt een adapter (bijv. de TelefoonSysteem-adapter) de relevante bron-events op (gesprekken, notities) en vertaalt ze naar een uniforme, read-only `Activity`-representatie in de UI — zonder een duplicaat-rij in de Control Center-database te schrijven. Dit voorkomt datasynchronisatieproblemen tussen twee systemen die "dezelfde" data bewaren.

Praktisch betekent dit: de Activity Timeline-component in de UI combineert (A) query's op de eigen database met (B) live/gecachte adapter-aanroepen, gesorteerd op tijdstip, gepresenteerd als één samenhangende lijst — de gebruiker ziet geen verschil tussen bron A en B, de code wél (verschillende data-adapters achter een gemeenschappelijke `ActivityItem`-interface).

Toekomstige uitbreiding (buiten Phase 1, zie E-mail-voorbereiding hieronder): e-mail-activiteiten (Outlook-koppeling) zouden aanvankelijk ook type B kunnen zijn (metadata-projectie vanuit Microsoft Graph) voordat ooit gekozen wordt om ze fysiek te importeren.

## Centrale datamodellen

**Vanaf Phase 1** (zie [25-PHASE-1-BUILD-SPEC.md](25-PHASE-1-BUILD-SPEC.md) voor volledige velden/relaties):
`User`, `CustomerProfile`, `Activity`, `Note`, `Task`, `AuditEvent`.

**Later** (Phase 2+, zie fasering hieronder):
`File`, `Appointment`, `Complaint`, `Supplier`, `PurchaseOrder`, `ProductionJob`, `PickupJob`, `Delivery`, `ServiceCase`.

## Technische architectuur: repo- en mapstructuur

**Uitgangspunt, getoetst aan bestaande technologie en migratierisico** (zoals gevraagd — niet blind de voorbeeldstructuur uit de opdracht overnemen):

- Van de vier bestaande apps gebruiken er **twee** al Next.js + Prisma + PostgreSQL (POS, en TelefoonSysteem's `apps/web`/`apps/api`-combinatie leunt op hetzelfde soort Node/TypeScript-stack). Dit is de stack waar in het landschap al de meeste bewezen ervaring mee is (client-credentials Shopify-client, Prisma-schema-conventies, audit-log-patronen) — zie `platform-discovery/12`, `14`.
- **Aanbeveling**: bouw het Control Center als **Next.js + Prisma + PostgreSQL**, niet als Flask (OfferteApp's stack) of een derde, nieuwe stack — dit minimaliseert het aantal nieuwe technologiekeuzes tegelijk met een nieuwe architectuur, en maakt het makkelijker om later concrete code (niet alleen concepten) uit POS/TelefoonSysteem te herbruiken waar dat wél verantwoord is (bijv. de Shopify-client-basis, zie ADR-006).
- **Geen monorepo die bestaande apps samenvoegt.** De opdracht suggereert een structuur met `apps/control-center`, `apps/shopify-quote`, `apps/phone-desktop` naast `modules/` en `packages/` — dit wordt **ten dele** overgenomen, maar uitsluitend **binnen de nieuwe Control Center-codebase**, niet door OfferteApp/s4u-quote-app/TelefoonSysteem/POS in dezelfde repo onder te brengen. Dat zou tegen ADR-001/ADR-004 ("geen big-bang, bestaande apps blijven zelfstandig draaien") ingaan.
- **Voorgestelde structuur binnen de nieuwe, losstaande Control Center-repo** (bijvoorbeeld met pnpm workspaces/Turborepo, zoals TelefoonSysteem al doet — een bekend, bewezen patroon in het landschap):

  ```
  control-center/                  (nieuwe, eigen repository)
    apps/
      web/                         (Next.js — de hoofdapplicatie, alle modules)
    modules/
      crm/
      tasks/
      sales/
      operations/                  (leeg/skeleton tot Phase 3)
      service/                     (leeg/skeleton tot Phase 6)
      telephony/                   (adapter-laag naar TelefoonSysteem)
    packages/
      db/                          (Prisma-schema, centrale modellen)
      auth/
      shopify/                     (ADR-006)
      ui/                          (designsysteem, zie GUI-richting hieronder)
      storage/                     (ADR-005, skeleton tot Phase 2)
      audit/
      search/
      shared/                      (types, utilities)
  ```

- Bestaande apps (`Kassa Systeem`, `OfferteApp`, `s4u-quote-app`, `TelefoonSysteem`) **blijven exact waar en wat ze zijn** — losse repo's, eigen deployments, eigen databases. De namen `apps/shopify-quote`/`apps/phone-desktop` uit de opdracht worden **niet** letterlijk gebruikt voor de bestaande s4u-quote-app/TelefoonSysteem-Windows-popup — die blijven hun eigen repo's; de Control Center-repo bevat alleen de nieuwe code.

## AI/Claude-grenzen

Elke module/package hierboven krijgt op termijn een eigen `CLAUDE.md` met: eigenaarschap, read-only afhankelijkheden, verboden wijzigingen, publieke interfaces — zie [17-AI-MODULE-BOUNDARIES.md](17-AI-MODULE-BOUNDARIES.md) (bijgewerkt) voor het volledige voorstel, nu uitgebreid met de `modules/`/`packages/`-indeling hierboven.

## GUI/productvisie

Vanaf Phase 1 een premium intern product, geen latere polish. Richting: Linear/Stripe/Shopify Admin/moderne enterprise SaaS — rustig, snel, duidelijke hiërarchie, veel witruimte, moderne typography, subtiele statuskleuren, drawers/modals waar logisch, keyboard-first waar nuttig, Ctrl/Cmd+K-zoekfunctie, uitstekende tabellen, responsive maar desktop-first. Expliciet **niet** een generiek Bootstrap/admin-template-uiterlijk. Dit is een productvereiste vanaf Phase 1, niet een "fase 2 polish"-item — zie [25-PHASE-1-BUILD-SPEC.md](25-PHASE-1-BUILD-SPEC.md) UX-sectie.

## E-mail-voorbereiding (architecturaal, niet Phase 1)

De Activity/File-modellen worden zo ontworpen dat latere e-mail-ondersteuning (Outlook drag-and-drop, `.eml`/`.msg`-verwerking, bijlagen, Microsoft Graph-integratie, automatische/handmatige klantkoppeling) geen grote migratie vereist — concreet: `Activity` heeft een `sourceType`-veld dat een toekomstige `EMAIL`-waarde kan dragen naast `CALL`/`NOTE`/`TASK`/etc. (type B, zie hierboven), en `File` staat los genoeg van specifieke entiteiten om ook aan een toekomstig e-mailbericht gekoppeld te kunnen worden. Niet bouwen in Phase 1.

## Fasering (aangepast op basis van discovery — zie toelichting)

De opdracht stelde een volgorde voor (Tasks advanced+Files+Appointments → Suppliers+PO → Production → Delivery → Complaints → Quote-integratie → OfferteApp-integratie → Telephony deeper → POS deeper). Discovery rechtvaardigt één aanpassing: **de TelefoonSysteem-adapter (read-only calls/notes/tasks-referentie in de tijdlijn) hoort al in Phase 1**, niet pas in Phase 9 — omdat, in tegenstelling tot OfferteApp/s4u-quote-app, TelefoonSysteem vandaag al een voor dit doel bruikbare, voor elke rol leesbare API heeft (`platform-discovery/19`, `23`). "Telephony deeper integration" (Phase 9) blijft wél terecht laat — dat betekent een écht diepere koppeling (bijv. events pushen i.p.v. lezen), niet de basis-projectie die al in Phase 1 kan.

| Fase | Inhoud |
|---|---|
| **Phase 1** | Control Center Foundation + Customer 360 v1 (incl. TelefoonSysteem-tijdlijn-adapter) — zie [25-PHASE-1-BUILD-SPEC.md](25-PHASE-1-BUILD-SPEC.md) |
| **Phase 2** | Tasks advanced + Files (R2 live) + Appointments |
| **Phase 3** | Suppliers + Purchase Orders |
| **Phase 4** | Production + Material Handoff + Pickup |
| **Phase 5** | Delivery + Customer Pickup |
| **Phase 6** | Complaints / Service |
| **Phase 7** | Quote App (s4u-quote-app) → Sales-integratie (read-only eerst; schrijvend pas na aparte goedkeuring, zie `platform-discovery/18` Fase 3) |
| **Phase 8** | OfferteApp-integratie/migratie (grootste risico-fase — raakt een productie-kritieke app, zie `platform-discovery/07`) |
| **Phase 9** | Telephony deeper integration (events i.p.v. polling, mogelijk een geformaliseerde interne service-auth i.p.v. het tijdelijke serviceaccount uit Phase 1) |
| **Phase 10** | POS deeper integration |

Deze volgorde is een **aanpassing van prioriteit binnen Phase 1's scope**, geen herordening van Phase 2–10 — zie [25-PHASE-1-BUILD-SPEC.md](25-PHASE-1-BUILD-SPEC.md) voor de concrete Phase 1-inhoud.
