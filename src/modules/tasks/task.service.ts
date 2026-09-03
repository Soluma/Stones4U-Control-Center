import "server-only";
import { prisma } from "@/platform/db/prisma";
import { logAudit } from "@/platform/audit/audit";
import { ForbiddenError } from "@/platform/auth/guards";
import { resolveCustomerProfileIdForOpportunity } from "@/modules/opportunities/opportunity.service";
import { assertContactBelongsToCustomer, CustomerContactValidationError } from "@/modules/crm/customer-contact.service";
import type { TaskPriority, TaskStatus, Role } from "@/generated/prisma";

type Actor = { id: string; role: Role };

// Creator/assignee/admin authorization — the one part of TelefoonSysteem's
// Task system discovery found genuinely worth carrying forward as a pattern
// (docs/platform-discovery/21 §3), reimplemented here rather than called
// over the network (docs/architecture/ADR-003).
function assertCanModify(task: { assignedToId: string; createdById: string }, actor: Actor) {
  if (actor.role === "ADMIN") return;
  if (actor.id === task.assignedToId || actor.id === task.createdById) return;
  throw new ForbiddenError("Alleen de toegewezene, aanmaker, of een beheerder mag deze taak wijzigen.");
}

export async function createTask(input: {
  title: string;
  description?: string;
  priority?: TaskPriority;
  assignedToId: string;
  customerProfileId?: string | null;
  // Phase 4a — when set, customerProfileId is ALWAYS derived from the
  // opportunity, never trusted from a caller-supplied value (ADR-009 §5):
  // an opportunity of customer A can never end up attached to a task that
  // also claims customer B.
  opportunityId?: string | null;
  // Phase 4c — optional, same server-verified invariant style as
  // opportunityId above (build spec §20): must belong to the same customer
  // as this task (whether that came from customerProfileId directly or was
  // derived from opportunityId).
  customerContactId?: string | null;
  dueAt?: Date | null;
}, actor: Actor) {
  const customerProfileId = input.opportunityId
    ? await resolveCustomerProfileIdForOpportunity(input.opportunityId)
    : input.customerProfileId ?? null;

  if (input.customerContactId) {
    if (!customerProfileId) throw new CustomerContactValidationError("Een contactpersoon vereist een klantcontext.");
    await assertContactBelongsToCustomer(input.customerContactId, customerProfileId);
  }

  const task = await prisma.$transaction(async (tx) => {
    const created = await tx.task.create({
      data: {
        title: input.title,
        description: input.description,
        priority: input.priority ?? "NORMAL",
        assignedToId: input.assignedToId,
        createdById: actor.id,
        customerProfileId,
        opportunityId: input.opportunityId ?? null,
        customerContactId: input.customerContactId ?? null,
        dueAt: input.dueAt ?? null,
      },
    });

    if (created.customerProfileId) {
      await tx.activity.create({
        data: {
          customerProfileId: created.customerProfileId,
          type: "TASK_CREATED",
          sourceType: "CONTROL_CENTER",
          title: `Taak aangemaakt: ${created.title}`,
          occurredAt: created.createdAt,
          actorId: actor.id,
          relatedTaskId: created.id,
          relatedOpportunityId: created.opportunityId,
        },
      });
    }

    return created;
  });

  await logAudit({ userId: actor.id, action: "task.created", entityType: "Task", entityId: task.id });
  return task;
}

export async function updateTaskStatus(taskId: string, newStatus: TaskStatus, actor: Actor) {
  const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
  assertCanModify(task, actor);

  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.task.update({
      where: { id: taskId },
      data: {
        status: newStatus,
        completedAt: newStatus === "DONE" ? now : task.completedAt,
        cancelledAt: newStatus === "CANCELLED" ? now : task.cancelledAt,
      },
    });

    if (result.customerProfileId) {
      const activityType = newStatus === "DONE" ? "TASK_COMPLETED" : newStatus === "CANCELLED" ? "TASK_CANCELLED" : "TASK_STATUS_CHANGED";
      await tx.activity.create({
        data: {
          customerProfileId: result.customerProfileId,
          type: activityType,
          sourceType: "CONTROL_CENTER",
          title: `Taakstatus gewijzigd: ${result.title}`,
          summary: `${task.status} → ${newStatus}`,
          occurredAt: now,
          actorId: actor.id,
          relatedTaskId: result.id,
          // Phase 4B — ongoing task work on an opportunity-linked task must
          // count toward that opportunity's "last activity" for staleness
          // purposes, not just the task's initial creation.
          relatedOpportunityId: result.opportunityId,
        },
      });
    }

    return result;
  });

  const auditAction = newStatus === "DONE" ? "task.completed" : newStatus === "CANCELLED" ? "task.cancelled" : "task.status_changed";
  await logAudit({
    userId: actor.id,
    action: auditAction,
    entityType: "Task",
    entityId: taskId,
    metadata: { oldStatus: task.status, newStatus },
  });

  return updated;
}

