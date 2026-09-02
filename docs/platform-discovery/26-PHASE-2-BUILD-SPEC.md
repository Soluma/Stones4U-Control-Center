# 26 — Phase 2 Build Spec: Tasks 2.0, Files (R2), Appointments, Customer 360 v2

Concrete functionele specificatie voor Phase 2, volgend op `24-UNIFIED-CONTROL-CENTER-TARGET.md` (fasering) en `25-PHASE-1-BUILD-SPEC.md` (Phase 1, reeds gebouwd en in productie). Geschreven vóór implementatie, zoals gevraagd. Phase 1 blijft ongewijzigd functioneel — elke wijziging hieronder is additief of een gerichte uitbreiding van een reeds *voorbereid maar ongebruikt* Phase-1-veld (bijv. `File`, `CustomerProfile.tags`).

## 1. Scope

1. **Tasks 2.0**: comments/updates, checklist/subtasks, tags, `reminderAt`, een echte taakdetailpagina (`/tasks/[id]`), uitgebreide filters/zoeken/sortering.
2. **Files**: Cloudflare R2 object-opslag + Postgres-metadata, upload/download/verwijderen, geïntegreerd op Customer 360.
3. **Appointments**: nieuw centraal model, CRUD, Customer 360-integratie, dashboard "komende afspraken".
4. **Customer 360 v2**: quick actions (Notitie/Taak/Afspraak/Bestand), accountmanager-edit-UI, echte CRM-tags, overzichtsblokken (taken/afspraken/bestanden/activiteit).
5. **Customer tags**: `CustomerTag`/`CustomerTagAssignment` relationeel model, vervangt het ongebruikte `CustomerProfile.tags String[]`-veld uit Phase 1.
6. **Activity Timeline**: nieuwe event-types voor files/appointments/task-updates.
7. **Dashboard**: taken vandaag, achterstallig, komende afspraken, recente activiteit — uitsluitend echte data.
8. **Command palette**: uitgebreid met `tasks`- en `navigation`-groepen naast het bestaande `customers`.

## 2. Out of scope (ongewijzigd van de opdracht)

Suppliers, Purchase Orders, Production, Material Handoff, Delivery, Complaints/Service, Outlook/Microsoft Graph, telefonie-migratie, Exact-writes, OfferteApp/s4u-quote-app/POS-migratie of -integratie. Geen dummy-tabellen voor deze toekomstige modules — de bestaande, Phase-1-voorbereide losse ID-velden op `Task` (`supplierId`, `purchaseOrderId`, `productionJobId`, `complaintId`, `quoteRef`, `callRef`) blijven ongebruikte, niet-gerelateerde `String?`-velden; dat is al precies "structureel voorbereid zonder dummy-tabellen" en wordt niet aangepast.

**Shopify Order-relatie op Task**: `Task.shopifyOrderGid` bestaat al sinds Phase 1 als losse `String?` (geen foreign key, geen orderdata-duplicatie — de Shopify GraphQL-client blijft de enige bron voor orderdetails). Dit voldoet al aan "zonder duplicatie van orderdata netjes mogelijk" — geen schemawijziging nodig. Wél nieuw: de taak-detailpagina toont, als `shopifyOrderGid` gezet is, een live Shopify-orderreferentie (nummer/status) via de bestaande read-only Shopify-client — geen nieuwe tabel, geen write.

## 3. Nieuwe modellen

