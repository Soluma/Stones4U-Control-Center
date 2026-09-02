# 02 — Datamodel-overzicht

Bron: volledige `prisma/schema.prisma`-bestanden gelezen voor de twee apps met lokale Prisma-schema's. Voor Fly-only apps is het databaseschema **niet** onderzocht (geen source, geen DB-toegang) — zie [08-ACCESS-GAPS.md](08-ACCESS-GAPS.md).

> **UPDATE 2026-09-01**: OfferteApp (SQLAlchemy/Postgres, 17 modellen) en s4u-quote-app (Prisma/Postgres, 10 modellen) zijn inmiddels volledig onderzocht. Volledige modeloverzichten staan in [10-OFFERTEAPP-DEEP-DIVE.md](10-OFFERTEAPP-DEEP-DIVE.md) §3 en [11-QUOTE-APP-DEEP-DIVE.md](11-QUOTE-APP-DEEP-DIVE.md) §6 — hieronder een beknopte samenvatting om duplicatie te tonen.

## OfferteApp — kernmodellen (SQLAlchemy/Postgres)

`ShopifyStore` (multi-shop OAuth-tokens), `CustomerCache` (read-through klant-cache, sleutel `shopify_customer_id`), `Quote`/`QuoteLine`/`QuoteVersion` (offerte + regels + volledige append-only versiesnapshot), `VisitReport`, `MolliePayment`, `TransportJob`/`TransportEvent` (Van Eijk), `WarehouseFulfillmentLink` (Pallet Yard), `User`/`PasswordResetToken`, `Setting` (generieke key/value, deels Fernet-versleuteld), `AuditLog`, `Attachment` (schema bestaat, ongebruikt — "fase 2").

## s4u-quote-app — kernmodellen (Prisma/Postgres)

`Session`/`Shop` (standaard Shopify-app-sessiebeheer, multi-tenant via `shopId`), `ShopSettings`, `Quote`/`QuoteItem`/`QuoteEvent` (offerte-**aanvraag**, geen versiebeheer zoals OfferteApp), `WebhookEvent`, `QuoteFormFieldDefinition`/`QuoteFieldValue`, `QuoteUpsellRule`.

## Duplicatie tussen de twee "Quote"-datamodellen

Beide apps hebben een model dat `Quote` heet, met overlappende maar niet identieke velden (klantgegevens, regels, Shopify-koppeling) — **dit zijn twee losstaande tabellen in twee losstaande databases, met geen enkele foreign key of sync ertussen.** Een klant kan in theorie in beide systemen een "Quote"-rij hebben zonder dat het ene systeem ooit van het andere weet. Zie [13-END-TO-END-DATAFLOW.md](13-END-TO-END-DATAFLOW.md).

## POS ("kassa-systeem") — PostgreSQL via Prisma

Bron van waarheid voor producten/varianten/voorraad/klanten blijft Shopify; dit schema bevat uitsluitend wat de kassa-app zelf beheert. **Geen lokale Customer-tabel** — klanten leven alleen in Shopify, gerefereerd via `shopifyCustomerId` + snapshot-velden.

| Model | Doel | PK | Belangrijke relaties | Shopify-koppeling | Timestamps/status |
|---|---|---|---|---|---|
| `User` | Medewerker-account | `id` (cuid) | carts, payments, dailyClosings, auditLogs, sessions, returns | — | `active`, timestamps |
| `Session` | Login-sessie | `id` | `userId` FK (cascade) | — | `expiresAt`, `lastUsedAt` |
| `Location` | Vestiging | `id` | terminals, carts, quickTiles, dailyClosings, returns | `shopifyLocationId` (uniek, nullable — **nog niet ingevuld**, blokkeert restock-sync) | — |
| `Terminal` | Kassaterminal | `id` | `locationId` FK, 1:1 `TerminalSetting` | `terminalExternalId` | `paymentProvider` (MANUAL_PIN/CCV_SIMULATED/CCV_A920) |
| `TerminalSetting` | Printer/bon-instellingen per terminal | `id` | 1:1 `Terminal` | — | — |
| `QuickTile` | Sneltoets in kassa-UI | `id` | many-to-many `Location[]` | — | `active` (soft-delete) |
| `Cart` | Winkelmandje/transactie | `id` | `userId`/`locationId`/`terminalId` FK, `CartLine[]`, `Payment[]` | `shopifyCustomerId`, `shopifyDraftOrderId`, `shopifyOrderId` + klant-snapshotvelden | `status: CartStatus` |
| `CartLine` | Regel in mandje | `id` | `cartId` FK | `shopifyProductId`/`shopifyVariantId` (nullable bij CUSTOM_ITEM), `shopifyOrderLineItemId` (na checkout, voor retour-sync) | `lineType`, snapshot van titel/prijs/SKU/barcode |
| `Payment` | Betaling | `id` | `cartId`/`userId`/`terminalId` FK | `shopifyOrderId` | `status: PaymentStatus`, `rawResponse: Json` (CCV-respons) |
| `ReceiptTemplate` | Bonsjabloon | `id` | — | — | `isDefault` |
| `Receipt` | Kassabon | `id` | `cartId` FK, `returnId` (uniek, nullable) | `shopifyOrderId`, `receiptNumber` (= Shopify order-naam) | `scanCode` (eigen barcode, uniek) |
| `Return` | Retour | `id` | `originalReceiptId` FK, 1:1 `returnReceipt` | `shopifyRefundId`/`shopifyReturnId` | `status: ReturnStatus`, `shopifySyncStatus` |
| `ReturnLine` | Retourregel | `id` | `returnId`/`originalCartLineId` FK | `shopifyRestockType`/`shopifyRefundLineItemId`/`shopifyReturnLineItemId` | snapshot-velden |
| `DailyClosing` | Kasafsluiting | `id` | `locationId`/`terminalId`/`userId` FK | — | `@@unique([date, terminalId])` — voorkomt dubbele afsluiting |
| `AppSetting` | Generieke key/value-store | `key` (uniek) | — | — | `value: Json` (company info, logo, thema) |
| `AuditLog` | Append-only logging | `id` | `userId?` (nullable FK) | — | `action`, `entityType`, `entityId`, `details: Json` — gebruikt voor prijswijzigingen, kortingen, retours (voldoet aan de CLAUDE.md-eis) |

