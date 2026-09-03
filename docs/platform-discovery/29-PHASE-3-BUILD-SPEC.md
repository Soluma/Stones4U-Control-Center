# 29 — Phase 3 Build Spec

Vervolg op `27-PHASE-3-DISCOVERY.md` en `28-PHASE-3-ARCHITECTURE.md` (ADR-007, ADR-008). Concrete bouwspecificatie — **nog niet geïmplementeerd, geen migraties gemaakt, geen deploy**. De kernbevinding uit discovery (§27 §5) bepaalt de scope hieronder direct: van de vier onderzochte uitbreidingen is er vandaag precies één zonder externe blokkade bouwbaar. Dit document splitst Phase 3 daarom expliciet in drie delen met verschillende bouwbaarheid, in plaats van één ononderbroken lijst te presenteren die de indruk zou wekken dat alles gelijktijdig kan starten.

## 1. Aanbevolen scope-indeling

### Phase 3a — vandaag bouwbaar, geen externe afhankelijkheid

- Shopify draft orders in Customer 360 (§27 §3) — geen nieuwe scope nodig.
- Centrale Customer Matching-laag (`ExternalContactMatch`, ADR-007) — het fundament, ook al is er in Phase 3a nog maar één "bron" (Shopify GID, al bestaand) die hem echt nodig heeft; klaarzetten voor 3b.
- Customer 360-herstructurering: Orders-tab → "Commercieel" met sub-secties (§28 §4).
- Activity Timeline: `DRAFT_ORDER_CREATED` (enige nieuwe type dat in 3a al data heeft).
- Command palette: ordernummer-zoeken (§28 §5).

### Phase 3b — ontworpen, klaar om te bouwen zodra een sibling-zijdig traject de blokkade opheft

- Telefonie-adapter (echte implementatie i.p.v. `DisabledTelephonyAdapter`) — wacht op TelefoonSysteem-zijdige service-auth (§27 §1.2).
- Offerte-adapters (OfferteApp + s4u-quote-app) — wacht op een read-API + service-auth aan beide kanten (§27 §4).
- Activity Timeline: `CALL_INBOUND`/`CALL_OUTBOUND`/`CALL_MISSED`, `QUOTE_CREATED`/`QUOTE_UPDATED`.
- Command palette: telefoonnummer- en offerte-ID-zoeken.

### Phase 3c — ontworpen, wacht op een besluit van Fons (geen technische blokkade, wel een keuze)

> **Correctie (2026-09-03, tweemaal)**: eerdere versies van dit document gingen eerst uit van Gmail, daarna kortstondig van Microsoft 365 als enige e-mailbron. Beide onjuist — Stones4U heeft twee mailboxen op twee providers (`info@stones4u.nl` op Microsoft 365, `info@stones4u.eu` waarschijnlijk op IMAP). Volledig, provider-onafhankelijk herzien ontwerp: `30-PHASE-3C-EMAIL-INTEGRATION-DISCOVERY.md`.
>
> **Status (2026-09-03) — Phase 3C-A gebouwd**: het Microsoft 365-deel hieronder is inmiddels geïmplementeerd en getest, geblokkeerd op een externe RBAC-configuratiestap vóór staging — zie `docs/build/PHASE-3C-A-MICROSOFT365-STAGING.md`. IMAP blijft een ontworpen, niet-gebouwde placeholder.

- Provider-onafhankelijke `EmailAdapter` met twee implementaties: `Microsoft365EmailAdapter` (`info@stones4u.nl`, Graph, application permissions + Exchange Online RBAC for Applications) en `ImapEmailAdapter` (`info@stones4u.eu`, ontworpen maar nog niet configureerbaar — host/auth onbekend). Elke mailbox onafhankelijk fail-safe. Geen sibling-repo-blokkade — wacht op admin-consent/RBAC-configuratie (Microsoft 365) resp. providergegevens (IMAP) door/via Fons (`30` §3/§4/§14).
- Activity Timeline: `EMAIL_INBOUND`/`EMAIL_OUTBOUND`, provider-aware stabiele ID's (`30` §8).
- Overzicht-blok "Recente e-mails" (samengevoegd over beide mailboxen).

**Praktisch advies**: bouw en deploy 3a als een zelfstandige, afgeronde Phase 3-oplevering. Start 3b/3c pas na een expliciete, aparte goedkeuring zodra hun vooraf-vereisten zijn opgelost — niet als één ononderbroken doorbouw-fase.

## 2. Voorgestelde datamodellen (Prisma, additief)

