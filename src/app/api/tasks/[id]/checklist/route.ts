import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, requireWriteAccess } from "@/platform/auth/guards";
import { addChecklistItem, getTaskDetail } from "@/modules/tasks/task.service";
import { toErrorResponse } from "@/lib/api-error";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await params;
    const task = await getTaskDetail(id);
    return NextResponse.json({ items: task.checklistItems });
  } catch (error) {
    return toErrorResponse(error);
  }
}

const createItemSchema = z.object({ title: z.string().min(1).max(200) });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireWriteAccess();
    const { id } = await params;
    const input = createItemSchema.parse(await request.json());
    const item = await addChecklistItem(id, input.title, actor);
    return NextResponse.json(item, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
