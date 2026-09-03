# ADR-009 — Opportunity/pipeline datamodel en state-semantiek

**Status**: Geïmplementeerd, staging-geverifieerd (2026-09-03). §1 en
§9–§13 zijn op 2026-09-03 toegevoegd/gecorrigeerd na een gerichte
pre-production data-semantics review die een reëel reopen-datalek en drie
ontbrekende validaties vond — zie
`docs/build/PHASE-4A-SALES-PIPELINE-STAGING.md` §21 voor het volledige
fix-rapport. §1–§8 zijn de oorspronkelijke, ongewijzigde nummering (op de
correctie binnen §1 na) — bestaande verwijzingen naar ADR-009 §6/§7/§8
elders (architectuurdoc, build-rapporten) blijven daardoor geldig.

## Context

Het Control Center bevat na Phase 3C alle bouwstenen om een klant te *zien*
(Customer 360: orders, conceptbestellingen, offertes uit twee bronnen,
telefoongesprekken, e-mail, taken, notities, afspraken, bestanden), maar geen
enkel model om een lopend **verkooptraject** te *beheren*: waarde, kans,
fase, eigenaar, verwachte sluitdatum, en de vraag "wat moet er nu gebeuren."
Een klant kan meerdere gelijktijdige, onafhankelijke verkooptrajecten hebben
(bv. een terras+zwembadproject én een aparte garantie-/onderhoudsvraag) die
`CrmStatus` (één waarde per klant) niet kan onderscheiden. Zie
`docs/platform-discovery/31-PHASE-4-SALES-PIPELINE-DISCOVERY.md` voor de
volledige inventarisatie en `32-PHASE-4-SALES-PIPELINE-ARCHITECTURE.md` voor
het volledige ontwerp — dit ADR legt alleen de datamodel- en
state-beslissingen vast die niet vanzelfsprekend uit die documenten volgen.

## Besluit

### 1. `stage` en `status` zijn twee gescheiden velden, geen samengevoegde enum

Task combineert workflow-positie en eindstatus in één `TaskStatus`-enum
(`OPEN, IN_PROGRESS, WAITING, DONE, CANCELLED`) — dat werkt daar omdat Task
geen "funnel" heeft. Opportunity heeft dat wel: de vraag "hoever in het
verkoopproces was deze deal toen hij verloren ging" is zelf waardevolle
rapportage-informatie (§18 van de architectuurdoc) die verloren gaat als
"Verloren" gewoon een fase-waarde tussen de andere fases wordt.

Daarom:
- `stage: OpportunityStage` — uitsluitend de actieve funnel-posities (Nieuw
  t/m Onderhandeling). Bevriest op de laatste actieve waarde zodra de
  opportunity gesloten wordt — verandert daarna niet meer.
- `status: OpportunityStatus { OPEN, WON, LOST }` — de levenscyclus, apart
  van de funnelpositie. Alleen wijzigbaar via de expliciete
  `markWon`/`markLost`/`reopen`-acties (nooit via een generieke stage-PATCH),
  zodat een winst/verlies altijd zijn eigen auditregel en eigen
  business-regels krijgt (§13 van de architectuurdoc).

Dit wijkt bewust af van het in de opdracht gegeven voorbeeld (dat "Gewonnen"/
"Verloren" als fases opsomt) — zie architectuurdoc §2 voor de volledige
onderbouwing.

