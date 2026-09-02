# 19 — TelefoonSysteem: CRM-relevante Deep Dive

Bron: `D:\Shopify\TelefoonSysteem` (git, `github.com/Soluma/TelefoonSysteem`, branch `master`, HEAD `f652ead` "feat: checkpoint customer history, contacts, tasks and Windows popup"). Gericht, read-only onderzoek van uitsluitend de CRM-relevante delen. Zie ook [20-CUSTOMER-HISTORY-DATA-MODEL.md](20-CUSTOMER-HISTORY-DATA-MODEL.md) (Exact-historie), [21-TASKS-NOTES-REUSE-ANALYSIS.md](21-TASKS-NOTES-REUSE-ANALYSIS.md) (Contacts/Notes/Tasks in detail), [22-CUSTOMER-IDENTITY-STRATEGY.md](22-CUSTOMER-IDENTITY-STRATEGY.md) (Shopify-matching en identiteit).

## 1. Framework & architectuur

Turborepo-monorepo met vijf apps:
- `apps/api` — Node/TypeScript backend (Express-achtig), de centrale server.
- `apps/ami-worker` — verbindt met de Asterisk Manager Interface (AMI) van de PBX/FreePBX, verwerkt raw telefonie-events.
- `apps/web` — Next.js frontend (medewerker-dashboard).
- `apps/windows-popup` — Tauri (Rust+web) desktop-app die een native Windows-notificatie toont bij een inkomend gesprek.
- `apps/server` — **gedeprecieerd** (`DEPRECATED.md`: "no longer part of the active runtime," uitgesloten van build/dev, alleen bewaard voor rollback), vervangen door `apps/api` + `apps/ami-worker`. Bevat near-duplicate, dode kopieën van `shopifyService.ts` en `callCorrelation.ts` — niet verder onderzocht.

Twee gescheiden Postgres-databases via Prisma: `prisma/schema.prisma` (hoofddatabase — Users, Contacts, Calls, Notes, Tasks) en `prisma/customer-history.schema.prisma` (Exact Online-spiegel, zie [20](20-CUSTOMER-HISTORY-DATA-MODEL.md)). Realtime-communicatie via Socket.IO (`apps/api/src/socket/socketServer.ts`). Web Push (VAPID) voor notificaties buiten de browser-tab om.

## 2. Volledige call-datastroom (met bestand:regel-citaten)

```
Asterisk/FreePBX PBX
   │ AMI-events (Newchannel, DialBegin, DialEnd, BridgeEnter, Hangup, NewCallerid,
   │            AgentCalled, AgentConnect, AgentRingNoAnswer, AttendedTransfer)
   ▼
apps/ami-worker/src/ami/amiClient.ts — ruwe AMI-socketverbinding naar AMI_HOST:AMI_PORT
   ▼ emit 'event'
apps/ami-worker/src/ami/amiEventHandler.ts:36-90 — dispatcht op evt.Event
   │  Correlatiesleutel: evt.Linkedid (gedeeld over alle kanalen van één gesprek)
   │  Filter: alleen callerID's die matchen op /^\+?\d{7,}$/ (blokkeert interne toestellen) — regel 101
   ▼
apps/ami-worker/src/services/callCorrelation.ts — CallCorrelationService (in-memory Maps)
   │
   │  handleNewCall (97-161): zoekt lokale Contact op via EXACTE callerNumber-match (regel 114,
   │    GEEN telefoonnormalisatie — zie risico in §5), zoekt User op extension,
   │    prisma.call.create() met status=RINGING, slaat een CallEvent-rij op (ruwe AMI-payload als JSON),
   │    roept notifyApi('incoming_call', ...) aan, en vuurt DAARNA enrichWithShopifyName() af
   │    (fire-and-forget, niet gewacht)
   │
   │  handleDialBegin/handleCallAnswered/handleCallEnded/handleTransfer/handleAgentCalled/
   │  updateCallerInfo: elk doet een prisma.call.update(...) en roept opnieuw notifyApi(...) aan
   │
   │  enrichWithShopifyName (387-408): roept Shopify lookupByPhone(callerNumber) aan; bij status
   │    'found' overschrijft dit Call.callerName met de Shopify-displaynaam en notificeert opnieuw.
   │    Bij status 'multiple' (meerdere Shopify-klanten met dit nummer): DOET NIETS — geen naam,
   │    geen waarschuwing, stil genegeerd. Zie §5/[22](22-CUSTOMER-IDENTITY-STRATEGY.md).
   ▼
apps/ami-worker/src/services/notifier.ts:17-43 — POST naar {API_INTERNAL_URL}/internal/broadcast
   met header x-internal-secret: INTERNAL_SECRET
   ▼
apps/api/src/routes/internal.ts:39-95 — requireInternalSecret-gated route; haalt de Call-rij opnieuw
   op (met contact/assignedUser/notes) en emit via SocketServer (incoming_call/call_updated/
   call_answered/call_ended); bij call_answered ook een Web Push naar het beantwoordende toestel
   ▼
apps/api/src/socket/socketServer.ts:173-200 — Socket.IO-events naar room "calls" (alle clients)
   en room "call:{id}" (kijkers van dat specifieke gesprek)
   ▼  (twee consumenten)
   ├─ apps/web — IncomingCallPopup.tsx (toast + haalt /api/customer-history op voor "Exact historie")
   │    en ShopifyCustomerPanel.tsx (volledig Shopify-klant-/order-/draft-order-scherm)
   │
   └─ apps/windows-popup — socket.io-client met JWT, plus een HTTP-polling-fallback tegen
        GET /api/calls/active elke 5s wanneer de socket down is; popup.ts bepaalt of de native
        Windows-notificatie getoond wordt op basis van de eigen extensie van de ingelogde
        medewerker (admin kan opteren voor "alle gesprekken")
```

