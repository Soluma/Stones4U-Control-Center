import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, requireWriteAccess } from "@/platform/auth/guards";
import { createTask, listTasks, type TaskListFilter } from "@/modules/tasks/task.service";
import { toErrorResponse } from "@/lib/api-error";

const FILTERS: TaskListFilter[] = ["mine", "assigned", "created", "overdue", "all"];

export async function GET(request: NextRequest) {
  try {
    const actor = await requireUser();
    const filterParam = request.nextUrl.searchParams.get("filter") ?? "mine";
    const filter = FILTERS.includes(filterParam as TaskListFilter) ? (filterParam as TaskListFilter) : "mine";

    const tasks = await listTasks(actor, filter);
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
  customerProfileId: z.string().optional(),
  customerContactId: z.string().nullable().optional(),
  dueAt: z.string().datetime().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const actor = await requireWriteAccess();
    const input = createTaskSchema.parse(await request.json());

    const task = await createTask(
      {
        title: input.title,
        description: input.description,
        priority: input.priority,
        assignedToId: input.assignedToId,
        customerProfileId: input.customerProfileId,
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
