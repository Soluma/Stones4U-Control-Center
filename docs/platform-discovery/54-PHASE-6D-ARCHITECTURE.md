# 54 — Phase 6D Architecture: Notitie-pinning ("Belangrijke notitie")

**Status**: Architectuur, geen implementatie. Vervolg op
`53-PHASE-6D-DISCOVERY.md`.

## 1. Datamodel

Eén additieve kolom op het bestaande `Note`-model:

```prisma
model Note {
  // ...bestaande velden ongewijzigd...
  isPinned Boolean @default(false)
  pinnedAt DateTime?
  pinnedById String?
  pinnedBy User? @relation("NotesPinned", fields: [pinnedById], references: [id])
}
```

- `isPinned`: de daadwerkelijke sorteer-/filtervlag. `@default(false)` —
  elke bestaande rij krijgt automatisch `false`, geen backfill-script
  nodig, geen breaking change voor bestaande data.
- `pinnedAt`: wanneer vastgezet — bepaalt de sortering **binnen** de
  vastgezette groep (nieuwst-vastgezet-eerst, zie §6), en geeft context
  ("vastgezet op 3 maart") in de UI.
- `pinnedById`: wie heeft vastgezet — puur informatief/audit-context in
  de UI ("vastgezet door Fons"), zelfde patroon als `authorId`/
  `assignedById` elders. Optioneel (nullable) zodat `isPinned: false`
  rijen geen dummy-waarde nodig hebben.

**Waarom geen enum/prioriteitsniveau (bijv. LOW/MEDIUM/HIGH)**: geen
bewijs van een use case die meer dan "belangrijk / niet belangrijk"
onderscheidt (discovery §4) — een boolean is de kleinst mogelijke,
correcte modellering. Uitbreidbaar later, geen huidige noodzaak.

**Migratie**: één additieve, backward-compatible migratie
(`..._phase6d_note_pinning`), drie nieuwe kolommen, alle nullable/
defaulted — geen dataverlies-risico, geen downtime, consistent met elke
eerdere additieve Phase 2-6C-migratie in dit project (bijv. Phase 4c's
`customerContactId`-additie).

## 2. Waarom geen apart "belangrijke-info"-model

Overwogen: een apart `CustomerHighlight`- of `PinnedInfo`-model,
losstaand van `Note`. Verworpen — zou een nieuwe entiteit, nieuwe CRUD,
nieuwe RBAC-laag en een tweede plek voor "belangrijke klantinfo"
introduceren, terwijl `Note` al exact het juiste content-model is
(rich-text, auteur, tijdstempel, IDOR-veilig). Pinning is een
**presentatie-/organisatie-eigenschap van een bestaande notitie**, geen
nieuw soort inhoud.

## 3. Permissiemodel — bewust anders dan content-bewerking