**Correctie (2026-09-03) — Opportunity-rij is uitsluitend de HUIDIGE
canonical state; historie leeft uitsluitend in `AuditEvent`/`Activity`.**
De oorspronkelijke versie van dit ADR liet `reopen()` `wonAt`/`lostAt`
"sticky" laten staan (alleen `lostReason` werd gewist), met als
motivatie "history". Een gerichte pre-production review
(`docs/build/PHASE-4A-SALES-PIPELINE-STAGING.md` §21) toonde aan dat dit
fout was: een heropende, nog altijd OPEN opportunity hield daardoor een
niet-lege `wonAt`/`lostAt`, waardoor een simpele toekomstige query als
`WHERE wonAt IS NOT NULL` zo'n opportunity ten onrechte als "gewonnen" zou
tellen — en onafhankelijk daarvan werd `finalValue` door `markLost()`
nooit gewist, waardoor een WON→reopen→LOST-traject een verweesde
WON-waarde op een LOST-rij kon achterlaten. Bij nadere inspectie bleek de
"history"-motivatie zelf niet te kloppen: `AuditEvent`
(`opportunity.won`/`.lost`/`.reopened`) en `Activity`
(`OPPORTUNITY_WON`/`_LOST`/`_REOPENED`) leggen elke closing-gebeurtenis al
onvoorwaardelijk vast, onafhankelijk van wat er met `wonAt`/`lostAt`
gebeurt — er ging dus niets verloren door ze te wissen.

**Definitieve regel**: `reopen()` zet `status=OPEN` én wist
`wonAt`, `lostAt`, `lostReason`, **en** `finalValue` — allemaal naar
`null`. `stage` blijft ongewijzigd (bevroren op de laatste actieve
waarde). Een Opportunity-rij beantwoordt daarmee altijd correct en zonder
uitzondering "wat is de huidige toestand" met alleen zijn eigen kolommen;
"wanneer is dit ooit gewonnen/verloren/heropend geweest" is een vraag voor
`AuditEvent`/`Activity`, nooit voor de Opportunity-rij zelf.

### 2. Pipeline-fases starten als een vaste Prisma-enum, niet als configureerbare tabel

Elk bestaand workflow-veld in dit schema (`TaskStatus`, `TaskPriority`,
`AppointmentStatus`, `CrmStatus`) is een vaste enum — nergens in deze
codebase bestaat een precedent voor een admin-configureerbare
workflow-tabel. Een configureerbare-fases-tabel zou de eerste van zijn soort
zijn, zonder dat er vandaag een concreet gebruiksscenario is dat een vaste
lijst niet aankan. Start daarom met een vaste `OpportunityStage`-enum met de
zes fases uit de architectuurdoc.

**Expliciete consequentie, niet verzwegen**: een Postgres-enumkolom later
omzetten naar een foreign key naar een lookup-tabel is een echte,
niet-triviale migratie (waarde-mapping + backfill), geen kosteloze
refactor. Dit is een bewuste ruil van "moeilijker te wijzigen later" voor
"eenvoudig en consistent met de rest van het schema nu" — precies de ruil
die elk ander status-veld in dit schema al maakt.

### 3. Geen `OpportunityProduct`, geen `OpportunityContact`

- **`OpportunityProduct`** zou productregels/pricing dupliceren die al in
  Shopify (draft orders) en de offerte-apps leven — in directe spanning met
  het principe achter ADR-002 (Shopify blijft bron van waarheid voor
  commerciële identiteit) uitgebreid naar productdetail: Opportunity is de
  commerciële *context rond* die objecten, geen herimplementatie ervan.
- **`OpportunityContact`** (meerdere contactpersonen per opportunity) zou
  functionaliteit bouwen die `CustomerProfile` zelf niet eens heeft (geen
  enkel model in dit landschap ondersteunt vandaag meerdere contactpersonen
  per klant) — dat hoort, als het ooit nodig is, op `CustomerProfile`-niveau
  thuis, niet als Opportunity-specifieke uitzondering.

### 4. `OpportunityExternalLink` — lichte referentie, geen duplicatie

Voor koppelingen naar offertes (OfferteApp/s4u-quote-app) en Shopify
(concept)bestellingen — objecten die *niet* in deze database bestaan — komt
er één generiek koppelmodel, naar het patroon van `ExternalContactMatch`
(ADR-007): `externalRef`'s betekenis is `linkType`-afhankelijk, nooit de
externe data zelf, mensen leggen en ontkoppelen de link expliciet
(`linkedById`, soft-`unlinkedAt`), nooit hard verwijderd. Task/Note/
Appointment krijgen daarentegen een directe, optionele `opportunityId`-FK
(geen linktabel) omdat die al Control-Center-eigen rijen zijn — het
linkmodel is uitsluitend nodig voor objecten die *buiten* deze database
bestaan.

