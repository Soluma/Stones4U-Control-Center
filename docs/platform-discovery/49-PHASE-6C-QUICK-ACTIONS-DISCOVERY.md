# 49 — Phase 6C Discovery: Customer 360 Quick Actions & Interaction Follow-up

**Status**: Discovery, geen implementatie. Vervolg op Phase 6B
(productie-commit `21dc5e051409f7f271bb232f8d4193cd58053d35`, versie 17).
Gebaseerd op verse codebase-inventarisatie op HEAD.

## 1. Huidige Customer 360-acties

`CustomerHeader.tsx` (106-129): exact vijf bestaande knoppen — Verkoopkans/
Notitie/Taak/Afspraak/Bestand, allemaal tab-navigatielinks, geen dialoog
direct, geen `tel:`/`mailto:`, geen kopieerknop. De contactregel
(`[detailCompany, shopify.email, shopify.phone, shopify.defaultAddressSummary]`)
toont e-mail/telefoon als platte tekst, gebaseerd op live `shopify.*`-data
(niet `profile.*`) — consistent met het Shopify-identity-principe.

**Repo-brede bevestiging** (grep op `href={\`tel:` / `href={\`mailto:`):
precies **twee** treffers in de hele codebase, allebei in
`ContactsSection.tsx` (regel 131 mailto, regel 142 tel) — nergens anders.

## 2. Huidige contactpersoon-acties (Phase 4C, al gebouwd)

`ContactsSection.tsx` heeft per `CustomerContact`, wanneer aanwezig, al
**volledig**: een `mailto:`-link (131) + kopieerknop (134), een `tel:`-link
(142) + kopieerknop (145), via een lokale `copyToClipboard()`-helper
(68-70, `navigator.clipboard.writeText()`). Geen gedeeld/herbruikbaar
clipboard-component bestaat elders (`src/components/` bevat geen
`CopyButton`/`useClipboard`) — deze helper is lokaal aan dit bestand.
`ContactDialog.tsx` (create/edit-formulier) heeft geen acties, alleen
standaardvelden.

**Conclusie**: contactpersoon-niveau quick actions (bellen/mailen/
kopiëren) zijn al volledig gebouwd. Phase 6C hoeft hier niets aan toe te
voegen — alleen het `copyToClipboard`-patroon is kandidaat om te
hergebruiken (of te extraheren) voor de nieuwe plekken.

## 3. Timeline-databeschikbaarheid — kernbevinding

`TimelineItem` (`src/modules/activity/timeline.ts:20-28`) heeft **geen**
`phoneNumber`, `emailAddress`, `customerContactId` of `opportunityId`-veld
— elke producer van een `TimelineItem` verwerkt beschikbare
identiteitsdata uitsluitend tot een `title`/`summary`-string en gooit de
ruwe waarde daarna weg. Bevestigd voor zowel bel- als e-mailregels
(`timeline.ts:108-114`, `163-182`) — contactmatching (zie §5) gebeurt al
wél, maar het resultaat wordt nooit als ID doorgegeven, alleen als naam
in de tekst verwerkt.

`ActivityTimelineView.tsx` (127-149) rendert per item uitsluitend icoon/
titel/samenvatting/tijd/acteur — geen `onClick`, geen `<button>`, geen
`<a>` bestaat in dit component. Bevestigd: geen "maak taak"-actie bestaat
nu nergens op de tijdlijn.

