# 27 — Phase 3 Discovery: Telefonie, E-mail, Commerciële Context, Offerte-apps

Read-only discovery voor Phase 3 ("Customer 360 als centraal overzicht van alle klantcommunicatie en commerciële interacties"). Voortbouwend op, niet herhalend van, de bestaande diepe discovery in `01`–`26`. Elke hieronder aangehaalde bevinding uit een eerder rapport is dit keer **opnieuw geverifieerd tegen de actuele broncode** (niet uit het geheugen overgenomen) — zie §0.

## 0. Verificatie van bestaande discovery

| Repo | HEAD ten tijde van eerdere discovery | HEAD nu | Gewijzigd sinds? |
|---|---|---|---|
| TelefoonSysteem | `f652ead` | `f652ead` | Nee — identiek |
| OfferteApp | `88dd2c8` | `88dd2c8` | Nee — identiek |
| s4u-quote-app | `b9f23f1` (laatste bekende) | `b9f23f1` | Nee — identiek |

Alle drie sibling-repo's zijn **byte-voor-byte ongewijzigd** sinds `19-TELEFOONSYSTEEM-CRM-DEEP-DIVE.md`, `20-CUSTOMER-HISTORY-DATA-MODEL.md`, `22-CUSTOMER-IDENTITY-STRATEGY.md`, `10-OFFERTEAPP-DEEP-DIVE.md`, `11-QUOTE-APP-DEEP-DIVE.md` zijn geschreven. Die rapporten worden hieronder als **geverifieerd, actueel** aangehaald — niet herhaald, wel expliciet cross-gerefereerd. Aanvullend hieronder: gerichte, verse verificatie van precies de velden/routes/scopes die Phase 3 nodig heeft, plus volledig nieuw onderzoek naar de e-mailbronnen (oorspronkelijk, onjuist, als één Gmail-mailbox onderzocht — per de correcties van 2026-09-03 nu twee providers, Microsoft 365 + IMAP, zie `30-PHASE-3C-EMAIL-INTEGRATION-DISCOVERY.md`) en de huidige CRM-Shopify-integratie zelf.

## 1. Telefonie (TelefoonSysteem) — huidige situatie

Zie `19-TELEFOONSYSTEEM-CRM-DEEP-DIVE.md` voor de volledige architectuur (AMI → ami-worker → api → Socket.IO/web/windows-popup) en `22-CUSTOMER-IDENTITY-STRATEGY.md` voor de Shopify-matching. Hier: wat specifiek voor een Phase 3-adapter geverifieerd is.

### 1.1 Call-record — velden (geverifieerd, `prisma/schema.prisma:77-107`)

```
id, uniqueId (AMI-correlatie, @unique), linkedId (AMI-correlatie over alle legs),
callerNumber, callerName, calledExtension, answeredExtension,
assignedUserId, contactId,
status (RINGING|ANSWERED|ENDED|MISSED|ABANDONED),
category (OFFERTE|TERUGBELLEN|BESTELVRAAG|SERVICE_KLACHT|ONBEKEND),
startedAt, answeredAt, endedAt, durationSeconds,
createdAt, updatedAt
```

**Herbevestigd, nog steeds afwezig** (herhaalde grep, nul treffers): **geen `direction`-veld**, **geen recording-referentie**. Het modelcommentaar bij `RINGING` ("Incoming, not yet answered") en de trigger (`handleNewCall`, gevoed door AMI `Newchannel`/`NewCallerid`) impliceren dat dit model primair **inkomende** gesprekken modelleert; uitgaand bellen via `POST /api/calls/originate` genereert vermoedelijk ook een `Call`-rij via dezelfde correlatieservice, maar zonder een expliciet veld dat dit onderscheidt. **Concreet gevolg voor Phase 3**: `CallStatus.MISSED` is direct bruikbaar voor `CALL_MISSED`; een betrouwbaar `CALL_INBOUND`/`CALL_OUTBOUND`-onderscheid kan **niet** met zekerheid uit het huidige schema afgeleid worden — hooguit een heuristiek (bijv. "is er een `calledExtension` vóór een `answeredExtension`, of andersom"), die niet gegarandeerd correct is. Een schone oplossing vereist een `direction`-veld **aan TelefoonSysteem-kant** — buiten scope van dit CRM-repo, zie §6.

