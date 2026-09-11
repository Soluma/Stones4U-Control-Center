import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

// Phase 6AJ — verification of the Shopify session token a customer-account
// UI extension sends to this backend.
//
// The extension calls `shopify.sessionToken.get()` and sends the result as a
// bearer token. Shopify signs that JWT with the EXTENSION APP's client secret
// — which is a different app from this repo's own client-credentials Admin
// app (ADR-006). Hence a separate pair of env vars:
//
//   SHOPIFY_EXTENSION_APP_CLIENT_ID      -> must equal the `aud` claim
//   SHOPIFY_EXTENSION_APP_CLIENT_SECRET  -> the HMAC signing key
//
// Reusing SHOPIFY_CLIENT_ID/SECRET here would be wrong, not merely untidy:
// tokens minted for one app would then verify against another app's identity.
//
// WHAT THIS DOES NOT DO: it does not decide whether the bearer may touch a
// given Order. It answers exactly one question — "did Shopify mint this token
// for our extension app, on our shop, recently, for a signed-in customer?" —
// and returns the claims. Binding those claims to an Order is the caller's
// job and happens against a fresh Admin read, never against anything the
// browser sent.
//
// Deliberately implemented on node:crypto rather than adding a JWT library:
// Shopify session tokens are HS256, the verification is ~30 lines, and the
// algorithm-confusion trap below is the kind of thing worth having in plain
// sight in this repo rather than delegated.

/** Clock skew tolerated on exp/nbf/iat, in seconds. */
const CLOCK_SKEW_SECONDS = 30;

/** Shopify session tokens live 5 minutes; anything claiming much longer is
 * not one of ours, whatever it is signed with. */
const MAX_TOKEN_LIFETIME_SECONDS = 15 * 60;

export type SessionTokenRejectionReason =
  | "NOT_CONFIGURED"
  | "MISSING_TOKEN"
  | "MALFORMED"
  | "UNSUPPORTED_ALGORITHM"
  | "BAD_SIGNATURE"
  | "WRONG_AUDIENCE"
  | "WRONG_SHOP"
  | "EXPIRED"
  | "NOT_YET_VALID"
  | "IMPLAUSIBLE_LIFETIME"
  | "NO_CUSTOMER_IDENTITY";

export type VerifiedSessionToken = {
  /** The signed customer identity — `gid://shopify/Customer/<id>`. */
  customerGid: string;
  /** The shop the token was minted for, e.g. `stones4u-dev.myshopify.com`. */
  shopDomain: string;
  /** The token's unique nonce. */
  jti: string | null;
};

export type SessionTokenVerification =
  | { ok: true; claims: VerifiedSessionToken }
  | { ok: false; reason: SessionTokenRejectionReason };

type RawClaims = {
  aud?: unknown;
  dest?: unknown;
  sub?: unknown;
  exp?: unknown;
  nbf?: unknown;
  iat?: unknown;
  jti?: unknown;
};

function base64UrlDecode(segment: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  try {
    return Buffer.from(segment, "base64url");
  } catch {
    return null;
  }
}

/** `https://stones4u-dev.myshopify.com` and `stones4u-dev.myshopify.com` are
 * the same shop; `dest` is documented as the store domain but is not
 * guaranteed to arrive in one shape. */
function normalizeShopDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
}

/**
 * Verifies a Shopify-minted extension session token.
 *
 * Fails closed on every branch: an unconfigured environment rejects exactly
 * like a forged signature does, so a misconfigured deployment can never
 * accidentally become an open endpoint.
 *
 * @param authorizationHeader The raw `Authorization` header, expected as
 *   `Bearer <jwt>`.
 */
