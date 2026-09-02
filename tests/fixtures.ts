import { prisma } from "@/platform/db/prisma";

export async function createTestUser(overrides: { role?: "ADMIN" | "AGENT" | "VIEWER"; email?: string } = {}) {
  return prisma.user.create({
    data: {
      email: overrides.email ?? `test-${crypto.randomUUID()}@example.com`,
      name: "Test Gebruiker",
      passwordHash: "unused-in-tests",
      role: overrides.role ?? "AGENT",
    },
  });
}

export async function createTestCustomerProfile() {
  return prisma.customerProfile.create({
    data: {
      shopifyCustomerGid: `gid://shopify/Customer/${crypto.randomUUID()}`,
      displayName: "Fixture Klant",
    },
  });
}

export async function cleanupUser(userId: string) {
  await prisma.session.deleteMany({ where: { userId } });
  await prisma.auditEvent.deleteMany({ where: { userId } });
  // Phase 2 entities with a non-cascading FK to User (createdBy/uploadedBy/
  // assignedBy) — deleted defensively so a test-created row never blocks
  // user cleanup, mirroring the existing session/auditEvent pattern above.
  await prisma.customerTagAssignment.deleteMany({ where: { assignedById: userId } });
  await prisma.customerTag.deleteMany({ where: { createdById: userId } });
  await prisma.file.deleteMany({ where: { uploadedById: userId } });
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
}

export async function cleanupCustomerProfile(customerProfileId: string) {
  await prisma.activity.deleteMany({ where: { customerProfileId } });
  await prisma.note.deleteMany({ where: { customerProfileId } });
  await prisma.task.deleteMany({ where: { customerProfileId } });
  await prisma.appointment.deleteMany({ where: { customerProfileId } });
  await prisma.file.deleteMany({ where: { customerProfileId } });
  await prisma.customerTagAssignment.deleteMany({ where: { customerProfileId } });
  await prisma.customerProfile.delete({ where: { id: customerProfileId } }).catch(() => undefined);
}
