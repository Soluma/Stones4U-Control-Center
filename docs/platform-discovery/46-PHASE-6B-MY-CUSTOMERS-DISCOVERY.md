# 46 — Phase 6B Discovery: Mijn Klanten & Klanttoewijzing

**Status**: Discovery, geen implementatie. Vervolg op Phase 6A
(productie-commit `299e3911ce544124c81199bf72f459fb08c9b9b5`, versie 16).
Gebaseerd op verse codebase-inspectie op HEAD.

## 1. Huidige customer-list architectuur — kernbevinding

**Er bestaat vandaag nergens een lokale, doorbladerbare klantenlijst.**
`/customers` (`src/app/(app)/customers/page.tsx`) rendert uitsluitend
`<CustomerSearch />` — een client-component die pas vanaf 2 tekens een
`GET /api/customers/search?q=...`-aanroep doet, die op zijn beurt
uitsluitend `searchCustomers()` (`customer-profile.service.ts`) aanroept:
een **live Shopify-zoekopdracht**, aangevuld met een lookup van bestaande
lokale profielen op basis van de gevonden Shopify-GID's. Geen paginering,
geen filter, geen standaardweergave zonder zoekterm — een leeg zoekveld
toont "Zoek een klant" en verder niets.

Bevestigd via een repo-brede grep: **de enige `prisma.customerProfile.findMany()`-
aanroepen in de hele codebase** zijn (a) `searchCustomers()`'s
GID-lookup (om te bepalen welke Shopify-zoekresultaten al een lokaal
profiel hebben) en (b) `matching.service.ts`'s telefoon-/e-mail-lookups
voor identiteitsmatching — geen van beide is een browsbare lijst. Er is
dus **geen enkele bestaande query, route of pagina die alle (of een subset
van) lokale `CustomerProfile`-rijen oplijst.** Phase 6B zou dit als eerste
in deze applicatie introduceren.

