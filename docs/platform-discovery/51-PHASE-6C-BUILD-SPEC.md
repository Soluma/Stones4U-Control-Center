# 51 — Phase 6C Build Spec: Quick Actions & Interaction Follow-up

**Status**: Build spec, geen implementatie. Vervolg op
`50-PHASE-6C-QUICK-ACTIONS-ARCHITECTURE.md`. Klaar om te bouwen na
expliciete opdracht — dit document zelf bouwt niets.

## 1. IN scope

1. **CustomerHeader.tsx**: `shopify.phone`/`shopify.email` als `tel:`/
   `mailto:`-link i.p.v. platte tekst, alleen wanneer gevuld.
2. **RecentCallsBlock.tsx**: `call.phoneNumber` als `tel:`-link.
3. **RecentEmailsBlock.tsx**: `message.from.address` (of het relevante
   tegenpartij-adres) als `mailto:`-link, naast de bestaande, ongewijzigde
   `webLink`-knop.
4. **`TimelineItem`-type-uitbreiding** (`timeline.ts`): drie nieuwe
   optionele velden — `phoneNumber?: string`, `participantEmail?: string`,
   `customerContactId?: string | null` — gevuld vanuit al-berekende
   waarden in de bestaande CALL-/EMAIL-conversiefuncties, nooit een
   nieuwe query/aanroep.
5. **ActivityTimelineView.tsx**: contextuele Bel/Mail/"Taak
   maken"-acties, uitsluitend zichtbaar op items met de nieuwe velden
   gezet (dus alleen CALL/EMAIL_INBOUND/EMAIL_OUTBOUND).
6. **`CreateTaskDialog.tsx`** (nieuw, geëxtraheerd uit
   `TasksPanel.tsx`): zelfde velden/validatie/gedrag als vandaag, plus
   twee optionele prefill-props (`initialTitle`,
   `initialCustomerContactId`). `TasksPanel.tsx`'s eigen "Nieuwe
   taak"-knop gebruikt dit component ongewijzigd verder.
7. **Gedeelde copy-helper** (`src/lib/clipboard.ts` of
   `src/components/ui/CopyButton.tsx`), geëxtraheerd uit
   `ContactsSection.tsx`'s lokale `copyToClipboard()`; gebruikt door de
   nieuwe plekken (header, Recent-blokken, tijdlijn) én, ter vervanging
   van de lokale versie, door `ContactsSection.tsx` zelf.

## 2. OUT of scope (zie architectuurdoc §12 voor motivatie)

- SMTP/compose/templates
- PBX click-to-call
- Needs-response/call-direction-inferentie
- Source-event-persistence op Task (geen nieuw veld/relatie)
- Taak maken vanuit Appointment/Quote/Order/Opportunity-events
- Klantenlijst-acties (Phase 6B blijft ongewijzigd)
- Elke vorm van AI-samenvatting
- Nieuwe `AuditAction`
- Nieuwe route

## 3. Datamodel-impact

**Geen.** Geen Prisma-schemawijziging, geen migratie. De
`TimelineItem`-uitbreiding (§1.4) is een TypeScript-interface, geen
databasewijziging.

## 4. API-impact

**Geen nieuwe route.** Task-aanmaak blijft via de bestaande
`POST /api/customers/[id]/tasks` lopen (Customer 360 is altijd
klant-gescoped). Geen wijziging aan bestaande routes.

## 5. UI-impact

Drie kleine, geïsoleerde wijzigingen (§1.1-1.3), één type-uitbreiding +
conditionele tijdlijn-rendering (§1.4-1.5), één component-extractie
(§1.6), één helper-extractie (§1.7). Geen redesign van bestaande
schermen.

## 6. RBAC

`tel:`/`mailto:`/kopiëren: zichtbaar voor elke rol inclusief VIEWER
(read/navigatie-acties, geen mutatie — bevestigt build-instructie §21).
"Taak maken": zichtbaar/uitvoerbaar volgens de bestaande
`requireWriteAccess()`-gate (ADMIN/AGENT), VIEWER ziet de actie niet of
krijgt de bestaande 403 bij een geforceerde aanroep — exact het huidige
Task-aanmaak-gedrag, geen aparte quick-action-permissie.

## 7. Audit

Geen nieuwe `AuditAction`. Task-aanmaak via een quick action genereert
exact dezelfde `task.created`-audit + `TASK_CREATED`-Activity als de
gewone "Nieuwe taak"-knop. `tel:`/`mailto:`/kopiëren-kliks genereren
**geen** Activity/AuditEvent (geen `PHONE_CLICKED`/`EMAIL_CLICKED` o.i.d.
— bevestigd, bewust niet bouwen).

## 8. Performance

Geen nieuwe externe aanroep (Shopify/IMAP/TelefoonSysteem) — elke
wijziging hergebruikt data die al voor de huidige paginalading is
opgehaald.

## 9. Tests

