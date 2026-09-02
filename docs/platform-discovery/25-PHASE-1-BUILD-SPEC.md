# 25 — Phase 1 Build Spec: Control Center Foundation + Customer 360 v1

Concrete functionele specificatie voor de eerste echte bouwfase van het Stones4U Control Center, volgend op ADR-001 t/m ADR-006 en [24-UNIFIED-CONTROL-CENTER-TARGET.md](24-UNIFIED-CONTROL-CENTER-TARGET.md). **Dit document beschrijft wat gebouwd moet worden — er is in deze documentatieronde geen code geschreven.**

## 1. Exacte scope

- Een nieuwe, losstaande applicatie ("Control Center") met eigen PostgreSQL-database, eigen login, eigen deployment.
- Centrale modellen: `User`, `CustomerProfile`, `Activity`, `Note`, `Task`, `AuditEvent` (zie §4).
- Eén Customer 360-scherm dat combineert: Shopify-klant-/orderdata (live), TelefoonSysteem-gespreksgeschiedenis/-notities/-taken (read-only, via een tijdelijk serviceaccount), Exact-facturatiehistorie (read-only, via TelefoonSysteem's bestaande proxy).
- Notities en taken **worden vanaf Phase 1 opgeslagen in Control Center**, niet in TelefoonSysteem.
- Eén centrale zoekfunctie (klanten; taken/notities binnen Control Center) en een command-palette-achtige UX (Ctrl/Cmd+K).
- Basis-audit voor alle muterende acties binnen Control Center.
- Gebruikersbeheer (aanmaken/rol toewijzen) voor Control Center-accounts — **losstaand** van POS/OfferteApp/TelefoonSysteem-gebruikersaccounts (geen gedeelde auth in Phase 1, zie ADR-002/`14-SHARED-CORE-DESIGN.md`).

## 2. Out of scope (expliciet, om scope creep te voorkomen)

- Schrijven naar Shopify (geen order-/klant-mutaties vanuit Control Center in Phase 1).
- Schrijven naar TelefoonSysteem, OfferteApp, s4u-quote-app, of POS — alle integraties zijn read-only.
- Rich-text editing, tags-UI, en bijlagen op Notes (velden worden voorbereid in het schema, functionaliteit volgt in Phase 2).
- Bestandsopslag/R2-koppeling (schema voorbereid, geen upload-functionaliteit — zie ADR-005).
- Appointments, Complaints, Suppliers, Purchase Orders, Production Jobs, Pickup, Delivery (Phase 3–6).
- OfferteApp- of s4u-quote-app-integratie (geen geschikte read-API vandaag, zie `platform-discovery/10`, `11` — Phase 7/8).
- E-mail-integratie (architecturaal voorbereid, niet gebouwd — zie `24`).
- Migratie van historische data uit welke bestaande app dan ook.
- Wijzigingen aan POS, OfferteApp, s4u-quote-app, of TelefoonSysteem.

## 3. Schermen & routes

| Route | Scherm | Rol-toegang |
|---|---|---|
| `/login` | Inloggen | Publiek (niet-ingelogd) |
| `/` | Dashboard: "mijn taken"-widget, recente activiteit, snelzoeken | Alle rollen |
| `/customers` | Klant zoeken/lijst (Shopify-gebaseerd, met lokale `CustomerProfile`-verrijking) | Alle rollen |
| `/customers/[id]` | **Customer 360**: header (naam/bedrijf/status/accountmanager/tags), tabs: Overzicht, Activity Timeline, Notities, Taken, Orders/Omzet | Alle rollen (schrijven notities/taken: AGENT/ADMIN) |
| `/tasks` | Takenlijst met filters (mijn taken / toegewezen / aangemaakt / achterstallig / per klant) | Alle rollen |
| `/tasks/[id]` | Taakdetail met statusgeschiedenis | Alle rollen (wijzigen: eigenaar/toegewezene/ADMIN) |
| `/search` | Volledige-pagina zoekresultaten (fallback voor Ctrl/Cmd+K) | Alle rollen |
| `/admin/users` | Gebruikersbeheer | ADMIN alleen |
| `/settings` | Eigen accountinstellingen (minimaal: wachtwoord wijzigen) | Alle rollen (eigen account) |

Command-palette (Ctrl/Cmd+K) is een overlay-component beschikbaar op elke pagina, geen aparte route.

## 4. Datamodellen & relaties (conceptueel — Prisma-achtig, geen code)

### `User`
`id, email (uniek), passwordHash, name, role (ADMIN | AGENT | VIEWER), active, lastLoginAt, createdAt, updatedAt`. Relaties: `tasksCreated`, `tasksAssigned`, `notesAuthored`, `auditEvents`, `customerProfilesManaged` (als accountmanager).

### `CustomerProfile`
`id, shopifyCustomerGid (uniek — de stabiele externe sleutel, zie ADR-002), displayName, email, phone, phoneNormalized, company, crmStatus (LEAD | ACTIVE | INACTIVE | AT_RISK | VIP), accountManagerUserId?, lastSyncedAt, createdAt, updatedAt`. Relaties: `notes[]`, `tasks[]`, `activities[]`, `tags[]` (aparte `CustomerTag`-koppeltabel, schema voorbereid, UI minimaal in Phase 1).

### `Activity`
`id, customerProfileId, type (NOTE | TASK_CREATED | TASK_STATUS_CHANGED | CALL | SHOPIFY_ORDER | INVOICE | ...), sourceType (CONTROL_CENTER | SHOPIFY | TELEFOONSYSTEEM | EXACT), sourceRefId? (extern ID voor type-B-activiteiten), title, summary?, occurredAt, createdByUserId? (null voor systeem-/adapter-gegenereerd), relatedTaskId?, relatedNoteId?, metadata (JSON), createdAt`. Zie [24](24-UNIFIED-CONTROL-CENTER-TARGET.md) voor het A/B-onderscheid (owned vs. geprojecteerd).

### `Note`
`id, customerProfileId, authorUserId, bodyText (platte tekst in Phase 1), bodyRichJson? (voorbereid veld, ongebruikt tot rich-text-implementatie), tags[]? (voorbereid, geen tag-beheer-UI in Phase 1), editedAt?, deletedAt? (soft delete), createdAt, updatedAt`. **In tegenstelling tot TelefoonSysteem's Notes**: wél bewerkbaar en verwijderbaar (soft delete, audit-gelogd).

### `Task`
`id, title, description?, status (OPEN | IN_PROGRESS | WAITING | DONE | CANCELLED), priority (LOW | NORMAL | HIGH | URGENT), assignedToUserId, createdByUserId, dueAt?, completedAt?, cancelledAt?, customerProfileId?, orderId? (Shopify order GID, veld aanwezig, Phase 1 niet actief bevraagd), quoteId? (extern quote-ID, veld aanwezig voor Phase 7/8), callId? (TelefoonSysteem call-ID, gevuld wanneer een taak vanuit een gesprek/activiteit wordt aangemaakt), supplierId? / purchaseOrderId? / productionJobId? / complaintId? (velden aanwezig, ongebruikt tot latere fases), createdAt, updatedAt`. Statuswijzigingen schrijven een `AuditEvent` (geen aparte `TaskUpdate`-tabel in Phase 1 — audit via de generieke `AuditEvent`, zie §9; een taakspecifiek uitgebreid audit-log kan in Phase 2 alsnog worden toegevoegd als de generieke audit ontoereikend blijkt).

### `AuditEvent`
`id, userId? (null voor systeemacties), action (bijv. "note.created", "task.status_changed", "customer.account_manager_changed"), entityType, entityId, metadata (JSON — bevat bijv. oude/nieuwe waarde), createdAt`.

## 5. Integration adapters (Phase 1)

| Adapter | Richting | Toegangsmethode | Wat wordt opgehaald |
|---|---|---|---|
| **Shopify** | Read-only | `packages/shopify`, OAuth client-credentials (ADR-006) | Klant zoeken/detail, orders, draft orders (voor ordertotaal/openstaande facturen) |
| **TelefoonSysteem** | Read-only | Tijdelijk: een dedicated `VIEWER`-serviceaccount, ingelogd via TelefoonSysteem's bestaande `/api/auth/login`, daarna standaard JWT-bearer-calls naar `GET /api/contacts/:id`, `/api/contacts/:id/notes`, `/api/contacts/:id/tasks`, `/api/calls` (zie `platform-discovery/23`) | Gespreksgeschiedenis, contactnotities, openstaande taken (getoond als referentie/geprojecteerde activiteiten, niet overgenomen als Control Center-taken) |
| **Exact / customer-history** | Read-only | Via TelefoonSysteem's bestaande `GET /api/customer-history/*`-proxy (geen directe databaseverbinding vanuit Control Center — zie `platform-discovery/20` §11) | Omzet-/factuurhistorie, openstaand saldo |

**Matching-vereiste (verplicht, zie ADR-002 en `platform-discovery/22`)**: elke adapter-aanroep die op telefoonnummer of e-mail matcht, moet consistente normalisatie gebruiken (Nederlandse belformaat-varianten) en **expliciet** omgaan met "meerdere kandidaten gevonden" (nooit stilzwijgend de eerste/willekeurige rij kiezen, in tegenstelling tot TelefoonSysteem's automatische pad).

## 6. Permissies

| Rol | Klanten lezen | Notities/Taken lezen | Notities/Taken aanmaken | Notities bewerken/verwijderen | Taken van anderen wijzigen | Gebruikersbeheer |
|---|---|---|---|---|---|---|
| `VIEWER` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `AGENT` | ✅ | ✅ | ✅ | Alleen eigen notities | Alleen als toegewezene/aanmaker | ❌ |
| `ADMIN` | ✅ | ✅ | ✅ | ✅ (alle) | ✅ (alle) | ✅ |

Dit volgt bewust het creator/assignee/admin-patroon dat in TelefoonSysteem's Task-systeem al goed bleek te werken (`platform-discovery/21`), **maar** met een striktere aanmaakregel dan TelefoonSysteem (waar zelfs `VIEWER` taken mocht aanmaken) — hier expliciet niet, conform het striktere permissiemodel dat de nieuwe centrale architectuur vereist.

## 7. UX-requirements

- Desktop-first, responsive, geen mobile-first compromis.
- Command-palette (Ctrl/Cmd+K) vanaf elke pagina: zoekt klanten (naam/bedrijf/e-mail/telefoon) en, binnen Control Center, taken/notities.
- Customer 360 laadt in lagen: Shopify-basisgegevens eerst (snelste bron), gevolgd door TelefoonSysteem- en Exact-panelen die onafhankelijk laden (zie §8, foutisolatie per paneel).
- Visuele stijl: rustig, veel witruimte, moderne typography, subtiele statuskleuren (geen felle, willekeurige kleurcodes), drawers/modals voor snelle acties (notitie toevoegen, taak aanmaken) in plaats van volledige paginaovergangen. Geen generiek admin-template-uiterlijk (zie `24`).
- Tabellen (klantenlijst, takenlijst): sorteerbaar, filterbaar, met duidelijke lege/laad-/foutstaten (zie §8).

## 8. Error states, empty states, loading states

- **Adapter-fout (TelefoonSysteem of Exact onbereikbaar)**: het betreffende paneel op Customer 360 toont een duidelijke, niet-blokkerende melding (bijv. "Gespreksgeschiedenis tijdelijk niet beschikbaar" — consistent met TelefoonSysteem's eigen 503-gedrag voor Exact, zie `platform-discovery/20`). De rest van de pagina (Shopify-data, lokale notities/taken) blijft volledig functioneel.
- **Shopify-fout**: kritieker (Shopify is de identity-bron) — toon een duidelijke foutstaat op klantniveau, maar laat lokale Control Center-functionaliteit (bestaande notities/taken die al gekoppeld zijn) zichtbaar blijven waar mogelijk.
- **Geen zoekresultaten**: expliciete lege staat met suggestie (bijv. "Probeer te zoeken op naam, e-mail, telefoonnummer, of bedrijfsnaam").
- **Meerdere kandidaten bij matching** (TelefoonSysteem/Exact): toon expliciet een keuzelijst, nooit een stilzwijgend gekozen rij (zie §5).
- **Laadstaten**: skeleton-loaders per paneel/tabel, geen blokkerende full-page spinners voor Customer 360 (lagen laden onafhankelijk, zie §7).
- **Lege staten**: "Nog geen notities voor deze klant — voeg de eerste toe", "Geen openstaande taken", etc. — nooit een kaal leeg scherm zonder duiding.

## 9. Audit

Elke muterende actie binnen Control Center schrijft een `AuditEvent`: notitie aanmaken/bewerken/verwijderen, taak aanmaken/statuswijziging/toewijzing/afronden/annuleren, klantprofiel-velden wijzigen (accountmanager, CRM-status, tags), gebruikersbeheer-acties (aanmaken/rol wijzigen/deactiveren), login/logout. Adapter-**leesacties** (Shopify/TelefoonSysteem/Exact opvragen) worden **niet** geaudit als losse gebeurtenis (zou de audit-tabel onnodig vervuilen) — alleen fouten/uitval op adapterniveau worden technisch gelogd (applicatielogging, niet `AuditEvent`).

## 10. Security

- **Wachtwoord-hashing**: argon2 (het sterkste van de drie bestaande keuzes in het landschap, zie `platform-discovery/14`) — een bewust besluit, niet een voortzetting van een van de drie bestaande patronen zonder afweging.
- **Sessies**: DB-backed sessietokens (niet stateless JWT) — leert expliciet van TelefoonSysteem's zwakte (geen revocatie, 7 dagen niet-intrekbaar) door wél een intrekbare sessie te bieden, naar het voorbeeld van POS.
- **CSRF-bescherming** op alle muterende formulieren/routes.
- **Rate limiting** op de login-route (ontbrak in alle drie bestaande systemen, expliciet als les meegenomen).
- **Het tijdelijke TelefoonSysteem-serviceaccount-wachtwoord** wordt uitsluitend server-side bewaard (nooit naar de browser), en dit mechanisme wordt in de documentatie expliciet gemarkeerd als **tijdelijk, te vervangen** in Phase 9 (zie ADR-004, `24`).
- Geen enkel Shopify-, TelefoonSysteem-, of database-secret wordt ooit client-side blootgesteld — alle adapter-aanroepen lopen server-side (Next.js route handlers/server components).

## 11. Tests

- Unit tests: Note/Task-statusovergangen en permissie-logica, telefoon-/e-mailnormalisatie- en matching-logica (inclusief expliciete "meerdere kandidaten"-afhandeling), `CustomerProfile`-upsert-logica (dedup op `shopifyCustomerGid`).
- Integratietests: Shopify-adapter (tegen een gemockte/dev-store), TelefoonSysteem-adapter (gemockt, inclusief het geval "adapter onbereikbaar" en "meerdere kandidaten") .
- Acceptatietests: zie §12.

## 12. Acceptance criteria

1. Een medewerker kan inloggen en zijn eigen dashboard zien met openstaande taken en recente activiteit.
2. Een medewerker kan een klant zoeken (op naam/e-mail/telefoon/bedrijf) en de Customer 360-pagina openen.
3. Customer 360 toont: Shopify-basisgegevens + orderhistorie + ordertotaal + openstaande facturen (live), TelefoonSysteem-gespreksgeschiedenis + contactnotities + openstaande taken (read-only, met correcte foutisolatie als TelefoonSysteem onbereikbaar is), Exact-omzet-/factuurhistorie (read-only, met correcte foutisolatie).
4. Een medewerker (`AGENT`/`ADMIN`) kan een notitie toevoegen aan een klant, deze later bewerken en verwijderen (soft delete) — elke actie zichtbaar in de Activity Timeline en gelogd in `AuditEvent`.
5. Een medewerker kan een taak aanmaken, toewijzen, van status laten wijzigen, en afronden/annuleren — met dezelfde permissieregels als §6, en zichtbaar in `AuditEvent`.
6. De Activity Timeline op Customer 360 toont, gesorteerd op tijdstip, een gecombineerde lijst van lokale (Note/Task) en geprojecteerde (Call) activiteiten, zonder dat de gebruiker het technische onderscheid hoeft te zien.
7. Ctrl/Cmd+K opent een zoekoverlay die klanten (en binnen Control Center taken/notities) vindt.
8. Een `ADMIN` kan gebruikers aanmaken en rollen toewijzen; een `VIEWER` kan niets muteren.
9. **Geen enkele actie in Control Center wijzigt data in POS, OfferteApp, s4u-quote-app, of TelefoonSysteem** — geverifieerd door het ontbreken van elke schrijvende aanroep richting die systemen in de codebase (alleen leesaanroepen).
10. Bij uitval van de TelefoonSysteem- of Exact-adapter blijft de rest van Customer 360 volledig bruikbaar (geen crash, geen blokkerende fout).

## 13. Deployment-aannames

- Fly.io, regio `ams` — consistent met de rest van het landschap (zie `platform-discovery/04-INFRASTRUCTURE-MAP.md`, "Fly.io sluit al volledig aan").
- Eigen Fly Postgres-database, volledig geïsoleerd van alle bestaande app-databases.
- Geen R2-bucket nodig in Phase 1 (schema voorbereid, geen upload-functionaliteit, zie ADR-005).
- Geen wijziging aan enige bestaande Fly-app, -database, of -configuratie.

## 14. Benodigde environment-variabelen (namen, geen waarden)

**Database**: `DATABASE_URL`.
**App**: `NODE_ENV`, `APP_ENV`.
**Auth**: `SESSION_SECRET` (of gelijkwaardig, voor sessietoken-signing/hashing — exacte naam bij implementatie te bepalen).
**Shopify** (ADR-006): `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_API_VERSION`, `SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN` (shop-identity-guard, naar POS' voorbeeld).
**TelefoonSysteem-adapter** (tijdelijk serviceaccount, zie §10): `TELEFOONSYSTEEM_API_BASE_URL`, `TELEFOONSYSTEEM_SERVICE_ACCOUNT_EMAIL`, `TELEFOONSYSTEEM_SERVICE_ACCOUNT_PASSWORD`.

Geen enkele waarde hiervan wordt in deze of enige andere discovery-documentatie vastgelegd.

## 15. Migratiestrategie

**Geen migratie van bestaande data in Phase 1.** Shopify-, TelefoonSysteem-, en Exact-data blijven volledig in hun bronsystemen en worden live (of via de adapter) bevraagd — niets wordt gekopieerd/geïmporteerd naar de Control Center-database. De Control Center-database start leeg (op de eerste `ADMIN`-gebruiker na, aangemaakt via een bootstrap-script naar het voorbeeld van OfferteApp's `bootstrap-production.ts`, zie `platform-discovery/10`). Toekomstige fases (bijv. Phase 8, OfferteApp-integratie) kunnen wél historische-datamigratie vereisen — dat wordt in die fase apart uitgewerkt, niet hier.

## 16. Rollback-strategie

Omdat Phase 1 **geen enkele bestaande app of database wijzigt**, is de rollback triviaal en risicoloos voor de rest van het landschap:
- Control Center-applicatie stoppen/undeployen — geen effect op POS, OfferteApp, s4u-quote-app, of TelefoonSysteem.
- Control Center-database kan volledig verwijderd worden zonder gevolgen voor enig ander systeem (volledig geïsoleerd, geen gedeelde tabellen/foreign keys).
- Indien alleen de TelefoonSysteem-/Exact-adapters problematisch blijken (bijv. het tijdelijke serviceaccount geeft ongewenste belasting op TelefoonSysteem): deze adapters kunnen individueel uitgeschakeld worden (feature-vlag) zonder de rest van Control Center te beïnvloeden — Customer 360 valt dan terug op alleen Shopify-data.
- Het TelefoonSysteem-serviceaccount kan op elk moment door de TelefoonSysteem-beheerder gedeactiveerd worden via de bestaande gebruikersbeheer-UI, zonder enige Control Center-code te hoeven wijzigen.
