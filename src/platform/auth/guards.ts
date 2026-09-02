import { getSessionUser, type SessionUser } from "@/platform/auth/session";
import type { Role } from "@/generated/prisma";

export class UnauthenticatedError extends Error {
  constructor() {
    super("UNAUTHENTICATED");
    this.name = "UnauthenticatedError";
  }
}

export class ForbiddenError extends Error {
  constructor(message = "FORBIDDEN") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new UnauthenticatedError();
  return user;
}

export async function requireRole(...roles: Role[]): Promise<SessionUser> {
  const user = await requireUser();
  if (!roles.includes(user.role)) {
    throw new ForbiddenError(`role ${user.role} not in [${roles.join(", ")}]`);
  }
  return user;
}

// VIEWER may never create/edit/delete anything — enforced centrally here so
// no route can accidentally forget the check (unlike TelefoonSysteem, where
// Contacts/Notes routes had no role gating at all — see
// docs/platform-discovery/19 §4 and 21).
export async function requireWriteAccess(): Promise<SessionUser> {
  return requireRole("ADMIN", "AGENT");
}

export async function requireAdmin(): Promise<SessionUser> {
  return requireRole("ADMIN");
}
