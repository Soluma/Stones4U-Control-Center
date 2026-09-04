# 50 — Phase 6C Architecture: Quick Actions & Interaction Follow-up

**Status**: Discovery/architectuur, geen implementatie. Vervolg op
`49-PHASE-6C-QUICK-ACTIONS-DISCOVERY.md`.

## 1. Drie onafhankelijke, kleine bouwstenen

Phase 6C is geen samenhangend nieuw systeem — het zijn drie losse,
onafhankelijk inzetbare toevoegingen die elk op hun eigen, al-bestaande
plek landen:

1. `tel:`/`mailto:` op `CustomerHeader.tsx` (CustomerProfile-niveau).
2. `tel:`/`mailto:` op `RecentCallsBlock.tsx`/`RecentEmailsBlock.tsx`
   (call/e-mail-niveau, rijke data al aanwezig).
3. Contextuele `tel:`/`mailto:`/"Taak maken" op de generieke
   `ActivityTimelineView.tsx` voor `CALL`/`EMAIL_INBOUND`/
   `EMAIL_OUTBOUND`-items specifiek.

Elk van de drie kan onafhankelijk gebouwd/getest worden — geen van drieën
heeft de andere twee nodig.

## 2. CustomerProfile-niveau (§1 hierboven) — triviaal

`CustomerHeader.tsx` toont `shopify.phone`/`shopify.email` al als platte
tekst. Wijziging: vervang de platte tekst door `<a href="tel:...">`/
`<a href="mailto:...">` wanneer het veld gevuld is, anders ongewijzigd
(geen tekst tonen, geen kapotte link). Geen nieuwe data, geen nieuwe
query, geen nieuwe state.

## 3. Recent-blokken-niveau (§2) — triviaal

Zelfde patroon in `RecentCallsBlock.tsx`/`RecentEmailsBlock.tsx`:
`call.phoneNumber`/`message.from.address` zijn al props op het component
— alleen de rendering wijzigt (tekst → link), geen nieuwe fetch.

## 4. Tijdlijn-niveau (§3) — het enige echte ontwerpbesluit

**Probleem** (discovery §3): `TimelineItem` heeft geen `phoneNumber`/
`emailAddress`/`customerContactId`-veld — de producer-functies in
`timeline.ts` berekenen deze waarden al (voor de title-string en voor
contactmatching), maar gooien ze daarna weg.

**Besluit**: `TimelineItem` (TypeScript-type, **geen** Prisma-schema)
uitbreiden met drie optionele velden:

```ts
export type TimelineItem = {
  // ...bestaande velden ongewijzigd...
  phoneNumber?: string;       // alleen gezet voor CALL
  participantEmail?: string;  // alleen gezet voor EMAIL_INBOUND/OUTBOUND
  customerContactId?: string | null; // alleen gezet bij exacte match (CALL/EMAIL)
};
```

Dit is een **TypeScript-interface-uitbreiding, geen schemawijziging** —
niets wordt opgeslagen, de waarden bestaan al in het geheugen op het
moment dat de `TimelineItem` wordt samengesteld
(`timeline.ts:108-114`/`163-182`), ze worden nu alleen niet meer
weggegooid. `ActivityTimelineView.tsx` toont vervolgens, uitsluitend voor
items waar deze velden gezet zijn, een compacte "Bel"/"Mail"/"Taak
maken"-actie — voor elk ander `kind` blijft de weergave exact zoals nu.

**Alternatief overwogen en afgewezen**: quick actions uitsluitend op de
Recent-blokken bouwen en de generieke tijdlijn met rust laten. Afgewezen
omdat dit een inconsistente ervaring zou geven (Overview-tab wél acties,
Activiteit-tab niet, voor exact dezelfde onderliggende gebeurtenis) en
omdat de tijdlijn al bewezen, correcte contactmatching heeft die de
Recent-blokken niet hebben — het zou zonde zijn dat werk niet te
hergebruiken.

## 5. "Taak maken" — bestaande flow hergebruiken, niet dupliceren

**Overwogen** (build-instructie §9, expliciet open gelaten):

- **Optie A — dialoog extraheren**: `TasksPanel.tsx`'s "Nieuwe
  taak"-dialoog wordt een klein, herbruikbaar component
  (`CreateTaskDialog.tsx`) met optionele prefill-props
  (`initialTitle`, `initialCustomerContactId`), gebruikt door zowel
  `TasksPanel.tsx`'s eigen "Nieuwe taak"-knop als de nieuwe quick-action-
  knoppen. Klik → dialoog opent direct, vooringevuld.
- **Optie B — navigeren met query-params**: quick action navigeert naar
  `?tab=tasks&prefillTitle=...&prefillContact=...`; `TasksPanel.tsx`
  opent zijn bestaande dialoog automatisch bij het laden van de tab, met
  die waarden. Kleinere diff (geen extractie), maar één extra
  tab-wisseling voor de gebruiker.

**Aanbeveling: Optie A.** Het doel van deze fase is expliciet
klikfrictie verminderen — Optie B lost dat maar ten dele op (nog steeds
een navigatiestap). De extractie is klein en gecontroleerd: het bestaande
formulier verhuist ongewijzigd (zelfde velden, zelfde validatie, zelfde
"geen standaard-toewijzing/geen standaard-deadline"-gedrag — zie §6)
naar een eigen component; dit is **geen tweede taakformulier**, exact het
bestaande formulier op een herbruikbare plek. `TasksPanel.tsx` zelf wordt
dunner (roept het geëxtraheerde component aan), geen gedragswijziging
voor de bestaande "Nieuwe taak"-knop.

