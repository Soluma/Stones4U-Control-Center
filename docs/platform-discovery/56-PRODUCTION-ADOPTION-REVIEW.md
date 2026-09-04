# 56 — Post-Phase-6 Production Adoption Review

**Status**: Discovery/beslisdocument, geen implementatie. Onderzoekt
waarom Stones4U Control Center (Phase 1-6D, production HEAD
`d8266cda9234f088d19c626d3a3c6b963bf092d5`, versie 19) functioneel rijk
is maar vrijwel geen dagelijkse CRM-businessdata bevat. Gebaseerd op
verse, read-only productie-inspectie (counts, timestamps, geen PII) en
read-only broncode-inspectie van dit repo én de vier sibling-repo's
(`OfferteApp`, `s4u-quote-app`, `TelefoonSysteem`, `Kassa Systeem`).

## 1. Production capability map (uit actuele code, niet oude docs)

| Domein | Status | Kernmechanisme |
|---|---|---|
| Customer 360 | Live | 19+ componenten, tabs overview/commercieel/activity/notes/tasks/appointments/files |
| CustomerContacts | Live | CRUD, primary/decisionmaker/billing, archief/restore |
| Customer identity/company | Live | Persoon/organisatie-model (Phase 5A) |
| Notes | Live | Rijke tekst-opslag, nu met pinning (Phase 6D) |
| Pinned notes | Live | `isPinned`/`pinnedAt`/`pinnedById`, teamcuratie ongeacht auteur |
| Tasks | Live | Status/prioriteit/dueAt/checklist/comments, 3 aanmaakpaden |
| Appointments | Live | Alleen per-klant + dashboard "vandaag"-lijst, geen aparte agenda |
| Files | Live | Upload/metadata/verwijderen per klant |
| Activity timeline | Live | 7 bronnen geünificeerd, nu met Bel/Mail/"Taak maken"-quickacties (6C) |
| Calls | Live (enabled) | Read-only projectie, `direction` altijd `UNKNOWN` bij de bron |
| Emails | Live (enabled) | Read-only projectie, richting wél betrouwbaar (IMAP-folder-afgeleid) |
| Quotes | Live | Live-gefedereerd vanuit OfferteApp + s4u-quote-app, geen lokale opslag |
| Shopify orders/drafts | Live | Live, read-only |
| Opportunities/pipeline | Live | Volledig CRUD, stage/won/lost/reopen/archive |
| Sales attention | Live (RED/ORANGE) | BLUE structureel onbereikbaar in elk aggregate pad (bevestigd, ongewijzigd) |
| Mijn Werk | Live | Taken/afspraken-vandaag/aandacht-opportunities, altijd eigen werk |
| Mijn Klanten | Live | Mine/Unassigned/All + "Aan mij toewijzen" |
| Accountmanager-toewijzing | Live | Eén veld, geen workload/territory-concept |
| Quick actions | Live | tel:/mailto:/kopiëren/"Taak maken" op Customer 360 + tijdlijn (6C) |
| Command palette | Live | Klanten/taken/orders/offertes/verkoopkansen/contacten — geen notities |

**Conclusie**: elke geplande Phase 1-6D-capability is daadwerkelijk
productie-live en functioneel compleet naar zijn eigen build spec. Er is
geen technische feature-gap in wat al gebouwd is.

## 2. Productiedata reality check (read-only, geen PII)

**Momentopname, geen permanente uitspraak**: onderstaande counts zijn
vastgelegd op 2026-09-04, het moment van deze review — bedoeld om de
huidige adoptiegraad te verklaren, niet als blijvend geldige waarheid.
Zodra de adoptieperiode (`docs/operations/CRM-ADOPTION-PLAYBOOK.md`)
loopt, veranderen deze aantallen per definitie; de evaluatie na die
periode werkt met een nieuwe meting, niet met de cijfers hieronder.

