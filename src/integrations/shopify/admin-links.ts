/** Classic `https://{shop}.myshopify.com/admin/...` URLs still redirect
 * correctly to the current Shopify Admin — used instead of the newer
 * `admin.shopify.com/store/{handle}/...` form because it needs no extra
 * shop-handle lookup/transformation beyond the domain we already have
 * (docs/platform-discovery/29-PHASE-3-BUILD-SPEC.md §9). No "server-only"
 * guard here — pure string formatting, no secret/network access, shared by
 * both orders.ts and draft-orders.ts. */
export function buildShopifyAdminUrl(shopDomain: string, resource: "orders" | "draft_orders", legacyResourceId: string): string {
  return `https://${shopDomain}/admin/${resource}/${legacyResourceId}`;
}