### 1.2 Read-API — bestaat, maar zonder machine-credential (KRITIEKE BEVINDING)

Geverifieerd (`apps/api/src/routes/calls.ts`, `apps/api/src/routes/contacts.ts`):

```
GET  /calls/active
GET  /calls               (lijst, met filters)
GET  /calls/:id
GET  /calls/:id/caller-history
GET  /contacts/:id
GET  /contacts/:contactId/notes
GET  /contacts/:contactId/tasks
```

Alle bovenstaande routes lopen door `requireAuth` (`apps/api/src/middleware/auth.ts:21-33`) — een **mens-georiënteerde JWT-bearer-token**, verkregen via interactieve login, 7 dagen geldig, geen service-account-concept. Het enige machine-tot-machine-mechanisme dat wél bestaat, `requireInternalSecret` (`x-internal-secret`-header, timing-safe vergeleken), is uitsluitend gekoppeld aan de **interne** ami-worker→api-broadcastroute (`/internal/broadcast`) — niet aan een van bovenstaande lees-routes, en niet ontworpen om extern (vanuit een ander systeem/repo) aangeroepen te worden.

**Dit is exact dezelfde blokkade als in Phase 1 vastgesteld** (`docs/build/PHASE-1-IMPLEMENTATION-REPORT.md` §1, ADR-004) — opnieuw geverifieerd, niet veranderd. Zonder een nieuwe, TelefoonSysteem-zijdige service-auth-laag (bijv. een uitbreiding van het bestaande `INTERNAL_SECRET`/`x-internal-secret`-patroon naar de lees-routes, of een apart scoped service-token) kan Control Center deze routes niet server-to-server aanroepen zonder ofwel (a) een human-JWT als pseudo-service-credential te misbruiken — expliciet en herhaaldelijk uitgesloten in de opdrachtgeschiedenis van dit project — ofwel (b) rechtstreeks op TelefoonSysteem's database aan te sluiten — expliciet uitgesloten door `CLAUDE.md`/`AGENTS.md` ("Never write code in this repo that reads or writes another app's database directly").

**Consequentie voor Phase 3**: de telefonie-adapter kan in dit document volledig ontworpen worden (interface, datamodel, matching), maar kan **niet geactiveerd** worden totdat een expliciet, apart, TelefoonSysteem-zijdig traject een leesbare service-credential toevoegt. Dit is precies de bestaande, geaccepteerde blokkade uit Phase 1/ADR-004 — Phase 3 lost hem niet op, herbevestigt hem alleen met de exacte routes die klaar zouden staan zodra hij wél is opgelost.

### 1.3 Polling vs. API vs. database-adapter vs. event-driven

- **Directe database-adapter**: architecturaal uitgesloten door de bestaande projectregels (zie boven) — geen verdere afweging nodig, dit is geen open vraag.
- **API read-adapter (poll-on-demand)**: de aanbevolen aanpak, zodra §1.2 is opgelost. Bij het laden van Customer 360 vraagt Control Center live `GET /calls?phone=...` (of gelijkwaardig) op — zelfde patroon als de bestaande live Shopify-orderfetch. Geen lokale opslag, dus geen dedup-probleem (zie §5).
- **Event-driven (TelefoonSysteem → CRM webhook)**: technisch aantrekkelijk voor een toekomstige "klant belt nu binnen"-melding in Control Center, maar vereist een **nieuwe uitgaande** koppeling aan TelefoonSysteem-kant (een voor de hand liggende, kleinere uitbreiding van de al bestaande `notifier.ts`/`{API_INTERNAL_URL}/internal/broadcast`-patroon zou ook naar een extern CRM-webhook-endpoint kunnen posten met een gedeeld secret) — **niet nodig voor de Phase 3-doelstelling** ("gesprekshistorie tonen op Customer 360"), wél vermeldenswaardig als toekomstige evolutie. Niet in Phase 3 bouwen.

