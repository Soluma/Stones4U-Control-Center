# Phase 6D — Notitie-pinning: staging build report

**Status**: gebouwd, getest (546/546 tests groen, typecheck/lint/build
groen), migratie gegenereerd en toegepast, gedeployed naar
`stones4u-control-center-staging` (versie **v31**). Staging-E2E: 18/18
scenario's groen (na twee eigen testscript-fouten, geen productiebug —
zie §9). Niet gecommit, niet gepusht, geen productie-actie.

Vervolg op `docs/platform-discovery/52-POST-PHASE-6-PRIORITY-REVIEW.md`,
`53-PHASE-6D-DISCOVERY.md`, `54-PHASE-6D-ARCHITECTURE.md`,
`55-PHASE-6D-BUILD-SPEC.md`. Geen afwijking van deze documenten die een
correctie vereist — gebouwd exact zoals gespecificeerd.

## 1. Schema

Drie additieve kolommen op `Note` (`prisma/schema.prisma`), exact de
drie uit doc 54/55, geen vierde veld:

```prisma
isPinned   Boolean   @default(false)
pinnedAt   DateTime?
pinnedById String?
pinnedBy   User?     @relation("NotesPinned", fields: [pinnedById], references: [id])
```

`pinnedBy` is de Prisma-relatiedeclaratie bij `pinnedById`, geen eigen
kolom. Reverse-relatie `notesPinned Note[] @relation("NotesPinned")`
toegevoegd op `User`.

## 2. Migration

`prisma/migrations/20260904151633_phase_6d_note_pinning/migration.sql`
— volledige, letterlijke SQL:

