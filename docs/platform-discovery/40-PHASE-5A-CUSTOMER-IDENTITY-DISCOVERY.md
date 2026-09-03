# 40 — Phase 5A Discovery: Customer Identity — Persoon vs. Organisatie

**Status**: Discovery, geen implementatie. Vervolg op Phase 4C (productie-
commit `ed20c073282a1badb495a6d64222a224ccac74d3`). Basis voor
`41-PHASE-5A-CUSTOMER-IDENTITY-ARCHITECTURE.md` en `42-PHASE-5A-BUILD-SPEC.md`.

## 1. Huidige `CustomerProfile`-identiteitsmodel

`prisma/schema.prisma` — velden en eigenaarschap, geverifieerd door de code
te lezen (niet aangenomen):

| Veld | Eigenaar | Wanneer gevuld/ververst |
|---|---|---|
| `shopifyCustomerGid` | Shopify (immutabel) | eenmalig bij aanmaak, nooit gewijzigd |
| `displayName` | Shopify | bij elke `getOrCreateCustomerProfile()`-aanroep (zie §4) |
| `companyName` | Shopify (vandaag) | idem |
| `email` | Shopify | idem |
| `phone`/`phoneNormalized` | Shopify | idem |
| `crmStatus` | Control Center | handmatig, via `updateCustomerCrmFields()` |
| `accountManagerId` | Control Center | handmatig, idem |
| `lastSyncedAt` | Control Center (afgeleid) | gezet bij elke sync |
| tags (`CustomerTagAssignment`) | Control Center | handmatig |
| `CustomerContact[]` (Phase 4C) | Control Center | handmatig |
| `ExternalContactMatch[]` (Phase 3a) | Control Center (matching-laag) | automatisch/handmatig bevestigd |

**Geen bestaand `customerType`- of vergelijkbaar veld.** `CrmStatus` (`LEAD/
ACTIVE/INACTIVE/AT_RISK/VIP`) is een levenscyclus-status, geen
persoon/organisatie-onderscheid — geverifieerd door de enum-definitie te
lezen.

## 2. `companyName` — waarom staat dit nu leeg?

**Kernbevinding: het is geen synchronisatiebug.** `companyName` wordt al
wél gelezen uit Shopify (`defaultAddress.company`,
`src/integrations/shopify/customers.ts`) en al wél weggeschreven naar
`CustomerProfile.companyName` bij elke `getOrCreateCustomerProfile()`-aanroep
(`src/modules/crm/customer-profile.service.ts`, zowel `create` als `update`
in de upsert). De reden dat het bij de drie bestaande productieklanten leeg
is: **de onderliggende Shopify-data is zelf leeg.**

Geverifieerd met een read-only GraphQL-query rechtstreeks tegen de
productie-Shopify-winkel (geen schrijfactie):

- Alle drie bekende `CustomerProfile`-rijen (Mr. Oner, JS Verkoelen, Fons
  Verkoelen): `defaultAddress.company = null`, en (waar aanwezig)
  `addresses[].company = null` op elk adres.
- Voor "JS Verkoelen" bovendien de laatste 5 bestellingen gecontroleerd:
  `shippingAddress.company`/`billingAddress.company` allemaal `null`.
- Een steekproef van 10 willekeurige, recent-bijgewerkte Shopify-klanten
  (niet beperkt tot de drie in dit CRM bekende profielen): **eveneens
  overal `company: null`** waar een `defaultAddress` überhaupt bestaat.

**Conclusie**: in de gecontroleerde steekproef (13 klanten) is het
`company`-veld in deze Shopify-winkel structureel ongebruikt — niet omdat
onze code het niet leest, maar omdat de checkout/adresinvoer het kennelijk
niet vraagt of klanten het niet invullen. Dit is een aanwijzing, geen
bewezen feit voor de hele klantenbase (de steekproef is klein) — maar
voldoende om vast te stellen dat we niet blind op "empty company = geen
zakelijke klanten" mogen vertrouwen, én dat er geen leesbug is die eerst
gerepareerd moet worden.

## 3. Shopify-brondata — wat is al beschikbaar

`src/integrations/shopify/customers.ts`'s `CUSTOMER_FIELDS` haalt al op:
`id`, `displayName`, `firstName`, `lastName`, `email`, `phone`,
`defaultAddress.{address1,city,company}`, `numberOfOrders`, `amountSpent`.//
`ShopifyCustomerSummary` (het TypeScript-type) draagt dit al 1-op-1 door,
inclusief `firstName`/`lastName` los van `displayName` en `company` als
apart veld.

**Shopify B2B (`Company`/`CompanyLocation`/`companyContactProfiles`)**:
geverifieerd met een repo-brede grep — **nul treffers**. Shopify B2B wordt
nergens gebruikt of aangenomen. Bevestigt de instructie's eigen
waarschuwing: niet aannemen dat dit actief is.

**Order-niveau bedrijfsdata** (`shippingAddress.company`/
`billingAddress.company`): technisch beschikbaar via de Shopify Order-API,
maar nog nergens door onze code opgehaald — en, voor zover gecontroleerd
(§2), ook op ordernniveau leeg voor de enige klant die getest is.