### 1.4 Recordings, privacy

Geen recording-referentie in het schema (herbevestigd, §1.1) — er is dus vandaag niets af te spelen, ongeacht adapterontwerp. Als recordings ooit worden toegevoegd aan TelefoonSysteem, geldt voor Phase 3 de expliciete instructie "recordings afspelen tenzij vrijwel gratis beschikbaar" — gezien er nu niets bestaat, is dit sowieso **niet in Phase 3**.

## 2. E-mail (Microsoft 365 + IMAP, provider-onafhankelijk) — volledig nieuw onderzoek, geen bestaande documentatie

> **Correctie (2026-09-03, tweemaal)**: dit document ging eerst onjuist uit van Gmail, daarna (kortstondig) van Microsoft 365 als enige e-mailbron. Beide waren onjuiste aannames. Stones4U heeft **twee** mailboxen op **twee verschillende providers** — `info@stones4u.nl` (Microsoft 365/Exchange Online, via Microsoft Graph) en `info@stones4u.eu` (geen Microsoft 365, waarschijnlijk IMAP). Deze sectie is vervangen door een korte, provider-onafhankelijke samenvatting; het volledige, gedetailleerde ontwerp (`EmailAdapter` met een `Microsoft365EmailAdapter`- en een `ImapEmailAdapter`-implementatie, genormaliseerd berichtmodel, authenticatie per provider, matching, timeline-projectie, fail-safe-gedrag) staat nu in `30-PHASE-3C-EMAIL-INTEGRATION-DISCOVERY.md`.

Geen enkel systeem in het hele landschap heeft vandaag een e-mailkoppeling (OfferteApp verstuurt alleen SMTP-uitgaand, geen lezen; s4u-quote-app verstuurt alleen een platte meldingsmail; TelefoonSysteem heeft geen e-mailfunctionaliteit). Dit is dus zuiver nieuw ontwerp, geen "hergebruik bestaande code."

### 2.1 Architectuur — provider-onafhankelijke `EmailAdapter`

De centrale CRM-laag (Customer 360, Activity Timeline, matching) kent **geen enkel** provider-specifiek detail — die blijven volledig ingekapseld in `src/integrations/email/{microsoft365-adapter,imap-adapter}.ts`, achter één gedeelde interface en één genormaliseerd berichtmodel. Zie `30` §1/§2 voor de volledige interface- en modeldefinitie. Elke mailbox faalt onafhankelijk van de andere (`30` §10) — Microsoft Graph-uitval blokkeert IMAP niet en omgekeerd.

### 2.2 Microsoft 365-pad (`info@stones4u.nl`)

**Microsoft Graph**, application permissions (client-credentials, zelfde patroon als de bestaande Shopify-integratie, ADR-006), permissie `Mail.Read` (Application) — de minimale permissie die ook `bodyPreview`/snippet teruggeeft. Scoping tot uitsluitend deze mailbox via Exchange Online **RBAC for Applications** (de huidige, aanbevolen opvolger van het oudere Application Access Policy-mechanisme). Volledige onderbouwing, inclusief een kritieke configuratie-valkuil (een tenant-brede Entra-consent naast een RBAC-scope resulteert in de **vereniging** van beide, niet de kleinere scope), in `30` §3.

### 2.3 IMAP-pad (`info@stones4u.eu`)

**Nog niet configureerbaar** — host/poort/TLS/authenticatiemethode zijn onbekend. De `ImapEmailAdapter` is wél volledig ontworpen (interface, zoekmechanisme per map, richtingsbepaling via Postvak IN/Verzonden-items, authenticatie-opties met voorkeur voor een dedicated/app-specifiek credential) — zie `30` §4. Zes concrete, nog ontbrekende gegevens staan opgesomd in `30` §12.

### 2.4 Matching

Ongewijzigd principe (ADR-007): klant-e-mailadres zoals bekend bij Shopify, genormaliseerd, exact vergeleken — nooit fuzzy, nooit een ambigue match automatisch definitief. Provider-onafhankelijk: een generieke `EMAIL`-matchsource (niet per provider) — zie `30` §6/§7 voor de volledige onderbouwing waarom een provider-specifieke matchsource onnodige koppeling zou creëren.

