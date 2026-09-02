import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireWriteAccess } from "@/platform/auth/guards";
import { deleteNote, updateNote } from "@/modules/crm/note.service";
import { toErrorResponse } from "@/lib/api-error";

const updateSchema = z.object({
  bodyPlainText: z.string().min(1).max(20_000),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireWriteAccess();
    const { id } = await params;
    const input = updateSchema.parse(await request.json());
    const note = await updateNote(id, input, actor);
    return NextResponse.json(note);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireWriteAccess();
    const { id } = await params;
    await deleteNote(id, actor);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
