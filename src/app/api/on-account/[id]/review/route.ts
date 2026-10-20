import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/platform/auth/guards";
import { toErrorResponse } from "@/lib/api-error";
import { isOnAccountServiceEnabled } from "@/modules/on-account/config";
import { resolveReview } from "@/modules/on-account/on-account.service";

// Op rekening v1 — leaving MANUAL_REVIEW is always an explicit ADMIN
// decision with a note (audited as on_account.review_resolved).
const schema = z.object({
  resolution: z.enum(["MARK_INVOICE_SENT", "RETRY_INVOICE", "RETRY_FROM_START", "MARK_CANCELLED"]),
  note: z.string().trim().min(3).max(500),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireAdmin();
    if (!isOnAccountServiceEnabled()) return NextResponse.json({ error: "Op-rekening-service staat uit in deze omgeving." }, { status: 503 });
    const { id } = await params;
    const body = schema.parse(await request.json());
    const row = await resolveReview(id, body.resolution, actor.id, body.note);
    return NextResponse.json({ state: row.state });
  } catch (error) {
    if (error instanceof Error && /handmatige controle|intussen gewijzigd|vervaldatum/.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return toErrorResponse(error);
  }
}
