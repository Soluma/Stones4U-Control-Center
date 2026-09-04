# 43 — Phase 6 Discovery: CRM Workflow & Daily Operations

**Status**: Discovery, geen implementatie. Vervolg op Phase 5A
(productie-commit `5f87e92ba2799306bc6246a0d8135f65f37edcd2`, versie 15).
Gebaseerd op een verse codebase-inventarisatie op HEAD (drie parallelle
read-only onderzoeken), niet op oude discovery-documenten.

## 1. Huidige CRM — feitelijke staat

Per domein, gebaseerd op code (bestandsverwijzingen zijn indicatief, niet
uitputtend):

- **Customer 360** (`src/app/(app)/customers/[id]/`, 19 componenten):
  tabs overview/orders("Commercieel")/activity/notes/tasks/appointments/files.
  Header-quickactions (Verkoopkans/Notitie/Taak/Afspraak/Bestand) zijn
  navigatie-links naar een tab, geen inline-creatie. **Geen bel-/mail-
  quickaction.**
- **CustomerContacts**: volwaardige CRUD, primary/decisionmaker/billing
  booleans (bewust geen rol-enum), archief/restore, IDOR-veilig via
  `assertContactBelongsToCustomer()`. Geen `notes`-veld, geen department.
- **Customer identity** (Phase 5A): persoon/organisatie-model volledig
  aanwezig en productie-live — geen verder onderzoek nodig.
- **Tasks**: rijk model (status/prioriteit/dueAt/tags/reminderAt/checklist/
  comments), drie aanmaakpaden (standalone, klant-scoped,
  opportunity-scoped) via één service. Geen snooze, geen recurring, geen
  task-type, geen bulk-acties. `dueAt` is datum-only (geen tijd).
- **Notes**: gestructureerde rich-text-opslag (`bodyJson`, een gesloten
  JSON-boomstructuur, geen `dangerouslySetInnerHTML`-risico), maar de
  editor is een plain textarea met markdown-subset — geen
  WYSIWYG-toolbar. Geen pinning, geen zichtbaarheidscontrole, geen
  edit-historie (alleen een `editedAt`-vlag).
- **Appointments**: geen eigen agenda/kalenderweergave — alleen
  per-klant of een 5-item lijst op het dashboard. Geen reminder-veld
  (Task heeft dat wel). `externalCalendarId` bestaat maar ongebruikt,
  geen Google/Microsoft-sync-code aanwezig.
- **Activity/timeline**: sterke unificatie van 7 bronnen (CONTROL_CENTER
  opgeslagen; Shopify/Telefoonsysteem/Exact/OfferteApp/s4u-quote-app/
  Microsoft365/IMAP live geprojecteerd). **Geen "maak taak van dit
  item"-actie** op enig timeline-item.
- **Email (IMAP)**: strikt read-only, geen SMTP/send-code. Geen
  reply/mailto-actie specifiek voor e-mailrecords. Geen volledige body
  opgeslagen (alleen preview, gecapt). **Geen "wacht op antwoord"-signaal
  van welke aard dan ook.**
- **Calls (Telefonie)**: **ENABLED** in huidige code (niet disabled zoals
  oudere docs suggereren), afhankelijk van env-vars. `direction` is
  bij de bron altijd `"UNKNOWN"` — echte inbound/outbound/gemist-
  onderscheid is dus niet betrouwbaar beschikbaar, ondanks een
  `disposition`-label dat wel MISSED/ABANDONED kan tonen. Geen
  `tel:`-link, geen taak/notitie-actie vanuit een gesprek.
- **Quotes-federatie**: live, geen lokale opslag. **Geen `validUntil`-veld
  in beide bronnen** — "offerte verlopen" is dus niet berekenbaar. Enige
  gerelateerd signaal: `QUOTE_AHEAD_OF_STAGE` (aanwezigheid-vs-stage, geen
  tijdgebaseerde staleness).
- **Orders/Draft Orders**: live, geen lokale opslag, geen leeftijd-
  gebaseerd "te lang open"-signaal voor draft orders (alleen een
  koppelings-afhankelijk "bestelling geplaatst → markeer gewonnen?"-
  signaal in de attention engine).
