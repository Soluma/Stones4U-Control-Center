import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db/prisma";
import {
  createAppointment,
  updateAppointment,
  completeAppointment,
  cancelAppointment,
  listAppointmentsForCustomer,
  listUpcomingAppointments,
} from "@/modules/appointments/appointment.service";
import { ForbiddenError } from "@/platform/auth/guards";
import { createTestCustomerProfile, createTestUser, cleanupCustomerProfile, cleanupUser } from "./fixtures";

describe("appointment.service", () => {
  let creator: { id: string; role: "AGENT" };
  let assignee: { id: string; role: "AGENT" };
  let bystander: { id: string; role: "AGENT" };
  let admin: { id: string; role: "ADMIN" };
  let customerProfileId: string;
  const userIds: string[] = [];

  beforeAll(async () => {
    const creatorUser = await createTestUser({ role: "AGENT" });
    const assigneeUser = await createTestUser({ role: "AGENT" });
    const bystanderUser = await createTestUser({ role: "AGENT" });
    const adminUser = await createTestUser({ role: "ADMIN" });
    const profile = await createTestCustomerProfile();

    creator = { id: creatorUser.id, role: "AGENT" };
    assignee = { id: assigneeUser.id, role: "AGENT" };
    bystander = { id: bystanderUser.id, role: "AGENT" };
    admin = { id: adminUser.id, role: "ADMIN" };
    customerProfileId = profile.id;
    userIds.push(creatorUser.id, assigneeUser.id, bystanderUser.id, adminUser.id);
  });

  afterAll(async () => {
    await cleanupCustomerProfile(customerProfileId);
    for (const id of userIds) await cleanupUser(id);
    await prisma.$disconnect();
  });

  it("creates an appointment and writes an APPOINTMENT_CREATED activity", async () => {
    const appointment = await createAppointment(
      { customerProfileId, title: "Bezoek showroom", startsAt: new Date(Date.now() + 86_400_000), assignedToId: assignee.id },
      creator,
    );
    expect(appointment.status).toBe("SCHEDULED");

    const activity = await prisma.activity.findFirst({ where: { relatedAppointmentId: appointment.id, type: "APPOINTMENT_CREATED" } });
    expect(activity).not.toBeNull();

    const forCustomer = await listAppointmentsForCustomer(customerProfileId);
    expect(forCustomer.some((a) => a.id === appointment.id)).toBe(true);
  });

  it("lets the assignee complete an appointment and sets completedAt", async () => {
    const appointment = await createAppointment(
      { customerProfileId, title: "Levering bespreken", startsAt: new Date(Date.now() + 86_400_000), assignedToId: assignee.id },
      creator,
    );
    const completed = await completeAppointment(appointment.id, assignee);
    expect(completed.status).toBe("COMPLETED");
    expect(completed.completedAt).not.toBeNull();
  });

  it("lets the creator cancel an appointment", async () => {
    const appointment = await createAppointment(
      { customerProfileId, title: "Te annuleren", startsAt: new Date(Date.now() + 86_400_000), assignedToId: assignee.id },
      creator,
    );
    const cancelled = await cancelAppointment(appointment.id, creator);
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.cancelledAt).not.toBeNull();
  });

  it("forbids an unrelated agent from modifying an appointment", async () => {
    const appointment = await createAppointment(
      { customerProfileId, title: "Privé afspraak", startsAt: new Date(Date.now() + 86_400_000), assignedToId: assignee.id },
      creator,
    );
    await expect(completeAppointment(appointment.id, bystander)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateAppointment(appointment.id, { title: "Gehackt" }, bystander)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("lets an admin modify any appointment regardless of creator/assignee", async () => {
    const appointment = await createAppointment(
      { customerProfileId, title: "Admin-override", startsAt: new Date(Date.now() + 86_400_000), assignedToId: assignee.id },
      creator,
    );
    const updated = await updateAppointment(appointment.id, { title: "Aangepast door admin" }, admin);
    expect(updated.title).toBe("Aangepast door admin");
  });

  it("only surfaces future SCHEDULED appointments assigned to the actor in the upcoming list", async () => {
    await createAppointment(
      { customerProfileId, title: "Toekomstige afspraak", startsAt: new Date(Date.now() + 3_600_000), assignedToId: assignee.id },
      creator,
    );
    const past = await createAppointment(
      { customerProfileId, title: "Verleden afspraak", startsAt: new Date(Date.now() + 3_600_000), assignedToId: assignee.id },
      creator,
    );
    await cancelAppointment(past.id, creator); // cancelled -> must not appear as upcoming

    const upcoming = await listUpcomingAppointments(assignee);
    expect(upcoming.every((a) => a.status === "SCHEDULED")).toBe(true);
    expect(upcoming.some((a) => a.id === past.id)).toBe(false);
    expect(upcoming.every((a) => a.assignedToId === assignee.id)).toBe(true);
  });
});