| Model | Count | 0 logisch (nieuw) of ontbrekend? |
|---|---|---|
| CustomerProfile | 3 | Zie §3 — verklaard, niet "logisch nieuw" |
| CustomerContact | 0 | Volgt uit CustomerProfile=3 — geen contactpersoon ooit toegevoegd |
| Task | 0 | Zie §7 |
| Note | 0 | Zie §6 |
| Appointment | 0 | Zie §8 |
| Opportunity | 0 | Zie §9 |
| Activity | 1 | Eén rij — een test-artefact, geen echte klantinteractie |
| ExternalContactMatch | 3 | Uitsluitend gegenereerd als **bijeffect** van Customer 360-paginabezoeken tijdens engineering-rollouts (bevestigd tijdens Phase 6C-productierollout) |

## 3. CustomerProfile = 3 — exacte oorzaak

**Materialisatie-mechanisme** (enige plek in de hele codebase die een
`CustomerProfile` aanmaakt): `syncCustomerIdentityFromShopify()`
(`customer-profile.service.ts:150`), aangeroepen door precies één route
— `POST /api/customers/resolve` — die op zijn beurt uitsluitend wordt
aangeroepen vanuit drie UI-plekken:

1. `CommandPalette.tsx` — een Shopify-klant selecteren in ⌘K-zoeken.
2. `CustomerSearch.tsx` — een resultaat selecteren in de live
   Shopify-zoekbalk op `/customers`.
3. `NewOpportunityDialog.tsx` — een Shopify-klant kiezen bij het
   aanmaken van een verkoopkans.

**Geen enkel ander codepad materialiseert een profiel** — niet een
inkomend gesprek, niet een inkomende e-mail, niet een order, niet een
offerte. `resolveAndRecordByPhone()`/`resolveAndRecordByEmail()`
(`matching.service.ts`) zoeken uitsluitend tegen **al-bestaande**
`CustomerProfile`/`CustomerContact`-rijen (`findMany({ where: ... })`)
— als niemand die klant ooit al heeft opgezocht, blijft een binnenkomend
gesprek of e-mail volledig "unmatched", zelfs als het een reële,
identificeerbare Shopify-klant betreft.

**Bewijs dat de 3 bestaande profielen engineering-artefacten zijn, geen
echt gebruik**: alle drie `createdAt`-tijdstempels vallen in een venster
van 2026-09-02 11:27 tot 2026-09-03 11:24 — exact het tijdsbestek van
deze sessie's eigen Phase 4B-6D-productierollouts, niet verspreid over
dagen zoals bij organisch personeelsgebruik verwacht zou worden. Voor
alle drie geldt: `crmStatus` staat nog op de default `LEAD`,
`accountManagerId` is `null`, `companyNameConfirmed` is `false`, en er
zijn **0** `CustomerTagAssignment`-rijen. Slechts één profiel heeft één
enkel CRM-veld ooit aangepast (`customerTypeOverride: INDIVIDUAL`) — een
vrijwel zekere restant van Phase 5A's eigen identity-featuretest, niet
van een medewerker die een klant classificeert.

**Schaalcontext (Shopify, read-only opgehaald)**: de winkel heeft
**±5.631 klanten** en verwerkte **±310 bestellingen in de afgelopen 90
dagen** (~3-4 per dag) — een reëel, actief bedrijf. Als medewerkers dit
systeem voor dagelijks werk gebruikten, zou het aantal lokale profielen
allang veel hoger liggen dan 3, puur als bijproduct van het opzoeken van
klanten. Dat het na meerdere dagen productie nog steeds 3 is — allemaal
uit dit ontwikkeltraject zelf — is het sterkste enkele bewijsstuk in
deze review.

**Antwoord op de kernvraag**: **B — een adoptieprobleem, niet A (het
gewenste model)**. Het lazy-materialisatie-ontwerp zelf is niet fout
(bewust, gedocumenteerd, voorkomt een ongewenste bulk-import van 5.631
passieve klanten — zie §11/§19) — maar het is **nog nooit door een echte
medewerker in de praktijk gebruikt**, dus de vraag "is dit het juiste
model" kan feitelijk nog niet beantwoord worden vanuit productiegebruik.