export async function assignTask(taskId: string, newAssigneeId: string, actor: Actor) {
  const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
  assertCanModify(task, actor);

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.task.update({ where: { id: taskId }, data: { assignedToId: newAssigneeId } });

    if (result.customerProfileId) {
      await tx.activity.create({
        data: {
          customerProfileId: result.customerProfileId,
          type: "TASK_ASSIGNED",
          sourceType: "CONTROL_CENTER",
          title: `Taak toegewezen: ${result.title}`,
          occurredAt: new Date(),
          actorId: actor.id,
          relatedTaskId: result.id,
          relatedOpportunityId: result.opportunityId,
        },
      });
    }

    return result;
  });

  await logAudit({
    userId: actor.id,
    action: "task.assigned",
    entityType: "Task",
    entityId: taskId,
    metadata: { oldAssigneeId: task.assignedToId, newAssigneeId },
  });

  return updated;
}

export type TaskListFilter = "mine" | "assigned" | "created" | "overdue" | "all";

export async function listTasks(actor: Actor, filter: TaskListFilter) {
  const openStatuses: TaskStatus[] = ["OPEN", "IN_PROGRESS", "WAITING"];

  if (filter === "all") {
    if (actor.role !== "ADMIN") throw new ForbiddenError("Alleen beheerders kunnen alle taken bekijken.");
    return prisma.task.findMany({ orderBy: { createdAt: "desc" }, take: 100, include: taskListInclude });
  }

  if (filter === "overdue") {
    return prisma.task.findMany({
      where: {
        status: { in: openStatuses },
        dueAt: { lt: new Date() },
        ...(actor.role === "ADMIN" ? {} : { OR: [{ assignedToId: actor.id }, { createdById: actor.id }] }),
      },
      orderBy: { dueAt: "asc" },
      include: taskListInclude,
    });
  }

  if (filter === "assigned") {
    return prisma.task.findMany({
      where: { assignedToId: actor.id, status: { in: openStatuses } },
      orderBy: { dueAt: "asc" },
      include: taskListInclude,
    });
  }

  if (filter === "created") {
    return prisma.task.findMany({
      where: { createdById: actor.id },
      orderBy: { createdAt: "desc" },
      include: taskListInclude,
    });
  }

  // "mine" — assigned to me OR created by me, open only
  return prisma.task.findMany({
    where: { OR: [{ assignedToId: actor.id }, { createdById: actor.id }], status: { in: openStatuses } },
    orderBy: { dueAt: "asc" },
    include: taskListInclude,
  });
}

export async function listTasksForCustomer(customerProfileId: string) {
  return prisma.task.findMany({
    where: { customerProfileId },
    orderBy: { createdAt: "desc" },
    include: taskListInclude,
  });
}

/** Phase 4a — opportunity-scoped tasks for the Opportunity detail page
 * (docs/platform-discovery/33 §build spec). Unlike calls/emails
 * (customer-level only, see the email/telephony adapters), tasks genuinely
 * are opportunity-scoped once opportunityId is set, so a real filter here
 * is honest, not simulated. */
export async function listTasksForOpportunity(opportunityId: string) {
  return prisma.task.findMany({
    where: { opportunityId },
    orderBy: { createdAt: "desc" },
    include: taskListInclude,
  });
}

export async function getTaskSummary(actor: Actor) {
  const openStatuses: TaskStatus[] = ["OPEN", "IN_PROGRESS", "WAITING"];
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date(startOfToday);
  endOfToday.setDate(endOfToday.getDate() + 1);

  const [assignedToMe, createdByMe, overdue, dueToday] = await Promise.all([
    prisma.task.count({ where: { assignedToId: actor.id, status: { in: openStatuses } } }),
    prisma.task.count({ where: { createdById: actor.id, status: { in: openStatuses } } }),
    prisma.task.count({ where: { assignedToId: actor.id, status: { in: openStatuses }, dueAt: { lt: new Date() } } }),
    prisma.task.count({
      where: { assignedToId: actor.id, status: { in: openStatuses }, dueAt: { gte: startOfToday, lt: endOfToday } },
    }),
  ]);

  return { assignedToMe, createdByMe, overdue, dueToday };
}

const taskListInclude = {
  assignedTo: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  customerProfile: { select: { id: true, displayName: true, companyName: true } },
} as const;

// ---------------------------------------------------------------------------
// Phase 2 — Tasks 2.0 (docs/platform-discovery/26 §2)
// ---------------------------------------------------------------------------

const taskDetailInclude = {
  ...taskListInclude,
  comments: { include: { author: { select: { id: true, name: true } } }, orderBy: { createdAt: "asc" as const } },
  checklistItems: { orderBy: { position: "asc" as const } },
} as const;

export async function getTaskDetail(taskId: string) {
  return prisma.task.findUniqueOrThrow({ where: { id: taskId }, include: taskDetailInclude });
}