Command palette (`/api/search`'s `customers`-groep): identiek patroon —
live Shopify-zoekopdracht via `searchCustomers()`, geen scope, geen
lokale lijst.

## 2. Accountmanager-datamodel

`CustomerProfile.accountManagerId String?` (nullable) →
`accountManager User? @relation("AccountManager", ...)`. **Geen index op
`accountManagerId`** — alleen `phoneNormalized`, `email`, `crmStatus` zijn
geïndexeerd op `CustomerProfile`. `User.active Boolean @default(true)`,
drie rollen (`Role`: `ADMIN`/`AGENT`/`VIEWER`).

**Belangrijke asymmetrie ontdekt**: `Opportunity.ownerUserId` wordt bij
aanmaak expliciet gevalideerd via `assertUserExistsAndActive()`
(`opportunity.service.ts`, een pre-productie-reviewbevinding uit Phase
4A — "een opportunity mag nooit stil aan een inactieve gebruiker worden
toegewezen"). **`CustomerProfile.accountManagerId` heeft géén
equivalente validatie** — noch in de Zod-schema van `PATCH
/api/customers/[id]` (`z.string().nullable().optional()`, geen
existence/active-check), noch in `updateCustomerCrmFields()` zelf. De
enige bestaande bescherming is **UI-only**: de dropdown in
`AccountManagerControl.tsx` wordt gevuld via `prisma.user.findMany({where:
{active: true}}, ...)` (rechtstreeks in
`src/app/(app)/customers/[id]/page.tsx`, hetzelfde patroon als het
aparte `/api/users/assignable`-endpoint) — een gebruiker kan dus alleen
via de UI geen inactieve accountmanager kiezen, maar de
service-/API-laag zou een inactieve (of zelfs niet-bestaande, tot een
FK-fout) gebruikers-ID niet zelf weigeren.

## 3. Bestaande assignment-mutatie — al voldoende

`accountManagerId` wordt al gewijzigd via de bestaande
`updateCustomerCrmFields()` (aangeroepen door `PATCH
/api/customers/[id]`), samen met `crmStatus`/`customerTypeOverride`/
`companyName`. Al RBAC-gated via `requireWriteAccess()` (ADMIN/AGENT,
VIEWER krijgt 403), al ge-audit via de generieke
`CUSTOMER_PROFILE_UPDATED`-Activity + `customer_profile.updated`-AuditEvent
met before/after-diff (`diffFields()`). **Geen tweede assignment-route
nodig** — Phase 6B kan deze functie ongewijzigd hergebruiken, inclusief
voor een eventuele "Aan mij toewijzen"-quickaction (zie §17).

## 4. "Mijn klanten"-semantiek

Exact zoals de opdracht voorschrijft:
`CustomerProfile.accountManagerId === actor.id`, identiek voor
ADMIN/AGENT/VIEWER — geen ADMIN-uitzondering. Dit is consistent met de
zojuist in Phase 6A vastgelegde precedent (Mijn Werk: nooit een
team-wide bypass, ook niet voor ADMIN).

## 5. "Niet toegewezen"-semantiek

`accountManagerId IS NULL` — geen andere heuristiek. Bevestigd: geen
enkele code duidt `creator`/`opportunity owner`/`Shopify owner`/"laatst
geopend" ooit aan als vervanging voor een ontbrekende accountmanager.

## 6. "Alle klanten" — RBAC-onderzoek

**Kernbevinding**: vandaag kan **elke geauthenticeerde rol, inclusief
VIEWER**, al elke bestaande klant lezen — `GET /api/customers/[id]`
(Customer 360) is uitsluitend `requireUser()`-gated (geen
eigendoms-/scope-check), en de live Shopify-zoekopdracht is dat ook.
**Er bestaat vandaag geen enkele row-level leesrestrictie op
klantdata.** Phase 6B mag dit niet stil verkleinen (conform de
opdracht) — "Alle klanten" blijft dus voor elke rol leesbaar, inclusief
VIEWER, exact zoals vandaag al het geval is voor elke individuele klant
apart.

## 7. Kernarchitectuurbeslissing: wat betekent "Alle klanten"?

Omdat er geen bestaande lokale lijst bestaat, moet expliciet gekozen
worden wat "Alle klanten" ophaalt. Twee opties, tegen elkaar afgewogen:

**Optie A — alle lokaal bekende `CustomerProfile`-rijen** (aanbevolen).
Klein, bounded, geen externe aanroep, past bij het bestaande lazy-
creation-model (een profiel ontstaat pas zodra iemand een Shopify-klant
opent). "Alle klanten" betekent dan: "elke klant waar deze CRM al een
dossier voor heeft" — groeit vanzelf naarmate medewerkers klanten openen
via de bestaande zoekfunctie. Eerlijk en consistent, geen nieuwe
integratie.

**Optie B — een live, gepagineerde Shopify-klantenlijst**, samengevoegd
met lokale `accountManagerId`-data per pagina. Zou "Alle klanten"
betekenisvoller maken (echt alle Shopify-klanten, niet alleen de lokaal
geopende), maar vereist een **geheel nieuwe** live-Shopify-browse-
capaciteit die vandaag nergens bestaat (Shopify wordt nu uitsluitend op
zoekterm bevraagd, nooit ongefilterd gepagineerd) — een aanzienlijk
grotere wijziging dan een dashboarduitbreiding.

**Aanbeveling: Optie A.** Consistent met de herhaalde Phase 6-discipline
("klein, bounded, geen nieuwe externe integratie"). De bestaande live
Shopify-zoekbalk blijft **ongewijzigd** bestaan als het middel om een
compleet onbekende klant te vinden/openen — de nieuwe Mijn/Niet
toegewezen/Alle-tabs zijn een aanvullende, lokaal-gescoopte
browsefunctie, geen vervanging. Zie architectuurdoc §3 voor de volledige
uitwerking.

## 8. UI-patroon

Eén `/customers`-pagina, uitgebreid (niet vervangen): de bestaande
zoekbalk blijft bovenaan staan, met een nieuwe tab/filterset eronder —
`Mijn klanten` / `Niet toegewezen` / `Alle klanten`, via een
querystring (`?scope=mine|unassigned|all`), zelfde `Tabs`-UI-conventie
als al gebruikt op Customer 360 en de opportunity-detailpagina. Geen
drie aparte routes.

## 9. Default view — aanbeveling met onderbouwing

Bestaande precedent: `/opportunities` gebruikt al "Mijn
verkoopkansen"-als-standaard voor AGENT/USER en "alle" voor ADMIN
(architectuurdoc Phase 4B §14/§15, bevestigd in `page.tsx`'s
`getSalesDashboardMetrics(user.role === "ADMIN" ? {} : {ownerUserId:
user.id})`). **Aanbeveling**: dezelfde conventie — AGENT/USER
standaard op `Mijn klanten`, **ADMIN én VIEWER** standaard op `Alle
klanten`. VIEWER wordt bewust bij ADMIN ingedeeld voor de
*standaardweergave* (niet voor de semantiek van "Mijn klanten" zelf,
die voor VIEWER ongewijzigd `accountManagerId === actor.id` blijft) —
een VIEWER-rol is in de praktijk zelden zelf accountmanager, dus
"Mijn klanten" zou voor die rol meestal een verwarrende lege
standaardweergave zijn.

## 10. Counts

Drie kleine, aparte `prisma.customerProfile.count()`-aanroepen (zelfde
`where`-clausule als de bijbehorende lijst-query) — verwaarloosbare
kosten bij elk realistisch Stones4U-volume, en directe dagelijkse
waarde ("Niet toegewezen (4)" is een onmiddellijk, actionable signaal).
Aanbevolen: wél tonen.

## 11. Search + filter combinatie

Zoeken **binnen** een scope vereist een **nieuwe, lokale** tekstzoek-
functie (`CustomerProfile.displayName`/`companyName` `contains`,
gecombineerd met de scope-`where`-clausule in dezelfde query) — dit is
nadrukkelijk **niet** dezelfde functie als de bestaande live
Shopify-zoekopdracht. Geen index aanwezig op `displayName`/`companyName`
(zie §30) — bij het huidige/verwachte volume geen probleem, wel een
aandachtspunt.

## 12. Shopify-zoekgrens

Live Shopify-zoekresultaten zonder lokaal profiel hebben structureel
geen `accountManagerId` — ze zijn geen `CustomerProfile`-rij en kunnen
dus per definitie in **geen van de drie tabs** verschijnen (niet Mijn,
niet Niet-toegewezen, niet Alle). Dit is geen aparte beslissing die
genomen hoeft te worden — het volgt automatisch uit Optie A (§7): de
tabs zijn uitsluitend lokaal. De bestaande zoekbalk blijft het enige pad
naar een nog-niet-lokaal-bekende Shopify-klant, ongewijzigd. Opent een
medewerker zo'n klant (bestaande `resolve`-flow), dan materialiseert
het lokale profiel zoals nu al gebeurt — en verschijnt het vanaf dat
moment vanzelf in "Niet toegewezen"/"Alle klanten".

## 13. Paginering

Server-side, `take`/`skip` toegepast **na** de scope-`where`-clausule +
zoekterm, in dezelfde Prisma-query — geen fetch-all-then-slice. Matcht
het bestaande patroon van `listOpportunities()` (`take: 200`) en
`searchCustomerContacts()` (`take: limit`).

## 14. Sortering

Geen bestaande directe precedent voor een klantenlijst specifiek. Twee
redelijke opties: alfabetisch op het ruwe `displayName`-veld (eenvoudig,
maar voor een ORGANIZATION-klant sorteert dit op de accounthoudernaam,
niet de bedrijfsnaam — `customerDisplayName()` is een berekende waarde,
geen DB-kolom, dus "echt" alfabetisch-op-weergavenaam sorteren is niet
direct met één `orderBy` te doen) — of `updatedAt desc` (recent actieve
klanten eerst, geen berekende-waarde-probleem, directe dagelijkse
waarde: "waar heb ik recent aan gewerkt"). **Aanbeveling**: `updatedAt
desc` als standaard — geen sorting-redesign, gewoon de eenvoudigste
optie met duidelijke waarde.

## 15. Customer display

`customerDisplayName()`/`customerSecondaryName()` (Phase 5A) hergebruikt
ongewijzigd — `customerTypeOverride` moet in de `select` staan, zoals
overal elders al gebeurt.

## 16. Accountmanager-presentatie

Toon op "Niet toegewezen" (impliciet altijd "Niet toegewezen", geen
extra tekst nodig) en "Alle klanten" (compact "Accountmanager: {naam}").
Niet nodig op "Mijn klanten" (redundant — de scope zegt het al).

## 17. Assignment vanuit de lijst — aanbeveling

Geen inline dropdown per rij (matcht de eigen voorkeur uit de opdracht —
extra mutatie-UI, grotere lijstcomplexiteit, Customer 360 heeft de
control al). Wél aanbevolen: een kleine **"Aan mij toewijzen"**-
quickaction, uitsluitend zichtbaar op "Niet toegewezen"-rijen voor
ADMIN/AGENT (niet VIEWER) — lost precies het "te weinig actionable"-
risico op zonder een bulk-/inline-edit-framework te bouwen. Zie §19.

## 18. Bulk assignment

Geen concrete, aantoonbare noodzaak gevonden in deze discovery — bewust
buiten scope, conform de opdracht.

## 19. "Aan mij toewijzen" — aanbevolen, klein genoeg

Hergebruikt `updateCustomerCrmFields()` ongewijzigd, met
`accountManagerId` altijd afgeleid van de server-side actor (`actor.id`
uit de sessie) — nooit een client-aangeleverde `userId`. Eén knop, één
bestaande mutatie-aanroep, geen nieuwe route, geen nieuwe validatie-
logica nodig (de actor is per definitie al een actieve, ingelogde
AGENT/ADMIN).

## 20. Inactieve accountmanagers

FK blijft bestaan na deactivering — geen automatische ontkoppeling of
her-toewijzing (bevestigd: geen enkele code doet dit vandaag, en
Phase 6B introduceert het niet). Aanbevolen UX: gewone naam +
subtiele "(inactief)"-indicator, nooit stil tonen als "Niet
toegewezen" (dat zou feitelijk onjuist zijn — de FK is niet null).

## 21. ADMIN-medewerkerfilter

Beoordeling: **later, niet nu.** Geen bestaand component maakt dit
"vrijwel gratis" — de dichtstbijzijnde bouwsteen
(`AccountManagerControl`'s active-user-dropdown) is een mutatie-control,
geen filter-control, en zou aangepast moeten worden. Voegt reële scope
toe (medewerker-picker-UI, "Onbekend"-bucket-semantiek die overlapt met
"Niet toegewezen"). Phase 6B blijft bij Mine/Unassigned/All.

## 22. Dashboard-koppeling

Eén kleine link vanuit de bestaande Phase 6A "Mijn Werk"-sectie (of het
dashboard in het algemeen) naar `/customers?scope=mine` — geen nieuwe
widget, voorkomt duplicatie van wat `/customers` straks beter doet.

## 23. Command palette

Bevestigd: blijft ongewijzigd. De command-palette-`customers`-groep is
globale navigatie/zoekfunctie binnen de al-bestaande, al-open
leesrechten (§6) — geen security-boundary, dus geen reden om een
scope-filter toe te passen. "Mijn klanten" is een lijstweergave-concept,
geen zoek-beveiligingsmodel.

## 24. Opportunity/Task-scheiding

Bevestigd via code: `Opportunity.ownerUserId` en
`CustomerProfile.accountManagerId` zijn volledig onafhankelijke velden
— geen enkele bestaande code synchroniseert ze in beide richtingen.
Phase 6B introduceert geen koppeling.

## 25. CustomerContact

Bevestigd: geen accountmanager-concept op dit model (`isPrimary`/
`isDecisionMaker`/`isBillingContact`-booleans, verder niets relevants).
Niets te bouwen hier.

## 26. Audit

Bestaande `CUSTOMER_PROFILE_UPDATED`/`customer_profile.updated` volstaat
volledig, inclusief voor "Aan mij toewijzen" (dezelfde onderliggende
functie-aanroep). Geen nieuwe `AuditAction` nodig.

## 27. RBAC — samengevat

VIEWER: leest alle drie tabs (matcht het al-bestaande open leesmodel,
§6), geen mutatie-UI. AGENT/ADMIN: lezen + "Aan mij toewijzen" op
Niet-toegewezen-rijen, bestaande `requireWriteAccess()`-gate hergebruikt.
`scope=mine` wordt altijd server-side vanuit de sessie-actor herleid,
nooit een client-aangeleverde `userId` — zelfde patroon als Phase 6A.

## 28. Performance/indexen

Geen index op `accountManagerId`, geen index op `displayName`/
`companyName` — bij het huidige productievolume (3 klanten) irrelevant.
Gerapporteerd als een bewuste, toekomstige performance-keuze, **geen**
migratie nu (conform de opdracht — discovery beslist geen schema).

## 29. Schema-impact

**Geen wijziging nodig.** `accountManagerId`, de FK, en alle benodigde
data bestaan al. Geen nieuw model.

## 30. Samenvatting — wat Phase 6B daadwerkelijk toevoegt

Niet "een filter op een bestaande lijst" — Phase 6B introduceert de
**eerste lokale, browsbare klantenlijst** die deze applicatie ooit heeft
gehad, gescoped op de al-bestaande `accountManagerId`-relatie, met een
bewust klein, bounded, geen-nieuwe-integratie-ontwerp (§7). Dit is de
belangrijkste architecturale conclusie van deze discovery en bepaalt de
volledige `47`/`48`-uitwerking.