### 5. Task/Note/Appointment: `opportunityId` optioneel, `customerProfileId` blijft leidend

Elk van de drie krijgt een additieve, optionele `opportunityId`-kolom. De
servicelaag (niet de database — Prisma ondersteunt geen cross-field
consistentiecontrole) valideert bij het zetten van `opportunityId` dat de
gekoppelde opportunity's `customerProfileId` overeenkomt met die van de
task/note/afspraak — en leidt `customerProfileId` af van de opportunity
wanneer beide gegeven zouden kunnen worden, in plaats van een mogelijk
inconsistente aanroeper te vertrouwen. Zo kan een taak: alleen
klantgebonden zijn, opportunity-gebonden zijn (en daarmee altijd ook
diezelfde klant), maar nooit een opportunity van klant A aan een taak van
klant B hangen. (`File` kreeg dezelfde behandeling bij de implementatie —
niet expliciet in de oorspronkelijke tekst van dit ADR genoemd, maar
identiek toegepast.)

### 6. Geld: `Decimal @db.Decimal(12,2)`, geen `currency`-kolom

Dit is de eerste keer dat dit schema zelf een geldbedrag opslaat — elk
bestaand geldbedrag in de codebase is vandaag een live Shopify-`string`
(`{amount, currencyCode}`) of een gefedereerd offertebedrag, nooit lokaal
opgeslagen. Prisma `Decimal` (Postgres `NUMERIC`) is de juiste keuze zodra
er wél lokaal wordt opgeslagen en gesommeerd: geen JavaScript-float-fouten,
correcte sortering, native `SUM`/`AVG` in de database voor
dashboard-aggregaties. Er komt geen `currency`-kolom — de hele winkel is
EUR (elke Shopify-oproep in deze app gaat naar één EUR-shop, `formatMoney()`
neemt al aan dat er niets te kiezen valt) — een kolom toevoegen die de UI
nooit laat wijzigen is precies het soort premature abstractie de
projectinstructies afraden. Weergave hergebruikt het bestaande
`formatMoney({amount, currencyCode})` uit `src/lib/format.ts` door
`estimatedValue.toString()` in te vullen — geen nieuwe formatteerfunctie.
Zie §8 voor hoe invoer vóór opslag gevalideerd wordt.

### 7. Geen hard delete — alleen archiveren

Consistent met het bestaande patroon (`Note.deletedAt`,
`ExternalContactMatch.unlinkedAt`) en met de expliciete voorkeur uit de
opdracht: Opportunity krijgt een `archivedAt`-veld, geen
delete-endpoint. Dit maakt bovendien elke discussie over
cascade-gedrag voor gekoppelde taken/notities/afspraken bij verwijdering
overbodig — die rijen blijven altijd geldig verwijzen naar een bestaande
(mogelijk gearchiveerde) opportunity.

### 8. Geen achtergrondproces voor "opvolging nodig"

Volledig on-the-fly berekend bij het opvragen van een opportunity/lijst
(stage=open + laatste Control-Center-eigen activiteit + open taken +
`expectedCloseDate`) — geen cron, geen queue, geen bijgehouden
`isStale`-kolom. Zie architectuurdoc §17 voor de exacte regel. Dit volgt
direct uit ADR-004/008's al gevestigde principe dat een polling-/sync-taak
alleen gebouwd wordt als on-the-fly berekenen aantoonbaar niet volstaat —
bij de verwachte data-omvang (tientallen tot enkele honderden open
opportunities) is dat hier niet het geval.

### 9. Strikte state-transitions: WON/LOST alleen vanuit OPEN (2026-09-03)

