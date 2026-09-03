import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, requireWriteAccess } from "@/platform/auth/guards";
import { assignTask, updateTaskStatus, getTaskDetail, updateTaskDetails } from "@/modules/tasks/task.service";
import { toErrorResponse } from "@/lib/api-error";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await params;
    const task = await getTaskDetail(id);
    return NextResponse.json(task);
  } catch (error) {
    return toErrorResponse(error);
  }
}

const patchSchema = z.union([
  z.object({ status: z.enum(["OPEN", "IN_PROGRESS", "WAITING", "DONE", "CANCELLED"]) }),
  z.object({ assignedToId: z.string().min(1) }),
  z.object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(5000).nullable().optional(),
    priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).optional(),
    dueAt: z.string().datetime().nullable().optional(),
    reminderAt: z.string().datetime().nullable().optional(),
    tags: z.array(z.string().min(1).max(40)).max(20).optional(),
    customerContactId: z.string().nullable().optional(),
  }),
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

    let task;
    if ("status" in input) {
      task = await updateTaskStatus(id, input.status, actor);
    } else if ("assignedToId" in input) {
      task = await assignTask(id, input.assignedToId, actor);
    } else {
      task = await updateTaskDetails(
        id,
        {
          title: input.title,
          description: input.description,
          priority: input.priority,
          dueAt: input.dueAt === undefined ? undefined : input.dueAt ? new Date(input.dueAt) : null,
          reminderAt: input.reminderAt === undefined ? undefined : input.reminderAt ? new Date(input.reminderAt) : null,
          tags: input.tags,
          customerContactId: input.customerContactId,
        },
        actor,
      );
    }

    return NextResponse.json(task);
  } catch (error) {
    return toErrorResponse(error);
  }
}
