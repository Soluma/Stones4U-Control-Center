# Phase 6C — Customer 360 Quick Actions & Interaction Follow-up: staging build report

**Status**: gebouwd, getest (538/538 tests groen, typecheck/lint/build
groen), gedeployed naar `stones4u-control-center-staging` (huidige versie
**v30**, geen nieuwe migratie op geen van de deploys — `release_command`
meldde steeds "No pending migrations to apply."). Staging-E2E: **eerste
run had een echte HTTP 500 op Customer 360** (v28) — root-cause gevonden
en gefixt vóór commit, herbevestigd met een volledige herhaling van de
E2E op v29: **12/12 groen**. Tijdens de final-review-ronde vóór commit is
daarna nog een kleine, defensieve fix aan `copyToClipboard()` toegevoegd
(§15) — v29 → **v30**, opnieuw volledig herbevestigd: **12/12 groen**.
Niet gecommit, niet gepusht, geen productie-actie.

Vervolg op `docs/platform-discovery/49-PHASE-6C-QUICK-ACTIONS-DISCOVERY.md`,
`50-PHASE-6C-QUICK-ACTIONS-ARCHITECTURE.md`,
`51-PHASE-6C-BUILD-SPEC.md`. Geen afwijking van deze documenten die een
correctie vereist — de bug hieronder zat in de implementatie, niet in de
architectuur/build spec (die specificeerde geen component-boundary, dat is
een uitvoeringsdetail).

## 0. De v28-failure — eerlijk gerapporteerd

De eerste staging-E2E-run (tegen v28) gaf:

```
[FAIL] Scenario A: page loads (200) — status=500
[FAIL] Scenario A: header contains a tel: link
[FAIL] Scenario A: header contains a mailto: link
[FAIL] Scenario L: VIEWER can load the page (200) — status=500
[FAIL] Scenario L: VIEWER still sees tel:/mailto: (read-only actions)
```

Alle taak-aanmaak-scenario's (H/I/J/M/L/regressie) waren al wel groen — de
bug zat uitsluitend in het laden van de Customer 360-pagina zelf.

### Root cause (productbug, bewezen)

`CustomerHeader.tsx` is een Server Component (geen `"use client"`). De
eerste implementatie voegde daar rechtstreeks een `<button
onClick={() => copyToClipboard(...)}>` toe voor de e-mail-/telefoon-
kopieerknoppen. React Server Components kunnen geen functie als prop
serialiseren — dat crasht de render met exact de fout uit de staging-logs
(`fly logs`, 08:48:43 UTC):

```
⨯ Error: Event handlers cannot be passed to Client Component props.
 {type: "button", onClick: function onClick, className: ..., aria-label: ..., title: ..., children: ...}
    at stringify (<anonymous>)
  digest: '3453523987'
```

`next build` ving dit niet af omdat `/customers/[id]` een dynamische route
is (geen `generateStaticParams`) — de pagina wordt nooit tijdens de build
daadwerkelijk gerenderd met echte data, alleen bij een echt HTTP-verzoek.
Vandaar dat dit alleen op de staging-E2E naar boven kwam, niet bij
typecheck/lint/build.

`RecentCallsBlock.tsx`/`RecentEmailsBlock.tsx` (alleen `<a href>`, geen
handler) en `ActivityTimelineView.tsx` (heeft `"use client"`) hadden dit
probleem niet — uitsluitend de twee kopieerknoppen in `CustomerHeader.tsx`.

**Productbug, niet fixturebug**: de E2E-fixture (een geldige
`CustomerProfile` met een echte, alleen-lezen Shopify-klant-GID) is exact
hoe de applicatie een klant al zou behandelen — er is geen ongeldige
applicatiestate aangetoond. Bevestigd via de stacktrace zelf (een RSC-
serialisatiefout in productiecode, geen data-validatiefout).

## 1. De fix

`src/components/ui/CopyButton.tsx` (nieuw, `"use client"`) — de
interactieve helft van de gedeelde copy-actie (build spec §1.7 was al van
plan een gedeelde helper te maken; dit maakt "gedeeld" ook daadwerkelijk
Server-Component-veilig, niet alleen een losse functie). `CustomerHeader.tsx`
gebruikt nu `<CopyButton value={...} label={...} />` in plaats van een
rauwe `<button onClick={...}>` — zelf blijft het een Server Component,
ongewijzigd voor de rest. `src/lib/clipboard.ts`'s pure
`copyToClipboard()`-functie blijft bestaan en wordt intern door
`CopyButton` gebruikt.

