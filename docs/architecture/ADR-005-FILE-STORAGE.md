# ADR-005 — Bestandsopslag: Cloudflare R2 + PostgreSQL-metadata

**Status**: Besloten als target (2026-09-01), **niet noodzakelijk volledig geïmplementeerd in Phase 1**. Bevestigt de eerdere infrastructuur-toetsing in [platform-discovery/04-INFRASTRUCTURE-MAP.md](../platform-discovery/04-INFRASTRUCTURE-MAP.md) ("Infrastructuuradvies").

## Context

Geen enkele onderzochte app heeft vandaag een werkende bestandsopslagoplossing: OfferteApp's `Attachment`-model is een niet-geïmplementeerde placeholder ("fase 2"), POS slaat alleen een logo als base64-in-Postgres op, TelefoonSysteem heeft geen bijlage-functionaliteit bij notities. Cloudflare R2 sluit dus aan op een echte, aantoonbare leemte in het hele landschap, niet op een bestaand patroon (zie `04-INFRASTRUCTURE-MAP.md`).

## Besluit

- **Cloudflare R2** wordt de target-objectopslag voor bestanden: foto's, klachtfoto's, productietekeningen, PDF's, pakbonnen, e-mailbijlagen, documenten.
- **PostgreSQL** (de centrale Control Center-database) bevat uitsluitend **metadata en relaties** (bestandsnaam, type, grootte, eigenaar, gekoppelde entiteit, R2-objectsleutel) — nooit de bestandsinhoud zelf.
- Dit wordt vanaf Phase 1 **architecturaal voorbereid** (een `File`-model met de juiste velden/relaties bestaat, zie [25-PHASE-1-BUILD-SPEC.md](../platform-discovery/25-PHASE-1-BUILD-SPEC.md)) maar hoeft **niet** volledig functioneel te zijn (upload-UI, R2-koppeling) in Phase 1 — dat volgt in Phase 2 (zie [24-UNIFIED-CONTROL-CENTER-TARGET.md](../platform-discovery/24-UNIFIED-CONTROL-CENTER-TARGET.md)).
- Het `File`/`Activity`-datamodel moet vanaf Phase 1 zo ontworpen zijn dat latere e-mailbijlage-verwerking (Outlook drag-and-drop, `.eml`/`.msg`, Microsoft Graph — zie de e-mail-voorbereidingsnotitie in het target-document) zonder grote migratie mogelijk is.

## Consequenties

- Geen infrastructuurwijziging in Phase 1 (geen R2-bucket wordt in deze documentatieronde aangemaakt — dat is een latere, apart uit te voeren operationele stap).
- Cloudflare wordt hiermee, voor het eerst in het hele landschap, een bewust geïntroduceerde nieuwe technologie (zie `04-INFRASTRUCTURE-MAP.md`: "geen enkele onderzochte app gebruikt Cloudflare vandaag") — geen voortzetting van een bestaand patroon, dus expliciet als besluit vastgelegd, niet als aanname.
