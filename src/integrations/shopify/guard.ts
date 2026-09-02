import "server-only";
import { shopifyGraphQL } from "./client";
import { ShopifyConfigError, ShopifyShopIdentityMismatchError } from "./errors";

const SHOP_IDENTITY_QUERY = /* GraphQL */ `
  query ShopIdentity {
    shop {
      myshopifyDomain
    }
  }
`;

type ShopIdentityResponse = { shop: { myshopifyDomain: string } };

/**
 * Live shop-identity verification — ports the safety pattern proven in Kassa
 * Systeem (src/lib/shopify-guard.ts), one of the direct-A Shared Core
 * candidates from docs/platform-discovery/14. Every future Shopify WRITE in
 * Control Center must call this first (Phase 1 has no writes, so nothing
 * calls this yet in application code — it exists so Phase 2+ never has to
 * add it under time pressure).
 */
export async function assertShopifyShopIdentity(): Promise<void> {
  const expected = process.env.SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN?.trim();
  if (!expected) {
    throw new ShopifyConfigError("SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN ontbreekt in de environment.");
  }

  const data = await shopifyGraphQL<ShopIdentityResponse>(SHOP_IDENTITY_QUERY);
  const actual = data.shop.myshopifyDomain;

  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new ShopifyShopIdentityMismatchError(expected, actual);
  }
}