- **Opportunities/pipeline**: `lostReason` verplicht bij verlies. Geen
  eigen "volgende actie"-veld — volledig afgeleid van de gekoppelde Task
  via `deriveNextAction()`. Solide quickactions (stage/eigenaar/gewonnen/
  verloren/heropenen/archiveren).
- **Sales dashboard/attention engine**: opportunity-specifiek, puur/
  stateless, herbruikbare primitieven (`deriveNextAction`, staleness-
  drempel) maar generaliseert nergens naar taak- of klantniveau.
- **Dashboards**: hoofddashboard hergebruikt letterlijk
  `getSalesDashboardMetrics()` — geen duplicate berekening, één
  "Verkoop"-blok. Taken-widget toont alleen **tellingen**, geen lijst met
  titels/links. Afspraken-sectie: vaste 5-item lijst, geen "vandaag"-
  filter.
- **Command palette/zoeken**: customers/orders live via Shopify; tasks/
  opportunities/contacts via Postgres `ILIKE` (ongeïndexeerd op de
  gezochte tekstkolommen — bij het huidige datavolume geen probleem, wel
  een aandachtspunt bij groei). **Geen notitie-zoeken, geen
  e-mailinhoud-zoeken** (bewust uitgesloten).
- **RBAC/audit**: drie rollen (ADMIN/AGENT/VIEWER), `requireWriteAccess()`
  centraal, zeer uitgebreide bestaande `AuditAction`-unie, consistent
  IDOR-patroon (`assertContactBelongsToCustomer()` hergebruikt in Note/
  Task/Appointment).
- **Admin/Users**: aanmaken/rolwijziging/deactiveren. Geen reactivatie,
  geen wachtwoord-reset door admin, geen verwijderen.
- **Matching**: telefoon/e-mail/GID(niet als aparte functie
  geïmplementeerd)/handmatig — bewezen, in productie.
- **Accountmanager-workflow**: `accountManagerId` bestaat als enkel veld.
  **Geen "mijn klanten"-weergave, geen "niet-toegewezen klanten"-
  weergave** — de klantenlijstpagina is uitsluitend een Shopify-
  zoekbalk zonder enige filter. De Opportunities-dashboard heeft wél al
  een volledig uitgewerkt `ownerUserId`-filterpatroon — dit patroon heeft
  geen CustomerProfile-equivalent.
- **Exact/accounting**: adapter is een bewust, goed gedocumenteerd
  **DISABLED**-stub (geen nep-afwezigheid) — de onderliggende data
  (`ExactCustomer`/`ExactInvoice`/…) bestaat wél, in TelefoonSysteem's
  eigen `customer-history-db`, maar zit achter een mens-georiënteerde
  JWT-auth zonder veilige machine-credential. Structurele blocker, niet
  oplosbaar vanuit deze repo (CLAUDE.md verbiedt expliciet een
  workaround hiervoor).
- **Order/delivery**: bevestigd via een oppervlakkige zusApp-check —
  levering/transport zit al in OfferteApp (`TransportOrder`,
  Hoefnagels-planning), "op rekening"/restock zit al in Kassa Systeem.
  Geen adapter naar deze systemen bestaat vanuit dit CRM.
- **Performance-precedenten**: fail-isolation (onafhankelijke try/catch
  per externe adapter, `customers/[id]/page.tsx`), geen N+1 (hergebruik
  van een al-opgehaalde lijst in `getSalesDashboardMetrics()`, één
  gebatchte `groupBy` in `attachAttention()`) — dit zijn de patronen die
  elke Phase 6-feature moet volgen.

## 2. Dagelijkse workflow — welke vragen worden beantwoord?

