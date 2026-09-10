import "server-only";
import { shopifyGraphQL } from "./client";
import { ShopifyConfigError, ShopifyShopIdentityMismatchError } from "./errors";

// Fail-closed pre-write safety guard for Control Center's Shopify write
// capability (Phase 7 — Quote Delivery Date Handoff is the first Shopify
// write this repo has ever performed). Distinct from
// assertShopifyShopIdentity() (guard.ts): that guard checks the live shop
// against a SINGLE expected domain read from the same environment's own
// config, whereas this one checks an explicit per-environment allowlist.
//
// SHOP IDENTITIES, verified live in Phase 6X (2026-09-10) — do not restate
// these from memory, and do not assume a config FILE's name tells you which
// shop it addresses:
//
//   9h7x2c-ku.myshopify.com    PRODUCTION. Shop name "Stones4U", primary
//                              domain www.stones4u.eu, paid Shopify plan,
//                              plan.partnerDevelopment = false.
//   stones4u-dev.myshopify.com DEVELOPMENT/STAGING. Shop name "Stones4U_dev",
//                              plan "Grow App Development",
//                              plan.partnerDevelopment = true.
//
// An earlier version of this comment said staging and production shared one
// real shop. That was true once, is no longer true, and the stale wording
// contributed directly to the Phase 6W incident in which ad-hoc tooling —
// using local credentials that addressed PRODUCTION — created eight real
// Orders and two real Draft Orders on the production shop.
//
// That incident did not defeat this guard; it BYPASSED it, by calling the
// Shopify API with raw fetch instead of going through shopifyGraphQL(). The
// lesson is therefore not "add another check here" but: every Shopify write,
// including one-off investigation scripts, must go through the app's own
// client so that this guard runs at all.
//
// This guard is deliberately a SEPARATE, uniform mechanism across every
// environment: writes are allowed only against myshopifyDomain values
// listed in SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS for THIS environment.
// No environment-name branching (no `if (APP_ENV === "production")`
// anywhere in this file or any caller) — the approved-domain list lives
// exclusively in config, never in business logic, so the same code path
// behaves identically and safely regardless of which environment it runs
// in. An unset or empty allowlist means zero writes are possible — the
// safe default in every environment until a human explicitly configures
// it, matching CLAUDE.md's "no exceptions" instruction for
// assertShopifyShopIdentity().

const SHOP_IDENTITY_QUERY = /* GraphQL */ `
  query ShopIdentityForWrite {
    shop {
      myshopifyDomain
    }
  }
`;

type ShopIdentityResponse = { shop: { myshopifyDomain: string } };

function getApprovedWriteDomains(): string[] {
  const raw = process.env.SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Verifies the live Shopify shop this process is currently configured
 * against is on the approved write allowlist for this environment. Must be
 * called as the very first step of every Shopify mutation — never after
 * any part of the mutation has already been constructed or sent.
 *
 * Throws ShopifyConfigError if no allowlist is configured at all (fail
 * closed), or ShopifyShopIdentityMismatchError if the live shop is not on
 * the list. Both are safe to surface as a generic "not configured"/
 * retryable error to the caller — neither ever includes a credential.
 */
export async function assertShopifyWriteAllowed(): Promise<void> {
  const approved = getApprovedWriteDomains();
  if (approved.length === 0) {
    throw new ShopifyConfigError(
      "SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS ontbreekt in de environment — Shopify-writes zijn in deze omgeving standaard geblokkeerd totdat dit expliciet is geconfigureerd.",
    );
  }

  const data = await shopifyGraphQL<ShopIdentityResponse>(SHOP_IDENTITY_QUERY);
  const actual = data.shop.myshopifyDomain.toLowerCase();

  if (!approved.includes(actual)) {
    throw new ShopifyShopIdentityMismatchError(approved.join(", "), actual);
  }
}
