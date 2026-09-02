import "server-only";
import { prisma } from "@/platform/db/prisma";
import { hashPassword, isPasswordStrongEnough } from "@/platform/auth/password";
import { destroyAllSessionsForUser } from "@/platform/auth/session";
import { logAudit } from "@/platform/audit/audit";
import type { Role } from "@/generated/prisma";

export async function listUsers() {
  return prisma.user.findMany({
    select: { id: true, email: true, name: true, role: true, active: true, lastLoginAt: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
}

export async function createUser(
  input: { email: string; name: string; password: string; role: Role },
  actor: { id: string },
) {
  if (!isPasswordStrongEnough(input.password)) {
    throw new Error("Wachtwoord moet minimaal 10 tekens zijn.");
  }

  const passwordHash = await hashPassword(input.password);
  const user = await prisma.user.create({
    data: {
      email: input.email.trim().toLowerCase(),
      name: input.name.trim(),
      passwordHash,
      role: input.role,
    },
  });

  await logAudit({
    userId: actor.id,
    action: "user.created",
    entityType: "User",
    entityId: user.id,
    metadata: { role: input.role },
  });

  return user;
}

export async function changeUserRole(userId: string, role: Role, actor: { id: string }) {
  const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const updated = await prisma.user.update({ where: { id: userId }, data: { role } });

  // Sessions are DB-backed, so a role change (unlike TelefoonSysteem's
  // stateless JWT — docs/platform-discovery/19 §4) can be made effective
  // immediately by revoking existing sessions, forcing a re-login with the
  // new role rather than waiting out a token's lifetime.
  await destroyAllSessionsForUser(userId);

  await logAudit({
    userId: actor.id,
    action: "user.role_changed",
    entityType: "User",
    entityId: userId,
    metadata: { oldRole: before.role, newRole: role },
  });

  return updated;
}

export async function deactivateUser(userId: string, actor: { id: string }) {
  const updated = await prisma.user.update({ where: { id: userId }, data: { active: false } });
  await destroyAllSessionsForUser(userId);

  await logAudit({ userId: actor.id, action: "user.deactivated", entityType: "User", entityId: userId });

  return updated;
}