`markWon()`/`markLost()` weigeren nu expliciet wanneer de opportunity niet
`status=OPEN` is — een directe LOST→WON- of WON→LOST-overgang wordt
geweigerd met een `OpportunityValidationError`; de gebruiker moet altijd
eerst `reopen()` aanroepen. Dit was oorspronkelijk niet zo gebouwd:
`markWon()`/`markLost()` hadden alleen een idempotentie-check op hun eigen
doelstatus (bv. `if (status === "WON") return`), niet op de tegengestelde
gesloten status — waardoor een direct API-verzoek een LOST-opportunity
zonder tussenstap naar WON kon zetten, wat de expliciete `reopen()`-stap
(en zijn eigen audit-/Activity-regel) oversloeg. Nu symmetrisch met
`changeStage()`'s al bestaande `status !== "OPEN"`-guard. Herhaalde
aanroepen op de reeds-bereikte doelstatus blijven een no-op (geen dubbele
audit/Activity-regel) — dat gedrag is ongewijzigd.

### 10. `updateOpportunity()` bevriest bij gesloten status; `assignOwner()` bewust niet

Inhoudelijke velden (titel, omschrijving, `estimatedValue`, `probability`,
`expectedCloseDate`) zijn alleen wijzigbaar terwijl `status=OPEN` — exact
dezelfde guard als `changeStage()`. Dit was oorspronkelijk gemist: deze
velden bleven wijzigbaar op een WON/LOST (niet-gearchiveerde) opportunity,
wat de commerciële feiten van een reeds gesloten deal achteraf kon laten
verschuiven.

`assignOwner()` krijgt bewust **geen** vergelijkbare guard — eigenaarschap
is een administratief/verantwoordelijkheidsfeit (wie krijgt credit, wie is
aanspreekpunt), geen commercieel feit van de deal zelf. Een gesloten deal
opnieuw toewijzen (foutcorrectie, personeelswissel, commissie-overdracht)
is een legitieme, veelvoorkomende praktijkbehoefte die niets verandert aan
wat er verkocht is, voor hoeveel, of wanneer. Deze keuze is bewust
gemaakt en hier vastgelegd, niet stilzwijgend overgenomen.

### 11. Geld-validatie: strikte decimale parser, geen kale `Number()`

`estimatedValue`/`finalValue` (§6) worden geparsed door één centrale
`parseMoneyInput()`-functie (`src/modules/opportunities/
opportunity.service.ts`) — een strikt, unsigned decimaal patroon
(`^\d{1,10}(\.\d{1,2})?$`), maximaal 2 decimalen, geen exponentnotatie,
geen minteken, geverifieerd tegen `Decimal(12,2)`'s bovengrens
(`9999999999.99`) via `Prisma.Decimal`-rekenkunde — nooit via `Number()`
als validator. Dit was oorspronkelijk gemist: de eerste versie gebruikte
kale `Number()`-coercie, die exponentnotatie en getallen groter dan de
kolom accepteerde, met een onafgevangen database-overflow (generieke 500)
als gevolg in plaats van een nette 400. Een JS-`number`-input wordt nog
altijd ondersteund (voor bestaande callers), maar defensief genormaliseerd
via `toFixed(2)` — alleen als dat geen echte derde decimaal wegrondt (dus
`0.1 + 0.2` wordt geaccepteerd als 0.30, maar `10.129` als getal wordt
geweigerd, niet stil afgerond). De opgeslagen waarde is altijd een
`Prisma.Decimal`-instantie, nooit een JS-float-roundtrip.

### 12. Standaard-eigenaar valt nooit stil terug op een inactieve gebruiker

`createOpportunity()` controleert nu ook de actieve status van de
klant-accountmanager wanneer die als standaard-eigenaar gebruikt zou
worden (geen expliciete `ownerUserId` meegegeven): actief → gebruik de
accountmanager; ontbrekend of inactief → val terug op de aanmaker. Dit was
oorspronkelijk gemist: alleen het expliciete-eigenaar-pad controleerde
actieve status; het standaardpad deed dat niet, waardoor een nieuwe
opportunity stilzwijgend aan een inmiddels gedeactiveerde accountmanager
kon worden toegewezen. De eigenaar mag daarna, net als bij aanmaak zonder
accountmanager, bewust afwijken van de klant-accountmanager (§10) — deze
regel gaat uitsluitend over de standaardwaarde bij aanmaak.

