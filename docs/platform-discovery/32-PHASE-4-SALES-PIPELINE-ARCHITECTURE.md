# 32 — Phase 4 Architecture: Sales Pipeline & Opportunities

**Status**: Architectuurvoorstel, geen implementatie. Zie
`31-PHASE-4-SALES-PIPELINE-DISCOVERY.md` voor de inventarisatie waarop dit
voortbouwt, `docs/architecture/ADR-009-OPPORTUNITY-PIPELINE-MODEL.md` voor de
onderliggende datamodel-/state-beslissingen, en
`33-PHASE-4A-BUILD-SPEC.md` voor de concrete eerste bouwfase.

## 1. Datamodel

### 1.1 `Opportunity` (nieuw model)

```
enum OpportunityStage {
  NIEUW
  CONTACT_GEHAD
  BEHOEFTE_BEPAALD
  OFFERTE_VOORBEREIDEN
  OFFERTE_UITGEBRACHT
  ONDERHANDELING
}

enum OpportunityStatus {
  OPEN
  WON
  LOST
}

model Opportunity {
  id                 String            @id @default(cuid())
  customerProfileId  String
  customerProfile    CustomerProfile   @relation(fields: [customerProfileId], references: [id])

  title              String
  description        String?           @db.Text

  stage              OpportunityStage  @default(NIEUW)
  status             OpportunityStatus @default(OPEN)

  estimatedValue     Decimal?          @db.Decimal(12, 2)
  finalValue         Decimal?          @db.Decimal(12, 2)
  probability        Int?              // 0–100, expliciete menselijke override; anders stage-default (§6)
  expectedCloseDate  DateTime?

  ownerUserId        String
  owner              User              @relation("OpportunityOwner", fields: [ownerUserId], references: [id])
  createdById        String
  createdBy          User              @relation("OpportunityCreatedBy", fields: [createdById], references: [id])

  wonAt              DateTime?
  lostAt             DateTime?
  lostReason         String?

  archivedAt         DateTime?

  createdAt          DateTime          @default(now())
  updatedAt          DateTime          @updatedAt

  tasks              Task[]
  notes              Note[]
  appointments       Appointment[]
  activities         Activity[]
  externalLinks      OpportunityExternalLink[]

  @@index([customerProfileId])
  @@index([ownerUserId])
  @@index([status, stage])
  @@index([expectedCloseDate])
}
```

**Waarom deze velden en niet klakkeloos de opdrachtvoorbeelden**: zie
ADR-009 §1 (stage/status-splitsing), §6 (geld), §7 (archiveren i.p.v.
verwijderen). `probability` en `finalValue` zijn bewust nullable — een net
aangemaakte opportunity heeft geen van beide totdat een mens ze zet of de
opportunity gewonnen wordt (§6, §13 hieronder).

**Niet toegevoegd** (onderzocht, expliciet afgewezen — zie ADR-009 §3):
`OpportunityProduct` (dupliceert Shopify/offerte-productdetail),
`OpportunityContact` (CustomerProfile zelf modelleert nog geen meerdere
contactpersonen — hoort daar thuis als het ooit nodig is, niet hier),
`OpportunityStage` als tabel (start als vaste enum, zie ADR-009 §2),
`OpportunityActivity` als apart model (de bestaande `Activity`-tabel met een
nieuwe optionele `relatedOpportunityId` doet dit al, zie §1.3).

### 1.2 `OpportunityExternalLink` (nieuw model)

```
enum OpportunityLinkType {
  OFFERTEAPP_QUOTE
  S4U_QUOTE_APP_QUOTE
  SHOPIFY_DRAFT_ORDER
  SHOPIFY_ORDER
}

model OpportunityExternalLink {
  id             String              @id @default(cuid())
  opportunityId  String
  opportunity    Opportunity         @relation(fields: [opportunityId], references: [id], onDelete: Cascade)

  linkType       OpportunityLinkType
  // Betekenis is linkType-afhankelijk (offerte-externalId of Shopify-GID) —
  // zelfde ontwerp als ExternalContactMatch.externalRef (ADR-007). Nooit de
  // externe data zelf, uitsluitend de verwijzing.
  externalRef    String

  linkedById     String
  linkedBy       User                @relation(fields: [linkedById], references: [id])
  linkedAt       DateTime            @default(now())
  unlinkedAt     DateTime?

  @@unique([opportunityId, linkType, externalRef])
  @@index([linkType, externalRef])
}
```

