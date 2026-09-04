# 55 — Phase 6D Build Spec: Notitie-pinning ("Belangrijke notitie")

**Status**: Build spec, geen implementatie. Vervolg op
`54-PHASE-6D-ARCHITECTURE.md`. Klaar om te bouwen na expliciete opdracht
— dit document zelf bouwt niets.

## 1. IN scope

1. **Schemawijziging** (`prisma/schema.prisma`, `Note`-model): drie
   nieuwe, additieve, nullable/defaulted kolommen —
   `isPinned Boolean @default(false)`, `pinnedAt DateTime?`,
   `pinnedById String?` + `pinnedBy User? @relation("NotesPinned", ...)`.
   Eén nieuwe migratie (`..._phase6d_note_pinning`).
2. **`pinNote(noteId, actor)`/`unpinNote(noteId, actor)`** in
   `note.service.ts` — `requireWriteAccess()`-niveau (ADMIN/AGENT, niet
   auteur-beperkt, zie architectuurdoc §3), zet/wist
   `isPinned`/`pinnedAt`/`pinnedById` in één `update()`, schrijft
   `note.pinned`/`note.unpinned`-audit (metadata: `customerProfileId`),
   **geen** Activity-schrijving.
3. **`PATCH /api/notes/[id]/pin`** (nieuw) — body `{ isPinned: boolean
   }`, `requireWriteAccess()`-gated, roept `pinNote()`/`unpinNote()` aan
   op basis van de boolean, retourneert de bijgewerkte notitie.
4. **Sorteerwijziging** in `listNotesForCustomer()`/
   `listNotesForOpportunity()`: `orderBy: [{ isPinned: "desc" },
   { pinnedAt: "desc" }, { createdAt: "desc" }]`.
5. **`NotesPanel.tsx`**: pin/unpin-icoonknop (`Pin`/`PinOff` uit
   `lucide-react`, bevestigd beschikbaar in de geïnstalleerde versie)
   naast de bestaande bewerken/verwijderen-iconen, zichtbaar bij
   `canEdit`; subtiele visuele markering op vastgezette notities
   (bijv. linker-accentrand of klein label — presentatiedetail, te
   kiezen bij bouw); geen herontwerp van de bestaande kaart-layout.

## 2. OUT of scope (zie architectuurdoc §11 voor motivatie)

- CustomerHeader/Overview-tab-weergave van een vastgezette notitie
- Cap op aantal vastgezette notities
- Prioriteitsniveaus (enum i.p.v. boolean)
- Zichtbaarheidscontrole/privé-notities
- Notitie-zoeken (aparte, latere kandidaat)
- Elke wijziging aan `updateNote()`/`deleteNote()`/`assertCanModifyNote()`
  (content-permissies blijven exact ongewijzigd)
- Nieuwe Activity-tijdlijn-kind

## 3. Datamodel-impact

Eén additieve, backward-compatible migratie — drie nieuwe kolommen op
`Note`, alle nullable/defaulted. Geen wijziging aan enig ander model.
Geen dataverlies-risico (bestaande rijen krijgen automatisch
`isPinned: false`, `pinnedAt: null`, `pinnedById: null`).

## 4. API-impact

Eén nieuwe, kleine route: `PATCH /api/notes/[id]/pin`. Geen wijziging
aan `PATCH /api/notes/[id]` of `DELETE /api/notes/[id]`.

## 5. UI-impact

Eén bestaand component gewijzigd (`NotesPanel.tsx`) — geen nieuw
scherm, geen nieuwe route, geen wijziging aan Customer 360's
tab-structuur.

## 6. RBAC

`PATCH /api/notes/[id]/pin`: `requireWriteAccess()` (ADMIN/AGENT) —
bewust **niet** `assertCanModifyNote()`'s auteur-of-ADMIN-gate
(architectuurdoc §3: pinnen is teamcuratie, geen contentwijziging).
VIEWER: ziet het pin-icoon niet (UI), 403 bij geforceerde aanroep
(server). Lezen: ongewijzigd, iedereen die de klant/opportunity mag
zien ziet ook de pin-status.

## 7. Audit