```sql
-- AlterTable
ALTER TABLE "Note" ADD COLUMN     "isPinned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pinnedAt" TIMESTAMP(3),
ADD COLUMN     "pinnedById" TEXT;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_pinnedById_fkey" FOREIGN KEY ("pinnedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

Uitsluitend `ADD COLUMN`/`ADD CONSTRAINT` — geen `DROP`, geen tabel-
rebuild, geen destructieve DDL, geen backfill nodig (bestaande rijen
krijgen automatisch `isPinned: false` via de kolomdefault).

**Foreign-key-onDelete bevestigd correct**: `ON DELETE SET NULL` —
gegenereerd door Prisma zonder expliciete override, en bevestigd
identiek aan het bestaande `CustomerProfile.accountManagerId`-patroon
(zelfde `ON DELETE SET NULL` in de init-migratie). Het verwijderen van
een `User` kan dus nooit een `Note` verwijderen of blokkeren — het
nult hooguit `pinnedById`. Voldoet aan build-instructie §3's eis.

Bij het genereren ontstond eenmalig een tweede, lege migratiemap
(`20260904151640_phase_6d_note_pinning`, artefact van een dubbele
`prisma migrate dev`-aanroep) — verwijderd vóórdat er iets gecommit
werd. Uiteindelijke migratiehistorie: precies 8 migraties, exact één
nieuwe voor Phase 6D.

## 3. AuditAction

Twee nieuwe waarden toegevoegd aan `src/platform/audit/audit.ts`:
`"note.pinned"`, `"note.unpinned"` — exacte naamconventie
(`entity.verb`) van de bestaande unie. Geen nieuwe `ActivityKind`.

## 4. pinNote()/unpinNote() — semantiek

`src/modules/crm/note.service.ts`. Beide functies:
- Gebruiken `noteId` als enige, server-autoritatieve identifier (geen
  client-aangeleverde `customerProfileId` — zelfde patroon als
  `updateNote()`/`deleteNote()`).
- Wijzigen nooit `bodyJson`/`bodyText`/`authorId` — inhoud en
  auteurschap blijven volledig onaangetast.
- Zijn **niet** gegated door `assertCanModifyNote()` (auteur-of-ADMIN)
  — bewust, zie §5.

**Idempotentie** (build-instructie §2B, letterlijk zo geïmplementeerd):
- Pin op een al-gepinde notitie → succesvolle no-op, `pinnedAt`/
  `pinnedById` blijven ongewijzigd, geen tweede audit-rij.
- Unpin op een al-niet-gepinde notitie → succesvolle no-op, geen audit-
  rij.
- Een echte state-transitie schrijft wél altijd de normale audit.

**Concurrency** (build-instructie §8): een conditionele
`prisma.note.updateMany({ where: { id: noteId, isPinned: false/true },
... })` — exact hetzelfde bewezen patroon als Phase 6B's
`assignCustomerToSelfIfUnassigned()`. Bij een race tussen twee
gelijktijdige pin-pogingen wint precies één `updateMany` (count 1,
schrijft de audit), de andere ziet `count === 0` en valt terug op
dezelfde no-op-uitkomst (geen tweede audit, geen tweede schrijfactie).
Zelfde garantie voor unpin. Geen zwaar lock-mechanisme nodig — één
atomaire, voorwaardelijke database-operatie per richting.

## 5. Permissiemodel — bewuste, gedocumenteerde afwijking van content-edit

`requireWriteAccess()` (ADMIN/AGENT), **niet** auteur-beperkt — een
schrijfbevoegde collega mag elke notitie pinnen/unpinnen, ongeacht wie
de auteur is. Dit is een expliciete, in doc 54 §3 vastgelegde
ontwerpkeuze (pinning is teamcuratie, geen contentwijziging) — bevestigd
in de staging-E2E (scenario E: Agent B pint een notitie van Agent A,
`authorId` blijft A, `pinnedById` wordt B). Content-bewerken/verwijderen
(`updateNote()`/`deleteNote()`) blijft volledig ongewijzigd onder
`assertCanModifyNote()` (auteur-of-ADMIN).

## 6. API

Eén nieuwe, kleine route: `PATCH /api/notes/[id]/pin`, body `{
"isPinned": boolean }`. Geen wijziging aan `PATCH /api/notes/[id]` of
`DELETE /api/notes/[id]`.

## 7. IDOR

Geen nieuwe oppervlakte: dezelfde `findUniqueOrThrow({ where: { id:
noteId } })` als de bestaande content-routes, geen client-vertrouwde
`customerProfileId`. Bevestigd via staging (scenario J: een niet-
bestaand `noteId` geeft een schone 404, geen 500).

## 8. Sortering/performance

`listNotesForCustomer()`/`listNotesForOpportunity()`:
`orderBy: [{ isPinned: "desc" }, { pinnedAt: "desc" }, { createdAt:
"desc" }]` — één query, DB-side multi-key sort, geen in-memory
re-sortering, geen N+1. `pinnedBy` wordt met één `select` meegeladen in
dezelfde query (geen per-notitie lookup). Bevestigd in staging (scenario
C): een gepinde notitie staat altijd boven een niet-gepinde, ook al is
de niet-gepinde nieuwer aangemaakt.

## 9. De twee testscript-fouten (eerlijk gerapporteerd — geen productiebug)

**Fout 1 — hoofdlettergevoelige e-mail-mismatch (fixturebug)**: de eerste
E2E-poging gebruikte testgebruikers-e-mails met een hoofdletter
(`phase6d-agentA-...@example.com`). De login-route normaliseert
(`email.trim().toLowerCase()`) vóór de databasequery, maar het
testscript maakte de gebruiker aan met de ongewijzigde, gemengde-
hoofdletter-waarde via een directe `prisma.user.create()` (buiten de
normale registratieflow om) — een `findUnique({ where: { email:
"...agenta..." } })` vond dus niets, wat een 401 opleverde. **Bewezen
fixturebug, geen productiebug**: een echte gebruiker wordt altijd via
een flow aangemaakt die dezelfde normalisatie toepast; dit trad alleen
op omdat het testscript de Prisma-laag rechtstreeks aansprak met een
niet-genormaliseerde waarde. Gefixt door de testscript-e-mails volledig
lowercase te maken — geen enkele productiecode aangeraakt.

**Fout 2 — eigen rate limiter geraakt tijdens itereren (verwacht
gedrag, geen bug)**: de bestaande login-rate-limiter
(`src/platform/security/rate-limit.ts`, 8 pogingen per 5 minuten, per
IP) is binnen de staging-container voor elke `fly ssh console`-sessie
effectief hetzelfde ("onbekend") IP-sleutel — dus elke herhaalde
testscript-uitvoering tijdens het debuggen van fout 1 telde mee tegen
dezelfde teller. Na een paar snelle iteraties (twee mislukte pogingen +
één gedeeltelijk geslaagde poging met drie logins) sloeg de limiter
correct dicht op een volgende login-poging (HTTP 429). Dit is de
rate-limiter die precies doet waarvoor hij bestaat — geen wijziging
nodig, gewoon het venster laten verlopen en opnieuw proberen. Na de
wachttijd slaagde de volledige E2E in één keer.

Geen van beide bevindingen wijst op een probleem in de Phase 6D-
productiecode zelf.

## 10. Tweede bevinding tijdens het bouwen van de E2E — testmethodologie, geen bug

`NotesPanel.tsx` is een Client Component die zijn eigen notities ophaalt
via een `useEffect` ná mount (zelfde patroon als `TasksPanel.tsx`/
`ContactsSection.tsx`). Een kale HTTP-GET van `/customers/{id}?tab=notes`
(zonder JavaScript-executie) levert dus nooit de gehydrateerde
notitielijst op, alleen de initiële skeleton — een string-`includes`-
check op "Vastgezet" in die ruwe HTML kan dus per ontwerp nooit slagen,
ongeacht of de functionaliteit correct is. Gecorrigeerd door scenario H
te verifiëren via de onderliggende API-response (`GET
/api/customers/{id}/notes`, precies de data waar de client uit
hydrateert) in plaats van de ruwe pagina-HTML. Er is geen browser-
automatiseringstool beschikbaar in deze sessie om de daadwerkelijke
gehydrateerde DOM te renderen; de UI-renderlogica zelf is via codereview
bevestigd (`NotesPanel.tsx` rendert de "Vastgezet"-badge exact
conditioneel op `note.isPinned`, hetzelfde patroon als elke andere
label/badge in dit component), gecombineerd met het bewezen-correcte
API-niveau-gedrag. Zelfde, al eerder in dit project geaccepteerde
grens als elke voorgaande fase (geen van de Phase 1-6C-staging-rondes
had wel toegang tot een browser-automatiseringstool).

## 11. Note-lifecycle (archief/verwijderen) — ongewijzigd

`listNotesForCustomer()`/`listNotesForOpportunity()` filteren nog steeds
op `deletedAt: null` — pin-status overrulet deze filter nooit (build-
instructie §24). Geen wijziging aan `deleteNote()`'s soft-delete-
gedrag.

## 12. Audit/Activity

`note.pinned`/`note.unpinned` bevat uitsluitend `userId`/`entityType`/
`entityId`/`customerProfileId` in metadata — geen notitie-inhoud, geen
extra PII. Geen `Activity`-rij voor pin/unpin, bevestigd zowel unit
(`tests/notes.test.ts`) als staging (scenario K: `Activity`-telling
ongewijzigd na een pin+unpin-cyclus).

## 13. Regressie

`updateNote()`/`deleteNote()`/`assertCanModifyNote()` volledig
ongewijzigd — bestaande auteur-of-ADMIN-gate blijft gelden voor
content-mutaties (bevestigd via de bestaande, ongewijzigde tests in
`tests/notes.test.ts`, alle nog groen). Gewone notitie-aanmaak werkt nog
(staging scenario L).

## 14. Tests + nieuwe baseline

`tests/notes.test.ts`, nieuwe `describe("Phase 6d — pinning")`-blok (9
tests): pin door auteur, pin door niet-auteur (bevestigt de bewuste
architectuurkeuze), idempotente pin (geen dubbele audit/metadata-
herschrijving), unpin, idempotente unpin, geen Activity bij pin/unpin,
sortering (pinned-groep boven, correct gesorteerd binnen beide groepen),
`pinnedBy` als compacte `{ id, name }`-relatie.

**Nieuwe baseline: 546/546 tests groen** (was 538 vóór Phase 6D, +8 — 9
nieuwe pin-tests, netto +8 doordat er geen bestaande tests zijn
verwijderd of samengevoegd). Geen nieuwe flaky tests waargenomen.

## 15. Typecheck/lint/build

Alle drie schoon. Build: nieuwe route `/api/notes/[id]/pin` zichtbaar in
de routetabel, `/customers/[id]`-bundle marginaal gegroeid (18.4 kB →
18.8 kB, verwacht — nieuwe UI-elementen in `NotesPanel.tsx`).

## 16. Staging migratie/deploy/versie

`fly deploy --config fly.toml -a stones4u-control-center-staging` —
versie v30 → **v31**, beide machines gezond. `release_command` (`npx
prisma migrate deploy`) paste de nieuwe migratie daadwerkelijk toe
(bevestigd via een losse `npx prisma migrate status`-controle op de
container: "8 migrations found", "Database schema is up to date!").

## 17. Staging health

`/api/health` 200, beide machines `started`/gezond, geen restart-loop,
geen nieuwe Prisma-fouten in de logs rond de deploy/E2E-vensters.

## 18. Staging E2E — 18/18 groen

```
[PASS] A: note created (201)
[PASS] A: note initially unpinned
[PASS] B: pin succeeds (200)
[PASS] B: state is pinned
[PASS] C: pinned note sorts above normal note
[PASS] D: second pin succeeds (200, no-op)
[PASS] D: pinnedAt unchanged on repeated pin
[PASS] D: pinnedById unchanged on repeated pin
[PASS] E: Agent B can pin Agent A's note (200)
[PASS] E: pinnedById is B, authorId stays A
[PASS] F: unpin succeeds (200)
[PASS] F: state correctly reset
[PASS] G: second unpin succeeds (200, no-op)
[PASS] H: VIEWER Notes tab loads (200)
[PASS] H: VIEWER can read the pinned note's isPinned:true via the API (200)
[PASS] I: VIEWER pin/unpin blocked (403)
[PASS] J: nonexistent note rejected cleanly (404, not 500)
[PASS] K: Activity count unchanged by pin/unpin
[PASS] L: plain note creation still works (201)
Cleanup done.
```

Geen scenario geschrapt om een groene run te krijgen — zie §9/§10 voor
de twee correcties die daadwerkelijk nodig waren (beide testscript-
niveau, geen productiecode).

## 19. Cleanup

Alle synthetische data (3 testgebruikers, 1 `CustomerProfile`, alle
aangemaakte `Note`-rijen) verwijderd door het self-cleaning script,
geverifieerd met een losse controlequery ná afloop (`leftover users: 0`,
`leftover profiles: 0`, `leftover notes: 0`). Beide scratch-scripts
(`phase6d-e2e.ts`, `phase6d-debug-login.ts`) van de staging-container
verwijderd en afwezigheid bevestigd (`ls /app/scripts/` toont alleen het
al-bestaande `bootstrap-admin.ts`). Geen bestaande staging-data
aangeraakt.

## 20. Documentatie

Dit bestand (nieuw). Geen wijziging aan doc 52/53/54/55 nodig — de
implementatie volgt ze exact; de enige "afwijkingen" (§9/§10) zijn
test-methodologie-correcties, geen architectuurwijziging.

## Blockers

Geen.

---

**PHASE 6D STAGING: GO**