Altijd door een mens gelegd (`linkedById`) — nooit automatisch geschreven
(zie §6, automatisering blijft een suggestie, geen stille schrijfactie).
Soft-unlink (`unlinkedAt`), zelfde patroon als `ExternalContactMatch`.
`onDelete: Cascade` hier is veilig (in tegenstelling tot bij Opportunity
zelf) omdat een link-rij zonder betekenis is zodra de opportunity weg is —
en Opportunity zelf wordt sowieso nooit hard verwijderd (§13).

### 1.3 Additieve wijzigingen aan bestaande modellen

```
model Task {
  // ...bestaande velden ongewijzigd...
  opportunityId String?
  opportunity   Opportunity? @relation(fields: [opportunityId], references: [id])
}

model Note {
  // ...bestaande velden ongewijzigd...
  opportunityId String?
  opportunity   Opportunity? @relation(fields: [opportunityId], references: [id])
}

model Appointment {
  // ...bestaande velden ongewijzigd...
  opportunityId String?
  opportunity   Opportunity? @relation(fields: [opportunityId], references: [id])
}

model Activity {
  // ...bestaande velden ongewijzigd...
  relatedOpportunityId String?
  relatedOpportunity   Opportunity? @relation(fields: [relatedOpportunityId], references: [id])
}

enum ActivityType {
  // ...bestaande waarden ongewijzigd...
  OPPORTUNITY_CREATED
  OPPORTUNITY_STAGE_CHANGED
  OPPORTUNITY_WON
  OPPORTUNITY_LOST
  OPPORTUNITY_REOPENED
}
```

`relatedOpportunityId` op `Activity` is het vijfde `related*Id`-veld naast
`relatedNoteId`/`relatedTaskId`/`relatedFileId`/`relatedAppointmentId` —
zelfde herhaalde, al gevestigde patroon, geen nieuw concept.

## 2. Pipeline-fases