Twee nieuwe `AuditAction`-waarden: `note.pinned`, `note.unpinned` —
exact naar het bestaande `customer_tag.assigned`/`unassigned`-patroon.
Geen nieuwe Activity-kind (architectuurdoc §5).

## 8. Performance

Geen nieuwe externe aanroep, geen N+1 — één extra `orderBy`-clausule op
een al-bestaande query. Geen nieuwe index nodig bij het huidige
datavolume (architectuurdoc §10).

## 9. Tests

**Pin/unpin (kern)**: AGENT kan zowel eigen als andermans notitie
pinnen/unpinnen (bevestigt de bewuste architectuurkeuze — geen
auteur-restrictie); `isPinned`/`pinnedAt`/`pinnedById` correct gezet bij
pin, correct gewist (`null`) bij unpin; idempotent (tweemaal pinnen
zonder tussentijds unpinnen verandert `pinnedAt` niet ten onrechte —
exact gedrag bij bouw te bepalen: een herhaalde pin-aanroep op een
al-vastgezette notitie mag `pinnedAt` verversen of ongewijzigd laten,
geen architectuurbeslissing, wel expliciet te testen wat de gekozen
implementatie doet).

**RBAC**: VIEWER geblokkeerd (403) op `PATCH /api/notes/[id]/pin`,
zowel voor een eigen-klant-notitie als een andermans-klant-notitie.

**IDOR**: bestaand patroon (`findUniqueOrThrow` op `noteId`, geen
client-aangeleverde `customerProfileId`) — bevestigen dat dit
onveranderd werkt, geen nieuwe test-logica nodig (architectuurdoc §9).

**Sortering**: vastgezette notitie(s) altijd bovenaan ongeacht
`createdAt`; meerdere vastgezette notities gesorteerd op `pinnedAt desc`
binnen de vastgezette groep; niet-vastgezette notities behouden hun
bestaande `createdAt desc`-volgorde eronder; werkt identiek voor zowel
`listNotesForCustomer()` als `listNotesForOpportunity()`.

**Audit**: `note.pinned`/`note.unpinned`-rij met correcte
`entityId`/metadata; **geen** Activity-rij aangemaakt door pin/unpin
(expliciete negatieve test).

**Regressie**: `updateNote()`/`deleteNote()`/`assertCanModifyNote()`
ongewijzigd (bestaande auteur-of-ADMIN-gate blijft gelden voor
content-wijziging); bestaande Note-tests blijven groen;
`ActivityTimelineView.tsx` ongewijzigd voor NOTE_*-kinds.

## 10. Staging E2E

Zelfde gevestigde patroon (tijdelijke ADMIN/AGENT/VIEWER-testgebruikers,
synthetische `CustomerProfile` + meerdere `Note`-rijen). Scenario's:

- A. AGENT pint een eigen notitie → verschijnt bovenaan, icoon toont
  "vastgezet"-status.
- B. AGENT pint een notitie van een andere gebruiker → geslaagd
  (bevestigt architectuurkeuze §3).
- C. Meerdere vastgezette notities → correct gesorteerd op `pinnedAt`.
- D. Unpin → notitie valt terug naar chronologische positie.
- E. VIEWER → pin-icoon niet zichtbaar; geforceerde `PATCH .../pin` →
  403.
- F. Content-bewerken/verwijderen van een vastgezette notitie → blijft
  exact het bestaande auteur-of-ADMIN-gedrag (regressie).
- G. Cross-customer IDOR — bestaande guard, alleen bevestigen.
- H. Opportunity-scoped notities → pin/unpin werkt identiek.
- I. Audit-rij aanwezig, geen Activity-rij.
- J. Cleanup — alle synthetische data + testgebruikers verwijderd,
  geverifieerd.

## 11. Openstaande beslissingen bij bouw (geen architectuurwijziging)

- Exacte visuele markering van een vastgezette notitie (accentrand vs.
  label vs. beide) — presentatiedetail.
- Of een herhaalde pin-aanroep op een al-vastgezette notitie
  `pinnedAt` ververst — functioneel gelijkwaardig, te kiezen bij bouw
  (zie §9).

**PHASE 6D READY TO BUILD: YES**