## 4. Mijn Klanten reality check

Met 3 profielen en 0 toewijzingen is "Mijn Klanten" vandaag voor elke
medewerker leeg (`mine`), "Niet toegewezen" toont alle 3, "Alle klanten"
toont 3 — geen enkele van de drie tabs is op dit moment een bruikbare
dagelijkse klantenlijst. Dit is een rechtstreeks gevolg van §3, geen
apart Mijn-Klanten-probleem: zodra medewerkers daadwerkelijk klanten
opzoeken en aan zichzelf toewijzen (Phase 6B's "Aan mij toewijzen" is al
live en concurrency-veilig), vult deze weergave zich organisch.
Vermoedelijke medewerkersverwachting (niet bevestigd, geen bewijs
voorhanden): een medewerker verwacht waarschijnlijk klanten waarmee
**hij/zij actief in contact is** (offerte, telefoongesprek, order in
behandeling) in "Mijn Klanten" te zien — niet elke Shopify-klant
automatisch. Dat pleit tegen een bulkimport (zie §11/§19) en vóór een
signaalgedreven materialisatie-aanvulling, maar dat is een **architectuur-
vraag voor een aparte fase** (§19), geen conclusie die nu getrokken wordt.

## 5. CustomerProfile materialization — optievergelijking (analyse, geen keuze)

| Optie | Business-betekenis | Datavolume | Privacy | Shopify-load | Duplicate/identity-risico | Accountmanager-semantiek | Effect op Mijn Klanten | Operationele waarde |
|---|---|---|---|---|---|---|---|---|
| A. Lazy zoals nu | Profiel = "iemand heeft deze klant ooit relevant gevonden" | Minimaal (3 na dagen) | Uitstekend — geen ongevraagde dataverzameling | Nul extra | Nul (uniek op shopifyCustomerGid, bewezen) | Schoon, maar leeg totdat gebruik start | Blijft leeg zonder actief gebruik | Hoog per opgezochte klant, nul passief |
| B. Expliciete "CRM-klant maken"-knop | Voegt een bewuste stap toe boven op A | Zelfde als A, iets hogere frictie | Uitstekend | Nul extra | Nul | Zelfde als A | Zelfde als A | Vermoedelijk geen verbetering — A is al impliciet "expliciet" (zoeken+openen) |
| C. Periodieke volledige Shopify-sync | Elke Shopify-klant wordt een CustomerProfile | 5.631+ rijen direct | Slecht — verzamelt data over passieve, nooit-gecontacteerde klanten zonder aanleiding | Eén grote batch + herhaald | Laag (zelfde unieke-GID-garantie), maar massale ruis | Oningevuld voor bijna alle 5.631 — devalueert "toegewezen" | Overspoelt "Alle klanten" met irrelevante rijen | Laag — kwantiteit zonder kwaliteit, precies het "premature automation"-risico (opdracht §16) |
| D. Materialiseren bij relevante signalen (offerte/order/gesprek/e-mail) | Profiel = "er is een commerciële/communicatie-aanleiding" | Groeit met echte activiteit, niet met catalogusgrootte | Goed — alleen bij een concreet contactmoment | Beperkt, gebeurtenisgedreven | Vereist zorgvuldige idempotentie (zelfde patroon als bestaande upsert kan hergebruikt worden) | Vult zich vanzelf uit echte interacties | Directe, geleidelijke, relevante vulling | Potentieel hoog — lost precies het in §3 genoemde "gemiste inkomend gesprek"-gat op |
| E. Actieve-klantenselectie o.b.v. orders/quotes/contact | Alleen klanten met aantoonbare recente commerciële activiteit | Middelgroot, begrensd | Goed | Eenmalige/periodieke gerichte batch, geen full sync | Laag, mits deduplicatie op GID (bestaand patroon) | Vult direct een zinvolle startset | Direct bruikbare eerste vulling | Hoog als eenmalige bootstrap, maar geen doorlopend mechanisme |