Zes actieve fases (§1.1). Dit volgt het voorbeeld uit de opdracht op één
punt na: **"Gewonnen" en "Verloren" zijn geen fase-waarden**, maar
`status`-waarden (ADR-009 §1) — een gesloten deal bevriest op zijn laatste
actieve fase, wat zelf waardevolle informatie is voor rapportage (§18: "in
welke fase gaan de meeste deals verloren").

**Onderscheid met bestaande statusvelden** (expliciet gecontroleerd, zoals
gevraagd): `stage` is nooit gelijk aan of afgeleid van Shopify-orderstatus
(`OPEN/INVOICE_SENT/COMPLETED` bij draft orders), offertestatus (eigen veld
per offerte-app), of `TaskStatus`. Een opportunity kan bijvoorbeeld in
`OFFERTE_UITGEBRACHT` staan terwijl de gekoppelde offerte zelf nog
`OPEN` is bij OfferteApp — dat zijn twee onafhankelijke statussen die
toevallig gelijktijdig bestaan, nooit gesynchroniseerd.

**Configureerbaarheid**: start als vaste enum (ADR-009 §2). Geen
per-productlijn of per-team aanpasbare fases in Phase 4A/4B — als de vaste
lijst in de praktijk niet past, is dat een expliciete, apart te plannen
Phase 4C-migratie (enum → tabel), niet iets om nu preventief te bouwen.

## 3. Status/stage-semantiek

Samengevat (volledige onderbouwing in ADR-009 §1):

| Actie | Effect op `status` | Effect op `stage` | Effect op `wonAt`/`lostAt`/`lostReason` |
|---|---|---|---|
| Fase wijzigen (Nieuw…Onderhandeling) | ongewijzigd (`OPEN`) | nieuwe waarde | ongewijzigd |
| `markWon()` | → `WON` | bevriest | `wonAt` = nu |
| `markLost(reason)` | → `LOST` | bevriest | `lostAt` = nu, `lostReason` gezet |
| `reopen()` | → `OPEN` | ongewijzigd (blijft op bevroren waarde — een heropende deal gaat niet terug naar "Nieuw") | `lostReason` gewist; `wonAt`/`lostAt` blijven staan als historisch record (zelfde "sticky timestamp"-precedent als `Task.completedAt` in `updateTaskStatus()`, dat ook niet wist bij een latere statuswijziging) |

Een fase-wijziging is alleen toegestaan wanneer `status = OPEN` — de
service-laag weigert een stage-PATCH op een gewonnen/verloren opportunity
(moet eerst `reopen()`).

## 4. Task-relatie

`Task.opportunityId` (optioneel). Regel (ADR-009 §5): wanneer
`opportunityId` gezet wordt, leidt de servicelaag `customerProfileId` af
van de opportunity in plaats van een apart meegegeven waarde te
vertrouwen — een taak kan dus:

- alleen klantgebonden zijn (`customerProfileId` gezet, `opportunityId`
  leeg) — ongewijzigd bestaand gedrag;
- opportunity-gebonden zijn (`opportunityId` gezet — `customerProfileId`
  wordt automatisch die van de opportunity, nooit onafhankelijk
  instelbaar zodra `opportunityId` gezet is);
- volledig ongebonden zijn (beide leeg) — ongewijzigd bestaand gedrag.

Dezelfde regel geldt voor `Note.opportunityId` en
`Appointment.opportunityId`.

## 5. Externe quote/order-relaties

Zoals ADR-009 §4 vastlegt: `OpportunityExternalLink`, nooit een kopie van
het externe document. Een mens legt de link (bijvoorbeeld vanuit de
Commercieel-tab: "koppel deze offerte aan opportunity X"), nooit een
automatisch proces. Weergave van gekoppelde offertes/orders op de
opportunity-detailpagina haalt de actuele data live op via de bestaande
adapters (`createQuotesAdapter().fetchSingleQuote()`-achtig,
Shopify-order-GID via de bestaande `orders.ts`/`draft-orders.ts`) — nooit
een tweede opslag van bedrag/status.

## 6. Automatisering zonder magie

Strikt onderscheid tussen (A) afgeleide informatie — puur weergave, nooit
een schrijfactie — en (B) expliciete menselijke beslissing:

| Signaal | Type | Gedrag |
|---|---|---|
| Offerte gekoppeld → suggestie "Zet fase op Offerte uitgebracht?" | B | Banner met één klik, wijzigt niets zonder bevestiging |
| `ShopifyDraftOrderSummary.completedOrder` wordt niet-null voor een gekoppelde conceptbestelling → suggestie "Markeer als Gewonnen?" | B | Zelfde — hergebruikt een al bestaand, ongebruikt Shopify-veld (§31 tabel), geen nieuwe integratie nodig |
| Opportunity zonder Control-Center-eigen activiteit (taak/notitie/afspraak) in 7 dagen, status=OPEN | A | Badge "Opvolging nodig" — puur berekend, zie §17 |
| `expectedCloseDate` verstreken, status=OPEN | A | Badge "Verwachte sluitdatum verstreken" |
| Gekoppelde open taak met `dueAt` in het verleden | A | Badge, zichtbaar op de opportunity-kaart (hergebruikt bestaande `Task.dueAt`) |
| Nieuwe e-mail/call van de klant | A | Getoond als "laatste klantcontact" op klantniveau (niet opportunity-niveau — zie §9 beperking) |

Nooit: een automatische `stage`- of `status`-wijziging zonder menselijke
bevestiging. Categorie B-signalen zijn altijd een banner/knop, nooit een
achtergrondschrijving.

## 7. Pipeline UI — `/opportunities`

Nieuw, top-level route, nieuw item in de bestaande "Sales"-sectie van
`src/components/layout/nav-config.ts` (naast de al gereserveerde, nog
steeds `comingSoon` blijvende `Offertes`/`Orders`-items — dit zijn
afzonderlijke, gefedereerde documentoverzichten, geen opportunities, en
worden door Phase 4 niet aangeraakt).

**Kanban** (standaardweergave): kolommen = de zes actieve fases +
"Gewonnen"/"Verloren" als apart, samengevouwen einde (geen actieve
sleepdoelen, alleen ter referentie/filter). Kaarten tonen compact: klant,
titel, waarde, eigenaar, volgende actie (eerstvolgende open taak met
`dueAt`, indien aanwezig), ouderdom/laatste contact, verwachte sluitdatum.

**Lijstweergave**: sorteerbare tabel, dezelfde kolommen, voor gebruikers
die liever scannen dan slepen.

**Filters**: eigenaar, fase, status (open/gewonnen/verloren/alle),
"opvolging nodig", zoekterm (titel/klantnaam).

**Drag-and-drop**: aanbevolen, maar uitsluitend als een UI-laag bovenop
dezelfde, al geauditeerde `changeOpportunityStage()`-servicefunctie die een
handmatige dropdown ook zou aanroepen — geen apart, ongeauditeerd
schrijfpad. Zolang dat gegarandeerd is, is drag-and-drop even veilig als de
dropdown en dus toegestaan (zie §33 voor of dit in 4A of 4B landt).

## 8. Opportunity-detail — `/opportunities/[id]`

**Header**: titel, klant (link naar Customer 360), fase, waarde, kans,
eigenaar, verwachte sluitdatum.

**Quick actions**: taak maken, notitie, afspraak (alle drie vooraf
ingevuld met `opportunityId` + afgeleide `customerProfileId`), klant
openen, fase wijzigen, gewonnen/verloren markeren.

**Content — maximaal hergebruik van Customer 360-componenten**, niet een
tweede los systeem (expliciete instructie §8/§9):

| Sectie | Component (hergebruikt, evt. met een `opportunityId`-filterprop) |
|---|---|
| Gekoppelde offertes/orders | `QuotesTable`/`DraftOrdersTable`/`OrdersTable`, gefilterd op `OpportunityExternalLink` |
| Taken | `TasksPanel`, gefilterd op `opportunityId` i.p.v. alleen `customerProfileId` |
| Notities | `NotesPanel`, idem |
| Afspraken | `AppointmentsPanel`, idem |
| Timeline | `ActivityTimelineView`, gefilterd op `relatedOpportunityId` (Control-Center-eigen gebeurtenissen) |
| Recente gesprekken/e-mails | `RecentCallsBlock`/`RecentEmailsBlock`, **ongefilterd op klantniveau** — met een zichtbare toelichting dat dit alle contact met de klant toont, niet uitsluitend dit traject (zie beperking §9) |

Geen enkel van deze zes componenten wordt herschreven — ze krijgen op zijn
hoogst een optionele filterprop.

## 9. Customer 360-integratie

Geen nieuwe top-level tab (expliciete instructie). In plaats daarvan:

- **Commercieel-tab**: nieuwe sectie "Opportunities" naast de bestaande
  Bestellingen/Conceptbestellingen/Offertes-secties — dezelfde tab, één
  sectie erbij.
- **Overzicht-tab**: nieuw compact blok "Open opportunities" (zelfde
  visuele patroon als het bestaande `RecentCallsBlock`/`RecentEmailsBlock`)
  — toont elke open opportunity van de klant afzonderlijk (nooit
  samengevouwen tot één regel), zodat een klant met meerdere gelijktijdige
  trajecten expliciet leesbaar blijft (businessdoel).
- **CustomerHeader**: klein badge "N open opportunities · €X" wanneer
  N > 0.

**Eerlijke beperking, expliciet zichtbaar in de UI**: gesprekken en e-mails
worden matched op klantniveau (ADR-007), niet op opportunity-niveau — er
bestaat geen mechanisme om een binnenkomend telefoongesprek of
e-mailbericht aan één specifieke opportunity van een klant met meerdere
trajecten toe te wijzen. De opportunity-detailpagina toont daarom expliciet
"recent klantcontact" (klantbreed), nooit een foutief gesuggereerde
opportunity-specifieke gespreksgeschiedenis.

## 10. Dashboard

Nieuwe sectie (Phase 4B, zie §20) op `src/app/(app)/page.tsx`:

- Open pipeline-waarde (`SUM(estimatedValue) WHERE status=OPEN`)
- Gewogen pipeline-waarde (`SUM(estimatedValue × effectieve kans)`,
  effectieve kans = expliciete `probability` ?? fase-standaard, zie §6/§14)
- Opportunities per fase (kleine lijst/staafjes, `status=OPEN` gegroepeerd
  op `stage`)
- Opvolging-nodig-telling (§17)
- Verwachte sluitingen komende 30 dagen (`expectedCloseDate` binnen bereik,
  `status=OPEN`)
- Recent gewonnen/verloren (laatste N, met datum en waarde)

Alle zes zijn simpele `aggregate`/`groupBy`/`count`-query's — geen
BI-laag, geen nieuwe afhankelijkheid.

## 11. Task-integratie (herhaling van §4, expliciet t.b.v. rapportagevolgorde)

Zie §4 hierboven — dit is dezelfde regel, hier herhaald omdat de opdracht
er een apart genummerd punt van maakt.

## 12. Owner/accountmanager

`Opportunity.ownerUserId` is onafhankelijk van
`CustomerProfile.accountManagerId` — een opportunity-eigenaar kan afwijken
van de vaste klant-accountmanager (bijvoorbeeld een specialist die één
traject trekt). Bij aanmaak wordt `ownerUserId` **standaard** gevuld met
`CustomerProfile.accountManagerId` indien gezet, anders de aanmakende
gebruiker — maar altijd expliciet wijzigbaar, nooit gedwongen gelijk.

**Reassignment**: elke wijziging van `ownerUserId` is een gewone
service-actie (zelfde autorisatie als hieronder), maar krijgt altijd zijn
eigen auditregel (`opportunity.owner_changed`, met oude/nieuwe eigenaar in
`metadata`) — eigenaarschap heeft directe verantwoordelijkheids-
implicaties, dus wordt nooit stilzwijgend meegenomen in een generieke
"opportunity bijgewerkt"-audit.

**RBAC**: `VIEWER` kan nooit muteren (overal, zonder uitzondering — zelfde
centrale `requireWriteAccess()` als de rest van de app). Voor
`AGENT`/`ADMIN`: elke `AGENT`/`ADMIN` mag een opportunity aanmaken; alleen
de eigenaar, de aanmaker, of een `ADMIN` mag hem wijzigen — exact dezelfde
vorm als `Task`'s bestaande `assertCanModify()` (hergebruik van het
patroon, niet van de code zelf, want de functie is Task-getypeerd).

