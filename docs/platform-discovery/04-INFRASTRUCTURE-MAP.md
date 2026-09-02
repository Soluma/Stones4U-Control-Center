# 04 — Infrastructuuroverzicht

Bron: `fly auth whoami` (geauthenticeerd als `stones4unl@gmail.com`), `fly apps list`, `fly status -a <app>` per app. Alle 22 apps draaien in regio **`ams`** (Amsterdam). Geen secret-waarden zijn opgevraagd — uitsluitend namen, en uitsluitend waar relevant.

## Fly.io — volledige app-inventarisatie

| App | Status | Laatste deploy | Gekoppelde lokale bron |
|---|---|---|---|
| `source2pos-prod-web` | deployed | 2026-08-14 | ✅ `Kassa Systeem` / `source2pos-production` |
| `source2pos-prod-db` | deployed | — (DB) | ✅ (idem) |
| `source2pos-dev-web` | **suspended** | 2026-08-14 | ✅ (idem) |
| `source2pos-dev` | deployed | — (DB) | ✅ (idem) |
| `offerteapp` | deployed | **2026-08-26** | ✅ `D:\Shopify\OfferteApp` (bijgewerkt 2026-09-01) |
| `offerteapp-db` | deployed | — (DB) | ✅ (idem, schema zie 02-DATA-MODEL-MAP.md) |
| `s4u-quote-app` | deployed | 2026-07-11 | ✅ `D:\Shopify\s4u-quote-app` (bijgewerkt 2026-09-01) |
| `s4u-quote-db` | deployed | — (DB) | ✅ (idem) |
| `customer-history-db` | deployed | — (kale Postgres-cluster) | ❌ geen |
| `telefoon-api` | deployed | 2026-06-05 | ❌ geen |
| `telefoon-web` | deployed | 2026-06-05 | ❌ geen |
| `telefoon-ami-worker` | deployed | 2026-05-04 | ❌ geen |
| `telefoon-db` | deployed | — (DB) | ❌ geen |
| `transport-s4u` | deployed (1 machine gestopt) | 2026-04-16 / 2026-08-20 | ❌ geen |
| `transport-s4u-db` | deployed | — (DB) | ❌ geen |
| `s4u-import-app` | deployed | 2026-03-31 | ❌ geen |
| `s4u-import-db` | deployed | — (DB) | ❌ geen |
| `maten-en-meters` | deployed | 2026-04-03 | ❌ geen |
| `maten-en-meters-s4u` | deployed | 2026-05-22 | ❌ geen |
| `productcards` | **suspended** | 2026-08-26 | ❌ geen |
| `stones4u-calculator` | deployed | 2026-06-28 | ❌ geen |
| `pallet-yard` | **suspended** | 2026-04-02 | ⚠️ vermoedelijk `Voorraad\...\pallet-yard` (ongeversioneerd prototype) |

`locatie-viewer` (de app-naam in `D:\Shopify\locatie\fly.toml`) **staat niet in deze lijst** — dit systeem is, ondanks documentatie die "v1.0 Released" claimt, nooit daadwerkelijk gedeployed.

## Database-landschap

| Database | Engine | Hosting | Gebruikt door | Connection-env-var |
|---|---|---|---|---|
| `source2pos-prod-db` / `source2pos-dev` | PostgreSQL (Fly Postgres) | Fly.io, privénetwerk (geen publiek IP) | POS-app | `DATABASE_URL` |
| `offerteapp-db` | PostgreSQL (Fly Postgres) | Fly.io | offerteapp | `DATABASE_URL`, migraties via `flask db upgrade` als `release_command` |
| `s4u-quote-db` | PostgreSQL (Fly Postgres) | Fly.io | s4u-quote-app | `DATABASE_URL`, migraties via `npx prisma migrate deploy` als `release_command` |
| `customer-history-db` | PostgreSQL (Fly `postgres-flex` 17.2) | Fly.io | `telefoon-api` (via `CUSTOMER_HISTORY_DATABASE_URL`) | zie linker kolom |
| `telefoon-db` | PostgreSQL (aangenomen) | Fly.io | `telefoon-api`, `telefoon-ami-worker` | `DATABASE_URL` |
| `transport-s4u-db` | PostgreSQL (aangenomen) | Fly.io | `transport-s4u` | `DATABASE_URL` |
| `s4u-import-db` | PostgreSQL (aangenomen) | Fly.io | `s4u-import-app` | `DATABASE_URL` / `DIRECT_URL` |
| `stones4u-calculator` eigen DB | PostgreSQL (aangenomen) | Fly.io | `stones4u-calculator` | `DATABASE_URL` |
| Neon (locatie) | PostgreSQL (Neon, serverless) | **Beweerd in docs, nooit daadwerkelijk gedeployed** — geen Fly-app, geen bevestigde Neon-projectverbinding | "locatie" (indien ooit gedeployed) | `DATABASE_URL` (pooled) + `DIRECT_DATABASE_URL` |

Prisma wordt gebruikt als ORM bij POS en "locatie" (beide bevestigd via `prisma/schema.prisma` + `@prisma/client`-dependency). Voor de overige Fly-only apps is het ORM onbekend.

Migratie-strategie: POS gebruikt handmatige `npx prisma migrate deploy` (bewust **niet** als Fly `release_command`, om de Prisma CLI buiten het productie-image te houden). "locatie"'s (nooit uitgevoerde) `DEPLOY_FLY.md` documenteert wél een `release_command = "npx prisma migrate deploy"`-aanpak. Voor de overige apps onbekend.

## Deployment-patronen (waar bron beschikbaar)