### 2.1 `ExternalContactMatch` (ADR-007) — nodig voor 3a (fundament) en 3b

Zie ADR-007 §Besluit voor het volledige model. Eén nieuwe tabel, drie nieuwe enums (`MatchSource`, `MatchMethod`, `MatchConfidence`).

### 2.2 Geen nieuwe kolommen op bestaande modellen nodig voor 3a

`CustomerProfile.phoneNormalized`/`email` (al bestaand sinds Phase 1) zijn voldoende voor de matching-sleutels. `Activity`/`ActivityType` krijgen alleen nieuwe enum-waarden (additief, geen kolomwijziging) — zie §3.

### 2.3 Voor 3c (Microsoft 365 + IMAP, provider-onafhankelijk), indien/wanneer gebouwd

Definitief herzien (2026-09-03) — zie `30-PHASE-3C-EMAIL-INTEGRATION-DISCOVERY.md` §5. `MonitoredMailbox` draagt nu een `provider`-veld (`MICROSOFT365` | `IMAP`) in plaats van providerspecifiek te zijn, en bevat **geen enkele credential**, voor geen van beide providers — Microsoft 365 gebruikt een tenant-breed app-credential (geen per-mailbox-token, zie §8), IMAP gebruikt een server-side secret (nooit in PostgreSQL, zie `30` §4.2).

```
enum EmailProvider {
  MICROSOFT365
  IMAP
}

model MonitoredMailbox {
  id           String        @id @default(cuid())
  emailAddress String        @unique
  displayName  String?
  provider     EmailProvider
  enabled      Boolean       @default(true)
  createdAt    DateTime      @default(now())
  updatedAt    DateTime      @updatedAt
}
```
Geen `accessTokenEnc`/`refreshTokenEnc`-kolommen, geen wachtwoordkolom — voor geen van beide providers. Bewust **geen** e-mailinhoud-opslag (ADR-008) — dit model bevat uitsluitend welke mailboxen in scope zijn en via welke provider, niets van hun inhoud of credentials.

## 3. Migraties (indicatief, niet gemaakt)

- **3a**: één migratie — `CREATE TABLE "ExternalContactMatch"` + drie `CREATE TYPE`-enums + 9 nieuwe `ALTER TYPE "ActivityType" ADD VALUE` (alle negen namen in één keer toevoegen is goedkoper dan gefaseerd, ook al wordt in 3a alleen `DRAFT_ORDER_CREATED` gebruikt — voorkomt een latere Postgres-enum-migratie-cyclus voor 3b/3c). Zuiver additief, geen enkele `DROP`/hernoeming — in tegenstelling tot de Phase 2-migratie is hier vooraf geen destructieve-statement-risico te verwachten.
- **3c**: aparte migratie voor `MonitoredMailbox` + `EmailProvider`-enum (§2.3), plus een additieve `ALTER TYPE "MatchSource" ADD VALUE 'EMAIL'` — generiek, niet per provider, zie §13 punt 7 voor de onderbouwing (het al gedeployde, ongebruikte `GMAIL`-enumlid blijft staan, niet destructief verwijderd — zie `30-PHASE-3C-EMAIL-INTEGRATION-DISCOVERY.md` §6) — alleen wanneer het e-mailintegratiebesluit (§13) genomen is.
- **Belangrijk, expliciet**: dit document maakt **geen** migratiebestand aan — dat gebeurt pas bij daadwerkelijke implementatie, met dezelfde handmatige SQL-review-discipline als Phase 2 (`docs/build/PHASE-2-PRODUCTION-*`).

## 4. Routes (3a)

| Route | Methode | Doel |
|---|---|---|
| `/api/customers/[id]/draft-orders` | GET | Shopify concept-orders voor deze klant (live) |
| `/api/customers/[id]/matches` | GET | Overzicht bevestigde/ambigue externe matches (leeg totdat 3b/3c actief zijn, maar endpoint-vorm alvast vastgelegd) |
| `/api/customers/[id]/matches` | POST | Handmatige match bevestigen (ADR-007 regel 3) |
| `/api/customers/[id]/matches/[matchId]` | DELETE | Match ontkoppelen (`unlinkedAt`, soft) |
| `/api/search` | GET (uitbreiding) | `orders`-groep toevoegen |

## 5. Schermen (3a)