## 13. Won/Lost

**Gewonnen** (`markWon`): wie — de aanroepende actor (audit); wanneer —
`wonAt = nu`; optioneel een gekoppelde Shopify-order (via
`OpportunityExternalLink`, `linkType = SHOPIFY_ORDER` — een mens bevestigt
dit, vaak vanuit de in §6 beschreven suggestiebanner); `finalValue` —
optioneel, standaard leeg, door een mens in te vullen of automatisch
voorgesteld vanuit het bedrag van de gekoppelde order indien die gekoppeld
wordt. Rapportage gebruikt `finalValue ?? estimatedValue` (§18) — expliciet
gedocumenteerd omdat niet elke gewonnen deal een `finalValue` zal hebben
(een deal zonder gekoppelde order/handmatige invoer heeft alleen de
schatting).

**Verloren** (`markLost`): verplichte `lostReason` (kort, vrij tekstveld —
geen vaste enum, want de opdracht vraagt geen gestructureerde
redenenlijst en een premature enum zou een aanname doen over redenen die
nog niet bekend zijn); optionele uitgebreide toelichting hergebruikt de
**bestaande Note-functionaliteit** (een gekoppelde notitie via
`opportunityId`) in plaats van een tweede tekstveld — vermijdt duplicatie
van opslagmechanismen voor vrije tekst. Concurrent-veld: bewust niet
toegevoegd nu (opdracht noemt dit expliciet "niet noodzakelijk nu") — een
mogelijke Phase 4C-uitbreiding.

