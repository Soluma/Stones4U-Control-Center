import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, requireWriteAccess } from "@/platform/auth/guards";
import { createTask, listTasksForCustomer } from "@/modules/tasks/task.service";
import { toErrorResponse } from "@/lib/api-error";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await params;
    const tasks = await listTasksForCustomer(id);
    return NextResponse.json({ tasks });
  } catch (error) {
    return toErrorResponse(error);
  }
}

const createTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).optional(),
  assignedToId: z.string().min(1),
  dueAt: z.string().datetime().optional(),
  // Phase 6c — quick-action prefill (build spec §1.6/§1.4). createTask()
  // already validates this belongs to the same customer
  // (assertContactBelongsToCustomer) — no new guard needed here. Mirrors
  // the sibling opportunities/[id]/tasks route's existing schema shape.
  customerContactId: z.string().nullable().optional(),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireWriteAccess();
    const { id } = await params;
    const input = createTaskSchema.parse(await request.json());

    const task = await createTask(
      {
        title: input.title,
        description: input.description,
        priority: input.priority,
        assignedToId: input.assignedToId,
        customerProfileId: id,
        customerContactId: input.customerContactId,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
      },
      actor,
    );

    return NextResponse.json(task, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