## "locatie" (Voorraad Viewer) — PostgreSQL via Prisma (Neon, per docs — nooit echt gedeployed, zie 01)

| Model | Doel | PK | Relaties | Shopify-koppeling |
|---|---|---|---|---|
| `Map` | Yard-kaart | `id` (cuid) | heeft veel `MapObject`, `Stack` | — |
| `Stack` | Pallet-stapel op de kaart | `id` | `mapId` FK (cascade), heeft veel `StackLayer` | `shopifyVariantId`, `sku`, `title`, `imageUrl` |
| `StackLayer` | Laag binnen een stapel | `id` | `stackId` FK (cascade); uniek op `(stackId, index)` | optioneel `shopifyVariantId` (alleen bij gemengde stapel) |
| `Template` | Herbruikbare pallet/vak-vorm | `id` | los, via `templateKey` string-referentie | — |
| `MapObject` | Overig object op de kaart (vak/stelling) | `id` | `mapId` FK (cascade) | `shopifyVariantId`, `sku`, `title`, `imageUrl` |

Geen `User`/`Session`/`Role`/`Customer`/`Order`-modellen — bevestigd via schema-grep. Alle Shopify-referenties zijn losse string-ID's (`gid://shopify/ProductVariant/...`), geen FK-relaties.

## Stones4U-Catalog-SEO — geen database

Persistentie is volledig bestandsgebaseerd: `data/*.json` (change-plans), `audit-logs/*.json` (gegenereerde audit-trail), `reports/*.md`/`.json` (leesbare rapporten). Geen ORM, geen schema.

## Onbekend — geen bron/DB-toegang (zie 08-ACCESS-GAPS.md)

`offerteapp-db` en `s4u-quote-db` zijn **niet langer onbekend** — zie de secties hierboven. Voor de volgende systemen bestaat nog steeds aantoonbaar een Postgres-database op Fly.io (via `fly apps list`/secretsnamen), maar het schema is **nog niet onderzocht**:

- `customer-history-db` (gekoppeld aan `telefoon-api` — bevat vermoedelijk klant/interactie-records)
- `telefoon-db` (gekoppeld aan `telefoon-api`/`telefoon-ami-worker`)
- `transport-s4u-db`
- `s4u-import-db`
- database achter `stones4u-calculator`'s eigen `DATABASE_URL`

## Duplicatie-observatie (bijgewerkt)

POS en "locatie" hebben geen eigen `Customer`-tabel — beide verwijzen uitsluitend naar Shopify. **OfferteApp heeft wel een `CustomerCache`** (read-through cache, geen stamgegevens-eigenaarschap) en s4u-quote-app slaat klantgegevens alleen als snapshot op de `Quote`-rij op (geen cache, geen sync naar Shopify). **Nergens in het landschap bestaat een echte, gezaghebbende lokale Customer-master** — een toekomstig CRM `Customer`-model zou dat voor het eerst worden. Zie [14-SHARED-CORE-DESIGN.md](14-SHARED-CORE-DESIGN.md) voor de aanbeveling om dit als een bewust te nemen besluit te behandelen (Fase 0 in [18-RECOMMENDED-BUILD-SEQUENCE.md](18-RECOMMENDED-BUILD-SEQUENCE.md)), niet als vanzelfsprekendheid. `customer-history-db` (Fly-only, nog steeds ongeïnspecteerd) blijft relevant om te onderzoeken voordat dit besluit genomen wordt.