### 2.5 Caching/indexering

Niet nodig bij start voor beide providers — live opgehaald per Customer-360-paginabezoek (Graph `$search`, IMAP `SEARCH` per map), geen synchronisatie, geen lokale index. Zie `30` §5.

### 2.6 Privacy/security — reëel, niet triviaal

- Microsoft 365: `Mail.Read` (Application) is inherent breed geformuleerd door Microsoft ("alle mailboxen") — de RBAC-scoping (§2.2) is het daadwerkelijke least-privilege-mechanisme, geen optionele verharding.
- IMAP: een dedicated/app-specifiek credential (nooit het hoofdaccountwachtwoord) is het least-privilege-equivalent — nooit in PostgreSQL opgeslagen, uitsluitend server-side secret/env.
- Beide: de query-scoping (`from:`/`to:` op het klant-e-mailadres) gebeurt in Control Center's eigen code, niet door de provider afgedwongen — een bug in de queryconstructie kan onbedoeld irrelevante/privé-berichten tonen.
- GDPR-relevant: e-mailinhoud over een klant is persoonsgegevens. Retentie/inzagerecht is een beleidsvraag voor Stones4U, niet iets dit document kan beslissen — gemarkeerd als open punt.
- Geen per-mailbox OAuth-tokenopslag voor Microsoft 365 (tenant-breed credential); voor IMAP evenmin een database-credential (uitsluitend server-side secret) — zie `30` §5/§11.

## 3. Shopify commerciële context — uitbreiding van bestaande integratie

Geverifieerd in de huidige CRM-code (`src/integrations/shopify/orders.ts`, `types.ts`, `README.md`):

- **Al geïmplementeerd**: `getShopifyCustomerOrders()` — orders met `displayFinancialStatus`, `displayFulfillmentStatus`, `currentTotalPriceSet`, `createdAt`, `numberOfOrders`, `amountSpent`, plus een `outstandingOrders`-afleiding (financial status in `PENDING`/`PARTIALLY_PAID`/`AUTHORIZED`).
- **Al aanwezige scope, nog ongebruikt**: `read_draft_orders` staat al in `README.md`'s scope-lijst (Phase 1) en is dus al toegekend aan het bestaande Shopify custom app — **maar er bestaat vandaag geen enkele `draftOrder`-query in de hele CRM-codebase** (repo-brede grep op "draftOrder"/"DraftOrder": nul treffers). Concept-orders tonen in Customer 360 vereist dus **geen nieuwe Shopify-scope**, alleen nieuwe code — een genuine "snelle winst" voor Phase 3.
- **Shopify Admin-links**: triviaal te construeren (`https://admin.shopify.com/store/{shop}/orders/{legacyId}` resp. `/draft_orders/{legacyId}`) — de bestaande `ShopifyOrderSummary`/toekomstige `ShopifyDraftOrderSummary`-types bevatten al `legacyId`/`gid`, voldoende om de link te bouwen zonder extra API-aanroep.
- **Auth**: blijft ADR-006 (client-credentials, Patroon A in `03-SHOPIFY-INTEGRATION-MAP.md`) — geen statisch token, geen nieuwe auth-laag nodig. Alleen de GraphQL-query in `orders.ts` (of een nieuw `draft-orders.ts`) hoeft uitgebreid te worden.

## 4. Offerte-apps (OfferteApp, s4u-quote-app) — herbevestigd

Zie `10-OFFERTEAPP-DEEP-DIVE.md` §21 en `11-QUOTE-APP-DEEP-DIVE.md` §21 (beide read-only herbevestigd, §0). Kernpunten voor Phase 3:

