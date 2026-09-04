# Phase 6B — Mijn Klanten & Klanttoewijzing: staging build report

**Status**: gebouwd, getest (518/518 tests groen, typecheck/lint/build
groen), gedeployed naar `stones4u-control-center-staging` (laatste versie
27, geen nieuwe migratie — `release_command` bevestigde "Database schema
is up to date!"), gevalideerd met een staging-E2E (31/32 checks direct
groen op de eerste run; de 32e faalde uitsluitend door een testscript-
fout, niet door productiecode — zie §11) plus een gerichte tweede
staging-E2E specifiek voor de tijdens de final review gevonden
concurrency-fix (§0/§19, 5/5 groen). Niet gecommit, niet gepusht, geen
productie-actie.

**Final-review-update (2026-09-04)**: de final review vóór commit vond
één echte concurrency-bug in "Aan mij toewijzen" (blinde
last-write-wins-overschrijving, nooit expliciet besloten in doc 48) —
gefixt met een conditionele, atomaire database-operatie vóórdat er iets
gecommit werd. Zie §19 hieronder voor het volledige verhaal. Geen andere
codewijziging tijdens de final review.

Vervolg op `docs/platform-discovery/46-PHASE-6B-MY-CUSTOMERS-DISCOVERY.md`,
`47-PHASE-6B-MY-CUSTOMERS-ARCHITECTURE.md`, `48-PHASE-6B-BUILD-SPEC.md`.
Geen afwijking van deze documenten die een correctie vereist.

## 1. Final scopes

Drie scopes op de bestaande `CustomerProfile.accountManagerId`-relatie —
geen tweede model, geen aparte dataset:

- `mine`: `accountManagerId === actor.id` — identiek voor ADMIN/AGENT/
  VIEWER, geen bypass.
- `unassigned`: `accountManagerId IS NULL` — geen andere heuristiek.
- `all`: alle lokaal gematerialiseerde `CustomerProfile`-rijen — bewust
  géén live Shopify-klantenlijst (discovery §7, Optie A). De bestaande
  `CustomerSearch`-zoekbalk blijft ongewijzigd de enige weg naar een
  nog-niet-lokaal-bekende Shopify-klant.

## 2. Default view

`AGENT` → `mine`; `ADMIN`/`VIEWER` → `all` — server-side bepaald in
`src/app/(app)/customers/page.tsx` op basis van `getSessionUser().role`,
met een expliciete `?scope=`-query-param die altijd voorrang heeft.

## 3. Search + scope-semantiek

