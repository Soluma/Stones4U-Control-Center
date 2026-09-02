import "server-only";
import { prisma } from "@/platform/db/prisma";
import { logAudit } from "@/platform/audit/audit";
import { ForbiddenError } from "@/platform/auth/guards";
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
  dueAt?: Date | null;
}, actor: Actor) {
  const task = await prisma.$transaction(async (tx) => {
    const created = await tx.task.create({
      data: {
        title: input.title,
        description: input.description,
        priority: input.priority ?? "NORMAL",
        assignedToId: input.assignedToId,
        createdById: actor.id,
        customerProfileId: input.customerProfileId ?? null,
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
