# 18 — Aanbevolen evolutionaire bouwvolgorde

Concreet, gefaseerd, geen algemene tekst. Elke fase is ontworpen om **niets** aan bestaande, productie-draaiende apps te breken — behalve Fase 3, die dat expliciet en bewust wél doet, met een eigen, zwaardere goedkeuringseis.

> **UPDATE 2026-09-01 (na TelefoonSysteem-onderzoek)**: **Fase 1 hieronder is vervangen** door een rijkere versie in [23-CRM-PHASE-1-FINAL-RECOMMENDATION.md](23-CRM-PHASE-1-FINAL-RECOMMENDATION.md) — TelefoonSysteem blijkt een bestaande, voor elke rol leesbare API te hebben (Contacts/Calls/Notes/Tasks/Exact-historie), waardoor Fase 1 zonder extra risico kan worden uitgebreid met gespreksgeschiedenis, contactnotities, openstaande taken en facturatiehistorie naast Shopify.
>
> **ARCHITECTUURWIJZIGING 2026-09-01 (tweede update)**: **de volledige bouwvolgorde in dit document is vervangen** door een nieuw target-model — zie `docs/architecture/ADR-001` t/m `ADR-006`, [24-UNIFIED-CONTROL-CENTER-TARGET.md](24-UNIFIED-CONTROL-CENTER-TARGET.md) (de nieuwe, leidende fasering) en [25-PHASE-1-BUILD-SPEC.md](25-PHASE-1-BUILD-SPEC.md) (de concrete Phase 1-specificatie, die zowel deze pagina's Fase 1 als 23's versie vervangt). De kern-reden: Notes/Tasks worden vanaf Phase 1 **centrale, eigen Control Center-modellen** in plaats van permanente API-afhankelijkheden van TelefoonSysteem (zie ADR-003). De onderliggende evolutionaire principes hieronder (geen big-bang, bestaande apps blijven onaangetast, Fase 0-achtige besluitvorming eerst) blijven wél volledig geldig en zijn in `24`/`25` verder uitgewerkt.

---

## Fase 0 — Uitlijnen & fundamentele besluiten (geen code)

**Doel**: de open architecturale vragen beantwoorden die anders elke volgende fase op aannames zouden baseren.

**Exacte onderdelen**:
- Besluit: wordt Shopify de blijvende bron van waarheid voor klanten, of wordt het CRM de eerste lokale Customer-master? (zie [14-SHARED-CORE-DESIGN.md](14-SHARED-CORE-DESIGN.md))
- Besluit: bevestig Cloudflare R2 als opslagtechnologie voor Files/foto's/tekeningen/documenten (of alternatief).
- Besluit: moet de ontbrekende koppeling tussen s4u-quote-app en OfferteApp gedicht worden, en zo ja, in welke richting (webhook vanuit s4u-quote-app, polling vanuit OfferteApp, of iets anders)? Zie [13-END-TO-END-DATAFLOW.md](13-END-TO-END-DATAFLOW.md).
- Besluit: welke Shopify-authenticatiestrategie wordt de standaard voor **nieuwe** modules (client-credentials zoals POS, of iets anders)?

**Afhankelijkheden**: geen.

**Bestaande apps onaangetast**: alle vier (CRM, OfferteApp, s4u-quote-app, Kassa Systeem) — puur besluitvorming.

**Risico**: laag qua techniek, maar het overslaan van deze fase is het grootste risico in het hele traject — elke volgende fase bouwt op deze besluiten.

**Acceptance criteria**: de vier besluiten hierboven zijn schriftelijk vastgelegd (bijv. als ADR/decisions-document) en door de gebruiker geaccordeerd.

---

## Fase 1 — Shared Core Shopify-package + read-only CRM Customer-view — **DE EERSTE BOUWFASE**

**Doel**: een klein, geïsoleerd, direct bruikbaar stukje CRM opleveren zonder enige bestaande app aan te raken.