**Nooit verwijderd** bij verlies — zie §15/ADR-009 §7.

## 14. Geld

Zie ADR-009 §6 voor de volledige onderbouwing: `Decimal @db.Decimal(12,2)`,
geen `currency`-kolom (impliciet EUR), hergebruik van
`formatMoney({amount, currencyCode})` uit `src/lib/format.ts` voor
weergave.

**Fase-standaardkansen** (voor gewogen pipeline-waarde wanneer
`probability` niet expliciet gezet is — categorie A, puur weergave, nooit
opgeslagen als de daadwerkelijke waarde):

| Fase | Standaardkans |
|---|---|
| Nieuw | 10% |
| Contact gehad | 20% |
| Behoefte bepaald | 35% |
| Offerte voorbereiden | 45% |
| Offerte uitgebracht | 60% |
| Onderhandeling | 75% |

Zodra een mens een expliciete `probability` invult, wint die altijd van de
fase-standaard (categorie B overschrijft categorie A) — precies het
onderscheid dat §6 van de opdracht vraagt.

## 15. Audit & security

Zie ADR-009 §7 voor de argumentatie tegen hard delete. Audit-acties (nieuwe
`AuditAction`-waarden, TS-only, geen migratie):

- `opportunity.created`
- `opportunity.stage_changed`
- `opportunity.owner_changed`
- `opportunity.value_changed`
- `opportunity.won`
- `opportunity.lost`
- `opportunity.reopened`
- `opportunity.archived`
- `opportunity.external_link_added`
- `opportunity.external_link_removed`

