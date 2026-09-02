# ADR-002 — Customer Identity: Shopify commercieel + Control Center CustomerProfile

**Status**: Besloten (2026-09-01), **bevestigt en verscherpt** het bestaande advies uit [platform-discovery/22-CUSTOMER-IDENTITY-STRATEGY.md](../platform-discovery/22-CUSTOMER-IDENTITY-STRATEGY.md).

## Context

Discovery over vier apps (`platform-discovery/02`, `12`, `22`) toont dat geen enkele bestaande app een gezaghebbende lokale Customer-tabel heeft — allemaal verwijzen ze naar Shopify, met vier onderling incompatibele, zwakke lokale verwijzingsstrategieën (POS: snapshot-only; OfferteApp: `CustomerCache` op Shopify-ID; s4u-quote-app: snapshot-only, geen sync; TelefoonSysteem: telefoonnummer-gesleuteld `Contact`, geen Shopify-GID bewaard, inconsistente normalisatie, geen dedup). Dit is precies het patroon dat het Control Center **niet** moet herhalen.

## Besluit

- **Shopify blijft de commerciële bron voor customer identity**: naam, e-mail, telefoon, adressen, orders.
- Het Control Center krijgt een eigen `CustomerProfile`-model dat **minimaal een stabiele relatie naar de Shopify Customer GID bevat** (niet alleen een numeriek ID of een losse telefoonnummer-string zoals bestaande apps doen).
- Control Center wordt eigenaar van CRM-specifieke data die Shopify niet heeft: CRM-status, accountmanager, CRM-tags, notities, taken, afspraken, documenten, activiteiten, klachten, operationele relaties (leverancier, purchase order, productieopdracht, etc.).
- Matching-/identiteitsproblemen die in TelefoonSysteem zijn aangetroffen (inconsistente telefoonnormalisatie tussen code-paden, geen afhandeling van "meerdere Shopify-klanten met hetzelfde nummer" in het automatische pad, geen dedup-garantie) worden **niet** overgenomen — `CustomerProfile` moet vanaf het begin één consistente, geteste normalisatie- en ambiguïteits-strategie hebben.

## Consequenties

- Het Control Center wordt de **eerste** app in het hele landschap met een echte, gezaghebbende lokale klant-entiteit (weliswaar altijd verwijzend naar Shopify voor commerciële basisgegevens) — een nieuw soort verantwoordelijkheid die zorgvuldig ontworpen moet worden (zie [25-PHASE-1-BUILD-SPEC.md](../platform-discovery/25-PHASE-1-BUILD-SPEC.md) voor het concrete datamodel).
- Bestaande apps' eigen klant-verwijzingen (POS' snapshots, OfferteApp's `CustomerCache`, TelefoonSysteem's `Contact`) worden **niet** aangepast of gemigreerd in Phase 1 — ze blijven bestaan als losse, app-eigen mechanismen totdat een latere fase expliciet anders besluit.
- Toekomstige koppelingen (TelefoonSysteem-gesprekken, Exact-facturen) aan een `CustomerProfile` gebeuren via matching op Shopify GID/telefoon/e-mail, met dezelfde zorgvuldigheid die in `platform-discovery/22` als ontbrekend is gedocumenteerd.
