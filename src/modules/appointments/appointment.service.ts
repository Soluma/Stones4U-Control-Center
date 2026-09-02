import "server-only";
import { prisma } from "@/platform/db/prisma";
import { logAudit } from "@/platform/audit/audit";
import { ForbiddenError } from "@/platform/auth/guards";
import type { Role } from "@/generated/prisma";

// Central Appointment model (docs/platform-discovery/26 §6). Same
// creator/assignee/admin authorization pattern as Task (ADR-003).

type Actor = { id: string; role: Role };

function assertCanModify(appointment: { assignedToId: string; createdById: string }, actor: Actor) {
  if (actor.role === "ADMIN") return;
  if (actor.id === appointment.assignedToId || actor.id === appointment.createdById) return;
  throw new ForbiddenError("Alleen de toegewezene, aanmaker, of een beheerder mag deze afspraak wijzigen.");
}

const appointmentInclude = {
  assignedTo: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  customerProfile: { select: { id: true, displayName: true, companyName: true } },
} as const;

export async function listAppointmentsForCustomer(customerProfileId: string) {
  return prisma.appointment.findMany({
    where: { customerProfileId },
    orderBy: { startsAt: "desc" },
    include: appointmentInclude,
  });
}

/** Upcoming appointments assigned to the actor (dashboard "komende
 * afspraken") — ADMIN sees everyone's, matching the existing Task-summary
 * convention (task.service.ts getTaskSummary is per-actor too). */
export async function listUpcomingAppointments(actor: Actor, limit = 10) {
  return prisma.appointment.findMany({
    where: {
      status: "SCHEDULED",
      startsAt: { gte: new Date() },
      ...(actor.role === "ADMIN" ? {} : { assignedToId: actor.id }),
    },
    orderBy: { startsAt: "asc" },
    take: limit,
    include: appointmentInclude,
  });
}

export async function createAppointment(
  input: {
    customerProfileId: string;
    title: string;
    description?: string;
    startsAt: Date;
    endsAt?: Date | null;
    assignedToId: string;
  },
  actor: Actor,
) {
  const appointment = await prisma.$transaction(async (tx) => {
    const created = await tx.appointment.create({
      data: {
        customerProfileId: input.customerProfileId,
        title: input.title,
        description: input.description,
        startsAt: input.startsAt,
        endsAt: input.endsAt ?? null,
        assignedToId: input.assignedToId,
        createdById: actor.id,
      },
      include: appointmentInclude,
    });

    await tx.activity.create({
      data: {
        customerProfileId: created.customerProfileId,
        type: "APPOINTMENT_CREATED",
        sourceType: "CONTROL_CENTER",
        title: `Afspraak gepland: ${created.title}`,
        summary: created.startsAt.toISOString(),
        occurredAt: created.createdAt,
        actorId: actor.id,
        relatedAppointmentId: created.id,
      },
    });

    return created;
  });

  await logAudit({ userId: actor.id, action: "appointment.created", entityType: "Appointment", entityId: appointment.id });
  return appointment;
}

export async function updateAppointment(
  appointmentId: string,
  input: { title?: string; description?: string | null; startsAt?: Date; endsAt?: Date | null; assignedToId?: string },
  actor: Actor,
) {
  const appointment = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
  assertCanModify(appointment, actor);

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.appointment.update({ where: { id: appointmentId }, data: input, include: appointmentInclude });

    await tx.activity.create({
      data: {
        customerProfileId: result.customerProfileId,
        type: "APPOINTMENT_UPDATED",
        sourceType: "CONTROL_CENTER",
        title: `Afspraak gewijzigd: ${result.title}`,
        occurredAt: new Date(),
        actorId: actor.id,
        relatedAppointmentId: result.id,
      },
    });

    return result;
  });

  await logAudit({ userId: actor.id, action: "appointment.updated", entityType: "Appointment", entityId: appointmentId, metadata: input });
  return updated;
}

export async function completeAppointment(appointmentId: string, actor: Actor) {
  const appointment = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
  assertCanModify(appointment, actor);

  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.appointment.update({
      where: { id: appointmentId },
      data: { status: "COMPLETED", completedAt: now },
      include: appointmentInclude,
    });

    await tx.activity.create({
      data: {
        customerProfileId: result.customerProfileId,
        type: "APPOINTMENT_COMPLETED",
        sourceType: "CONTROL_CENTER",
        title: `Afspraak voltooid: ${result.title}`,
        occurredAt: now,
        actorId: actor.id,
        relatedAppointmentId: result.id,
      },
    });

    return result;
  });

  await logAudit({ userId: actor.id, action: "appointment.completed", entityType: "Appointment", entityId: appointmentId });
  return updated;
}

export async function cancelAppointment(appointmentId: string, actor: Actor) {
  const appointment = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
  assertCanModify(appointment, actor);

  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.appointment.update({
      where: { id: appointmentId },
      data: { status: "CANCELLED", cancelledAt: now },
      include: appointmentInclude,
    });

    await tx.activity.create({
      data: {
        customerProfileId: result.customerProfileId,
        type: "APPOINTMENT_CANCELLED",
        sourceType: "CONTROL_CENTER",
        title: `Afspraak geannuleerd: ${result.title}`,
        occurredAt: now,
        actorId: actor.id,
        relatedAppointmentId: result.id,
      },
    });

    return result;
  });

  await logAudit({ userId: actor.id, action: "appointment.cancelled", entityType: "Appointment", entityId: appointmentId });
  return updated;
}
