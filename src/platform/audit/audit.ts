import { prisma } from "@/platform/db/prisma";

export type AuditAction =
  | "auth.login"
  | "auth.login_failed"
  | "auth.logout"
  | "user.created"
  | "user.role_changed"
  | "user.deactivated"
  | "note.created"
  | "note.updated"
  | "note.deleted"
  | "task.created"
  | "task.status_changed"
  | "task.assigned"
  | "task.completed"
  | "task.cancelled"
  | "customer_profile.updated";

export type AuditEntityType =
  | "User"
  | "Session"
  | "Note"
  | "Task"
  | "CustomerProfile";

type LogAuditInput = {
  userId: string | null;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId?: string | null;
  // Free-form context (e.g. old/new status). MUST NEVER contain a secret,
  // token, or password value — this is a hard rule across the whole
  // Stones4U platform, not just Control Center.
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
};

// The one place every mutating action in Control Center writes its audit
// trail. Deliberately defensive: an audit-write failure must never break
// the calling transaction (same principle as OfferteApp's log_audit()).
export async function logAudit(input: LogAuditInput): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: {
        userId: input.userId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        metadata: input.metadata as never,
        ipAddress: input.ipAddress ?? null,
      },
    });
  } catch (error) {
    console.error("audit_write_failed", { action: input.action, error: String(error) });
  }
}