### 13. Shopify-gekoppelde externe links: server-side klantidentiteit-check

`addExternalLink()` verifieert nu, voor `SHOPIFY_ORDER`/
`SHOPIFY_DRAFT_ORDER`, dat de opgegeven `externalRef` daadwerkelijk bij de
Shopify-klant van de opportunity hoort — via de bestaande, al geharde
`getShopifyCustomerOrders()`/`getShopifyCustomerDraftOrders()`-adapters
(geen nieuwe Shopify-integratie, geen lokale kopie van het document, zie
§4). Dit was oorspronkelijk gemist: er was geen enkele controle, waardoor
een crafted API-verzoek (met bestaande schrijfrechten op een opportunity)
een order van klant B aan een opportunity van klant A kon koppelen — de
bestaande UI kon dit nooit veroorzaken (die biedt alleen al-voor-de-klant-
gefilterde kandidaten aan), maar de API zelf bood geen verdediging.

**Bekende, bewuste beperking**: dezelfde controle bestaat nog niet voor
`OFFERTEAPP_QUOTE`/`S4U_QUOTE_APP_QUOTE`. De benodigde identiteitsvelden
(`email`/`phone`/`shopifyCustomerGid`) staan al op `QuoteSummary`, maar de
enkele-offerte-opzoekfunctie (`fetchSingleQuote()` in
`src/integrations/quotes/adapter.ts`) is vandaag niet publiek — dit zou
een kleine, sibling-API-afhankelijke uitbreiding vergen. Bewust niet nu
gebouwd (buiten de scope van deze fix-ronde); een quote-link kan dus
vandaag nog zonder klantidentiteit-verificatie gelegd worden — dit is een
expliciet gedocumenteerde beperking, geen verborgen aanname en geen
beveiligingsgarantie die niet bestaat. Te sluiten in een latere ronde.

## Consequenties

- Eén nieuwe migratie, volledig additief: 2 nieuwe modellen
  (`Opportunity`, `OpportunityExternalLink`), 3 nieuwe enums
  (`OpportunityStage`, `OpportunityStatus`, `OpportunityLinkType`), 4 nieuwe
  optionele kolommen op bestaande modellen (`Task.opportunityId`,
  `Note.opportunityId`, `Appointment.opportunityId`, `File.opportunityId`),
  1 nieuwe optionele kolom op `Activity` (`relatedOpportunityId`), 5 nieuwe
  `ActivityType`-waarden. Geen bestaande rij verandert van waarde of type.
  Dit is en blijft de enige Phase 4A-migratie — de MUST-FIX-ronde (§9–§13)
  was uitsluitend servicelaag-logica, geen schemawijziging.
- `AuditAction`/`AuditEntityType` zijn TypeScript-only unions (geen
  databasekolom-enum) — nieuwe `opportunity.*`-waarden toevoegen vergt geen
  aparte migratie, alleen een typewijziging, exact zoals elke eerdere fase
  dit al deed.
- "Laatste contact" en "gerelateerde e-mails/gesprekken" op een opportunity
  zijn eerlijk beperkt tot wat werkelijk aan de opportunity gekoppeld kan
  worden (Control-Center-eigen taken/notities/afspraken) — telefoon/e-mail
  blijven, zoals nu, alleen op klantniveau gematcht (ADR-007), niet
  per-opportunity, omdat er geen enkel mechanisme bestaat (en dit ADR er
  geen invoert) om een binnenkomend telefoongesprek of e-mailbericht aan één
  specifieke opportunity van een klant met meerdere trajecten toe te wijzen.
  De UI moet dit onderscheid expliciet maken, nooit verhullen.