**Exacte onderdelen**:
1. `packages/shopify` (nieuwe, losstaande package): token-acquisitie/cache (patroon van POS' `shopify.ts`), GraphQL-transport met retry (patroon van OfferteApp's `graphql_client.py`), shop-identity-verificatie (patroon van POS' `shopify-guard.ts`), write-guard-scaffolding (ongebruikt in deze fase — CRM schrijft nog niets naar Shopify).
2. In de CRM-workspace: een minimale app-skeleton (framework-keuze door de gebruiker, geen bestaande stack hoeft hergebruikt te worden) die `packages/shopify` gebruikt om **alleen te lezen**: klant zoeken (naam/e-mail/telefoon), klantdetail met Shopify-orderhistorie, ordertotalen, openstaande Shopify-facturen (Draft Order `INVOICE_SENT`-status).
3. Geen schrijfacties naar Shopify, geen koppeling met OfferteApp/s4u-quote-app/POS databases.

**Afhankelijkheden**: Fase 0 (auth-strategiebesluit).

**Bestaande apps onaangetast**: **volledig** — POS, OfferteApp, s4u-quote-app worden op geen enkele manier aangeroepen, gewijzigd, of zelfs maar uitgelezen. Deze fase praat uitsluitend rechtstreeks met Shopify's eigen API, met dezelfde soort read-only scopes die elke andere app ook al gebruikt.

**Risico**: laag — uitsluitend leesverkeer naar Shopify, geen schrijfacties, geen productie-impact op bestaande systemen. Het enige risico is API-rate-limiting bij Shopify zelf, beheersbaar met dezelfde throttle-aware aanpak die OfferteApp al toont.

**Acceptance criteria**: een medewerker kan in het nieuwe CRM een klant opzoeken en diens Shopify-orderhistorie + ordertotaal + openstaande facturen zien — informatie die vandaag alleen in Shopify Admin zelf te vinden is, nu voor het eerst in een Stones4U-eigen scherm. Geen regressie mogelijk, want er wordt niets bestaands gewijzigd.

---

## Fase 2 — Lokale notities & klanttijdlijn (eerste eigen CRM-data)

**Doel**: het CRM zijn eerste eigen, schrijfbare data geven — notities en een handmatige activiteiten-tijdlijn per klant.

**Exacte onderdelen**: een CRM-eigen database (nieuw, niet gedeeld met een bestaande app), een `Note`-model (platte tekst eerst, rich-text als latere uitbreiding), een `CustomerActivity`-achtige tijdlijn (patroon: OfferteApp's `CustomerActivity`) die notities combineert met de Shopify-orderhistorie uit Fase 1 in één chronologisch overzicht. Audit-logging van notitie-wijzigingen via een eerste, kleine versie van de Core Audit-service uit [14-SHARED-CORE-DESIGN.md](14-SHARED-CORE-DESIGN.md).

**Afhankelijkheden**: Fase 1 (Customer-view als basis om notities aan te hangen).

**Bestaande apps onaangetast**: alle drie — dit is uitsluitend nieuwe, CRM-eigen data.

**Risico**: laag-gemiddeld — eerste keer dat het CRM een eigen database nodig heeft; standaard operationele zorgen (backups, migraties) gelden, maar geen enkele bestaande app wordt geraakt.

**Acceptance criteria**: een medewerker kan een notitie toevoegen aan een klant en deze terugzien in een tijdlijn naast diens Shopify-orders.

---

## Fase 3 — Koppeling s4u-quote-app ↔ OfferteApp (alleen als Fase 0 dit besluit bevestigt)

**Doel**: de in [13-END-TO-END-DATAFLOW.md](13-END-TO-END-DATAFLOW.md) bevestigde ontbrekende schakel dichten, met het al bewezen interne-API-patroon (`x-integration-key`/bearer-token, zoals Pallet Yard/Transport-S4U vandaag al gebruiken).

**Exacte onderdelen**: een nieuw, smal inbound-endpoint in OfferteApp naar het voorbeeld van het bestaande `POST /api/warehouse/callback` (bijv. `POST /api/quotes/intake`), dat een offerteaanvraag vanuit s4u-quote-app omzet in een gekoppelde `Quote`-rij (of een apart "externe aanvraag"-model, ter beoordeling tijdens ontwerp) — **zonder** de bestaande handmatige bezoekrapport-flow te wijzigen of te verwijderen.

**Afhankelijkheden**: Fase 0-besluit, Fase 1-package (voor een consistente interne-auth-aanpak).

**Bestaande apps onaangetast**: **s4u-quote-app niet, of nauwelijks** (voegt hoogstens een uitgaande call toe aan een al bestaand endpoint-patroon). **OfferteApp WORDT hier voor het eerst en enige keer in deze hele volgorde gewijzigd** — dit is een bewuste uitzondering en vereist een eigen, apart goedkeuringstraject volgens OfferteApp's eigen gedocumenteerde werkwijze (research → plan → expliciete goedkeuring → bouwen → testen → tonen → goedkeuring → committen → goedkeuring → deployen → productie-verificatie, zoals vastgelegd in `docs/PROJECT_STATUS.md`). Dit rapport stelt de wijziging voor, voert hem niet uit.

**Risico**: **gemiddeld tot hoog** — dit is de enige fase die een live productie-app (OfferteApp v455) aanraakt. Zorgvuldige, kleine, backward-compatible implementatie is essentieel; de bestaande handmatige flow moet volledig blijven werken.

**Acceptance criteria**: een offerteaanvraag ingediend via de storefront verschijnt automatisch, zonder handmatige overtyping, als gekoppelde/herkenbare aanvraag in OfferteApp of het CRM; de bestaande handmatige bezoekrapport-flow in OfferteApp functioneert ongewijzigd.

---

## Fase 4 — Bestandsopslag (foto's, tekeningen, documenten)

**Doel**: de ontbrekende Files-Shared-Core-component bouwen (er is nergens iets werkends om te hergebruiken — OfferteApp's `Attachment`-model is een niet-geïmplementeerde placeholder), eerst gebruikt binnen het CRM.

**Exacte onderdelen**: Cloudflare R2-bucket (per Fase 0-besluit), `packages/files` (upload/ophalen, met dezelfde soort veiligheidsdiscipline als de rest van Core), gekoppeld aan CRM-klantdossiers en aan een toekomstige Service/klachten-module.

**Afhankelijkheden**: Fase 0 (opslagtechnologie-besluit), Fase 2 (CRM-datamodel om bestanden aan te hangen).

**Bestaande apps onaangetast**: alle drie — OfferteApp's eigen placeholder-`Attachment`-model wordt niet gemigreerd of aangeraakt in deze fase.

**Risico**: laag — nieuwe infrastructuur, geen bestaande data in het geding.

**Acceptance criteria**: een foto kan aan een klant/case worden geüpload en later worden opgehaald; opslagkosten/toegangsrechten zijn geverifieerd.

---

## Fase 5 en verder — buiten scope van dit rapport, ter latere uitwerking

Taken, klantafspraken, Service/klachten-module (volledig nieuw domein, geen bestaande code), Operations-module (purchase orders, productieopdrachten, genormaliseerd leverplanning-model dat Van Eijk én Hoefnagels bedient), en — pas wanneer er meerdere bewezen consumenten van de Core-package zijn — de vraag of POS en/of OfferteApp zelf ooit vrijwillig overstappen op de gedeelde Shopify-/Auth-/Audit-laag. Zie [07-MIGRATION-RECOMMENDATION.md](07-MIGRATION-RECOMMENDATION.md) voor de bredere evolutionaire principes die ook op deze latere fases van toepassing blijven.
