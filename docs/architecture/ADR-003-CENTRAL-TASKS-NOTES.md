# ADR-003 — Nieuwe centrale Task/Note-modellen; bestaande implementaties alleen referentie

**Status**: Besloten (2026-09-01). **Herziet expliciet** de aanbeveling in [platform-discovery/21-TASKS-NOTES-REUSE-ANALYSIS.md](../platform-discovery/21-TASKS-NOTES-REUSE-ANALYSIS.md) ("Tasks: B — hergebruiken via API") en de daarop gebaseerde Fase 1 in [23-CRM-PHASE-1-FINAL-RECOMMENDATION.md](../platform-discovery/23-CRM-PHASE-1-FINAL-RECOMMENDATION.md).

## Context

`platform-discovery/21` classificeerde TelefoonSysteem's `Task`/`TaskUpdate`-systeem als "B — hergebruiken via API": een rijk, productie-getest model met status/prioriteit-machine, verplichte eigenaar+aanmaker, en een volledig audit-log. De eerder voorgestelde route was om dit als **permanente** bron van waarheid voor CRM-taken te gebruiken.

Bij nader inzien: TelefoonSysteem's Task-model is ontworpen voor een smaller domein (koppeling aan `Contact`/`Call` alleen) en draagt de zwaktes van dat systeem mee (Nederlandstalige enum-waarden vastgebakken in het schema, aanmaakrechten open voor elke rol inclusief `VIEWER`, geen recurrence/herinneringen, een niet-ideaal auth-model voor extern/CRM-gebruik — zie `platform-discovery/19` §4). Permanente architecturale afhankelijkheid van dit model zou CRM-kernfunctionaliteit laten leunen op een systeem dat niet voor dit doel ontworpen is.

Hetzelfde geldt voor Notes: geen van de bestaande implementaties (OfferteApp's `Quote.internal_note`/`VisitReport`, TelefoonSysteem's `CallNote`/`ContactNote`) ondersteunt rich text, tags, of bijlagen — allemaal platte tekst, en bij TelefoonSysteem bovendien append-only zonder edit/delete.

## Besluit

Het Control Center krijgt **eigen, nieuwe centrale modellen** voor `Task` en `Note` — geen van de bestaande implementaties wordt de toekomstige centrale implementatie.

**Task** (conceptueel — zie [25-PHASE-1-BUILD-SPEC.md](../platform-discovery/25-PHASE-1-BUILD-SPEC.md) voor het volledige veldenoverzicht) ondersteunt vanaf het ontwerp relaties naar: Customer, Shopify Order, Quote, Quote Request, Call, Note, Supplier, Purchase Order, Production Job, Pickup, Delivery, Complaint/Service Case — een bredere set dan TelefoonSysteem's Task ooit nodig had.

**Note** ondersteunt vanaf het ontwerp: rich text (voorbereid, niet per se Phase 1 volledig af), meerdere notities per klant, auteur, timestamps, tags, bijlagen, koppelingen naar meerdere domeinen, timeline-integratie, audit, permissions.

**TelefoonSysteem's bestaande `Task`/`CallNote`/`ContactNote` worden gebruikt als referentiemateriaal** voor businessregels (statusovergangen, autorisatiemodel, audit-patroon) — niet als code, niet als database, niet via permanente API-afhankelijkheid. TelefoonSysteem wordt **nu niet gewijzigd of gemigreerd**.

**TelefoonSysteem's CallNotes/ContactNotes blijven voorlopig bestaan** en worden, waar nuttig, **read-only als activiteiten getoond** in de Control Center Activity Timeline (zie ADR-004) — dit is geen tegenspraak met bovenstaande: het gaat om het tónen van bestaande gespreksnotities als tijdlijn-item, niet om het overnemen van TelefoonSysteem's Note-model als CRM-notitiesysteem.

## Consequenties

- Meer initieel ontwerp-/bouwwerk in Phase 1 dan de eerder voorgestelde API-hergebruik-route, omdat Task en Note vanaf nul (maar met TelefoonSysteem als goede referentie) ontworpen worden.
- Geen enkele afhankelijkheid van TelefoonSysteem's uptime/auth-model voor CRM-kernfunctionaliteit (taken/notities aanmaken werkt onafhankelijk van TelefoonSysteem).
- TelefoonSysteem-gespreksdata blijft wél een integratie (via ADR-004's adapter-strategie) voor de Activity Timeline — dit besluit gaat niet over het negeren van TelefoonSysteem-data, alleen over waar CRM-taken/-notities **worden opgeslagen**.
- `platform-discovery/21`'s classificatie ("B — hergebruiken via API") wordt hiermee **niet gewist maar herzien** — de analyse zelf (wat TelefoonSysteem's model wél/niet kan) blijft correct en waardevol als referentiemateriaal; alleen de architecturale conclusie verandert.
