# ADR-001 — Stones4U Control Center als target platform

**Status**: Besloten (2026-09-01)
**Vervangt**: het impliciete "CRM als losstaand, permanent API-afhankelijk systeem"-model uit [platform-discovery/16-PLATFORM-BOUNDARIES.md](../platform-discovery/16-PLATFORM-BOUNDARIES.md) (Fase-1-versie).

## Context

De discovery-rondes tot nu toe (zie `platform-discovery/01` t/m `23`) hebben vier bestaande apps in kaart gebracht (POS, OfferteApp, s4u-quote-app, TelefoonSysteem) plus een reeks kleinere/Fly-only systemen. De eerder aanbevolen aanpak (Fase 1 in [18-RECOMMENDED-BUILD-SEQUENCE.md](../platform-discovery/18-RECOMMENDED-BUILD-SEQUENCE.md), verfijnd in [23-CRM-PHASE-1-FINAL-RECOMMENDATION.md](../platform-discovery/23-CRM-PHASE-1-FINAL-RECOMMENDATION.md)) ging uit van een CRM dat permanent, structureel afhankelijk blijft van TelefoonSysteem's Task/Note-API's en vergelijkbare koppelingen bij andere apps voor zijn kernfunctionaliteit.

Bij nader inzien is dit niet de gewenste eindtoestand: het zou de nieuwe CRM-kernfunctionaliteit (taken, notities, klantdossier) permanent laten leunen op datamodellen die zijn ontworpen voor een ander doel (een telefoniesysteem), met de bijbehorende zwaktes (zie `platform-discovery/19-22`: geen rich text, geen dedup, inconsistente telefoonnormalisatie, een niet-ideaal `VIEWER`-serviceaccount als tijdelijke auth).

## Besluit

Er komt één doelplatform: **Stones4U Control Center** — een nieuwe, modulaire applicatie met:
- één login, één navigatie, één Customer 360, één centrale zoekfunctie;
- één centrale Activity Timeline;
- één centraal Task-model en één centraal Note-model, **eigendom van het Control Center**, niet van TelefoonSysteem of enige andere bestaande app;
- één centrale CRM-database (PostgreSQL);
- modulaire domeinen (CRM, Sales, Tasks, Operations, Service, Telephony, POS-integratie, Admin) met duidelijke AI/Claude-grenzen per module.

Bestaande applicaties (POS, OfferteApp, s4u-quote-app, TelefoonSysteem, en de kleinere satellite-apps) blijven **voorlopig zelfstandig draaien** en worden **evolutionair** — niet in één big-bang — geïntegreerd, in eerste instantie als read-only adapters/bronnen voor de Control Center-tijdlijn (zie ADR-004).

## Consequenties

- Elke eerder aanbevolen "hergebruik via API als permanente architectuur"-conclusie voor Tasks/Notes wordt herzien (zie ADR-003) — bestaande implementaties blijven waardevol als **referentie voor businessregels**, niet als toekomstig system-of-record voor CRM-kernfunctionaliteit.
- Er ontstaat een nieuwe, centrale database die vanaf de eerste bouwfase bestaat — dit is een grotere eerste stap dan de eerder voorgestelde read-only Fase 1, maar nog steeds **geen** wijziging aan bestaande apps.
- Bestaande apps' databases, code en deployments blijven ongewijzigd tot een expliciet latere, apart goedgekeurde migratiefase (zie de fase-volgorde in [24-UNIFIED-CONTROL-CENTER-TARGET.md](../platform-discovery/24-UNIFIED-CONTROL-CENTER-TARGET.md)).
- Groter initieel bouwrisico dan de eerdere read-only aanpak, gecompenseerd door een striktere Fase-1-scope (zie [25-PHASE-1-BUILD-SPEC.md](../platform-discovery/25-PHASE-1-BUILD-SPEC.md)) en het feit dat geen enkele bestaande productie-app wordt aangeraakt.
