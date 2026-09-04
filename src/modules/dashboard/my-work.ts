import "server-only";
import { prisma } from "@/platform/db/prisma";
import { listOpportunities } from "@/modules/opportunities/opportunity.service";
import { SEVERITY_RANK } from "@/modules/opportunities/attention";
import type { Role, TaskStatus, CustomerType } from "@/generated/prisma";

// Phase 6A — "Mijn Werk" (docs/platform-discovery/45-PHASE-6A-BUILD-SPEC.md).
// Pure read layer combining Task/Appointment/Opportunity into one personal
// work queue for the dashboard. No mutation, no side effects, no Activity/
// Audit writes, no external calls — every function here reuses an existing,
// already-batched query pattern (Task/Appointment day-boundary scoping from
// task.service.ts's getTaskSummary(); the Phase 4B attention engine via
// listOpportunities(), never recomputed here).
//
// "Mijn Werk" always means the signed-in actor's own work — including for
// ADMIN. There is deliberately no "all users" mode here (build instruction
// §0.3/§4): a team-wide view is an explicit, separate, later feature.

const MY_WORK_CAP = 10;

type Actor = { id: string; role: Role };

type CustomerProfileSummary = { id: string; displayName: string | null; companyName: string | null; customerTypeOverride: CustomerType | null };

const customerProfileSelect = { id: true, displayName: true, companyName: true, customerTypeOverride: true } as const;

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const OPEN_TASK_STATUSES: TaskStatus[] = ["OPEN", "IN_PROGRESS", "WAITING"];

export type MyWorkTaskUrgency = "OVERDUE" | "DUE_TODAY";

export type MyWorkTask = {
  id: string;
  title: string;
  dueAt: Date;
  urgency: MyWorkTaskUrgency;
  customerProfile: CustomerProfileSummary | null;
};

/** Overdue + due-today tasks assigned to the actor. Same day-boundary
 * computation as task.service.ts's getTaskSummary() overdue/dueToday tiles
 * — reused verbatim (server-local Date.setHours(0,0,0,0)), so these numbers
 * can never disagree with the existing dashboard tiles. Tasks without a
 * dueAt are never actionable here (build spec 45 never defines them as
 * such — not invented here either); dueAt: { lt: endOfToday } already
 * excludes them (SQL NULL comparisons are never true). Closed/cancelled
 * tasks are never included. Ordering by dueAt ascending already puts the
 * most overdue task first, then the earliest due-today task — no separate
 * urgency sort needed. */
export async function getMyWorkTasks(actor: Actor, limit = MY_WORK_CAP): Promise<MyWorkTask[]> {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date(startOfToday);
  endOfToday.setDate(endOfToday.getDate() + 1);

  const tasks = await prisma.task.findMany({
    where: {
      assignedToId: actor.id,
      status: { in: OPEN_TASK_STATUSES },
      dueAt: { lt: endOfToday },
    },
    orderBy: { dueAt: "asc" },
    take: limit,
    select: {
      id: true,
      title: true,
      dueAt: true,
      customerProfile: { select: customerProfileSelect },
    },
  });

  return tasks.map((task) => ({
    id: task.id,
    title: task.title,
    dueAt: task.dueAt!,
    urgency: task.dueAt! < startOfToday ? "OVERDUE" : "DUE_TODAY",
    customerProfile: task.customerProfile,
  }));
}

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------

export type MyWorkAppointment = {
  id: string;
  title: string;
  startsAt: Date;
  customerProfile: CustomerProfileSummary | null;
  customerContact: { id: string; displayName: string } | null;
};

/** Today's scheduled appointments assigned to the actor, strictly
 * (build spec 45 defines only "afspraken vandaag" — no fallback to a later
 * date is specified, so none is invented here). Same day-boundary
 * computation as getMyWorkTasks(). */
export async function getMyWorkAppointments(actor: Actor, limit = MY_WORK_CAP): Promise<MyWorkAppointment[]> {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date(startOfToday);
  endOfToday.setDate(endOfToday.getDate() + 1);

  return prisma.appointment.findMany({
    where: {
      assignedToId: actor.id,
      status: "SCHEDULED",
      startsAt: { gte: startOfToday, lt: endOfToday },
    },
    orderBy: { startsAt: "asc" },
    take: limit,
    select: {
      id: true,
      title: true,
      startsAt: true,
      customerProfile: { select: customerProfileSelect },
      customerContact: { select: { id: true, displayName: true } },
    },
  });
}

// ---------------------------------------------------------------------------
// Opportunity attention
// ---------------------------------------------------------------------------

export type MyWorkOpportunity = Awaited<ReturnType<typeof listOpportunities>>[number];

/** Actor-owned OPEN, non-archived opportunities that the existing Phase 4B
 * attention engine has already flagged (severity !== NONE) — reuses
 * listOpportunities() as-is (already the one-batched-groupBy, no-N+1, no
 * per-card external call path); this function only filters/sorts/caps its
 * output, it never recomputes attention itself. Shopify/quote BLUE signals
 * are the same as on the pipeline board: not present here either, since
 * those require a per-opportunity live fetch that only the detail page
 * performs (opportunity.service.ts's own comment on attachAttention()) —
 * not a Phase 6A regression, this list has always excluded them. */
export async function getMyWorkOpportunityAttention(actor: Actor, limit = MY_WORK_CAP): Promise<MyWorkOpportunity[]> {
  const opportunities = await listOpportunities({ ownerUserId: actor.id, status: "OPEN", archived: "exclude" });
  const needsAttention = opportunities.filter(
    (o): o is typeof o & { attention: { severity: keyof typeof SEVERITY_RANK } } => o.attention.severity !== "NONE",
  );
  needsAttention.sort((a, b) => SEVERITY_RANK[b.attention.severity] - SEVERITY_RANK[a.attention.severity]);
  return needsAttention.slice(0, limit);
}