- `Commercieel`-tab op Customer 360 (hernoemd van `Orders`), met interne sub-navigatie/filter (Orders/Concept-orders) — geen nieuwe route, dezelfde `?tab=`-parameter-conventie als bestaand.
- Overzicht-tab: geen wijziging in 3a (de "Recente gesprekken"/"Recente e-mails"-blokken horen bij 3b/3c, niet vooraf lege blokken tonen).
- Activiteit-tab: `DRAFT_ORDER_CREATED`-icoon/tint toevoegen aan de bestaande `KIND_STYLE`-map (`ActivityTimelineView.tsx`) — zelfde patroon als elke eerdere uitbreiding.
- Command palette: nieuwe `orders`-groep, zelfde rendering als bestaande `tasks`-groep.
- Geen nieuwe UI voor `ExternalContactMatch` in 3a zelf (er is nog niets te matchen buiten Shopify) — de API-vorm staat klaar, de UI (keuzescherm bij ambigue matches) wordt gebouwd zodra 3b een eerste echte externe bron oplevert.

## 6. Permissions

Ongewijzigd model (Phase 1 §6, consistent toegepast in Phase 2). Draft orders/matches: lezen voor alle rollen (consistent met bestaande Orders-tab), matches bevestigen/ontkoppelen vereist `requireWriteAccess()` (VIEWER blijft read-only).

## 7. Audit

Nieuwe `AuditAction`-waarden: `customer_match.confirmed`, `customer_match.unlinked`. Geen bestandsinhoud-equivalent risico hier (geen contentopslag), maar wel: nooit e-mailadres/telefoonnummer van een DERDE partij (bijv. een AMBIGUOUS-kandidaat die uiteindelijk niet gekozen wordt) onnodig in audit-metadata bewaren — alleen de uiteindelijk bevestigde/ontkoppelde relatie loggen.

## 8. Benodigde env vars / scopes / connections

### 3a
Geen nieuwe env vars. Bestaande Shopify client-credentials + bestaande scopes (`read_draft_orders` is al toegekend, ongebruikt — zie `27` §3).

### 3b (bij activering, niet in 3a te zetten)
- `TELEFOONSYSTEEM_API_BASE_URL` (al aanwezig in `.env.example` sinds Phase 1, nooit gebruikt) + een **nieuwe** naam voor de service-credential zodra TelefoonSysteem die levert (bijv. `TELEFOONSYSTEEM_SERVICE_TOKEN` — exacte naam hangt af van wat het TelefoonSysteem-traject oplevert, hier niet vooraf te fixeren).
- Equivalent voor OfferteApp/s4u-quote-app: nog geen bestaande env-var-namen, af te spreken zodra hun read-API's bestaan.

### 3c — provider-onafhankelijk, definitief herzien (zie `30-PHASE-3C-EMAIL-INTEGRATION-DISCOVERY.md` §11)

**Microsoft 365** (`info@stones4u.nl`), tenant-breed, geen per-mailbox secret:
- `MICROSOFT_GRAPH_TENANT_ID`, `MICROSOFT_GRAPH_CLIENT_ID`, `MICROSOFT_GRAPH_CLIENT_SECRET` (Fly secret, nooit in Git) — of later certificaatconfiguratie i.p.v. `CLIENT_SECRET`.
- Buiten Control Center's eigen config: Exchange Online RBAC for Applications (PowerShell-configuratie door een Microsoft 365-beheerder) die het app-credential tot uitsluitend deze mailbox beperkt — geen CRM-zijdig secret, wel een noodzakelijke, apart uit te voeren beheerdersactie (zie `30` §3.2/§14).

**IMAP** (`info@stones4u.eu`) — **geen definitieve env-namen vastgelegd** zolang host/poort/auth onbekend zijn (§12 van `30`); indicatief patroon: host, poort, TLS-vorm, gebruikersnaam, authenticatiemethode, en het credential zelf (wachtwoord/app-wachtwoord/OAuth-token) — uitsluitend als server-side secret, **nooit** in PostgreSQL.

De monitor-mailboxlijst zelf (`MonitoredMailbox`-tabel, §2.3) is voor beide providers geen geheim (bekende zakelijke adressen, geen credentials) — geen versleuteling nodig.

## 9. Buildvolgorde (3a, concreet)

