# Quote Delivery Date — Portal Discovery (Stones4U Control Center)

**Status**: Pure discovery. Geen implementatie, geen migratie, geen commit,
geen push, geen deploy. Onderzoek uitsluitend uitgevoerd in `D:\Shopify\CRM`
— `D:\Shopify\OfferteApp` en `https://offerteapp.fly.dev/` zijn niet
geopend, niet gelezen, niet aangeraakt (harde grens uit de opdracht). Alle
kennis over OfferteApp hieronder komt uitsluitend uit eerder in deze sessie
al opgedane, functionele kennis — niet uit nieuwe bestandsinspectie.

**Update (2026-09-08 — Fase 2A gebouwd)**: de architectuuraanbeveling
hieronder (§4: nieuwe `DeliveryDateHandoff`-entiteit, optie C) is
geïmplementeerd. Zie `docs/QUOTE-DELIVERY-DATE-PORTAL-BUILD.md` voor het
volledige databaseschema, de token-beveiliging, de publieke routes, de
Shopify-mirror-service, de staging-safety-guard en de volledige testset.
Dit document blijft ongewijzigd staan als de oorspronkelijke, uitsluitend
onderzoeksmatige discovery — de bevindingen erin zijn nog steeds accuraat
en vormen de basis van de build.

**Doel van dit document**: bepalen hoe de reeds in staging (OfferteApp)
bewezen "Gewenste leverdatum klant"-flow **native** in het Control Center
gebouwd kan worden, zonder OfferteApp te wijzigen.

## 1. Current portal architecture

Next.js 15 (App Router) / TypeScript / Prisma 6 / PostgreSQL, gedeployed op
Fly.io. Strikte laagscheiding (`CLAUDE.md`):

- `src/platform/*` — auth, db, audit, security. Generiek, geen
  businesslogica. Alles hangt hiervan af; dit hangt van niets af.
- `src/integrations/*` — één map per extern systeem (`shopify`,
  `telephony`, `exact`, `quotes`, `email`, `storage`), elk achter een
  klein adapter-interface. `telephony`/`exact` zijn bewust uitgeschakeld.
- `src/modules/*` — businesslogica (`crm`, `tasks`, `activity`, `admin`,
  `opportunities`, `appointments`, `files`, `dashboard`, `matching`).