Als consistentiefix (niet strikt nodig om de bug op te lossen, maar
voorkomt twee parallelle implementaties van hetzelfde patroon):
`ContactsSection.tsx` (al `"use client"`, dus nooit zelf gebroken) is ook
overgezet op `<CopyButton>` — gedrag ongewijzigd, nu één enkele
implementatie in de hele Customer 360.

## 2. Regressietest tegen exact deze bugklasse

`tests/server-client-boundary.test.ts` — een statische scan, geschaald tot
`src/app/(app)/customers/[id]/`, die faalt zodra een `.tsx`-bestand zonder
`"use client"` een `onXxx={...}`-prop bevat. Bewust **niet**
codebase-breed: `src/components/ui/Tabs.tsx` heeft legitiem een
`onClick`-pad (`onSelect`-modus) dat alleen ooit vanuit een Client-
Component-boom wordt gebruikt (`TasksList.tsx`/`CustomerListPanel.tsx`,
beide `"use client"`) — een codebase-brede versie van deze scan gaf daar
een fout-positief. De scope blijft dus precies de map waar het incident
zich voordeed.

## 3. Local quality gates (na de fix)

`npm run test`: **538/538 groen** (was 518 vóór Phase 6C, +20: 8
href-helper-tests, 4 timeline-call-tests, 5 timeline-email-tests, 2
tasks-service-tests al bestaand/ongewijzigd, 1 server/client-boundary-
regressietest — zie §7 hieronder voor het volledige overzicht).
`npm run typecheck`: schoon. `npm run lint`: schoon. `npm run build`:
schoon, geen schemawijziging zichtbaar in de routetabel.

## 4. Staging redeploy

Tweede deploy (met de fix): `fly deploy --config fly.toml -a
stones4u-control-center-staging` — versie v28 → **v29**, beide machines
gezond. `release_command` (`npx prisma migrate deploy`) meldde opnieuw
"No pending migrations to apply." — geen schema-impact van de fix.

## 5. Tweede staging-E2E — volledige herhaling tegen v29

Alle 12 scenario's, inclusief de eerder gefaalde:

```
[PASS] Scenario A: page loads (200) — status=200
[PASS] Scenario A: header contains a tel: link
[PASS] Scenario A: header contains a mailto: link
[PASS] Scenario L: VIEWER can load the page (200) — status=200
[PASS] Scenario L: VIEWER still sees tel:/mailto: (read-only actions)
[PASS] Scenario H/I/J: task created with same-customer contact prefill (201)
[PASS] Scenario J: created task carries the prefilled customerContactId
[PASS] Scenario H: created task title is the fixed string, never message content
[PASS] Scenario M: cross-customer customerContactId rejected (not 201) — status=400
[PASS] Scenario L: VIEWER blocked from creating a task (403)
[PASS] Regression: plain task creation (no contact prefill) still works (201)
[PASS] Regression: no auto-assigned assignee/due-date beyond what was sent
Cleanup done.
```

Geen scenario is geschrapt om een groene run te krijgen — dezelfde 12
checks als de eerste (mislukte) run.

## 6. Wat elk scenario dekt

- **A**: Customer 360-header rendert een echte `tel:`/`mailto:`-link voor
  een klant met een echt Shopify-telefoonnummer + e-mailadres (alleen-
  lezen Shopify-klant gebruikt, geen schrijfactie — Phase 1 blijft
  Shopify-read-only).
- **L**: VIEWER kan de pagina laden en ziet dezelfde `tel:`/`mailto:`-
  acties (lees-/navigatie-acties, geen mutatie — toegestaan voor elke
  rol) maar krijgt een 403 op taak-aanmaak (bestaande
  `requireWriteAccess()`-gate, ongewijzigd).
- **H/I/J**: een taak aangemaakt via de quick-action-route met een
  same-customer `customerContactId`-prefill wordt geaccepteerd (201) en
  het aangemaakte record draagt exact die `customerContactId` — en de
  vaste, veilige titel ("Terugbellen"), nooit berichtinhoud.