1. Migratie: `ExternalContactMatch` + enums (handmatig SQL-gereviewd, zoals elke eerdere migratie in dit project).
2. `src/lib/email.ts`: `normalizeEmail()` — nieuw, klein, puur functie, analoog aan `src/lib/phone.ts`.
3. `src/modules/matching/matching.service.ts`: `matchByPhone`/`matchByEmail`/`confirmMatch`/`unlinkMatch`/`getMatchesForCustomer` — gebruikt `normalizeDutchPhone`/`normalizeEmail`, schrijft `AuditEvent`.
4. `src/integrations/shopify/draft-orders.ts`: `getShopifyCustomerDraftOrders()` — zelfde GraphQL-transportlaag als `orders.ts`, geen nieuwe client-code.
5. API-routes (§4).
6. UI: Commercieel-tab-herstructurering, Activiteit-icoon, command-palette-groep.
7. Tests (zie §10).
8. `docs/build/PHASE-3A-IMPLEMENTATION-REPORT.md` + staging-deploy + smoke test — zelfde discipline als Phase 1/2.
9. **Geen productie-deploy in dit document** — dat is, zoals bij Phase 1/2, een latere, apart te autoriseren stap.

## 10. Teststrategie

- Unit: `normalizeEmail()` (edge cases: hoofdlettergebruik, whitespace, `+`-aliassen — bewust WEL of NIET normaliseren, vast te leggen als test, niet als aanname), matching-service (exact/ambiguous/manual/unlink-paden, analoog aan de bestaande task/appointment-permissietests).
- Integratie: `ExternalContactMatch`-uniekheidsconstraint (dubbele match-poging = upsert, geen tweede rij) — zelfde patroon als de bestaande `CustomerProfile.shopifyCustomerGid`-dedup-test.
- Adapter: `getShopifyCustomerDraftOrders()` tegen een gemockte GraphQL-respons (zelfde mockstijl als `shopify-client.test.ts`), inclusief "geen concept-orders"/"Shopify onbereikbaar"-paden.
- Voor 3b/3c, ten tijde van activering: adapter-fail-safe-tests naar het bestaande `adapters.test.ts`-patroon (nooit throwen, altijd leeg bij onbeschikbaarheid) — nu al te schrijven als **placeholder-verwachting** in dit document, niet als code.

## 11. Concrete buildvolgorde-samenvatting

**3a** (deze fase, aanbevolen als eerstvolgende bouwstap): matching-fundament → Shopify draft orders → Customer 360-herstructurering → command palette → tests → staging.
**3b**: pas na TelefoonSysteem-/offerte-app-zijdige service-auth-trajecten (buiten dit repo) — dan telefonie-adapter, offerte-adapters, bijbehorende Timeline-types en command-palette-groepen, in die volgorde van waarschijnlijke waarde (telefonie raakt vermoedelijk meer klantcontact per dag dan offertes).
**3c**: provider-onafhankelijk, twee onafhankelijke paden. Microsoft 365 (`info@stones4u.nl`) is startbaar zodra de Exchange Online RBAC-configuratie (buiten dit repo, door een Microsoft 365-beheerder) is uitgevoerd. IMAP (`info@stones4u.eu`) wacht op de zes ontbrekende gegevens in `30` §12. Een gefaseerde 3c-oplevering (eerst Microsoft 365, later IMAP) is expliciet toegestaan door de architectuur (`30` §10/§13) — geen van beide paden blokkeert het andere. Zie `30-PHASE-3C-EMAIL-INTEGRATION-DISCOVERY.md`.

## 12. Explicit out-of-scope (herbevestigd uit de opdracht)

Complete mailclient, compose/send vanuit Control Center, volledige telefonie/PBX-vervanging, bellen via browser, recordings afspelen (bestaat sowieso niet, zie `27` §1.4), offerte-editor, offerte-app-migratie, kassasysteem-migratie, voorraadmanagement, leveranciers, inkooporders, productieplanning, transportplanning, service/tickets, boekhouding. Ook expliciet niet in dit document: enige migratie uitvoeren, enige deploy, enige codewijziging buiten deze documentatie.

## 13. Open beslissingen — input van Fons nodig