- `src/app/*` — Next.js routes (pagina's + API). Dun — delegeert naar
  `modules`.

Routegroepen: `src/app/(app)/*` is de geauthenticeerde staff-omgeving
(vereist een sessie via `requireUser()`/`requireWriteAccess()`,
`src/platform/auth/guards.ts`). `src/app/login` is de **enige** bestaande
publieke, niet-geauthenticeerde route in deze app. Er is geen
`src/middleware.ts` — auth wordt per-route afgedwongen, niet globaal via
middleware.

Twee volledig gescheiden Fly-omgevingen (`docs/deployment/FLY-STAGING.md`,
`FLY-PRODUCTION.md`): `stones4u-control-center-staging` (eigen
`fly.toml`, eigen database `stones4u-cc-staging-db`) en
`stones4u-control-center` (`fly.production.toml`, eigen database
`stones4u-cc-production-db`). Deploys zijn volledig onafhankelijk — een
`fly deploy -c fly.toml` raakt nooit production.

## 2. Relevante bestaande modellen (`prisma/schema.prisma`)

- **`CustomerProfile`** — dun, alleen CRM-specifieke velden
  (`crmStatus`, `accountManagerId`, tags) + een gedenormaliseerde
  Shopify-snapshot, key = `shopifyCustomerGid` (uniek). Shopify blijft de
  bron van waarheid voor identiteit (ADR-002). **Eén klant kan meerdere
  offertes/orders hebben** — er is hier al expliciet géén enkelvoudig
  offerte- of orderveld op dit model, precies om die reden.
- **Geen lokaal Quote- of DraftOrder-model.** Bevestigd: het schema bevat
  nergens een `Quote`-, `DraftOrder`- of vergelijkbare entiteit. Externe
  commerciële documenten worden **nooit gekopieerd**, alleen lichtgewicht
  gerefereerd — zie `OpportunityExternalLink` (`linkType` +
  `externalRef`, ADR-009 §4: "never a copy of the document itself") en
  `ExternalContactMatch` (`source` + `externalRef`, ADR-007). Dit is een
  bewuste, herhaalde architectuurkeuze in dit repo, geen toevallige
  omissie.
- **`Opportunity`** — een sales-pipeline-deal (`stage`,
  `status`, `estimatedValue`), niet gekoppeld aan één specifieke offerte-
  instantie. Een Opportunity kan meerdere offerteversies/herzieningen
  overspannen via `OpportunityExternalLink` (meerdere
  `OFFERTEAPP_QUOTE`/`SHOPIFY_DRAFT_ORDER`-links per Opportunity zijn
  toegestaan). Niet elke offerte heeft een Opportunity (Opportunities
  zijn een handmatig CRM-sales-construct, geen automatische spiegeling
  van elke offerte).
- **`Note`/`Task`/`Activity`** — centraal eigendom (ADR-003), staff-
  geauthenticeerd, `authorId`/`actorId` altijd een `User`.
  `AuditEvent.userId` is **nullable** — er bestaat al precedent voor een
  audit-rij zonder ingelogde gebruiker.
- **`ActivityType`** bevat al `QUOTE_CREATED`, `QUOTE_UPDATED`,
  `DRAFT_ORDER_CREATED` als category-B (live-geprojecteerd, nooit
  persistent opgeslagen) waarden — voorbereid voor precies dit soort
  offerte-gerelateerde gebeurtenissen, nog zonder producer voor de
  eerste twee.

## 3. Shopify-integratie (`src/integrations/shopify/`)

- **Auth**: OAuth **client-credentials** grant (ADR-006), niet de
  authorization-code/consent-flow die OfferteApp gebruikt. Token wordt
  per proces in-memory gecached en automatisch ververst
  (`src/integrations/shopify/client.ts`, `shopifyGraphQL()`/
  `getAccessToken()`). **Belangrijk verschil met de OfferteApp-
  reauthorisatie-ervaring uit deze week**: bij client-credentials is er
  geen interactieve browser-consentstap nodig om een scope-wijziging te
  laten ingaan — zodra Fons de scopes van de custom app in Shopify Admin
  aanpast, haalt de eerstvolgende tokenvernieuwing automatisch de nieuwe
  scope op. Geen `/shopify/auth?shop=...`-stap nodig zoals bij OfferteApp.
- **Huidige scopes (bevestigd via `README.md` en `.env.example`)**:
  uitsluitend `read_customers`, `read_orders`, `read_draft_orders`. **Geen
  enkele write-scope.** `src/integrations/shopify/client.ts` zelf legt dit
  ook expliciet vast: *"PHASE 1 IS READ-ONLY: this module intentionally
  exposes no mutation helpers."* De onderliggende `shopifyGraphQL()`-
  functie is generiek (query of mutation, geen technisch onderscheid) —
  de read-only-grens wordt today uitsluitend bewaakt doordat er simpelweg
  geen mutation-functies bestaan in `customers.ts`/`orders.ts`/
  `draft-orders.ts`, niet door een harde blokkade in de client zelf.
- **`assertShopifyShopIdentity()`** (`guard.ts`) — live shop-identity-
  check tegen `SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN`, expliciet voorbereid
  ("every future Shopify WRITE in Control Center must call this first")
  maar nog nergens aangeroepen, want er is nog geen write-code.
- **`draft-orders.ts`** bevat al `getShopifyCustomerDraftOrders()` —
  haalt draft orders op **per klant** (`customer_id:`-filter), inclusief
  `invoiceUrl`. Er bestaat **nog geen** functie om één specifieke draft
  order **op id** op te halen (het equivalent van OfferteApp's
  `get_draft_order(draft_order_id)`), en `customAttributes` wordt nog
  nergens opgevraagd.
- **API-versie**: `SHOPIFY_API_VERSION=2026-07` (env-gestuurd, niet
  hardcoded zoals in de andere twee apps).
- **Kritiek verschil met OfferteApp voor testbaarheid**: staging en
  production van dit portal wijzen **op hetzelfde, echte Stones4U-
  Shopify-account** — `docs/deployment/FLY-PRODUCTION.md` zegt dit
  letterlijk: *"there is one real Stones4U shop... so there is no
  separate 'staging Shopify store' to point at instead."* Er is dus
  **geen ingebouwde, portal-eigen dev-store-scheiding** zoals bij
  OfferteApp. Zie §11 (staging strategy) voor hoe dit voor de
  Draft→Order-verificatie moet worden opgelost.

## 4. Aanbevolen data ownership — architectuurvraag beantwoord

**Antwoord: C — een nieuwe, lichtgewicht entiteit, niet A/B/D/E.**

- **A (CustomerProfile) — afgewezen.** Semantisch fout: een klant kan
  meerdere offertes hebben (§2), dus één datumveld op CustomerProfile zou
  bij een tweede offerte de eerste overschrijven of dubbelzinnig worden.
  Dit is precies de fout die de opdracht expliciet uitsloot, en die het
  bestaande schema zelf ook nergens maakt (er staat geen enkel offerte-
  specifiek veld op CustomerProfile).
- **B (Opportunity) — afgewezen.** Een Opportunity is een deal over de
  tijd, niet een specifieke betaalmoment-instantie; hij kan meerdere
  offerteversies overspannen (§2) en niet elke offerte heeft er één. Een
  "gewenste leverdatum voor déze specifieke betaal-handoff" hoort bij de
  offerte/order-instantie, niet bij het bredere deal-record.
- **D (bestaande order/quote entity) — bestaat niet.** Zoals in §2
  vastgesteld: er is helemaal geen lokale Quote/Order-entiteit om aan toe
  te voegen. Dit repo kopieert bewust nooit externe commerciële
  documenten.
- **E (andere bestaande entiteit) — geen kandidaat gevonden.** Geen van
  de overige modellen (`Note`, `Task`, `Appointment`, `File`,
  `CustomerContact`, `ExternalContactMatch`, `OpportunityExternalLink`)
  is semantisch een "specifieke offerte/order die een betaal-handoff met
  leverdatumkeuze doorloopt."
- **C — nieuwe entiteit, aanbevolen.** Exact dezelfde situatie als
  waarom `OpportunityExternalLink`/`ExternalContactMatch` bestaan: een
  lichtgewicht, **Control-Center-eigen** rij die naar het externe
  document *verwijst* (`sourceSystem` + `externalId`, hetzelfde paar dat
  `QuoteSummary.sourceSystem`/`externalId` uit
  `src/integrations/quotes/adapter.ts` al gebruikt) in plaats van het te
  kopiëren. Voorgestelde naam: **`DeliveryDateHandoff`** (of
  `QuoteDeliveryHandoff` — naamgeving is triviaal, het patroon is de
  beslissing).

  Voorgestelde vorm (Fase 2, niet nu bouwen):
  ```prisma
  enum QuoteSourceSystem {
    OFFERTEAPP
    S4U_QUOTE_APP
  }

  model DeliveryDateHandoff {
    id                String            @id @default(cuid())
    // Publieke, opaque autorisatie-token. Bewust een apart veld, niet
    // hergebruik van `id` — zie §10 voor de afweging.
    publicToken       String            @unique @default(cuid())

    sourceSystem      QuoteSourceSystem
    externalQuoteId   String            // = QuoteSummary.externalId (OfferteApp: Quote.uuid)
    shopifyDraftOrderGid String?         // voor de mirror-stap

    requestedDeliveryDate DateTime?      @db.Date
    mirroredAt            DateTime?      // laatste geslaagde Shopify-mirror, voor observability

    createdAt DateTime @default(now())
    updatedAt DateTime @updatedAt

    @@unique([sourceSystem, externalQuoteId])
    @@index([shopifyDraftOrderGid])
  }
  ```
  `@@unique([sourceSystem, externalQuoteId])` geeft natuurlijke
  idempotentie: eenzelfde offerte krijgt nooit twee handoff-rijen,
  ongeacht hoeveel keer de klant de pagina opnieuw bezoekt of de mail
  opnieuw wordt verstuurd (upsert-semantiek, zelfde "laatste geldige
  datum wint"-regel als bewezen in OfferteApp).

## 5. Public handoff architecture

Precedent: `src/app/login` is de enige bestaande publieke route. Een
nieuwe publieke route zou hetzelfde patroon volgen — **buiten** de
`(app)`-routegroep, geen `requireUser()`/`requireWriteAccess()`-aanroep
(bewust, net als `login/route.ts` zelf al doet).

Voorgestelde locatie: `src/app/delivery/[token]/page.tsx` +
`src/app/api/delivery/[token]/route.ts` (of een gecombineerde Server
Action — Next.js 15 App Router ondersteunt beide; een Server Action is
hier waarschijnlijk het natuurlijkere idioom dan een aparte API-route,
gezien de rest van dit repo al Server Actions gebruikt voor mutaties
binnen `(app)` — te bevestigen bij daadwerkelijke build, niet nu).

**Token**: `DeliveryDateHandoff.publicToken`, nooit de rij-`id`, nooit een
Shopify GID, nooit een numeriek OfferteApp-quote-id. Zie §10 voor de
motivatie.

**GET**: token → `DeliveryDateHandoff`-rij (of 404, generiek, geen
onderscheid tussen "onbekend" en "malformed" — zelfde regel als
OfferteApp). Toon alleen het offertenummer (via een lichte, publieke
lookup — zie §9), geen naam/e-mail/telefoon.

**POST-volgorde — identiek aan de bewezen OfferteApp-architectuur**:
1. resolve token → rij (404 bij onbekend)
2. valideer datum (geldig, niet in het verleden — §6 van de opdracht,
   geen weekend/feestdag/capaciteit/leadtime-regels)
3. persist lokaal (`DeliveryDateHandoff.requestedDeliveryDate`) — dit is
   de autoriteit, gebeurt vóór alles hieronder
4. Shopify-mirror (§7) — alleen als `shopifyDraftOrderGid` bekend is
5. server-side payment-target bepalen (§6)
6. pas dan redirect (303)

Mirror-failure: lokale datum blijft staan, geen redirect, retrybaar, geen
nieuwe Draft Order, geen nieuwe Mollie-betaling — identiek aan de
bewezen regel.

## 6. Payment target architecture

**Shopify-pad — volledig native bouwbaar in Fase A.** De CRM heeft al
een eigen, onafhankelijke Shopify-integratie (§3). Een nieuwe
`getDraftOrderById(gid)`-achtige functie (analoog aan OfferteApp's
`get_draft_order()`) kan de live `invoiceUrl` ophalen zonder enige
afhankelijkheid van OfferteApp. Dit is de default/meerderheidscasus
(OfferteApp's `payment_link_provider`-instelling staat standaard op
`'shopify'`).

**Mollie-pad — NIET native bouwbaar in Fase A, harde afhankelijkheid.**
Bevestigd: er bestaat **nergens** in dit repo een Mollie-integratie (geen
enkele treffer op "mollie" in `src/`). Mollie-betalingen (`MolliePayment`-
rijen) zijn en blijven **OfferteApp's eigen data** — dit repo mag nooit
een andere app's database rechtstreeks lezen (`CLAUDE.md`, "No big-bang
migration"). Om het bestaande Mollie-checkout-URL voor een offerte te
kunnen hergebruiken, zou het portal OfferteApp moeten bevragen — en elke
wijziging aan OfferteApp (zelfs een kleine, additieve uitbreiding van het
bestaande read-only
`GET /api/integrations/control-center/quotes`-endpoint) valt onder de
huidige harde grens en is dus expliciet **Fase B**, nu niet uit te voeren.

**Gevolg voor de architectuur**: Fase A levert een volledig werkende
native handoff voor het Shopify-betaalpad. Voor offertes waarvan
OfferteApp intern het Mollie-pad koos, is er in Fase A geen manier om de
bestaande Mollie-checkout-URL te achterhalen zonder OfferteApp aan te
passen — dit moet expliciet als bekende beperking gecommuniceerd worden,
niet stilzwijgend genegeerd. Zie §8 en §14.

**Server-authoritative, zoals bewezen**: de resolutie gebeurt uitsluitend
op basis van wat er in `DeliveryDateHandoff` staat (welke provider bekend
is), nooit op basis van een request-parameter. `provider=`/`redirect=`/
`payment_url=`/`invoice_url=`/`next=` in de request hebben geen enkel
effect — identieke regel als bewezen in OfferteApp's live security-E2E.

## 7. Shopify attribute mirror

Zelfde read-merge-write-patroon, nu te bouwen in
`src/integrations/shopify/draft-orders.ts` (of een nieuw
`draft-order-mutations.ts` ernaast, om de bestaande, puur read-only
`draft-orders.ts` niet te vermengen met de eerste mutatie-code in dit
repo — een expliciete, zichtbare grens tussen "Phase 1 read-only" en
"nieuwe write-capability", makkelijker te reviewen en later makkelijker
terug te draaien indien nodig):

1. `assertShopifyShopIdentity()` — **verplicht vóór elke write**, exact
   zoals `CLAUDE.md` en `guard.ts`'s eigen commentaar al voorschrijven.
   Dit is de eerste keer dat deze functie ergens wordt aangeroepen.
2. Live `customAttributes` van de Draft Order ophalen (nieuwe query-
   uitbreiding, `customAttributes { key value }`, zelfde velden als
   OfferteApp toevoegde aan zijn `get_draft_order()`).
3. Merge: bestaande attributen behouden, sleutel
   `requested_delivery_date` vervangen (nooit dupliceren), waarde
   `YYYY-MM-DD`.
4. `draftOrderUpdate`-mutatie met **uitsluitend** `customAttributes` in
   de input — nooit de generieke aanpak die andere Draft Order-velden
   zou kunnen overschrijven (zelfde hard gate als bewezen in
   OfferteApp).

**Benodigde scope-uitbreiding**: `write_draft_orders` toevoegen aan de
custom app's Admin API access scopes in Shopify Admin. Omdat dit een
client-credentials-app is (§3), is er — anders dan bij OfferteApp — geen
aparte herautorisatiestap nodig; de eerstvolgende tokenvernieuwing pakt de
nieuwe scope automatisch op.

## 8. Mollie impact

Zie §6. Samengevat: **geen impact te bouwen in Fase A**, want er is geen
Mollie-toegang. Twee reële vervolgopties voor later (Fase B, niet nu
kiezen):
1. OfferteApp's bestaande read-only integratie-endpoint uitbreiden met
   het huidige `payment_link_provider`/Mollie-checkout-URL voor een
   offerte (kleinste, meest voor-de-hand-liggende uitbreiding — volgt
   exact het patroon dat `QuoteSummary` al gebruikt).
2. Het portal draagt de Mollie-pad-offertes voorlopig niet — toon een
   duidelijke "neem contact op"-foutmelding wanneer een handoff-token
   naar een offerte zonder gekende Shopify Draft Order wijst (dezelfde
   `DeliveryHandoffError`-aanpak als OfferteApp al gebruikt voor "geen
   bruikbaar betaal-target").

Optie 2 is voor Fase A het enige haalbare pad, en is ook precies wat het
bestaande `resolve_payment_target()`-ontwerp al voorziet als fallback
("geen target gevonden" is al een first-class, geteste uitkomst — geen
crash).

## 9. CRM/customer timeline integration

- **Waar tonen aan staff**: `src/app/(app)/customers/[id]/QuotesTable.tsx`
  bestaat al en toont per klant de gefedereerde `QuoteSummary[]`
  (`sourceSystem`, `displayNumber`, `status`, bedrag). Dit is het
  natuurlijke aanknopingspunt qua *plaatsing* — maar `QuotesTable` leest
  uitsluitend live van OfferteApp/s4u-quote-app via de adapter, dus de
  CRM-eigen `requestedDeliveryDate` (Fase A, zonder OfferteApp-wijziging)
  kan daar **niet zomaar in mee-renderen** zonder een aparte join op
  `sourceSystem`+`externalId` in de servercomponent die deze tabel
  vult (`customers/[id]/page.tsx`) — dat join is triviaal (één extra
  Prisma-query op `DeliveryDateHandoff`, dezelfde matcher-sleutel), geen
  OfferteApp-wijziging nodig. Zo blijft de weergave "Gewenste leverdatum
  klant" een portal-eigen kolom/regel naast de reeds bestaande, live
  OfferteApp-gegevens — feitelijk gescheiden bronnen, netjes samengevoegd
  op weergaveniveau, exact zoals de Activity Timeline nu al "A"
  (eigen) en "B" (geprojecteerd) door elkaar rendert zonder ze te
  vermengen in opslag.
- **Activity Timeline**: geen nieuwe `ActivityType` nodig voor Fase A —
  een `DeliveryDateHandoff`-update is geen klantgerichte CRM-actie van
  een medewerker (geen `User`-actor), dus het past niet natuurlijk in het
  "CONTROL_CENTER"-categorie-A-patroon (dat is voor door staff
  uitgevoerde acties). Aanbeveling: **geen** Activity-rij voor Fase A;
  wel een `AuditEvent` (zie §10) voor traceerbaarheid. Als een tijdlijn-
  weergave later gewenst is, kan dat als een nieuwe, expliciete
  "B"-projectie (net als `DRAFT_ORDER_CREATED`) worden toegevoegd —
  aparte beslissing, niet nu.
- **Contradictie met interne planning voorkomen**: exact dezelfde regel
  als bewezen — `requested_delivery_date` mag nooit een bestaand
  transportplanningsveld vullen. Dit repo heeft (nog) geen eigen
  transport-/Hoefnagels-planningsmodule; er is dus vandaag geen
  bestaand veld waarmee verwarring zou kunnen ontstaan — de scheidingsregel
  is hier dus vooral een **toekomstvaste ontwerpregel** (voor als een
  Operations-module ooit landt), niet een acute botsing zoals bij
  OfferteApp.

## 10. Security boundaries

- **Opaque public token**: `DeliveryDateHandoff.publicToken`, een apart
  veld, niet de rij-`id`. Motivatie, gebaseerd op de OfferteApp-precedent
  maar niet blind gekopieerd: OfferteApp had een numerieke autoincrement
  primary key naast `Quote.uuid` — een echt enumeratierisico dat het
  aparte uuid-veld oploste. Dit repo's `id`-velden zijn overal al
  Prisma `cuid()`-waarden (niet-sequentieel, niet makkelijk te raden of
  op te tellen) — het enumeratierisico dat OfferteApp's aparte
  uuid-veld oploste, is hier dus intrinsiek kleiner. Toch wordt een
  **apart** `publicToken`-veld aanbevolen, om twee redenen die niets met
  enumeratie te maken hebben: (1) een publiek token moet ooit
  onafhankelijk van de rij te **roteren** zijn (bijv. na een vermoeden
  van lekkage) zonder de rij zelf opnieuw te moeten aanmaken, en (2) het
  voorkomt dat een toekomstige, terloopse "toon de rij-id in een
  admin-URL"-gewoonte per ongeluk hetzelfde ID als publiek geheim
  hergebruikt. Kleine meerkost, geen architectuurschuld.
- **Geen CSRF-library in dit repo** (bevestigd: geen treffer op "csrf"
  in `src/`, geen `middleware.ts`). Next.js Route Handlers/Server Actions
  hebben geen ingebouwd equivalent van Flask-WTF's tokenbescherming. Dit
  is geen omissie om nu te "fixen" — het publieke handoff-formulier heeft
  **geen sessie/cookie-gebonden bevoegdheid om te beschermen** (in
  tegenstelling tot de rest van deze app, die wél sessie-gebaseerd is):
  de autorisatie is uitsluitend het opaque token in de URL, niet een
  ingelogde staff-sessie. Klassieke session-riding-CSRF is hier dus
  structureel niet van toepassing, net zoals bij OfferteApp's publieke
  route (die overigens wél CSRF-tokens gebruikte, omdat Flask-WTF dat
  globaal afdwingt voor élke POST in die app — hier is dat een bewuste,
  aparte afweging, geen kopieerplicht). Aanbevolen, lichte
  aanvullende maatregel: `Origin`/`Referer`-header-check op de POST als
  defense-in-depth (triviaal toe te voegen, geen library nodig).
- **Redirect-target**: uitsluitend server-side bepaald (§6) — nooit uit
  de request. Zelfde regel, zelfde bewezen testaanpak (tamper-pogingen
  met extra velden hebben geen effect).
- **Geen PII op de publieke pagina** buiten het offertenummer.
- **Audit**: `AuditEvent.userId` is nullable — een
  `delivery_date.requested`-achtige actie kan gelogd worden met
  `userId: null`, `entityType: "delivery_date_handoff"`,
  `entityId: <rij-id>`, zonder een nieuwe uitzondering op het bestaande
  patroon te hoeven verzinnen.
- **Shopify-schrijfveiligheid**: `assertShopifyShopIdentity()` vóór elke
  mutatie, exact zoals `CLAUDE.md` voorschrijft — dit wordt de eerste
  echte toepassing van die al voorbereide functie.

## 11. Staging strategy

Twee gescheiden lagen om rekening mee te houden:

- **Portal-niveau** (database, code, deploy): volledig gescheiden
  staging/production zoals altijd (§1) — `fly deploy -c fly.toml` naar
  `stones4u-control-center-staging`, nooit naar production, exact zoals
  bij elke eerdere fase in dit repo.
- **Shopify-niveau — het punt waar dit portal fundamenteel anders zit
  dan OfferteApp**: staging en production van dit portal wijzen op
  **dezelfde, echte Stones4U-winkel** (§3). Er is geen ingebouwde
  portal-eigen dev-store-scheiding. Voor een veilige, live Draft→Order-
  verificatie (zoals net bewezen voor OfferteApp) zijn er twee opties:
  1. **Tijdelijk** `SHOPIFY_SHOP_DOMAIN`/`_CLIENT_ID`/`_CLIENT_SECRET`/
     `_EXPECTED_MYSHOPIFY_DOMAIN` op de **portal-staging**-omgeving
     overschrijven met een custom-app-koppeling voor **dezelfde
     `stones4u-dev.myshopify.com`-teststore** die deze week al voor
     OfferteApp is ingericht — deze store is niet aan OfferteApp
     gebonden, hij kan door elke Stones4U-applicatie als veilige
     testomgeving gebruikt worden. Vereist een eigen custom-app-
     koppeling in die winkel (los van OfferteApp's eigen koppeling
     daar), met minimaal `read_draft_orders`, `write_draft_orders`,
     `read_orders`, `read_customers` (laatste is nodig zoals live bleek
     bij OfferteApp, voor het geneste `customer`-veld in
     `get_draft_order()`-achtige queries).
  2. Een verificatie tegen de echte productiewinkel uitvoeren, met
     dezelfde synthetische-datahygiëne als bewezen (custom line item,
     geen echte klant, duidelijk gemarkeerd, direct opgeruimd) — hoger
     risicoprofiel dan optie 1, alleen te overwegen als optie 1 om een
     andere reden niet haalbaar blijkt.

  **Aanbeveling: optie 1.** Dit vereist geen enkele wijziging aan
  OfferteApp — alleen nieuwe, eigen Shopify-custom-app-credentials voor
  het portal, tijdelijk op de portal-staging-omgeving, precies zoals de
  portal zijn eigen Shopify-config al via env vars regelt (§3).

## 12. Migration impact

Precies één additieve Prisma-migratie, zelfde risicoprofiel als
OfferteApp's `requested_delivery_date`-kolom:
- Nieuwe tabel `DeliveryDateHandoff` (of gekozen naam) — geen wijziging
  aan een bestaande tabel, dus geen enkel risico voor bestaande data.
- Geen backfill, geen destructieve DDL.
- Volgt de bestaande migratieconventie
  (`YYYYMMDDHHMMSS_phaseX_beschrijving`, zie §1's migratielijst) —
  vermoedelijk `..._phaseN_quote_delivery_date_handoff`.
- `npx prisma migrate dev` lokaal/staging, `npx prisma migrate deploy`
  als `release_command` op productie (bestaand patroon, ongewijzigd).

## 13. Dingen die NIET in OfferteApp hoeven te veranderen (Fase A)

- Niets aan `Quote.requested_delivery_date`, de bestaande OfferteApp-
  migratie, of de bestaande `/delivery/<uuid>`-route in OfferteApp zelf
  — die blijft precies zoals hij nu, gecommit maar nog niet gedeployed,
  op `origin/master` staat.
- Niets aan `/api/integrations/control-center/quotes` (het bestaande
  read-only endpoint dat `src/integrations/quotes/adapter.ts` al
  gebruikt) — Fase A heeft er niets extra van nodig, want de nieuwe
  handoff-flow gebruikt Shopify rechtstreeks (§6), niet OfferteApp.
- Niets aan de bestaande OfferteApp-factuurmail of CTA — die blijft (nog)
  naar OfferteApp's eigen `/delivery/<uuid>` wijzen totdat er, apart en
  expliciet (Fase B, §14), besloten wordt hoe/of dat verandert.
- Geen enkele database- of Fly-actie tegen OfferteApp's staging of
  productieomgeving.

## 14. Onderdelen die pas later nodig zijn (Fase B — niet nu uitvoeren)

- Bepalen of/hoe bestaande (en toekomstige) OfferteApp-facturatiemails
  naar de nieuwe portal-handoff-URL gaan verwijzen in plaats van naar
  OfferteApp's eigen `/delivery/<uuid>` — vereist een wijziging in
  OfferteApp's mailflow (`bezoekrapport/api.py`'s CTA-URL-opbouw,
  al bewezen aanpasbaar deze week) en een besluit over welke van de twee
  systemen dan de "echte" handoff wordt.
- OfferteApp's read-only integratie-endpoint uitbreiden met de Mollie-
  checkout-URL/`payment_link_provider`-status, om het Mollie-pad ook
  native in het portal te ondersteunen (§8).
- Eventuele deduplicatie/migratie van reeds via OfferteApp lopende,
  nog-niet-beantwoorde handoff-verzoeken naar het portal (waarschijnlijk
  niet nodig zolang OfferteApp's eigen flow niet in productie draait —
  te herbevestigen zodra dat wel gebeurt).
- Beslissen of `QuotesTable.tsx` de portal-eigen
  `requestedDeliveryDate` gaat tonen als vaste kolom (klein, niet-
  risicovol, maar wel een expliciete UI-beslissing, niet stilzwijgend
  meenemen in Fase A).

## 15. Voorgestelde implementatiefasen

1. **Fase 1 — schema + Shopify write-capability**: `DeliveryDateHandoff`-
   model + migratie (§4, §12); nieuwe, expliciet afgezonderde Shopify-
   mutatiecode (`assertShopifyShopIdentity()`, single-draft-order-fetch,
   `customAttributes`-read-merge-write) (§3, §7); scope-uitbreiding
   `write_draft_orders` in Shopify Admin (geen herautorisatiestap nodig,
   §3).
2. **Fase 2 — publieke handoff-route**: `GET`/POST-flow (§5), Shopify-
   pad volledig werkend, Mollie-pad expliciet als "geen betaallink
   beschikbaar"-nette-foutmelding (§8), server-authoritative
   redirect-target (§6), audit-logging (§10).
3. **Fase 3 — CRM-weergave**: `requestedDeliveryDate` zichtbaar maken op
   Customer 360 (join naast `QuotesTable`, §9) — puur portal-eigen,
   geen OfferteApp-afhankelijkheid.
4. **Fase 4 — staging-verificatie**: dezelfde live Draft→Order-hardgate
   als bewezen bij OfferteApp, tegen `stones4u-dev.myshopify.com` via
   tijdelijke portal-staging-credentials (§11), volledige security-E2E,
   volledige testsuite, alleen op `stones4u-control-center-staging`.
5. **Fase 5 — expliciete, aparte opdracht van Fons**: pas daarna, en
   alleen na uitdrukkelijke nieuwe toestemming, Fase B (§14) oppakken en/
   of een productiedeploy overwegen. Niet automatisch aansluitend op
   Fase 4.

## Aanbevolen architectuur — samenvatting

**Eén zin**: een nieuwe, Control-Center-eigen `DeliveryDateHandoff`-
entiteit (optie C), gekoppeld via `sourceSystem`+`externalId` aan de
externe offerte (nooit een kopie), met een eigen opaque `publicToken`,
een nieuwe publieke `/delivery/[token]`-route buiten de bestaande
auth-grens, een Shopify-mirror die het portal's eigen — nu voor het eerst
gebruikte — client-credentials-schrijfpad benut (na een scope-
uitbreiding die geen herautorisatiestap vergt), en een Mollie-pad dat in
Fase A bewust onbeschikbaar blijft totdat een aparte, expliciete Fase-B-
beslissing over een OfferteApp-uitbreiding wordt genomen — zonder dat
OfferteApp zelf op enig moment in Fase A t/m 4 wordt aangeraakt.

PORTAL QUOTE DELIVERY DATE DISCOVERY: COMPLETE
