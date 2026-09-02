# 23 — CRM Phase 1: definitieve aanbeveling (na analyse van alle bekende apps)

> **ARCHITECTUURWIJZIGING 2026-09-01 — dit document is SUPERSEDED**: na dit rapport is een expliciete richtingsbeslissing genomen (`docs/architecture/ADR-001` t/m `ADR-006`) om Notes/Tasks vanaf Phase 1 als **eigen, centrale Control Center-modellen** te bouwen in plaats van permanent via TelefoonSysteem's API te lezen/schrijven zoals hieronder nog wordt voorgesteld. **De actuele, geldende Phase 1-specificatie staat in [25-PHASE-1-BUILD-SPEC.md](25-PHASE-1-BUILD-SPEC.md)**, met de high-level richting in [24-UNIFIED-CONTROL-CENTER-TARGET.md](24-UNIFIED-CONTROL-CENTER-TARGET.md). Dit document blijft staan omdat de onderliggende analyse (TelefoonSysteem heeft een bruikbare read-API, geschikt als *adapter* voor de Activity Timeline) nog steeds correct en relevant is — alleen de conclusie "dus bouwen we Notes/Tasks daar bovenop" is herzien; TelefoonSysteem's API wordt in de nieuwe architectuur uitsluitend gebruikt als read-only adapter voor gespreksdata, niet als opslag voor CRM-taken/-notities.

Deze aanbeveling vervangt/verfijnt Fase 1 uit [18-RECOMMENDED-BUILD-SEQUENCE.md](18-RECOMMENDED-BUILD-SEQUENCE.md), nu alle vier bekende Stones4U-apps (POS, OfferteApp, s4u-quote-app, TelefoonSysteem) zijn onderzocht. Fase 0 (de vier fundamentele besluiten uit 18) blijft ongewijzigd van toepassing en moet nog steeds eerst genomen worden.

## De belangrijkste nieuwe inzicht uit TelefoonSysteem

TelefoonSysteem heeft, in tegenstelling tot OfferteApp en s4u-quote-app, **een al werkende, geauthenticeerde REST API met een open (niet-rol-beperkt) leesrecht op Contacts, Notes, Calls, Tasks en Exact-facturatiehistorie.** Elke ingelogde gebruiker — ook de rol `VIEWER`, die geen enkele muterende actie mag uitvoeren — kan deze data lezen. Dat betekent concreet: **een nieuw CRM kan al deze data raadplegen door simpelweg een eigen `VIEWER`-gebruikersaccount te laten aanmaken in TelefoonSysteem** (via de bestaande admin-UI/`POST /api/users`, geen enkele coderegel hoeft te wijzigen in TelefoonSysteem) en vervolgens met dat account in te loggen en de bestaande `GET`-routes te bevragen. Dit is fundamenteel anders dan de situatie bij OfferteApp/s4u-quote-app, waar geen enkele voor CRM bruikbare read-API bestaat zonder eerst nieuwe code te schrijven.

## Herziene Fase 1 — nog steeds klein, nu rijker

**Doel**: een direct bruikbaar, read-only Customer 360/Timeline-scherm opleveren, zonder **enige regel code** in POS, OfferteApp, s4u-quote-app of TelefoonSysteem te wijzigen.

