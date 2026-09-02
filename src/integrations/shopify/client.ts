import "server-only";
import { ShopifyApiError, ShopifyConfigError } from "./errors";

// Server-side Shopify Admin GraphQL client for Control Center.
//
// Auth: OAuth CLIENT-CREDENTIALS grant (docs/architecture/ADR-006) — never a
// permanent, manually-issued SHOPIFY_ADMIN_ACCESS_TOKEN. This is a direct,
// deliberate port of the pattern already proven in Kassa Systeem
// (src/lib/shopify.ts): the access token is requested from Shopify on first
// use and cached in memory only (per server process), refreshed shortly
// before it expires, with in-flight de-duplication so concurrent callers
// never trigger duplicate token requests. Never persisted to disk, the
// database, or sent to the browser.
//
// PHASE 1 IS READ-ONLY: this module intentionally exposes no mutation
// helpers. See src/integrations/shopify/customers.ts and orders.ts.

const MYSHOPIFY_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_REFRESH_BUFFER_MS = 60_000;
const MAX_RETRIES = 2;

type ShopifyConfig = {
  domain: string;
  apiVersion: string;
  clientId: string;
  clientSecret: string;
  graphqlEndpoint: string;
  tokenEndpoint: string;
};

type CachedToken = { accessToken: string; validUntil: number };

let cachedToken: CachedToken | null = null;
let pendingTokenRequest: Promise<string> | null = null;

function readEnvVar(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new ShopifyConfigError(`${name} ontbreekt in de environment.`);
  }
  return value.trim();
}

export function getShopifyConfig(): ShopifyConfig {
  const domain = readEnvVar("SHOPIFY_SHOP_DOMAIN");
  const apiVersion = readEnvVar("SHOPIFY_API_VERSION");
  const clientId = readEnvVar("SHOPIFY_CLIENT_ID");
  const clientSecret = readEnvVar("SHOPIFY_CLIENT_SECRET");

  if (!MYSHOPIFY_DOMAIN_RE.test(domain)) {
    throw new ShopifyConfigError(
      `SHOPIFY_SHOP_DOMAIN moet exact "<shop>.myshopify.com" zijn, zonder https:// en zonder pad.`,
    );
  }

  return {
    domain,
    apiVersion,
    clientId,
    clientSecret,
    graphqlEndpoint: `https://${domain}/admin/api/${apiVersion}/graphql.json`,
    tokenEndpoint: `https://${domain}/admin/oauth/access_token`,
  };
}

/** True only if every required Shopify env var is present — used to give a
 * clean "not configured" UI state instead of a stack trace when a developer
 * hasn't set up their own custom app credentials yet (see .env.example). */
export function isShopifyConfigured(): boolean {
  try {
    getShopifyConfig();
    return true;
  } catch {
    return false;
  }
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function requestNewAccessToken(config: ShopifyConfig): Promise<string> {
  let response: Response;
  try {
    response = await fetchWithTimeout(config.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ShopifyApiError(`Shopify-tokenverzoek liep vast na ${REQUEST_TIMEOUT_MS / 1000}s (timeout).`);
    }
    throw new ShopifyApiError(
      `Kon geen verbinding maken met Shopify voor een access token: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const bodyText = await response.text();
  let body: { access_token?: string; expires_in?: number } | null = null;
  try {
    body = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    // fall through to status-based error below
  }

  if (!response.ok || !body?.access_token) {
    // Shopify's token error response never echoes back the client secret —
    // safe to log.
    console.error("shopify_token_request_failed", response.status, response.statusText);
    throw new ShopifyApiError(`Kon geen Shopify access token verkrijgen (status ${response.status}).`, {
      status: response.status,
    });
  }

  const expiresInSeconds = body.expires_in ?? 0;
  cachedToken = {
    accessToken: body.access_token,
    validUntil: Date.now() + expiresInSeconds * 1000 - TOKEN_REFRESH_BUFFER_MS,
  };
  return cachedToken.accessToken;
}

async function getAccessToken(config: ShopifyConfig): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.validUntil) {
    return cachedToken.accessToken;
  }
  if (!pendingTokenRequest) {
    pendingTokenRequest = requestNewAccessToken(config).finally(() => {
      pendingTokenRequest = null;
    });
  }
  return pendingTokenRequest;
}

/** Exposed only for tests — never call outside a test file. */
export function __resetShopifyClientStateForTests(): void {
  cachedToken = null;
  pendingTokenRequest = null;
}

async function performGraphQLRequest<T>(
  config: ShopifyConfig,
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchWithTimeout(config.graphqlEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ShopifyApiError(`Shopify Admin API-verzoek liep vast na ${REQUEST_TIMEOUT_MS / 1000}s (timeout).`);
    }
    throw new ShopifyApiError(
      `Kon geen verbinding maken met Shopify Admin API: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const bodyText = await response.text();
  let body: { data?: T; errors?: { message: string; extensions?: unknown }[] } | null = null;
  try {
    body = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    // fall through to status-based error below
  }

  if (!response.ok) {
    console.error("shopify_admin_api_http_error", response.status, response.statusText);
    throw new ShopifyApiError(`Shopify Admin API gaf status ${response.status} ${response.statusText}.`, {
      status: response.status,
      graphqlErrors: body?.errors,
    });
  }

  if (body?.errors && body.errors.length > 0) {
    for (const err of body.errors) {
      console.error("shopify_graphql_error", err.message);
    }
    // status is set to the (successful) HTTP status here deliberately, so
    // isTransientError() never mistakes a GraphQL-level user error (e.g. an
    // invalid field/query) for a network/timeout failure — only a genuinely
    // absent status (thrown before any response was received) means
    // "network/timeout" and is worth retrying.
    throw new ShopifyApiError("Shopify Admin API gaf GraphQL-fouten terug.", {
      status: response.status,
      graphqlErrors: body.errors,
    });
  }

  if (!body?.data) {
    throw new ShopifyApiError("Shopify Admin API gaf een onverwacht leeg antwoord terug.", {
      status: response.status,
    });
  }

  return body.data;
}

function isTransientError(error: unknown): boolean {
  if (!(error instanceof ShopifyApiError)) return false;
  if (error.status === undefined) return true; // network/timeout
  return error.status === 429 || error.status >= 500;
}

/**
 * Runs a Shopify Admin GraphQL query/mutation with automatic client-
 * credentials auth and up to MAX_RETRIES retries (linear backoff) on
 * transient errors — an improvement on Kassa Systeem's no-retry client,
 * matching what discovery found worked better in OfferteApp
 * (docs/platform-discovery/12).
 */
export async function shopifyGraphQL<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const config = getShopifyConfig();
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const accessToken = await getAccessToken(config);
      return await performGraphQLRequest<T>(config, accessToken, query, variables);
    } catch (error) {
      lastError = error;
      if (!isTransientError(error) || attempt === MAX_RETRIES) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }

  throw lastError;
}