- **M**: een cross-customer `customerContactId` (hoort bij een andere
  klant) wordt server-side geweigerd (400) — de bestaande
  `assertContactBelongsToCustomer()`-guard in `createTask()`, nu ook echt
  bereikbaar via de route (zie §8).
- **Regressie**: de gewone "Nieuwe taak"-flow zonder prefill werkt nog
  exact zoals vóór de `CreateTaskDialog`-extractie — geen automatisch
  toegewezen medewerker, geen automatische deadline.

## 7. Tests + nieuwe baseline

- `tests/phone.test.ts` — `buildTelHref()`: Nederlands-opgemaakt nummer,
  een echt internationaal nummer (bewijst geen Nederlandse
  landcode-corruptie), null/leeg/ongeldig, injectie-achtige garbage-input.
- `tests/email.test.ts` — `buildMailtoHref()`: geldig adres, null/leeg/
  ongeldig, CRLF/header-injectie geweigerd, nooit een subject/body-query-
  string.
- `tests/timeline-call.test.ts` (nieuw) — `callToTimelineItem()`
  (geëxtraheerd uit `getCustomerTimeline()` voor testbaarheid, zelfde
  patroon als het al-bestaande `emailToTimelineItem()`): stabiel
  geprefixt id, `phoneNumber`/`customerContactId` correct gevuld, nooit
  geraden bij afwezige/ambigue match.
- `tests/timeline-email.test.ts` (uitgebreid) — `participantEmail`/
  `customerContactId` op `emailToTimelineItem()`: exacte match, geen
  match, ambigue match (nooit geraden), en een expliciete test dat deze
  velden nooit onderwerp/berichtinhoud lekken.
- `tests/server-client-boundary.test.ts` (nieuw) — de regressietest tegen
  de v28-bugklasse, zie §2.
- `tests/tasks.test.ts` — al-bestaande, ongewijzigde dekking van de
  `customerContactId`-invariant in `createTask()` (same-customer/cross-
  customer/opportunity-afgeleid) — nu ook daadwerkelijk bereikbaar vanaf
  `/api/customers/[id]/tasks` (§8).

**Nieuwe baseline: 538/538 tests groen** (was 518 vóór Phase 6C: +8
href-helpers, +6 timeline (4 call, +2 nieuw email — 3 waren al impliciet
gedekt door bestaande summary/title-tests), +1 server/client-boundary).
Geen nieuwe flaky tests waargenomen over meerdere volledige-suite-runs.

## 8. API-wijziging (geen nieuwe route)

`POST /api/customers/[id]/tasks` accepteerde `customerContactId` voorheen
niet (zod stripte het veld stil) — `createTask()` had de
`assertContactBelongsToCustomer()`-guard al wel, maar was via deze route
nooit bereikbaar. Toegevoegd aan het bestaande zod-schema
(`customerContactId: z.string().nullable().optional()`, exact zoals de
zuster-route `/api/opportunities/[id]/tasks` al deed) en doorgegeven aan
`createTask()`. Geen nieuwe route, geen nieuwe guard-logica — alleen een
al-bestaande, al-geteste guard nu daadwerkelijk aangesloten.

## 9. RBAC/IDOR

Ongewijzigd via bestaande mechanismen: `requireWriteAccess()` op
taak-aanmaak (VIEWER → 403, scenario L), `assertContactBelongsToCustomer()`
op elke `customerContactId` (cross-customer → afgewezen, scenario M).
`tel:`/`mailto:`/kopiëren zichtbaar voor elke rol incl. VIEWER (scenario
L) — lees-/navigatie-acties, geen mutatie.

## 10. Privacy/audit

Geen nieuwe `AuditAction`. Taak-aanmaak via een quick action genereert
dezelfde `task.created`-audit + `TASK_CREATED`-Activity als de gewone
knop. `tel:`/`mailto:`/kopiëren-kliks genereren geen Activity/AuditEvent
(bevestigd, bewust). `Task.title` is altijd de vaste string
("Terugbellen"/"E-mail opvolgen"), nooit `message.bodyPreview`/
`call.summary` — bevestigd zowel in de unit-test
(`timeline-email.test.ts`) als in de staging-E2E (scenario H).

