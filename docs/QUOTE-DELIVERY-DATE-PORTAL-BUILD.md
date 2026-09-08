# Quote Delivery Date — Portal Build (Fase 2A + 2B)

**Status**: Fase 2A volledig gebouwd. Fase 2B **gedeployed en geverifieerd**
naar `stones4u-control-center-staging`, met dedicated dev-store-credentials
en een bewezen geïsoleerde write-allowlist. **Geen enkele live Shopify-
mutatie uitgevoerd** — alleen read-only calls. `D:\Shopify\OfferteApp` en
`https://offerteapp.fly.dev/` zijn op geen enkel moment geopend, gelezen of
aangeraakt. `stones4u-control-center` (productie) is uitsluitend
read-only bevraagd (`fly secrets list`, geen waarden) ter vergelijking —
nooit gewijzigd, gedeployed of herstart.

**Bekende blocker voor Fase 2C** (ontdekt tijdens Fase 2B's read-only
scope-verificatie, zie §16.6): de `write_draft_orders`-scope staat wel
geconfigureerd in de Shopify-Admin-app, maar is **niet** daadwerkelijk aan
de actieve installatie toegekend — live bevestigd via
`currentAppInstallation.accessScopes`. Dit blokkeert Fase 2B zelf niet
(de write-allowlist-isolatie is domain-based, niet scope-based, en is
onafhankelijk bewezen), maar moet vóór Fase 2C's eerste echte
`draftOrderUpdate`-poging opgelost worden.

Zie `docs/QUOTE-DELIVERY-DATE-PORTAL-DISCOVERY.md` voor de onderliggende
architectuuranalyse waar deze build op voortbouwt.

## 1. Data model