`listCustomerProfiles()` (`customer-profile.service.ts`) combineert de
scope-`where`-clausule en de zoekterm-`OR`-clausule in **dezelfde**
Prisma-query — er bestaat geen codepad waarin een zoekopdracht de scope
omzeilt. Bevestigd zowel unit-test (`tests/customer-list.test.ts`,
"search stays inside 'mine'/'unassigned' scope") als staging-E2E
(scenario's G/H/I): een zoekterm die matcht op een andermans klant
binnen `scope=mine` levert nul resultaten op.

## 4. Shopify live-search grens

Bevestigd ongewijzigd: een live Shopify-zoekresultaat zonder lokaal
profiel heeft geen `accountManagerId` en kan dus in geen van de drie
scopes verschijnen. Geen enkele code materialiseert automatisch een
`CustomerProfile` om een lijstfilter te laten werken — de bestaande
`resolve()`-flow (open een klant via zoeken) blijft de enige weg naar
materialisatie, ongewijzigd.

## 5. Paginering

Server-side `skip`/`take` (default `pageSize=25`), toegepast **na** de
scope+zoek-`where`-clausule, in dezelfde query als de `count()`. Bevestigd
met een gerichte test (`tests/customer-list.test.ts`,
"pagination is applied server-side"): pagina 1 en 2 bevatten nooit
dezelfde rij, `total` reflecteert het volledige, ongepagineerde
scope-aantal.

## 6. Assignment-semantiek — "Aan mij toewijzen"

De bestaande `updateCustomerCrmFields()` blijft volledig ongewijzigd —
Customer 360's eigen accountmanager-control gebruikt hem nog steeds
exact zoals vóór Phase 6B. "Aan mij toewijzen" krijgt een eigen, kleine,
dedicated functie: `assignCustomerToSelfIfUnassigned()`
(`customer-profile.service.ts`), aangestuurd via een nieuw
`assignToSelf: z.literal(true).optional()`-veld op de bestaande `PATCH
/api/customers/[id]`-route — geen nieuwe route. `accountManagerId` wordt
**altijd** serverzijdig herleid naar `actor.id` (uit
`requireWriteAccess()`); elke `accountManagerId` die de client in
hetzelfde verzoek meestuurt wordt genegeerd (getest met een bewuste
spoofing-poging, zowel unit als staging-E2E — het resultaat was correct
`actor.id`, nooit de gespoofde waarde).

**Concurrency-fix (final review vóór commit, 2026-09-04)**: de eerste
implementatie deed een blinde `update()` — een medewerker B die op
hetzelfde moment op dezelfde "Niet toegewezen"-rij klikte als medewerker
A zou A's toewijzing stil hebben overschreven (last-write-wins, nooit
expliciet toegestaan in doc 48). Gefixt vóórdat er iets gecommit werd:
`assignCustomerToSelfIfUnassigned()` doet nu een **conditionele**
`prisma.customerProfile.updateMany({ where: { id, accountManagerId: null
}, data: { accountManagerId: actor.id } })` — slaagt alleen als de klant
op het exacte moment van schrijven nog niet-toegewezen is. Bij een
conflict (`result.count === 0`) wordt niets geschreven — geen Activity,
geen AuditEvent — en de route retourneert HTTP 409 met een duidelijke
Nederlandse foutmelding; de client toont deze apart van de gewone
lijst-laadfout en ververst de lijst zodat de echte actuele status
zichtbaar wordt. Getest: een normale toewijzing, een geweigerde
toewijzing op een al-toegewezen klant (geen Activity/AuditEvent erbij),
en een gesimuleerde race (`Promise.all()` van twee gelijktijdige
toewijzingspogingen op dezelfde klant — precies één wint, nooit beide of
geen). Herbevestigd op staging met een gerichte tweede E2E-ronde na
redeploy (versie 27): sequentiële A-dan-B-poging levert 409 voor B op,
accountManagerId blijft A; een poging op een al-bij-aanmaak-toegewezen
klant levert eveneens 409 op.

## 7. Inactive accountmanager

Bevestigd exact zoals architectuurdoc §11 voorschrijft: een klant met een
inmiddels-inactieve accountmanager blijft zichtbaar in `all` met
`accountManager.active: false` in de response (UI toont "(inactief)"),
en verschijnt **nooit** in `unassigned` (de FK is nog steeds gezet, geen
automatische ontkoppeling). Beide expliciet getest, unit én staging-E2E
(scenario M).

## 8. RBAC

`GET /api/customers`: `requireUser()` — elke rol, inclusief VIEWER,
bevestigd in staging (scenario L: VIEWER las `scope=all` probleemloos).
`assignToSelf`: `requireWriteAccess()` via de bestaande route,
ongewijzigd — VIEWER kreeg 403 (scenario L). Geen enkele bestaande
leesrechten-verkleining: elke rol kan nog steeds elke klant lezen via
`scope=all`, exact zoals vóór Phase 6B al gold voor Customer 360/Shopify-
zoeken (discovery §6).

## 9. Query-strategie/performance

Geen N+1: elke lijst-aanroep is één `findMany` (met
`accountManager`-relatie-`select`, geen losse query) + één parallelle
`count()`. Geen externe aanroepen — 100% lokale `CustomerProfile`-data.
Geen nieuwe index toegevoegd (architectuurdoc §10) — bij het huidige
staging-/productievolume geen enkel prestatieprobleem waargenomen.

## 10. Schema/migratie

Geen wijziging. Bevestigd: `git diff -- prisma/schema.prisma` leeg, geen
nieuw bestand onder `prisma/migrations/`, staging's `release_command`
meldde expliciet "Database schema is up to date!" met het
migratie-aantal ongewijzigd op 7.

## 11. UI/empty states

Nieuwe `Tabs` (Mijn klanten/Niet toegewezen/Alle klanten, met counts) +
zoekveld + lijst + paginering onder de bestaande, ongewijzigde
`CustomerSearch`-zoekbalk op `/customers`. Lege staten per scope
(bevestigd in staging, scenario K voor de organisatie-weergave; de
overige lege-staat-teksten zijn in de Vitest-suite niet apart als
UI-string getest, maar de onderliggende data — 0 resultaten per scope —
is wel bewezen): "Nog geen klanten toegewezen" (mine), "Alle klanten
zijn toegewezen" (unassigned), "Nog geen klanten bekend" (all), plus een
aparte "Geen klanten gevonden voor '{term}'"-tekst specifiek voor een
zoekopdracht zonder resultaat — nooit dezelfde tekst als een echte lege
scope.

