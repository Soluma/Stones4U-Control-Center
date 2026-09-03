# Phase 5A — Customer Identity: Persoon vs. Organisatie: staging build report

**Status**: gebouwd, getest (476/476 tests groen, typecheck/lint/build
groen), gedeployed naar `stones4u-control-center-staging` (versie 24,
migratie `20260903224436_phase5a_customer_identity_type` toegepast via
`release_command`), gevalideerd met een staging-E2E (10/11 scenario's
groen tegen de draaiende staging-app; scenario K faalde alleen op een
bekende tooling-beperking van losse tsx-scripts, niet op productiecode —
zie §20). Niet gecommit, niet gepusht, geen productie-actie.

Vervolg op `docs/platform-discovery/40-PHASE-5A-CUSTOMER-IDENTITY-DISCOVERY.md`,
`41-PHASE-5A-CUSTOMER-IDENTITY-ARCHITECTURE.md`,
`42-PHASE-5A-BUILD-SPEC.md`, `docs/architecture/ADR-011-CUSTOMER-IDENTITY-TYPE.md`.

## 1. Datamodel

Twee additieve kolommen op `CustomerProfile`: `customerTypeOverride
CustomerType?` en `companyNameConfirmed Boolean @default(false)`, plus één
nieuwe enum `CustomerType { INDIVIDUAL, ORGANIZATION }`. Precies het
minimale model uit ADR-011 — geen `companyNameOverride`,
`accountHolderName`, `customerTypeDerived`, `organizationName`, en geen
opgeslagen `effectiveCustomerType`. `customerTypeOverride=null` betekent
expliciet "automatisch afleiden", niet "INDIVIDUAL" — dat onderscheid is
overal in de code en in de tests bewust zichtbaar gehouden.

## 2. Migratie

`prisma/migrations/20260903224436_phase5a_customer_identity_type/migration.sql`
— handmatig gecontroleerd, drie statements: `CREATE TYPE "CustomerType"`,
`ADD COLUMN "companyNameConfirmed" BOOLEAN NOT NULL DEFAULT false`, `ADD
COLUMN "customerTypeOverride" "CustomerType"`. Geen `DROP`, geen wijziging
van een bestaande kolom, geen backfill/`UPDATE`-statement. Bestaande
`CustomerProfile`-rijen zijn ongewijzigd en vallen automatisch en correct
terug op de afgeleide waarde (`customerTypeOverride=null`,
`companyNameConfirmed=false` — exact het huidige, ongewijzigde
syncgedrag).

## 3. `effectiveCustomerType()` — waarheidstabel

`src/modules/crm/customer-identity.ts`, precies het patroon van
`effectiveProbability()` (ADR-009): override wint altijd; zonder override
bepaalt een niet-leeg (whitespace-getrimd) `companyName` `ORGANIZATION`,
anders `INDIVIDUAL`. Volledige dekking in
`tests/customer-identity.test.ts` (20 tests): beide override-richtingen,
beide afgeleide richtingen, expliciet leeg/whitespace-only `companyName`
als "niet gevuld".

## 4. Display-helpers

`customerDisplayName()`/`customerSecondaryName()` (op `CustomerProfile`-
vorm) en de aparte `shopifyCustomerDisplayName()`/
`shopifyCustomerSecondaryName()` (op `ShopifyCustomerSummary`-vorm, voor
live Shopify-zoekresultaten zonder lokaal profiel — build spec §17).
Kritieke edge cases getest en werkend: `customerTypeOverride=ORGANIZATION`
met `companyName=null` valt veilig terug op `displayName` (nooit een lege
titel); de "Accounthouder: {naam}"-regel verschijnt nooit wanneer die naam
identiek is aan de al getoonde primaire naam.

## 5. Shopify-sync — `syncCustomerIdentityFromShopify()`

Hernoemd van `getOrCreateCustomerProfile()` (alle aanroepers bijgewerkt:
`/api/customers/resolve`, `getCustomer360()`). `displayName`/`email`/
`phone` verversen onvoorwaardelijk; `companyName` ververst — inclusief het
terugzetten naar `null` — uitsluitend wanneer `companyNameConfirmed`
`false` is. CRM-eigen velden (`crmStatus`, `accountManagerId`, tags,
`customerTypeOverride`, `companyNameConfirmed` zelf) worden nooit door
deze functie aangeraakt.

## 6. Null-company-semantiek — het expliciet vereiste scenario

Getest in `tests/customer-profile.test.ts`: een profiel met
`companyName="Jansen Tuinen BV"` en `companyNameConfirmed=false` wordt bij
de eerstvolgende sync, als Shopify's `company` inmiddels `null` is,
correct teruggezet naar `companyName=null` — nooit stale data. Een tweede
test bevestigt het tegenovergestelde: zodra `companyNameConfirmed=true`
is (via een handmatige correctie), blijft `companyName` ongewijzigd, ook
als Shopify's waarde daarna verandert — alleen `displayName`/`email`/
`phone` verversen dan nog.