| Vraag | Status | Bewijs |
|---|---|---|
| Wie moet ik vandaag bellen? | **Niet beantwoord** | geen cross-klant call-actielijst |
| Welke klanten wachten op antwoord? | **Niet beantwoord** | geen "needs response"-signaal, nergens |
| Welke offertes moet ik opvolgen? | **Deels** | alleen aanwezigheid-vs-stage, geen tijd/verval (geen `validUntil`) |
| Welke afspraken heb ik vandaag? | **Deels** | 5-item lijst, geen "vandaag"-filter |
| Welke taken zijn te laat? | **Deels** | telling wel, lijst met titels/links niet |
| Welke verkoopkansen zijn stilgevallen? | **Goed opgelost** | attention engine + dashboard + pipeline |
| Welke klant heeft onlangs gebeld/gemaild? | **Alleen per klant** | geen cross-klant weergave |
| Wat heb ik zelf beloofd aan een klant? | **Deels, via Tasks** | geen apart "belofte"-concept |
| Welke klanten hebben nog openstaande acties? | **Opportunity-niveau ja, klant-niveau nee** | geen generieke rollup |
| Wat is de laatste interactie? | **Goed opgelost, per klant** | ActivityTimelineView; niet cross-klant |
| Wat moet mijn collega weten? | **Deels, via Notes** | geen handoff-specifiek mechanisme |

**Kernbevinding**: per klant is Customer 360 al zeer volledig en goed
gebouwd. Het gat zit vrijwel volledig op **cross-klant, "mijn dag"-
niveau** — er bestaat nergens één geprioriteerde lijst die taken,
afspraken en verkoopkansen-die-aandacht-nodig-hebben over ál mijn
klanten samenbrengt. Van de 11 dagelijkse vragen hierboven raakt dit
gat er 7 direct of gedeeltelijk.

## 3. Customer 360 gap-review

