import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, requireWriteAccess } from "@/platform/auth/guards";
import { prisma } from "@/platform/db/prisma";
import { updateAppointment, completeAppointment, cancelAppointment } from "@/modules/appointments/appointment.service";
import { toErrorResponse } from "@/lib/api-error";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await params;
    const appointment = await prisma.appointment.findUniqueOrThrow({
      where: { id },
      include: {
        assignedTo: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
        customerProfile: { select: { id: true, displayName: true, companyName: true } },
      },
    });
    return NextResponse.json(appointment);
  } catch (error) {
    return toErrorResponse(error);
  }
}

const patchSchema = z.union([
  z.object({ action: z.literal("complete") }),
  z.object({ action: z.literal("cancel") }),
  z.object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(5000).nullable().optional(),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().nullable().optional(),
    assignedToId: z.string().min(1).optional(),
  }),
]);

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireWriteAccess();
    const { id } = await params;
    const input = patchSchema.parse(await request.json());

    let appointment;
    if ("action" in input && input.action === "complete") {
      appointment = await completeAppointment(id, actor);
    } else if ("action" in input && input.action === "cancel") {
      appointment = await cancelAppointment(id, actor);
    } else if (!("action" in input)) {
      appointment = await updateAppointment(
        id,
        {
          title: input.title,
          description: input.description,
          startsAt: input.startsAt ? new Date(input.startsAt) : undefined,
          endsAt: input.endsAt === undefined ? undefined : input.endsAt ? new Date(input.endsAt) : null,
          assignedToId: input.assignedToId,
        },
        actor,
      );
    }

    return NextResponse.json(appointment);
  } catch (error) {
    return toErrorResponse(error);
  }
}
