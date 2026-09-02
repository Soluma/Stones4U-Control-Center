# 08 — Toegang die ontbrak tijdens deze discovery

Geen enkel item hieronder vraagt om een secret-waarde — uitsluitend om toegang tot broncode, systemen of tooling.

> **UPDATE 2026-09-01**: `offerteapp` en `s4u-quote-app` zijn **niet langer een gap** — beide repositories zijn inmiddels lokaal gekloond (`D:\Shopify\OfferteApp`, `D:\Shopify\s4u-quote-app`) en volledig onderzocht (zie [10-OFFERTEAPP-DEEP-DIVE.md](10-OFFERTEAPP-DEEP-DIVE.md), [11-QUOTE-APP-DEEP-DIVE.md](11-QUOTE-APP-DEEP-DIVE.md)). Ze zijn hieronder verwijderd uit de lijst; de resterende gaps staan nog open.

## Broncode ontbreekt volledig (systeem draait aantoonbaar live op Fly.io, geen lokale repo gevonden)

- `telefoon-api`, `telefoon-web`, `telefoon-ami-worker` — telefonie-/VoIP-backend, koppelt met Shopify en met `customer-history-db`. **Verhoogde prioriteit na deze ronde**: OfferteApp's onderzoek toont aan dat `customer-history-db` mogelijk al een vroege vorm van "klant-interactiehistorie" bevat — direct relevant voor de CRM Customer-360/tijdlijn-scope (zie [15-CRM-GAP-ANALYSIS.md](15-CRM-GAP-ANALYSIS.md)).
- `transport-s4u` — transport/leveringen, koppelt met een externe leverancier en met `offerteapp`.
- `s4u-import-app` — Shopify-productimport.
- `maten-en-meters`, `maten-en-meters-s4u` — functie onbekend zonder bron.
- `productcards` — functie onbekend zonder bron (suspended).
- `stones4u-calculator` — functie onbekend zonder bron (vermoedelijk prijs-/m²-calculator).

Voor geen van deze systemen kon een databaseschema, functionaliteitsniveau, of daadwerkelijke Shopify-scope-lijst worden vastgesteld — alleen namen van environment-variabelen via `fly secrets list`.

Gezocht is naar lokale kopieën van deze repos in `D:\Shopify\*` (volledig), en steekproefsgewijs in `C:\Users\Master\Documents`, `Desktop`, `source`, `dev` — niets gevonden. Een bredere, diepere scan van `C:\Users\Master` is niet volledig uitgevoerd (een eerste poging faalde op een permissiefout bij een systeempad); gezien niets is gevonden in de meest waarschijnlijke locaties is de snelste vervolgstap waarschijnlijk **de gebruiker rechtstreeks vragen waar deze repositories staan** (lokaal ergens anders, alleen op GitHub, of bij een andere ontwikkelaar), in plaats van verder blind te zoeken.

## Tooling ontbreekt

- **`gh` CLI niet geïnstalleerd** — kon de GitHub-organisatie (`Soluma`, bevestigd als remote-owner van `source2pos`) niet bevragen op overige repositories. Installeren en authenticeren van `gh` zou waarschijnlijk direct de bovenstaande broncode-gaten oplossen, ervan uitgaande dat deze apps ook op GitHub staan.
- **`wrangler` CLI niet geïnstalleerd** — kon geen Cloudflare Workers/Pages-projecten opsporen (al is er ook geen enkele aanwijzing gevonden dát die bestaan).

## Toegang niet geprobeerd (buiten scope van deze opdracht, niet gevraagd)

- Geen Cloudflare-accounttoegang opgezocht/gebruikt — er was geen enkele lokale aanwijzing dat Cloudflare gebruikt wordt, dus dit is niet actief nagetrokken.
- Geen directe databasetoegang (bijv. via `fly proxy`) tot een van de Fly Postgres-clusters — dit zou schemainformatie kunnen opleveren zonder secrets te tonen, maar is niet uitgevoerd omdat het buiten een zuivere bestands-/configuratie-inventarisatie valt en eerst overlegd zou moeten worden.
- Geen Shopify Partner Dashboard-toegang gebruikt om te bevestigen welke apps daadwerkelijk als "custom app" of "embedded app" geregistreerd staan — de indeling in dit rapport (patroon A/B/C in 03-SHOPIFY-INTEGRATION-MAP.md) is afgeleid uit environment-variabelenamen, niet uit het Shopify-dashboard zelf.

## Wat dit betekent voor het vervolg (bijgewerkt)

Met `offerteapp` en `s4u-quote-app` nu onderzocht, is de belangrijkste resterende gap **`telefoon-api`/`customer-history-db`** — relevant omdat het mogelijk al een vorm van klant-interactiehistorie bevat die het CRM zou kunnen hergebruiken in plaats van dupliceren. Daarna, in aflopende prioriteit: `transport-s4u` (leveranciers-/transportkoppeling, al aantoonbaar geïntegreerd met OfferteApp) en de resterende kleinere Shopify-embedded apps. Zie [09-EXECUTIVE-SUMMARY.md](09-EXECUTIVE-SUMMARY.md) en [18-RECOMMENDED-BUILD-SEQUENCE.md](18-RECOMMENDED-BUILD-SEQUENCE.md) voor de aanbevolen vervolgstappen.
