import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireWriteAccess } from "@/platform/auth/guards";
import { assignTask, updateTaskStatus } from "@/modules/tasks/task.service";
import { toErrorResponse } from "@/lib/api-error";

const patchSchema = z.union([
  z.object({ status: z.enum(["OPEN", "IN_PROGRESS", "WAITING", "DONE", "CANCELLED"]) }),
  z.object({ assignedToId: z.string().min(1) }),
]);

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    // requireWriteAccess (not requireUser) is essential here, not just
    // belt-and-braces: task.service's assertCanModify() only checks
    // creator/assignee/admin, and a VIEWER can legitimately be the
    // assignee of a task (an AGENT can assign a task to anyone). Without
    // this role gate, that VIEWER could mutate a task's status/assignee via
    // a direct API call despite the role being defined as read-only
    // everywhere else — found and fixed during the Phase 1 production
    // readiness review (docs/build/PHASE-1-PRODUCTION-READINESS.md).
    const actor = await requireWriteAccess();
    const { id } = await params;
    const input = patchSchema.parse(await request.json());

    const task =
      "status" in input ? await updateTaskStatus(id, input.status, actor) : await assignTask(id, input.assignedToId, actor);

    return NextResponse.json(task);
  } catch (error) {
    return toErrorResponse(error);
  }
}