`assertCanModifyNote()` (auteur-of-ADMIN) blijft **ongewijzigd** en
blijft uitsluitend gelden voor inhoudelijke bewerking/verwijdering
(`updateNote()`/`deleteNote()`) — dat blijft een ownership-vraag ("mag
ik deze tekst wijzigen").

Pinnen/unpinnen is een **andere soort actie**: het curateren van wat het
hele team meteen ziet, niet het wijzigen van wie iets geschreven heeft.
Een collega die een belangrijke notitie van een ander teamlid ziet, moet
die kunnen vastzetten zonder de oorspronkelijke auteur of een ADMIN te
moeten vragen — anders wordt de functie zelf een frictiepunt. Daarom:
**`pinNote()`/`unpinNote()` gebruiken `requireWriteAccess()`
(ADMIN/AGENT), niet `assertCanModifyNote()`'s striktere auteur-gate.**
VIEWER blijft uitgesloten (consistent met elke andere mutatie in dit
systeem).

Dit is een bewuste, hier vastgelegde ontwerpkeuze — geen toevallige
versoepeling van bestaande contentbeveiliging (de tekst van de notitie
zelf blijft alleen door auteur/ADMIN wijzigbaar).

## 4. API — één kleine, nieuwe route (geen overload van de bestaande PATCH)

`PATCH /api/notes/[id]` vereist vandaag altijd `bodyPlainText`
(`.min(1)`, niet optioneel) — een pure pin-toggle zou dus ofwel de volledige
tekst opnieuw moeten meesturen (onnodig, foutgevoelig) ofwel het
bestaande schema moeten verzwakken naar "alles optioneel" (risico: een
lege `PATCH`-aanroep die per ongeluk niets valideert). Beide onwenselijk.

**Gekozen**: één nieuwe, kleine route: `PATCH
/api/notes/[id]/pin` — body `{ isPinned: boolean }`, retourneert de
bijgewerkte notitie. Analoog aan Phase 6B's `assignToSelf`-precedent
(een klein, dedicated toggle-veld op een bestaande resource, niet
gebundeld in de generieke update-route) — hier zelfs verder
losgetrokken tot een eigen sub-route, omdat pin/unpin conceptueel geen
"update van de notitie-inhoud" is.

Geen wijziging aan de bestaande `PATCH /api/notes/[id]` (content-update)
of `DELETE /api/notes/[id]`.

## 5. Activity/audit

**Geen** nieuwe Activity-tijdlijn-item (`NOTE_PINNED` o.i.d.) — pinning
is geen inhoudelijke gebeurtenis die in de klant-tijdlijn thuishoort
(zelfde redenering als tags: zie discovery §2, `customer_tag.assigned`
schrijft ook geen Activity). Een tijdlijn die elke pin/unpin toont zou
ruis toevoegen zonder waarde.

**Wel** een nieuwe, kleine audit-trail: twee nieuwe `AuditAction`-waarden,
`note.pinned`/`note.unpinned`, exact naar het bestaande
`customer_tag.assigned`/`unassigned`-patroon — `logAudit({ userId:
actor.id, action: "note.pinned", entityType: "Note", entityId: note.id,
metadata: { customerProfileId } })`.

## 6. Sortering/weergave

`listNotesForCustomer()`/`listNotesForOpportunity()` krijgen een
aangepaste `orderBy`: `[{ isPinned: "desc" }, { pinnedAt: "desc" },
{ createdAt: "desc" }]` — vastgezette notities altijd bovenaan (nieuwst-
vastgezet-eerst binnen die groep), niet-vastgezette notities daaronder
in de bestaande chronologische volgorde. Eén query, geen tweede
round-trip, geen in-memory-sortering nodig (Prisma ondersteunt
multi-key `orderBy` native).

**Geen harde cap op het aantal vastgezette notities** — een technische
limiet (bijv. "max 3") voegt edge-case-complexiteit toe (wat gebeurt er
bij het vastzetten van een vierde: foutmelding? automatisch de oudste
lospinnen?) zonder bewezen noodzaak. De sociale druk van een lange
vastgezette lijst (die zijn eigen doel ondermijnt) is voldoende — exact
zoals `CustomerTag`-toewijzingen ook geen cap hebben. Als bij bouw/
staging-E2E blijkt dat dit toch nodig is, is dat een kleine, apart te
documenteren toevoeging, geen architectuurwijziging vooraf.

## 7. UI

`NotesPanel.tsx` (bestaand, client component, hergebruikt voor klant- en
opportunity-scoped notities — geen wijziging aan die dual-scope-opzet):
- Een pin-icoon (`Pin`/`PinOff` uit `lucide-react`, al beschikbaar,
  consistent met de rest van de iconenset) naast de bestaande bewerken/
  verwijderen-iconen, zichtbaar wanneer `canEdit` (zelfde gate als de
  overige actie-iconen — `requireWriteAccess()` aan de serverkant is de
  echte grens, de UI-gate is presentatie).
- Vastgezette notities krijgen een subtiele visuele markering (bijv. een
  linker-accentrand of een klein "Vastgezet"-label) — geen herontwerp
  van de bestaande kaart-layout.
- Geen aparte sectie-kop nodig ("Vastgezette notities" / "Overige") —
  de gecombineerde, geserveerde sortering (§6) volstaat; een aparte
  visuele scheiding is een presentatiedetail, te bepalen bij bouw.

## 8. RBAC

- Lezen: ongewijzigd — wie de klant/opportunity mag zien, ziet ook alle
  notities inclusief pin-status (geen nieuwe leesbeperking).
- Pinnen/unpinnen: `requireWriteAccess()` (ADMIN/AGENT), zie §3. VIEWER
  ziet het pin-icoon niet (UI) en krijgt 403 bij een geforceerde
  aanroep (server).
- Content-bewerken/verwijderen: ongewijzigd, `assertCanModifyNote()`.

## 9. IDOR

De nieuwe route opereert op een bestaand, al-IDOR-veilig
`noteId` — geen nieuwe cross-customer-oppervlakte: `pinNote()`/
`unpinNote()` doen exact dezelfde `prisma.note.findUniqueOrThrow({
where: { id: noteId } })` + geen customerProfileId-parameter uit de
client (de notitie's eigen `customerProfileId` is al server-bekend,
identiek aan hoe `updateNote()`/`deleteNote()` dat vandaag al doen).
Geen nieuwe guard-logica nodig — hergebruikt het bestaande patroon.

## 10. Performance

Geen nieuwe externe aanroep, geen N+1 — één extra `orderBy`-clausule op
een reeds bestaande query. Geen nieuwe index strikt noodzakelijk bij het
huidige datavolume (3 klanten, 0-enkele notities in productie); een
samengestelde index op `(customerProfileId, isPinned, pinnedAt)` is een
mogelijke toekomstige optimalisatie bij bewezen groei, niet nu (zelfde
"bij bewezen volume"-principe als doc 52 §5).

## 11. Expliciet buiten scope

- CustomerHeader/Overview-tab-weergave van de vastgezette notitie (zie
  discovery §6).
- Cap op aantal vastgezette notities (zie §6).
- Prioriteitsniveaus (enum i.p.v. boolean, zie §1).
- Zichtbaarheidscontrole/privé-notities (discovery §4).
- Notitie-zoeken (aparte, latere kandidaat — doc 52 §17 #2).

## 12. Testplan (kort, uitgewerkt in de build spec)

Pin/unpin door AGENT (eigen én andermans notitie — bevestigt §3's
bewuste keuze), VIEWER geblokkeerd (403), sortering (vastgezet altijd
boven, meerdere vastgezette notities correct op `pinnedAt` gesorteerd),
IDOR (bestaande patroon, geen nieuwe test-logica nodig — alleen
bevestigen), audit-rij correct (`note.pinned`/`unpinned`, geen
Activity-item), content-update/delete-permissies ongewijzigd
(regressie).

## 13. Staging E2E

Zelfde gevestigde patroon: tijdelijke ADMIN/AGENT/VIEWER-testgebruikers,
synthetische `CustomerProfile` + meerdere `Note`-rijen, verificatie van
pin/unpin/sortering/RBAC/audit, volledige cleanup.

**PHASE 6D READY FOR BUILD SPEC: YES**
