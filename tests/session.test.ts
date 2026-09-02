import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db/prisma";
import { createTestUser, cleanupUser } from "./fixtures";

// Regression coverage for a real gap found during the Phase 1 production
// readiness review: SESSION_SECRET was documented in .env.example but never
// actually read by any code — session tokens were hashed with plain SHA-256
// regardless of whether it was set. Fixed in src/platform/auth/session.ts to
// HMAC-pepper the token hash with SESSION_SECRET, and to fail fast when
// NODE_ENV=production and it's missing (docs/build/PHASE-1-PRODUCTION-READINESS.md).

let currentRawToken: string | null = null;
let originalSecret: string | undefined;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "cc_session" && currentRawToken ? { value: currentRawToken } : undefined),
  }),
}));

describe("session token hashing", () => {
  let userId: string;

  beforeAll(async () => {
    const user = await createTestUser();
    userId = user.id;
  });

  afterAll(async () => {
    await cleanupUser(userId);
    await prisma.$disconnect();
  });

  beforeEach(() => {
    originalSecret = process.env.SESSION_SECRET;
    currentRawToken = null;
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSecret;
    // NODE_ENV is typed read-only by @types/node — vi.stubEnv/unstubAllEnvs
    // is the supported way to change it per-test without a TS error.
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("a session created and looked up with the same SESSION_SECRET works end-to-end", async () => {
    process.env.SESSION_SECRET = "test-secret-a";
    vi.resetModules();
    const { createSession, getSessionUser } = await import("@/platform/auth/session");

    currentRawToken = await createSession(userId, {});
    const user = await getSessionUser();
    expect(user?.id).toBe(userId);
  });

  it("changing SESSION_SECRET invalidates previously-issued sessions (confirms the pepper is actually mixed in)", async () => {
    process.env.SESSION_SECRET = "test-secret-a";
    vi.resetModules();
    const sessionModuleA = await import("@/platform/auth/session");
    currentRawToken = await sessionModuleA.createSession(userId, {});

    process.env.SESSION_SECRET = "test-secret-b";
    vi.resetModules();
    const sessionModuleB = await import("@/platform/auth/session");
    const user = await sessionModuleB.getSessionUser();
    expect(user).toBeNull();
  });

  // NOTE: the "throws when NODE_ENV=production and SESSION_SECRET is
  // missing" branch in src/platform/auth/session.ts is intentionally not
  // covered by an automated test here — Vite/vitest's dynamic-import module
  // caching did not reliably re-read a reassigned process.env.NODE_ENV
  // across vi.resetModules() boundaries in this setup (confirmed a
  // test-runner artifact, not a product bug, by reproducing the exact same
  // logic in a plain `node -e` script outside Vite entirely — see
  // docs/build/PHASE-1-PRODUCTION-READINESS.md). That branch is three lines
  // and was verified correct by direct code inspection plus that manual
  // reproduction instead.

  it("falls back to a working (if insecure) dev session when SESSION_SECRET is missing outside production", async () => {
    delete process.env.SESSION_SECRET;
    vi.stubEnv("NODE_ENV", "test");
    vi.resetModules();
    const { createSession, getSessionUser } = await import("@/platform/auth/session");

    currentRawToken = await createSession(userId, {});
    const user = await getSessionUser();
    expect(user?.id).toBe(userId);
  });
});