### `TaskComment`
Append-only opmerkingen/updates op een taak (referentie: TelefoonSysteem's `TaskUpdate`-patroon, ADR-003 — hergebruikt als concept, niet als code/tabel).
```
id, taskId, authorId, body (Text, max 5000), createdAt
```
Geen edit/delete in Phase 2 (bewust: een append-only updatelog is eenvoudiger correct te auditen dan een bewerkbare opmerking, en niets in de opdracht vraagt om bewerken).

### `TaskChecklistItem`
```
id, taskId, title, done (Boolean, default false), position (Int), completedAt?, createdAt, updatedAt
```
`position` bepaalt volgorde binnen de taak (drag-to-reorder is out of scope voor Phase 2 — omhoog/omlaag-knoppen zijn voldoende voor de gevraagde functionaliteit).

### `Appointment`
```
id, customerProfileId, title, description?, startsAt, endsAt?,
assignedToId, createdById, status (AppointmentStatus), externalCalendarId?,
completedAt?, cancelledAt?, createdAt, updatedAt
```
`AppointmentStatus { SCHEDULED, COMPLETED, CANCELLED }`. `externalCalendarId` is een ongebruikt, voorbereid `String?`-veld voor een toekomstige Microsoft Graph/Google Calendar-koppeling (net als `Task`'s voorbereide velden in Phase 1) — geen sync-logica in Phase 2.

### `CustomerTag` / `CustomerTagAssignment`
```
CustomerTag: id, name (uniek), color? (hex string, bv. "#6366f1"), createdById, createdAt
CustomerTagAssignment: id, customerProfileId, tagId, assignedById, assignedAt
  @@unique([customerProfileId, tagId])
```
Vervangt `CustomerProfile.tags String[]` (Phase 1, nooit gevuld — er bestond geen tag-UI, zie `25-PHASE-1-BUILD-SPEC.md` §2 "out of scope"). Dit zijn expliciet **Control Center-CRM-tags**, losstaand van eventuele Shopify-klant-tags (die worden nergens gelezen of geschreven door dit model).

### `File` (uitbreiding van het Phase-1-schema-only model)
Phase 1 had al `id, customerProfileId?, fileName, mimeType, sizeBytes, storageKey, uploadedById, createdAt` — schema-only, geen enkele code las of schreef dit model (geverifieerd: nul treffers op `prisma.file` in `src/` vóór Phase 2). Uitgebreid naar:
```
id, storageKey (uniek), originalFilename, mimeType, byteSize,
title?, description?, customerProfileId?, uploadedById,
deletedAt?, createdAt, updatedAt
```
Herbenoemd: `fileName`→`originalFilename`, `sizeBytes`→`byteSize` (consistent met de exacte veldnamen uit de opdracht). Zero productiedata-risico: het bestaande `File`-model heeft in zowel staging als productie nul rijen (nooit door enige code aangesproken) — geverifieerd voorafgaand aan de migratie.

## 4. Wijzigingen bestaande modellen

- **`Task`**: `+ tags String[] @default([])`, `+ reminderAt DateTime?`, `+ comments TaskComment[]`, `+ checklistItems TaskChecklistItem[]`. Alle bestaande velden ongewijzigd — volledige backwards compatibility met Phase-1-taken (een bestaande taak heeft simpelweg een lege `tags`/`checklistItems`/`comments`-lijst).
- **`CustomerProfile`**: `tags String[]` **verwijderd** (nooit gevuld, zie boven), `+ tagAssignments CustomerTagAssignment[]`, `+ files File[]`, `+ appointments Appointment[]`.
- **`User`**: nieuwe terug-relaties (`taskComments`, `appointmentsAssigned`, `appointmentsCreated`, `filesUploaded`, `customerTagsCreated`, `tagAssignmentsMade`).
- **`Activity`** / **`ActivityType`**: nieuwe waarden `FILE_UPLOADED`, `FILE_REMOVED`, `APPOINTMENT_CREATED`, `APPOINTMENT_UPDATED`, `APPOINTMENT_COMPLETED`, `APPOINTMENT_CANCELLED`, `TASK_UPDATED`, `TASK_COMMENT_ADDED`, `TASK_CHECKLIST_COMPLETED`. `Activity` krijgt `+ relatedFileId File?`, `+ relatedAppointmentId Appointment?` (zelfde patroon als bestaande `relatedNoteId`/`relatedTaskId`).

## 5. Routes

| Route | Methode | Doel | Toegang |
|---|---|---|---|
| `/tasks/[id]` | pagina | Taakdetail: velden, checklist, opmerkingen, statusacties | alle rollen (schrijven: toegewezene/aanmaker/ADMIN) |
| `/api/tasks/[id]` | GET | Taakdetail incl. comments/checklist | alle rollen |
| `/api/tasks/[id]` | PATCH | *(bestaand, uitgebreid)* title/description/priority/dueAt/tags/reminderAt naast status/assignedToId | write access + `assertCanModify` |
| `/api/tasks/[id]/comments` | GET, POST | Opmerkingen lezen/plaatsen | write access voor POST |
| `/api/tasks/[id]/checklist` | GET, POST | Checklist lezen/item toevoegen | write access voor POST |
| `/api/tasks/[id]/checklist/[itemId]` | PATCH, DELETE | Item afvinken/hernoemen/verwijderen | write access + `assertCanModify` op de taak |
| `/api/customers/[id]/appointments` | GET, POST | Afspraken van een klant | write access voor POST |
| `/api/appointments/[id]` | GET, PATCH | Afspraakdetail/wijzigen/voltooien/annuleren | write access + eigenaar/aanmaker/ADMIN |
| `/api/appointments/upcoming` | GET | Komende afspraken (dashboard) | alle rollen (eigen toegewezen) |
| `/api/customers/[id]/files` | GET, POST | Bestanden lijst / upload (server-side, multipart) | write access voor POST |
| `/api/files/[id]` | GET, PATCH, DELETE | Metadata + signed download-URL / titel-omschrijving bewerken / verwijderen | write access voor PATCH/DELETE |
| `/api/customer-tags` | GET, POST | Alle tags lezen / nieuwe tag aanmaken | write access voor POST |
| `/api/customer-tags/[id]` | DELETE | Tag verwijderen (ADMIN) | ADMIN |
| `/api/customers/[id]/tags` | POST, DELETE | Tag aan klant koppelen/ontkoppelen | write access |
| `/api/search` | GET | *(bestaand, uitgebreid)* + `tasks`-groep | alle rollen |

## 6. Schermen

- **`/tasks/[id]`** (nieuw): header (titel, status-badge, prioriteit, toegewezene, deadline, klant-link indien gekoppeld, Shopify-orderreferentie indien `shopifyOrderGid` gezet), bewerkbare velden (inline of dialoog, consistent met bestaande `Dialog`-component), checklist-sectie (voortgang "3/5", toggle, toevoegen/verwijderen), opmerkingen-sectie (lijst + nieuw-opmerking-composer), statusacties (afronden/heropenen/annuleren), audit-onzichtbaar voor de gebruiker maar server-side gelogd.
- **`/tasks`** (bestaand, uitgebreid): elke rij klikbaar naar `/tasks/[id]`; tekst-zoekveld (titel/omschrijving) naast de bestaande tabs; sorteeroptie (deadline/prioriteit/aangemaakt).
- **Customer 360** (bestaand, uitgebreid): Quick Actions-rij (Notitie/Taak/Afspraak/Bestand — compacte knoppen, geen grote kaarten), tags-sectie (badges + "beheren"-dialoog voor write-access-rollen), accountmanager-select (zelfde patroon als bestaande `CrmStatusControl`), nieuwe tabs "Afspraken" en "Bestanden" naast Overzicht/Orders/Activiteit/Notities/Taken.
- **Dashboard** (bestaand, uitgebreid): bestaande taken-tegels blijven; nieuwe secties "Komende afspraken" en "Recente CRM-activiteit" (laatste N `Activity`-rijen over alle klanten, alleen `CONTROL_CENTER`-bron — geen Shopify-orderdata nodig op het dashboard).
- **Command palette** (bestaand, uitgebreid): groepen `Klanten` (bestaand), `Taken` (nieuw, zoekt op titel), `Navigatie` (nieuw, statische lijst van routes — Dashboard/Klanten/Taken/Gebruikers/Instellingen).

## 7. Permissions

Ongewijzigd model (Phase 1 §6), consistent toegepast op alle nieuwe entiteiten:

| Actie | VIEWER | AGENT | ADMIN |
|---|---|---|---|
| Taken/afspraken/bestanden/tags lezen | ✅ | ✅ | ✅ |
| Taak/afspraak/bestand/tag aanmaken | ❌ | ✅ | ✅ |
| Taak-opmerking/checklist wijzigen | ❌ | eigenaar/toegewezene | ✅ (alle) |
| Afspraak wijzigen/annuleren/voltooien | ❌ | eigenaar/toegewezene | ✅ (alle) |
| Bestand verwijderen | ❌ | uploader of ADMIN | ✅ (alle) |
| Tag *verwijderen* (het tag-type zelf) | ❌ | ❌ | ✅ |
| Tag aan klant koppelen/ontkoppelen | ❌ | ✅ | ✅ |

Elke schrijvende route gebruikt `requireWriteAccess()` als basis (nooit alleen `requireUser()`), plus een entity-specifieke eigenaar/rol-check waar van toepassing — zelfde patroon als `task.service.ts`'s `assertCanModify`.

## 8. Audit

Nieuwe `AuditAction`-waarden: `task.comment_added`, `task.checklist_item_added`, `task.checklist_item_toggled`, `task.checklist_item_removed`, `task.updated` (titel/omschrijving/prioriteit/deadline/tags/reminder), `appointment.created`, `appointment.updated`, `appointment.completed`, `appointment.cancelled`, `file.uploaded`, `file.metadata_updated`, `file.deleted`, `customer_tag.created`, `customer_tag.deleted`, `customer_tag.assigned`, `customer_tag.unassigned`. Nieuwe `AuditEntityType`-waarden: `TaskComment`, `TaskChecklistItem`, `Appointment`, `File`, `CustomerTag`. **Geen bestandsinhoud in audit-metadata** — alleen `fileId`/`originalFilename`/`mimeType`/`byteSize`, nooit de bytes zelf of een storage-URL.

## 9. Activity events

Zie §4 voor de nieuwe `ActivityType`-waarden. Regels om dubbele/te ruizige events te voorkomen:
- Checklist: **geen** Activity-rij per aangevinkt item (te ruizig voor een tijdlijn) — wél een `TASK_CHECKLIST_COMPLETED`-Activity zodra het **laatste** open item wordt afgevinkt (het hele lijstje is klaar). Elke toggle wordt wél individueel geaudit (§8).
- Taak-opmerkingen: één `TASK_COMMENT_ADDED`-Activity per geplaatste opmerking (niet ruizig — vergelijkbaar volume met notities).
- Bestanden: `FILE_UPLOADED` bij upload, `FILE_REMOVED` bij verwijderen — geen event bij titel/omschrijving-bewerking (te klein voor de tijdlijn, wel geaudit).
- Afspraken: één event per statusovergang (`APPOINTMENT_CREATED`/`_UPDATED`/`_COMPLETED`/`_CANCELLED`) — `_UPDATED` alleen bij veldwijziging (titel/tijd), niet bij elke PATCH-aanroep zonder inhoudelijke wijziging.
- Alle nieuwe Activity-rijen zijn `sourceType: CONTROL_CENTER` (type A, fysiek opgeslagen) — er is in Phase 2 geen nieuwe externe/geprojecteerde (type B) bron; dat onderscheid blijft ongewijzigd.

## 10. R2/file-architectuur

- **Adapter** `src/integrations/storage/r2.ts`, zelfde `Disabled*`-gracieus-degraderen-patroon als `telephony`/`exact`: `isStorageConfigured()` checkt `R2_ACCOUNT_ID`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/`R2_BUCKET_NAME`; als niet geconfigureerd, geven de file-routes een schone `503 "Bestandsopslag is nog niet geconfigureerd."` terug — exact het patroon dat `isShopifyConfigured()` al gebruikt.
- **S3-compatibele client** via `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (R2 is S3-API-compatibel; nieuwe dependency, geen bestaande vervangen).
- **Upload**: server-side. De browser stuurt de bestandsbytes naar een eigen Next.js route (`POST /api/customers/[id]/files`, `multipart/form-data`); de server valideert (grootte, MIME-allowlist, magic-bytes, bestandsnaam) en doet zelf de `PutObject`-call naar R2 — de client krijgt nooit een presigned PUT-URL of R2-credentials te zien. Dit is bewust gekozen boven client-side presigned-upload: server-side validatie kan dan niet omzeild worden door een client die het gevalideerde veld negeert.
- **Download**: kortlevende (60s) presigned GET-URL, server-side gegenereerd na autorisatiecheck, met `response-content-disposition` (`inline` voor afbeeldingen/PDF, `attachment` voor overige typen) — nooit een permanente publieke URL opgeslagen of hergebruikt.
- **Storage key**: `files/{crypto.randomUUID()}{extensie}` — willekeurig, nooit afgeleid van de originele bestandsnaam (voorkomt raden/overschrijven, zie §13).
- **Verwijderen**: soft-delete op de `File`-rij (`deletedAt`) + direct hard-delete van het R2-object (geen wees-opslag) — de rij blijft bestaan voor audit/tijdlijn-consistentie ("bestand verwijderd" blijft zichtbaar), maar is niet meer downloadbaar of in lijsten zichtbaar.
- **Bucket**: geen publieke bucket, geen publieke policy — alle toegang loopt via de authenticated server-side routes hierboven.

## 11. Migration plan

- Eén nieuwe Prisma-migratie, lokaal gegenereerd met `prisma migrate dev` (nooit tegen staging/productie), volledig additief op tabellen (`TaskComment`, `TaskChecklistItem`, `Appointment`, `CustomerTag`, `CustomerTagAssignment`) plus kolomwijzigingen op `Task` (2 nieuwe kolommen), `File` (hernoemde/nieuwe kolommen — nul productierijen, zie §3) en `CustomerProfile` (`tags`-kolom verwijderd — nooit gevuld, zie §3).
- SQL wordt vóór toepassing handmatig gecontroleerd (geen onverwachte `DROP TABLE`/data-verlies buiten het bewust lege `tags`-veld en het bewust lege `File`-model).
- Staging: `prisma migrate deploy` via het bestaande `release_command`-mechanisme (`fly.toml`, ongewijzigd patroon uit `docs/deployment/FLY-STAGING.md`).
- **Geen migratie naar productie in deze fase** — expliciet uitgesloten door de opdracht (§17–19).

## 12. Rollback

- App-niveau: vorige Fly-release/image (zelfde procedure als `docs/deployment/FLY-STAGING.md`).
- Database: de migratie is additief (nieuwe tabellen/kolommen); een rollback naar de Phase-1-image werkt ongewijzigd tegen een database die deze extra kolommen/tabellen simpelweg niet gebruikt. De enige niet-triviaal-omkeerbare stap is het verwijderen van `CustomerProfile.tags` — aantoonbaar veilig omdat dit veld in geen enkele omgeving ooit gevuld is (geverifieerd vóór migratie, zie §15/implementatie).
- R2: geen rollback-actie nodig zolang geen bucket bestaat/gebruikt is (dit blijft in deze staging-only fase het geval tenzij de gebruiker zelf al credentials aanlevert).

## 13. Tests

Nieuw, per de opdracht: Task 2.0-permissies (comments/checklist eigenaar/toegewezene/ADMIN), taakfilters (tekst-zoeken, sortering), appointment CRUD + permissies, file-autorisatie (upload/download/delete alleen met write access resp. eigenaar/ADMIN), bestandsnaam-validatie, MIME-validatie (allowlist + magic-bytes-mismatch-afwijzing, inclusief expliciete SVG-weigering), groottelimiet, customer tags (aanmaken/koppelen/ontkoppelen/verwijderen-permissies), activity-mapping voor de nieuwe event-types, audit-dekking, R2-adapter-falen (niet-geconfigureerd → 503, netwerkfout → nette fout, nooit een crash).

## 14. Acceptance criteria

1. Een bestaande Phase-1-taak (zonder tags/checklist/comments) blijft ongewijzigd zichtbaar en bewerkbaar.
2. Een taak kan geopend worden op `/tasks/[id]`, met titel/omschrijving/prioriteit/deadline bewerkbaar, een checklist beheerd (toevoegen/afvinken/verwijderen), en opmerkingen geplaatst — alles zichtbaar in de Activity Timeline en `AuditEvent` waar van toepassing.
3. Een `VIEWER` kan niets van het bovenstaande muteren (server-side afgedwongen, niet alleen UI-verborgen).
4. Een afbeelding en een PDF kunnen naar een klant geüpload worden, gedownload/geopend worden, en verwijderd worden; een niet-toegestaan bestandstype of een te groot bestand wordt geweigerd met een duidelijke foutmelding.
5. Een afspraak kan aangemaakt, gewijzigd, voltooid, en geannuleerd worden vanuit Customer 360; komende afspraken zijn zichtbaar op het dashboard.
6. Customer 360 toont compacte quick actions (Notitie/Taak/Afspraak/Bestand), echte CRM-tags (aanmaken/koppelen/ontkoppelen), en een accountmanager-edit-control.
7. De Activity Timeline toont, zonder duplicatie, alle bestaande Phase-1-events plus de nieuwe file-/appointment-/task-update-events, correct gesorteerd.
8. Het dashboard toont uitsluitend echte data (geen fake KPI's): taken vandaag, achterstallig, komende afspraken, recente activiteit.
9. Ctrl/Cmd+K vindt klanten én taken, en biedt statische navigatie-snelkoppelingen.
10. `npm run typecheck/lint/test/build` slagen; staging-deploy + smoke test (zie opdracht §17–18) slagen; **geen productie-deploy** in deze fase.