export async function searchTasks(actor: Actor, query: string, limit = 20) {
  return prisma.task.findMany({
    where: {
      title: { contains: query, mode: "insensitive" },
      ...(actor.role === "ADMIN" ? {} : { OR: [{ assignedToId: actor.id }, { createdById: actor.id }] }),
    },
    orderBy: { updatedAt: "desc" },
    take: limit,
    include: taskListInclude,
  });
}

export async function updateTaskDetails(
  taskId: string,
  input: {
    title?: string;
    description?: string | null;
    priority?: TaskPriority;
    dueAt?: Date | null;
    reminderAt?: Date | null;
    tags?: string[];
    // Phase 4c — optional, same server-verified invariant as createTask's
    // customerContactId (build spec §20).
    customerContactId?: string | null;
  },
  actor: Actor,
) {
  const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
  assertCanModify(task, actor);

  if (input.customerContactId) {
    if (!task.customerProfileId) throw new CustomerContactValidationError("Een contactpersoon vereist een klantcontext.");
    await assertContactBelongsToCustomer(input.customerContactId, task.customerProfileId);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.task.update({ where: { id: taskId }, data: input });

    if (result.customerProfileId) {
      await tx.activity.create({
        data: {
          customerProfileId: result.customerProfileId,
          type: "TASK_UPDATED",
          sourceType: "CONTROL_CENTER",
          title: `Taak bijgewerkt: ${result.title}`,
          occurredAt: new Date(),
          actorId: actor.id,
          relatedTaskId: result.id,
          relatedOpportunityId: result.opportunityId,
        },
      });
    }

    return result;
  });

  await logAudit({ userId: actor.id, action: "task.updated", entityType: "Task", entityId: taskId, metadata: input });
  return updated;
}

export async function addTaskComment(taskId: string, body: string, actor: Actor) {
  const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
  assertCanModify(task, actor);

  const comment = await prisma.$transaction(async (tx) => {
    const created = await tx.taskComment.create({
      data: { taskId, authorId: actor.id, body },
      include: { author: { select: { id: true, name: true } } },
    });

    if (task.customerProfileId) {
      await tx.activity.create({
        data: {
          customerProfileId: task.customerProfileId,
          type: "TASK_COMMENT_ADDED",
          sourceType: "CONTROL_CENTER",
          title: `Opmerking op taak: ${task.title}`,
          summary: truncateText(body, 140),
          occurredAt: created.createdAt,
          actorId: actor.id,
          relatedTaskId: taskId,
          relatedOpportunityId: task.opportunityId,
        },
      });
    }

    return created;
  });

  await logAudit({ userId: actor.id, action: "task.comment_added", entityType: "TaskComment", entityId: comment.id, metadata: { taskId } });
  return comment;
}

export async function addChecklistItem(taskId: string, title: string, actor: Actor) {
  const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
  assertCanModify(task, actor);

  const maxPosition = await prisma.taskChecklistItem.aggregate({ where: { taskId }, _max: { position: true } });
  const item = await prisma.taskChecklistItem.create({
    data: { taskId, title, position: (maxPosition._max.position ?? -1) + 1 },
  });

  await logAudit({
    userId: actor.id,
    action: "task.checklist_item_added",
    entityType: "TaskChecklistItem",
    entityId: item.id,
    metadata: { taskId, title },
  });
  return item;
}

export async function toggleChecklistItem(taskId: string, itemId: string, done: boolean, actor: Actor) {
  const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
  assertCanModify(task, actor);

  const item = await prisma.$transaction(async (tx) => {
    const updated = await tx.taskChecklistItem.update({
      where: { id: itemId },
      data: { done, completedAt: done ? new Date() : null },
    });

    // Only surface a timeline event when the whole checklist becomes fully
    // done — per-item toggles are audited (below) but would be too noisy
    // for the Activity Timeline (docs/platform-discovery/26 §9).
    if (done && task.customerProfileId) {
      const remaining = await tx.taskChecklistItem.count({ where: { taskId, done: false } });
      if (remaining === 0) {
        await tx.activity.create({
          data: {
            customerProfileId: task.customerProfileId,
            type: "TASK_CHECKLIST_COMPLETED",
            sourceType: "CONTROL_CENTER",
            title: `Checklist afgerond: ${task.title}`,
            occurredAt: new Date(),
            actorId: actor.id,
            relatedTaskId: taskId,
            relatedOpportunityId: task.opportunityId,
          },
        });
      }
    }

    return updated;
  });

  await logAudit({
    userId: actor.id,
    action: "task.checklist_item_toggled",
    entityType: "TaskChecklistItem",
    entityId: itemId,
    metadata: { taskId, done },
  });
  return item;
}

export async function removeChecklistItem(taskId: string, itemId: string, actor: Actor) {
  const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
  assertCanModify(task, actor);

  await prisma.taskChecklistItem.delete({ where: { id: itemId } });

  await logAudit({
    userId: actor.id,
    action: "task.checklist_item_removed",
    entityType: "TaskChecklistItem",
    entityId: itemId,
    metadata: { taskId },
  });
}

function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
