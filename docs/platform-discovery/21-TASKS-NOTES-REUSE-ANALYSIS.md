# 21 — Contacts, Notes & Tasks: hergebruikanalyse (TelefoonSysteem)

Bron: volledige lezing van `apps/api/src/routes/contacts.ts`, `apps/api/src/routes/tasks.ts`, het hoofdschema `prisma/schema.prisma` (modellen `Contact`, `ContactNote`, `CallNote`, `Task`, `TaskUpdate`), de bijbehorende migraties (`20260417141951_add_contact_notes`, `20260416122645_add_task_system`), en de relevante frontend-componenten onder `apps/web/src/app/{contacts,tasks}/` en `apps/web/src/components/{contacts,calls,dashboard}/`.

> **ARCHITECTUURWIJZIGING 2026-09-01**: zie `docs/architecture/ADR-003`. De classificaties hieronder (Contacts: 3, Notes: 3, **Tasks: B — hergebruiken met uitbreiding**) blijven een correcte analyse van wat TelefoonSysteem bevat en hoe goed het is. **De architecturale conclusie voor Tasks is herzien**: in plaats van via API te hergebruiken, bouwt het Control Center een eigen, breder `Task`-model (zie [25-PHASE-1-BUILD-SPEC.md](25-PHASE-1-BUILD-SPEC.md) §4), met TelefoonSysteem's model als referentie voor de statusmachine, het permissiepatroon (creator/assignee/admin), en het audit-log-idee — niet als de onderliggende implementatie. Lees "B" hieronder daarom als "sterke referentiewaarde", niet als "wordt via API aangesproken".

## 1. Contacts

### Wat is een Contact precies?

```prisma
model Contact {
  id          String  @id @default(cuid())
  phoneNumber String  @unique
  displayName String?
  companyName String?
  email       String?
  notes       String? @db.Text   // dode kolom, zie hieronder
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  calls        Call[]
  tasks        Task[]
  contactNotes ContactNote[]
}
```

Een **dunne, telefoonnummer-gesleutelde join-/cacherij**, geen volwaardig klantprofiel:
- Natuurlijke sleutel is `phoneNumber` (`@unique`) — dit ís de identiteit, niet een Shopify-ID.
- **Geen `shopifyCustomerId`/GID-veld.** Contact en Shopify Customer zijn twee volledig gescheiden identiteitssystemen, alleen gekoppeld *op query-tijd* via telefoonnummer-stringmatching — geen persistente FK of cache-kolom.
- `notes String? @db.Text` — een enkel legacy vrije-tekstveld, **bevestigd dode code**: nul lees-/schrijfreferenties gevonden ergens in de repo. Vervangen door het aparte `ContactNote`-model, maar de kolom/migratie is nooit opgeruimd.
- Geen los `Phone`-model — een Contact ís één telefoonnummer-string. Meerdere nummers per persoon worden niet gemodelleerd; belt iemand van twee nummers, dan ontstaan twee losse Contact-rijen zonder koppeling.

### CRUD & routes

Geen enkele rolbeperking op de hele `contacts.ts`-router — elke ingelogde gebruiker (ook `VIEWER`) kan elk Contact lezen, aanmaken (via `/ensure`) en van notities voorzien. Geen update/delete-route (behalve impliciet binnen `/ensure`). Zie [19-TELEFOONSYSTEEM-CRM-DEEP-DIVE.md](19-TELEFOONSYSTEEM-CRM-DEEP-DIVE.md) §5 voor de volledige routetabel.

### Contact-matching bij een gesprek

**Kritieke bug/risico**: de matching bij een binnenkomend gesprek (`apps/ami-worker/src/services/callCorrelation.ts:114`, `prisma.contact.findUnique({ where: { phoneNumber: callerNumber } })`) gebruikt **exacte string-matching, zonder de telefoonnormalisatie** die elders in de app wel bestaat (`normalizePhoneForLookup`, gebruikt door `/contacts/ensure` en de Shopify-lookups). Is een Contact opgeslagen als `0612345678` en levert de PBX `+31612345678`, dan matcht dit **niet** — er wordt geen Contact gekoppeld aan het gesprek, ook al bestaat er al een passende rij. Geen auto-aanmaak van een Contact bij een inkomend gesprek zonder match; dat gebeurt pas later, on-demand, als een medewerker de contactpagina opent.

### Vergelijking met het gewenste CRM Customer/CustomerProfile-concept

Dit is **geen** CRM-klantrecord. Het bestaat specifiek om `Call`- en `Task`-rijen iets lokaals te geven om naar te verwijzen, en om `ContactNote`s te hosten — niet om rijke klantdata (adres, tags, omzet) te dragen; die wordt altijd live uit Shopify gehaald en nooit lokaal bewaard. Het ontbreekt aan: multi-kanaal-identiteit (alleen één telefoonnummer, geen meerdere nummers/e-mails), een echte koppeling naar Shopify's klant-GID, en elke vorm van merge/dedup.

