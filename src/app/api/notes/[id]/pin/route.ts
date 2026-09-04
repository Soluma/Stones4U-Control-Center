import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireWriteAccess } from "@/platform/auth/guards";
import { pinNote, unpinNote } from "@/modules/crm/note.service";
import { toErrorResponse } from "@/lib/api-error";

const pinSchema = z.object({ isPinned: z.boolean() });

// Phase 6d — a dedicated sub-route, not folded into PATCH /api/notes/[id]:
// that route's schema requires bodyPlainText (a content update), and
// pin/unpin is deliberately not a content change (docs/platform-discovery/
// 54 §4). requireWriteAccess() (ADMIN/AGENT), not an author-only guard —
// any write-capable user may pin/unpin any note (architecture doc §3).
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireWriteAccess();
    const { id } = await params;
    const { isPinned } = pinSchema.parse(await request.json());
    const note = isPinned ? await pinNote(id, actor) : await unpinNote(id, actor);
    return NextResponse.json(note);
  } catch (error) {
    return toErrorResponse(error);
  }
}