## 6. Geen nieuwe assignee-/deadline-semantiek

Bevestigd (discovery §7): de bestaande dialoog heeft **geen**
standaard-toewijzing (gebruiker moet altijd kiezen) en **geen**
standaard-deadline. Build-instructie §19/§20 vraagt expliciet: alleen een
nieuw default-gedrag invoeren als het bestaande patroon dat al doet. Dat
is hier niet het geval — dus Phase 6C voegt **geen** auto-assign-aan-
actor en **geen** auto-deadline toe. De geëxtraheerde `CreateTaskDialog`
gedraagt zich op dit punt exact als vandaag.

## 7. Prefill-regels — samengevat

- `customerProfileId`: altijd geprefilled (de pagina is al klant-
  gescoped) — nooit onbetrouwbaar.
- `customerContactId`: alleen geprefilled wanneer de tijdlijn-item al een
  exacte match heeft (§4) — anders `null`, nooit gegokt. Op de Recent-
  blokken (geen contactmatching daar): altijd `null`.
- `opportunityId`: nooit geprefilled vanuit CALL/EMAIL — deze events zijn
  klant-breed (discovery §8-tabel), nooit betrouwbaar aan één opportunity
  te koppelen.
- `title`: vaste, korte teksten — "Terugbellen" (CALL), "E-mail opvolgen"
  (EMAIL_INBOUND/OUTBOUND). Geen onderwerp/body/gesprektekst in de titel.
  Gebruiker kan de titel in de geopende dialoog altijd nog aanpassen
  vóór opslaan (het is een prefill, geen vergrendeld veld).

## 8. Server-side validatie — geen nieuwe guard nodig

`createTask()`'s bestaande validatie (discovery §7:
`assertContactBelongsToCustomer()`, opportunity-herleiding) blijft
100% ongewijzigd de autoriteit. Een geprefilde `customerContactId` die
de client tóch zou manipuleren, wordt exact zo geweigerd als vandaag al
gebeurt voor elke andere `customerContactId`-aanroep — geen nieuwe IDOR-
oppervlakte, geen nieuwe guard.

## 9. Geen nieuwe route, geen nieuwe audit

Task-aanmaak blijft via de bestaande drie routes lopen (in dit geval:
altijd de customer-scoped route, `POST /api/customers/[id]/tasks`, want
de context is altijd Customer 360). Geen nieuwe `AuditAction` — de
bestaande `task.created`-audit + `TASK_CREATED`-Activity dekken dit al
volledig, ongeacht of de taak via de gewone knop of via een quick action
is aangemaakt.

## 10. Performance — geen nieuwe externe aanroep

Elke voorgestelde wijziging is een presentatie-/doorgeef-wijziging over
data die al server-side is opgehaald voor de huidige pagina-load — geen
enkele nieuwe Shopify-/IMAP-/TelefoonSysteem-aanroep, bevestigd per
onderdeel in §2-§4 hierboven.

## 11. Kopiëren

`ContactsSection.tsx`'s lokale `copyToClipboard()`-helper wordt
geëxtraheerd naar een klein gedeeld component/hook (bijv.
`src/lib/clipboard.ts` of een `CopyButton`-component in
`src/components/ui/`) zodat de drie nieuwe plekken (header, Recent-
blokken, tijdlijn) en de bestaande `ContactsSection.tsx` allemaal
dezelfde, ene implementatie gebruiken — geen duplicate `navigator.
clipboard.writeText()`-aanroepen verspreid over meerdere bestanden.
Triviale extractie, geen nieuwe library.

## 12. Expliciet buiten scope (en waarom)

- **SMTP/compose/templates**: geen schrijfpad naar e-mail bestaat, buiten
  scope per de opdracht.
- **PBX click-to-call**: geen schrijfpad naar TelefoonSysteem, buiten
  scope per de opdracht.
- **Needs-response/call-direction-inferentie**: data is niet betrouwbaar
  genoeg (discovery §4) — expliciet afgewezen, geen aannames.
- **Source-event-persistence op Task**: geen bestaande relatie, geen
  bewezen noodzaak voor traceability in déze fase (build-instructie §12)
  — customer/contact/opportunity-context is voldoende.
- **Taak maken vanuit Appointment/Quote/Order/Opportunity-events**: geen
  aantoonbare dagelijkse waarde gevonden in de feasibility-tabel
  (discovery §8) — bewust niet meegenomen.
- **Klantenlijst-acties (Phase 6B)**: quick actions blijven Customer
  360/tijdlijn-gescoped, geen wijziging aan `/customers`.

## 13. Geen 6C/6D-splitsing nodig

De "Taak maken vanuit tijdlijn"-functionaliteit vereist geen nieuwe
architectuur — de dialoog-extractie (§5) is een gecontroleerde, kleine
refactor van één bestaand component, geen fundamenteel andere aanpak dan
de twee triviale `tel:`/`mailto:`-toevoegingen. Er is geen
architectuurgrens die een splitsing rechtvaardigt (build-instructie §41)
— alle drie bouwstenen leveren op in één Phase 6C.