## 12. Tests + nieuwe baseline

`tests/customer-list.test.ts` (18 tests):
mine/unassigned/all-scoping (incl. het expliciete ADMIN-geen-bypass-
scenario), counts-consistentie (zie hieronder), search-binnen-scope (twee
scopes apart getest + companyName-matching), paginering, organisatie/
individu-identiteitsvelden, inactive-accountmanager-gedrag in zowel
`all` als `unassigned`, de algemene `updateCustomerCrmFields()`-
accountmanager-mutatie (Customer 360's bestaande pad, ongewijzigd) +
audit-before/after, en — na de concurrency-fix (§6) — vier gerichte
`assignCustomerToSelfIfUnassigned()`-tests: normale toewijzing, een
geweigerde toewijzing op een al-toegewezen klant (geen Activity/
AuditEvent), een gesimuleerde race via `Promise.all()` (precies één van
twee gelijktijdige pogingen wint), en opportunity-owner/task-assignee-
ontkoppeling.

**Bijvangst 1 tijdens het testen**: `tests/fixtures.ts`'s `cleanupUser()`
had nog geen bescherming tegen een `CustomerProfile.accountManagerId`
die naar de op te ruimen testgebruiker wijst — dezelfde bugklasse als de
Task/Appointment-fix uit de Phase 6A-staging-ronde. Toegevoegd: een
`customerProfile.updateMany({accountManagerId: null})` vóór de
`user.delete()`, zelfde defensieve stijl als de bestaande regels. Puur
test-infrastructuur, geen productiecode geraakt.

**Bijvangst 2, gevonden tijdens de final review**: de oorspronkelijke
"counts: match what listCustomerProfiles returns"-test vergeleek twee
apart-opgehaalde **globale** `unassigned`-tellingen (dat scope heeft
per definitie geen eigenaar, dus geen enkele test kan hem exclusief voor
zichzelf claimen) — inherent race-gevoelig zodra een andere, parallel
draaiende testfile op exact dat moment een klant toewijst/ontkoppelt.
Dit veroorzaakte een echte, reproduceerbare flake (6 vs. 7) tijdens de
final-review-testrun. Gefixt door de vergelijking te beperken tot
`mine` (uniek aan de eigen, vers aangemaakte testgebruiker in die test,
dus immuun voor interferentie) — `unassigned`-filtering zelf blijft
volledig gedekt door de bestaande, aparte scope-tests. Test-only fix,
geen productiecode geraakt.

**Nieuwe baseline: 518/518 tests groen** (was 500 na Phase 6A, +18
nieuw — 14 uit de oorspronkelijke bouwronde, +4 uit de
concurrency-fix). Herhaaldelijk bevestigd stabiel (twee opeenvolgende
volledige-suite-runs, beide 518/518). Eén onafhankelijke, reeds-
bestaande flaky test eerder waargenomen tijdens de oorspronkelijke
bouwronde (`tests/email-matching-identity.test.ts`, een literal-
e-mailadres-botsing met `tests/email-adapter.test.ts` — beide gebruiken
`shared@voorbeeld.nl`), losstaand van Phase 6B: slaagde in isolatie en
bij herhaalde volledige-suite-runs. Niet gerepareerd — buiten de scope
van deze fase, een reeds langer bestaand test-isolatie-patroon in dit
project (zie eerdere sessies voor dezelfde bugklasse bij andere
literals).

## 13. Typecheck/lint/build

Alle drie schoon. Build: geen schemawijziging, één nieuwe route
(`/api/customers`) zichtbaar in de routetabel, `/customers`-bundle
gegroeid van 2.59 kB naar 4.96 kB (verwacht — nieuw clientcomponent).

## 14. Staging deploy/versie

Eerste deploy: `fly deploy --config fly.toml -a stones4u-control-center-staging`
— versie 25 → 26, beide machines gezond. Tweede deploy, na de
concurrency-fix tijdens de final review: versie 26 → **27**, beide
machines gezond. Geen migratie toegepast bij geen van beide deploys
(bevestigd — `release_command` meldde bij de tweede deploy opnieuw
"Database schema is up to date!", migratie-aantal ongewijzigd op 7).

## 15. Staging E2E

32 scenario's (A–P), 31 direct groen. Scenario P (Customer 360-
accountmanager-controle-regressie) faalde initieel omdat het
testscript daarvoor een **synthetisch, ongeldig-gevormd** Shopify-GID
gebruikte (`gid://shopify/Customer/e2e6b-{uuid}`) — Shopify's GraphQL-API
gooit hierop een fout, die de bestaande, al-bewezen
`try/catch`-foutafhandeling in `customers/[id]/page.tsx` (regels 50-62)
correct opving met een 200-status "Shopify is niet bereikbaar"-pagina —
precies het al-ontworpen, veilige gedrag, geen regressie. Herbevestigd
met een gerichte hercontrole die een echte, veilige, alleen-lezen
Shopify-klant gebruikte (Fons Verkoelen, `gid://shopify/Customer/25413296554316`
— Phase 1 doet nooit een Shopify-schrijfactie, dus zonder risico):
Customer 360 laadde correct (200), toonde "Accountmanager"-context, geen
foutstaat. De tijdelijk gematerialiseerde profiel-rij is nadien
opgeruimd; de echte Shopify-klant is nooit gewijzigd.

