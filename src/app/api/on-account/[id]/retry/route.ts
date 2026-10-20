import { NextRequest, NextResponse } from "next/server";
import { requireWriteAccess } from "@/platform/auth/guards";
import { toErrorResponse } from "@/lib/api-error";
import { isOnAccountServiceEnabled } from "@/modules/on-account/config";
import { reconcileOnAccountOrder } from "@/modules/on-account/on-account.service";

// Op rekening v1 — "Nu opnieuw proberen": runs the same idempotent step as
// the worker, immediately. Never leaves MANUAL_REVIEW (that is /review).
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireWriteAccess();
    if (!isOnAccountServiceEnabled()) return NextResponse.json({ error: "Op-rekening-service staat uit in deze omgeving." }, { status: 503 });
    const { id } = await params;
    const row = await reconcileOnAccountOrder(id);
    return NextResponse.json({ state: row.state, lastError: row.lastError });
  } catch (error) {
    return toErrorResponse(error);
  }
}
