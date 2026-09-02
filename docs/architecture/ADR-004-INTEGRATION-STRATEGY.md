# ADR-004 — Evolutionaire adapterstrategie; geen big-bang migratie

**Status**: Besloten (2026-09-01)

## Context

Vier bestaande apps zijn productie-kritiek en actief in gebruik (POS: hardware-geteste kassa; OfferteApp: release v455, dagen-oude deploys; s4u-quote-app: storefront-facing; TelefoonSysteem: live PBX-koppeling). Geen van deze mag verstoord worden door de introductie van het Control Center. Tegelijk moet het Control Center uiteindelijk één samenhangende gebruikerservaring bieden over data die vandaag over al deze systemen verspreid ligt.

## Besluit

Bestaande systemen worden voorlopig behandeld als **satellites/adapters**, niet als te vervangen legacy:

| Systeem | Levert aan Control Center |
|---|---|
| Shopify | customer/product/order-data (commerciële bron van waarheid) |
| TelefoonSysteem | calls + bestaande call-notes/-historie (read-only getoond in de tijdlijn) |
| Exact / customer-history | factuur-/omzethistorie (read-only) |
| OfferteApp | interne offertes/orders/sales-processen (read-only waar veilig beschikbaar) |
| s4u-quote-app | webshop-offerteaanvragen (read-only waar veilig beschikbaar) |
| Transport-S4U / Pallet Yard | operations-data (later, read-only) |
| POS | kassaverkoop/betaalcontext (later, read-only) |

Voor de Activity Timeline geldt een expliciet onderscheid (zie [24-UNIFIED-CONTROL-CENTER-TARGET.md](../platform-discovery/24-UNIFIED-CONTROL-CENTER-TARGET.md) voor het volledige ontwerp):
- **A. Control Center-owned activities** — direct in de Control Center-database aangemaakt (notities, taken, afspraken).
- **B. External/source activities** — geprojecteerd vanuit een adapter (een call, een offerte-status, een Shopify-order) zonder de bron-data fysiek te migreren.

Niet elk bron-event hoeft direct fysiek naar dezelfde tabel gemigreerd te worden — een adapter-/projectiestrategie maakt één uniforme tijdlijn mogelijk zonder bestaande apps onmiddellijk te migreren.

## Consequenties

- Elke integratie in Phase 1 is **read-only** — geen enkele bestaande app-database wordt beschreven, geen enkele bestaande app-code wordt gewijzigd.
- Sommige adapters (OfferteApp, s4u-quote-app) hebben vandaag **geen** voor dit doel geschikte read-API (zie `platform-discovery/10`, `11`) — deze worden pas geïntegreerd zodra dat veilig mogelijk is (zie de gefaseerde volgorde in `24`), niet geforceerd in Phase 1.
- TelefoonSysteem's read-API is wél direct bruikbaar (zie `platform-discovery/19`, `23`) en wordt daarom als eerste adapter opgenomen.
- Op termijn (buiten Phase 1) kan een adapter "dieper" geïntegreerd worden (bijv. events pushen in plaats van pollen) — dat vereist wel een wijziging aan de betreffende bestaande app en dus een aparte, zwaardere goedkeuring, zoals al vastgelegd voor de OfferteApp↔s4u-quote-app-koppeling in [platform-discovery/18](../platform-discovery/18-RECOMMENDED-BUILD-SEQUENCE.md) Fase 3.
