import { afterEach, describe, expect, it, vi } from "vitest";
import { getPublicAppUrl, buildPublicUrl } from "@/lib/public-url";

// Phase 5C — regression coverage for a real production bug: the
// create/regenerate-token routes used to build DeliveryDateHandoff's public
// link from request.nextUrl.origin, which under this app's standalone
// server.js resolves to the server's own bind address (HOSTNAME/PORT —
// 0.0.0.0:3000 per the Dockerfile) rather than the real public domain. A
// staff member's "Vernieuw link" click produced
// https://0.0.0.0:3000/delivery/<token> in production — unusable, and
// discovered live rather than by any prior test, since every earlier E2E
// round exercised creation via direct Prisma calls rather than the real
// HTTP route. Fixed by never deriving the public origin from the request at
// all — see src/lib/public-url.ts.

describe("getPublicAppUrl / buildPublicUrl", () => {
  afterEach(() => {
    delete process.env.PUBLIC_APP_URL;
    vi.unstubAllEnvs();
  });

  it("builds the correct absolute URL for a production-style PUBLIC_APP_URL", () => {
    process.env.PUBLIC_APP_URL = "https://stones4u-control-center.fly.dev";
    vi.stubEnv("NODE_ENV", "production");

    expect(buildPublicUrl("/delivery/abc123")).toBe("https://stones4u-control-center.fly.dev/delivery/abc123");
  });

  it("builds the correct absolute URL for a staging-style PUBLIC_APP_URL", () => {
    process.env.PUBLIC_APP_URL = "https://stones4u-control-center-staging.fly.dev";
    vi.stubEnv("NODE_ENV", "production");

    expect(buildPublicUrl("/delivery/xyz789")).toBe(
      "https://stones4u-control-center-staging.fly.dev/delivery/xyz789",
    );
  });

  it("URL-safe-appends the token exactly, without dropping or mangling characters", () => {
    process.env.PUBLIC_APP_URL = "https://stones4u-control-center.fly.dev";
    vi.stubEnv("NODE_ENV", "production");

    const token = "uHooKfs49KxyB4sR7XI8ZCwzfiK7ArjsulhQO6Hopbc";
    expect(buildPublicUrl(`/delivery/${token}`)).toBe(`https://stones4u-control-center.fly.dev/delivery/${token}`);
  });

  it("throws when PUBLIC_APP_URL is missing — never silently falls back to an internal host", () => {
    delete process.env.PUBLIC_APP_URL;
    expect(() => getPublicAppUrl()).toThrow(/PUBLIC_APP_URL ontbreekt/);
  });

  it("throws when PUBLIC_APP_URL is not a valid absolute URL", () => {
    process.env.PUBLIC_APP_URL = "not-a-url";
    expect(() => getPublicAppUrl()).toThrow(/geldige absolute URL/);
  });

  it.each(["http://0.0.0.0:3000", "https://0.0.0.0:3000"])(
    "rejects 0.0.0.0 regardless of protocol (%s) — the exact production bug host",
    (raw) => {
      process.env.PUBLIC_APP_URL = raw;
      expect(() => getPublicAppUrl()).toThrow(/interne\/loopback host/);
    },
  );

  it("rejects localhost", () => {
    process.env.PUBLIC_APP_URL = "http://localhost:3000";
    expect(() => getPublicAppUrl()).toThrow(/interne\/loopback host/);
  });

  it("rejects 127.0.0.1", () => {
    process.env.PUBLIC_APP_URL = "http://127.0.0.1:3000";
    expect(() => getPublicAppUrl()).toThrow(/interne\/loopback host/);
  });

  it("requires https when NODE_ENV=production, even for an otherwise-valid, non-loopback host", () => {
    process.env.PUBLIC_APP_URL = "http://stones4u-control-center.fly.dev";
    vi.stubEnv("NODE_ENV", "production");

    expect(() => getPublicAppUrl()).toThrow(/moet https gebruiken/);
  });

  it("allows http outside production for a non-loopback host", () => {
    process.env.PUBLIC_APP_URL = "http://example-dev-tunnel.test";
    vi.stubEnv("NODE_ENV", "test");

    expect(() => getPublicAppUrl()).not.toThrow();
  });

  it("output depends only on PUBLIC_APP_URL — the function takes no request/host input at all, so host-header tampering has no path to influence it", () => {
    process.env.PUBLIC_APP_URL = "https://stones4u-control-center.fly.dev";
    vi.stubEnv("NODE_ENV", "production");

    // buildPublicUrl's signature is (path: string) — there is no host,
    // headers, or request parameter it could read an attacker-controlled
    // value from, unlike the request.nextUrl.origin pattern this replaces.
    expect(buildPublicUrl.length).toBe(1);
    expect(buildPublicUrl("/delivery/tok")).toBe("https://stones4u-control-center.fly.dev/delivery/tok");
  });
});
