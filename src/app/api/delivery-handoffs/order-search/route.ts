import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/platform/auth/guards";
import { searchOrdersForHandoff } from "@/integrations/shopify/order-search";
import { prisma } from "@/platform/db/prisma";
import { toErrorResponse } from "@/lib/api-error";

// Phase 6E — Order lookup for the staff "create a delivery date link"
// flow, alongside the existing Draft-order-search route this mirrors.
// Read-only (requireUser() — any logged-in staff, same as the Draft
// search; only the actual creation route requires write access). Never
// mutates Shopify. Joins in `hasExistingHandoff` from the local DB only —
// a plain boolean, never any other local detail about an existing row.
export async function GET(request: NextRequest) {
  try {
    await requireUser();
    const term = request.nextUrl.searchParams.get("q")?.trim() ?? "";
    if (term.length < 2) {
      return NextResponse.json({ results: [] });
    }
    const results = await searchOrdersForHandoff(term);

    const existing = await prisma.deliveryDateHandoff.findMany({
      where: { sourceSystem: "SHOPIFY", externalId: { in: results.map((r) => r.gid) } },
      select: { externalId: true },
    });
    const existingGids = new Set(existing.map((e) => e.externalId));

    return NextResponse.json({
      results: results.map((r) => ({ ...r, hasExistingHandoff: existingGids.has(r.gid) })),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