**Geen van deze opties is hier gekozen of ontworpen** — dit is uitsluitend
de vergelijking die de opdracht vroeg. Optie D (en eventueel E als
eenmalige bootstrap ernaast) lijkt op basis van deze analyse het meest
kansrijk, maar verdient een eigen discovery/architectuur-traject (zie
§19) — niet een impliciete keuze in dit document.

## 6. Notes = 0 — analyse

Notitie-zoeken (kandidaat #2 uit doc 52) is **overduidelijk niet de
volgende stap** zolang er nul notities bestaan om te doorzoeken — dat
zou een oplossing zijn voor een probleem dat nog niet is ontstaan.
Waarschijnlijkste verklaring is eenvoudig: **er zijn nog geen 3+
klanten om over te schrijven, en zelfs voor die 3 is er nooit een reden
geweest** (geen echt lopend gesprek met een echte medewerker). Notes
zelf is UX-technisch niet de bottleneck — de aanmaakflow is triviaal (één
textarea + knop, zichtbaar zodra Customer 360 open staat). Sterkere,
bewezen verklaring (zie §10/§14): **OfferteApp heeft al een volwaardig,
actief onderhouden "bezoekrapport"-systeem** (`VisitReport`-model,
eigen blueprint/service/API, gekoppeld aan `shopify_customer_id`) dat
functioneel vrijwel identiek is aan wat Notes hier biedt. Het is
aannemelijk dat verkopers die gewoonte al hebben, en dus geen aanleiding
voelen om ditzelfde in een tweede systeem te herhalen. Classificatie:
**C (adoptiegat), met een concreet aanwijsbare gewoonte-oorzaak** —
niet enkel "nog niet begonnen", maar "doet het al ergens anders".

## 7. Tasks = 0 — analyse

Tasks 2.0, Mijn Werk, en "Taak maken vanuit tijdlijn" (Phase 6C) zijn
alle drie productie-compleet en goed geïntegreerd. Task-aanmaak is
zichtbaar op drie plekken (Customer 360-header, tijdlijn-quickactions,
`/tasks`). Er is geen aanwijsbare UX-frictie in de code zelf. De meest
waarschijnlijke verklaring is dezelfde als Notes: zonder klanten in het
systeem (§3) is er simpelweg niets om een taak over aan te maken, én
TelefoonSysteem heeft al zijn **eigen**, telefoonnummer-gekeyde
`Task`/`ContactNote`-model (bevestigd in
`TelefoonSysteem/prisma/schema.prisma`), bewust never gesynchroniseerd
met dit CRM (ADR-003). Als telefonie-gerelateerde taken al in
TelefoonSysteem worden vastgelegd, is er nul aanleiding om ze hier
nogmaals te typen. Classificatie: **C (adoptiegat)**, deels met dezelfde
concrete gewoonte-oorzaak als Notes (een ander systeem, niet "geen
systeem"). Geen bewijs voor een auto-task-engine — expliciet niet
aanbevolen (opdracht §7/§16).

## 8. Appointments = 0 — analyse

Zelfde onderliggende oorzaak als Tasks/Notes (§3: geen klanten om een
afspraak aan te koppelen). Vóór er geconcludeerd wordt dat een
agenda-feature zinvol is, moet eerst vaststaan **of afspraken in dit CRM
thuishoren** in de huidige Stones4U-werkwijze — daar is in deze review
geen bewijs voor gevonden (geen sibling-systeem met een agenda/afspraak-
concept aangetroffen, in tegenstelling tot Notes/Tasks die wel
duidelijke sibling-equivalenten hebben). Classificatie: **E (onbekend)**
— onvoldoende bewijs om te zeggen of dit een adoptiegat, een
featuregat, of gewoon (nog) niet relevant is. Geen agenda-feature
prioriteren op basis van deze review (bevestigt opdracht §8).

## 9. Opportunities = 0 — analyse

De pipeline is volledig gebouwd (stage/won/lost/reopen/archive,
attention-engine). Sterkste verklaring, direct onderbouwd: **offertes
leven al volledig in OfferteApp/s4u-quote-app** (§10/§11) — die apps
hebben hun eigen quote-lifecycle, en dit CRM federeert die offertes al
(read-only) in Customer 360/tijdlijn/command-palette zonder dat daar een
lokale `Opportunity` voor nodig is. Een medewerker heeft dus **geen
directe aanleiding** om handmatig een Opportunity aan te maken zolang
hun eigenlijke offerteproces zich elders afspeelt — de Opportunity-
laag is vandaag puur een optionele, extra rapportagelaag bovenop een
proces dat al ergens anders compleet functioneert. Classificatie: **C
(adoptiegat) gecombineerd met D (architecturale vraag)** — de vraag "moet
een offerte-aanvraag automatisch een Opportunity triggeren" is precies
zo'n architectuurvraag (§11), niet iets om nu te bouwen.

## 10. Sibling-data inventarisatie (read-only broncode-inspectie)

- **OfferteApp**: heeft al een **volwaardig, actief blueprint**
  (`app/blueprints/visit_reports/`, `app/blueprints/bezoekrapport/`,
  `app/services/visit_reports/visit_report_service.py`) voor
  "bezoekrapporten" — een `VisitReport`-model
  (`app/models/visit_report.py`) met `shopify_customer_id`, optioneel
  `quote_id`, `title`/`report_text`, `internal_only`-vlag, en
  `created_by`. Functioneel sterk overlappend met dit CRM's Notes.
  **Niet** blootgesteld via de bestaande
  `app/blueprints/integrations/api.py` (die uitsluitend `/quotes`
  exposeert) — volledig onzichtbaar voor Control Center vandaag.
- **TelefoonSysteem**: eigen `Contact`/`Task`/`ContactNote`-model
  (`prisma/schema.prisma`), telefoonnummer-gekeyed, bewust nooit
  gesynchroniseerd met dit CRM (ADR-003, bevestigd ongewijzigd).
- **s4u-quote-app**: geen eigen customer/lead-model aangetroffen —
  vermoedelijk het oudere, Shopify-embedded quote-tool zonder eigen
  klantrelatie-laag.
- **Kassa Systeem (POS)**: bevestigd (eerdere sessie-discovery,
  ongewijzigd) geen eigen `Customer`-tabel — klanten blijven volledig in
  Shopify, geen CRM-achtige data hier.
- **Exact/accounting**: ongewijzigd **BLOCKED** — externe auth-blokkade
  bij TelefoonSysteem's `customer-history-db`-toegang, niet oplosbaar
  vanuit deze repo.

**Kernvraag "welke data bestaat al maar wordt nog niet gebruikt als
CRM-startpunt"**: het antwoord is expliciet **OfferteApp's
bezoekrapporten** en, in mindere mate, **TelefoonSysteem's
Task/ContactNote** — beide representeren precies het soort
klantrelatie-informatie die dit CRM zou moeten centraliseren, maar die
vandaag in twee aparte, niet-geïntegreerde systemen blijft.

## 11. Offertes als CRM-startsignaal — analyse

Architecturaal aantrekkelijk (een offerteaanvraag is een duidelijk,
commercieel, opt-in-achtig moment — heel anders dan "elke Shopify-
klant"), en OfferteApp's eigen `Quote`-model heeft al
`shopify_customer_id` direct beschikbaar, dus matching zou geen nieuwe
identity-onzekerheid toevoegen. Dit zou **zowel** het CustomerProfile-
materialisatieprobleem (§3/§5 optie D) **als** het Opportunity=0-
probleem (§9) tegelijk kunnen aanpakken: "een offerte ontstaat" →
"een CustomerProfile + Opportunity ontstaat/wordt gekoppeld". Belangrijke
makkelijke valkuil om te vermijden (opdracht §11 zelf waarschuwt hiervoor):
dit mag nooit verward worden met "importeer alle 5.631 Shopify-klanten"
— het zou uitsluitend gelden voor klanten die daadwerkelijk een offerte
aanvragen, een fundamenteel andere, veel kleinere en commercieel
relevantere populatie. **Niet gekozen of ontworpen hier** — een sterke
kandidaat-hypothese voor de aparte materialisatie-discovery (§19), geen
besluit.

## 12. Telefoon/e-mail als CRM-startsignaal — analyse

Bevestigd in §3: bij een inkomend/uitgaand gesprek of e-mail bestaat
**uitsluitend matching tegen een reeds-bestaand profiel** — nooit
materialisatie. Dit is exact het gat waar CRM-waarde het hoogst zou
zijn (een medewerker neemt op, wil meteen zien "ken ik deze klant al")
maar vandaag het minst geleverd wordt (niets verschijnt, tenzij iemand
deze klant al eerder had opgezocht). Dit is potentieel **belangrijker
dan elke nieuwe UI-feature** (bevestigt de expliciete hint in de
opdracht) — maar het wijzigen van materialisatie-gedrag is precies het
soort architectuurbeslissing dat opdracht §19 vraagt apart te behandelen,
niet nu te implementeren.

## 13. Accountmanager-adoptie

Actuele verdeling (read-only bevestigd): **0 van de 3** profielen heeft
een `accountManagerId`. "Aan mij toewijzen" (Phase 6B) is technisch
volledig werkend en concurrency-veilig, maar heeft in productie nog
nooit een reële toewijzing verwerkt buiten geautomatiseerde
rollout-tests (die altijd zorgvuldig zijn opgeruimd — bevestigd via de
DB-baselines in elk productie-rollout-rapport). Accountmanager-
toewijzing krijgt per definitie pas betekenis zodra er een zinvolle
klantpopulatie is om aan toe te wijzen (§3) — dit is dus volledig
stroomafwaarts van het materialisatie-vraagstuk, niet een apart
probleem.

## 14. Legacy/bestaande klantafspraken

**Bevestigd, niet gegokt** (§10): OfferteApp's bezoekrapporten
(`VisitReport`) en TelefoonSysteem's `Task`/`ContactNote` zijn de twee
concrete, aanwijsbare bestaande bronnen waar Stones4U vandaag al
klantnotities/taken vastlegt, buiten dit CRM om. Geen bewijs gevonden
van een derde bron (geen spreadsheet/extern systeem in de vier
sibling-repo's aangetroffen die hierop zou wijzen) — voor alles daarbuiten
geldt: **onbekend**, niet aangenomen.

## 15. Feature/data/adoption-classificatie per domein

| Domein | Classificatie | Onderbouwing |
|---|---|---|
| CustomerProfile-populatie | **C — adoptiegat** (met een architecturale nuance, zie §5) | Materialisatie werkt zoals ontworpen; er is alleen nog geen gebruik geweest om het te vullen |
| Mijn Klanten | **C — adoptiegat** (volgt uit CustomerProfile) | Geen eigen probleem, stroomafwaarts van §3 |
| Notes | **C — adoptiegat, met bewezen gewoonte-oorzaak** | OfferteApp's bezoekrapporten al in gebruik (aangenomen, niet gemeten) |
| Tasks | **C — adoptiegat, deels met bewezen gewoonte-oorzaak** | TelefoonSysteem's eigen Task-model bestaat al |
| Appointments | **E — onbekend** | Geen sibling-equivalent gevonden, geen ander bewijs |
| Opportunities | **C + D — adoptiegat + architectuurvraag** | Offertes leven al elders; koppeling zou beide tegelijk kunnen aanpakken |
| Accountmanager-toewijzing | **C — adoptiegat** | Volledig afhankelijk van §3 |
| Inkomende communicatie → CRM-zichtbaarheid | **D — architectuurvraag (materialisatie)** | Structureel bevestigd: matching bestaat, materialisatie niet |

## 16. Kandidaten voor de volgende stap (max. 6, inclusief non-build)

| # | Optie | Probleem | Bewijs | Businesswaarde | Risico | Complexiteit | Data-impact | Externe dependency | Advies |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **Gewoon productiegebruik starten** (operationeel, geen build) | CRM is compleet maar nooit echt gebruikt | §3: 3 profielen, alle drie engineering-artefacten; 0 van elke businessentiteit | Zeer hoog — enige manier om te weten of iets van dit alles daadwerkelijk werkt in de praktijk | Zeer laag | Geen (operationeel) | Geen | Geen | **Sterk aanbevolen, als eerste stap** |
| 2 | Gerichte customer-materialization-discovery (offerte-/communicatie-signaal) | Materialisatie gebeurt nooit passief (§3/§12) | Structureel bevestigd in code (`resolveAndRecordBy*` matcht nooit, creëert nooit) | Potentieel hoog, ongemeten | Middel (identity/privacy-afwegingen, zie §5) | M-L (eigen discovery/architectuur-traject) | Kan CustomerProfile-aantal aanzienlijk laten groeien — vereist zorgvuldig ontwerp | Shopify (al bestaand patroon), evt. OfferteApp-quote-koppeling | **Later — waardevolle vervolg-discovery, niet nu bouwen** |
| 3 | Quote→CRM handoff (offerte als startsignaal) | Opportunities/CustomerProfile blijven leeg terwijl offertes elders al bestaan | §9/§11, OfferteApp's `Quote.shopify_customer_id` al beschikbaar | Potentieel hoog | Middel (cross-app-koppeling, welke app is autoritatief blijft een open vraag uit eerdere sessies) | M-L | Middelgroot, begrensd tot offerte-klanten | OfferteApp/s4u-quote-app (welke is de "echte"? nog niet opgelost — zie doc's uit de originele platform-discovery) | **Later — sterke kandidaat, vereist eerst de offerteapp/s4u-quote-app-ambiguïteit op te lossen** |
| 4 | Gebruikersworkflow/documentatie/korte onboarding | Niemand heeft blijkbaar nog een gestructureerde introductie tot het systeem gehad | Geen enkel spoor van organisch gebruik in de productiedata | Hoog — vaak de eigenlijke bottleneck bij "compleet maar ongebruikt"-systemen | Zeer laag | Geen (operationeel) | Geen | Geen | **Sterk aanbevolen, samen met #1** |
| 5 | Data-migratie/import vanuit OfferteApp-bezoekrapporten | Bestaande klantkennis blijft gevangen in een ander systeem | §10/§14, `VisitReport`-model bevestigd bestaand en gekoppeld | Middel-hoog, mits het systeem daadwerkelijk actief gebruikt wordt (niet gemeten) | Middel (eenmalige import, geen doorlopende sync, risico op verouderde/dubbele info) | M | Kan in één keer relevante historische Notes-achtige data opleveren | OfferteApp (leesrechten nodig) | **Later — pas zinvol ná bevestiging dat bezoekrapporten daadwerkelijk actief gebruikt worden** |
| 6 | Niets bouwen, twee weken observeren na een zachte lancering | We weten simpelweg nog niet hoe dit systeem in de praktijk presteert | Nul organisch gebruik tot nu toe | Hoog (informatief) | Zeer laag | Geen | Geen | Geen | **Overweeg te combineren met #1/#4** |

## 17. Aanbevolen volgende stap

Een combinatie van **#1 (productiegebruik starten) + #4 (korte
workflow-introductie) + #6 (een observatieperiode)** — geen van deze is
een build-taak. Concreet, geen implementatie, uitsluitend een
aanbeveling: Stones4U-medewerkers daadwerkelijk laten inloggen en het
systeem voor echte, lopende klantcontacten laten gebruiken (te beginnen
met simpelweg een klant opzoeken via ⌘K/de zoekbalk zodra er telefonisch
of per e-mail contact is, en die notities/taken/afspraken daar vast te
leggen in plaats van in OfferteApp's bezoekrapporten of
TelefoonSysteem's eigen taken) — met een korte observatieperiode
daarna om te zien welke van de in §15/§16 geïdentificeerde
adoptiegaten zich in de praktijk daadwerkelijk manifesteren, vóórdat
er verder gebouwd wordt.

## 18. Waarom dit vóór elke andere feature

Elke technische capability t/m Phase 6D is al productie-live en
functioneel compleet naar zijn eigen build spec (§1) — er is geen
bewijs van een blokkerende featuregap. Het probleem dat deze review
blootlegt is aantoonbaar **gedrag/adoptie**, niet **techniek**: 3
profielen, allemaal uit dit ontwikkeltraject zelf, tegenover een winkel
met 5.631 klanten en ~310 orders per kwartaal. Nog een feature bouwen
(notitie-zoeken, een agenda, BLUE-signalen, Mijn-Klanten-verfijningen)
zou functionaliteit toevoegen aan een systeem dat zijn bestaande
functionaliteit nog niet één keer in de praktijk heeft bewezen — het
risico is een steeds rijker CRM dat nog steeds niemand gebruikt.

## 19. Indien customer materialization het echte blokkerende probleem blijkt

Zoals opdracht §19 vraagt: als de observatieperiode (§17) bevestigt dat
lazy materialisatie daadwerkelijk de dagelijkse bruikbaarheid blokkeert
(bijv. medewerkers vergeten stelselmatig een klant eerst op te zoeken,
of inkomende gesprekken/e-mails blijven onzichtbaar omdat er nog geen
profiel bestaat), dan verdient dit een **eigen, volgende discovery-fase**
— nog geen build spec — die minimaal moet beschrijven:

- Gewenste CRM-populatie (elke Shopify-klant? alleen klanten met een
  offerte/order/gesprek/e-mail? een expliciete drempel?).
- Lifecycle: wanneer ontstaat een profiel, wanneer expliciet niet
  (bijv. eenmalige, niet-commerciële browsing-orders uitsluiten).
- Source of truth voor het aanmaakmoment (Shopify-order-webhook?
  OfferteApp-quote-signaal? TelefoonSysteem/e-mail-matching-uitbreiding?).
- Effect op accountmanager-semantiek (blijft een nieuw profiel altijd
  onbewijzigd `null`, of kan een signaalbron een voorlopige toewijzing
  suggereren?).
- Databewaring/retentie voor profielen die nooit tot iets leiden.
- Shopify-API-belasting bij een gebeurtenisgedreven of periodieke
  aanpak (huidig client-credentials-patroon, geen nieuwe webhook-
  infrastructuur zonder expliciete afweging).
- Idempotentie/duplicate-preventie (de bestaande unieke
  `shopifyCustomerGid`-constraint is al bewezen voldoende voor het
  huidige upsert-pad — bevestigen dat elke nieuwe triggerbron dezelfde
  garantie behoudt).

## 20. Indien adoptie het probleem is (bevestigd hierboven)

Dit is expliciet het geval — zie §3/§18. Geen kunstmatige nieuwe feature
wordt aanbevolen. Wat operationeel moet gebeuren staat in §17: echt
gebruik starten, een korte introductie, en observeren — geen
implementatiewerk in dit repo.

## Blockers/unknowns

- **Onbekend**: hoe actief OfferteApp's bezoekrapporten/TelefoonSysteem's
  taken daadwerkelijk vandaag worden gebruikt (geen toegang tot hun
  productiedatabases vanuit deze review — alleen hun broncode
  geïnspecteerd, per de bestaande "sibling apps zijn read-only"-regel).
  Dit zou de urgentie van kandidaat #5 (data-migratie) direct
  beïnvloeden.
- **Onbekend**: of er al een interne aankondiging/introductie van
  Control Center aan Stones4U-medewerkers heeft plaatsgevonden buiten
  deze ontwikkelsessie om — geen bewijs hiervan gevonden in de
  productiedata of dit repo's documentatie.
- **Nog niet opgelost** (bekend sinds de originele platform-discovery,
  niet nieuw hier): welke van OfferteApp/s4u-quote-app het autoritatieve
  offertesysteem is — relevant voor kandidaat #3, niet voor deze review
  zelf.
- Appointments blijft geclassificeerd als **E — onbekend** (§8/§15) —
  onvoldoende bewijs in beide richtingen.

---

**NEXT STEP: NO NEW FEATURE YET**
