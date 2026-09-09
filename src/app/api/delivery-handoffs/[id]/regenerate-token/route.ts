import { NextResponse } from "next/server";
import { requireWriteAccess } from "@/platform/auth/guards";
import { regeneratePublicToken } from "@/modules/delivery/delivery-handoff.service";
import { toErrorResponse } from "@/lib/api-error";
import { buildPublicUrl } from "@/lib/public-url";

// Phase 5A — token reissue for a lost/unshared link
// (docs/QUOTE-DELIVERY-DATE-MANUAL-ACTIVATION.md §6). ADMIN/AGENT only —
// same write-access level as creation, never the public route.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireWriteAccess();
    const { id } = await params;

    const { handoff, rawToken } = await regeneratePublicToken(id, actor.id);

    return NextResponse.json({
      id: handoff.id,
      publicUrl: buildPublicUrl(`/delivery/${rawToken}`),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
