# Palletfoto's in de CRM-orderhistorie — hoe te lezen (nog niet gebouwd)

Status: **alleen ontwerp**. De Control Center-code verandert hier nog niet.

## Wat er in Shopify staat

De Stones4U Pick App slaat palletfoto's op via OfferteApp als Shopify-bestanden
(`MediaImage`). Ze hangen aan de order in één metafield:

| | |
|---|---|
| Owner | `ORDER` |
| Namespace / key | `custom.pick_pallet_photos` |
| Type | `list.file_reference`, alleen afbeeldingen (`file_type_options: ["Image"]`), max. 20 |
| Schrijver | alleen OfferteApp (`app/services/pick/photo_service.py`) |
| Alt-tekst | `Palletfoto #<order> · <picker> · <dd-mm-jjjj uu:mm>` (Amsterdamse tijd) |

Een verwijzing komt pas in het metafield als het bestand de status `READY` heeft.
Een verwijzing kan wel naar niets wijzen als iemand het bestand in de
Shopify-admin verwijdert; dan geeft Shopify `null` in `nodes`. Sla die over.

## Query (CRM, API-versie 2026-07)

Dit hoort in de bestaande order-read van `src/integrations/shopify/`. Het is
een lees-query, geen mutatie, dus er is geen shop-guard nodig.

```graphql
query OrderPalletPhotos($id: ID!) {
  order(id: $id) {
    id
    name
    palletPhotos: metafield(namespace: "custom", key: "pick_pallet_photos") {
      references(first: 20) {
        nodes {
          ... on MediaImage {
            id
            alt
            createdAt
            image {
              thumb: url(transform: { maxWidth: 400 })
              full: url
              width
              height
            }
          }
        }
      }
    }
  }
}
```

- **Scopes:** geen extra. De CRM-app heeft `read_orders` via
  `write_orders`/`read_merchant_managed_fulfillment_orders`. In de spike op de
  dev-shop is bevestigd dat dit genoeg is om de verwijzingen, de alt en de
  thumbnail-URL te lezen; `read_files` is **niet** nodig.
- **Geen extra kosten per order:** het is een veld op de order-query die al
  bestaat, zonder aparte Files-query.

## Weergave in de orderhistorie (voorstel)

- Een rij thumbnails (`thumb`) onder de order; klikken opent `full`.
- Als ondertitel `createdAt` + de picker uit de alt-tekst.
- `palletPhotos` is `null` → geen blok tonen (de meeste orders).

## Grenzen (ADR-002 / ADR-003)

- **Niets opslaan in de CRM-database:** geen URL's, geen kopieën. Live lezen
  uit Shopify, net als de rest van de order.
- **Niet schrijven:** foto's toevoegen of verwijderen blijft bij de Pick App via
  OfferteApp.
- **Privacy:** `cdn.shopify.com`-URL's zijn openbaar voor wie de link heeft.
  Toon ze alleen in de ingelogde CRM, en zet ze niet in e-mails of in
  klantportalen.