## 7. Handmatige klanttype-override

`updateCustomerCrmFields()` uitgebreid met `customerTypeOverride` — geen
nieuwe route, hergebruikt de bestaande `PATCH /api/customers/[id]`. 100%
Control-Center-owned, nooit door de Shopify-sync aangeraakt (geen
Shopify-tegenhanger, dus structureel geen syncconflict mogelijk).

## 8. Handmatige bedrijfsnaam-correctie

Ook via `updateCustomerCrmFields()`: een expliciete lege/`null`-waarde is
een bewuste "geen bedrijf"-bevestiging, geen "veld niet meegegeven" — in
beide gevallen wordt `companyNameConfirmed=true` gezet. Het onderscheid
"veld wel/niet meegegeven" wordt gemaakt via `!== undefined` op het
geparste PATCH-body-object (niet via `"key" in object`, om te voorkomen
dat een niet-meegegeven veld per ongeluk als "expliciet gewijzigd naar
undefined" in de audit/activity-metadata terechtkomt — zie §11).

## 9. Atomaire "reset naar Shopify"

Nieuwe functie `resetCompanyNameToShopify()`: één live Shopify-read, dan
`companyName` gezet op precies Shopify's huidige waarde (inclusief
`null`) en `companyNameConfirmed=false`, in één atomaire operatie.
Aangestuurd via dezelfde `PATCH`-route met `{ resetCompanyNameToShopify:
true }` — bij aanwezigheid van dat veld worden alle overige velden in
diezelfde request genegeerd. Geverifieerd in zowel de Vitest-suite als de
staging-E2E (scenario H).

## 10. `customerTypeOverride` en `companyName` zijn onafhankelijk