Handmatig klik-om-te-bellen (omgekeerde richting): `POST /api/calls/originate` (`apps/api/src/routes/calls.ts:323-374`) → HTTP POST naar `{AMI_WORKER_URL}/originate` met `x-internal-secret`.

**Identifiers beschikbaar op een Call-record** (`prisma/schema.prisma`, model `Call`): `id`, `uniqueId`/`linkedId` (AMI-correlatie), `callerNumber`, `callerName` (raw AMI óf Shopify-verrijkt, nooit beide bewaard), `calledExtension`/`answeredExtension`, `assignedUserId`/`contactId` (relaties), `status` (RINGING/ANSWERED/ENDED/MISSED/ABANDONED), `category` (OFFERTE/TERUGBELLEN/BESTELVRAAG/SERVICE_KLACHT/ONBEKEND), `startedAt`/`answeredAt`/`endedAt`/`durationSeconds`, relaties naar `events`/`notes`/`viewers`/`tasks`.

**Expliciet afwezig** (repo-breed gegrept, nul treffers): **geen `direction`-veld** (inkomend/uitgaand wordt nergens als vlag opgeslagen, alleen impliciet af te leiden), **geen call-recording-referentie**. **De Shopify customer-GID wordt niet op de Call-rij bewaard** — alleen de resolved naam (string). Een CRM-timeline die dit consumeert, zou de telefoon-gebaseerde Shopify-lookup zelf opnieuw moeten uitvoeren om een duurzame Shopify-klantreferentie te krijgen.

## 3. Gewenst eindresultaat getoetst: "Customer Timeline met gesprek → notitie → taak → Shopify order"

Op basis van bovenstaande en [21](21-TASKS-NOTES-REUSE-ANALYSIS.md): **dit is technisch mogelijk zonder duplicatie**, mits het CRM de bestaande `Call`/`CallNote`/`Task`-rijen via API leest (niet herbouwt) en zelf de Shopify-order-koppeling toevoegt (die vandaag nergens tussen TelefoonSysteem en Shopify-orders bestaat — TelefoonSysteem leest alleen Shopify *klanten*, niet orders, in de call-context). Zie [23-CRM-PHASE-1-FINAL-RECOMMENDATION.md](23-CRM-PHASE-1-FINAL-RECOMMENDATION.md) voor de concrete aanbeveling.

## 4. Users/Auth/Permissions — overzicht

