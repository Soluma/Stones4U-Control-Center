import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, requireWriteAccess } from "@/platform/auth/guards";
import { createAppointment, listAppointmentsForCustomer } from "@/modules/appointments/appointment.service";
import { toErrorResponse } from "@/lib/api-error";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await params;
    const appointments = await listAppointmentsForCustomer(id);
    return NextResponse.json({ appointments });
  } catch (error) {
    return toErrorResponse(error);
  }
}

const createSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime().optional(),
  assignedToId: z.string().min(1),
  customerContactId: z.string().nullable().optional(),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireWriteAccess();
    const { id } = await params;
    const input = createSchema.parse(await request.json());

    const appointment = await createAppointment(
      {
        customerProfileId: id,
        title: input.title,
        description: input.description,
        startsAt: new Date(input.startsAt),
        endsAt: input.endsAt ? new Date(input.endsAt) : null,
        assignedToId: input.assignedToId,
        customerContactId: input.customerContactId,
      },
      actor,
    );

    return NextResponse.json(appointment, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