Nieuwe `AuditEntityType`-waarden: `Opportunity`, `OpportunityExternalLink`.

Geen delete-endpoint bestaat — archiveren (`archivedAt`) is de enige
manier om een opportunity uit actieve weergaven te laten verdwijnen, exact
zoals `Note.deletedAt` en `ExternalContactMatch.unlinkedAt` dat al doen.

## 16. Command palette

Nieuwe groep `opportunities` in `/api/search` (`src/app/api/search/
route.ts`), zoekend op `Opportunity.title` (bevat, ongevoelig voor
hoofdletters) + gekoppelde klantnaam, in dezelfde stijl als de bestaande
`orders`/`quotes`-groepen (eigen try/catch, faalt nooit de rest van de
palette). Puur additief — de bestaande vier groepen (customers, tasks,
orders, quotes) blijven ongewijzigd, geen regressierisico.

## 17. Stale/follow-up-engine

Geen achtergrondproces (ADR-009 §8). Eerste, eenvoudige versie, volledig
on-the-fly berekend bij het opvragen van een lijst/detail:

```
needsFollowUp(opportunity) =
  status == OPEN AND (
    (geen Control-Center-eigen activiteit gekoppeld aan deze opportunity
     in de laatste 7 dagen) AND (opportunity ouder dan 7 dagen)
    OR (een gekoppelde open taak heeft dueAt in het verleden)
    OR (expectedCloseDate is gezet en ligt in het verleden)
  )
```

Berekend per rij bij het laden van de kanban/lijst — bij de verwachte
schaal (tientallen tot enkele honderden open opportunities) is dit
triviaal goedkoop; een gecachete/bijgehouden kolom is niet nodig totdat het
tegendeel blijkt.

## 18. Rapportage