1. **TelefoonSysteem service-auth-traject**: wie/wanneer plant een apart traject om een leesbare service-credential aan TelefoonSysteem toe te voegen? Zonder dit blijft 3b's telefonie-deel op de plank liggen.
2. **OfferteApp/s4u-quote-app read-API-traject**: zelfde vraag, twee keer — en een prioriteitsvraag (welke van de twee eerst, gezien ze losstaan van elkaar).
3. **Microsoft 365 RBAC-beheerderstoegang**: wie binnen Stones4U configureert de Exchange Online RBAC for Applications-roltoewijzing voor `info@stones4u.nl` (Exchange Administrator-rechten of gelijkwaardig)? Zonder dit blijft dat pad van 3c op de plank liggen, ongeacht dat er verder geen technische blokkade is. Zie `30-PHASE-3C-EMAIL-INTEGRATION-DISCOVERY.md` §3.2/§14.
4. **`info@stones4u.eu`-providergegevens**: de zes ontbrekende gegevens uit `30` §12 (host, poort, TLS, authenticatiemethode, sent-map-detectie, wie een dedicated credential kan aanmaken) — wie kan deze opzoeken/aanleveren?
5. **E-mail-retentiebeleid**: zodra e-mailmetadata (ook al is het live, niet opgeslagen) zichtbaar wordt in Control Center, is er mogelijk een GDPR-inzage-/verwijderverzoek-consequentie te overwegen — een beleidsvraag, niet dit document se beslissing.
6. **Prioriteit 3a vs. wachten op 3b/3c-vooraf-vereisten**: is een Phase 3-livegang met **alleen** draft orders + matching-fundament (3a) een zinvolle, zelfstandige oplevering, of wil Fons liever wachten tot minstens telefonie (3b) ook meegaat? Dit document adviseert **niet wachten** (§1), maar dit is Fons' keuze. (Inmiddels achterhaald door de daadwerkelijke uitrol: 3a en 3b zijn beide al gebouwd en naar productie uitgerold — zie `docs/build/PHASE-3A-IMPLEMENTATION-REPORT.md` en de Phase 3B-productierollout. Dit item blijft ongewijzigd staan als historisch record van de toenmalige afweging.)
7. **`MatchSource`-enumcorrectie**: generiek `EMAIL` toevoegen naast het al gedeployde, ongebruikte `GMAIL`-enumlid (aanbevolen, additief, laag risico) — **niet** een providerspecifieke waarde (`MICROSOFT365`/`IMAP`), zie de onderbouwing in `30` §6 voor waarom dat onnodige koppeling zou creëren. Te bevestigen vóór de eerste Phase 3c-migratie.
8. **Gefaseerde 3c-oplevering**: eerst Microsoft 365 live, IMAP later toevoegen zodra §13 punt 4 is opgelost — of wachten tot beide klaar zijn? Dit document adviseert niet wachten (`30` §13), maar dit is Fons' keuze.

## 14. Eindconclusie

**PHASE 3 READY TO BUILD: JA, VOOR 3A — NEE, VOOR 3B/3C**

- **Phase 3a** (Shopify draft orders, Customer Matching-fundament, Customer 360-herstructurering, command-palette-uitbreiding) is **vandaag startbaar** — geen externe blokkade, geen sibling-repo-wijziging nodig, geen openstaand Fons-besluit vereist buiten de gebruikelijke "ga akkoord om te bouwen."
- **Phase 3b** (telefonie, offertes) is **ontworpen maar niet startbaar** totdat de in §13 punt 1/2 genoemde sibling-zijdige service-auth-trajecten zijn opgestart en opgeleverd — dit is geen technische onzekerheid in dit document, maar een harde externe afhankelijkheid buiten dit repo's controle.
- **Phase 3c** (e-mailintegratie, provider-onafhankelijk: Microsoft 365 + IMAP — twee keer gecorrigeerd, eerst van het onjuiste Gmail, daarna van het te enge Microsoft-365-only-ontwerp, zie `30-PHASE-3C-EMAIL-INTEGRATION-DISCOVERY.md`) heeft **twee onafhankelijke paden**: Microsoft 365 is **technisch startbaar zodra** de RBAC-configuratie (§13 punt 3) is uitgevoerd; IMAP wacht op de zes ontbrekende providergegevens (§13 punt 4). Geen sibling-repo-blokkade voor geen van beide, wel een bewuste admin-actie resp. ontbrekende praktische gegevens.

**Aanbevolen vervolgstap**: goedkeuring vragen voor Phase 3a als eerstvolgende, zelfstandige bouwfase, en parallel de twee sibling-zijdige service-auth-trajecten (TelefoonSysteem, offerte-apps) als aparte, expliciet te plannen initiatieven agenderen — niet als blokkerende voorwaarde voor 3a's start.

**Status (2026-09-03)**: Phase 3a en 3b zijn inmiddels daadwerkelijk gebouwd en naar productie uitgerold (zie `docs/build/PHASE-3A-IMPLEMENTATION-REPORT.md` en de Phase 3B-productierapportage) — deze eindconclusie beschrijft de situatie zoals die gold ten tijde van het oorspronkelijke Phase 3-ontwerp en blijft ongewijzigd als historisch record. Phase 3c staat nu, na deze (tweede) documentatiecorrectie, opnieuw klaar voor een Fons-beslissing — zie `30-PHASE-3C-EMAIL-INTEGRATION-DISCOVERY.md`.
