import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/platform/auth/guards";
import { getSalesDashboardMetrics } from "@/modules/opportunities/dashboard";
import { toErrorResponse } from "@/lib/api-error";

const STAGES = ["NEW", "CONTACTED", "NEEDS_DEFINED", "QUOTE_PREPARATION", "QUOTE_SENT", "NEGOTIATION"] as const;

// Read-only for any authenticated role, including VIEWER (build spec §26:
// "VIEWER: read-only" — the dashboard is a view, not a mutation).
export async function GET(request: NextRequest) {
  try {
    await requireUser();
    const params = request.nextUrl.searchParams;
    const stage = params.get("stage");

    const metrics = await getSalesDashboardMetrics({
      ownerUserId: params.get("ownerUserId") ?? undefined,
      stage: stage && (STAGES as readonly string[]).includes(stage) ? (stage as (typeof STAGES)[number]) : undefined,
    });

    return NextResponse.json(metrics);
  } catch (error) {
    return toErrorResponse(error);
  }
}
