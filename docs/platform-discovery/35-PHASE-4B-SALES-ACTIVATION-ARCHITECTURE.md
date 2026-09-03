# 35 — Phase 4B Architecture: Sales Follow-up, Dashboard & Automation

**Status**: Architectuurvoorstel, geen implementatie. Vervolg op
`34-PHASE-4B-SALES-ACTIVATION-DISCOVERY.md`. Geen nieuwe ADR — zie §0 voor
waarom.

## 0. Waarom geen nieuwe ADR

Phase 4B introduceert geen nieuwe entiteit, geen nieuwe state machine, geen
nieuwe persistente relatie — alles hieronder is afgeleide berekening
(service-/UI-laag) bovenop het door ADR-009 al vastgelegde Opportunity-
model. Er is geen punt waarop een toekomstige ontwikkelaar een
architecturale keuze zou missen die niet al in ADR-009 staat of in dit
document expliciet wordt vastgelegd (met name §5 "geen cache" is zelf al
een expliciete, beargumenteerde keuze — maar bevestigt een al bestaand
principe uit ADR-004/008, het introduceert er geen nieuw).

## 1. Attention engine — `deriveOpportunityAttention()`

Bouwt voort op de bestaande `attachFollowUpFlags()` (§34 §1.2). Voorstel:
een **pure functie**, geen eigen queries — alle benodigde data wordt al
door de aanroeper (`listOpportunities()`, `getOpportunityDetail()`)
opgehaald.

```ts
type AttentionSeverity = "RED" | "ORANGE" | "BLUE";

type AttentionSignal = {
  code:
    | "OVERDUE_TASK"
    | "CLOSE_DATE_PASSED"
    | "STALE"
    | "NO_NEXT_ACTION"
    | "SHOPIFY_ORDER_PLACED"
    | "QUOTE_AHEAD_OF_STAGE";
  severity: AttentionSeverity;
  label: string; // Nederlandse UI-tekst
};

type OpportunityAttention = {
  signals: AttentionSignal[];
  highestSeverity: AttentionSeverity | null; // null = niets te melden
};

function deriveOpportunityAttention(input: {
  status: OpportunityStatus;
  stage: OpportunityStage;
  expectedCloseDate: Date | null;
  createdAt: Date;
  nextOpenTask: { dueAt: Date | null } | null;
  lastActivityAt: Date | null; // al gebatcht opgehaald, zie §1.2 discovery
  shopifyOrderPlacedSignal: boolean; // §6, alleen op detailpagina beschikbaar
  quoteAheadOfStageSignal: boolean; // §7, alleen op detailpagina beschikbaar
}): OpportunityAttention
```

**A/B/C-indeling uit de opdracht → RED/ORANGE/BLUE uit sectie 16** (één
consistent model, geen twee parallelle categorieën):

| Categorie (opdracht §2) | Severity (opdracht §16) | Signalen |
|---|---|---|
| A. Waarschuwing | **RED** | `OVERDUE_TASK`, `CLOSE_DATE_PASSED` |
| B. Informatie | **ORANGE** | `STALE` (per-fase drempel, §2 hieronder), `NO_NEXT_ACTION` |
| C. Commerciële suggestie | **BLUE** | `SHOPIFY_ORDER_PLACED`, `QUOTE_AHEAD_OF_STAGE` |

Alleen `status=OPEN`, niet-gearchiveerde opportunities krijgen signalen —
gesloten/gearchiveerde opportunities hebben altijd `highestSeverity: null`
(geen "opvolging nodig" op iets dat al afgehandeld is).

**Geen enkele schrijfactie** in deze functie — puur berekenen, exact zoals
`attachFollowUpFlags()` dat vandaag al doet.

## 2. Stale-regels — per fase, als constanten

```ts
// src/modules/opportunities/labels.ts (of een nieuw labels-achtig bestand)
export const STAGE_STALE_THRESHOLD_DAYS: Record<OpportunityStage, number> = {
  NEW: 3,
  CONTACTED: 5,
  NEEDS_DEFINED: 7,
  QUOTE_PREPARATION: 3,
  QUOTE_SENT: 7,   // afwijking t.o.v. opdracht-voorbeeld — zie onderbouwing
  NEGOTIATION: 7,  // afwijking t.o.v. opdracht-voorbeeld — zie onderbouwing
};
```

