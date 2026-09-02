import { NextResponse } from "next/server";
import { requireUser } from "@/platform/auth/guards";
import { getTaskSummary } from "@/modules/tasks/task.service";
import { toErrorResponse } from "@/lib/api-error";

export async function GET() {
  try {
    const actor = await requireUser();
    const summary = await getTaskSummary(actor);
    return NextResponse.json(summary);
  } catch (error) {
    return toErrorResponse(error);
  }
}
