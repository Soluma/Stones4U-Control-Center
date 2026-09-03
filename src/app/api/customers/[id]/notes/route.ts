import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, requireWriteAccess } from "@/platform/auth/guards";
import { createNote, listNotesForCustomer } from "@/modules/crm/note.service";
import { toErrorResponse } from "@/lib/api-error";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await params;
    const notes = await listNotesForCustomer(id);
    return NextResponse.json({ notes });
  } catch (error) {
    return toErrorResponse(error);
  }
}

const createNoteSchema = z.object({
  bodyPlainText: z.string().min(1).max(20_000),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
  customerContactId: z.string().nullable().optional(),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireWriteAccess();
    const { id } = await params;
    const input = createNoteSchema.parse(await request.json());

    const note = await createNote({
      customerProfileId: id,
      authorId: actor.id,
      bodyPlainText: input.bodyPlainText,
      tags: input.tags,
      customerContactId: input.customerContactId,
    });

    return NextResponse.json(note, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