**Antwoord op de gestelde vraag**: het CRM moet dit Contact-model **niet** als centrale Customer-identiteit gebruiken. Het is wél bruikbaar als **concept** (een lichte lokale join-rij tussen telefonie en een externe klantbron) — zie [22-CUSTOMER-IDENTITY-STRATEGY.md](22-CUSTOMER-IDENTITY-STRATEGY.md) voor de aanbevolen aanpak.

**Classificatie**: **3. CONCEPT/DATAMODEL HERGEBRUIKEN MAAR NIEUWE IMPLEMENTATIE.**

---

## 2. Notes

### Twee gescheiden modellen, geen polymorf Note-type

`CallNote` (aan een `Call` gekoppeld) en `ContactNote` (aan een `Contact` gekoppeld) hebben identieke vorm (`id`, `message String @db.Text`, `userId`-FK, timestamps) maar zijn **losse modellen**, geen gedeeld polymorf Note-type. Plus de hierboven genoemde dode `Contact.notes`-kolom — een derde, ongebruikte "notitie-achtige" plek.

### Opslag & kenmerken

- **Platte tekst, geen rich text.** Beide zijn `@db.Text`. Frontend gebruikt een kale `<textarea>` (`NotesChat.tsx`, `ContactNotesPanel.tsx`); geen WYSIWYG/markdown-library in `apps/web/package.json`. Weergave via `whitespace-pre-wrap`, geen `dangerouslySetInnerHTML`.
- **Geen bijlagen.** Geen upload-/attachment-code bij notitie-routes of -componenten gevonden.
- **Append-only.** Geen enkele PATCH/DELETE-route voor `CallNote` of `ContactNote` — notities zijn onveranderlijk na aanmaak, geen edit-geschiedenis, geen soft-delete-vlag.
- **Geen rechten-check.** Elke ingelogde gebruiker kan op elk contact/gesprek een notitie plaatsen — geen eigenaarschap, geen rolbeperking (en dus, omdat er toch niet bewerkt kan worden, ook geen "mag ik andermans notitie bewerken"-vraag).
- **"Maak taak van notitie"-functie bestaat in de UI** (`NotesChat.tsx`), maar de onderliggende `Task.sourceNoteId`-koppeling wordt **nooit daadwerkelijk gezet** door deze flow — de database-relatie bestaat en wordt door de API geaccepteerd, maar geen enkel UI-pad vult hem. In de praktijk maakt "converteren naar taak" een nieuwe, **ongekoppelde** taak wiens omschrijving toevallig de notitietekst kopieert — geen traceerbare link terug naar de oorspronkelijke notitie.

### Vergelijking met de CRM-wens

| CRM-wens | TelefoonSysteem heeft dit? |
|---|---|
| Rich-text klantnotities | ❌ Nee — platte tekst |
| Meerdere notities per klant | ✅ Ja (maar gesplitst over twee incompatibele modellen + één dode kolom) |
| Auteur/tijdstip | ✅ Ja |
| Tags | ❌ Nee |
| Bijlagen | ❌ Nee |
| Zichtbaar in Customer Timeline | ⚠️ Gedeeltelijk — technisch mogelijk via API, maar er is geen enkele bestaande timeline die Call+Note+Task al combineert |

**Wat is herbruikbaar**: het datamodel-idee (auteur/tijdstip/vrije tekst/entiteitsgebonden) en het "notitie → taak"-UX-patroon (los van de kapotte koppeling). De implementatie zelf (plat, niet-polymorf, niet-bewerkbaar, geen bijlagen) dekt de CRM-wens niet.

**Classificatie**: **3. CONCEPT/DATAMODEL HERGEBRUIKEN MAAR NIEUWE IMPLEMENTATIE.** Een CRM-Notitiemodel heeft rich text, tags en bijlagen nodig die hier niet bestaan — dit rechtvaardigt een nieuwe implementatie, met behoud van het simpele "auteur+tijdstip+entiteit"-idee.

---

## 3. Task-systeem

### Volledig model

```prisma
enum TaskStatus { OPEN IN_BEHANDELING WACHT_OP_KLANT WACHT_OP_COLLEGA GEPLAND AFGEROND GEANNULEERD }
enum TaskPriority { LAAG NORMAAL HOOG URGENT }
enum TaskUpdateType { COMMENT STATUS_CHANGE ASSIGNMENT_CHANGE PRIORITY_CHANGE SYSTEM COMPLETION }

model Task {
  id, title, description
  status TaskStatus @default(OPEN)
  priority TaskPriority @default(NORMAAL)
  createdByUserId, assignedToUserId   // beide verplicht, FK naar User
  callId?, contactId?, sourceNoteId?  // optionele koppelingen
  dueAt?, completedAt?, cancelledAt?
  createdAt, updatedAt
  updates TaskUpdate[]                // volledig append-only audit-log
}
```

