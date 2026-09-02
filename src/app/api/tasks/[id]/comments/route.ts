import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, requireWriteAccess } from "@/platform/auth/guards";
import { addTaskComment, getTaskDetail } from "@/modules/tasks/task.service";
import { toErrorResponse } from "@/lib/api-error";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await params;
    const task = await getTaskDetail(id);
    return NextResponse.json({ comments: task.comments });
  } catch (error) {
    return toErrorResponse(error);
  }
}

const createCommentSchema = z.object({ body: z.string().min(1).max(5000) });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireWriteAccess();
    const { id } = await params;
    const input = createCommentSchema.parse(await request.json());
    const comment = await addTaskComment(id, input.body, actor);
    return NextResponse.json(comment, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
