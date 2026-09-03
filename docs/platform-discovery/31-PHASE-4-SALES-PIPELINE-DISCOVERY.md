# 31 — Phase 4 Discovery: Sales Pipeline & Opportunities

**Status**: Discovery, geen implementatie. Vervolg op Phase 1–3C
(production-live sinds commit `1792195`). Zie `32-PHASE-4-SALES-PIPELINE-
ARCHITECTURE.md` voor het ontwerp en `33-PHASE-4A-BUILD-SPEC.md` voor de
concrete bouwspecificatie van de eerste deelfase.

## 1. Wat het Control Center vandaag al kan (relevant voor sales)

Volledige inspectie van `prisma/schema.prisma`, `src/modules/*`,
`src/integrations/*`, `src/platform/*`, alle ADR's (001–008) en alle eerdere
discovery-/build-documenten (01–30) bevestigt de volgende capabilities:

| Capability | Waar | Relevantie voor Opportunity |
|---|---|---|
| `CustomerProfile` — klant, `crmStatus`, accountmanager | `schema.prisma`, `src/modules/crm/customer-profile.service.ts` | De klant waaraan een opportunity hangt. `crmStatus` is één waarde per klant — kan geen meerdere gelijktijdige trajecten onderscheiden. |
| `Task` (+ comments, checklist, tags, reminders) | `src/modules/tasks/task.service.ts` | Al voorbereid met ongebruikte velden (`quoteRef`, `shopifyOrderGid`) voor precies dit soort koppeling — nooit met een echt commercieel-traject-concept. |
| `Note` (rich, editable, soft-delete) | `src/modules/crm/note.service.ts` | Herbruikbaar 1-op-1 voor opportunity-notities via een optionele FK. |
| `Appointment` | `src/modules/appointments/appointment.service.ts` | Herbruikbaar voor "afspraak showroom" uit het businessvoorbeeld. |
| `File` (Cloudflare R2) | `src/modules/files/file.service.ts` | Herbruikbaar, geen wijziging nodig. |
| `ExternalContactMatch` (ADR-007) | `src/modules/matching/matching.service.ts` | Klant-identiteitsmatching — niet ontworpen voor, en niet nodig voor, opportunity-koppelingen (die zijn altijd al binnen een bekende klant). |
| Activity Timeline (A/B-projectie) | `src/modules/activity/timeline.ts` | Precies het patroon dat opportunity-gebeurtenissen (aangemaakt, fase gewijzigd, gewonnen/verloren) nodig hebben — puur additief uit te breiden. |
| Shopify orders + draft orders (live, read-only) | `src/integrations/shopify/{orders,draft-orders}.ts` | `ShopifyDraftOrderSummary.completedOrder` bestaat al — een sterk, ongebruikt signaal voor "offerte is bestelling geworden." |
| Federated offertes (OfferteApp + s4u-quote-app) | `src/integrations/quotes/adapter.ts` | Tier-gebaseerde matching, dedup op draft-order-GID — precies het soort externe-referentie-patroon dat een opportunity-koppeling nodig heeft. |
| Federated calls (TelefoonSysteem) | `src/integrations/telephony/adapter.ts` | Klantniveau, geen bericht-/gespreks-ID dat aan één opportunity toe te wijzen is. |
| E-mail (Microsoft 365 geparkeerd, IMAP/Xel live) | `src/integrations/email/*` | Zelfde beperking als calls. |
| Dashboard (taken, komende afspraken, recente activiteit) | `src/app/(app)/page.tsx` | Uit te breiden met een pipeline-sectie — geen nieuwe pagina nodig. |
| Customer 360 tabs: Overzicht, Commercieel, Activiteit, Notities, Taken, Afspraken, Bestanden | `src/app/(app)/customers/[id]/page.tsx` | Commercieel-tab (Orders/Conceptbestellingen/Offertes) is de natuurlijke plek voor een Opportunities-sectie — geen nieuwe top-level tab nodig. |
| Command palette (`/api/search`) | `src/app/api/search/route.ts` | Groep-gebaseerde respons, al drie keer additief uitgebreid (klanten → taken → orders → offertes) — een vierde groep is een bekend patroon. |
| RBAC (`ADMIN`/`AGENT`/`VIEWER`) | `src/platform/auth/guards.ts` | `requireWriteAccess()`/`requireRole()` herbruikbaar zonder wijziging. |
| Audit (`AuditEvent`, TS-only `AuditAction`-union) | `src/platform/audit/audit.ts` | Nieuwe `opportunity.*`-acties zijn een typewijziging, geen migratie. |
| Sidebar-navigatie: "Sales"-sectie met `Offertes`/`Orders` als `comingSoon` | `src/components/layout/nav-config.ts` | Bevestigt dat een verkoop-pipeline-scherm al conceptueel gereserveerd was — maar de bestaande placeholders zijn federated offerte-/orderoverzichten, niet opportunities. Phase 4 voegt een *nieuw* item toe, hergebruikt de placeholders niet. |