- **Status**: 7-waarden Nederlandstalige enum, `OPEN` default; `AFGEROND`/`GEANNULEERD` overal behandeld als de twee "gesloten" statussen.
- **Prioriteit**: 4 waarden, `NORMAAL` default.
- **Assignee**: verplicht (niet nullable) — elke taak heeft een eigenaar; bij ontbreken standaard de aanmaker.
- **Creator**: verplicht.
- **Relatie met klant/contact**: optionele `contactId`.
- **Relatie met call/note**: optionele `callId`, optionele (maar in de praktijk ongebruikte, zie hierboven) `sourceNoteId`.
- **Recurrence/reminders**: **geen** — geen enkel veld hiervoor gevonden in het schema.

### Permissies

- Alleen `GET /api/tasks/all` is `ADMIN`-only.
- Per-taak-toegang (bekijken/bewerken/reageren/afronden): aanmaker, toegewezene, of admin.
- Annuleren: **strenger** — alleen aanmaker of admin (de toegewezene alleen kan niet annuleren).
- **Taken aanmaken staat open voor iedereen**, inclusief `VIEWER` — elke ingelogde gebruiker kan taken aanmaken en aan wie dan ook toewijzen.

### Filtering & dashboard

Routes voor "mijn taken", "aan mij toegewezen", "door mij aangemaakt", "achterstallig", plus een admin-`/all` met filters op status/prioriteit/toegewezene/aanmaker (max. 100 resultaten). Een dashboardwidget (`TaskDashboardPanel.tsx`) pollt elke 30s een samenvatting-endpoint en toont vier klikbare tegels (aan mij / door mij / achterstallig / vandaag klaar). Taakdetailpagina met realtime Socket.IO-updates.

### Audit

**Het enige subsysteem in dit hele onderzoek met een echt, volledig audit-log**: elke statuswijziging, prioriteitswijziging, herroestoewijzing, reactie, afronding en annulering schrijft een `TaskUpdate`-rij (type, oude/nieuwe waarde, auteur, tijdstip). Rijker dan Contacts of Notes, en rijker dan wat POS/OfferteApp voor losse taken hebben (die hebben geen taakconcept).

### Vergelijking met de gewenste CRM-taken

Dit is **het meest CRM-klare onderdeel** van heel TelefoonSysteem: status/prioriteit-model, verplichte eigenaar+aanmaker, koppeling naar klant én naar de oorsprong-interactie (call), een echt audit-log, rolgebaseerde autorisatie op recordniveau, een dashboardwidget, en realtime updates. Wat ontbreekt t.o.v. een generiek CRM-taaksysteem: recurrence/herinneringen, Nederlandstalige enum-waarden die vastgebakken in het schema zitten (zou gelokaliseerd/gegeneraliseerd moeten worden voor platformbreed gebruik), en te ruime aanmaakrechten (elke rol, ook `VIEWER`).

### Classificatie

**B. HERGEBRUIKEN MET UITBREIDING** *(oorspronkelijke analyse — zie onderstaande herziening)*

Onderbouwing (blijft geldig als analyse): het datamodel, de statusmachine, het audit-log-patroon (`TaskUpdate`) en de permissiestructuur (aanmaker/toegewezene/admin) zijn precies wat een CRM-taaksysteem nodig heeft, en zijn al productie-getest binnen TelefoonSysteem. Dit is geen "volledig hergebruiken" (A) omdat het Task-model uitsluitend aan `Contact`/`Call` koppelt, niet aan de bredere set CRM-entiteiten (Quote, Purchase Order, Klacht) die het CRM straks nodig heeft.

> **Herziening (ADR-003, 2026-09-01)**: de oorspronkelijk aanbevolen route ("CRM hergebruikt dit via API, TelefoonSysteem's `/api/tasks/*`-endpoints blijven de bron van waarheid") is **niet overgenomen** als target-architectuur. In plaats daarvan bouwt het Control Center een **eigen, centraal `Task`-model** (zie [25-PHASE-1-BUILD-SPEC.md](25-PHASE-1-BUILD-SPEC.md) §4) met relaties naar Customer/Order/Quote/Call/Supplier/PurchaseOrder/ProductionJob/Complaint vanaf het ontwerp — TelefoonSysteem's model dient als **referentie voor businessregels** (statusmachine, permissiepatroon, audit-idee), niet als draaiende afhankelijkheid. Reden: permanente architecturale afhankelijkheid van een systeem dat voor een ander domein (telefonie) is gebouwd, zou de kwaliteit/consistentie van CRM-kernfunctionaliteit ondergeschikt maken aan maximale code-hergebruik — precies wat het nieuwe fundamentele principe (zie ADR-001) wil vermijden. TelefoonSysteem's eigen taken (aan `Contact`/`Call` gekoppeld) blijven intussen gewoon bestaan in TelefoonSysteem en worden, waar nuttig, als **geprojecteerde activiteit** getoond in de Control Center Activity Timeline (type B, zie [24-UNIFIED-CONTROL-CENTER-TARGET.md](24-UNIFIED-CONTROL-CENTER-TARGET.md)) — niet gemigreerd, niet dubbel opgeslagen.