**Tel (build-instructie §34)**: geldig CustomerProfile-telefoonnummer →
correcte `tel:`-href; geldig CustomerContact-nummer → idem; genormaliseerd
Nederlands nummer; internationaal nummer (bevestig het bestaande
`normalizeDutchPhone()`-gedrag hier — geen nieuwe normalisatielogica,
alleen renderen van wat al aanwezig is); `null`/leeg → geen link
gerenderd (geen kapotte href); geen spaties/opmaak-rommel in de href.

**Mailto (§35)**: geldig e-mailadres → correcte `mailto:`-href; `null`/
ongeldig → geen link; geen header-injectie mogelijk via een gemanipuleerd
adres (encodeer/valideer waar nodig — bevestig dat `encodeURIComponent`
of gelijkwaardig wordt gebruikt als het adres uit externe (IMAP)
brondata komt).

**Taak vanuit tijdlijn (§36)**: CALL-item → dialoog opent met
`title="Terugbellen"`; EMAIL_INBOUND/OUTBOUND-item → `title="E-mail
opvolgen"`; klant altijd geprefilled; exacte contactmatch → contact
geprefilled; ambigue/geen match → `customerContactId=null`, nooit
gegokt; geen `opportunityId`-prefill vanuit CALL/EMAIL; toewijzing blijft
leeg (gebruiker kiest, zoals vandaag); deadline blijft leeg; geen
volledige berichttekst/gesprektekst wordt ooit opgeslagen (bevestig dat
alleen de vaste titel-string in `Task.title` terechtkomt, nooit
`message.bodyPreview`/`call.summary`).

**Security (§37)**: VIEWER ziet `tel:`/`mailto:`/kopiëren; VIEWER kan
geen taak aanmaken (bestaande 403, hergebruikt); een cross-customer
`customerContactId` in de prefill-flow wordt server-side geweigerd
(bestaande `assertContactBelongsToCustomer()` — geen nieuwe test-
logica nodig, alleen bevestigen dat het geëxtraheerde dialoogcomponent
nog steeds via dezelfde, ongewijzigde service-aanroep loopt); geen
verborgen privilege-bypass via prefill-query-params/props.

**Regressie (§38)**: Customer 360, ContactsSection (met de nieuw-
geëxtraheerde copy-helper — gedrag ongewijzigd), Activity-tijdlijn
(overige kinds ongewijzigd gerenderd), e-mail-/call-blokken, bestaande
"Nieuwe taak"-knop op `TasksPanel.tsx` (ongewijzigd gedrag via het
geëxtraheerde component), Task-detail, CustomerContact-matching,
Opportunity-relatie, Mijn Werk, Mijn klanten, command palette, RBAC.

## 10. Staging E2E-plan

Zelfde gevestigde patroon (tijdelijke gebruikers, synthetische
`CustomerProfile`/`CustomerContact`/`Task`-rijen — geen echte
Shopify-klant nodig voor de meeste scenario's, aangezien dit
presentatie-/prefill-only is over al-lokale data). Scenario's:

- A. klant met telefoon+e-mail → beide links aanwezig op header.
- B. klant zonder telefoon → geen tel-link, geen kapotte href.
- C. klant zonder e-mail → geen mailto-link.
- D. contactpersoon met telefoon+e-mail → bestaand gedrag (regressie,
  ongewijzigd).
- E. CALL-tijdlijn-item met bekend nummer → Bel-actie zichtbaar.
- F. EMAIL_INBOUND-item → Mail-actie zichtbaar, `direction`-gebaseerd
  correct.
- G. EMAIL_OUTBOUND-item → idem.
- H. "Taak maken" vanuit een CALL-item → dialoog met correcte prefill.
- I. "Taak maken" vanuit een EMAIL-item → idem.
- J. exacte contactmatch → contact geprefilled in de dialoog.
- K. geen/ambigue match → `customerContactId` blijft leeg, geen gok.
- L. VIEWER → ziet Bel/Mail/kopiëren, geen "Taak maken"-optie
  (of 403 bij geforceerde aanroep).
- M. gemanipuleerde cross-customer `customerContactId` via de prefill-
  flow → server weigert (bestaande guard).
- N. geen extra externe aanroepen tijdens het renderen van deze acties
  (bevestig via request-logging tijdens de paginalading, geen nieuwe
  Shopify/IMAP/TelefoonSysteem-aanroep).
- O. cleanup — alle synthetische data + testgebruikers verwijderd,
  geverifieerd.

## 11. Openstaande beslissingen bij bouw (geen architectuurwijziging)

- Exacte bestandslocatie van de gedeelde copy-helper
  (`src/lib/clipboard.ts` vs. een `CopyButton`-component) —
  functioneel equivalent.
- Exacte iconkeuze voor de tijdlijn-acties (Phone/Mail/CheckSquare uit
  `lucide-react`, al gebruikt elders in de app) — presentatiedetail.
