# 09 — Executive Summary

*Bijgewerkt 2026-09-01 (tweede discovery-ronde) na volledige broncode-analyse van OfferteApp en s4u-quote-app. De eerdere versie van dit rapport (gebaseerd op Fly-secrets-only inferenties) is hieronder volledig vervangen; zie git/versiehistorie of eerdere gespreksinhoud voor het origineel.*

## 1. Wat bestaat er momenteel?

Vier apps zijn nu volledig onderzocht: **Kassa Systeem** (POS, Next.js/Prisma, hardware-geteste kassa), **OfferteApp** (Flask, volwassen productiesysteem — release v455 — voor interne offerte-/orderverwerking, betalingen, warehouse- en transportkoppeling), **s4u-quote-app** (Remix/Shopify-embedded app voor storefront-offerteaanvragen), en **Stones4U-Catalog-SEO** (los CLI-gereedschap). Daarnaast bestaan er nog minstens 18 andere Fly.io-apps (telefonie, transport, yard-inventarisatie, productimport, kleinere Shopify-tools) waarvan de broncode nog niet lokaal beschikbaar is.

## 2. Wat is de belangrijkste overlap tussen apps?

**Geen van de drie kernapps praat automatisch met een ander.** Concreet: s4u-quote-app slaat een offerteaanvraag alleen in zijn eigen database op; een winkelier moet handmatig op "Maak Draft Order" klikken. OfferteApp heeft geen enkel intake-mechanisme buiten de handmatige medewerker-UI — bevestigd door beide apps' eigen broncode én eigen documentatie. **Er zijn dus vandaag twee volledig gescheiden "Quote"-datamodellen in twee gescheiden databases, zonder foreign key, webhook, of gedeelde database ertussen.** Zie [13-END-TO-END-DATAFLOW.md](13-END-TO-END-DATAFLOW.md). Verder gebruiken POS, OfferteApp en s4u-quote-app **drie technisch verschillende manieren** om bij Shopify in te loggen, en herbouwen alle drie onafhankelijk van elkaar: een GraphQL-client, klant-snapshotting, audit-logging, en gebruikersauthenticatie/rollen — met steeds net andere technische keuzes voor hetzelfde probleem (zie [12-OFFERTEAPP-POS-OVERLAP.md](12-OFFERTEAPP-POS-OVERLAP.md)).

## 3. Wat is de belangrijkste ontbrekende CRM-functionaliteit?

Taken, klantafspraken, en een klachten-/service-module bestaan **nergens** — zuiver nieuw werk. Bestandsopslag (foto's/tekeningen/documenten) is in OfferteApp wel voorbereid als datamodel maar nooit geïmplementeerd ("fase 2", een lege placeholder). Een echt cross-systeem Customer 360-overzicht en een universele zoekfunctie bestaan evenmin — elke app toont alleen zijn eigen fragment van een klant. Zie de volledige tabel in [15-CRM-GAP-ANALYSIS.md](15-CRM-GAP-ANALYSIS.md).

## 4. Wat is het aanbevolen Shared Core-model?

Direct herbruikbaar zonder aanpassing aan bestaande apps (classificatie A in [14-SHARED-CORE-DESIGN.md](14-SHARED-CORE-DESIGN.md)): de Shopify-tokencache, GraphQL-transportlaag met retry, de shop-identity-safety-guard (alleen in POS aanwezig — OfferteApp mist dit volledig, een reëel risicoverschil), write-guards, en een generieke audit-log-service. Vereist eerst een bewust besluit met de gebruiker (classificatie D): wordt Shopify de blijvende Customer-bron-van-waarheid of wordt het CRM de eerste lokale Customer-master, welke Shopify-authenticatiestrategie wordt standaard voor nieuwe modules, en welke opslagtechnologie voor bestanden (Cloudflare R2 sluit aan op een echte leemte, niet op een bestaand patroon — zie [04-INFRASTRUCTURE-MAP.md](04-INFRASTRUCTURE-MAP.md)).

## 5. Wat moeten we absoluut gescheiden houden?

POS blijft zelfstandig en onaangeroerd (hardware-geteste pinbetalingen, productie-kritiek). OfferteApp's bestaande, productie-bewezen offerte-rekenmotor, Mollie-integratie, en Pallet Yard-/Transport-S4U-koppelingen worden **niet** herbouwd — ze zijn precies het soort werkend precedent waar een CRM juist op zou moeten aansluiten, niet mee zou moeten concurreren. s4u-quote-app's storefront-intake-flow blijft eveneens ongewijzigd als op zichzelf staand systeem.

## 6. Wat is de veiligste eerste stap naar het CRM?

**Nog steeds niet coderen aan bestaande apps.** De veiligste eerste bouwstap (zie [18-RECOMMENDED-BUILD-SEQUENCE.md](18-RECOMMENDED-BUILD-SEQUENCE.md), Fase 1) is een geïsoleerd Shared-Core Shopify-package plus een **read-only** CRM-Customer-scherm dat rechtstreeks bij Shopify leest — geen enkele bestaande app wordt aangeraakt of zelfs maar uitgelezen. Dit levert direct bruikbare CRM-functionaliteit op (klant zoeken, orderhistorie/ordertotaal/openstaande facturen zien) zonder enig regressierisico.

## 7. Wat moet de eerstvolgende bouwopdracht worden?

Eerst **Fase 0**: vier expliciete besluiten met de gebruiker vastleggen (Customer-identity-strategie, bestandsopslag-technologie, of/hoe de s4u-quote-app↔OfferteApp-koppeling gedicht wordt, en de standaard Shopify-authenticatiestrategie voor nieuwe modules) — zie Fase 0 in [18-RECOMMENDED-BUILD-SEQUENCE.md](18-RECOMMENDED-BUILD-SEQUENCE.md). Daarna pas Fase 1: het Shared-Core Shopify-package plus het eerste, read-only CRM-scherm.

---

*Rapporten aangemaakt/bijgewerkt in `docs/platform-discovery/`: 01–09 (bijgewerkt op 2026-09-01) plus nieuw: 10 (OfferteApp deep dive), 11 (s4u-quote-app deep dive), 12 (POS-overlap), 13 (end-to-end dataflow), 14 (Shared Core-ontwerp), 15 (CRM gap analysis), 16 (domeingrenzen), 17 (AI-modulegrenzen), 18 (bouwvolgorde). Geen applicatiecode, database, infrastructuur of secrets zijn gewijzigd.*