## 4. Lazy creation / refresh — het precieze mechanisme

`getOrCreateCustomerProfile(shopifyGid)` is de enige plek die
Shopify-eigen velden naar `CustomerProfile` schrijft — een upsert die zowel
bij aanmaak als bij een hernieuwde aanroep **alle** Shopify-eigen velden
onvoorwaardelijk overschrijft (`displayName`, `companyName`, `email`,
`phone`, `phoneNormalized`, `lastSyncedAt`).

**Deze functie wordt uitsluitend aangeroepen vanaf `POST
/api/customers/resolve`** — dat gebeurt elke keer dat een gebruiker een
Shopify-zoekresultaat opent (command palette of `/customers`-zoekpagina),
ook voor een **al bestaand** lokaal profiel (de eigen code-comment noemt
dit expliciet: "Lazily creates (or refreshes)"). Navigeert een gebruiker
echter via een **interne** link (een taak, opportunity, of eerder bezochte
klant) rechtstreeks naar `/customers/{lokale-id}`, dan wordt `resolve`
**niet** aangeroepen — `getCustomer360()` doet dan uitsluitend een
`prisma.customerProfile.findUnique()` (geen upsert) plús, apart, een **live**
Shopify-fetch die uitsluitend voor weergave wordt gebruikt en nooit wordt
teruggeschreven.

**Belangrijke nevenvondst**: `getCustomer360()` haalt dus al bij **elke**
Customer 360-paginabezoek de actuele Shopify-klant op (`shopify`-object in
de return-waarde) — zonder deze ooit naar `CustomerProfile` te schrijven.
Dit betekent dat een "ververs de lokale snapshot bij elk bezoek"-strategie
**geen enkele nieuwe Shopify-aanroep** zou kosten — de data wordt al
opgehaald, alleen nog niet teruggeschreven (zie architectuurdoc §8/§9).

## 5. Customer 360-header / klantzoeken / command palette — huidige weergave

`CustomerHeader.tsx`: `<h1>{shopify.displayName}</h1>` als primaire titel,
`[shopify.company, shopify.email, shopify.phone, shopify.defaultAddressSummary]`
als secundaire detailregel — `company` staat er dus al **in**, maar nooit
prominent en zonder enig visueel onderscheid tussen "dit is toevallig
ingevuld" en "dit is de eigenlijke klantidentiteit."

`CustomerSearch.tsx` (Shopify-zoekresultaten) en de `customers`-groep in
`/api/search` (command palette): identiek patroon — `displayName` als
titel, `company` in de subtitel-regel.

## 6. `displayName ?? companyName`-patroon — al overal in de app aanwezig

Een repo-brede grep op `displayName.*companyName` levert **vijftien**
treffers op, verspreid over opportunities (board, detail, dashboard, zoeken),
taken (lijst, detail), afspraken (dashboard-widget), offertes-adapter, en de
command-palette-groepen voor taken/opportunities/contacten. **Elke** treffer
gebruikt exact hetzelfde patroon:

```ts
customerProfile.displayName ?? customerProfile.companyName ?? "Klant"
```

Dit is dus al **consistent** (geen tegenstrijdige patronen aangetroffen),
maar consistent in de **verkeerde** volgorde voor een zakelijke klant:
overal in de app verschijnt vandaag de persoonsnaam van de accounthouder
als primaire klantnaam, nooit de bedrijfsnaam — precies het gat dat de
opdracht wil dichten (§18: "Klant: Jansen Tuinen BV. Niet automatisch: Jan
Jansen."). Alle vijftien plekken selecteren `companyName` al in hun Prisma-
query — er is dus nergens een ontbrekende databasekolom, alleen
inconsistente presentatielogica die met één gedeelde helper-functie
gecorrigeerd kan worden (zie architectuurdoc §6).

## 7. `CustomerContact` (Phase 4C) — huidige relatie

Al volledig gebouwd en in productie: `customerProfileId`-gebonden,
Control-Center-owned, nooit automatisch uit Shopify afgeleid (ADR-010 §5).
Matching (`resolveAndRecordByEmail`/`Phone`) blijft uitsluitend op exacte,
genormaliseerde e-mail/telefoon — geen enkele bedrijfsnaam- of
klanttype-afhankelijkheid aangetroffen in `matching.service.ts`.

## 8. Wat ontbreekt (de eigenlijke Phase 5A-scope)

- Geen expliciet `customerType`-concept (persoon vs. organisatie).
- Geen bescherming tegen het overschrijven van een handmatig gecorrigeerde
  `companyName` bij de volgende `resolve()`-aanroep.
- Geen consistente, herbruikbare "welke naam is primair"-beslissing — vijftien
  plekken dupliceren dezelfde (voor zakelijke klanten onjuiste) logica.
- Customer 360 toont nooit expliciet "Accounthouder: {naam}" als aparte,
  ondergeschikte regel bij een organisatie.
- Geen lazy refresh van de lokale snapshot bij een gewoon paginabezoek
  (alleen bij een hernieuwde Shopify-zoekactie) — ondanks dat de data er al
  ligt.