Belangrijkste informatie is direct zichtbaar (header + overview-tab).
Hoofdacties (taak/notitie/afspraak/verkoopkans/bestand) zijn 2 klikken
(header-link → "nieuw…"-knop) + formulier — acceptabel, geen structureel
probleem. Ontbrekende hoogfrequente acties: **bellen** en **mailen**
vanuit Customer 360 zelf (geen `tel:`/mailto`-links op call-/e-mail-
records, alleen op een contactpersoons eigen veld elders in de pagina).

## 4. Inbox / Work Queue

Bevestigd: dit ontbreekt feitelijk. Bestaande bouwstenen die al 90% van
de benodigde data leveren zonder nieuwe integratie:
- Overdue/due-today tasks: `Task`-model + bestaande service, alleen de
  telling wordt vandaag getoond, niet de lijst.
- Aanstaande afspraken: `listUpcomingAppointments()` bestaat al, capped
  op 5, geen "vandaag"-scoping.
- Verkoopkansen die aandacht nodig hebben: attention engine + dashboard-
  telling bestaan al, alleen de telling wordt getoond, niet de lijst.
- Recente inkomende communicatie (mail/bellen) cross-klant: **niet**
  veilig uit bestaande bouwstenen te halen zonder een nieuwe, gebatchte
  adapter-aanroep per "mijn klanten" — dat zou een N+1-patroon richting
  TelefoonSysteem/IMAP zijn, in strijd met het al gevestigde fail-
  isolation/no-N+1-precedent. Zie §5.

**Eén gecombineerde work queue heeft duidelijk meer waarde dan meerdere
losse widgets** — juist omdat de onderliggende tellingen al apart bestaan
maar nooit worden samengevoegd tot iets actionable.

## 5. Inbound communication follow-up

Het "Needs response"-concept is met de huidige data **niet betrouwbaar**
te bouwen: e-mail heeft geen read/replied-vlag, telefonie heeft geen
betrouwbare richting (`direction` is altijd `"UNKNOWN"` bij de bron). Een
naïeve "laatste bericht was inbound → needs response" conclusie zou vaak
fout zijn (bijv. een reply die niet via de gemonitorde mailbox verstuurd
is, blijft onzichtbaar). **Conclusie: dit blijft discovery, niet bouwen
in Phase 6A** — de betrouwbare data ontbreekt structureel, niet alleen de
UI.

## 6. Email workflow

Read-only bevestigd. Geen reply/compose/templates. Enige realistische
laagrisico-vervolgstap: een `mailto:`-link op een e-mailrecord (net als
al bestaat op een contactpersoon's eigen e-mailveld) — triviaal, geen
SMTP nodig. Geen SMTP-implementatie nu (expliciet uitgesloten door de
opdracht).

## 7. Call workflow

Telefonie is **enabled**, niet disabled. Data die écht beschikbaar is:
tijdstip, titel/samenvatting, telefoonnummer, disposition-afgeleide
tekst — **geen betrouwbare richting**. Laagrisico-vervolgstap: een
`tel:`-link (triviaal). Taak/notitie-vanuit-gesprek bestaat niet en zou
de bestaande `createTask()`/`createNote()`-services kunnen hergebruiken.

## 8. Tasks als centraal werkobject

Model is al rijk. Enige met aantoonbare operationele waarde: **geen van
de gevraagde extra's (priority bestaat al, snooze/recurring/type/bulk)
heeft directe evidentie van een dagelijkse blocker** in deze
inventarisatie — dit blijft dus een "later, bij bewezen behoefte"-
categorie, niet iets om nu toe te voegen.

## 9. Appointments/calendar

Geen eigen agenda-overzicht, geen vandaag/week-filter, geen reminders.
Google/Microsoft-sync: **niet nodig nu** — er is geen enkele aanwijzing
dat medewerkers vandaag een externe agenda gebruiken naast dit systeem;
`externalCalendarId` is een bewust voor-latere-fase leeg veld, geen
halve implementatie.

## 10. Opportunity workflow

Na "quote sent" bestaat er geen expliciete "volgende actie"-prompt —
alles loopt via Tasks. Dit werkt, maar is impliciet: een verkoper moet
zelf onthouden een taak aan te maken. Cards zijn informatief genoeg
(attention-badges, next-action). Closing-workflow is compleet
(won/lost/reopen/archive, verplichte lostReason). Geen automatische
stage-transities nodig (bevestigd, geen wijziging voorgesteld).

## 11. Quote follow-up

Geen `validUntil` in beide bronnen → "offerte verlopen" is
**niet-berekenbaar zonder brondata-uitbreiding in OfferteApp/
s4u-quote-app zelf** (buiten scope van deze repo). "Quote verzonden maar
geen vervolgactie" is met de huidige stage-vergelijking (
`QUOTE_AHEAD_OF_STAGE`) al gedeeltelijk gedekt — een striktere
tijdgebaseerde variant is niet mogelijk zonder een van de twee ontbrekende
brongegevens (verzenddatum-per-quote-status of validUntil).

## 12. Customer task/activity relation

Bevestigd ontbrekend: geen "maak taak"/"opvolgen"-actie vanuit een
timeline-item. Zou de bestaande `createTask()`/`createNote()`-services
kunnen hergebruiken vanuit `ActivityTimelineView.tsx` — reële waarde,
kleine wijziging, maar raakt een ander scherm (Customer 360) dan het
gekozen Phase 6A-onderwerp (zie §28 hieronder) — kandidaat voor een
volgende iteratie, niet gebundeld nu om Phase 6A klein te houden.

## 13. Quick actions

Compacte set bestaat al in Customer 360-header (Verkoopkans/Notitie/
Taak/Afspraak/Bestand). "Offerte" als quickaction: **niet toevoegen** —
er is geen schrijf-adapter naar OfferteApp/s4u-quote-app (Phase 1 is
sowieso alleen-lezen richting Shopify en er bestaat geen quote-
aanmaak-integratie); dit zou een nieuwe, grote externe schrijf-
integratie vereisen, expliciet buiten scope.

## 14. Global search

Zoals hierboven: geen notitie-zoeken, geen e-mailinhoud-zoeken (bewust),
geen apart telefoonnummer-zoeken (wel incidenteel via contactpersonen-
zoeken). Performance: alle lokale tekstzoekopdrachten zijn ongeïndexeerde
`ILIKE`-scans — bij 3 klanten/0 taken/0 opportunities in productie
vandaag geen probleem, maar een reëel aandachtspunt zodra het
klantenbestand groeit. Geen wijziging nu nodig (geen bewijs van een
huidig probleem), wel genoemd in de rangschikking.

## 15. Notities

Rich-text-opslag is er al (gestructureerd, veilig). Editor is een
textarea met markdown-subset — functioneel voldoende voor dagelijkse
klantafspraken (bold/italic/lijsten kunnen al), geen bewijs dat een
WYSIWYG-toolbar een dagelijkse blocker is. Geen pinning, geen
zichtbaarheid, geen editgeschiedenis — pinning heeft de duidelijkste
potentiële dagelijkse waarde ("wat moet mijn collega weten", §2), de
andere twee minder aantoonbaar urgent.

## 16. Customer flags/important info

Tags (vrije tekst + kleur) bestaan al en kunnen dit al gedeeltelijk
oplossen ("Let op", "Betaalt op rekening" als tag). Notities met een
toekomstige pin-functie zouden de rest dekken. **Geen apart
custom-fields-systeem nodig** — geen bewijs gevonden dat tags/notities
hiervoor structureel tekortschieten.

## 17. Accountmanager workflow

Bevestigd echt ontbrekend: geen "mijn klanten"-weergave, geen "niet-
toegewezen klanten"-weergave, terwijl het exact-analoge patroon
(`ownerUserId`-filtering) al volledig bewezen bestaat op de
Opportunities-dashboard. Sterke kandidaat voor een volgende fase — bewust
niet gebundeld in Phase 6A om de scope klein te houden (zie §28).

## 18. Dashboard

Geen overlap-probleem — het hoofddashboard hergebruikt de sales-
dashboard-data al (één berekening, één bron). Ontbrekende dagelijkse
signalen: taken-lijst (i.p.v. alleen telling), "vandaag"-afspraken-
filter, opportunity-attention-lijst (i.p.v. alleen telling) — precies
het "Mijn Werk"-gat. **Geen derde dashboard nodig** — het bestaande
hoofddashboard is de juiste plek om dit uit te breiden.

## 19. Notifications

Geen bestaand notificatiesysteem. Gegeven dat de onderliggende
tellingen/signalen al bestaan maar nergens als actionable lijst worden
getoond, lost een werkbak-uitbreiding op het dashboard het grootste deel
van de behoefte op zonder een nieuw notificatie-systeem (push/e-mail) te
hoeven bouwen — expliciet niet nu ontwerpen, conform de opdracht.

## 20. Commercial customer overview

Al goed gedekt: laatste order, open draft, offertes, opportunity, omzet/
orderhistorie, laatste contact zijn allemaal al live zichtbaar in
Customer 360. "Volgende actie" is impliciet via Tasks (zie §10). Geen
zware analytics nodig — geen use case aangetroffen die dit rechtvaardigt.

## 21. Accounting/Exact

Zoals boven: reële, structurele blocker (auth-gat aan TelefoonSysteem-
kant), niet oplosbaar binnen deze repo. Duidelijk gemarkeerd als
accounting-data, geen interactiegeschiedenis. **Geen Exact-integratie in
Phase 6.**

## 22. Order/delivery workflow

Bevestigd: levering/transport/op-rekening/voorraad zijn al eigendom van
OfferteApp en Kassa Systeem. Control Center moet dit niet dupliceren en
heeft geen adapter hiernaartoe. Geen samenvattend signaal op te nemen in
Phase 6A zonder een nieuwe, grote externe integratie te bouwen —
expliciet buiten scope.

## 23. Duplication review

Voor elke hieronder gerangschikte aanbeveling is expliciet gecontroleerd
of hij al elders bestaat (zie per sectie hierboven) — geen van de
gekozen Phase 6A-onderdelen dupliceert iets dat al in OfferteApp/
s4u-quote-app/Kassa Systeem/TelefoonSysteem/Shopify bestaat; alle drie
zijn 100% Control-Center-owned data (Task/Appointment/Opportunity),
uitsluitend samengevoegd, niet elders opnieuw opgeslagen.

## 24. UX friction review

Concrete fricties gevonden (geen cosmetische lijst):
- Taken-telling op dashboard zonder doorklik naar de daadwerkelijke
  taken → medewerker moet altijd naar `/tasks` navigeren en zelf
  filteren.
- Afspraken-lijst toont een vaste 5, niet "vandaag" — bij een drukke dag
  kan een afspraak van vandaag onderaan verdwijnen zodra er >5
  toekomstige afspraken zijn.
- Geen bel-/mail-actie op Customer 360 zelf — een medewerker moet het
  telefoonnummer/e-mailadres kopiëren of via de contactpersoon-sectie
  gaan.
- Geen "maak taak van dit" vanuit een timeline-item — een opvolgactie
  vanuit een gesprek/e-mail vereist alt-tabben naar de Taken-tab en het
  onderwerp opnieuw intypen.

## 25. Performance/security (voor voorgestelde features)

Zie precedenten in §1. Elke Phase 6A-service moet: bestaande, al-
opgehaalde lijsten hergebruiken (geen nieuwe N+1), geen externe
API-aanroep per kaart, `ownerUserId`/`assignedToId`-scoping voor
niet-ADMIN (matcht bestaand dashboard-patroon), fail-isolation per
sectie (een falende sectie mag de rest van het dashboard niet breken).

## 26. Security/privacy

VIEWER blijft read-only (bestaand patroon, geen wijziging nodig — een
werkbak is sowieso alleen-lezen). Geen nieuwe IDOR-oppervlakte: alle
voorgestelde queries zijn scoped op de ingelogde gebruiker zelf
(assignedToId/ownerUserId), identiek aan bestaande patronen. Geen
e-mail/call-PII wordt toegevoegd (die secties worden juist NIET gebouwd
in 6A, zie §5). Geen nieuwe persoonsgegevens-duplicatie.

## 27. Prioriteitenlijst (max. 10)

| # | Verbetering | Dagelijkse waarde | Complexiteit | Risico | Afhankelijkheden | Bouwstenen | Advies |
|---|---|---|---|---|---|---|---|
| 1 | Mijn Werk — taken/afspraken/aandacht-lijst op dashboard | Zeer hoog | M | Laag | geen | Task/Appointment/Opportunity services + attention engine, alle al bestaand | **Nu (Phase 6A)** |
| 2 | Taken-lijst i.p.v. alleen telling op dashboard | Hoog | S | Laag | geen | onderdeel van #1 | **Nu (Phase 6A)** |
| 3 | "Vandaag"-afspraken-filter | Hoog | S | Laag | geen | onderdeel van #1 | **Nu (Phase 6A)** |
| 4 | "Maak taak" vanuit een timeline-item (call/e-mail) | Middel-hoog | S–M | Laag | geen | bestaande createTask()/createNote() | Later (6B) |
| 5 | "Mijn klanten"/niet-toegewezen klanten-weergave | Middel | S | Laag | geen | analoog aan bestaand ownerUserId-patroon | Later (6B) |
| 6 | `tel:`/`mailto:`-links op call-/e-mailrecords | Laag-middel | XS/S | Zeer laag | geen | puur presentatie | Later, snelle losse fix |
| 7 | Appointment-reminders (reminderAt-veld, zoals Task) | Middel | S | Laag | geen | schema-additie, geen notificatiesysteem | Later (6B) |
| 8 | Notitie-pinning | Laag-middel | S | Laag | geen | schema-additie (`isPinned`) | Later |
| 9 | Notitie-zoeken in command palette | Laag-middel | S–M | Laag | geen | bestaand zoek-patroon | Later |
| 10 | Trigram/GIN-index op bestaande ILIKE-kolommen | Laag (nu), hoog (bij groei) | S | Zeer laag | geen | infra-only, geen UI | Later, bij bewezen volume |

**Niet doen**: Exact-integratie (harde externe blocker), externe
kalendersync (geen bewijs van noodzaak), levering/voorraad/ERP-functies
(hoort bij OfferteApp/Kassa Systeem), custom-fields-systeem (tags
volstaan), rich WYSIWYG-editor (geen bewezen dagelijkse blocker), quote-
aanmaak-quickaction (vereist nieuwe schrijf-integratie).

## 28. Gekozen volgende fase

**Phase 6A — Mijn Werk (dashboard-uitbreiding)**, exact zoals in de
opdracht als voorbeeld gegeven, maar geconcretiseerd als een uitbreiding
van het bestaande hoofddashboard — géén nieuwe route/derde dashboard
(conform §18). Deze keuze is direct bewezen door §2 (7 van 11 dagelijkse
vragen raken dit gat), vereist geen nieuwe externe integratie, geen
migratie, hergebruikt uitsluitend al bestaande, al-berekende data
(attention engine, `listUpcomingAppointments()`, Task-tellingen), en is
klein genoeg voor één gecontroleerde build (drie leesfuncties + drie
UI-secties, geen nieuwe route, geen nieuwe Prisma-modellen).

Zie `44-PHASE-6-NEXT-PHASE-ARCHITECTURE.md` voor de architectuur en
`45-PHASE-6A-BUILD-SPEC.md` voor de concrete bouwopdracht.
