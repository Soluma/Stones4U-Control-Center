# ADR-006 — Shopify-auth: client credentials voor nieuwe modules, bestaande apps ongewijzigd

**Status**: Besloten (2026-09-01). Verscherpt de "D, met een noodzakelijke voorafgaande keuze"-classificatie in [platform-discovery/14-SHARED-CORE-DESIGN.md](../platform-discovery/14-SHARED-CORE-DESIGN.md).

## Context

Discovery (`platform-discovery/03`, `22`) bevestigde **vier** verschillende Shopify-authenticatiepatronen live in productie: OAuth client-credentials (POS, Stones4U-Catalog-SEO), authorization-code-met-permanent-token (OfferteApp), embedded-app-OAuth (s4u-quote-app), en een statisch, langlevend Admin-token (TelefoonSysteem, "locatie"). De oorspronkelijke opdrachtwens was expliciet client-credentials, niet een permanente token.

## Besluit

- **Nieuwe interne Control Center-server-integraties gebruiken uitsluitend OAuth client-credentials** (Client ID + Client Secret → runtime access token, in-memory gecached, automatisch ververst) — het patroon dat vandaag al bewezen werkt in POS.
- Er komt één **gedeelde Shopify-client** (`packages/shopify`, zie [24-UNIFIED-CONTROL-CENTER-TARGET.md](../platform-discovery/24-UNIFIED-CONTROL-CENTER-TARGET.md)) voor alle nieuwe modules — geen los-gebouwde client per module.
- **Bestaande apps worden niet geforceerd te migreren.** POS, OfferteApp, s4u-quote-app en TelefoonSysteem behouden hun huidige, werkende Shopify-authenticatie totdat een latere, apart goedgekeurde fase anders besluit. Dit besluit gaat uitsluitend over **nieuwe** code.

## Consequenties

- Vier Shopify-authenticatiepatronen blijven naast elkaar bestaan in het landschap totdat een expliciete latere migratiefase dit vermindert — dit wordt bewust geaccepteerd, niet genegeerd.
- De gedeelde client moet, om herbruikbaar te zijn buiten alleen de nieuwe modules, in theorie ook de andere patronen als adapter kunnen ondersteunen (zie `14-SHARED-CORE-DESIGN.md` Shopify-laag) — dit ADR beperkt zich tot de **standaard voor nieuw werk**, niet tot een volledige consolidatie van alle vier patronen.
- Alle Shopify-writes vanuit nieuwe Control Center-modules moeten, net als POS, een live shop-identity-guard en write-kill-switch gebruiken (zie `14-SHARED-CORE-DESIGN.md`, classificatie A) — dit is impliciet onderdeel van "client credentials op de POS-manier", niet een los besluit.
