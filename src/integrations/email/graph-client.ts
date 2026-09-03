import "server-only";
import { ConfidentialClientApplication } from "@azure/msal-node";

// Microsoft Graph client-credentials transport for Phase 3C-A
// (docs/platform-discovery/30-PHASE-3C-EMAIL-INTEGRATION-DISCOVERY.md §3).
// Two concerns, deliberately separated:
//   - GraphCredential: how we authenticate AS the app (client secret today,
//     certificate later — see §3.1). Microsoft365EmailAdapter depends only
//     on this interface, never on which concrete credential is in use, so a
//     future certificate credential is a new class + a branch in
//     createGraphCredential() — Customer 360 and the adapter itself never
//     change.
//   - the low-level fetch helper: timeout, one controlled retry on
//     transient failure, generic fail-safe errors (never a raw Graph error
//     body reaches a caller), no token/secret ever logged.

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const REQUEST_TIMEOUT_MS = 8_000;
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";

export interface GraphCredential {
  /** Returns a valid bearer token. MSAL's ConfidentialClientApplication
   * caches and refreshes internally — callers should call this before every
   * request rather than caching the string themselves long-term. Never
   * logs the token or the underlying secret/certificate. */
  acquireToken(): Promise<string>;
}

// client_secret today (docs/platform-discovery/30 §3.1 — acceptable for
// local/staging; certificate-based auth is the stated production
// preference, added later as a sibling class implementing the same
// GraphCredential interface — see createGraphCredential() below).
export class ClientSecretGraphCredential implements GraphCredential {
  private readonly app: ConfidentialClientApplication;

  constructor(tenantId: string, clientId: string, clientSecret: string) {
    this.app = new ConfidentialClientApplication({
      auth: {
        clientId,
        authority: `https://login.microsoftonline.com/${tenantId}`,
        clientSecret,
      },
    });
  }

  async acquireToken(): Promise<string> {
    const result = await this.app.acquireTokenByClientCredential({ scopes: [GRAPH_SCOPE] });
    if (!result?.accessToken) {
      // Never include the MSAL error detail here — it can echo back
      // configuration values. Server-side log only, generic to callers.
      throw new Error("graph_token_acquisition_failed");
    }
    return result.accessToken;
  }
}

// Extension point for §3.1's stated production preference — not implemented
// in Phase 3C-A (no certificate has been provisioned). Adding it later is a
// new class here plus one branch in createGraphCredential(); nothing in
// microsoft365-adapter.ts, the composing EmailAdapter, or Customer 360
// changes, because all three depend only on the GraphCredential interface.
//
// export class CertificateGraphCredential implements GraphCredential { ... }

export function createGraphCredential(): GraphCredential | null {
  const tenantId = process.env.MICROSOFT_GRAPH_TENANT_ID;
  const clientId = process.env.MICROSOFT_GRAPH_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_GRAPH_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) return null;
  return new ClientSecretGraphCredential(tenantId, clientId, clientSecret);
}

export class GraphRequestError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "GraphRequestError";
  }
}

/** GET against Graph with a timeout, one controlled retry on a transient
 * failure (network error or 5xx — never on 4xx, which is never going to
 * succeed on retry and would just hammer a misconfigured mailbox), and
 * generic fail-safe errors. Returns null (never throws) on any failure the
 * caller should treat as "this mailbox is unavailable right now" — 401/403
 * (auth/RBAC-scope failure) included, since a Customer 360 page must never
 * break because one mailbox is misconfigured. */
export async function graphGet<T>(path: string, credential: GraphCredential, extraHeaders?: Record<string, string>): Promise<T | null> {
  let token: string;
  try {
    token = await credential.acquireToken();
  } catch (error) {
    console.error("graph_auth_failed", error instanceof Error ? error.message : "unknown");
    return null;
  }

  const url = path.startsWith("http") ? path : `${GRAPH_BASE_URL}${path}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, ...extraHeaders },
        signal: controller.signal,
      });

      if (response.ok) {
        return (await response.json()) as T;
      }

      // 4xx (incl. 401/403 — bad token, or an RBAC scope that denies this
      // mailbox) never benefits from a retry.
      if (response.status < 500) {
        console.error("graph_http_error", response.status);
        return null;
      }

      console.error("graph_http_error_retrying", response.status);
      // fall through to retry loop for a 5xx
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      console.error(timedOut ? "graph_timeout" : "graph_request_failed", timedOut ? `${REQUEST_TIMEOUT_MS}ms` : error instanceof Error ? error.message : "unknown");
      if (timedOut) return null; // a second attempt after a timeout is unlikely to help within budget
    } finally {
      clearTimeout(timeout);
    }
  }

  return null;
}