export function verifyExtensionSessionToken(
  authorizationHeader: string | null | undefined,
  now: Date = new Date(),
): SessionTokenVerification {
  const expectedAudience = process.env.SHOPIFY_EXTENSION_APP_CLIENT_ID?.trim();
  const secret = process.env.SHOPIFY_EXTENSION_APP_CLIENT_SECRET;
  const expectedShop = process.env.SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN?.trim();
  if (!expectedAudience || !secret || !expectedShop) {
    return { ok: false, reason: "NOT_CONFIGURED" };
  }

  const raw = authorizationHeader?.trim() ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(raw);
  if (!match) return { ok: false, reason: "MISSING_TOKEN" };
  const token = match[1]!.trim();

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "MALFORMED" };
  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];

  const headerBytes = base64UrlDecode(headerSegment);
  const payloadBytes = base64UrlDecode(payloadSegment);
  const providedSignature = base64UrlDecode(signatureSegment);
  if (!headerBytes || !payloadBytes || !providedSignature) {
    return { ok: false, reason: "MALFORMED" };
  }

  let header: { alg?: unknown; typ?: unknown };
  let claims: RawClaims;
  try {
    header = JSON.parse(headerBytes.toString("utf8"));
    claims = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }

  // Algorithm is pinned, never read as an instruction. Accepting whatever
  // `alg` says is the classic JWT confusion bug: "none" would skip
  // verification entirely, and an asymmetric alg would let a token signed
  // with a public key verify against it.
  if (header.alg !== "HS256") {
    return { ok: false, reason: "UNSUPPORTED_ALGORITHM" };
  }

  const expectedSignature = createHmac("sha256", secret)
    .update(`${headerSegment}.${payloadSegment}`, "utf8")
    .digest();
  if (providedSignature.length !== expectedSignature.length) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }
  if (!timingSafeEqual(providedSignature, expectedSignature)) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }

  // ── Signature is good. Only now are the claims worth reading. ──────────

  if (typeof claims.aud !== "string" || claims.aud !== expectedAudience) {
    return { ok: false, reason: "WRONG_AUDIENCE" };
  }

  if (typeof claims.dest !== "string") {
    return { ok: false, reason: "WRONG_SHOP" };
  }
  const shopDomain = normalizeShopDomain(claims.dest);
  if (shopDomain !== normalizeShopDomain(expectedShop)) {
    return { ok: false, reason: "WRONG_SHOP" };
  }

  const nowSeconds = Math.floor(now.getTime() / 1000);

  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
    return { ok: false, reason: "EXPIRED" };
  }
  if (claims.exp + CLOCK_SKEW_SECONDS < nowSeconds) {
    return { ok: false, reason: "EXPIRED" };
  }

  if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_SECONDS > nowSeconds) {
    return { ok: false, reason: "NOT_YET_VALID" };
  }

  // A token whose own claims describe a far-future expiry is rejected even
  // when correctly signed: real Shopify tokens are 5-minute tokens, so a
  // long-lived one indicates something other than the flow we support.
  if (typeof claims.iat === "number" && Number.isFinite(claims.iat)) {
    if (claims.iat - CLOCK_SKEW_SECONDS > nowSeconds) {
      return { ok: false, reason: "NOT_YET_VALID" };
    }
    if (claims.exp - claims.iat > MAX_TOKEN_LIFETIME_SECONDS) {
      return { ok: false, reason: "IMPLAUSIBLE_LIFETIME" };
    }
  }

  // `sub` is absent for a pre-authenticated buyer — Shopify documents that
  // the Order status page reached from an order notification cannot expose a
  // customer id. That is not an error; it is the state the extension must
  // resolve with requireLogin() before submitting. Either way, no write is
  // ever bound to an unsigned identity.
  if (typeof claims.sub !== "string" || !/^gid:\/\/shopify\/Customer\/\d+$/.test(claims.sub)) {
    return { ok: false, reason: "NO_CUSTOMER_IDENTITY" };
  }

  return {
    ok: true,
    claims: {
      customerGid: claims.sub,
      shopDomain,
      jti: typeof claims.jti === "string" ? claims.jti : null,
    },
  };
}
