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
  | "customer_profile.updated"
  // Phase 2
  | "task.updated"
  | "task.comment_added"
  | "task.checklist_item_added"
  | "task.checklist_item_toggled"
  | "task.checklist_item_removed"
  | "appointment.created"
  | "appointment.updated"
  | "appointment.completed"
  | "appointment.cancelled"
  | "file.uploaded"
  | "file.metadata_updated"
  | "file.deleted"
  | "customer_tag.created"
  | "customer_tag.deleted"
  | "customer_tag.assigned"
  | "customer_tag.unassigned"
  // Phase 3a
  | "customer_match.confirmed"
  | "customer_match.unlinked"
  // Phase 4a — docs/architecture/ADR-009-OPPORTUNITY-PIPELINE-MODEL.md
  | "opportunity.created"
  | "opportunity.updated"
  | "opportunity.stage_changed"
  | "opportunity.owner_changed"
  | "opportunity.value_changed"
  | "opportunity.won"
  | "opportunity.lost"
  | "opportunity.reopened"
  | "opportunity.archived"
  | "opportunity.external_link_added"
  | "opportunity.external_link_removed";

export type AuditEntityType =
  | "User"
  | "Session"
  | "Note"
  | "Task"
  | "CustomerProfile"
  // Phase 2
  | "TaskComment"
  | "TaskChecklistItem"
  | "Appointment"
  | "File"
  | "CustomerTag"
  // Phase 3a
  | "ExternalContactMatch"
  // Phase 4a
  | "Opportunity"
  | "OpportunityExternalLink";

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
