# 52 — Post-Phase-6 Priority Review

**Status**: Discovery/beslisdocument, geen implementatie. Herbeoordeelt
`43-PHASE-6-CRM-WORKFLOW-DISCOVERY.md` en `44-PHASE-6-NEXT-PHASE-
ARCHITECTURE.md` tegen de daadwerkelijk gebouwde en productie-live staat
na Phase 6A/6B/6C (HEAD `574b2f225cab1e824a61e9e02e790c9df3157ab5`,
production versie 18). Elke bevinding hieronder is geverifieerd tegen de
huidige code, niet tegen de oude discovery-aannames.

## 1. Oorspronkelijke Phase 6 top-10 (doc 43 §27) — herbeoordeeld

| # | Verbetering | Oorspronkelijke status | Huidige status | Opgelost door | Nog open? | Dagelijkse waarde nu | Complexiteit nu | Advies |
|---|---|---|---|---|---|---|---|---|
| 1 | Mijn Werk — taken/afspraken/aandacht-lijst op dashboard | Nu (6A) | **Live** — `src/modules/dashboard/my-work.ts`, drie functies (`getMyWorkTasks`/`getMyWorkAppointments`/`getMyWorkOpportunityAttention`), op het hoofddashboard | **Phase 6A** | Nee | — | — | Opgelost |
| 2 | Taken-lijst i.p.v. alleen telling | Nu (6A) | **Live** — `MyWorkTasksList.tsx`, overdue/due-today, cap 10 | **Phase 6A** | Nee | — | — | Opgelost |
| 3 | "Vandaag"-afspraken-filter | Nu (6A) | **Live, maar beperkt** — `getMyWorkAppointments()` toont alleen vandaag, alleen eigen afspraken (ook voor ADMIN, bewust geen team-modus), cap 10, geen aparte agenda-route | **Phase 6A** | **Gedeeltelijk** — zie §7 hieronder | Laag (bestaande oplossing volstaat, geen bewijs van tekort) | — | Blijft zo, geen agenda-uitbreiding nu |
| 4 | "Maak taak" vanuit een timeline-item (call/e-mail) | Later (6B) | **Live** — `ActivityTimelineView.tsx` contextuele Bel/Mail/"Taak maken"-acties via `CreateTaskDialog.tsx` | **Phase 6C** | Nee | — | — | Opgelost |
| 5 | "Mijn klanten"/niet-toegewezen klanten-weergave | Later (6B) | **Live** — `/customers` met Mine/Unassigned/All-tabs + "Aan mij toewijzen" (concurrency-safe) | **Phase 6B** | Nee | — | — | Opgelost |
| 6 | `tel:`/`mailto:`-links op call-/e-mailrecords | Later, snelle losse fix | **Live** — `buildTelHref()`/`buildMailtoHref()`, CustomerHeader + RecentCallsBlock + RecentEmailsBlock + tijdlijn | **Phase 6C** | Nee | — | — | Opgelost |
| 7 | Appointment-reminders (`reminderAt`-veld) | Later (6B) | **Nog steeds afwezig** — `prisma/schema.prisma` Appointment-model heeft geen `reminderAt`; geen notificatiesysteem elders bijgekomen | Niemand | **Ja** | Laag-middel (geen bewijs van een gemiste-afspraak-incident) | S (schema-additie) | **Later** — geen bewijs van dagelijkse blocker |
| 8 | Notitie-pinning | Later | **Nog steeds afwezig** — `Note`-model heeft geen `isPinned`/vergelijkbaar veld, sortering is uitsluitend `createdAt desc` | Niemand | **Ja** | **Hoog** — zie §4/§7 | **S** | **NU — gekozen (Phase 6D, zie §17-18)** |
| 9 | Notitie-zoeken in command palette | Later | **Nog steeds afwezig** — `/api/search/route.ts` doorzoekt customers/tasks/orders/quotes/opportunities/contacts, geen notes-groep | Niemand | **Ja** | Middel | S–M | **Later** — reëel maar minder urgent dan pinning (zie §13) |
| 10 | Trigram/GIN-index op ILIKE-kolommen | Later, bij bewezen volume | **Nog steeds niet nodig** — productie heeft vandaag 3 `CustomerProfile`-rijen, 0 taken, 0 opportunities (zie Phase 6C-productie-rollout-DB-baseline) | Niemand | **Ja, maar niet urgent** | Laag (geen huidig probleem) | S (infra-only) | **Later, bij bewezen groei** |

