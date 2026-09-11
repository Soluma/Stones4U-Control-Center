import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyExtensionSessionToken } from "@/integrations/shopify/extension-session-token";

// Phase 6AJ — the security boundary between a Shopify-hosted extension and
// this backend. These are behavioural tests against real signed tokens, not
// assertions about source text: every case below mints an actual JWT and
// checks what the verifier does with it.

const APP_ID = "test-extension-client-id";
const SECRET = "test-extension-client-secret";
const SHOP = "stones4u-dev.myshopify.com";
const CUSTOMER = "gid://shopify/Customer/1234567890";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

function mint(
  claims: Record<string, unknown> = {},
  opts: { secret?: string; alg?: string } = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: opts.alg ?? "HS256", typ: "JWT" });
  const payload = b64({
    aud: APP_ID,
    dest: SHOP,
    sub: CUSTOMER,
    iat: now,
    nbf: now,
    exp: now + 300,
    jti: "nonce-1",
    ...claims,
  });
  const sig = createHmac("sha256", opts.secret ?? SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${sig}`;
}

const bearer = (t: string) => `Bearer ${t}`;

beforeEach(() => {
  process.env.SHOPIFY_EXTENSION_APP_CLIENT_ID = APP_ID;
  process.env.SHOPIFY_EXTENSION_APP_CLIENT_SECRET = SECRET;
  process.env.SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN = SHOP;
});

afterEach(() => {
  delete process.env.SHOPIFY_EXTENSION_APP_CLIENT_ID;
  delete process.env.SHOPIFY_EXTENSION_APP_CLIENT_SECRET;
  delete process.env.SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN;
});

describe("verifyExtensionSessionToken — accepts only Shopify-minted tokens", () => {
  it("accepts a well-formed token and returns the signed customer identity", () => {
    const result = verifyExtensionSessionToken(bearer(mint()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.customerGid).toBe(CUSTOMER);
    expect(result.claims.shopDomain).toBe(SHOP);
    expect(result.claims.jti).toBe("nonce-1");
  });

  it("accepts dest with an https:// prefix as the same shop", () => {
    const result = verifyExtensionSessionToken(bearer(mint({ dest: `https://${SHOP}` })));
    expect(result.ok).toBe(true);
  });
});

describe("verifyExtensionSessionToken — signature", () => {
  it("rejects a token signed with the wrong secret", () => {
    const result = verifyExtensionSessionToken(bearer(mint({}, { secret: "attacker-secret" })));
    expect(result).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("rejects a tampered payload that keeps the original signature", () => {
    const token = mint();
    const [h, , s] = token.split(".");
    const forged = b64({ aud: APP_ID, dest: SHOP, sub: "gid://shopify/Customer/999", exp: 99999999999 });
    const result = verifyExtensionSessionToken(bearer(`${h}.${forged}.${s}`));
    expect(result).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("rejects alg:none — an unsigned token is never trusted", () => {
    const now = Math.floor(Date.now() / 1000);
    const header = b64({ alg: "none", typ: "JWT" });
    const payload = b64({ aud: APP_ID, dest: SHOP, sub: CUSTOMER, exp: now + 300 });
    const result = verifyExtensionSessionToken(bearer(`${header}.${payload}.`));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Either rejection is correct; what must never happen is acceptance.
    expect(["UNSUPPORTED_ALGORITHM", "MALFORMED"]).toContain(result.reason);
  });

  it("rejects an algorithm the verifier does not pin to", () => {
    const result = verifyExtensionSessionToken(bearer(mint({}, { alg: "HS512" })));
    expect(result).toEqual({ ok: false, reason: "UNSUPPORTED_ALGORITHM" });
  });
});

describe("verifyExtensionSessionToken — audience and shop", () => {
  it("rejects a token minted for another app", () => {
    const result = verifyExtensionSessionToken(bearer(mint({ aud: "some-other-app" })));
    expect(result).toEqual({ ok: false, reason: "WRONG_AUDIENCE" });
  });

  it("rejects a correctly signed token from another shop", () => {
    const result = verifyExtensionSessionToken(bearer(mint({ dest: "9h7x2c-ku.myshopify.com" })));
    expect(result).toEqual({ ok: false, reason: "WRONG_SHOP" });
  });
});

describe("verifyExtensionSessionToken — time claims", () => {
  it("rejects an expired token", () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const result = verifyExtensionSessionToken(bearer(mint({ iat: past, nbf: past, exp: past + 300 })));
    expect(result).toEqual({ ok: false, reason: "EXPIRED" });
  });

  it("rejects a token that is not yet valid", () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const result = verifyExtensionSessionToken(bearer(mint({ nbf: future, exp: future + 300 })));
    expect(result).toEqual({ ok: false, reason: "NOT_YET_VALID" });
  });

  it("rejects a correctly signed token claiming an implausibly long life", () => {
    const now = Math.floor(Date.now() / 1000);
    const result = verifyExtensionSessionToken(bearer(mint({ iat: now, exp: now + 86400 })));
    expect(result).toEqual({ ok: false, reason: "IMPLAUSIBLE_LIFETIME" });
  });
});

describe("verifyExtensionSessionToken — customer identity", () => {
  it("rejects a pre-authenticated token with no sub claim", () => {
    const result = verifyExtensionSessionToken(bearer(mint({ sub: undefined })));
    expect(result).toEqual({ ok: false, reason: "NO_CUSTOMER_IDENTITY" });
  });

  it("rejects a sub that is not a Customer GID", () => {
    for (const sub of ["1234567890", "gid://shopify/Order/1", "gid://shopify/Customer/abc"]) {
      const result = verifyExtensionSessionToken(bearer(mint({ sub })));
      expect(result).toEqual({ ok: false, reason: "NO_CUSTOMER_IDENTITY" });
    }
  });
});

describe("verifyExtensionSessionToken — fails closed", () => {
  it("rejects when the server is not configured, even with a valid token", () => {
    const token = bearer(mint());
    delete process.env.SHOPIFY_EXTENSION_APP_CLIENT_SECRET;
    expect(verifyExtensionSessionToken(token)).toEqual({ ok: false, reason: "NOT_CONFIGURED" });
  });

  it("rejects a missing or malformed Authorization header", () => {
    expect(verifyExtensionSessionToken(null).ok).toBe(false);
    expect(verifyExtensionSessionToken("").ok).toBe(false);
    expect(verifyExtensionSessionToken(mint()).ok).toBe(false); // no "Bearer "
    expect(verifyExtensionSessionToken(bearer("not.a.jwt")).ok).toBe(false);
    expect(verifyExtensionSessionToken(bearer("only.two")).ok).toBe(false);
  });

  it("never reuses the Admin app's own credentials as the extension's", () => {
    // A token minted with SHOPIFY_CLIENT_SECRET must not verify here: the
    // extension app is a different app with a different secret.
    process.env.SHOPIFY_CLIENT_SECRET = "admin-app-secret";
    const result = verifyExtensionSessionToken(bearer(mint({}, { secret: "admin-app-secret" })));
    expect(result).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    delete process.env.SHOPIFY_CLIENT_SECRET;
  });
});
