import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

// Phase 6C — Shopify webhook HMAC verification. Reuses SHOPIFY_CLIENT_SECRET
// as the signing key — verified against Shopify's own webhook
// documentation ("verification uses your app's client secret as the key"),
// not assumed. This repo's Shopify app is a client-credentials custom app
// (ADR-006) that already treats SHOPIFY_CLIENT_SECRET as its one
// confidential credential; no separate SHOPIFY_WEBHOOK_SECRET is
// introduced, since that would just be a second name for the same value
// and a second thing to keep in sync across environments.
//
// Fail-closed: a missing secret, a missing/malformed header, or a
// signature mismatch are all treated identically by the caller (the
// webhook route) — reject before any payload is trusted or parsed. Never
// compares raw strings — always timing-safe, and only after confirming
// both buffers are the same length (an unequal-length compare is safe to
// short-circuit; it can never be a valid signature).

/**
 * Verifies a Shopify webhook's HMAC-SHA256 signature against the *raw*
 * request body — never a re-serialized/re-parsed version of it, which
 * would not reproduce Shopify's original byte sequence and could let a
 * tampered body with a different byte-for-byte representation of the same
 * logical JSON pass verification.
 *
 * @param rawBody Exact raw request body as Shopify sent it (before any
 *   JSON.parse).
 * @param hmacHeader The `X-Shopify-Hmac-Sha256` header value, base64-encoded,
 *   or null/undefined if absent.
 */
export function verifyShopifyWebhookHmac(rawBody: string, hmacHeader: string | null | undefined): boolean {
  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!secret || !hmacHeader) return false;

  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();

  let provided: Buffer;
  try {
    provided = Buffer.from(hmacHeader, "base64");
  } catch {
    return false;
  }

  // timingSafeEqual throws on a length mismatch rather than returning
  // false — an attacker-controlled header could otherwise leak timing
  // information about the expected length. A length mismatch can never be
  // a valid signature, so it's safe to reject immediately without calling
  // timingSafeEqual at all.
  if (provided.length !== expected.length) return false;

  return timingSafeEqual(provided, expected);
}
