import "server-only";

// Canonical public base URL for building customer-facing bearer URLs (e.g.
// DeliveryDateHandoff's /delivery/[token] link). Deliberately NEVER derived
// from the incoming request (request.nextUrl.origin, the Host header, or
// any X-Forwarded-* header): under this app's standalone server.js, that
// origin falls back to the server's own bind address (HOSTNAME/PORT —
// 0.0.0.0:3000 per the Dockerfile) instead of the real public domain, and
// even where it doesn't, trusting a request-controlled host for a
// bearer-token URL would open host-header injection. PUBLIC_APP_URL is the
// single, explicit, server-configured source of truth instead — same
// fail-closed philosophy as SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS
// (write-safety-guard.ts): no value configured means the feature fails
// clearly, never a silent fallback to an internal host.
//
// No environment-name branching (CLAUDE.md) — https is required whenever
// NODE_ENV=production, which is true for both staging and production here
// (they share the same Dockerfile), so this one check already covers "only
// https in production/staging" without ever reading an environment name.

const FORBIDDEN_HOSTNAMES = new Set(["0.0.0.0", "localhost", "127.0.0.1"]);

/**
 * Resolves and validates the canonical public base URL. Throws a clear,
 * non-sensitive error if PUBLIC_APP_URL is missing, malformed, points at an
 * internal/loopback host, or (in production) isn't https — never falls
 * back to any request-derived or internal-bind value.
 */
export function getPublicAppUrl(): URL {
  const raw = process.env.PUBLIC_APP_URL?.trim();
  if (!raw) {
    throw new Error(
      "PUBLIC_APP_URL ontbreekt in de environment — er kan geen klant-gerichte publieke URL worden opgebouwd zonder een expliciet geconfigureerde canonical base URL.",
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`PUBLIC_APP_URL is geen geldige absolute URL: "${raw}".`);
  }

  const hostname = url.hostname.toLowerCase();
  if (FORBIDDEN_HOSTNAMES.has(hostname)) {
    throw new Error(
      `PUBLIC_APP_URL wijst naar een interne/loopback host ("${hostname}") — dit mag nooit gebruikt worden voor een klant-gerichte URL.`,
    );
  }

  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("PUBLIC_APP_URL moet https gebruiken wanneer NODE_ENV=production.");
  }

  return url;
}

/**
 * Builds an absolute public URL for `path` against the canonical base URL.
 * The only URL-building path for customer-facing bearer links — reuse this
 * rather than constructing URLs from request.nextUrl/request.url anywhere
 * a link will be shown to or used by a customer.
 */
export function buildPublicUrl(path: string): string {
  return new URL(path, getPublicAppUrl()).toString();
}