- **Geen koppeling tussen OfferteApp en s4u-quote-app** — beide systemen bevestigen dit onafhankelijk vanuit hun eigen code én documentatie. Een Phase 3 "offertes tonen"-adapter moet dus **twee volledig gescheiden bronnen** federeren, niet één.
- **Geen van beide heeft een externe read-API of service-auth-mechanisme.** OfferteApp: alles achter Flask-Login staff-sessie (cookie-based, geen DB-sessietabel), drie publieke endpoints zijn allemaal smal-gescoopte webhook-ontvangers (Mollie/Pallet Yard/Shopify OAuth-callback), geen van drieën leesbaar voor offerte-data. s4u-quote-app: embedded-admin-UI vereist Shopify-sessie-token, storefront-proxy vereist HMAC — geen van beide bruikbaar voor een server-naar-server CRM-aanroep.
- **Zelfde structurele blokkade als telefonie** (§1.2): een offerte-read-adapter kan ontworpen worden, maar niet geactiveerd zonder een nieuwe, sibling-zijdige service-auth-laag — in beide gevallen een apart, buiten-scope traject.
- **Datamodel, indien/wanneer een adapter gebouwd wordt** (velden reeds geverifieerd in `10`/`11`):
  - OfferteApp `Quote`: `uuid`, `quote_number` (`OFF-YYYY-MMDD-NNN`), `shopify_customer_id`, `shopify_draft_order_id`, `shopify_order_id`, `status` (grotendeels ongebruikt in de praktijk — zie `10` §17, gebruik liever de aanwezigheid van `shopify_draft_order_id`/`shopify_order_id` als statussignaal), `total_inc`, `created_at` (impliciet via tijdstempel-conventie).
  - s4u-quote-app `Quote`: `publicQuoteNumber`, `status`, `source`, klant-/adresvelden, `draftOrderId`/`draftOrderName`, totalen, relatie naar `QuoteItem[]`.
  - Beide hebben een **directe Shopify draft-order-relatie** — dit betekent dat, zodra een offerte een draft order wordt, die al zichtbaar zou zijn via de in §3 beschreven Shopify-draft-order-uitbreiding, **ook zonder** een offerte-app-adapter. Dit relativeert de urgentie van de offerte-app-adapters: de "is er een openstaande offerte/concept" use-case is voor een deel al met alleen de Shopify-uitbreiding te dekken; de adapters voegen vooral *pre-draft-order*-offertes (nog niet omgezet) en offerte-specifieke metadata (offertenummer, versiehistorie) toe.

## 5. Cross-cutting bevinding: drie herhalingen van dezelfde blokkade

Telefonie (§1.2), OfferteApp (§4), s4u-quote-app (§4) hebben **alle drie** exact hetzelfde probleem: een leesbare API bestaat (of zou triviaal te bouwen zijn), maar zonder machine-credential, alleen mens-georiënteerde sessie-auth. Dit is geen toeval — het is het patroon dat dit hele platform-project al sinds Phase 1 bewust weigert te omzeilen met een pseudo-service-credential (human-token-hergebruik). **Voor Phase 3 betekent dit: van de vier onderzochte uitbreidingen (telefonie, e-mail, Shopify-commercieel, offerte-apps) is precies één (Shopify-commercieel, §3) vandaag zonder externe afhankelijkheid bouwbaar.** De andere drie vereisen een voorafgaand, apart, buiten-CRM-scope besluit/traject. Zie `29-PHASE-3-BUILD-SPEC.md` voor hoe dit de aanbevolen scope/volgorde bepaalt.

## 6. Wat NIET in dit CRM-repo kan worden opgelost (expliciet)

- Een nieuwe service-auth-laag op TelefoonSysteem (uitbreiding `x-internal-secret`-patroon of scoped service-token voor de lees-routes in §1.2).
- Een nieuwe read-API/service-auth op OfferteApp (bestaat nergens vandaag).
- Een nieuwe read-API/service-auth op s4u-quote-app (bestaat nergens vandaag).
- Een `direction`-veld op TelefoonSysteem's `Call`-model (§1.1).

Elk van deze is een **apart, expliciet te plannen traject in het betreffende sibling-repo**, buiten scope van dit document en van Phase 3 zoals hier ontworpen. Zie `29-PHASE-3-BUILD-SPEC.md` §16 voor de volledige lijst open beslissingen.