**Samenvatting**: 6 van de 10 oorspronkelijke punten zijn opgelost (6A: #1/#2/#3-gedeeltelijk;
6B: #5; 6C: #4/#6). De 3 resterende "Later"-punten (#8/#9/#10) blijven
open, plus #7 dat nooit is opgepakt. Geen van de drie gebouwde fases
heeft een nieuw probleem geïntroduceerd dat niet al in doc 43 stond.

## 2. Hercontrole van de actuele code (niet aangenomen, per gebied geverifieerd)

- **Dashboard/Mijn Werk**: `src/modules/dashboard/my-work.ts` bevestigd
  — drie pure leesfuncties, actor-scoped, geen team-breed modus (bewuste
  keuze, build-instructie §0.3/§4 van Phase 6A), cap 10 per lijst.
- **Mijn Klanten**: `listCustomerProfiles()`
  (`customer-profile.service.ts:89-116`) bevestigd — uitsluitend
  `scope: mine|unassigned|all`, **geen** accountmanager-specifieke
  filter-parameter, geen bulk-mutatie-functie aanwezig. Exact zoals doc
  48 §2 als "OUT of scope" vastlegde — niets stiekem toegevoegd sindsdien.
- **Customer 360**: 19+ componenten, header-quickacties nu inclusief
  `tel:`/`mailto:`/kopiëren (Phase 6C), Contacts/Tasks/Notes/
  Appointments/Files-tabs ongewijzigd van structuur.
- **Activity**: `ActivityTimelineView.tsx` bevestigd — contextuele
  Bel/Mail/"Taak maken" nu aanwezig op CALL/EMAIL_INBOUND/
  EMAIL_OUTBOUND-items (Phase 6C), overige kinds ongewijzigd.
- **Tasks**: model ongewijzigd sinds doc 43 — geen snooze/recurring/
  bulk-acties bijgekomen, `dueAt` blijft datum-only.
- **Appointments**: **geen** `src/app/(app)/appointments/`-route bestaat
  — bevestigd via directory-scan. Nog steeds geen agenda-pagina, geen
  appointment-detailpagina, geen Vandaag/Week/medewerker/klant-filter
  buiten wat Mijn Werk (6A) al toont. `reminderAt` bevestigd afwezig in
  `prisma/schema.prisma`.
- **Notes**: `note.service.ts` bevestigd — `listNotesForCustomer()`
  sorteert uitsluitend `orderBy: { createdAt: "desc" }`, geen
  `isPinned`/zichtbaarheids-veld in het `Note`-model
  (`prisma/schema.prisma:313-333`).
- **Opportunities/attention**: `attention.ts` bevestigd ongewijzigd —
  `shopifyOrderPlacedSignal`/`quoteAheadOfStageSignal` blijven
  "Detail-page-only BLUE signals" (regel 176-commentaar, ongewijzigd).
  `opportunity.service.ts`'s `attachAttention()` laadt ze nog steeds
  niet — BLUE blijft structureel onbereikbaar in elk aggregate pad
  (pipeline, dashboard, Mijn Werk), exact zoals vastgesteld tijdens de
  Phase 6A final review.
- **Accountmanager**: `accountManagerId` ongewijzigd een enkel veld,
  geen workload/territory-concept bijgekomen.
- **E-mail**: read-only bevestigd ongewijzigd, geen SMTP/send-code.
  `direction` blijft betrouwbaar (IMAP-folder-afgeleid) — ongewijzigd
  sinds Phase 3C.
- **Calls**: `src/integrations/telephony/adapter.ts:18/96` bevestigd —
  `direction` blijft altijd `"UNKNOWN"` bij de bron, expliciete
  code-comment ongewijzigd. Geen richting-inferentie toegevoegd.
- **Quotes**: geen `validUntil`-veld bijgekomen in de externe bronnen
  (buiten deze repo's bereik, ongewijzigd blocker).
- **Search**: `/api/search/route.ts` bevestigd — customers/tasks/orders/
  quotes/opportunities/contacts, geen notes-groep, geen e-mailinhoud
  (bewust, ongewijzigd).
- **Command palette**: geen structurele wijziging sinds doc 43.
- **RBAC/audit**: `requireWriteAccess()`/`requireUser()` ongewijzigd
  centraal, `AuditAction`-unie uitgebreid met Phase 6B/6C-acties (geen
  nieuwe voor Phase 6C zelf — quick actions genereren bewust geen audit).

## 3. Herbeoordeling van de 11 dagelijkse werkvragen (doc 43 §2)

| Vraag | Status ná Phase 6 (was in doc 43) | Onderbouwing |
|---|---|---|
| Wie moet ik vandaag bellen? | **Nog steeds niet beantwoord** (was: niet beantwoord) | Geen cross-klant call-actielijst; Mijn Werk toont taken/afspraken/opportunities, geen "bel deze klanten vandaag"-signaal — dat zou "needs response"-achtige data vereisen, bewust niet gebouwd (§10 hieronder) |
| Welke klanten wachten op antwoord? | **Nog steeds niet beantwoord** (was: niet beantwoord) | Geen wijziging aan de onderliggende data — zie §10 |
| Welke offertes moet ik opvolgen? | **Deels** (ongewijzigd) | `QUOTE_AHEAD_OF_STAGE` blijft het enige signaal, geen `validUntil` |
| Welke afspraken heb ik vandaag? | **Goed opgelost** (was: deels) | Mijn Werk toont nu een expliciete, gefilterde "vandaag"-lijst i.p.v. een vaste top-5 |
| Welke taken zijn te laat? | **Goed opgelost** (was: deels) | Mijn Werk toont nu de daadwerkelijke lijst met titels/links, niet alleen een telling |
| Welke verkoopkansen zijn stilgevallen? | **Goed opgelost** (ongewijzigd) | Attention engine + dashboard + pipeline + nu ook Mijn Werk |
| Welke klant heeft onlangs gebeld/gemaild? | **Alleen per klant** (ongewijzigd) | Geen cross-klant weergave; wel nu met directe `tel:`/`mailto:`/"Taak maken" per record (Phase 6C) — de vraag zelf blijft per-klant beantwoord, niet cross-klant |
| Wat heb ik zelf beloofd aan een klant? | **Deels, via Tasks** (ongewijzigd) | Geen apart "belofte"-concept, maar "Taak maken" vanuit een gesprek/e-mail (6C) maakt het makkelijker om een belofte meteen vast te leggen |
| Welke klanten hebben nog openstaande acties? | **Opportunity-niveau ja, klant-niveau nee** (ongewijzigd) | Geen generieke rollup op klantniveau — Mijn Klanten (6B) toont toewijzing, niet "openstaande acties per klant" |
| Wat is de laatste interactie? | **Goed opgelost, per klant** (ongewijzigd) | ActivityTimelineView, nu met quick actions; niet cross-klant |
| Wat moet mijn collega weten? | **Nog steeds deels, via Notes** (ongewijzigd) | Geen handoff-specifiek mechanisme — dit is precies het gat dat notitie-pinning zou dichten (zie §4) |

**Netto-effect van 6A/6B/6C**: van de 11 vragen zijn er 2 verbeterd van
"deels" naar "goed opgelost" (afspraken-vandaag, taken-te-laat — beide
door Mijn Werk). De overige 9 zijn ongewijzigd. Geen enkele vraag is
verslechterd.

## 4. Werkelijke dagelijkse frictie (niet "hoort bij een CRM")

Toegepast op de resterende, nog-open candidates — alleen frictie met
concreet bewijs (veel klikken, informatie die iemand moet onthouden,
verspreide informatie, niet-actionable data, dagelijks herhaalde
handelingen):

- **"Wat moet mijn collega weten over deze klant"** — een reëel,
  driemaal onafhankelijk genoemd gat (doc 43 §2 vraag 11, §15, §16) —
  vandaag staat belangrijke informatie ergens tussen mogelijk tientallen
  chronologische notities begraven; een nieuwe medewerker die een klant
  voor het eerst opent moet de hele geschiedenis lezen om te weten "deze
  klant betaalt altijd op rekening" of "nooit voor 10 uur bellen".
  **Sterkste resterende frictie-bewijs van alle candidates.**
- **Notitie-zoeken**: reëel maar minder frequent — "ik weet dat we iets
  genoteerd hebben, maar niet meer bij welke klant" is een incidenteel
  recall-probleem, geen dagelijks-herhaalde handeling.
- **Appointment-agenda**: geen concreet frictiebewijs gevonden — Mijn
  Werk lost "vandaag" al op; er is geen aanwijzing dat medewerkers een
  weekoverzicht missen (doc 43 §9 bevestigde dit al, ongewijzigd).
- **Accountmanager-vervolg (ADMIN-filter/bulk)**: geen dagelijks-
  frictiebewijs voor de AGENT-rol (de primaire dagelijkse gebruiker);
  eerder een incidentele ADMIN-taak.
- **BLUE-commerciële-signalen**: potentieel waardevol maar **geen
  gemeten frictie** — niemand heeft aantoonbaar een gemiste "bestelling
  geplaatst, markeer als gewonnen"-kans gerapporteerd; de huidige
  RED/ORANGE-signalen dekken de acute gevallen al.

## 5. Trigram/index

Ongewijzigd: geen huidig probleem (3 klanten, 0 taken, 0 opportunities
in productie). Blijft "Later, bij bewezen groei" — geen actie nu.

## 6. Exact/accounting

Ongewijzigd **BLOCKED** — externe auth-blokkade bij TelefoonSysteem's
`customer-history-db`-toegang, niet oplosbaar vanuit deze repo (CLAUDE.md
verbiedt expliciet een workaround). Niet opnieuw aanbevolen alsof dit nu
plots eenvoudig is — het is dat niet.

## 7. Appointments/agenda — herbeoordeeld

Mijn Werk (6A) toont "vandaag, aan mij toegewezen" — dit dekt de
oorspronkelijk belangrijkste vraag ("welke afspraken heb ik vandaag")
goed genoeg. Een volwaardige Vandaag/Week/medewerker/klant-agenda met een
eigen route en afspraakdetail-pagina zou M/L-complexiteit zijn (nieuwe
route, filterlogica, mogelijk een kalenderweergave-component) zonder
concreet bewijs van een resterende dagelijkse blocker. **Advies: niet nu
bouwen.** Reminders (`reminderAt`) blijven om dezelfde reden ongebouwd —
geen incident, geen vraag hiernaar.

## 8. Notes — herbeoordeeld

Zie §4. Rich-text-opslag + markdown-subset-editor blijft functioneel
voldoende (geen bewijs van een WYSIWYG-blocker). Het enige aantoonbare
tekort is **geen manier om een notitie prioriteit te geven** — vandaar de
keuze voor Phase 6D (§17-18).

## 9. Mijn Klanten vervolg — herbeoordeeld

Onderzocht: (a) filter op specifieke accountmanager, (b) inactive-
accountmanager-filter (al gedekt — inactieve managers blijven zichtbaar
met een indicator, Phase 6B), (c) bulk-toewijzing, (d) "mijn klanten met
aandacht". Geen van deze heeft een concreet dagelijks-frictiebewijs voor
de AGENT-rol; (a) en (c) zijn primair ADMIN-gemak, geen dagelijkse
AGENT-blocker. (d) zou een nieuwe join tussen Mijn Klanten en Mijn Werk
vereisen — mogelijk waardevol later, maar geen bewijs dat het huidige
gebrek daaraan vandaag pijn doet (Mijn Werk toont al aandacht-vragende
opportunities/taken; het enige extra zou "klanten zonder open taak/kans
die al lang niet benaderd zijn" zijn — een aanname, geen waargenomen
probleem). **Advies: niet nu, geen van de vier.**

## 10. Commercial BLUE signals — herbeoordeeld

"Batched commercial opportunity signals" blijft technisch open (§2
hierboven, ongewijzigd sinds Phase 6A). Concreet: welke waarde levert het
op?
- Shopify completed-order-signal in aggregate views: zou een verkoper
  waarschuwen "deze opportunity heeft al een voltooide bestelling,
  waarschijnlijk gewonnen" zonder de opportunity individueel te hoeven
  openen — nuttig, maar de verkoper opent een actieve opportunity
  sowieso regelmatig (impliciet al zichtbaar via RED/ORANGE en de
  bestaande Commercieel-tab).
- Quote-ahead-of-stage-signal in aggregate views: idem, al deels gedekt
  door de detail-pagina.

Architectuur die dit zou vereisen: een nieuwe, gebatchte, multi-klant/
multi-opportunity live-ophaalcapaciteit richting Shopify én de
quote-adapters (nooit één aanroep per kaart) — een **L**-project, een
eigen discovery/architectuur/build-spec-traject, geen "kleine volgende
fase". Gegeven **geen gemeten dagelijkse frictie** (§4) en de expliciete
instructie om dit niet automatisch te kiezen alleen omdat het technisch
openstaat: **niet gekozen als Phase 6D**. Blijft een legitieme, apart te
plannen toekomstige fase (zie §16, kandidaat #8).

## 11. Email/call follow-up — herbeoordeeld

Bronnen ongewijzigd sinds Phase 6C (§2 hierboven — e-mail-richting
betrouwbaar, call-richting nog steeds `UNKNOWN` bij de bron). Geen
nieuwe brondata beschikbaar gekomen. "Needs response" blijft **OUT** —
niet bouwbaar op onbetrouwbare aannames, ongewijzigd advies.

## 12. Call follow-up — herbeoordeeld

Zoals §11 — bron ongewijzigd, geen richting-inferentie toevoegen.

## 13. Customer flags/important info — herbeoordeeld

Tags (bestaand, vrije tekst + kleur) dekken korte labels goed ("Let op",
"Betaalt op rekening"). Wat ontbreekt is een manier om **langere,
vrije-tekst context** (een zin of alinea, niet een label) prominent te
tonen — dat is precies wat notitie-pinning oplost, zonder een nieuw
custom-fields-systeem. **Bewijsgebaseerde aanbeveling: notitie-pinning,
geen apart flags-systeem** (bevestigt doc 43 §16, nu met een concrete
implementatiekeuze — zie doc 53-55).

## 14. Global search — herbeoordeeld

Notitie-zoeken blijft afwezig (§2). Reële waarde, maar §4 laat zien dat
dit minder frequent-dagelijks is dan pinning. Privacy/performance-
afweging: notitie-tekst bevat mogelijk gevoeligere vrije-tekst-inhoud dan
titels/namen (de huidige doorzochte velden) — een notitie-zoekfunctie
zou zorgvuldiger RBAC-scoping verdienen dan de huidige groepen (bijv.
moet een VIEWER notitie-inhoud kunnen doorzoeken die ze toch al mogen
lezen op Customer 360? Waarschijnlijk ja, geen nieuw risico, maar wel een
expliciete check waard bij bouw). Geen e-mailinhoud-zoeken — blijft
bewust uitgesloten (ADR-008/build spec, ongewijzigd). **Advies: LATER**,
na Phase 6D.

## 15. Exact/accounting — zie §6 (ongewijzigd BLOCKED)

## 16. Order/delivery — domeingrens

Ongewijzigd: levering/transport/voorraad blijven eigendom van OfferteApp/
Kassa Systeem. Geen adapter, geen duplicatie voorgesteld. Geen candidate
hieruit voor Phase 6D.

## 17. Resterende kandidaten — gerangschikt (max. 8)

| # | Kandidaat | Concreet probleem | Huidige workaround | Dagelijkse waarde | Frequentie | Complexiteit | Risico | Externe dependency | Schema nodig? | Advies |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **Notitie-pinning** | Belangrijke klantinfo verdwijnt in chronologische notitie-geschiedenis | Handmatig scrollen/onthouden, of een tag als workaround | **Hoog** | Dagelijks (elke keer een klant met een "let op"-notitie geopend wordt) | **S** | Zeer laag | Geen | Ja — één kolom (`isPinned Boolean`), additief | **NU (Phase 6D)** |
| 2 | Notitie-zoeken in command palette | Kan een notitie niet terugvinden zonder te weten bij welke klant | Handmatig door klanten heen klikken | Middel | Incidenteel | S–M | Laag | Geen | Nee | **Later** |
| 3 | Batched commercial opportunity signals (BLUE) | Bestelling/offerte-signalen alleen zichtbaar op de opportunity-detailpagina, niet in aggregate views | Opportunity individueel openen | Middel (ongemeten) | Onbekend, waarschijnlijk laag-middel | **L** | Middel (nieuwe externe-aanroep-architectuur) | Ja (Shopify + quote-adapters, gebatcht) | Nee | **Later** — eigen traject |
| 4 | Appointment-reminders (`reminderAt`) | Geen herinnering vóór een afspraak | Medewerker onthoudt het zelf | Laag-middel (geen incident) | Onbekend | S | Laag | Geen | Ja — één kolom, additief | **Later** |
| 5 | Volwaardige agenda (Vandaag/Week/medewerker/klant) | Geen weekoverzicht, geen aparte agenda-pagina | Mijn Werk (vandaag) + per-klant-tab | Laag (Mijn Werk dekt het acute geval al) | Onbekend | M | Laag | Geen | Nee | **Later** |
| 6 | Mijn Klanten: ADMIN-medewerkerfilter + bulk-toewijzing | ADMIN kan niet filteren op specifieke medewerker of in bulk herverdelen | Individueel per klant toewijzen | Laag (ADMIN-gemak, geen AGENT-dagelijkse blocker) | Incidenteel | S–M | Laag | Geen | Nee | **Later** |
| 7 | Trigram/GIN-index op zoekkolommen | Ongeïndexeerde `ILIKE`-scans | Werkt prima bij huidig volume | Laag nu | N.v.t. | S (infra) | Zeer laag | Geen | Nee (index, geen schema-tabelwijziging) | **Later, bij bewezen groei** |
| 8 | "Mijn klanten met aandacht" (join Mijn Klanten × Mijn Werk) | Geen gecombineerd "welke van mijn klanten heeft nu iets nodig"-overzicht | Los door Mijn Werk (taken/afspraken/kansen) én Mijn Klanten heen kijken | Laag-middel (ongemeten) | Onbekend | S–M | Laag | Geen | Nee | **Later** |

**Niet doen (ongewijzigd)**: Exact-integratie (harde externe blocker),
externe kalendersync, levering/voorraad/ERP-functies, custom-
fields-systeem, rich WYSIWYG-editor, quote-aanmaak-quickaction,
"needs response"-signaal op onbetrouwbare data, call-richting-inferentie.

## 18. Gekozen volgende fase

**Phase 6D — Notitie-pinning ("Belangrijke notitie")**. Blijft
onmiskenbaar binnen de bestaande dagelijkse-workflow-scope (Notes-domein
op Customer 360), dus **6D**, geen 7A.

Criteria-toets:
1. **Hoge dagelijkse Stones4U-waarde**: enige candidate met concreet,
   drievoudig onderbouwd frictiebewijs (§4/§13) — niet een aanname.
2. **Huidige workflow aantoonbaar incompleet**: bevestigd via code
   (§2/§8) — geen `isPinned`-veld, geen prioriteitsmechanisme,
   uitsluitend chronologische sortering.
3. **Klein genoeg voor één build**: **S** — één additieve kolom, één
   kleine route, één klein UI-detail (zie doc 55).
4. **Weinig/geen externe dependencies**: geen — 100% Control-Center-
   owned `Note`-model.
5. **Geen duplicatie met sibling apps**: bevestigd — geen enkele sibling
   app heeft een notitie-concept dat dit zou dupliceren.
6. **Geen onnodig nieuw datamodel**: één kolom op een bestaand model,
   geen nieuwe tabel.
7. **Duidelijke staging-E2E mogelijk**: pin/unpin, sortering,
   RBAC/IDOR — zelfde bewezen patroon als elke eerdere fase.

### Waarom niet eerst de alternatieven

- **Notitie-zoeken (#2)**: reëel maar aantoonbaar minder frequent dan
  pinning (§4) — een logische **volgende** kleine fase na 6D, niet nu.
- **BLUE-signalen (#3)**: expliciet niet automatisch gekozen (opdracht
  §19) — **L**-complexiteit, nieuwe externe-integratie-architectuur,
  geen gemeten dagelijkse frictie. Eigen toekomstig traject.
- **Agenda/reminders (#4/#5)**: geen frictiebewijs, Mijn Werk dekt het
  acute geval al (§7).
- **Mijn Klanten-vervolg (#6/#8)**: primair ADMIN-gemak of ongemeten
  aanname, geen AGENT-dagelijkse blocker (§9).
- **Trigram-index (#7)**: geen huidig probleem (§5).

Zie `53-PHASE-6D-DISCOVERY.md`, `54-PHASE-6D-ARCHITECTURE.md`,
`55-PHASE-6D-BUILD-SPEC.md` voor de volledige uitwerking.

## Blockers

Geen. Alle bevindingen zijn geverifieerd tegen de actuele code op HEAD
(`574b2f2`), niet aangenomen vanuit oude documentatie.

---

**NEXT CRM PHASE READY TO BUILD: YES**
