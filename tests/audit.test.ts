import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db/prisma";
import { logAudit } from "@/platform/audit/audit";
import { createTestUser, cleanupUser } from "./fixtures";

describe("audit", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("writes an AuditEvent row for a mutating action", async () => {
    const user = await createTestUser();
    await logAudit({ userId: user.id, action: "note.created", entityType: "Note", entityId: "abc" });

    const event = await prisma.auditEvent.findFirst({ where: { userId: user.id, action: "note.created" } });
    expect(event).not.toBeNull();
    expect(event?.entityType).toBe("Note");

    await cleanupUser(user.id);
  });

  it("never throws when the write itself fails — a broken audit write must not break the caller", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // A userId that violates the foreign key forces prisma.auditEvent.create to reject.
    await expect(
      logAudit({ userId: "not-a-real-user-id", action: "note.created", entityType: "Note" }),
    ).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