## 11. Performance

Geen nieuwe externe aanroep — `TimelineItem`'s nieuwe velden
(`phoneNumber`/`participantEmail`/`customerContactId`) zijn puur
in-memory gevuld vanuit al-opgehaalde data (`callToTimelineItem()`/
`emailToTimelineItem()`), nooit een nieuwe query/fetch. Bevestigd via
codereview (geen nieuwe `fetch()`/adapter-aanroep toegevoegd) — expliciete
request-telling was door de omgeving (telephony/exact staan uit in Phase
1, e-mail-adapter levert hier geen nieuwe items op voor de synthetische
testklant) niet aanvullend zinvol bovenop de codereview.

## 12. Schema/migratie

Geen wijziging, bevestigd op beide deploys (`git diff --
prisma/schema.prisma` leeg, `git status --short prisma/migrations` leeg,
`release_command` meldde bij beide deploys "No pending migrations to
apply.").

## 13. Cleanup

Beide E2E-rondes (v28-poging + v29-herhaling): alle synthetische rijen
(3 testgebruikers, 2 `CustomerProfile`, 2 `CustomerContact`, taken)
verwijderd door het self-cleaning script zelf, plus geverifieerd met een
losse controlequery (`leftover users: 0`, `leftover profiles: 0`) na de
laatste run. De twee scratch-scripts
(`scripts/phase6c-e2e.ts`, `scripts/phase6c-cleanup.ts`) zijn van de
staging-container verwijderd en geverifieerd afwezig (`ls
/app/scripts/` toont alleen het al-bestaande `bootstrap-admin.ts`). Geen
bestaande staging-data aangeraakt. Geen echte Shopify-klant gewijzigd
(alleen-lezen gebruikt voor scenario A).

## 14. Documentatie

Dit bestand (nieuw). Geen wijziging aan doc 49/50/51 nodig — de
architectuur/build spec beschreven geen component-implementatiedetail op
het niveau van Server/Client-boundaries; de fix is een uitvoeringscorrectie,
geen architectuurwijziging.

## 15. Final review — v30

Tijdens de final-review-ronde vóór commit (zelfde sessie) is een kleine,
niet-gedragswijzigende defensieve fix toegevoegd aan
`copyToClipboard()` (`src/lib/clipboard.ts`): een `try/catch` +
`navigator.clipboard?.writeText(value)?.catch(() => undefined)` zodat een
ontbrekende/geweigerde clipboard-API (oudere browser, niet-secure
context, permission-denial) nooit meer een onbehandelde exception of
promise-rejection in de klikhandler kan veroorzaken — puur defensief, het
gelukkige pad is ongewijzigd. Aanleiding: de kopieerknop wordt door Phase
6C nu op drie plekken gebruikt in plaats van één (header, Recent-blokken
via `CopyButton`, tijdlijn), dus een groter blast-radius voor eenzelfde,
al langer bestaand randgeval.

Geen dedicated unit-test toegevoegd voor deze guard — `clipboard.ts` is
een browser-only API-wrapper, de Vitest-suite draait in een Node-
omgeving zonder DOM (`environment: "node"`, `vitest.config.ts`), en dit
project heeft nergens component-/browser-tests met een gemockte
`navigator`. Consistent met hoe de oorspronkelijke, identieke
(ongeguardeerde) versie in `ContactsSection.tsx` sinds Phase 4C ook nooit
apart getest is.

Na deze wijziging opnieuw volledige quality gates gedraaid (538/538
tests, typecheck, lint, build — alle groen) en opnieuw gedeployed naar
staging: v29 → **v30**, geen pending migration, beide machines gezond.
Volledige E2E-set (12/12) nogmaals herhaald tegen v30 — allemaal groen,
inclusief Scenario A/L (de oorspronkelijke v28-failure). Scratch-script
opnieuw verwijderd en afwezigheid bevestigd.

## Blockers

Geen — de v28-failure is gevonden, root-cause-bewezen, gefixt, en
volledig herbevestigd (tweemaal — v29 en na de v30-verfijning) vóór dit
rapport.

---

**PHASE 6C STAGING: GO**