**Exacte onderdelen**:
1. `packages/shopify` (ongewijzigd t.o.v. de eerdere Fase 1 in 18): token-acquisitie, GraphQL-transport, shop-identity-guard — patroon van POS.
2. **Nieuw, mogelijk gemaakt door deze discovery-ronde**: een klein `packages/telefoonsysteem-client` dat inlogt met een dedicated `VIEWER`-serviceaccount (aangemaakt via TelefoonSysteem's bestaande admin-UI, een operationele stap, geen code-wijziging) en de bestaande, read-only endpoints bevraagt: `GET /api/contacts/:id`, `GET /api/contacts/:id/notes`, `GET /api/contacts/:id/tasks`, `GET /api/calls` (gespreksgeschiedenis), `GET /api/customer-history/*` (Exact-facturatie, zie [20-CUSTOMER-HISTORY-DATA-MODEL.md](20-CUSTOMER-HISTORY-DATA-MODEL.md)).
3. CRM-scherm: klant zoeken (Shopify) → detailpagina die combineert: Shopify-orderhistorie/-totaal/openstaande facturen (Fase-1-basis uit 18), **plus** TelefoonSysteem-gespreksgeschiedenis + contactnotities + openstaande taken, **plus** Exact-facturatiehistorie (omzet, openstaand saldo, meest gekochte artikelen) — drie voorheen losse bronnen voor het eerst in één scherm.
4. **Matching-waarschuwing verplicht overnemen**: elke TelefoonSysteem-/Exact-koppeling in dit scherm moet, net als `ShopifyCustomerPanel`, expliciet omgaan met "meerdere klanten met dit nummer" (zie [22-CUSTOMER-IDENTITY-STRATEGY.md](22-CUSTOMER-IDENTITY-STRATEGY.md)) — nooit stilzwijgend een van meerdere kandidaten kiezen.

**Afhankelijkheden**: Fase 0-besluiten (ongewijzigd), plus een operationeel besluit: akkoord van de TelefoonSysteem-beheerder om een CRM-serviceaccount aan te maken (geen codewijziging, wel een bewuste, aparte toestemming — dit is client-credentials-achtig hergebruik van een bestaand mens-gericht auth-systeem voor een machine-tot-machine-doel, wat op termijn beter zou moeten worden vervangen door een echte service-tot-service-auth zoals TelefoonSysteem's eigen `INTERNAL_SECRET`-patroon — zie de kanttekening hieronder).

**Bestaande apps onaangetast**: **volledig, letterlijk nul coderegels** in POS, OfferteApp, s4u-quote-app, of TelefoonSysteem. Zelfs rijker dan de oorspronkelijke Fase 1 (die alleen Shopify raadpleegde), zonder het risiconiveau te verhogen — alle geraadpleegde endpoints zijn bevestigd read-only (customer-history) of expliciet toegankelijk voor de laagste rol (contacts/notes/tasks/calls).

**Risico**: laag, met één nieuwe, expliciete kanttekening: een `VIEWER`-gebruikersaccount gebruiken als machine-service-account is een **tijdelijke, niet-ideale oplossing** — het gebruikt mens-gerichte JWT-authenticatie (7 dagen geldig, geen rotatie, geen scopebeperking voorbij de rol) voor een geautomatiseerd doel. Dit is acceptabel voor een eerste, kleine Fase 1, maar moet in een latere fase vervangen worden door een echte service-tot-service-auth (mogelijk een uitbreiding van TelefoonSysteem's bestaande `INTERNAL_SECRET`-patroon naar een tweede, CRM-specifieke secret) — dat vereist wél een (kleine, geïsoleerde) codewijziging in TelefoonSysteem en hoort dus in een latere fase, niet Fase 1.

**Acceptance criteria**: een medewerker kan in het nieuwe CRM een klant opzoeken en in één scherm zien: Shopify-orderhistorie + -totaal + openstaande facturen, TelefoonSysteem-gespreksgeschiedenis + contactnotities + openstaande taken, en Exact-facturatiehistorie — informatie die vandaag over drie/vier aparte systemen verspreid staat. Geen van de vier bestaande apps is aangepast; een eventuele storing in het CRM heeft geen enkel effect op POS, OfferteApp, s4u-quote-app, of TelefoonSysteem.

## Wat nog steeds NIET in Phase 1 hoort

- **Taken/notities vanuit het CRM aanmaken of wijzigen** in TelefoonSysteem — dit is een schrijfactie, en een `VIEWER`-account kan dit toch niet (rolbeperking in TelefoonSysteem zelf voorkomt dit al, een prettige extra veiligheidslaag). Schrijven hoort in een latere fase, met een bewust ontworpen service-auth.
- **De offerteapp/s4u-quote-app-koppeling** (Fase 3 in 18) — ongewijzigd, blijft een latere, apart-goedgekeurde fase die wél een OfferteApp-codewijziging vereist.
- **Bestandsopslag** (Fase 4 in 18) — ongewijzigd.
- **Shopify-GID persisteren voor TelefoonSysteem-contacten** — een verbetering die in TelefoonSysteem zelf zou moeten gebeuren (buiten CRM-scope), niet iets wat het CRM zelfstandig kan repareren zonder in TelefoonSysteem te schrijven.

## Samenvatting van de herziening t.o.v. het eerdere Fase 1-voorstel

| Aspect | Eerder (18, vóór TelefoonSysteem-onderzoek) | Nu (23, na TelefoonSysteem-onderzoek) |
|---|---|---|
| Databronnen | Alleen Shopify (live) | Shopify (live) + TelefoonSysteem-API (calls/notes/tasks) + TelefoonSysteem's Exact-historie-proxy |
| Scherm-inhoud | Klant zoeken, orderhistorie, ordertotaal, openstaande facturen | Bovenstaand, plus gespreksgeschiedenis, contactnotities, openstaande taken, omzet-/factuurhistorie |
| Nieuwe code nodig in bestaande apps | Nee | Nee (Fase 1 zelf) — wel een operationele stap (serviceaccount aanmaken) |
| Risico | Laag | Laag, met een expliciet benoemde tijdelijke auth-compromis om later op te lossen |