**Analyse, niet klakkeloos overgenomen**: de opdracht stelt 5 dagen voor
`QUOTE_SENT`/`NEGOTIATION`. Voor Stones4U (natuursteen/tuinprojecten,
orders in de duizenden tot tienduizenden euro's, zie het businessvoorbeeld
"Terras + zwembadproject — €18.500") is de beslistijd bij de **klant** in
deze late fases typisch langer dan bij bijvoorbeeld een SaaS-sales-cyclus:
een klant die een offerte van €18.500 heeft ontvangen, overlegt vaak
dagenlang thuis of met een partner voordat hij reageert. Een 5-dagen-
drempel zou dat structureel als "stale" markeren, wat tot alert-fatigue
leidt (de melding wordt genegeerd omdat hij te vaak "onterecht" afgaat).
**Aanbeveling: 7 dagen** voor beide late fases — nog steeds een nuttige
nudge, maar niet voorbarig. De vroege fases (`NEW`/`CONTACTED`/
`NEEDS_DEFINED`/`QUOTE_PREPARATION`) behouden de voorgestelde waarden
ongewijzigd — daar gaat het om *interne* voortgang (heeft iemand actie
ondernomen), waar een kortere drempel wél zin heeft. Dit is een
voorstel, geen onwrikbare keuze — als config-constante (geen rules-engine,
geen databasekolom) is dit bij een volgende fase net zo makkelijk aan te
passen als de oorspronkelijke voorstelwaarden.