- Beide Next.js-apps (POS, "locatie") gebruiken een 3-staps Dockerfile op `node:22-alpine`/`node:22-slim`, `output: "standalone"`, non-root runtime-user, en genereren de Prisma-client tijdens de Linux-buildstage (niet hergebruikt vanaf Windows-dev).
- POS: `min_machines_running = 1` in productie (bewust warm gehouden tegen cold-start bij checkout), `= 0` in dev (scale-to-zero).

## Cloudflare

**Geen Cloudflare-gebruik aantoonbaar in enige lokaal beschikbare broncode.** Geen `wrangler.toml`/`.jsonc`, geen `@cloudflare/*`-dependency, geen `CLOUDFLARE_*`-env-vars gevonden in een repo-brede grep over alle lokaal aanwezige apps. De `wrangler` CLI is niet geïnstalleerd op deze machine. POS-documentatie noemt Cloudflare uitsluitend als **aspirationeel** item in een architectuurtabel ("DNS/WAF: Cloudflare") met elders een expliciete bevestiging dat het nog niet bestaat ("Geen Cloudflare-configuratie").

Voor de Fly-only apps zonder broncode kan Cloudflare-gebruik **niet worden uitgesloten** — er is simpelweg geen bewijs in beide richtingen.

## GitHub

`gh` CLI niet geïnstalleerd — kon de `Soluma`-organisatie niet direct bevragen. Van de lokaal aanwezige repos heeft alleen POS een GitHub-remote (`github.com/Soluma/source2pos`); Stones4U-Catalog-SEO en "locatie" hebben geen git-remote.

> **UPDATE 2026-09-01**: OfferteApp (`github.com/Soluma/OfferteApp`) en s4u-quote-app (`github.com/Soluma/s4u-quote-app`) zijn inmiddels ook lokaal gekloond en bevestigd onder de `Soluma`-organisatie.

## Infrastructuuradvies — sluit het voorlopige platformdoel aan bij de bestaande werkelijkheid?

Het voorlopige platformdoel (Fly.io voor app/backend/workers/Postgres, Cloudflare voor DNS/proxy en R2 voor foto's/documenten/tekeningen/PDF's, Shopify als commerciële bron voor producten/orders/klantidentificatie) is getoetst aan wat daadwerkelijk is aangetroffen:

- **Fly.io als app/backend/Postgres-platform**: **sluit al volledig aan.** Alle vier onderzochte apps (POS, OfferteApp, s4u-quote-app, en de eerder gevonden Fly-only apps) draaien al op Fly.io in regio `ams`, elk met een eigen Fly Postgres-database. Er is geen enkele aangetroffen app die een ander platform gebruikt (behalve `Tuindesign/tile-visualizer` op Vercel, buiten scope). Een nieuw CRM op Fly.io zetten is dus geen trendbreuk maar een voortzetting van de bestaande praktijk.
- **Workers**: geen enkele aangetroffen app gebruikt Fly "workers" als apart procestype in de zin van een losse achtergrond-queue-runner — de dichtstbijzijnde equivalenten zijn losse Fly-apps met een specifieke rol (`telefoon-ami-worker`) of losse lokale processen (POS' `local-ccv-bridge`/`local-agent`, OfferteApp's lokale Print Agent op `localhost:9876`). Een CRM-achtergrondtaak (bijv. voor notificaties) zou dit patroon kunnen volgen: een aparte, kleine Fly-app/machine, geen gedeeld "workers"-framework dat al bestaat.
- **Cloudflare (DNS/proxy)**: **sluit vandaag nergens op aan** — geen enkele lokaal onderzochte app gebruikt Cloudflare voor DNS/proxy (zie hierboven). Introductie van Cloudflare voor het CRM zou dus **nieuw** zijn voor het hele landschap, geen voortzetting. Dit is geen bezwaar, maar wel iets om bewust te beslissen (Fase 0 in [18-RECOMMENDED-BUILD-SEQUENCE.md](18-RECOMMENDED-BUILD-SEQUENCE.md)) — niet aannemen dat het "gewoon al zo werkt".
- **Cloudflare R2 (bestandsopslag)**: **sluit aan op een reële, aantoonbare leemte**, niet op een bestaand patroon. Geen enkele onderzochte app heeft vandaag een werkende bestandsopslagoplossing — OfferteApp's `Attachment`-model is een ongeïmplementeerde placeholder, POS slaat alleen een logo als base64-in-Postgres op. R2 zou dus niet iets bestaands vervangen, maar de eerste echte oplossing voor een tot nu toe onopgelost probleem zijn (foto's, tekeningen, PDF's voor het CRM) — een goede aansluiting, mits als nieuw Shared Core-onderdeel behandeld (zie [14-SHARED-CORE-DESIGN.md](14-SHARED-CORE-DESIGN.md), Files = classificatie D).
- **Shopify als commerciële bron voor producten/orders/klantidentificatie**: **sluit volledig aan** — dit is al de facto de praktijk in elke onderzochte app (POS, OfferteApp, "locatie", Stones4U-Catalog-SEO, s4u-quote-app behandelen Shopify allemaal als bron van waarheid voor producten; klantidentificatie eveneens, met uitzondering van OfferteApp's cache-laag die snelheid toevoegt zonder eigenaarschap te claimen). Het CRM zou hierin passen door hetzelfde principe te volgen, niet een eigen concurrerende productcatalogus te bouwen.

**Conclusie**: het Fly.io- en Shopify-deel van het voorlopige doel is al de bestaande praktijk — laag risico om voort te zetten. Het Cloudflare-deel (zowel DNS/proxy als R2) is nieuw voor het hele landschap — geen bezwaar, maar vereist een bewust besluit in plaats van een aanname dat het al ergens gebruikt wordt.