| Metric | Berekening | Betrouwbaarheid |
|---|---|---|
| Gewonnen waarde per maand | `SUM(finalValue ?? estimatedValue) WHERE status=WON GROUP BY MONTH(wonAt)` | Betrouwbaar, met de expliciete kanttekening dat niet elke rij een `finalValue` heeft |
| Verloren waarde | `SUM(estimatedValue) WHERE status=LOST GROUP BY MONTH(lostAt)` | Betrouwbaar — `estimatedValue` is het enige ooit bekende bedrag voor een verloren deal |
| Win rate | `COUNT(WON) / COUNT(WON+LOST)` over een periode | Betrouwbaar als aantal-gebaseerde metric; een waarde-gewogen win rate wordt bewust niet als primaire metric getoond (vooraf geschatte waarde is inherent onzeker) |
| Gemiddelde doorlooptijd | `AVG(closedAt - createdAt)` voor gesloten opportunities | Betrouwbaar, simpele datumrekenkunde |
| Pipeline value | `SUM(estimatedValue) WHERE status=OPEN` | Betrouwbaar als schatting — expliciet als "geschat" gelabeld in de UI, geen garantie |
| Gewogen pipeline | `SUM(estimatedValue × effectieve kans)` | Heuristiek, expliciet als zodanig gelabeld |

**Bekende beperking, niet verzwegen**: Phase 4 start zonder historische
opportunity-data — er bestaat nergens in het landschap een eerder
bijgehouden "verkooptraject"-geschiedenis om terug te vullen (offertes zijn
documenten, geen trajecten, zie §31 §2). Rapportage is dus vanaf de
lanceringsdatum zinvol, niet met terugwerkende kracht.

Geen uitgebreide analytics-engine — alle bovenstaande zijn directe
Prisma-`aggregate`/`groupBy`-query's.

## 19. Migration safety

Zie ADR-009 "Consequenties" voor de volledige lijst. Samengevat: 2 nieuwe
modellen, 3 nieuwe enums, 4 nieuwe optionele kolommen op bestaande
modellen (`Task`/`Note`/`Appointment`.`opportunityId`,
`Activity.relatedOpportunityId`), 5 nieuwe `ActivityType`-waarden. Geen
bestaande rij verandert van waarde of type — zelfde risicoklasse als elke
eerdere fase-migratie in dit project (allemaal additief bevestigd vóór
productie-uitrol).

## 20. Scopefasering

**Phase 4A — fundament** (zie `33-PHASE-4A-BUILD-SPEC.md` voor het
volledige detail): `Opportunity` + `OpportunityExternalLink`-modellen en
enums, optionele FK's op Task/Note/Appointment/Activity, kernservice
(aanmaken/bewerken/fase wijzigen/winnen/verliezen/heropenen/archiveren),
RBAC + audit, minimale `/opportunities`-kanban+lijst, minimale
`/opportunities/[id]`-detail (hergebruik van bestaande panelen),
Customer 360 Commercieel-sectie + Overzicht-blok, command-palette-groep.
**Geen** dashboardwidgets, **geen** automatiserings-suggestiebanners,
**geen** drag-and-drop nog — handmatige acties eerst, bewezen correct en
geauditeerd, vóór er UI-gemak bovenop komt.

**Phase 4B — koppelingen/automatisering/dashboard/rapportage**:
dashboard-pipelinesectie (§10), afgeleide signalen (§6/§17 badges,
suggestiebanners), rapportagesectie (§18), drag-and-drop-kanban
(bovenop dezelfde geauditeerde servicefunctie, §7).

**Phase 4C — optioneel, alleen bij aangetoonde noodzaak**: configureerbare
pipeline-fases (enum → tabel-migratie), concurrent-veld op verloren
deals, contactpersonen per opportunity of op `CustomerProfile`-niveau,
diepere sales intelligence.

## 21. Out of scope — bevestigd

Zoals in §31 §4 al vastgesteld: niets in dit ontwerp raakt Microsoft 365,
marketing automation, nieuwsbrieven, AI lead scoring, AI-e-mails,
voorraadplanning, ERP, financiële administratie, SMTP-verzending,
PBX-wijzigingen, of herschrijving van sibling-apps.