**Welke "recency"-maat per fase-groep** (rechtstreeks uit de eigen
formulering van de opdracht af te leiden — sectie 4 zegt voor de vroege
fases "na X dagen **zonder actie**", voor de late fases expliciet "na X
dagen **zonder klantcontact**"):

- `NEW`/`CONTACTED`/`NEEDS_DEFINED`/`QUOTE_PREPARATION`: gebruikt
  **"laatste activiteit"** (breed, Control-Center-eigen, al gebatcht via
  `Activity.groupBy` — §34 §1.2) — interne voortgang telt hier terecht mee.
- `QUOTE_SENT`/`NEGOTIATION`: zou idealiter **"laatste klantcontact"**
  gebruiken (call/e-mail/afspraak) — maar zie §5 hieronder voor de
  performance-afweging waarom de pipeline/dashboard-weergave hier bewust
  een benaderde meting gebruikt in plaats van live externe data per kaart.

## 3. "Laatste klantcontact" vs. "laatste activiteit" — twee aparte waarden

| | "Laatste klantcontact" | "Laatste activiteit" |
|---|---|---|
| Betekenis | Echte communicatie: call, e-mail, afspraak | Bredere CRM-activiteit: alles hierboven + taken, notities, bestanden, fasewijzigingen |
| Bron | Telefonie-adapter (klantniveau) + e-mail-adapter (klantniveau) + `Appointment` (opportunity- of klantniveau) | `Activity`-rijen met `relatedOpportunityId` (al bestaand mechanisme) |
| Schaal | **Klantniveau** — een klant met meerdere opportunities heeft één gedeelde waarde | **Opportunity-niveau** — al specifiek per opportunity |
| Waar beschikbaar | Alleen waar al live opgehaald: detailpagina, Customer 360 | Overal — al gebatcht op pipeline/dashboard-niveau |
| UI-tekst | **"Laatste klantcontact voor deze klant"** — nooit gesuggereerd als opportunity-specifiek | "Laatste activiteit op deze verkoopkans" |

Notities en taakvoltooiing tellen bewust **niet** mee als "klantcontact" —
een notitie is een intern record, geen communicatie mét de klant (ook al
kan een notitie een telefoongesprek *beschrijven* — dat gesprek zelf is
dan al apart zichtbaar via de call-adapter). Offerte-aanmaak/order-plaatsing
zijn eigen signalen (§6/§7), geen onderdeel van "contact".

**Eerlijkheid in de UI, letterlijk uit de opdracht overgenomen**: nooit
suggereren dat een getoond gesprek/e-mailbericht bewezen bij déze specifieke
opportunity hoort wanneer een klant meerdere opportunities heeft — exact
het patroon dat de opportunity-detailpagina in Phase 4A al hanteert voor
"Klantcommunicatie" (ongewijzigd, wordt in 4B niet anders).

## 4. Stale-drempels toegepast — samenvatting

Zie §2 voor de tabel en §5 voor de performance-afweging die bepaalt welke
recency-maat de PIJPLIJN-weergave (in tegenstelling tot de detailpagina)
daadwerkelijk gebruikt.

## 5. Next action — hergebruik van `Task`, geen nieuw veld

```ts
type NextActionState = "OVERDUE" | "TODAY" | "UPCOMING" | "UNSCHEDULED" | "NONE";

function deriveNextAction(nextOpenTask: { title: string; dueAt: Date | null } | null): {
  state: NextActionState;
  task: { title: string; dueAt: Date | null } | null;
} {
  if (!nextOpenTask) return { state: "NONE", task: null };
  if (!nextOpenTask.dueAt) return { state: "UNSCHEDULED", task: nextOpenTask };
  const now = new Date();
  if (nextOpenTask.dueAt < startOfToday(now)) return { state: "OVERDUE", task: nextOpenTask };
  if (isSameDay(nextOpenTask.dueAt, now)) return { state: "TODAY", task: nextOpenTask };
  return { state: "UPCOMING", task: nextOpenTask };
}
```

Input is exact de al bestaande `tasks`-include (`take:1, orderBy: dueAt
asc, where: status open`) uit `listOpportunities()` — **geen nieuwe
query**. `Task` blijft de enige bron van waarheid; geen `nextAction`-veld
op `Opportunity`. Zonder open taak: "Geen volgende actie gepland" —
letterlijk zoals de opdracht vraagt.

## 6. Shopify completed-order-signaal

**Volledig bouwbaar zonder nieuwe Shopify-aanroepen** — de detailpagina
haalt `draftOrders` (met `completedOrder`) en `orders` (met
`currentTotalPriceSet`) al op (§34 §1.3).

Regel: voor elke actieve (`unlinkedAt=null`) `OpportunityExternalLink` met
`linkType=SHOPIFY_DRAFT_ORDER` op een **OPEN** opportunity: zoek de
bijbehorende draft order in de al opgehaalde `draftOrders`-array
(`gid` match). Als `draftOrder.completedOrder !== null`: toon een banner
"Bestelling {completedOrder.name} geplaatst — markeer als gewonnen?".

**Betrouwbare orderwaarde**: zoek `completedOrder.gid` op in de al
opgehaalde `orders`-array → `order.currentTotalPriceSet` (bedrag +
`currencyCode`, altijd EUR in deze winkel). Dit is de **echte, actuele
Shopify-orderwaarde**, betrouwbaarder dan de oorspronkelijke schatting.

**Bevestiging, geen automatisme**: de banner heeft een knop die het
bestaande `markWon()`-dialoogvenster opent (`OpportunityActions.tsx`,
al aanwezig) met `finalValue` **voorgesteld** (niet blind ingevuld/
opgeslagen) op basis van de gevonden orderwaarde — de gebruiker ziet het
voorgestelde bedrag, kan het aanpassen, en moet expliciet op "Bevestigen"
klikken. Zonder bevestiging gebeurt er niets. Dit gaat via de **bestaande**
`markWon()`-servicefunctie — geen nieuwe mutatie-code.

## 7. Quote-signalen

Beschikbaar zonder nieuwe sibling-API's: de detailpagina haalt `quotes`
(`QuoteSummary[]`, met `status`, `createdAt`, `shopifyDraftOrderGid`) al op
voor de bestaande `OpportunityCommercialLinks`-kandidatenlijst.

Voorstel, uitsluitend als banner, nooit als automatische fasewijziging:
als de klant minstens één offerte heeft (`quotes.length > 0`) EN de
opportunity's fase is nog vroeg (`NEW`/`CONTACTED`/`NEEDS_DEFINED`) EN er
is nog geen actieve quote-`OpportunityExternalLink` op deze opportunity →
"Offerte aanwezig — fase staat nog op {STAGE_LABEL[stage]}. Koppelen?"
Puur informatief/suggestief — de gebruiker kiest zelf of hij de offerte
koppelt (bestaande `addExternalLink()`-flow) en of hij de fase handmatig
aanpast (bestaande `changeStage()`-flow). Laagste prioriteit van de zes
4B-onderdelen — nice-to-have, niet kritiek voor "READY TO BUILD".

## 8. Dashboard — nieuwe Sales-sectie

Nieuwe sectie op `src/app/(app)/page.tsx`, naast de bestaande Taken/
Afspraken/Activiteit-secties:

- Open pipeline-waarde
- Gewogen pipeline-waarde
- Opportunities die aandacht nodig hebben (telling + link naar
  `/opportunities?attention=true` of vergelijkbaar filter)
- Verwachte sluitingen komende 30 dagen (telling + korte lijst)
- Recent gewonnen (laatste N, deze maand)
- Recent verloren (laatste N, deze maand)

Zie §14 voor filters (owner/stage/periode) en §9 voor de exacte
metric-query's.

## 9. Decimal-aggregatie — exacte querysemantiek

**Belangrijk uitgangspunt**: native Postgres/Prisma `SUM` waar mogelijk
(geen enkele JS-`Number`-optelling van geldbedragen), `Prisma.Decimal`-
rekenkunde waar een berekening niet puur in SQL kan (de gewogen pijplijn,
omdat de fase-standaardkans alleen in TypeScript bestaat, nooit in de
database).

```ts
// Open pipeline-waarde — pure Postgres SUM, geen JS-optelling.
const openPipeline = await prisma.opportunity.aggregate({
  where: { status: "OPEN", archivedAt: null },
  _sum: { estimatedValue: true },
}); // .._sum.estimatedValue is Decimal | null

// Opportunities per fase — telling, geen geldbedrag, geen Decimal-risico.
const perStage = await prisma.opportunity.groupBy({
  by: ["stage"],
  where: { status: "OPEN", archivedAt: null },
  _count: true,
});

// Gewogen pipeline-waarde — de fase-standaardkans bestaat alleen in TS
// (labels.ts), dus dit KAN niet puur in SQL. Haalt alleen de 3 benodigde
// kolommen op (geen volledige rijen) voor alle open, niet-gearchiveerde
// opportunities, en telt op met Prisma.Decimal — nooit Number().
const openForWeighting = await prisma.opportunity.findMany({
  where: { status: "OPEN", archivedAt: null },
  select: { estimatedValue: true, probability: true, stage: true },
});
const weighted = openForWeighting.reduce((sum, o) => {
  if (!o.estimatedValue) return sum;
  const probability = o.probability ?? STAGE_DEFAULT_PROBABILITY[o.stage];
  return sum.plus(o.estimatedValue.times(probability).dividedBy(100));
}, new Prisma.Decimal(0));

// Gewonnen waarde deze maand — status is de canonical-state-autoriteit
// (ADR-009), wonAt is uitsluitend gevuld wanneer status=WON (Phase 4A
// MUST-FIX §1) — dus filteren op status ÉN wonAt is hier redundant-veilig,
// niet ambigu. finalValue kan null zijn (zeldzame rand-case: nooit een
// bedrag ingevuld) — zo'n rij draagt dan 0 bij, gedocumenteerde beperking,
// geen bug.
const wonThisMonth = await prisma.opportunity.aggregate({
  where: { status: "WON", wonAt: { gte: startOfMonth, lt: startOfNextMonth } },
  _sum: { finalValue: true },
});

// Verloren waarde deze maand — estimatedValue is het enige ooit bekende
// bedrag voor een verloren deal.
const lostThisMonth = await prisma.opportunity.aggregate({
  where: { status: "LOST", lostAt: { gte: startOfMonth, lt: startOfNextMonth } },
  _sum: { estimatedValue: true },
});

// Win rate — telling, geen geldbedrag.
const [wonCount, lostCount] = await Promise.all([
  prisma.opportunity.count({ where: { status: "WON", wonAt: { gte: periodStart } } }),
  prisma.opportunity.count({ where: { status: "LOST", lostAt: { gte: periodStart } } }),
]);
const winRate = wonCount + lostCount === 0 ? null : wonCount / (wonCount + lostCount);

// Gemiddelde doorlooptijd — datumrekenkunde, geen geld, veilig als gewoon
// getal (dagen). Haalt alleen createdAt/wonAt/lostAt op.
const closed = await prisma.opportunity.findMany({
  where: { status: { in: ["WON", "LOST"] }, OR: [{ wonAt: { gte: periodStart } }, { lostAt: { gte: periodStart } }] },
  select: { createdAt: true, wonAt: true, lostAt: true },
});
const avgCycleDays = average(closed.map((o) => daysBetween(o.createdAt, (o.wonAt ?? o.lostAt)!)));
```

**Vastgelegde regel voor toekomstige ontwikkelaars**: gebruik altijd
`status` als het filter dat "is dit een gewonnen/verloren deal" beantwoordt
— `wonAt`/`lostAt IS NOT NULL` is **na de Phase 4A MUST-FIX-ronde**
weliswaar weer betrouwbaar synoniem aan `status=WON`/`LOST` (ze worden nu
altijd samen gezet en samen gewist), maar `status` is en blijft de
semantisch juiste, expliciete autoriteit — filter er altijd op, ook als
`wonAt`/`lostAt` toevallig hetzelfde resultaat zou geven.

## 10. Kanban drag/drop

**Eisen, één voor één beantwoord:**

- **Alleen OPEN opportunities**: al gegarandeerd door constructie — de
  kanban-kolommen zijn uitsluitend de 6 actieve fases; WON/LOST/gearchiveerd
  worden daar nooit in gerenderd (bestaand `listOpportunities()`-filter).
- **Alleen bevoegde gebruiker**: kanban ontvangt een `canEdit`-prop
  (`role !== VIEWER`, zelfde patroon als de bestaande `canCreate`-prop) —
  bij `!canEdit` worden geen drag-handles gerenderd, kaarten zijn puur
  informatief.
- **Server-side `changeStage()`**: de drag-handler roept exact
  `PATCH /api/opportunities/[id]/stage` aan — dezelfde route, dezelfde
  service-functie, dezelfde audit/Activity-schrijfacties als de bestaande
  dropdown op de detailpagina. Geen nieuwe mutatiecode.
- **Optimistic UI, met rollback**: de kaart verplaatst lokaal direct bij
  drop (responsief gevoel), gevolgd door de API-aanroep. Bij een fout-
  response (403/400/netwerkfout) springt de kaart terug naar de
  oorspronkelijke kolom en toont een foutmelding — geen stille inconsistentie
  tussen UI en server.
- **VIEWER geen drag**: hierboven al gedekt via `canEdit`.
- **Archived/WON/LOST niet draggable**: hierboven al gedekt — ze verschijnen
  niet in de kanban-kolommen om te beginnen.
- **AuditEvent/Activity altijd**: al gegarandeerd door hergebruik van
  `changeStage()` — geen aparte "drag" audit-actie nodig, het is dezelfde
  actie als een handmatige fasewijziging.

**Toegankelijkheid**: HTML5-native drag-and-drop heeft geen
toetsenbordondersteuning. Aanbeveling: een DnD-bibliotheek met ingebouwde
keyboard-sensor (bv. `@dnd-kit/core`, expliciete keyboard-sensor-
ondersteuning) in plaats van kale native HTML5 DnD. **Onafhankelijk
daarvan** blijft de bestaande stage-dropdown op de detailpagina de
gegarandeerde, volledig toetsenbord-bedienbare route — drag-and-drop is een
aanvullend gemak op de kanban, nooit de enige manier om een fase te
wijzigen. Exacte bibliotheekkeuze is een bouwbeslissing, geen
architectuurbeslissing — vastgelegd hier is uitsluitend de eis
("toetsenbordalternatief moet blijven bestaan én functioneel gelijkwaardig
zijn").

## 11. Pipeline cards — compacte toevoegingen

Kaart toont (naast de bestaande titel/klant/waarde/kans/eigenaar/
verwachte-sluiting):
- Aandacht-indicator (kleine gekleurde stip/badge, `highestSeverity`) —
  geen tekst-opsomming van alle signalen op de kaart zelf (te vol); hover/
  klik toont detail.
- Volgende actie (uit `deriveNextAction()`, al beschikbaar).
- **Geen** "laatste klantcontact" op de kaart — dat blijft, per de
  performance-afweging in §5/discovery §1.3, exclusief voor de
  detailpagina en Customer 360. De kaart toont hoogstens "laatste
  activiteit" (al gebatcht beschikbaar).
- Shopify-win-signaal: alleen zichtbaar op de detailpagina (vereist de
  daar al opgehaalde `draftOrders`/`orders`-data) — niet op de kanban-kaart,
  om diezelfde reden.

## 12. Opportunity-detail — nieuwe "Opvolging"-sectie

- Volgende taak (met overdue/vandaag/gepland-status)
- Laatste klantcontact voor deze klant (eerlijk gelabeld, §3)
- Laatste activiteit op deze opportunity
- Waarschuwing verwachte sluitdatum (indien verstreken)
- Shopify-ordersignaal (§6), indien van toepassing
- Offerte-signaal (§7), indien van toepassing

Quick actions ongewijzigd uit Phase 4A (taak toevoegen, gewonnen/verloren
markeren, fase aanpassen) — geen AI-suggesties, exact zoals gevraagd.

## 13. Customer 360

`OpenOpportunitiesBlock`/`OpportunitiesSection` (al bestaand) tonen per
opportunity een eigen aandacht-indicator (`highestSeverity`) — elke
opportunity van een klant met meerdere trajecten blijft individueel
zichtbaar, geen samengevouwen/globale status. Geen wijziging aan
`CustomerProfile.crmStatus` of enige andere globale klantstatus — de
aandacht-indicator is uitsluitend een leesweergave, nooit een schrijfactie
op de klant.

## 14. Sales-dashboardfilters

- **Eigenaar**: ADMIN ziet alle eigenaren (standaard: iedereen, met
  wisselmogelijkheid — zelfde patroon als de bestaande
  `/opportunities`-eigenaarfilter); AGENT/USER krijgt standaard de eigen
  opportunities getoond maar kan, exact zoals de bestaande
  `/opportunities`-lijst dat al toestaat via `ownerUserId`-filter, wisselen
  naar "alle" of een specifieke collega (geen extra RBAC-laag nodig — de
  onderliggende `listOpportunities()` filtert al server-side, en lezen van
  andermans opportunity-overzicht is nooit als "schrijven" behandeld in dit
  systeem).
- **Fase**: hergebruikt het bestaande `stage`-filter.
- **Periode/horizon**: nieuw voor het dashboard specifiek (bv. "deze maand"/
  "komende 30 dagen"/"dit kwartaal") — een klein, vast setje opties, geen
  vrije datumkiezer-complexiteit.
- **VIEWER**: dashboard volledig read-only — geen enkele actieknop
  zichtbaar, zelfde `canEdit`-conventie als overal elders.

## 15. "Mijn verkoopkansen"

Geen aparte route. `/opportunities?owner=me` (of een expliciete
`?ownerUserId={huidige gebruiker}`) — de bestaande eigenaarfilter-select op
de pipeline-pagina krijgt een "Ik"-optie die zich server-side vertaalt naar
de ingelogde gebruiker's id. Eén regel UI-logica, geen nieuwe
infrastructuur.

## 16. Alert priority — UX-noodzaak bevestigd

RED/ORANGE/BLUE is UX-technisch zinvol specifiek omdat de drie categorieën
fundamenteel verschillend gedrag van de gebruiker vragen: RED = "dit is nu
al te laat, actie vereist", ORANGE = "dit begint te verouderen, kijk
ernaar", BLUE = "er is een kans om te sluiten, wil je bevestigen". Eén
ongedifferentieerd "aandacht nodig"-icoon (zoals Phase 4A's huidige
enkele boolean) zou dit onderscheid verliezen. Geen databasekolom voor
severity — puur een berekende eigenschap van `deriveOpportunityAttention()`
(§1).

## 17. Performance-strategie

- **Pipeline/dashboard**: uitsluitend Control-Center-eigen data
  (`Opportunity`, `Task`, `Activity`) plus batched queries — nooit een
  Shopify/IMAP/PBX-aanroep per kaart. Het bestaande `Activity.groupBy`-
  patroon (§34 §1.2) is het sjabloon voor elke nieuwe gebatchte lookup.
- **Detailpagina**: blijft de enige plek met live externe aanroepen (al zo
  in Phase 4A) — één paginabezoek, één fetch per bron, geen wijziging
  nodig.
- Geen N+1: elke nieuwe metric/signaal die per-opportunity-rij data nodig
  heeft (attention, next action) gebruikt dezelfde reeds-gebatchte
  aanpak — nooit een losse query per rij in een lus.

## 18. "Laatste contact"-performance — architectuurvoorstel

Drie opties tegen elkaar afgewogen, zoals gevraagd:

| | A. Alleen detailpagina live | B. `CustomerProfile`-cache | C. Category-C projectie/cache |
|---|---|---|---|
| Nieuwe infrastructuur | Geen | Nieuwe kolom(men) + verversingsstrategie | Nieuwe tabel + verversingsstrategie |
| Hoe blijft het actueel | Vanzelf — elke live fetch is per definitie actueel | Vereist een trigger: webhook (bestaat niet, zou een sibling-app-wijziging vergen — expliciet buiten scope) of een periodieke poller (achtergrondproces — expliciet af te raden tenzij aantoonbaar noodzakelijk, §19) | Zelfde probleem als B |
| Risico | Geen "laatste contact" zichtbaar op kaart/dashboard (alleen "laatste activiteit") | Staleness-beheer nodig, extra faalmodus (cache loopt uit de pas met de waarheid) | Zelfde als B, plus een nieuw datamodel om te onderhouden |
| Strookt met ADR-004/008 | Ja — precies het al gevestigde principe ("live/gefedereerd, nooit lokaal gekopieerd") | Nee — zou de eerste afwijking zijn van dat principe in dit hele platform | Nee, zelfde bezwaar |

**Aanbeveling: Optie A.** Er bestaat vandaag geen enkel push-mechanisme
voor calls (telefonie-adapter is pull-only) of e-mail (IMAP is pull-only,
Microsoft 365 is geparkeerd) — een cache zou dus alleen door een nieuwe
achtergrondpoller actueel gehouden kunnen worden, wat sectie 19 van de
opdracht expliciet afraadt tenzij aantoonbaar noodzakelijk. Dat bewijs is
er niet: de pipeline/dashboard kunnen volledig functioneren met "laatste
activiteit" (Control-Center-eigen, al gebatcht, geen cache nodig) als proxy
voor de vroege fases, en de detailpagina/Customer 360 tonen de echte
"laatste klantcontact" al live, zonder extra kosten (§17).

**Erkende, expliciet gedocumenteerde beperking**: voor `QUOTE_SENT`/
`NEGOTIATION` gebruikt de PIJPLIJN-weergave "laatste activiteit" als
benadering van "laatste klantcontact" (§2) — een salesmedewerker die alleen
intern een notitie toevoegt zonder de klant echt opnieuw te benaderen zou
daardoor een stale deal ten onrechte niet gemarkeerd zien in de
pijplijnweergave. De detailpagina toont in dat geval wél de correcte,
live "laatste klantcontact"-waarde. Dit is een bewuste, beargumenteerde
afweging (juistheid op de detailpagina, snelheid + eenvoud op de
pijplijn) — geen toevallige omissie.

## 19. Achtergrondproces?

Niet nodig. Elke afgeleide waarde in dit document (attention, next action,
dashboard-metrics) is bij de verwachte schaal (tientallen tot enkele
honderden open opportunities, bevestigd in ADR-009/architectuurdoc)
goedkoop on-the-fly te berekenen bij paginalaad. Phase 4B verstuurt geen
notificaties (geen e-mail/push) — zodra dat ooit wél gevraagd wordt, is dát
het moment voor een achtergrondproces, niet nu.

## 20. Audit

- Derived attention state: geen audit — het is een leesweergave, geen
  mutatie.
- Drag-stage: hergebruikt de bestaande `opportunity.stage_changed`-audit
  (via `changeStage()`) — geen nieuwe audit-actie.
- Mens-bevestigd order→won: hergebruikt de bestaande `opportunity.won`-
  audit (via `markWon()`) — geen nieuwe audit-actie.
- Geen enkele nieuwe `AuditAction`-waarde nodig voor Phase 4B.

## 21. RBAC/security

VIEWER: dashboard + pipeline volledig zichtbaar (lezen), geen drag, geen
mark-won/lost, geen taak aanmaken — allemaal al gegarandeerd door de
bestaande `requireWriteAccess()`-gates op de onderliggende routes plus de
nieuwe `canEdit`-prop-conventie voor drag. AGENT/ADMIN: bestaande
`assertCanModify`-eigendomsregels (eigenaar/aanmaker/beheerder), ongewijzigd.
Geen enkele commerciële beslissing (stage/status/won/lost) wordt ooit
uitsluitend op basis van client-afgeleide externe data uitgevoerd — elke
suggestie (§6/§7) vereist een expliciete, server-side gevalideerde
mensactie via de bestaande, al gehardeerde services.

## 22. Migration

**Niet nodig.** Elke nieuwe waarde in dit document — `highestSeverity`,
gewogen pipeline-waarde, "volgende actie"-status, "laatste
contact"-classificatie — is een pure berekening over bestaande kolommen
(`Opportunity.stage/status/estimatedValue/probability/expectedCloseDate/
wonAt/lostAt/finalValue`, `Task.dueAt/status`, `Activity.occurredAt`). Geen
nieuwe tabel, geen nieuwe kolom, geen nieuwe enum. Dit is een bewuste,
onderbouwde keuze (niet zomaar "geen tijd gehad"): elke voorgestelde
afgeleide waarde is *goedkoop herhaalbaar* uit bestaande data — er is geen
enkel geval waarin het cachen/opslaan ervan een probleem zou oplossen dat
on-the-fly berekenen niet al oplost, bij de huidige en verwachte schaal.

## 23. Fasering — voorgestelde 4B-scope

**Phase 4B** (dit voorstel, praktisch gehouden):
- A. Attention engine (`deriveOpportunityAttention`, per-fase stale-
  drempels, RED/ORANGE/BLUE)
- B. Dashboard sales-metrics (pipeline-waarde, gewogen pipeline,
  aandacht-tellingen, verwachte sluitingen, recent won/lost)
- C. Pipeline-verbeteringen (aandacht-indicator + volgende-actie op kaarten,
  "Opvolging"-sectie op detailpagina, eigenaar-/fase-/periodefilters,
  "Mijn verkoopkansen"-snelkoppeling)
- D. Drag-and-drop (met toetsenbordalternatief gegarandeerd)
- E. Shopify completed-order-suggestiebanner

**Later (bewust niet in 4B)**:
- Quote-aanwezig-suggestiebanner (§7) — laagste prioriteit, kan zonder
  risico naar een volgende ronde als de tijd beperkt is.
- Uitgebreide historische analytics/forecasting.
- Configureerbare stale-drempels (blijven vaste constanten totdat een
  concreet gebruiksgeval een andere waarde per team/productlijn vraagt).
- Notificaties (e-mail/push).
- AI, in welke vorm dan ook.
- Quote-link cross-customer-verificatie (al bekende beperking uit Phase
  4A, blijft ongewijzigd beperkt).

## 24. Testplan

**Attention**:
- overdue open taak → `RED`/`OVERDUE_TASK`
- `expectedCloseDate` verstreken → `RED`/`CLOSE_DATE_PASSED`
- stale per fase (elke fase apart, met de eigen drempel) → `ORANGE`/`STALE`
- geen volgende open taak → `ORANGE`/`NO_NEXT_ACTION`
- recent gecontacteerd (binnen drempel) → geen `STALE`-signaal
- WON/LOST/gearchiveerd → altijd `highestSeverity: null`, ongeacht andere
  condities

**Geld**:
- gewogen pipeline-berekening met `Prisma.Decimal` — expliciete test dat
  het resultaat exact overeenkomt met een handmatige Decimal-berekening,
  nooit een `Number`-afrondingsverschil.
- `estimatedValue = null` wordt overgeslagen in de gewogen som (niet als 0
  meegenomen op een manier die een fout veroorzaakt).

**Dashboard**:
- open pipeline-waarde sluit `archivedAt != null` uit.
- open pipeline-waarde sluit WON/LOST uit.
- won/lost-metrics gebruiken `status`, niet alleen `wonAt/lostAt IS NOT
  NULL` (regressietest tegen de exacte MUST-FIX-bevinding uit Phase 4A).

**Drag/drop**:
- succesvolle drag → `changeStage()` aangeroepen, audit + Activity
  geschreven.
- API-fout → UI-rollback naar oorspronkelijke kolom.
- gesloten/gearchiveerde opportunity → nooit draggable (kan al niet
  gerenderd worden in een open-fase-kolom, maar test expliciet dat de
  onderliggende route dit ook server-side blijft weigeren).
- VIEWER → geen drag-handles gerenderd; server weigert de route sowieso
  (bestaande RBAC, hertest niet overbodig).

**Shopify-signaal**:
- gekoppelde draft order met `completedOrder` gevuld → banner zichtbaar,
  voorgestelde waarde komt overeen met de echte `orders`-rij.
- geen `completedOrder` → geen banner.
- klant-mismatch onmogelijk — hergebruikt de al bestaande, al geteste
  cross-customer-verificatie uit Phase 4A (`addExternalLink()`); geen
  nieuwe test nodig, wel een regressie-bevestiging dat het signaal alleen
  op basis van een al-geverifieerde link verschijnt.
- markWon() wordt nooit automatisch aangeroepen — alleen na expliciete
  UI-bevestiging (component-test, geen server-side aanroep zonder
  gebruikersactie).

**Performance**:
- pipeline-lijst met N opportunities genereert een vast, klein aantal
  queries (niet O(N)) — expliciete query-tellingtest, zelfde soort
  controle als al elders in dit project gebruikt.

## 25. Buildvolgorde

1. `deriveOpportunityAttention()` + per-fase stale-constanten +
   `deriveNextAction()` in de service-/labels-laag, met volledige
   testdekking (sluit meteen het bestaande testgat rond `needsFollowUp`).
2. Dashboard-metric-functies (§9) + Sales-dashboardsectie-UI.
3. Pipeline-kaartverbeteringen (aandacht-indicator, volgende actie) +
   filters (eigenaar/fase/periode) + "Mijn verkoopkansen".
4. Opportunity-detail "Opvolging"-sectie.
5. Shopify completed-order-suggestiebanner.
6. Quote-aanwezig-suggestiebanner (laagste prioriteit, kan als laatste of
   uitgesteld worden).
7. Drag-and-drop (bouwt op een al werkende, volledig geteste
   niet-drag-pijplijn — laatst, want het meest UI-risicovolle onderdeel).
8. Volledige teststrategie + kwaliteitspoorten, zelfde patroon als Phase
   4A/4A-fix.
