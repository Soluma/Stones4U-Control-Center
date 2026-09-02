import { NextResponse } from "next/server";
import { requireUser } from "@/platform/auth/guards";
import { listUpcomingAppointments } from "@/modules/appointments/appointment.service";
import { toErrorResponse } from "@/lib/api-error";

export async function GET() {
  try {
    const actor = await requireUser();
    const appointments = await listUpcomingAppointments(actor);
    return NextResponse.json({ appointments });
  } catch (error) {
    return toErrorResponse(error);
  }
}
