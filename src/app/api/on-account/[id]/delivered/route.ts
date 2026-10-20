import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireWriteAccess } from "@/platform/auth/guards";
import { toErrorResponse } from "@/lib/api-error";
import { isOnAccountServiceEnabled } from "@/modules/on-account/config";
import { OnAccountActionError, recordManualDelivery } from "@/modules/on-account/on-account.service";

// Op rekening v1 — "Afgeleverd bij klant" (bezorging). Staff confirms the
// real delivery moment; the central service then sets the FIXED term and
// sends the invoice. Audited as on_account.delivery_recorded.
const schema = z.object({ deliveredAt: z.string().datetime({ offset: true }), confirmed: z.literal(true) });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireWriteAccess();
    if (!isOnAccountServiceEnabled()) return NextResponse.json({ error: "Op-rekening-service staat uit in deze omgeving." }, { status: 503 });
    const { id } = await params;
    const body = schema.parse(await request.json());
    const result = await recordManualDelivery(id, new Date(body.deliveredAt), actor.id);
    return NextResponse.json(result, { status: result.outcome === "APPLIED" || result.outcome === "DUPLICATE" ? 200 : 409 });
  } catch (error) {
    if (error instanceof OnAccountActionError) return NextResponse.json({ error: error.message }, { status: error.status });
    return toErrorResponse(error);
  }
}