Getest in beide richtingen (`tests/customer-profile.test.ts` en
staging-E2E scenario's D–G): een type-override wint altijd, ongeacht of
`companyName` gevuld is; een `companyName`-correctie laat een bestaande
override ongemoeid.

## 11. Audit/activity-hergebruik

Geen nieuwe `ActivityType` of `AuditAction` — beide bestaande
`CUSTOMER_PROFILE_UPDATED`/`customer_profile.updated` hergebruikt, ook
voor de reset-actie (met `metadata.reset: true` ter onderscheiding). Eén
correctie tijdens het bouwen: de eerste versie van de route bouwde de
`changes`-payload door het hele geparste PATCH-body-object door te geven
inclusief niet-meegegeven (`undefined`) velden — dat zou onnodige
`undefined`-vermeldingen in de audit-metadata hebben opgeleverd.
`updateCustomerCrmFields()` filtert nu expliciet alle `undefined`-velden
eruit vóórdat diff/audit gebeurt, zodat de audit-trail alleen daadwerkelijk
gewijzigde velden bevat — geen documentatie-afwijking, puur een
implementatiedetail opgelost tijdens het bouwen zelf.

## 12/13/14. Customer 360-UX

`CustomerHeader.tsx`: primaire titel nu `customerDisplayName()`
(bedrijfsnaam voor een organisatie, accounthoudernaam voor een
particulier), met een ondergeschikte "Accounthouder: {naam}"-regel die
nooit dupliceert. Nieuwe `CustomerTypeControl.tsx` (Automatisch/
Particulier/Zakelijk, met toelichtende tekst bij "Automatisch") en
`CompanyNameControl.tsx` (inline-bewerkbaar, met een "Gebruik weer
Shopify"-actie die uitsluitend zichtbaar is wanneer
`companyNameConfirmed=true`) — beide mirroren het bestaande
`CrmStatusControl.tsx`/`AccountManagerControl.tsx`-patroon.

## 15. `CustomerContact` ongewijzigd

Geen enkele wijziging aan `customer-contact.service.ts`'s
matching/aanmaaklogica — alleen de `customerProfile`-`select` in
`searchCustomerContacts()` uitgebreid met `customerTypeOverride` t.b.v. de
command-palette-weergave (§19).

## 16/17. Klantenlijst en Shopify-zoekresultaten

`CustomerSearch.tsx` (live Shopify-zoekresultaten, command-palette
`customers`-groep) gebruikt nu de aparte
`shopifyCustomerDisplayName()`/`shopifyCustomerSecondaryName()`-helpers —
bewust een ander koppel dan `customerDisplayName()`, omdat live
zoekresultaten geen lokaal `CustomerProfile`/`customerTypeOverride` hebben
(build spec §17).

## 18/19. Command-palette contactpersonen/opportunities/taken

Alle vier groepen (`customers`, `tasks`, `opportunities`, `contacts`) in
`src/app/api/search/route.ts` bijgewerkt. Bevestigd in staging-E2E
scenario J: een taak gekoppeld aan een organisatie-klant toont de
bedrijfsnaam, niet de accounthoudernaam, in de command-palette.

## 20/21. Opportunities/orders/drafts/quotes — presentatie-only

Vijftien bekende call sites (zie build spec) allemaal geconverteerd naar
`customerDisplayName()`, met `customerTypeOverride` toegevoegd aan elke
onderliggende Prisma-`select`. Geen enkele nieuwe query — alle vijftien
selecteerden `companyName` al (bevestigd tijdens discovery, §6 van doc 40).

## 22. Matching-regressie — bevestigd zonder afhankelijkheid

Repo-brede grep op `customerType`/`companyName` binnen
`src/modules/matching/`: **nul treffers**. Een nieuwe regressietest in
`tests/matching.test.ts` bevestigt dit functioneel: een profiel met
`customerTypeOverride=ORGANIZATION` en een gevulde `companyName` matcht
exact zoals elk ander profiel op telefoon/e-mail. In de staging-E2E kon
dit specifieke scenario (K) niet via het losse tsx-script draaien — een
bekende, al eerder in deze sessie gedocumenteerde beperking: een dynamische
`import()` van een `"server-only"`-getagd, `@/`-alias-zwaar servicemodule
crasht in een los `tsx`-script buiten de Next.js-buildpijplijn (`Cannot
find module 'server-only'`). Dit is geen productiecode-bug — de al
groene, dedicated Vitest-integratietest is hier het gezaghebbende bewijs,
niet het staging-script.

## 23. Lazy sync — geen extra Shopify-aanroepen

`getCustomer360()` haalt Shopify-klant + orders op zoals voorheen (2
aanroepen), en geeft de al-opgehaalde `shopify`-data nu door aan
`syncCustomerIdentityFromShopify({ shopify })` — die slaat de eigen
Shopify-read dan over. Geverifieerd via codepad-inspectie (geen derde
`getShopifyCustomerByGid`-aanroep in het pad) én empirisch: staging-E2E
scenario B (Customer 360 GET na een eerdere `resolve()`) toonde geen
meetbare extra latentie of foutmelding die op een dubbele aanroep zou
wijzen.

## 24/25/26/27. Lazy-creation, bestaande profielen, geen bulk-migratie, scope

Nieuwe profielen krijgen `customerTypeOverride=null`,
`companyNameConfirmed=false` — identiek aan het kolom-default, geen aparte
create-logica nodig. Bestaande profielen (productie: 3 rijen, alle
`companyName=null`) blijven zonder enige migratie-actie geldig en tonen
correct `INDIVIDUAL` via de afgeleide waarde. Geen backfill-script
geschreven of nodig.

## 28. Indexen

Geen nieuwe index toegevoegd — `customerTypeOverride`/
`companyNameConfirmed` worden nergens gefilterd/gesorteerd op in de huidige
queries; als een toekomstige "toon alleen zakelijke klanten"-filter nodig
blijkt, is dat een aparte, expliciet gemotiveerde vervolgstap.

## 29–36. Tests

`tests/customer-identity.test.ts` (nieuw, 20 tests): volledige
waarheidstabel + alle edge cases uit §3/§4 hierboven.
`tests/customer-profile.test.ts` (uitgebreid): sync-guard (inclusief het
expliciete null-clearing-scenario), atomaire reset, onafhankelijkheid
override/companyName.
`tests/matching.test.ts` (uitgebreid): matching-regressie.
`tests/quotes-search.test.ts` (aangepast): twee bestaande tests
bijgewerkt naar de uitgebreide `select`-vorm (geen gedragswijziging,
alleen een extra geselecteerd veld).

## 37. Beveiligingsreview

`customerTypeOverride`/`companyName`-wijzigingen lopen uitsluitend via de
bestaande `PATCH /api/customers/[id]` achter `requireWriteAccess()` —
zelfde RBAC-poort als `crmStatus`/`accountManagerId` altijd al hadden.
Bevestigd in staging-E2E scenario C: een VIEWER-gebruiker krijgt 403 op
een poging tot `customerTypeOverride`-wijziging. Geen nieuwe user-input
gaat ongesaneerd naar Prisma — `companyName` wordt getrimd, lege string
genormaliseerd naar `null`, `customerTypeOverride` is een Zod-`enum`. Geen
Shopify-schrijfactie toegevoegd — `resetCompanyNameToShopify()` doet
uitsluitend een Shopify-*read*, gevolgd door een lokale write.

## 38. Kwaliteitspoorten

`npm run test`: 476/476 groen (was 451 vóór Phase 5A — 25 nieuwe tests).
`npm run typecheck`: schoon. `npm run lint`: schoon (één tijdelijke
`no-unused-vars`-warning tijdens het bouwen, opgelost door de
audit-cleanliness-fix uit §11 — zie geen resterende warnings). `npm run
build`: slaagt, Turbopack, alle 26 routes gegenereerd.

## 39. Lokale migratie

Toegepast op de lokale dev-database via `npx prisma migrate dev` — geen
staging/productie-migratie vanaf de lokale machine; staging kreeg de
migratie via de eigen `release_command` tijdens `fly deploy` (zie §40).

## 40. Staging-deploy

`fly deploy --config fly.toml` (app `stones4u-control-center-staging`,
versie 24). `release_command: npx prisma migrate deploy` liep vóór de
nieuwe machines live gingen — `✔ release_command ... completed
successfully`. Beide machines (`876921a0644278`, `d891e967b31798`)
bereikten "started" met een groene health check. DNS-verificatie gaf een
tijdelijke UDP-timeout-warning (bekend, cosmetisch, geen deploy-falen) —
`/api/health` bevestigt achteraf 200 OK.

## 41. Staging-E2E

11 scenario's (A–K) tegen de draaiende staging-app, via een tijdelijke
ADMIN- en VIEWER-testgebruiker (willekeurige e-mail/wachtwoord,
argon2-hash, opgeruimd in een `finally`-fase) en een bestaande, echte,
schrijf-veilige Shopify-klant ("Fons Verkoelen",
`gid://shopify/Customer/25413296554316` — Phase 1 doet sowieso nooit een
Shopify-schrijfactie, dus dit is zonder risico voor die klant; staging en
productie delen dezelfde Shopify-winkel maar hebben elk hun eigen,
volledig gescheiden Postgres-database, dus geen productie-CRM-data is
aangeraakt). 10/11 groen; scenario K (matching-regressie via een los
script) faalde op de in §22 toegelichte tooling-beperking, niet op
productiegedrag — al bewezen door de reguliere testsuite.

Gedekte scenario's: resolve()-gebaseerde profielcreatie op een echte GID;
Customer 360-default (INDIVIDUAL, `companyName=null`); RBAC-blokkade voor
VIEWER; handmatige bedrijfsnaam-correctie + confirmatie-vlag; type-override
wint over gevulde bedrijfsnaam; terug naar automatisch herderiveert
correct; expliciete lege bedrijfsnaam bij ORGANIZATION-override crasht
niet; atomaire reset-naar-Shopify; command-palette klant-weergave; een
gekoppelde taak toont de bedrijfsnaam in zoekresultaten.

## 42. Regressie

Volledige lokale Vitest-suite (476 tests, alle Phase 1–4C-modules
inbegrepen: customers, Customer 360, CustomerContacts, matching, e-mail,
calls, orders/drafts, quotes, opportunities, dashboard, tasks/notities/
afspraken/bestanden, timeline, command palette, RBAC) liep groen vóór de
staging-deploy. Op staging zelf: `/api/health` 200 OK, en scenario I/J
van de E2E oefenden de command-palette (`customers`/`tasks`-groepen) en
taakaanmaak/-koppeling uit zonder regressie.

## 43. Cleanup

Alle door de E2E aangemaakte rijen (2 testgebruikers, 1 CustomerProfile,
1 Task, bijbehorende Activity/AuditEvent-rijen) zijn verwijderd —
geverifieerd met een aparte controle-query (`leftover users: 0`,
`leftover profiles for Fons GID: 0`, `leftover E2E tasks: 0`). Beide
scratch-scripts (`phase5a-e2e.ts`, `phase5a-verify-cleanup.ts`) zijn van
de staging-container verwijderd en geverifieerd afwezig.

## 44. Documentatie

Dit bestand. Geen wijziging aan ADR-011 of de build spec nodig — de
implementatie week op geen enkel punt af van het vastgelegde ontwerp,
op de audit-cleanliness-fix in §11 na (een implementatiedetail, geen
architectuurwijziging).

## 45. Git-status

`git status --short`/`git diff --check` gecontroleerd: alleen de
verwachte bestanden gewijzigd/toegevoegd (zie de bestandslijst in de
sessie), geen scratch-scripts, geen secret-waarden. **Niet gecommit, niet
gepusht** — zoals expliciet gevraagd.

## Blockers

Geen. De enige afwijking van het oorspronkelijke plan is de
audit-cleanliness-fix in §11 (opgelost tijdens het bouwen) en de
scope van staging-E2E-scenario K (opgelost door te steunen op de al
groene Vitest-regressietest in plaats van het losse script — zelfde
patroon als eerder deze sessie gedocumenteerd voor `matching.service.ts`).

---

**PHASE 5A STAGING: GO**