**Daarnaast bestaan er twee aparte, rijkere componenten** die niet via
`TimelineItem` lopen: `RecentCallsBlock.tsx` en `RecentEmailsBlock.tsx`
(beide in Customer 360's Overview-tab) — deze renderen de **volledige,
niet-verlieslijdende** `TelephonyActivityItem`/`NormalizedEmailMessage`
rechtstreeks (al opgehaald server-side voor weergave, geen aparte
timeline-conversie). Dit is een belangrijk architectuuronderscheid: deze
twee blokken hebben nu al, zonder enige wijziging, toegang tot het echte
telefoonnummer/e-mailadres — de generieke tijdlijn niet.

## 4. Bel-haalbaarheid (tel:)

**CustomerProfile-niveau**: `shopify.phone` wordt al geladen en getoond
in `CustomerHeader.tsx` — een `tel:`-link toevoegen kost geen nieuwe data.

**Call-niveau** (`TelephonyActivityItem`, `adapter.ts:23-30`):
`phoneNumber` bestaat (optioneel), gevuld vanuit `call.remoteNumber` — het
tegenpartij-nummer voor dit gesprek, betrouwbaar als telefoonnummer, maar
**niet** gelabeld met een rol (bellend/gebeld). `RecentCallsBlock.tsx:23`
toont dit nummer vandaag als platte tekst — een `tel:`-link toevoegen kost
geen nieuwe data.

**`direction`**: bestaat als veldtype (`"inbound" | "outbound"`) maar
wordt **nooit** daadwerkelijk gezet — de bron levert uitsluitend
`"UNKNOWN"`, en de adapter laat dit bewust weg (expliciete
codecommentaar, `adapter.ts:95-98`). Elke richting-afhankelijke logica
("terugbellen" alleen bij inbound) is dus **niet mogelijk** — bevestigt
de opdracht se eigen §16-aanname.

## 5. Mail-haalbaarheid (mailto:)

**CustomerProfile-niveau**: `shopify.email` idem — `mailto:` toevoegen
kost geen nieuwe data.

**E-mail-niveau** (`NormalizedEmailMessage`, `types.ts:18-34`): `from`/
`to` zijn gestructureerd (`{address, name}`), elk adres al door
`normalizeEmail()` gehaald (`imap-adapter.ts:46-50`). **`direction` is
hier wél een echt, altijd-aanwezig, betrouwbaar veld** — bepaald op
IMAP-map-niveau (`INBOX` vs. de server-bevestigde `\Sent`-special-use-map
via `resolveSentMailbox()`, nooit een naam-gok), plus een extra
participant-re-validatiestap (`imap-adapter.ts:205-209`). Dit is dus
precies het tegenovergestelde betrouwbaarheidsniveau van call-`direction`
— expliciet bevestigd, niet aangenomen.

`RecentEmailsBlock.tsx` toont vandaag geen `mailto:` — alleen een
`webLink`-knop, en `webLink` is voor IMAP-berichten **altijd** `null`
(`imap-adapter.ts:235`, expliciete commentaar: "no known safe Xel webmail
deep-link pattern"). Een `mailto:`-fallback toevoegen kost geen nieuwe
data (het `from`/`to`-adres is al geladen).

## 6. Contactmatching — al bewezen, alleen niet doorgegeven

`src/modules/crm/contact-timeline.ts`'s `matchContactByEmail`/
`matchContactByPhone` (22-33): **uitsluitend exacte** genormaliseerde
match, nooit fuzzy. Bij 0 of >1 matches: `null` — nooit gegokt
(expliciete doc-comment). Archived contacten worden al vóór deze functie
uitgefilterd door de aanroeper (`timeline.ts:42-46`'s documentatie-
eis: alleen actieve contacten worden doorgegeven). Dit matching-resultaat
wordt vandaag gebruikt om een naam in een string te zetten
(`timeline.ts:114`) en daarna weggegooid — het ID zelf bereikt de
gerenderde `TimelineItem` nooit.

**Kernconclusie van deze discovery**: alle benodigde data (telefoon-
nummer, e-mailadres, exacte-contactmatch) is al 100% aanwezig en al
correct berekend, ergens in de bestaande code — Phase 6C hoeft nergens
nieuwe data op te halen, alleen bestaande, al-berekende waarden door te
geven in plaats van weg te gooien.

## 7. Task-aanmaakflow — bestaande staat

`TasksPanel.tsx`'s "Nieuwe taak"-dialoog (169-204): velden Titel
(verplicht), Toewijzen aan (verplicht, **geen standaardwaarde** — de
gebruiker moet altijd expliciet kiezen uit `/api/users/assignable`),
Prioriteit (default NORMAL), Deadline (optioneel, **geen standaardwaarde**).
Geen `customerContactId`-veld in deze UI, ondanks dat de onderliggende
service dit wél ondersteunt.

`createTask()` (`task.service.ts:21-83`): valideert
`customerContactId` altijd tegen de opgeloste `customerProfileId` via
`assertContactBelongsToCustomer()` — een cross-customer contact wordt
server-side geweigerd, ongeacht wat de client meestuurt. Bij een
`opportunityId` wordt `customerProfileId` **altijd** herleid via
`resolveCustomerProfileIdForOpportunity()`, nooit vertrouwd van de
client. Drie aanmaakroutes (customer-scoped, opportunity-scoped,
standalone), alle drie `requireWriteAccess()`-gated (VIEWER geweigerd).

**Geen bestaande relatie tussen Task en een extern event** — geen
e-mail-message-ID-veld, geen call-ID-veld. Een `callRef String?`-veld
bestaat in het schema maar is expliciet "prepared for later phases,"
ongebruikt door alle huidige code.

## 8. Event-type feasibility-tabel

| Event/kind | Identiteit beschikbaar (in bestaande, al-geladen data) | Bel? | Mail? | Taak zinvol? | Contact exact bekend? | Opportunity exact bekend? |
|---|---|---|---|---|---|---|
| `CALL` (timeline) | `call.phoneNumber` (bestaat, wordt weggegooid na title-string) | Ja | — | Ja | Alleen als `matchContactByPhone` 1 exacte match geeft (elders al berekend) | Nee — calls zijn klant-breed |
| `RecentCallsBlock`-rij | `call.phoneNumber` (direct beschikbaar, geen conversie) | Ja | — | Ja (zelfde als CALL) | Nee — dit blok doet geen contactmatching | Nee |
| `EMAIL_INBOUND`/`EMAIL_OUTBOUND` (timeline) | `participant.address` (bestaat, wordt weggegooid na title-string) | — | Ja | Ja | Alleen als `matchContactByEmail` 1 exacte match geeft (elders al berekend) | Nee — e-mails zijn klant-breed |
| `RecentEmailsBlock`-rij | `message.from`/`to` (direct beschikbaar, geen conversie) | — | Ja | Ja | Nee — dit blok doet geen contactmatching | Nee |
| `NOTE_*` | geen extern contact-adres | — | — | Twijfelachtig (notitie is zelf al de vastlegging) | n.v.t. | n.v.t. |
| `TASK_*` | n.v.t. (het is zelf al een taak) | — | — | Nee | n.v.t. | n.v.t. |
| `APPOINTMENT_*` | geen telefoon/e-mail op het item zelf | — | — | Mogelijk, geen sterk bewijs van dagelijkse waarde | n.v.t. | Mogelijk (`opportunityId` bestaat al op Appointment) |
| `QUOTE_CREATED` | geen telefoon/e-mail | — | — | Zwak — geen bewijs | n.v.t. | Alleen als quote al aan opportunity gekoppeld is |
| `SHOPIFY_ORDER`/`DRAFT_ORDER_CREATED` | geen telefoon/e-mail | — | — | Zwak — geen bewijs | n.v.t. | Alleen als order al aan opportunity gekoppeld is |
| `OPPORTUNITY_*` | n.v.t. | — | — | Zwak — Opportunity heeft al een eigen tasks-tab | n.v.t. | Ja (het event IS de opportunity) |
| `CUSTOMER_PROFILE_UPDATED`/`INVOICE`/`FILE_*` | geen telefoon/e-mail | — | — | Nee | n.v.t. | n.v.t. |

**Conclusie uit de tabel**: alleen CALL/EMAIL_INBOUND/EMAIL_OUTBOUND
(zowel op de generieke tijdlijn als in de aparte Recent-blokken) hebben
een aantoonbare, data-onderbouwde basis voor Bel/Mail/Taak-acties. Alle
overige event-types: geen actie toevoegen — geen betrouwbare identiteit,
of het event is zelf al de vastlegging (Note/Task), of er is geen
concreet bewijs van dagelijkse waarde (Appointment/Quote/Order/
Opportunity-events). Dit bevestigt en verscherpt de vooraf verwachte
scope uit de opdracht (§1: A/B/C), zonder te gokken.

## 9. RBAC/audit — bevestigd ongewijzigd

`requireUser()` (geen rolcheck) vs. `requireWriteAccess()` (ADMIN/AGENT,
VIEWER geweigerd) — ongewijzigd sinds eerdere fases. Volledige
`AuditAction`-lijst gecontroleerd: geen enkele bestaande of
klik-tracking-actie zoals `PHONE_CLICKED`/`EMAIL_CLICKED` bestaat.