Overige 31 scenario's (A–O): Mine/Unassigned/All-scoping voor
AGENT/ADMIN, ADMIN-geen-bypass, search-binnen-scope (drie scopes),
paginering-metadata, organisatie-weergave, VIEWER-leesrechten +
mutatie-blokkade, inactive-accountmanager-gedrag (beide kanten),
`assignToSelf` inclusief spoofing-poging + audit-verificatie, command-
palette ongewijzigd — allemaal groen op de eerste run.

**Tweede, gerichte E2E-ronde (na de concurrency-fix, tegen versie 27)**:
5/5 groen — sequentieel A-toewijzen-dan-B-toewijzen-poging op dezelfde,
aanvankelijk niet-toegewezen klant (A slaagt 200, B krijgt 409,
`accountManagerId` blijft A); een toewijzingspoging op een klant die al
bij aanmaak aan een andere accountmanager was toegewezen (409,
ongewijzigd). Bevestigt de fix werkt end-to-end op de daadwerkelijk
draaiende staging-app, niet uitsluitend in de Vitest-suite.

## 16. Regressie

Volledige lokale Vitest-suite (518 tests na de concurrency-fix, alle
Phase 1–6A-modules inbegrepen) groen vóór beide staging-deploys. Op
staging zelf: command-palette (`/api/search`) 200 en ongewijzigd
(scenario O), Customer 360 + bestaande accountmanager-control 200 en
functioneel (scenario P, herbevestigd), `/api/health` 200 op zowel
versie 26 als versie 27.

## 17. Cleanup

Eerste ronde: alle door de E2E aangemaakte rijen (5 testgebruikers, 6
synthetische CustomerProfile-rijen, plus de één tijdelijk
gematerialiseerde profiel uit de P-hercontrole) zijn verwijderd —
geverifieerd met een aparte controlequery (`leftover users: 0`,
`leftover customer profiles: 0`). Tweede ronde (concurrency-E2E, na
redeploy): 2 testgebruikers + 2 synthetische CustomerProfile-rijen,
zelfde verificatie (`leftover users: 0`, `leftover customer profiles:
0`). Alle scratch-scripts uit beide rondes (`phase6b-e2e.ts`,
`phase6b-p-recheck.ts`, `phase6b-verify-cleanup.ts`,
`phase6b-concurrency-e2e.ts`, `phase6b-final-verify.ts`) zijn van de
staging-container verwijderd en geverifieerd afwezig. Geen bestaande
staging-data aangeraakt.

## 18. Documentatie

Dit bestand, plus een precisering in doc 48 §1.5/§9/§11 over de
concurrency-fix (geen architectuurwijziging — een nooit eerder expliciet
besloten implementatiedetail, nu vastgelegd). Verder geen wijziging aan
doc 46/47/48 nodig — de implementatie volgt ze exact; de enige eerdere
"afwijking" (scenario P's testscript-fout) is
een test-methodologie-correctie, geen architectuurwijziging.

## Blockers

Geen.

---

**PHASE 6B STAGING: GO**
