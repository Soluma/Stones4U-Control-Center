import "server-only";

// Phase 6C — inbound webhook shop-identity check. Deliberately NOT the
// same mechanism as assertShopifyShopIdentity() (guard.ts): that one makes
// a live Shopify call to verify *our own* outbound-write identity before a
// mutation. This one is a pure, local comparison of the untrusted
// `X-Shopify-Shop-Domain` header against SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN
// — no live call, deliberately cheap, and must run AFTER HMAC verification
// (never before) so this check only ever runs against a request already
// proven to have been signed with this app's own client secret.
//
// Note: Shopify's webhook HMAC covers only the raw body, never headers —
// so this header check is still meaningful defense-in-depth even after a
// valid HMAC, not a redundant belt-and-braces step.

/**
 * Compares the given `X-Shopify-Shop-Domain` header value against the
 * configured SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN. Exact match only (no
 * subdomain/suffix matching — a lookalike domain like
 * "evil-stones4u-dev.myshopify.com" or "stones4u-dev.myshopify.com.evil.com"
 * must never pass). Case-insensitive, since Shopify does not document a
 * guaranteed casing for this header. Fails closed: a missing expected
 * value, a missing header, or a mismatch are all rejections.
 */
export function isExpectedWebhookShopDomain(shopDomainHeader: string | null | undefined): boolean {
  const expected = process.env.SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN?.trim().toLowerCase();
  if (!expected || !shopDomainHeader) return false;

  const actual = shopDomainHeader.trim().toLowerCase();
  return actual === expected;
}