## 2. Belangrijkste ontbrekende capability

**Er bestaat geen enkel model, in dit Control Center of in enig
gefedereerd systeem, dat een lopend verkooptraject als eigen entiteit
vastlegt** — waarde, kans, fase, eigenaar, verwachte sluitdatum. Grep over
alle 30 bestaande discovery-/build-documenten en alle 8 ADR's bevestigt: het
woord "opportunity"/"pipeline"/"verkoopkans" komt nergens voor buiten een
irrelevante treffer in `PHASE-1-IMPLEMENTATION-REPORT.md` (§6, over
CI-pipelines). Dit is dus een genuine witte vlek, geen herbouw van iets dat
al bestaat.

`CrmStatus` (`LEAD/ACTIVE/INACTIVE/AT_RISK/VIP`) komt het dichtst in de
buurt, maar is per-klant, niet per-traject — een klant met twee
gelijktijdige, onafhankelijke verkoopkansen (bv. een terrasproject én een
service-/garantiekwestie) kan daarmee niet worden weergegeven, exact het
scenario dat de opdracht als businessdoel stelt.

Offertes (OfferteApp/s4u-quote-app) en Shopify concept-bestellingen zijn
*documenten*, geen *trajecten*: een offerte heeft een status
(`OPEN`/`INVOICE_SENT`/`COMPLETED` bij Shopify, eigen statusveld per
offerte-app), maar geen kans-percentage, geen eigenaarschap-toewijzing los
van de klant, en geen "volgende actie" — en een opportunity kan bovendien
bestaan vóórdat er ooit een offerte is uitgebracht (fases "Nieuw",
"Contact gehad", "Behoefte bepaald" liggen allemaal vóór een offerte).

## 3. Waarom dit geen duplicatie wordt

- **Klantidentiteit**: blijft Shopify (ADR-002) — Opportunity krijgt een
  verplichte `customerProfileId`, geen eigen klantgegevens.
- **Taken/notities/afspraken/bestanden**: blijven exact de bestaande
  modellen (ADR-003) — Opportunity krijgt alleen een optionele FK erbij,
  geen eigen taken-/notitiesysteem.
- **Offertes/orders**: blijven live/gefedereerd (ADR-004/008) — Opportunity
  krijgt een lichte referentie (§4 van de architectuurdoc), nooit een
  kopie van het document zelf.
- **Matching**: `ExternalContactMatch` blijft uitsluitend voor
  klant-identiteitsmatching (ADR-007) — een opportunity-koppeling is altijd
  al binnen een bekende `CustomerProfile`, dus dit is een ander probleem
  (welk extern document hoort bij welke opportunity van deze klant, niet
  welke klant hoort bij dit externe adres).
- **Timeline**: blijft één samengestelde tijdlijn (ADR-008) — opportunity-
  gebeurtenissen worden nieuwe `CONTROL_CENTER`-`Activity`-rijen, geen
  parallel activiteitensysteem.

## 4. Grenzen die dit onderzoek expliciet respecteert

Zoals opgedragen, blijven de volgende zaken buiten scope tenzij een
concrete noodzaak zou blijken (die dit onderzoek niet vond): Microsoft
365/`info@stones4u.nl` (blijft geparkeerd), marketing automation,
nieuwsbrieven, AI lead scoring, AI-geschreven e-mails, voorraadplanning,
volledige ERP, financiële administratie, SMTP/e-mail versturen,
PBX-wijzigingen, herschrijven van OfferteApp/Kassa Systeem/TelefoonSysteem.
Niets in het Phase 4-ontwerp (§32/§33) raakt deze gebieden.

## 5. Conclusie van deze discoveryfase

Het Control Center heeft alle bouwstenen (klant, taken, notities, afspraken,
gefedereerde offertes/orders, timeline, RBAC, audit) om een
Opportunity-laag additief toe te voegen zonder één bestaand model te
wijzigen op een manier die bestaande data raakt. Het enige echt nieuwe
concept is de opportunity zelf plus een lichte externe-linktabel. Zie
`32-PHASE-4-SALES-PIPELINE-ARCHITECTURE.md` voor het volledige ontwerp.
