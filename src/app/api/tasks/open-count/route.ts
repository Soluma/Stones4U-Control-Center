import { NextResponse } from "next/server";
import { requireUser } from "@/platform/auth/guards";
import { countOpenTasksAssignedTo } from "@/modules/tasks/task.service";
import { toErrorResponse } from "@/lib/api-error";

/** The Taken badge: open tasks assigned to the signed-in user (also ADMIN —
 * their own work, not the team's). One count query. */
export async function GET() {
  try {
    const actor = await requireUser();
    return NextResponse.json({ openAssignedToMe: await countOpenTasksAssignedTo(actor.id) });
  } catch (error) {
    return toErrorResponse(error);
  }
}