`prisma/schema.prisma` — twee additieve migraties:
`20260908154729_phase7_delivery_date_handoff` (nieuwe tabel + 3 enums) en
`20260908154948_phase7b_delivery_date_activity` (nieuwe `ActivityType`-
waarde + één nieuwe, nullable Activity-kolom). Geen wijziging aan een
bestaande kolom, geen backfill, geen destructieve DDL — geverifieerd via
`npx prisma migrate status` (10 migraties, "Database schema is up to
date") en handmatige inspectie van beide `migration.sql`-bestanden.

```prisma
enum QuoteSourceSystem { SHOPIFY OFFERTEAPP S4U_QUOTE_APP }
enum PaymentProvider   { SHOPIFY MOLLIE UNKNOWN }
enum DeliveryDateHandoffStatus { PENDING MIRRORED ERROR }

model DeliveryDateHandoff {
  id                    String   @id @default(cuid())
  publicTokenHash       String   @unique
  sourceSystem          QuoteSourceSystem
  externalId            String
  shopifyDraftOrderGid  String?
  customerProfileId     String?
  customerProfile       CustomerProfile? @relation(fields: [customerProfileId], references: [id])
  requestedDeliveryDate DateTime? @db.Date
  paymentProvider       PaymentProvider @default(UNKNOWN)
  status                DeliveryDateHandoffStatus @default(PENDING)
  lastMirrorAt          DateTime?
  mirrorErrorCode       String?
  createdById           String
  createdBy             User @relation(fields: [createdById], references: [id])
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  activities Activity[]

  @@unique([sourceSystem, externalId])
  @@index([customerProfileId])
  @@index([shopifyDraftOrderGid])
}
```

Nooit een kopie van het externe object — `sourceSystem` + `externalId` is
uitsluitend een verwijzing, exact hetzelfde patroon als
`OpportunityExternalLink`/`ExternalContactMatch`. Fase A maakt uitsluitend
`sourceSystem = SHOPIFY`-rijen aan, met `externalId ==
shopifyDraftOrderGid` (beide velden bewust apart gehouden — zie discovery
§4 voor de motivatie: een toekomstige `OFFERTEAPP`/`S4U_QUOTE_APP`-rij
verandert dan nooit de betekenis van deze kolommen). `OFFERTEAPP`/
`S4U_QUOTE_APP` bestaan als enum-waarden maar hebben nog geen enkele
producer — zelfde "voorbereid, nog niet actief"-patroon als
`ActivityType.QUOTE_CREATED` eerder al gebruikte.

`@@unique([sourceSystem, externalId])` geeft natuurlijke idempotentie op
aanmaakniveau: een tweede `createDeliveryDateHandoff()`-aanroep voor
dezelfde Draft Order geeft de bestaande rij terug, nooit een duplicaat.

## 2. Token security

`src/modules/delivery/token.ts`. Zelfde techniek als
`Session.tokenHash` (`src/platform/auth/session.ts`, al bestaand in dit
repo): een 256-bit CSPRNG raw token
(`randomBytes(32).toString("base64url")`), waarvan uitsluitend de
HMAC-SHA256-hash (`publicTokenHash`) wordt opgeslagen. De raw token wordt
**precies één keer** teruggegeven, op het moment van aanmaken
(`createDeliveryDateHandoff()`'s returnwaarde) — daarna is hij nergens
meer af te leiden, ook niet door iemand met volledige databasetoegang.

**Waarom een apart veld/secret, niet hergebruik van `id` of
`SESSION_SECRET`** (zie ook discovery §10): dit repo's `id`-velden zijn
al niet-sequentiële Prisma `cuid()`-waarden — het enumeratierisico dat
OfferteApp's aparte `Quote.uuid` (naast een numerieke autoincrement-
primary-key) oploste, is hier intrinsiek al kleiner. Een apart
`publicTokenHash`-veld is toch gekozen, om twee andere, concrete redenen:
(1) een publiek token moet ooit onafhankelijk van de rij te **roteren**
zijn (bijv. na een vermoeden van lekkage) zonder de rij zelf opnieuw aan
te hoeven maken — hergebruik van `id` zou dat onmogelijk maken; (2) het
voorkomt dat een toekomstige, terloopse "toon de rij-id in een admin-
URL"-gewoonte per ongeluk hetzelfde ID als publiek geheim hergebruikt. Een
**apart** `DELIVERY_HANDOFF_TOKEN_SECRET` (niet `SESSION_SECRET`) is
gekozen omdat het een andere tokenklasse is met een ander
blootstellingsoppervlak (een handoff-token wordt gemaild/gedeeld buiten
elke sessie om; een sessietoken verlaat nooit een httpOnly-cookie) en een
andere rotatiebehoefte — hergebruik van dezelfde HMAC-sleutel zou twee
losstaande belangen onnodig koppelen. Fail-closed in productie (gooit een
harde fout zonder `DELIVERY_HANDOFF_TOKEN_SECRET`), met een duidelijk
gelabelde, onveilige ontwikkel-fallback + eenmalige waarschuwing —
identiek gedrag aan `SESSION_SECRET`.

## 3. Public routes

- `GET /delivery/[token]` (`src/app/delivery/[token]/page.tsx`) — publiek,
  geen `getSessionUser()`/`requireUser()`-aanroep (zelfde precedent als
  `src/app/login`, de enige andere publieke pagina in dit repo). Onbekend/
  ongeldig token → `notFound()` (generieke 404, geen onderscheid tussen
  "malformed" en "onbekend maar geldig gevormd"). Toont uitsluitend een
  datumkeuzeveld — geen offertenummer, geen naam/e-mail/telefoon; er is
  zelfs minder te tonen dan bij OfferteApp's equivalent, omdat Fase A geen
  enkele koppeling met een extern offertesysteem heeft.
- `POST /api/delivery/[token]` (`src/app/api/delivery/[token]/route.ts`)
  — publiek. Dit repo gebruikt overal client-side React-formulieren die
  naar JSON-API-routes `fetch()`en (bevestigd via `src/app/login`'s
  `LoginForm.tsx` — geen server-rendered `<form method="POST">`-
  precedent zoals bij OfferteApp), dus dezelfde conventie is hier
  gevolgd: de route retourneert `{ redirectUrl }` op succes, en de
  cliëntcomponent (`DeliveryDateForm.tsx`) doet
  `window.location.href = redirectUrl` — de server bepaalt nog steeds
  volledig het target, de client navigeert er alleen naartoe.

## 4. Validation

`parseRequestedDeliveryDate()` in `src/modules/delivery/delivery-
handoff.service.ts`: geldige `YYYY-MM-DD`, niet in het verleden (UTC-
kalenderdag-vergelijking, tijdzone-onafhankelijk). Vandaag is geldig.
Ongeldig: leeg, malformed, en expliciet ook een out-of-range kalenderdatum
(`2026-02-30` — JavaScript's `Date`-constructor rolt dit stilzwijgend door
naar begin maart in plaats van te falen, dus een expliciete round-trip-
check vangt dit). Geen weekend-, feestdag-, capaciteit- of
leadtime-regels — exact de scope-grens uit de opdracht.

## 5. Shopify mirror service

`src/integrations/shopify/draft-order-mirror.ts` —
**Control Center's allereerste Shopify-write**, bewust in een eigen
bestand gehouden (niet toegevoegd aan het bestaande, read-only
`draft-orders.ts`) zodat de Phase-1-"geen mutaties"-grens zichtbaar en
makkelijk te reviewen/terug te draaien blijft.

Read-merge-write, identiek bewezen patroon als OfferteApp: bestaande
`customAttributes` ophalen, exact de eigen sleutel (`requested_delivery_
date`) vervangen (nooit dupliceren), overige attributen ongewijzigd
laten, een `draftOrderUpdate`-mutatie met **uitsluitend**
`customAttributes` in de input versturen (nooit een bredere payload die
line items/customer/shipping zou kunnen overschrijven).

`assertShopifyWriteAllowed()` (§6) wordt als allereerste stap aangeroepen
— vóór er ook maar iets van de mutatie is opgebouwd of verstuurd.

## 6. Minimal Shopify fields / scopes

De query voor de mirror-stap:
```graphql
query DraftOrderForMirror($id: ID!) {
  draftOrder(id: $id) {
    id
    invoiceUrl
    customAttributes { key value }
  }
}
```
**Bewust geen `customer`-veld** — OfferteApp's equivalente build bewees
live dat het bevragen van `DraftOrder.customer` een aparte
`read_customers`-scope vereist; deze flow heeft nergens klantgegevens
nodig, dus die scope wordt nooit aangevraagd. `invoiceUrl` wordt in
dezelfde aanroep meegenomen (geen extra scope nodig, al gebruikt door de
bestaande, read-only `draft-orders.ts`) zodat er geen tweede Shopify-
aanroep nodig is om het betaal-target te bepalen.

**Scopes, huidige staat vs. benodigd**:
- `read_draft_orders` — al aanwezig sinds Fase 1.
- `read_orders` — al aanwezig sinds Fase 1 (voor een latere Draft→Order-
  verificatie, Fase 2C).
- `write_draft_orders` — **ontbreekt nog**, moet worden toegevoegd aan de
  custom app's Admin API access scopes in Shopify Admin. Omdat dit een
  **client-credentials**-app is (ADR-006), is er — anders dan bij
  OfferteApp's OAuth-authorization-code-app — **geen interactieve
  browser-herautorisatiestap nodig**: de eerstvolgende tokenvernieuwing
  haalt de nieuwe scope automatisch op zodra de scope-configuratie in
  Shopify Admin is aangepast.
- `read_customers` — **bewust niet aangevraagd**, niet nodig voor deze
  flow.

## 7. Staging safety guard

`src/integrations/shopify/write-safety-guard.ts` —
`assertShopifyWriteAllowed()`. Fail-closed, uniform ontwerp: leest
uitsluitend `SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS` (komma-gescheiden
lijst van toegestane `myshopifyDomain`-waarden) uit de environment van de
huidige omgeving, haalt live de daadwerkelijke shop op
(`shop { myshopifyDomain }`), en gooit een harde configuratiefout
(`ShopifyConfigError`) als de lijst leeg/ongezet is, of een
`ShopifyShopIdentityMismatchError` als de live shop er niet op staat.
**Geen enkele omgevingsnaam-branch** (geen `if (APP_ENV ===
"production")` waar dan ook) — de goedgekeurde winkel-naam leeft
uitsluitend in config, nooit in bedrijfslogica, dus exact dezelfde code
gedraagt zich identiek veilig in elke omgeving.

Waarom dit een **apart** mechanisme is van het al bestaande
`assertShopifyShopIdentity()` (`guard.ts`): die vergelijkt de live shop
met een SINGLE verwachte waarde uit dezelfde omgeving's eigen config
(`SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN`) — en die staat vandaag in **elke**
omgeving (staging én productie) op de echte Stones4U-winkel, omdat
staging en productie vandaag dezelfde winkel delen (discovery §3/§11).
`assertShopifyShopIdentity()` alleen zou staging dus vandaag gewoon laten
schrijven naar de echte winkel. Dit vereiste een tweede, écht
schrijf-specifieke guard.

**Huidige lokale/test-staat**: `SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS`
staat nergens gezet (niet in `.env`, niet in Fly-config) → elke
schrijfpoging faalt vandaag overal fail-closed, inclusief op deze
ontwikkelmachine. Dit is bewust zo gelaten — Fase 2B moet dit expliciet
en alleen voor staging, met de dev-store-waarde, configureren.

## 8. Payment target authority

`resolvePaymentTarget()` in `delivery-handoff.service.ts` — het
`SubmitResult` (`{ redirectUrl }`) komt uitsluitend voort uit
server-side opgeslagen/opgevraagde data (`handoff.paymentProvider` uit de
database, `invoiceUrl` uit de live Shopify-mirror-respons). De
functiesignatuur van `submitRequestedDeliveryDate(handoff,
rawDateInput)` accepteert letterlijk geen `provider`-, `redirect`-,
`next`-, `invoiceUrl`- of `paymentUrl`-parameter — er is dus geen
codepad waarlangs de browser dit zou kunnen beïnvloeden, bevestigd zowel
door de signatuur zelf als door een expliciete test (§16).

## 9. Mollie behavior

Bevestigd tijdens discovery: Mollie bestaat nergens in dit repo. Fase A
bouwt **geen** Mollie-integratie, leest OfferteApp niet uit, wijzigt
OfferteApp niet, maakt nooit een duplicaat-betaling aan. Wanneer een
`DeliveryDateHandoff.paymentProvider === "MOLLIE"` (of `"UNKNOWN"`) is,
faalt `resolvePaymentTarget()` gesloten met een expliciete, niet-
retryable `DeliveryHandoffError` ("nog niet beschikbaar... Neem contact
op met Stones4U") — nooit een stille terugval naar Shopify, nooit een
redirect naar een client-aangeleverde Mollie-URL. Fase A's eigen
`createDeliveryDateHandoff()` zet zelf altijd `paymentProvider = SHOPIFY`
— de `MOLLIE`/`UNKNOWN`-paden bestaan uitsluitend als voorbereid,
getest, fail-closed gedrag voor een latere fase.

## 10. Timeline behavior

Nieuwe `ActivityType.DELIVERY_DATE_REQUESTED` — category-A (Control-
Center-eigen rij), met `actorId: null` (de klant is de "actor", geen
staflid — zelfde precedent als `AuditEvent.userId`'s nullable ontwerp).
Geschreven **uitsluitend** wanneer `requestedDeliveryDate` voor het eerst
gezet wordt of daadwerkelijk verandert (kalenderdag-vergelijking vóór de
update) — nooit bij een `GET`, nooit bij een hersubmit van dezelfde
datum (geen timeline-spam, expliciet getest). Nooit geschreven wanneer de
handoff geen `customerProfileId` heeft (het schema dwingt dit al af:
`Activity.customerProfileId` is verplicht).

`AuditEvent`-rijen (`delivery_handoff.created`,
`delivery_handoff.date_requested`, `delivery_handoff.mirror_failed`)
worden wél bij **elke** aanmaak/submit/mirror-poging geschreven,
ongeacht of de datum veranderde — audit is een technisch logboek, geen
klant-zichtbare tijdlijn, dus daar geldt de anti-spam-regel niet.

## 11. Backoffice display

`DeliveryDateHandoffsPanel.tsx`, read-only, gewired in Customer 360's
"Commercieel"-tab (`src/app/(app)/customers/[id]/page.tsx`,
`CommercialTab`), naast de al bestaande `QuotesTable`/`DraftOrdersTable`.
Toont: datum (of "Nog niet gekozen", met een expliciete "(wens, geen
toezegging)"-annotatie), bron (`shopifyDraftOrderGid`), status-badge.
Geen edit-control, geen enkele koppeling met een transport-/
planningsveld (dit repo heeft er nog geen — zie §12).

## 12. Domain isolation

`requestedDeliveryDate` wordt nergens automatisch naar een ander veld
gekopieerd of gebruikt om iets te triggeren — bevestigd door **afwezigheid**:
er bestaat in dit repo (nog) geen `hoefnagels_delivery_date`-equivalent,
geen transportplanningsmodule, geen shipment-aanmaakcode om per ongeluk
aan te raken. De scheidingsregel is hier dus een **toekomstvaste
ontwerpregel** (voor als een Operations-module ooit landt), niet de fix
van een bestaand conflict zoals bij OfferteApp. Geen test hiervoor
gefabriceerd tegen een veld dat niet bestaat — dat zou een misleidende
test zijn; in plaats daarvan is dit hier expliciet gedocumenteerd.

## 13. Tests

Twee nieuwe bestanden, 29 tests, allemaal via de service-laag (dit repo's
eigen conventie — geen enkele bestaande test roept een Next.js
route-handler direct aan; API-routes blijven dun en ongetest op HTTP-
niveau, zelfde patroon overal in dit repo):

**`tests/delivery-handoff.test.ts`** (20 tests, echte lokale database,
Shopify-mirror gemockt via `vi.mock`):
- data model: create, hash-only-opslag (nooit de raw token), idempotente
  create per `(sourceSystem, externalId)`, resolve alleen via het juiste
  token (een losstaand gegenereerd token matcht nooit), onbekend/
  malformed token → `null`, nooit een crash.
- datumvalidatie: vandaag, toekomst, verleden, malformed, leeg,
  out-of-range kalenderdatum.
- volgorde: lokaal opgeslagen vóór mirror (blijft staan bij mirror-
  falen), mirror vóór redirect (geen redirect bij falen), mirror wordt
  helemaal niet aangeroepen bij een ongeldige datum.
- beveiliging: het redirect-target komt uitsluitend uit server-side
  data — bewezen zowel via de functiesignatuur (geen provider/redirect-
  parameter bestaat) als een expliciete test.
- idempotentie: zelfde datum tweemaal → precies één Activity, geen
  duplicaat-rij; een echt gewijzigde datum → een tweede Activity, laatste
  datum wint; geen Activity zonder gekoppelde klant.
- Mollie: `paymentProvider = MOLLIE` én `UNKNOWN` falen beide gesloten,
  niet-retryable, met een duidelijke boodschap, zonder de lokaal
  opgeslagen datum te verliezen.
- backoffice: alleen handoffs van de opgevraagde klant, nieuwste eerst.

**`tests/delivery-handoff-shopify.test.ts`** (9 tests, echte `fetch`-
mocking via `vi.stubGlobal`, exact het patroon van het al bestaande
`tests/shopify-draft-orders.test.ts`):
- staging-safety-guard: fail-closed zonder allowlist (geen enkele
  Shopify-aanroep gedaan); toegestaan wanneer de live shop op de
  allowlist staat; **hard-fail in het exacte staging-scenario** (live
  shop = de echte productiewinkel, allowlist = alleen de dev-store);
  case-insensitief + komma-gescheiden lijst ondersteund.
- mirror: nooit een `draftOrder`-query of `draftOrderUpdate`-mutatie
  verstuurd wanneer de guard faalt (precies 2 aanroepen: token +
  identiteitscheck, nooit een derde); attribuut toevoegen wanneer er nog
  geen bestaat, met een query die nooit `customer` bevraagt; bestaande,
  ongerelateerde attributen blijven behouden en de eigen sleutel wordt
  precies één keer vervangen (nooit gedupliceerd); een
  `userErrors`-respons gooit een fout; een niet langer bestaande Draft
  Order gooit een fout.

**Bewust niet als runtime-test gebouwd** (met reden): "provider
tampering"/"redirect tampering" als los scenario — de functiesignatuur
zelf sluit dit uit (zie §8), een test die een niet-bestaande parameter
"probeert te manipuleren" zou niets zinvols bewijzen. "Geen
`hoefnagels_delivery_date`-mutatie" — dat veld bestaat niet in dit repo
(zie §12).

## 14. Full suite

`npx vitest run` (parallel, standaardgedrag): 575/575 tests slagen op
zichzelf; in enkele runs faalde één ander, al bestaand bestand
(`tests/matching.test.ts`, een AMBIGUOUS-confidence-test) — **niet**
gerelateerd aan deze build. Bevestigd via `npx vitest run --no-file-
parallelism`: **575/575 slagen altijd**, inclusief `matching.test.ts`,
wanneer testbestanden serieel i.p.v. parallel draaien. Dit repo's
teststrategie deelt één echte Postgres-database tussen alle parallel
draaiende testbestanden (geen per-bestand transactie-isolatie) — een
reeds bestaande karakteristiek, hier alleen zichtbaarder geworden doordat
twee nieuwe testbestanden de gelijktijdige databaselast verhoogden. Geen
enkele wijziging in dit testbestand of zijn code is nodig gebleken om dit
te verhelpen; niet als bug van deze build behandeld, wel hier eerlijk
vastgelegd in plaats van stilzwijgend als "groen" gerapporteerd.

## 15. Rollout gates

1. **Fase 2A (dit document)** — af. Model, migraties, token, publieke
   routes, validatie, service-architectuur, Shopify-adapter + mock-tests,
   staging-write-safety-guard, backoffice-weergave. Geen enkele live
   Shopify-write uitgevoerd.
2. **Fase 2B** — configuratie, geen code:
   - `write_draft_orders` toevoegen aan de custom app's Admin API access
     scopes in Shopify Admin (geen herautorisatiestap nodig, §6).
   - Een **aparte** custom-app-koppeling in `stones4u-dev.myshopify.com`
     aanmaken (los van OfferteApp's eigen koppeling daar), met
     `read_draft_orders`, `write_draft_orders`, `read_orders`.
   - Op `stones4u-control-center-staging` **uitsluitend**:
     `SHOPIFY_SHOP_DOMAIN`/`_CLIENT_ID`/`_CLIENT_SECRET` naar die
     dev-store-koppeling wijzen, én
     `SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS=stones4u-dev.myshopify.com`
     zetten. **Nooit** de productie-Fly-secrets aanraken.
   - Vóór enige write: bevestigen dat de staging-config metadata
     (`shop.myshopifyDomain` live opgevraagd) daadwerkelijk de dev-store
     teruggeeft — read-only verificatie, geen mutatie.
3. **Fase 2C** — pas ná 2B: echte staging-E2E tegen
   `stones4u-dev.myshopify.com` (synthetische Draft Order, geen echte
   klant, geen echte betaling), inclusief de Draft→Order-
   attribuutoverlevingsverificatie zoals eerder bewezen voor OfferteApp.
4. **Pas daarna, na expliciete nieuwe toestemming van Fons**: een
   eventuele productie-deploy overwegen. Niet automatisch aansluitend.

## 16. Fase 2B — staging/dev-store-isolatie (2026-09-08)

### 16.1 Pre-flight — huidige Shopify-config (read-only, geen waarden)

Effectieve env vars gelezen door `getShopifyConfig()`
(`src/integrations/shopify/client.ts`): `SHOPIFY_SHOP_DOMAIN`,
`SHOPIFY_API_VERSION`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`
(client-credentials, ADR-006). Geen OAuth-verbonden-store-DB-tabel zoals
bij OfferteApp — de shop wordt uitsluitend via deze vier env vars bepaald,
niets anders. `assertShopifyShopIdentity()` (`guard.ts`) leest daarnaast
`SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN`.

Op `stones4u-control-center-staging` (`fly secrets list`, alleen namen/
digests, geen waarden):

| Var | Aanwezig | Vergelijking met productie |
|---|---|---|
| `SHOPIFY_SHOP_DOMAIN` | ja | **identieke digest** als productie |
| `SHOPIFY_CLIENT_ID` | ja | **identieke digest** als productie |
| `SHOPIFY_CLIENT_SECRET` | ja | **identieke digest** als productie |
| `SHOPIFY_API_VERSION` | ja | identieke digest als productie |
| `SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN` | ja | identieke digest als productie |
| `SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS` | **nee** | n.v.t. — bestaat nog niet |
| `DELIVERY_HANDOFF_TOKEN_SECRET` | **nee** | n.v.t. — Fase 2A-code nog niet gedeployed |

**Digest-vergelijking (geen waarden gelezen, uitsluitend Fly's eigen
digest-hashes naast elkaar gelegd) bewijst onomstotelijk**: staging
gebruikt vandaag letterlijk dezelfde `SHOPIFY_CLIENT_ID` **én**
`SHOPIFY_CLIENT_SECRET` als productie, tegen dezelfde
`SHOPIFY_SHOP_DOMAIN`/`SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN` — bevestigt
exact het discovery-§3/§11-risico, nu met harde evidentie i.p.v. een
aanname.

API-versie: `2026-07` (zelfde als lokaal `.env.example`).

**Runtime-cachinggedrag**: alleen het Shopify **access token** wordt
in-memory gecached (`cachedToken`, module-scope, TTL-gebaseerd,
`client.ts`) — `SHOPIFY_SHOP_DOMAIN` en de overige config-vars worden bij
elke aanroep vers uit `process.env` gelezen (`getShopifyConfig()`), nooit
gecached. Een Fly-secret-update vereist dus geen codewijziging, wel een
procesherstart om de nieuwe env-waarden te laten gelden — `fly secrets
set` triggert dit automatisch (standaard Fly-gedrag, rolling restart van
de machines), geen aparte handeling nodig.

Huidige scopes (Fase 1, gedeeld tussen staging en productie, uit
`README.md`): `read_customers`, `read_orders`, `read_draft_orders`. Geen
enkele write-scope. Niet live opnieuw opgevraagd via een Shopify-call (dat
zou een onnodige aanroep tegen de — vandaag nog echte — productiewinkel
zijn vanuit staging-credentials; de README is hier al autoritatief en
consistent met wat in Fase 2A al vastgesteld werd).

### 16.2 Production safety snapshot

**PRODUCTION CONFIG CHANGES PLANNED: NONE.** Uitsluitend
`fly secrets list --app stones4u-control-center` uitgevoerd (namen/
digests, geen waarden) — puur ter vergelijking met staging, geen enkele
schrijfactie. Geen production-secret gewijzigd, geen production-deploy,
geen production-restart, geen production-database-actie.

### 16.3 Shopify dev-app requirements — exacte scopes (Fase 2C-doel)

Bepaald vanuit de daadwerkelijke code (`src/integrations/shopify/
draft-order-mirror.ts`, `write-safety-guard.ts`), niet aangenomen:

- `read_draft_orders` — al aanwezig (Fase 1).
- `write_draft_orders` — **ontbreekt**, nodig voor
  `draftOrderUpdate`/`customAttributes`.
- `read_orders` — al aanwezig (Fase 1), nodig voor de latere Fase-2C
  Draft→Order-verificatie.
- `read_customers` — **niet nodig** voor deze feature. `grep` op
  `draft-order-mirror.ts` bevestigt: geen `customer`-veld in de query.
  Wel al aanwezig in de bestaande, gedeelde app-scopes (Fase 1, voor
  Customer 360's eigen klant-opzoekfunctie) — dat is ongerelateerd en
  blijft ongewijzigd.

Voor een **nieuwe, dedicated** client-credentials-app in
`stones4u-dev.myshopify.com` (zie §16.4): minimaal `read_draft_orders`,
`write_draft_orders`, `read_orders` — geen `read_customers` nodig tenzij
een latere, andere feature dat expliciet vereist.

### 16.4 STOP — dedicated staging-credentials bestaan nog niet (opgelost, zie §16.10)

Geverifieerd (§16.1): de enige Shopify-credential die
`stones4u-control-center-staging` vandaag heeft, is letterlijk de
productie-credential. Er is geen aanwijzing dat er al een aparte,
dedicated client-credentials-app voor Control Center in
`stones4u-dev.myshopify.com` bestaat — en die zou hoe dan ook **niet**
dezelfde app mogen zijn als de OAuth-authorization-code-app die Fons
eerder deze week voor OfferteApp in dezelfde dev-store aanmaakte (ander
grant-type — client-credentials heeft geen App URL/redirect-URLs/
consentscherm nodig, authorization-code wel; hergebruik zou bovendien de
twee systemen se credentials vermengen, tegen de expliciete
"dedicated"-eis in).

Conform instructie §4: **hier gestopt, vóór elke configuratiewrite.**

**Wat Fons moet doen in Shopify Admin, exact:**

1. Open `stones4u-dev.myshopify.com` → Instellingen → Apps en
   verkoopkanalen → Apps ontwikkelen.
2. **Nieuwe** custom app aanmaken, specifiek voor Control Center
   (bijv. "Stones4U Control Center — staging") — niet de bestaande
   OfferteApp-dev-app hergebruiken.
3. Configuration → Admin API integration → **API scopes**: exact
   `read_draft_orders`, `write_draft_orders`, `read_orders` aanvinken
   (§16.3). Geen `read_customers`, geen bredere scopes.
4. **Client credentials-toegang inschakelen** (niet de gewone
   installatie-/access-token-flow die OfferteApp gebruikt) —
   "API credentials"-tabblad, "Client credentials"-sectie, activeren.
   Dit levert een **Client ID** en **Client Secret** op (het
   OAuth-`client_credentials`-paar, exact wat `getShopifyConfig()`
   verwacht — géén losse Admin API access token zoals bij het
   token-gebaseerde installatiepad).
5. Client ID + Client Secret **niet delen in chat** — rechtstreeks
   zetten via, op `stones4u-control-center-staging` uitsluitend:
   ```
   fly secrets set --app stones4u-control-center-staging SHOPIFY_SHOP_DOMAIN="stones4u-dev.myshopify.com"
   fly secrets set --app stones4u-control-center-staging SHOPIFY_CLIENT_ID="<client id>"
   fly secrets set --app stones4u-control-center-staging SHOPIFY_CLIENT_SECRET="<client secret>"
   fly secrets set --app stones4u-control-center-staging SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN="stones4u-dev.myshopify.com"
   fly secrets set --app stones4u-control-center-staging SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS="stones4u-dev.myshopify.com"
   ```
   (`SHOPIFY_API_VERSION` kan ongewijzigd blijven — een API-versiestring
   is geen credential en identiek geldig voor beide winkels.)

Zodra dit gezet is, kunnen §16.5 t/m §16.13 (allowlist-verificatie,
staging-deploy, staging-migratie, read-only Shopify-checks, runtime-
isolatie-bewijs, publieke-route-health) direct in dezelfde ronde verder.

### 16.5 Fail-closed proof — vooraf al bewezen, hernieuwd bevestigd

`tests/delivery-handoff-shopify.test.ts`, test "hard-fails when the live
shop is the real production shop and only the dev store is on the
allowlist — the exact staging-safety scenario" — opnieuw geïsoleerd
gedraaid, **groen**. Bewijst op config/service-testniveau (gemockte
`fetch`, geen live Shopify-aanroep): een live-shop-respons gelijk aan de
echte productiewinkel wordt geweigerd door `assertShopifyWriteAllowed()`
zodra de allowlist uitsluitend `stones4u-dev.myshopify.com` bevat; dezelfde
allowlist staat de dev-store zelf wel toe. Geen mutatie nodig of
uitgevoerd om dit te bewijzen.

### 16.6 CI/CD push-veiligheid (read-only)

Geen `.github/workflows/` — **geen enkele CI/CD-pipeline bestaat in dit
repo**. Deploys zijn uitsluitend handmatig (`fly deploy -c fly.toml` /
`-c fly.production.toml`, direct vanaf de lokale werkdirectory, niet
git-gebaseerd). Een `git push` naar `main` triggert dus **niets**
automatisch — geen staging-deploy, geen production-deploy, geen andere
workflow. Er was in deze ronde geen noodzaak om te committen/pushen (de
volgende stappen zijn hoe dan ook geblokkeerd op §16.4), dus er is niet
gecommit.

### 16.7 Baseline (vóór elke config-wijziging)

- `fly status --app stones4u-control-center-staging`: beide machines
  `started`, health check passing.
- `GET https://stones4u-control-center-staging.fly.dev/api/health` → 200.
- `GET .../delivery/does-not-exist-yet` → 404 (Next.js' generieke 404
  voor een onbekend pad — de nu (nog) gedeployde build is de **vóór**-
  Fase-2A-versie; dit is dus nog geen bevestiging van de eigen
  `notFound()`-logica uit `page.tsx`, alleen dat er sowieso nog geen
  toevallige route-collision is).

### 16.8 Wat destijds nog niet was uitgevoerd (inmiddels gedaan — zie §16.10-§16.14)

Op het moment van schrijven (eerste 2B-ronde): allowlist toepassen,
staging-config aanpassen, Fase-2A-code deployen naar staging, de
staging-migratie draaien, read-only Shopify-capability-checks tegen de
dev-store, het runtime-isolatiebewijs, en de publieke-route-health-check
ná deploy — stuk voor stuk afhankelijk van de dedicated credentials uit
§16.4. Alle bovenstaande stappen zijn in de vervolgronde (§16.10 e.v.)
alsnog uitgevoerd, nadat Fons de credentials zelf op staging had gezet.

### 16.9 Quality / git state

Geen enkele codewijziging deze ronde (zuiver read-only onderzoek +
documentatie) — `git status --short` toont geen nieuwe wijzigingen t.o.v.
het einde van Fase 2A. Geen test hoefde opnieuw te draaien om deze reden;
`tests/delivery-handoff-shopify.test.ts` is uitsluitend ter bevestiging
opnieuw gedraaid (§16.5), niet omdat code wijzigde.

### 16.10 Staged secrets bevestigd (vervolgronde)

`fly secrets list --app stones4u-control-center-staging` toont alle zes
verwachte secrets met status `Staged` (nog niet actief op de draaiende
machines): `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`,
`SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN`, `SHOPIFY_SHOP_DOMAIN`,
`SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS`, `DELIVERY_HANDOFF_TOKEN_SECRET`.
`SHOPIFY_CLIENT_ID`/`_CLIENT_SECRET` hebben digests die **afwijken** van
productie — bevestigt dat het echt nieuwe, dedicated credentials zijn,
geen hergebruikte productiewaarden. De drie domain-vars delen dezelfde
digest — bevestigt dat ze dezelfde waarde bevatten, consistent met "alle
drie `stones4u-dev.myshopify.com`". Geen enkele waarde gelezen.

### 16.11 Quality recheck vóór deploy

`npx vitest run --no-file-parallelism`: **575/575** slagen. `npx tsc
--noEmit`: schoon. `npx eslint .`: exit 0. `npx prisma validate`: geldig.
`git diff --check`: schoon (alleen onschuldige CRLF-waarschuwingen). Geen
nieuwe failure.

### 16.12 Staging deploy + migratie

`fly deploy --config fly.toml --app stones4u-control-center-staging`
(expliciet target, geen default) — geslaagd.
`release_command: npx prisma migrate deploy` liep automatisch vóór de
machines herstartten en meldde `completed successfully`. Beide machines
(`876921a0644278`, `d891e967b31798`) bereikten `started` met een
passing health check.

Migratiestatus, direct op staging bevestigd (`npx prisma migrate status`
via `fly ssh console`): 10 migraties gevonden, "Database schema is up to
date" — beide nieuwe additieve migraties
(`20260908154729_phase7_delivery_date_handoff`,
`20260908154948_phase7b_delivery_date_activity`) zijn toegepast. Database
= de staging-cluster (`pgbouncer.9g6y30wdpnmrv5ml.flympg.net`), niet
productie. Bestaande data intact — rechtstreeks bevraagd via de
gegenereerde Prisma-client op de draaiende machine: `users: 1`,
`customerProfile: 9` (ongewijzigd, geen dataverlies), `deliveryDateHandoff:
0` (nieuwe tabel bestaat, leeg — geen synthetische rij aangemaakt, niet
nodig gebleken).

### 16.13 Runtime-isolatiebewijs (live, read-only)

Via `fly ssh console`, een read-only script dat exact dezelfde stappen
volgt als `client.ts`/`write-safety-guard.ts` (client-credentials-token
ophalen, `shop { myshopifyDomain }` + `draftOrders`/`orders` bevragen) —
nooit de gegenereerde app-bundel zelf geïmporteerd (niet praktisch
bereikbaar vanuit een Next.js standalone build), wel functioneel
identiek aan de eigen code. Alleen domeinwaarden getoond (geen secrets):

```
SHOPIFY_SHOP_DOMAIN: stones4u-dev.myshopify.com
SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN: stones4u-dev.myshopify.com
SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS: stones4u-dev.myshopify.com
SHOPIFY_CLIENT_ID present: true
SHOPIFY_CLIENT_SECRET present: true
DELIVERY_HANDOFF_TOKEN_SECRET present: true
AUTH: OK
LIVE myshopifyDomain: stones4u-dev.myshopify.com
draftOrders read: OK count=1
orders read: OK count=1
MATCH shop==expectedDomain: true
MATCH shop==writeAllowlist: true
```

**Effective shop == expected domain == write-allowlist, alle drie
`stones4u-dev.myshopify.com`, live bevestigd op de draaiende staging-
machine.** Authenticatie tegen de dev-store werkt (client-credentials-
tokenverzoek slaagt). Draft Order-lezen en Order-lezen werken beide live.
Geen `customer`-veld ergens bevraagd. `draftOrders`/`orders` count = 1 elk
— pre-existing objecten in de dev-store (van de eerdere OfferteApp-
verificatieronde, niet door deze sessie aangemaakt of gewijzigd).

**Write-guard-bewijs**: de guard-logica zelf is al volledig unit-getest
(§16.5, opnieuw bevestigd groen); dit runtime-bewijs toont daarnaast dat
de daadwerkelijke, actieve configuratie exact de waarden bevat waarmee
die logica zou slagen. Samen vormt dit een volledige bewijsketen zonder
ooit de guard-functie zelf in de gedeployde bundel te hoeven aanroepen.

### 16.14 Scope-capability-check (read-only, GEEN mutatie) — blocker gevonden, inmiddels opgelost (zie §16.17)

`currentAppInstallation { accessScopes { handle } }` — een standaard,
read-only Shopify-query die de daadwerkelijk aan de actieve installatie
toegekende scopes toont, live bevraagd:

```
GRANTED SCOPES: read_draft_orders, read_orders
has write_draft_orders: false
has read_draft_orders: true
has read_orders: true
has read_customers: false
```

`read_draft_orders`/`read_orders` correct aanwezig, `read_customers`
correct afwezig (bevestigt de minimale-scope-eis uit §16.3 nogmaals,
live). **`write_draft_orders` is echter niet aan de actieve installatie
toegekend**, ondanks dat Fons meldde dat de scope in de Shopify-Admin-
app-configuratie staat aangevinkt. Dit is dezelfde klasse probleem als
eerder deze week bij OfferteApp (`read_customers`): een scope-wijziging
in de configuratie van een custom app wordt pas van kracht op de
**actieve installatie** na een expliciete "Install"/"Update"-actie in
Shopify Admin — het aanvinken van de checkbox alleen is niet voldoende.

**Dit blokkeert Fase 2B niet** — de write-allowlist-isolatie
(`assertShopifyWriteAllowed()`) is uitsluitend domain-based, niet
scope-based, en is volledig en onafhankelijk bewezen (§16.13). Het
blokkeert wel de eerste écht geslaagde `draftOrderUpdate`-poging in
**Fase 2C** — die zal met de huidige installatie falen op een
`ACCESS_DENIED`-achtige Shopify-fout, exact zoals bij OfferteApp destijds.

**Actie voor Fons, vóór Fase 2C**: in `stones4u-dev.myshopify.com`, bij de
"Stones4U Control Center Stagin"-custom-app, na het bevestigen dat
`write_draft_orders` is aangevinkt, de installatie opnieuw activeren
("Install"/"Update"-knop in het API-credentials-scherm) zodat de scope
daadwerkelijk aan het actieve access-token gekoppeld wordt. Geen
herautorisatiestap met een browser-consentscherm nodig (client-
credentials-app, geen OAuth-authorization-code-flow) — wel een expliciete
"reïnstalleer/update"-klik in Shopify Admin zelf.

### 16.15 Public route health (staging, na deploy)

Live tegen `https://stones4u-control-center-staging.fly.dev`:

- `GET /api/health` → `200`.
- `GET /delivery/does-not-exist-at-all` → `404` (de eigen `notFound()`-
  logica uit `page.tsx` — bevestigd via de RSC-specifieke response-
  headers, niet langer het generieke pre-deploy-gedrag).
- `POST /api/delivery/does-not-exist-at-all` → `404` (route.ts's eigen
  logica).
- Geen `Location: /login`-redirect op geen van beide — de publieke route
  vereist aantoonbaar geen staff-sessie.

Geen enkele geldige `DeliveryDateHandoff` aangemaakt of bezocht — geen
mirror-poging kon dus ooit plaatsvinden via deze checks.

### 16.16 CI/CD-pushveiligheid — ongewijzigd

Zelfde bevinding als §16.6: geen `.github/workflows/`, geen enkele
automatische deploy-trigger op `git push`. Er is deze ronde niet
gecommit/gepusht (niet noodzakelijk voor de staging-deployworkflow, die
rechtstreeks vanuit de lokale werkdirectory deploy, niet via git).

### 16.17 Fase 2C-preflight — scope-blocker opgelost, alle gates groen

Na Fons' herinstallatie van de "Stones4U Control Center Stagin"-app in
`stones4u-dev.myshopify.com`, opnieuw live bevraagd via
`currentAppInstallation.accessScopes` (read-only, geen mutatie):

```
GRANTED SCOPES: read_draft_orders, read_orders, write_draft_orders
has write_draft_orders: true
has read_draft_orders: true
has read_orders: true
has read_customers: false
LIVE myshopifyDomain: stones4u-dev.myshopify.com
MATCH shop==expectedDomain: true
MATCH shop==writeAllowlist: true
```

Alle gates groen: `write_draft_orders` nu daadwerkelijk aan de actieve
installatie toegekend (de eerdere §16.14-blocker is opgelost),
`read_orders` aanwezig, `read_customers` terecht afwezig/niet nodig,
effective shop == expected domain == write-allowlist ==
`stones4u-dev.myshopify.com`. Geen enkele mutatie uitgevoerd — uitsluitend
`shop`/`currentAppInstallation.accessScopes` bevraagd.

Fase 2C (de eerste synthetische write-test) kan starten.

## 17. Fase 2C — eerste live write-E2E (2026-09-08)

**Resultaat: volledig groen, inclusief de Draft→Order-attribuutgate.**
Alle mutaties uitsluitend tegen `stones4u-dev.myshopify.com` en
`stones4u-control-center-staging`. Geen enkele aanraking van
`D:\Shopify\OfferteApp`, `offerteapp.fly.dev`, Control Center productie,
de echte Shopify-winkel, een echte klant of een echte betaling.

### 17.0 Hard pre-write gate

Onmiddellijk vóór de eerste mutatie, live herbevestigd: effective shop =
expected domain = write-allowlist = `stones4u-dev.myshopify.com`;
granted scopes bevatten `read_draft_orders`, `write_draft_orders`,
`read_orders`. Alle voorwaarden groen — doorgegaan.

### 17.1 Synthetische Shopify Draft

Aangemaakt in `stones4u-dev.myshopify.com` via `draftOrderCreate`: geen
customer, geen e-mail, geen telefoon, geen shipping address. Custom line
item "PORTAL DELIVERY DATE E2E TEST" (€1,00), note "SYNTHETIC TEST
CONTROL CENTER STAGING".

- **Draft Order GID**: `gid://shopify/DraftOrder/1540260495705`
- **Naam**: `#D24`

### 17.2 Preservation-control seed

`test_existing_attribute = preserve-me` gezet via `draftOrderUpdate` en
direct teruggelezen ter bevestiging — aanwezig vóór de portal-flow werd
gestart.

### 17.3 Synthetische DeliveryDateHandoff

Aangemaakt in de staging-database met exact dezelfde token-generatie-
techniek als `src/modules/delivery/token.ts` (`randomBytes(32).base64url`
+ HMAC-SHA256 met het echte, actieve `DELIVERY_HANDOFF_TOKEN_SECRET` van
deze omgeving) — niet via de geauthenticeerde staff-API (geen
staff-inloggegevens beschikbaar op staging; zelfde beperking als eerder
bij OfferteApp), wel met identiek gedrag, aantoonbaar omdat de resulterende
publieke route er onmiddellijk correct op reageerde (§17.4).
`sourceSystem = SHOPIFY`, `externalId` = de Draft Order GID,
`paymentProvider = SHOPIFY`, `requestedDeliveryDate` leeg bij creatie,
`createdById` = de enige bestaande staging-gebruiker (gerefereerd, niet
gewijzigd).

**Tokenopslagbewijs**: `publicTokenHash` in de database is een 64-teken
hex-hash (`ea9540c1...`, ingekort), aantoonbaar ongelijk aan de raw
token zelf (`RAW_TOKEN_NOT_EQUAL_HASH: true`, direct in dezelfde
transactie geverifieerd). De raw token is uitsluitend in het tijdelijke
sessie-scratchgeheugen van dit E2E-proces gebruikt om de publieke route
aan te roepen — **nergens in dit document, in de database, of in enige
log opgeslagen.**

### 17.4 Public GET

- Geldig token → **200**, correcte formulier-UI (`type="date"`,
  `min="2026-09-08"`, lege waarde), geen klant-PII (gescand op e-mail/
  telefoon/naam-indicatoren — niets gevonden; er is sowieso geen
  klantgegeven op dit model aanwezig om te lekken).
- Willekeurig token → **404**.
- Eén teken gewijzigd t.o.v. het echte token → **404**.
- Geen staff-login vereist (geen sessie-cookie, geen redirect).

### 17.5 Eerste ingediende datum

Dynamisch gekozen: vandaag + 30 dagen = **2026-10-08**.

### 17.6 Ordering hard gate — live bewezen

Via de echte publieke `POST /api/delivery/[token]`:
1. token resolve → gevonden
2. datum gevalideerd
3. lokaal opgeslagen (bevestigd in de database direct na de call)
4. Shopify-mirror uitgevoerd
5. mirror geslaagd (`status: MIRRORED`, `lastMirrorAt` gezet)
6. betaal-target server-side opgelost (Shopify `invoiceUrl` van deze
   exacte Draft)
7. respons bevat `redirectUrl` — **pas na** stap 5, nooit ervoor (het
   contract van deze route is: geen `redirectUrl` in de respons zonder
   een geslaagde mirror, aantoonbaar door de mirror-failure-tests in
   §17.15, die überhaupt geen `redirectUrl` teruggeven)

### 17.7 Local database result

`requestedDeliveryDate: 2026-10-08`, `status: MIRRORED`,
`mirrorErrorCode: null`. Precies **1** `DeliveryDateHandoff`-rij in de
hele database (geen duplicaat aangemaakt).

### 17.8 Shopify mirror result — live read-merge-write-gate

Draft teruggelezen:
```
[{"key":"test_existing_attribute","value":"preserve-me"},
 {"key":"requested_delivery_date","value":"2026-10-08"}]
```
Exact twee attributen, geen duplicaat-sleutel, het vooraf gezette
testattribuut volledig intact.

### 17.9 Payment target / redirect

`invoiceUrl` van de Draft (live opgehaald) is **exact gelijk** aan de
`redirectUrl` die de publieke POST teruggaf (booleaanse gelijkheids-
check, geen volledige URL hier herhaald). Tamperingpoging in dezelfde
call met `provider`, `redirect`, `next`, `payment_url`, `invoice_url` als
extra velden → **exact dezelfde `redirectUrl`**, aantoonbaar geen enkel
effect. Geen betaling uitgevoerd of geïnitieerd.

### 17.10 Idempotency — same date

Dezelfde tamperingpoging (§17.9) hergebruikte toevallig ook dezelfde
datum — dient tegelijk als same-date-idempotency-bewijs: nog steeds
precies 1 handoff-rij, 0 Activity's (nog geen klant gekoppeld op dit
moment), redirect ongewijzigd.

### 17.11 Idempotency — changed date

Vóór deze stap gekoppeld aan een nieuwe, duidelijk synthetische
`CustomerProfile` (`displayName: "SYNTHETIC E2E TEST — CONTROL CENTER
STAGING"`, `shopifyCustomerGid` met een `synthetic-e2e-`-prefix) — nodig
om ook het klant-gekoppelde Activity-/backoffice-pad live te bewijzen
(§17.14/§17.17), niet omdat de kernflow het vereist.

Nieuwe testdatum: vandaag + 45 dagen = **2026-10-23** (dit werd de finale
testwaarde). Resultaat:
- `requestedDeliveryDate` lokaal vervangen naar `2026-10-23`.
- Nog steeds precies **1** handoff-rij (geen duplicaat).
- Shopify `requested_delivery_date` vervangen naar `2026-10-23` — geen
  duplicaat-sleutel, `test_existing_attribute` nog steeds aanwezig
  (§17.8-query herhaald, zie §17.12).
- Precies **1** nieuwe Activity geschreven (zie §17.14) — de eerdere
  same-date-poging (§17.10, zonder klantkoppeling) schreef er terecht
  geen.

### 17.12 Herbevestiging Shopify-attributen na wijziging

```
[{"key":"test_existing_attribute","value":"preserve-me"},
 {"key":"requested_delivery_date","value":"2026-10-23"}]
```

### 17.13 Mirror-failure-gedrag (via bestaande automatische tests, niet tegen de echte dev-store)

Conform instructie: **niet** bewezen door de echte dev-store-config kapot
te maken. `tests/delivery-handoff.test.ts`'s bestaande, gemockte
mirror-failure-tests opnieuw geïsoleerd gedraaid, groen: lokale datum
blijft opgeslagen bij een mislukte mirror, geen `redirectUrl`, retrybare
fout, geen nieuwe Draft, geen nieuwe handoff-rij. Zie Fase 2A §13 voor de
volledige testbeschrijving.

### 17.14 Mollie fail-closed (service-niveau, geen OfferteApp)

Zelfde aanpak: bestaande, al bewezen tests opnieuw gedraaid (`paymentProvider
= MOLLIE`/`UNKNOWN` → niet-retryable `DeliveryHandoffError`, geen
Shopify-fallback, geen request-URL-redirect, geen betaling, geen
OfferteApp-aanroep — er bestaat sowieso geen enkele OfferteApp-
afhankelijkheid in deze codebase). Niet opnieuw live tegen de dev-store
getest — een expliciete `paymentProvider = MOLLIE`-rij zou de kernflow
niet toevoegen, alleen herhalen wat al deterministisch op servicetestniveau
bewezen is.

### 17.15 Activity/timeline — live bewezen

```
ACTIVITY_COUNT: 1
 - DELIVERY_DATE_REQUESTED "Gewenste leverdatum klant ontvangen"
   "Klant koos 2026-10-23 als gewenste leverdatum (wens, geen toezegging)."
```

Precies één Activity over de hele flow — geschreven op het moment dat de
datum voor het eerst veranderde **terwijl** een klant gekoppeld was
(§17.11). Geen Activity op de eerdere, ongekoppelde inzendingen, geen
Activity op enige `GET`, geen tweede Activity op de latere
tamperingpoging met dezelfde datum (die kwam ná deze wijziging en betrof
dezelfde waarde).

### 17.16 Security E2E — live

| Test | Resultaat |
|---|---|
| Willekeurig token | `GET` → 404 |
| Gemanipuleerd (1 teken gewijzigd) token | `GET` → 404 |
| Verleden datum (`2020-01-01`) | `POST` → 400, "niet in het verleden", geen wijziging |
| Malformed datum (`not-a-date`) | `POST` → 400, "Ongeldige datum", geen wijziging |
| Lege datum | `POST` → 400, "Kies een gewenste leverdatum", geen wijziging |
| `provider`/`redirect`/`next`/`payment_url`/`invoice_url` tampering | `POST` → exact dezelfde server-bepaalde `redirectUrl`, geen effect |

Na alle drie ongeldige-datumpogingen: expliciet herbevestigd dat
`requestedDeliveryDate` (`2026-10-23`) en het totale rijenaantal (1)
volledig ongewijzigd bleven.

### 17.17 Backoffice-gegevenslaag — live bewezen (geen staff-browsersessie beschikbaar)

Zelfde beperking als bij OfferteApp: geen staff-inloggegevens beschikbaar
op staging, dus geen letterlijke geauthenticeerde-browser-screenshot.
Wel sterker bewijs dan toen: de exacte query die
`listDeliveryDateHandoffsForCustomer()`/`DeliveryDateHandoffsPanel.tsx`
zouden gebruiken, rechtstreeks tegen de live staging-database uitgevoerd
voor de gekoppelde synthetische klant:

```
{"requestedDeliveryDate":"2026-10-23","status":"MIRRORED",
 "shopifyDraftOrderGid":"gid://shopify/DraftOrder/1540260495705"}
COUNT_FOR_CUSTOMER: 1
```

Exact de data die het paneel zou renderen als "23-10-2026" met badge
"Doorgegeven aan Shopify" — het paneel zelf is een pure, simpele
presentatiecomponent (label-/badge-mapping, geen businesslogica) die al
in Fase 2A werd gereviewed; deze data-laagverificatie is voor dit
component voldoende om de daadwerkelijke weergave te vertrouwen.

### 17.18 Draft → Order hard gate

`draftOrderComplete` uitgevoerd — **geen `paymentGatewayId`**, dus geen
enkele echte betaalgateway aangeroepen of geld bewogen (zelfde bewezen
patroon als bij OfferteApp; de synthetische Draft had bovendien geen
customer gekoppeld, dus geen orderbevestigingsmail verstuurd).

- Draft-status: `COMPLETED`.
- Resulting Order: `#1022`, `gid://shopify/Order/13294986002777`,
  `displayFinancialStatus: PAID` (Shopify's eigen boekhouding voor een
  Draft zonder opgegeven betaalgateway — geen echte transactie).

### 17.19 Resulting Order — attribuutbewijs

Live, read-only opgehaald:
```
{"name":"#1022","displayFinancialStatus":"PAID",
 "customAttributes":[
   {"key":"test_existing_attribute","value":"preserve-me"},
   {"key":"requested_delivery_date","value":"2026-10-23"}]}
```

- Order bestaat: ✅
- `requested_delivery_date` aanwezig: ✅, waarde **exact** `2026-10-23`
  (de laatst gekozen testdatum, §17.11)
- **Exact Shopify-veld**: `Order.customAttributes` (GraphQL Admin API) —
  zelfde veld/type als op `DraftOrder`, ongewijzigd overgedragen bij
  completion.
- `test_existing_attribute = preserve-me`: ✅ behouden.

**PORTAL SHOPIFY DRAFT→ORDER ATTRIBUTE GATE: VERIFIED** — live bewezen,
niet weggeredeneerd met documentatie of unit tests.

### 17.20 DeliveryDateHandoff-status na de Draft→Order-test

Bewust **niet** gewijzigd naar een fictieve PAID/COMPLETED-status — het
portal heeft geen payment-completion-feedback-mechanisme (bevestigd,
buiten scope, zie §9 van dit document), dus het handmatig completeren van
de Draft voor testdoeleinden mag de `DeliveryDateHandoff.status` niet
laten liegen over wat het systeem daadwerkelijk weet. Status bleef
`MIRRORED` — accuraat: de datum is succesvol naar Shopify doorgegeven,
verder weet het systeem niets over de betaalstatus.

### 17.21 Cleanup

**Staging-database**: de synthetische `DeliveryDateHandoff`-rij, de ene
bijbehorende `Activity`-rij, en de synthetische `CustomerProfile`
verwijderd. Geverifieerd: 0 resterende handoffs, 9 resterende
`CustomerProfile`-rijen (exact de oorspronkelijke baseline uit Fase
2B §16.12 — geen bestaande data aangeraakt).

**Shopify dev-store**: Order `#1022` (voormalig Draft `#D24`) blijft
staan — geen `orderDelete`/`orderCancel` geprobeerd (niet gedekt door de
huidige, bewust minimale scopes; geen extra scope aangevraagd puur voor
cleanup, conform instructie). Al duidelijk zelf-documenterend als
synthetisch: regelomschrijving "PORTAL DELIVERY DATE E2E TEST", notitie
"SYNTHETIC TEST CONTROL CENTER STAGING", geen klant gekoppeld, €1,00.
Hierbij expliciet nogmaals gedocumenteerd: **SYNTHETIC CONTROL CENTER
TEST — veilig te herkennen en later handmatig op te ruimen door Fons in
de Shopify Admin, indien gewenst.**

### 17.22 Productie-isolatiebewijs

Alle mutaties deze ronde (Draft aanmaken, attribuut seeden, twee keer
mirror-update, Draft completeren) gingen aantoonbaar uitsluitend naar
`stones4u-dev.myshopify.com` (elke aanroep gebruikte dezelfde,
vooraf-geverifieerde staging-credentials, en de Draft/Order-GID's zijn
zichtbaar afkomstig uit die winkel). Geen enkele aanroep tegen de echte
Stones4U-winkel, geen enkele aanraking van `stones4u-control-center`
(productie), geen enkele actie tegen `D:\Shopify\OfferteApp` of
`offerteapp.fly.dev`, geen production-database-actie. Totaal **6**
Shopify-mutaties uitgevoerd, alle zes tegen de dev-store: 1x
`draftOrderCreate` (§17.1), 1x `draftOrderUpdate` voor de preservation-
seed (§17.2), 3x `draftOrderUpdate` via de echte portal-mirror-service
(één per geslaagde publieke `POST` — §17.6 eerste datum, §17.9 dezelfde
datum met tamperingvelden, §17.11 gewijzigde datum), en 1x
`draftOrderComplete` (§17.18).

### 17.23 Code / tests / git

Geen enkele codewijziging deze ronde. `npx vitest run
tests/delivery-handoff.test.ts tests/delivery-handoff-shopify.test.ts`:
29/29 groen, opnieuw bevestigd ná de live E2E. `git status --short`
ongewijzigd t.o.v. eind Fase 2B — geen nieuw bestand, geen wijziging.
Niet gecommit, niet gepusht.
