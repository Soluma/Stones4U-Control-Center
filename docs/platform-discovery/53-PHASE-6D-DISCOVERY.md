# 53 — Phase 6D Discovery: Notitie-pinning ("Belangrijke notitie")

**Status**: Discovery, geen implementatie. Vervolg op
`52-POST-PHASE-6-PRIORITY-REVIEW.md` §17-18. Gebaseerd op een verse
inventarisatie van de actuele Notes-code op HEAD
(`574b2f225cab1e824a61e9e02e790c9df3157ab5`).

## 1. Probleemstelling

`Note` (`prisma/schema.prisma:313-333`) heeft geen enkel veld dat
prioriteit/belang uitdrukt. `listNotesForCustomer()`
(`note.service.ts:23-29`) sorteert uitsluitend `orderBy: { createdAt:
"desc" }`. Een notitie als "klant betaalt altijd op rekening, nooit
vooruit" of "nooit voor 10 uur bellen, werkt 's nachts" heeft dezelfde
zichtbaarheid als de meest recente, mogelijk triviale notitie — en
verdwijnt zodra er meer notities bijkomen. Dit is het enige punt dat in
drie onafhankelijke hoeken van de Phase 6-discovery boven kwam (doc 43
§2 vraag 11 "wat moet mijn collega weten", §15 Notities, §16 Customer
flags/important info) — sterker onderbouwd dan elke andere resterende
kandidaat (zie doc 52 §4).

## 2. Huidige staat — feitelijk, uit code

- **Model**: `Note` heeft `bodyJson`/`bodyText`/`tags: String[]`/
  `editedAt`/`deletedAt` (soft-delete) — geen `isPinned` of
  vergelijkbaar veld.
- **Service**: `note.service.ts` — `listNotesForCustomer()`,
  `listNotesForOpportunity()` (beide `createdAt desc`, geen andere
  sorteeroptie), `createNote()`, `updateNote()` (vereist altijd
  `bodyPlainText`, geen partial-update-pad), `deleteNote()` (soft-delete
  via `deletedAt`).
- **Permissies**: `assertCanModifyNote()` — alleen de auteur of ADMIN mag
  een notitie **bewerken/verwijderen** (inhoudelijke wijziging,
  ownership-gebaseerd). Dit is een ander soort actie dan "markeren als
  belangrijk" (zie architectuurdoc §3 voor de afweging).
- **API**: `PATCH /api/notes/[id]` — schema vereist `bodyPlainText`
  (`.min(1)`), niet optioneel. Een pin-toggle kan dus niet zomaar in dit
  bestaande schema meeliften zonder de content-verplichting los te
  koppelen (zie architectuurdoc §4).
- **UI**: `NotesPanel.tsx` (client component, hergebruikt voor zowel
  klant- als opportunity-scoped notities) — rendert notities in
  volgorde van de service, met bewerken/verwijderen-iconen wanneer
  `canEdit`.
- **Activity/audit**: `note.created`/`note.updated`/`note.deleted` zijn
  de enige bestaande `AuditAction`-waarden voor Note; `NOTE_CREATED`/
  `NOTE_UPDATED`/`NOTE_DELETED` de enige Activity-kinds
  (`ActivityTimelineView.tsx` `KIND_STYLE`).
- **Vergelijkbaar precedent elders**: `customer_tag.assigned`/
  `unassigned` (`customer-tag.service.ts`) — een losstaande, kleine
  toggle-actie die **wel** een audit-rij schrijft maar **geen**
  Activity-tijdlijn-item aanmaakt (voorkomt tijdlijn-ruis voor een
  zuivere zichtbaarheids-/organisatie-actie, geen inhoudelijke
  wijziging). Direct herbruikbaar patroon voor pinning (zie
  architectuurdoc §5).

## 3. Wat ontbreekt precies

Geen enkele manier om:
1. Een notitie te markeren als "belangrijk"/"vastgezet".
2. Vastgezette notities apart/bovenaan te tonen.
3. In één oogopslag (zonder scrollen door de volledige geschiedenis) te
   zien wat een collega moet weten over een klant.

## 4. Wat NIET het probleem is (bewust afgebakend)

- **Geen WYSIWYG-editor-tekort** — de bestaande markdown-subset-textarea
  is functioneel voldoende voor dagelijkse klantafspraken (bold/italic/
  lijsten werken al); geen bewijs dat dit een blocker is (doc 43 §15,
  ongewijzigd).
- **Geen edit-historie-tekort** — `editedAt` (een simpele vlag) volstaat
  vandaag; geen bewijs van een "wie heeft dit gewijzigd"-incident.
- **Geen zichtbaarheidscontrole (privé/team)-tekort** — geen enkel
  gebruikssignaal dat sommige notities voor sommige rollen verborgen
  moeten zijn; alle rollen die een klant mogen zien, mogen vandaag ook
  alle notities van die klant zien, zonder incident. Niet toevoegen.
- **Geen custom-fields-systeem nodig** — tags dekken korte labels,
  pinning dekt vrije-tekst-context; samen is dat voldoende (doc 52 §13).

## 5. Duplicatie-check

Geen enkele sibling-app (`OfferteApp`, `s4u-quote-app`, `Kassa Systeem`,
`TelefoonSysteem`) heeft een notitie-concept dat dit zou dupliceren —
`Note` is en blijft 100% Control-Center-owned (ADR-003, ongewijzigd).
Pinning is een puur presentatie-/organisatie-kenmerk op een reeds
eigen model, geen nieuwe cross-app-afhankelijkheid.

## 6. Scope-afbakening

Uitsluitend de bestaande Notes-tab op Customer 360 (en de opportunity-
scoped variant, zelfde component). **Geen** wijziging aan CustomerHeader/
Overview-tab om een vastgezette notitie daar te tonen — dat zou een
tweede scherm raken (zelfde discipline als elke eerdere fase: klein en
gecontroleerd houden). Genoemd als mogelijke toekomstige losse
vervolgstap, niet gebundeld nu.

## 7. Conclusie

Klein, bewezen, single-screen, geen externe afhankelijkheid, één
additieve kolom. Zie `54-PHASE-6D-ARCHITECTURE.md` voor de architectuur
en `55-PHASE-6D-BUILD-SPEC.md` voor de concrete bouwopdracht.

**PHASE 6D READY FOR ARCHITECTURE: YES**
