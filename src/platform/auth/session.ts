import { randomBytes, createHash, createHmac } from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "@/platform/db/prisma";
import type { Role } from "@/generated/prisma";

export const SESSION_COOKIE_NAME = "cc_session";
const SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 7; // 7 days, but revocable (see schema.prisma Session)

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
};

let warnedMissingSessionSecret = false;

// The raw token itself is a 256-bit CSPRNG value, so hashing it before
// storage doesn't strictly need a server-side secret for the security model
// to hold (an attacker with only the DB can't derive a valid raw token from
// its hash either way). SESSION_SECRET is nonetheless mixed in via HMAC as
// defense-in-depth (protects e.g. against `tokenHash` values leaking
// alongside some future non-CSPRNG bug). Found during the Phase 1
// production readiness review: SESSION_SECRET was documented in
// .env.example but never actually read anywhere — this wires it in for
// real, and requires it outright in production rather than continuing to
// silently ignore it. Development stays convenient (a fixed, clearly-
// labeled fallback, with a one-time console warning) rather than TelefoonSysteem's
// silent fallback pattern flagged in docs/platform-discovery/19 §4.
function hashToken(rawToken: string): string {
  const secret = process.env.SESSION_SECRET;

  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SESSION_SECRET ontbreekt in de environment (verplicht in productie).");
    }
    if (!warnedMissingSessionSecret) {
      console.warn(
        "SESSION_SECRET is niet gezet — sessies gebruiken een onveilige ontwikkel-fallback. Zet SESSION_SECRET vóór een productie-deploy.",
      );
      warnedMissingSessionSecret = true;
    }
    return createHash("sha256").update(`dev-insecure-fallback:${rawToken}`).digest("hex");
  }

  return createHmac("sha256", secret).update(rawToken).digest("hex");
}

// Only the SHA-256 hash of the token is ever persisted — the raw token lives
// exclusively in the httpOnly cookie, mirroring the pattern already proven
// in Kassa Systeem (src/lib/auth.ts) rather than TelefoonSysteem's stateless,
// non-revocable JWT (see docs/platform-discovery/19 §4).
export async function createSession(
  userId: string,
  context: { userAgent?: string | null; ipAddress?: string | null },
): Promise<string> {
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  // Opportunistic cleanup: expired sessions are never actively deleted
  // elsewhere (getSessionUser only treats them as invalid, it doesn't
  // remove the row), so without this the Session table grows unbounded.
  // Bounding it per-user on every login is a cheap, safe fix — found during
  // the Phase 1 production readiness review (a proper scheduled sweep
  // across all users is a reasonable Phase 2 addition, not done here).
  await prisma.session.deleteMany({ where: { userId, expiresAt: { lt: new Date() } } }).catch(() => undefined);

  await prisma.session.create({
    data: {
      userId,
      tokenHash,
      expiresAt,
      userAgent: context.userAgent ?? undefined,
      ipAddress: context.ipAddress ?? undefined,
    },
  });

  return rawToken;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const rawToken = store.get(SESSION_COOKIE_NAME)?.value;
  if (!rawToken) return null;

  const tokenHash = hashToken(rawToken);
  const session = await prisma.session.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!session || session.expiresAt < new Date() || !session.user.active) {
    return null;
  }

  // Best-effort activity tracking; never block the request on this write.
  void prisma.session
    .update({ where: { id: session.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role,
  };
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  const rawToken = store.get(SESSION_COOKIE_NAME)?.value;
  if (rawToken) {
    await prisma.session.deleteMany({ where: { tokenHash: hashToken(rawToken) } });
  }
}

export async function destroyAllSessionsForUser(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } });
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_DURATION_MS / 1000,
  };
}
