import { NextRequest, NextResponse } from "next/server";
import { requireWriteAccess } from "@/platform/auth/guards";
import { removeExternalLink } from "@/modules/opportunities/opportunity.service";
import { toErrorResponse } from "@/lib/api-error";

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string; linkId: string }> }) {
  try {
    const actor = await requireWriteAccess();
    const { id, linkId } = await params;

    await removeExternalLink(id, linkId, actor);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
