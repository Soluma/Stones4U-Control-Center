import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireWriteAccess } from "@/platform/auth/guards";
import { toggleChecklistItem, removeChecklistItem } from "@/modules/tasks/task.service";
import { toErrorResponse } from "@/lib/api-error";

const patchSchema = z.object({ done: z.boolean() });

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  try {
    const actor = await requireWriteAccess();
    const { id, itemId } = await params;
    const input = patchSchema.parse(await request.json());
    const item = await toggleChecklistItem(id, itemId, input.done, actor);
    return NextResponse.json(item);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  try {
    const actor = await requireWriteAccess();
    const { id, itemId } = await params;
    await removeChecklistItem(id, itemId, actor);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