- **Wachtwoord-hashing**: `bcryptjs` (pure-JS bcrypt, cost 12) — **een derde hashing-schema** naast POS' argon2 en OfferteApp's Werkzeug-hasher. Drie systemen, drie keuzes.
- **Sessie**: stateless JWT (`jsonwebtoken`), payload `{id, email, name, role}`, 7 dagen geldig (hardcoded, niet configureerbaar), `Authorization: Bearer`-header (geen cookie). **Geen DB-sessietabel, geen refresh-flow, geen logout/revocatie-endpoint** — een gestolen token blijft de volle 7 dagen geldig.
- **Rollen**: drie vlakke rollen (`ADMIN`/`AGENT`/`VIEWER`), afgedwongen via inline `requireRole(...)`-checks per route, geen granulair permissiesysteem (in tegenstelling tot OfferteApp's runtime-overschrijfbare `FEATURE_GROUPS`).
- **Interne service-auth**: gedeeld secret (`INTERNAL_SECRET`) via `x-internal-secret`-header, vergeleken met `crypto.timingSafeEqual` — hetzelfde soort patroon als OfferteApp's `x-integration-key` richting Pallet Yard, onafhankelijk gebouwd.
- **Rolwijziging is niet direct effectief**: `User.role` zit in het JWT-payload, dus een rolwijziging via `PUT /api/users/:id` werkt pas na herinloggen (tot 7 dagen later).

Vergelijking met POS/OfferteApp: zie de bijgewerkte tabel in [14-SHARED-CORE-DESIGN.md](14-SHARED-CORE-DESIGN.md) — dit is nu het **derde** onafhankelijk gebouwde auth-systeem in het landschap.

## 5. Database-eigenaarschap (tabel per gevraagd type)

| Type | Tabel/model | Database | Eigenaar (app) | Externe ID | Schrijft | Leest | CRM-relevantie | Aanbevolen toekomstige eigenaar |
|---|---|---|---|---|---|---|---|---|
| Customer history (Exact) | `ExactCustomer`/`ExactInvoice`/`ExactInvoiceLine` | `customer-history-db` (apart) | TelefoonSysteem (read-only consument; de echte schrijver is een externe Exact-syncjob buiten deze repo) | Exact-klantnummer, geen Shopify-ID | Niemand (binnen deze repo) | `apps/api` (2 GET-routes) | Facturatie-/omzethistorie voor Customer 360 | Blijft bij een toekomstige Finance/Core-integratie; CRM leest via API, niet direct |
| Contact | `Contact` | hoofd-DB (`DATABASE_URL`) | TelefoonSysteem | geen (alleen telefoonnummer als sleutel) | `apps/api` (`/contacts/ensure`), `apps/ami-worker` (bij nieuw gesprek) | `apps/api`, `apps/web` | Kandidaat-bron voor CRM-klantidentiteit, maar te dun (zie [22](22-CUSTOMER-IDENTITY-STRATEGY.md)) | CRM (na verrijking met echte Customer-identiteit) |
| ContactNote | `ContactNote` | hoofd-DB | TelefoonSysteem | — | `apps/api` (`POST /contacts/:id/notes`) | `apps/api`, `apps/web` | Directe kandidaat voor Customer Timeline-notities | CRM (via API-hergebruik of concept-hergebruik, zie [21](21-TASKS-NOTES-REUSE-ANALYSIS.md)) |
| Call | `Call` | hoofd-DB | TelefoonSysteem | Shopify-naam alleen als string, geen GID bewaard | `apps/ami-worker` | `apps/api`, `apps/web`, `apps/windows-popup` | Directe kandidaat voor Customer Timeline-events | Blijft bij TelefoonSysteem; CRM leest via API |
| CallNote | `CallNote` | hoofd-DB | TelefoonSysteem | — | `apps/api` | `apps/api`, `apps/web` | Zelfde als ContactNote | Blijft bij TelefoonSysteem; CRM leest via API |
| Task | `Task`/`TaskUpdate` | hoofd-DB | TelefoonSysteem | — | `apps/api` | `apps/api`, `apps/web` | Rijkste, meest CRM-klare model in het hele landschap | Zie [21](21-TASKS-NOTES-REUSE-ANALYSIS.md) — sterke kandidaat om via API te hergebruiken i.p.v. te herbouwen |
| User | `User` | hoofd-DB | TelefoonSysteem | — | `apps/api` | alle apps binnen TelefoonSysteem | Derde onafhankelijke auth-implementatie in het landschap | Voorlopig gescheiden houden (zie [14](14-SHARED-CORE-DESIGN.md)); geen directe hergebruik zonder bewust Shared-Core-Auth-besluit |

## 6. CRM-hergebruikadvies — Calls en Users/Auth (Contacts/Notes/Tasks/Shopify-matching in aparte rapporten)

- **Calls**: **2. HERGEBRUIKEN VIA API.** Het gesprek zelf (wie belde wanneer, welk toestel, welke status) is uniek TelefoonSysteem-domein — een CRM moet dit niet herbouwen, maar via een (nieuwe, read-only) API-laag tonen in de Customer Timeline. Directe database-koppeling wordt afgeraden (zie [22](22-CUSTOMER-IDENTITY-STRATEGY.md) voor de onderbouwing).
- **Users/Auth**: **4. NIET HERGEBRUIKEN (voorlopig).** Een derde, onafhankelijk auth-systeem toevoegen aan een CRM zou de inconsistentie in het landschap vergroten, niet verkleinen. Zie [14-SHARED-CORE-DESIGN.md](14-SHARED-CORE-DESIGN.md) Fase 0 — dit vereist eerst een platformbreed besluit, geen ad-hoc hergebruik van één van de drie bestaande implementaties.
