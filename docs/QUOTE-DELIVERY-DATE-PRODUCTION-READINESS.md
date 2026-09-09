# Quote Delivery Date Handoff — Production Readiness Review

**Update (Fase 4B, 2026-09-09)**: **PRODUCTIE-DEPLOY VOLTOOID.** Commit
`6889470` draait nu live op `stones4u-control-center` (v20). Alle
migraties toegepast, beide staged secrets nu actief, alle post-deploy
gates groen, **nul Shopify-mutaties uitgevoerd**. Zie §20 voor het
volledige rolloutverslag.

**Update (Fase 4A, 2026-09-09)**: **COMPLETE.** `write_draft_orders` is
geactiveerd op productie, en beide resterende secrets
(`DELIVERY_HANDOFF_TOKEN_SECRET`, `SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS`)
stonden als `Staged` — zie §19.

**Status (oorspronkelijk, vóór Fase 4A/4B)**: Pure discovery/planning.
**Geen enkele productiewijziging uitgevoerd** — alleen read-only
`fly status`/`fly secrets list`/`fly releases`/`fly ssh console`
(read-only queries) tegen `stones4u-control-center`, en read-only
GraphQL-queries tegen de echte Shopify-productiewinkel (nooit een
mutatie). `D:\Shopify\OfferteApp` en `https://offerteapp.fly.dev/` zijn
op geen enkel moment geopend, gelezen
of aangeraakt. Geen secretwaarden getoond — uitsluitend namen/digests/
booleans, plus de live `myshopifyDomain`-string (geen geheim, een
publieke winkelidentiteit).

Gebaseerd op de reeds live bewezen staging-implementatie
(`docs/QUOTE-DELIVERY-DATE-PORTAL-BUILD.md` §16-17, commit `6889470`,
gepusht naar `origin/main`, **nog niet gedeployed naar productie**).

## 1. Current production baseline

- **Fly app**: `stones4u-control-center`, 2 machines, beide `started`,
  health check passing.
- **Laatste deploy**: `v19`, 2026-09-04 19:36 — dus **vóór** commit
  `6889470` (gepusht 2026-09-08/09). Er is geen CI/CD-pipeline en geen
  git-sha-embedding-mechanisme in dit repo (bevestigd: geen
  `.github/workflows/`, geen versie-string in `Dockerfile`/health-route),
  dus een letterlijke commit-SHA-match is niet automatisch te bewijzen —
  wel met hoge zekerheid af te leiden: `fly deploy` bouwt altijd vanaf de
  lokale werkdirectory op het moment van de opdracht, nooit vanaf git, en
  er is sinds v19 niemand die dat commando heeft uitgevoerd. **Productie
  draait dus met zekerheid nog de pre-Fase-2A-code.**
- **Migratiestatus**: `npx prisma migrate status` op productie zelf: 8
  migraties gevonden, "Database schema is up to date" — exact de 8
  migraties van vóór Fase 7 (de 2 nieuwe `DeliveryDateHandoff`-migraties
  zijn nog niet toegepast, consistent met bovenstaande).
- **Productie-DB-identiteit**: `pgbouncer.w8675081jlxr3pk4.flympg.net` —
  aantoonbaar een andere cluster dan staging
  (`pgbouncer.9g6y30wdpnmrv5ml.flympg.net`).
- **Huidige Shopify-shop-domain — belangrijke bevinding**: live
  bevraagd (`shop.myshopifyDomain`), productie's daadwerkelijke,
  actuele winkel-handle is **`9h7x2c-ku.myshopify.com`** — niet
  `stones4u.myshopify.com` zoals eerder deze week losjes gebruikt in de
  OfferteApp-context (dat was OfferteApp's eigen, apart geconfigureerde
  winkelverwijzing, mogelijk een alias/legacy-handle voor dezelfde
  onderliggende winkel, of een genuine afwijking — niet verder onderzocht
  omdat dat OfferteApp-inspectie zou vereisen, wat deze fase expliciet
  verbiedt). **Voor déze productieomgeving is `9h7x2c-ku.myshopify.com`
  de enige geverifieerde, autoritatieve waarde** — elke toekomstige
  write-allowlist-configuratie moet exact deze string gebruiken, nooit
  een aangenomen "stones4u.myshopify.com".
- **Credential-type**: OAuth client-credentials (ADR-006), zelfde
  patroon als staging — geen OAuth-authorization-code-app.
  `SHOPIFY_CLIENT_ID`/`SHOPIFY_CLIENT_SECRET`-digests zijn identiek aan
  wat staging vóór Fase 2B had — bevestigt dat productie nog steeds de
  **enige, oorspronkelijke** gedeelde Shopify-credential gebruikt (niet
  de nieuwe, dedicated staging/dev-store-credential — die is uitsluitend
  op staging gezet).
- **Env vars aanwezig** (namen/digests, geen waarden):
  `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`,
  `SHOPIFY_API_VERSION`, `SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN` — allemaal
  `Deployed`.
- **`DELIVERY_HANDOFF_TOKEN_SECRET`**: **afwezig** — bevestigd via
  `fly secrets list` (niet in de lijst).
- **`SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS`**: **afwezig** — bevestigd
  via `fly secrets list` (niet in de lijst). Dit betekent: zelfs als de
  nieuwe code vandaag naar productie zou worden gedeployed, zou
  `assertShopifyWriteAllowed()` **direct fail-closed** gaan (lege
  allowlist → altijd een `ShopifyConfigError`, nooit een mutatie) —
  productie is op dit moment dus al **structureel beschermd tegen een
  onbedoelde Shopify-write**, ook zonder verdere actie.

## 2. Shopify production requirements — scope-delta

Bepaald vanuit de daadwerkelijke code
(`src/integrations/shopify/draft-order-mirror.ts`), niet aangenomen —
zelfde delta als eerder vastgesteld voor staging, nu tegen productie's
eigen, live opgevraagde scopes vergeleken:

| Scope | Nodig voor deze feature | **Huidig op productie (live bevestigd)** |
|---|---|---|
| `read_draft_orders` | ✅ | ✅ aanwezig |
| `write_draft_orders` | ✅ | ❌ **afwezig** |
| `read_orders` | ✅ | ✅ aanwezig |
| `read_customers` | ❌ niet nodig | ✅ aanwezig (voor Customer 360's eigen, bestaande klant-opzoekfunctie — ongerelateerd, blijft ongewijzigd) |
| `read_all_orders` | ❌ niet nodig | ✅ aanwezig (ongerelateerd aan deze feature) |

**Delta: alleen `write_draft_orders` ontbreekt.** Geen scope-config
gewijzigd — uitsluitend live gelezen. Zelfde traject als bij staging: dit
is een client-credentials-app, dus geen browser-herautorisatiestap nodig
— wel een expliciete "Install"/"Update"-klik in Shopify Admin ná het
aanvinken van de scope (zelfde les als bij staging: het aanvinken alleen
was daar niet voldoende).

## 3. Write safety production design

`assertShopifyWriteAllowed()` (Fase 2A, `write-safety-guard.ts`) is
**omgevingsonafhankelijk en config-only** — geen enkele code-aanpassing
nodig voor productie. De enige actie: op productie
`SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS` zetten op **exact één** waarde:

```
SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS=9h7x2c-ku.myshopify.com
```

(de live-geverifieerde waarde uit §1 — **niet** een aangenomen
"stones4u.myshopify.com"). Geen wildcard, geen dev-store, geen tweede
shop zonder expliciete reden — matcht de eis exact.

**GO-voorwaarde, ongewijzigd van het ontwerp**: pas productie-write
toestaan wanneer, live geverifieerd op het moment van deploy:
```
effective Shopify shop == SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN == SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS
```
Aangezien `SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN` op productie al langer
correct is ingesteld (dagelijks gebruikt, geen gerapporteerde identity-
mismatch), is de enige nieuwe stap het toevoegen van de derde,
gelijkluidende waarde.

## 4. Delivery token secret

`DELIVERY_HANDOFF_TOKEN_SECRET`: **afwezig op productie** (bevestigd,
§1). Er moet een **nieuwe, dedicated** waarde gegenereerd worden — nooit
`SESSION_SECRET` hergebruiken (zelfde, expliciete motivatie als in
`docs/QUOTE-DELIVERY-DATE-PORTAL-BUILD.md` §2: andere tokenklasse, ander
blootstellingsoppervlak, andere rotatiebehoefte). Niet gegenereerd, niet
gezet in deze fase — uitsluitend geconstateerd.

Aanbevolen commando voor Fons, later, tijdens de daadwerkelijke rollout:
```
fly secrets set --app stones4u-control-center DELIVERY_HANDOFF_TOKEN_SECRET="$(openssl rand -hex 32)"
```

## 5. Migration review

Twee migraties, beide reeds live toegepast en geverifieerd op staging
(Fase 2B §16.12):

**`20260908154729_phase7_delivery_date_handoff`**:
- Wijzigingen: 3 nieuwe enums (`QuoteSourceSystem`, `PaymentProvider`,
  `DeliveryDateHandoffStatus`), 1 nieuwe tabel (`DeliveryDateHandoff`, 11
  kolommen), 4 nieuwe indexen (1 unique op `publicTokenHash`, 1 unique
  composite op `(sourceSystem, externalId)`, 2 losse indexen), 2 nieuwe
  foreign keys (`customerProfileId` → `CustomerProfile`, `ON DELETE SET
  NULL`; `createdById` → `User`, `ON DELETE RESTRICT`).
- **Geen wijziging aan een bestaande tabel.**
- Lock/risk-profiel: `CREATE TABLE`/`CREATE TYPE`/`CREATE INDEX` op een
  gloednieuwe, nog lege tabel — geen lock op bestaande tabellen, geen
  tablescan, geen rewrite van bestaande rijen. Verwachte looptijd: sub-
  seconde op een database van deze omvang (bevestigd empirisch op
  staging: de volledige `release_command` inclusief beide migraties
  liep binnen de normale deploy-tijd, geen waarneembare vertraging).
- Reversibility: volledig — een `DROP TABLE "DeliveryDateHandoff"` +
  `DROP TYPE` voor de drie enums zou de exacte inverse zijn (Prisma
  genereert dit niet automatisch als "down"-migratie, maar het is
  triviaal en zonder dataverlies uit te voeren omdat de tabel bij een
  eventuele rollback per definitie leeg of irrelevant is — zie §15).
- Effect op bestaande data: **geen** — geen enkele bestaande rij wordt
  gelezen, gewijzigd of verwijderd.

**`20260908154948_phase7b_delivery_date_activity`**:
- Wijzigingen: 1 nieuwe waarde op de bestaande `ActivityType`-enum
  (`ALTER TYPE ... ADD VALUE`), 1 nieuwe, nullable kolom op de bestaande
  `Activity`-tabel (`relatedDeliveryDateHandoffId`), 1 nieuwe foreign key
  (`ON DELETE SET NULL`).
- **Enige wijziging aan een bestaande tabel**: een nullable kolom
  toevoegen aan `Activity` — een additieve `ALTER TABLE ADD COLUMN`
  zonder `NOT NULL`/`DEFAULT`-constraint op bestaande rijen, dus geen
  tablerewrite, geen lock langer dan een korte DDL-lock (Postgres kan een
  nullable kolom zonder default toevoegen als pure metadata-wijziging,
  zonder de tabel te herschrijven).
- Effect op bestaande data: bestaande `Activity`-rijen krijgen simpelweg
  `relatedDeliveryDateHandoffId = NULL` — geen enkele bestaande waarde
  gewijzigd.
- `ALTER TYPE ... ADD VALUE` is in Postgres **niet transactioneel
  reversible** binnen dezelfde sessie waarin hij is toegevoegd (een
  bekende Postgres-beperking, geen Prisma-specifiek risico) — relevant
  voor rollback, zie §15.

**Beide migraties zijn additief, bevatten geen destructieve DDL, en
wijzigen geen bestaande businessdata.** Bevestigd, niet aangenomen.

## 6. Deploy behavior — antwoorden uit code, niet aangenomen

**A. Worden bestaande portalflows gewijzigd?** Nee. Geen enkel bestaand
bestand buiten `Customer 360`'s `page.tsx` is aangeraakt in de hele
Fase-7-wijziging (zie de diff-stat in
`docs/QUOTE-DELIVERY-DATE-PORTAL-BUILD.md` §1) — geen enkele andere
route, module of component gewijzigd.

**B. Worden bestaande Customer 360-pagina's gewijzigd?** Ja, in precies
één opzicht: een nieuwe, altijd-lege-tenzij-een-handoff-bestaat sectie
"Gewenste leverdatum klant" verschijnt onderaan het Commercieel-tabblad.
Voor elke bestaande klant vandaag: leeg (`EmptyState`, geen fout, geen
crash) — er bestaat nog geen enkele `DeliveryDateHandoff`-rij op
productie, en die kan ook na deploy niet vanzelf ontstaan (zie D).

**C. Wordt Shopify ineens automatisch geschreven?** Nee — bevestigd op
twee onafhankelijke niveaus: (1) er bestaat geen enkele codepad dat
`mirrorRequestedDeliveryDateToShopify()` aanroept behalve
`submitRequestedDeliveryDate()`, die zelf alleen wordt aangeroepen vanuit
`POST /api/delivery/[token]` — een route die alleen reageert op een
inkomend HTTP-verzoek met een geldig, reeds bestaand token; (2) zelfs als
zo'n verzoek zou binnenkomen, faalt `assertShopifyWriteAllowed()` altijd
fail-closed zolang `SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS` niet gezet
is (§1) — een dubbele barrière.

**D. Worden `DeliveryDateHandoff`-records automatisch aangemaakt?**
Nee — bevestigd: de enige plek die `createDeliveryDateHandoff()`
aanroept is `POST /api/delivery-handoffs`
(`requireWriteAccess()`-beveiligd), en **nergens in de huidige codebase
wordt die route zelf aangeroepen** — geen cronjob, geen webhook, geen
UI-knop (bewust niet gebouwd, zie Fase 2A-build-doc §"rollout gates").
Deploy op zichzelf creëert dus exact **nul** nieuwe rijen.

**E. Worden bestaande klanten/orders/offertes geraakt?** Nee — geen
enkele bestaande Prisma-query op `CustomerProfile`/`Order`/`Opportunity`/
etc. is gewijzigd; de enige toevoeging is een nieuwe, apart uit te
voeren query naar een nieuwe, lege tabel.

**F. Worden publieke `/delivery`-routes beschikbaar?** Ja, technisch
bereikbaar direct na deploy — maar zonder enige geldige token (want geen
handoff bestaat, zie D) resulteert elk bezoek in een generieke 404. Geen
enumeratie-endpoint, geen manier om een geldig token te raden of af te
leiden.

**G. Kan iemand zonder geldige token daar iets doen?** Nee — bevestigd
via de bestaande, live bewezen security-E2E (Fase 2C §17.16): elk
onbekend/geraden/gemanipuleerd token → 404, geen enkele mutatie mogelijk
zonder een reeds bestaand, geldig token.

**Harde verwachting bevestigd: geen Shopify-write mogelijk zonder een
expliciete handoff-POST, en die POST is zelf onmogelijk zonder een reeds
handmatig aangemaakte handoff-rij.**

## 7. Feature activation question

**Advies: geen aparte feature flag nodig.** De architectuur is al
inherent veilig, om drie onafhankelijke, elk op zichzelf al voldoende
redenen (zie §6): (1) geen token bestaat totdat een staff-lid expliciet
`POST /api/delivery-handoffs` aanroept — een actie die vandaag nergens
vanuit de UI getriggerd kan worden; (2) OfferteApp's bestaande
facturatiemails wijzen nergens naar de portal-URL (niet aangeraakt, niet
onderzocht deze ronde, maar reeds bevestigd in eerdere fases); (3) er is
geen enkel automatisch aanmaakmechanisme. Een feature flag zou hier
uitsluitend cosmetische schijnveiligheid toevoegen bovenop een al
sluitend ontwerp — expliciet afgeraden, conform de instructie.

## 8. Staff creation API — risicobeoordeling

`POST /api/delivery-handoffs` (`src/app/api/delivery-handoffs/route.ts`):

- **Wie kan hem aanroepen?** Elke ingelogde gebruiker met een geldige
  sessie die `requireWriteAccess()` doorstaat.
- **Auth/rol**: `requireWriteAccess()` = `requireRole("ADMIN", "AGENT")`
  (`src/platform/auth/guards.ts`) — **VIEWER kan dit niet** (403,
  bevestigd via code-inspectie van `requireRole()`'s expliciete
  allowlist-check).
- **Kan een willekeurige staff-user elke Shopify Draft-ID invoeren?**
  Ja — `shopifyDraftOrderGid` wordt niet live tegen Shopify
  geverifieerd op het moment van aanmaken (geen Shopify-aanroep in
  `createDeliveryDateHandoff()` — bevestigd, zie D hierboven). Een
  getypte/verzonnen GID leidt niet tot een fout bij aanmaken, wel later
  tot een nette, retrybare `DeliveryHandoffError` ("Draft Order bestaat
  niet (meer)") zodra een klant de link daadwerkelijk bezoekt en een
  datum indient — geen crash, geen inconsistente state, wel een
  vermijdbare, verwarrende klantervaring. **Aanbeveling (niet blocking
  voor GO)**: bij een latere UI-uitbreiding, de opgegeven GID live tegen
  Shopify verifiëren vóór het aanmaken van de rij.
- **Kan dit een Shopify-write veroorzaken vóór de klant-POST?** Nee —
  bevestigd, `createDeliveryDateHandoff()` doet geen enkele
  Shopify-aanroep.

**Risico-conclusie**: laag. Enige reëel risico is een staff-typefout die
pas laat zichtbaar wordt (UX, geen security/data-integriteitsrisico) —
niet blokkerend voor productie-GO.

## 9. Customer 360 impact

- Bestaande klanten blijven normaal laden — de nieuwe query
  (`listDeliveryDateHandoffsForCustomer`) is een simpele, geïndexeerde
  `findMany` op `customerProfileId` (`@@index([customerProfileId])`
  bestaat al op het model), geen N+1 (één query per paginaload, geen
  sub-queries per rij), geen joins met onbegrensde tabellen.
- Voor een klant zonder handoffs: lege array, `EmptyState`-component,
  geen fout.
- Geen enkele bestaande query gewijzigd — puur additief, sequentieel
  toegevoegd naast de al bestaande fetches op dezelfde pagina.
- Performance-impact: verwaarloosbaar — vergelijkbaar met de reeds
  bestaande `listTagsForCustomer`/`listContactsForCustomer`-achtige
  simpele lookups op dezelfde pagina.

## 10. Public route security

Bevestigd (herhaling van reeds bewezen eigenschappen, Fase 2A/2C):
opaque 256-bit token, alleen hash opgeslagen, onbekend token → 404, geen
PII op de pagina, geen enumeratie-endpoint, geen numerieke fallback,
geen open redirect, geen klant-sessie vereist.

**Rate limiting**: `src/platform/security/rate-limit.ts` bestaat al in
dit repo (ongebruikt door de delivery-routes). **Advies: niet toevoegen
vóór productie-GO.** Motivatie: het realistische risico dat rate
limiting zou mitigeren is niet token-gokken (256-bit entropie maakt dat
statistisch onhaalbaar, ongeacht rate limit) maar herhaald misbruik van
een reeds bekend, gestolen token — een scenario dat even goed van
toepassing is op bijvoorbeeld de bestaande `/login`-route, die ook geen
rate limiting heeft. Geen inconsistente, nieuwe veiligheidsdrempel
introduceren die nergens anders in dit repo bestaat. Als een reëel
misbruikpatroon zich later voordoet, is dit een kleine, geïsoleerde
toevoeging — geen architecturale wijziging.

## 11. Payment path — Mollie-grens

Bevestigd (Fase 2A/2C, ongewijzigd): Phase A ondersteunt uitsluitend
Shopify. `paymentProvider = MOLLIE` faalt gesloten, niet-retryable, geen
OfferteApp-aanroep, geen fallback, geen request-aangeleverde URL, geen
nieuwe Mollie-betaling. Er bestaat geen enkele Mollie-integratie in dit
repo — de bestaande Mollie-productieflow (die uitsluitend in OfferteApp
leeft) wordt door deze feature op geen enkele manier aangeraakt of
beïnvloed, simpelweg omdat er geen verbinding tussen de twee bestaat.

## 12. OfferteApp-grens

Om deze portalcode naar productie te deployen hoeft `D:\Shopify\OfferteApp`
en `https://offerteapp.fly.dev/` **niet** gewijzigd te worden. De huidige
productie-OfferteApp blijft volledig zelfstandig werken, ongewijzigd, en
ongemoeid. De nieuwe portalfeature blijft functioneel ongebruikt totdat
er later een expliciete integratie/entrypoint komt (§13) — tot die tijd
bestaat er geen enkele runtime-afhankelijkheid, netwerkaanroep, of
gedeelde state tussen de twee systemen voor deze feature.

## 13. Toekomstige entrypoint/activatie — opties op hoog niveau

| Optie | Omschrijving | OfferteApp-wijziging | Risico | Automatisering | Benodigde identifiers |
|---|---|---|---|---|---|
| **A. Handmatig in Control Center** | Staff roept `POST /api/delivery-handoffs` aan (rechtstreeks of via een toekomstige, kleine UI-knop) met een Shopify Draft Order GID die ze al in Customer 360/Shopify Admin zien. | Geen | Laag | Geen — één actie per offerte | Alleen de Draft Order GID (al zichtbaar in `DraftOrdersTable`) |
| **B. Vanuit een bestaand Control-Center-integratiepunt** | Automatisch een handoff voorstellen/aanmaken zodra een nieuwe Draft Order verschijnt in `getShopifyCustomerDraftOrders()` (bijv. een knop naast elke rij in `DraftOrdersTable`). | Geen | Laag-Middel — vereist een nieuwe UI-interactie, zelfde onderliggende, al bewezen service | Gedeeltelijk — staff triggert nog steeds, maar met minder handmatig typewerk | Draft Order GID, al beschikbaar in de bestaande component |
| **C. Aparte service/API-aanroep vanuit een externe offertebron** | OfferteApp (of s4u-quote-app) roept actief de CRM's `POST /api/delivery-handoffs` aan wanneer een factuur wordt verstuurd. | **Ja** — een nieuwe, uitgaande aanroep vanuit OfferteApp | Middel-Hoog — vereist een nieuw service-token, nieuwe foutafhandeling in OfferteApp, coördinatie tussen twee systemen | Volledig automatisch | Draft Order GID vanuit OfferteApp's eigen Shopify-koppeling |
| **D. Minimale OfferteApp-mailwijziging** | OfferteApp's factuurmail-CTA wijst naar de CRM's `/delivery/[token]` i.p.v. OfferteApp's eigen `/delivery/<uuid>` (het al bestaande, gecommitte-maar-niet-gedeployde OfferteApp-Fase-1-werk). | **Ja** — vereist zowel de OfferteApp-mailwijziging als een manier om vooraf een CRM-handoff-token te injecteren in die mail | Hoog — twee systemen moeten synchroon een enkele publieke flow bedienen; het grootste ontwerp- en coördinatierisico | Volledig automatisch, maar met de meeste bewegende delen | Draft Order GID + een correlatie tussen OfferteApp's verstuur-moment en de CRM's token-aanmaak |

**Aanbeveling**: begin met **optie A** (geen enkele extra codewijziging
nodig — de staff-API bestaat al) als eerste, laagrisico pilot. Overweeg
**B** pas nadat A in de praktijk bruikbaar is gebleken. **C en D
uitdrukkelijk uitstellen** — beide vereisen een OfferteApp-wijziging,
wat expliciet zo lang mogelijk vermeden moet worden per de gegeven
instructie. Geen van deze opties is in deze fase geïmplementeerd.

## 14. Production Shopify test strategy — zonder een echte klant/order te muteren

Aanbevolen post-deploy-verificatie, **geen synthetische productie-Draft
Order nodig als harde eis** — de Draft→Order-attribuutoverleving is al
live bewezen tegen de dev-store (Fase 2C, identiek Shopify-gedrag,
schema-onafhankelijk van welke winkel het is):

1. `GET /api/health` → 200.
2. `npx prisma migrate status` op productie → "up to date" (beide nieuwe
   migraties toegepast).
3. `GET /delivery/<willekeurig-token>` → 404.
4. Live Shopify-authenticatie (client-credentials-tokenverzoek) → OK.
5. Live `shop.myshopifyDomain` == `SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN` ==
   `SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS`.
6. Live `currentAppInstallation.accessScopes` bevat `write_draft_orders`.
7. Customer 360 laadt normaal voor een bestaande klant, paneel toont
   `EmptyState`.

**Wanneer zou een synthetische productie-Draft toch nodig zijn?**
Uitsluitend als er een concrete, nieuwe reden ontstaat om te twijfelen
aan de generieke Shopify-Draft→Order-attribuutsemantiek specifiek voor
déze winkel (bijv. een andere Shopify-planversie met afwijkend gedrag) —
geen enkele aanwijzing daarvoor gevonden. **Default: NIET doen.** Als
absoluut toch gewenst, exact hetzelfde recept als Fase 2C (custom line
item, geen klant, direct opruimen) — maar dan tegen de échte winkel, met
navenant hoger voorzichtigheidsniveau; dit rapport raadt dit af.

## 15. Rollback plan

- **Code-rollback**: `fly deploy` van de vorige image (`fly releases`
  toont `v19`'s image-referentie) of van de vorige lokale commit —
  standaard, al gedocumenteerd Fly-procedure (`docs/deployment/
  FLY-PRODUCTION.md`), niets nieuws nodig voor deze feature.
- **Database-rollback**: **niet nodig bij een code-rollback.** De
  additieve `DeliveryDateHandoff`-tabel mag na een code-rollback gewoon
  blijven staan — geen enkele oudere code-versie leest of verwacht die
  tabel, dus haar aanwezigheid is onschadelijk voor de teruggerolde
  applicatie. Dit vermijdt het risico van een destructieve
  schema-downgrade. Enige uitzondering: de `ALTER TYPE ... ADD VALUE`
  voor `ActivityType.DELIVERY_DATE_REQUESTED` is, zoals genoemd in §5,
  niet triviaal ongedaan te maken binnen Postgres — maar dat is ook niet
  nodig, want een oudere applicatieversie schrijft die waarde nooit en
  een extra, ongebruikte enum-waarde is functioneel onschadelijk.
- **Secrets/config-rollback**: als `SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS`
  al gezet was vóór een rollback-beslissing, kan die gewoon blijven staan
  (een oudere applicatieversie roept `assertShopifyWriteAllowed()` sowieso
  nooit aan) — of, voor maximale voorzichtigheid, met `fly secrets unset`
  verwijderd worden. Geen van beide is destructief of tijdgevoelig.

**Voorkeur, expliciet bevestigd**: een code-rollback zonder destructieve
schema-rollback is voldoende en veilig in elk scenario.

## 16. Exacte rolloutvolgorde (nog NIET uitgevoerd)

**PRE** (vóór enige deploy):
1. `write_draft_orders` aanvinken in Shopify Admin voor de bestaande
   productie-Shopify-app, gevolgd door een expliciete "Install"/"Update"
   om de scope daadwerkelijk aan de actieve installatie te koppelen
   (§2 — de checkbox alleen is, zoals bij staging bleek, niet voldoende).
2. Nieuwe, dedicated `DELIVERY_HANDOFF_TOKEN_SECRET` genereren en zetten
   (§4).
3. `SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS=9h7x2c-ku.myshopify.com`
   zetten (§3, de live-geverifieerde waarde).
4. `SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN` herbevestigen (al correct, geen
   wijziging verwacht — alleen ter controle vóór de volgende stap).
5. Config-bewijs: live herquery `shop.myshopifyDomain` +
   `currentAppInstallation.accessScopes`, vergelijk tegen de drie
   bovenstaande waarden — **hard STOP-gate**: bij enige afwijking niet
   verder gaan.
6. Backup/migratie-veiligheid: bevestigen dat Fly Managed Postgres'
   automatische backup actief is voor de productiecluster (al eerder
   vastgesteld tijdens de oorspronkelijke Fase-1-productiedeployment,
   `docs/deployment/FLY-PRODUCTION.md` — niet opnieuw geverifieerd deze
   ronde, wel expliciet te herbevestigen vóór de daadwerkelijke rollout).

**DEPLOY**:
7. `fly deploy -c fly.production.toml --app stones4u-control-center` —
   **expliciet target, nooit een default**.
8. `release_command` (`npx prisma migrate deploy`) draait automatisch,
   blokkeert de hele deploy bij een fout (bestaand, bewezen Fly-gedrag).
9. Health checks op beide machines groen.

**POST** (§14's checklist, exact):
10. Migratiestatus groen, beide nieuwe migraties toegepast.
11. Runtime-config-gelijkheid: effective shop == expected == allowlist.
12. Read-only Shopify-auth + scope-check (`write_draft_orders` aanwezig).
13. Publiek onbekend token → 404.
14. Customer 360-smoke-test op een bestaande klant.
15. **Bevestigen: nul mutaties uitgevoerd** — uitsluitend de hierboven
    genoemde read-only checks, geen enkele `draftOrderCreate`/`Update`/
    `Complete`.

**Harde STOP-gates**: bij elke afwijking in stap 5 of 11/12/13 — niet
verder gaan, rollback overwegen conform §15, opnieuw rapporteren voordat
verder wordt gegaan.

## 17. GO/NO-GO-checklist

| Voorwaarde | Status vandaag |
|---|---|
| Vereiste Shopify-scopes actief (`write_draft_orders`) | ❌ nog niet — actie vereist (§16 stap 1) |
| Productie-shop-identiteit exact geverifieerd | ✅ live bevestigd (`9h7x2c-ku.myshopify.com`) |
| Write-allowlist exact geconfigureerd | ❌ nog niet gezet |
| Dedicated token secret aanwezig | ❌ nog niet gezet |
| Migraties gereviewd, additief bevestigd | ✅ (§5) |
| Volledige testsuite groen | ✅ 575/575 (Fase 2C, hernieuwd te bevestigen vlak vóór de daadwerkelijke deploy als extra voorzorg) |
| Staging-evidence intact | ✅ Draft→Order-gate VERIFIED (Fase 2C) |
| Geen OfferteApp-afhankelijkheid | ✅ bevestigd (§12) |
| Rollback-plan gedocumenteerd | ✅ (§15) |

**Drie configuratie-acties resterend, geen codewijziging.**

## 18. Samenvatting

Deze feature is functioneel en veiligheidstechnisch **klaar voor
productie**, maar productie zelf is nog **niet geconfigureerd** voor de
write-guard en de token-hashing. Dat is precies zoals bedoeld: de code
zelf is al fail-closed-by-default (bevestigd in §1/§6), dus zelfs een
deploy van de huidige code náár productie, vóórdat de drie
configuratiestappen zijn gezet, zou **nog steeds geen enkele Shopify-
write toestaan** — het zou alleen de (nog onbruikbare) publieke routes
beschikbaar maken. De aanbevolen volgorde (§16) zet de configuratie
eerst, zodat de functionaliteit *en* de veiligheidsgaranties vanaf het
eerste moment samen actief zijn, in plaats van een tussenperiode met
gedeployde-maar-non-functionele code.

## 19. Fase 4A — production preconfiguratie (2026-09-09)

**Resultaat: BLOCKED op stap 2.** Read-only baseline herbevestigd, geen
enkele wijziging aangebracht.

### 19.1 Read-only baseline — herbevestigd

- Fly-versie: nog steeds `v19`, 2026-09-04 — bevestigt dat productie nog
  altijd de pre-`6889470`-code draait.
- `DELIVERY_HANDOFF_TOKEN_SECRET`: afwezig.
- `SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS`: afwezig.

### 19.2 Shop identity — hard fact bevestigd

Live, read-only herbevraagd:
```
SHOPIFY_SHOP_DOMAIN (env):         9h7x2c-ku.myshopify.com
SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN: 9h7x2c-ku.myshopify.com
LIVE myshopifyDomain (Shopify):    9h7x2c-ku.myshopify.com
```
**A + B van de Fase-4B-gate zijn groen**: effective shop == expected
shop == de hard-fact-waarde uit de opdracht, exact.

### 19.3 Scope-check — BLOCKER

```
GRANTED SCOPES: read_all_orders, read_customers, read_draft_orders, read_orders
has write_draft_orders: false
```

`write_draft_orders` is **niet** actief op de production-installatie.
Conform instructie gestopt vóór elke verdere stap — geen
`DELIVERY_HANDOFF_TOKEN_SECRET`/`SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS`
gezet, zelfs niet als `Staged`, totdat deze scope actief is.

**Actie voor Fons, exact**: in het Shopify Dev Dashboard, bij de
bestaande **production** Control-Center-app-configuratie (niet de
staging/dev-store-app — dit is een aparte app-registratie tegen de echte
winkel `9h7x2c-ku.myshopify.com`), bij Admin API access scopes
`write_draft_orders` aanvinken, en vervolgens — zelfde les als eerder bij
zowel de OfferteApp-dev-store als de Control-Center-staging-dev-store —
een expliciete **Install/Update-actie** uitvoeren in Shopify Admin zodat
de scope daadwerkelijk aan de actieve installatie wordt gekoppeld (het
aanvinken van de checkbox alleen volstaat niet). Geen andere scope
toevoegen.

### 19.4 Client credentials — ongewijzigd, bevestigd

`SHOPIFY_CLIENT_ID`/`SHOPIFY_CLIENT_SECRET`-digests op productie
identiek aan wat eerder al vastgesteld was — **niet gewijzigd, niet
vervangen** door staging/dev-store-credentials. Geen waarden gelezen.

### 19.5 Wat NIET is uitgevoerd

Conform de STOP: geen `fly secrets set`/`fly secrets import --stage`
aangeroepen, geen `DELIVERY_HANDOFF_TOKEN_SECRET` gegenereerd, geen
`SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS` gezet — geen van beide, ook niet
als `Staged`. Geen `fly deploy`/`fly secrets deploy`/restart/migratie.
Geen Shopify-mutatie van welke aard dan ook — uitsluitend de twee
read-only queries uit §19.2/§19.3.

### 19.6 Fase 4B-gate — status na de scope-fix (nog dezelfde dag)

`write_draft_orders` is door Fons geactiveerd op de production Shopify-
app "CRM" (Install/Update-actie uitgevoerd). Live, read-only herbevraagd:

```
LIVE myshopifyDomain: 9h7x2c-ku.myshopify.com
GRANTED SCOPES: read_all_orders, read_customers, read_draft_orders,
                read_orders, write_draft_orders
has write_draft_orders: true
```

Vervolgens de twee resterende configuratiestappen uitgevoerd, uitsluitend
als `Staged` (`fly secrets set --stage` — expliciet skipt deployment voor
machine-apps, bevestigd via `flyctl`'s eigen hulptekst):

- `DELIVERY_HANDOFF_TOKEN_SECRET`: nieuw gegenereerd, 256-bit
  (`openssl rand -hex 32`), rechtstreeks in dezelfde opdracht als het
  `fly secrets set`-commando gegenereerd — de waarde is op geen enkel
  moment apart weergegeven, gelogd of getoond.
- `SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS`: gezet op
  `9h7x2c-ku.myshopify.com`. Digest-bewijs zonder de waarde te lezen:
  identiek aan de digest van het al bestaande
  `SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN`/`SHOPIFY_SHOP_DOMAIN`
  (`11f0f89b5d9ec4fa`) — bevestigt dat de drie exact dezelfde string
  bevatten.

`fly secrets list --app stones4u-control-center` bevestigt beide als
`Staged` (niet `Deployed`), en meldt zelf expliciet: *"2 secrets not
deployed. Deploy with `fly secrets deploy` to make them available."* —
géén `fly secrets deploy` uitgevoerd. `fly status` bevestigt: beide
machines nog op `VERSION 19`, `LAST UPDATED`-tijdstempels ongewijzigd
sinds vóór deze sessie — geen deploy, geen restart.

| Voorwaarde | Status |
|---|---|
| A. effective shop = `9h7x2c-ku.myshopify.com` | ✅ |
| B. expected shop = `9h7x2c-ku.myshopify.com` | ✅ |
| C. `write_draft_orders` actief | ✅ |
| D. `DELIVERY_HANDOFF_TOKEN_SECRET` staged | ✅ |
| E. `SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS` staged, bedoeld als `9h7x2c-ku.myshopify.com` | ✅ (digest-bewezen) |
| F. production credentials ongewijzigd | ✅ (`SHOPIFY_CLIENT_ID`/`_CLIENT_SECRET`-digests identiek aan vóór deze sessie) |
| G. geen deploy/restart/migratie uitgevoerd | ✅ |

**Alle Fase-4A-voorwaarden groen.** Fase 4B (de daadwerkelijke deploy)
kan bij een aparte, expliciete opdracht starten.

## 20. Fase 4B — gecontroleerde production deploy (2026-09-09)

**Resultaat: volledig geslaagd.** Commit `6889470` draait live op
`stones4u-control-center`. Nul Shopify-mutaties, nul OfferteApp-
aanrakingen, nul automatische handoff-aanmaak.

### 20.1 Pre-deploy gates (stappen 3-6, herbevestigd vóór deploy)

- **Target proof**: `fly.production.toml` → `app = "stones4u-control-center"`;
  elk Fly-commando met expliciete `--app`, nooit een default.
- **Baseline**: `v19` (bekend goed), beide machines `started`/healthy;
  `DELIVERY_HANDOFF_TOKEN_SECRET` en `SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS`
  beide `Staged`; `SHOPIFY_CLIENT_ID`/`_CLIENT_SECRET`-digests ongewijzigd.
- **Database-veiligheid**: cluster `w8675081jlxr3pk4`
  (`stones4u-cc-production-db`) — bevestigd via `fly mpg list`,
  **exclusief** gekoppeld aan `stones4u-control-center` (geen andere app
  gekoppeld). 8/8 migraties vóór deploy. Recentste backup: 2026-09-09
  10:03:36Z (~50 min oud op het moment van controle), reguliere uurlijkse
  cadans, alle `completed`.
- **Shopify-precheck**: live herbevraagd — effective shop = expected shop
  = `9h7x2c-ku.myshopify.com`; scopes bevatten `read_draft_orders`,
  `write_draft_orders`, `read_orders`. Geen mutatie.

Alle zes gates groen — doorgegaan naar deploy.

### 20.2 Deploy

```
fly deploy --config fly.production.toml --app stones4u-control-center
```

- Build: cached (identieke image als de eerdere staging-deploy van
  dezelfde commit — `sha256:4dda573b...`), gepusht naar
  `registry.fly.io/stones4u-control-center`.
- `release_command` (`npx prisma migrate deploy`) — **geslaagd**:
  ```
  10 migrations found in prisma/migrations
  Applying migration `20260908154729_phase7_delivery_date_handoff`
  Applying migration `20260908154948_phase7b_delivery_date_activity`
  All migrations have been successfully applied.
  ```
- Rolling update van beide machines, elk met een korte (~5s), volledig
  normale "health check failed tijdens opstarten"-periode, gevolgd door
  "now passing" — geen crash, geen restart-loop, geen falende health
  check die niet vanzelf herstelde.
- DNS-verificatiewaarschuwing (`i/o timeout` op Fly's eigen DNS-check) —
  hetzelfde bekende, onschadelijke, transiënte Fly-artefact gezien bij
  elke eerdere deploy in dit hele traject; app zelf bevestigd bereikbaar
  (§20.4).

### 20.3 Post-deploy migratie + data-integriteit

`npx prisma migrate status` op productie zelf: **10 migraties gevonden,
"Database schema is up to date."** Data-integriteit rechtstreeks via de
gegenereerde Prisma-client op de draaiende machine geverifieerd:
```
users: 1, customers: 4, deliveryDateHandoff: 0
```
Bestaande productiedata (1 gebruiker, 4 klantprofielen — echte,
al aanwezige gegevens) volledig intact. Nieuwe tabel aanwezig, leeg —
geen synthetische rij aangemaakt, geen automatische aanmaak opgetreden.

### 20.4 Post-deploy health

`fly status`: beide machines op **v20**, `started`, health check
passing. `GET /api/health` → **200**.

### 20.5 Runtime hard gate — alle drie exact gelijk

Live, na deploy, op de draaiende machine:
```
DELIVERY_HANDOFF_TOKEN_SECRET present: true
SHOPIFY_SHOP_DOMAIN:                      9h7x2c-ku.myshopify.com
SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN:        9h7x2c-ku.myshopify.com
SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS:  9h7x2c-ku.myshopify.com
AUTH: OK
LIVE myshopifyDomain:                     9h7x2c-ku.myshopify.com
EQUALITY shop==expected==allowlist: true
```
De token secret is nu **actief** (niet langer alleen `Staged`) —
bevestigd doordat het draaiende proces `Boolean(process.env.
DELIVERY_HANDOFF_TOKEN_SECRET)` als `true` teruggeeft.

### 20.6 Shopify read-only postcheck

```
GRANTED SCOPES: read_all_orders, read_customers, read_draft_orders,
                read_orders, write_draft_orders
draftOrders read: OK count=1
orders read: OK count=1
```
Uitsluitend reads (`shop`, `currentAppInstallation.accessScopes`,
`draftOrders(first:1)`, `orders(first:1)`) — de `count=1` betreft
bestaande, reeds aanwezige winkeldata, niet iets dat deze sessie
aanmaakte. Geen `customer`-veld bevraagd. **Geen enkele mutatie.**

### 20.7 Publieke route smoke

- `GET /delivery/<willekeurig-token>` → **404**.
- `POST /api/delivery/<willekeurig-token>` → **404**.
- Geen `Location: /login`-redirect — bevestigd via de ruwe response-
  headers (RSC-specifieke headers, de eigen `notFound()`-logica van de
  nieuwe route, niet een generieke catch-all). Geen geldige handoff
  aangemaakt, geen raw token voor productie gegenereerd.

### 20.8 Customer 360 — gegevenslaagbewijs (geen staff-sessie beschikbaar)

Zelfde bekende beperking als bij elke eerdere fase: geen staff-
inloggegevens beschikbaar, dus geen letterlijke browser-screenshot. De
exacte query die `listDeliveryDateHandoffsForCustomer()` gebruikt,
rechtstreeks tegen een **echt bestaand** productie-klantprofiel
uitgevoerd (geen klantgegevens getoond, geen klantgegevens gewijzigd):
```
QUERY_SUCCEEDED: true
HANDOFF_COUNT_FOR_REAL_CUSTOMER: 0
```
Geen fout, correcte lege staat — bevestigt dat de nieuwe sectie op
Customer 360 voor elke bestaande klant vandaag foutloos als lege
`EmptyState` rendert.

### 20.9 Side-effect-bewijs

- `DeliveryDateHandoff`-aantal: **0**, ongewijzigd sinds vóór deploy.
- Geen `Activity`-rij aangemaakt (geen enkele handoff om er een te
  triggeren).
- Geen Shopify-write (uitsluitend reads uitgevoerd, §20.6).
- Geen betaalactie.
- Geen OfferteApp-aanroep (geen code in dit repo roept OfferteApp
  vanuit deze feature aan; deze sessie heeft `D:\Shopify\OfferteApp`/
  `offerteapp.fly.dev` op geen enkel moment geopend of benaderd).

### 20.10 Logs

`fly logs --app stones4u-control-center` over het volledige deploy-
venster gecontroleerd: release-command-log toont de twee migraties
expliciet en netjes toegepast, gevolgd door "All migrations have been
successfully applied", exit code 0. Beide machines: een kort,
verwacht "health check failed" tijdens de ~5 seconden opstarttijd
(Next.js' eigen boot-tijd, "Ready in 736ms"/"687ms"), direct gevolgd
door "now passing." **Geen enkele Prisma-fout, geen env/configfout,
geen Shopify-auth-fout, geen route-exception, geen Customer-360-
renderfout.** Geen secrets in de logs.

### 20.11 Rollback

**Niet nodig uitgevoerd** — de release was in elk opzicht gezond vanaf
het eerste moment (§20.4-20.10). Het gedocumenteerde rollback-plan
(§15) bleef ongebruikt, staat klaar indien ooit nodig.

### 20.12 Eindstatus

| Voorwaarde | Status |
|---|---|
| Production deploy geslaagd | ✅ v20 |
| Health groen | ✅ |
| Migrations 10/10 | ✅ |
| shop = expected = allowlist | ✅ `9h7x2c-ku.myshopify.com` |
| `DELIVERY_HANDOFF_TOKEN_SECRET` actief | ✅ |
| Shopify-scopes correct | ✅ (`write_draft_orders` incl.) |
| Onbekend publiek token → 404 | ✅ |
| Customer 360 gezond | ✅ (gegevenslaag bewezen) |
| Geen automatische handoff | ✅ (0 rijen) |
| Geen Shopify-mutatie | ✅ (uitsluitend reads) |
| Geen OfferteApp-interactie | ✅ |
| Geen production-business-data-mutatie | ✅ |

**Alle voorwaarden groen. Fase 4B volledig afgerond.**
