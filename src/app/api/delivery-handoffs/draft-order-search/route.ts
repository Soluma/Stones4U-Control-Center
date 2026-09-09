import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/platform/auth/guards";
import { searchDraftOrdersForHandoff } from "@/integrations/shopify/order-search";
import { toErrorResponse } from "@/lib/api-error";

// Phase 5A — Draft Order lookup for the "create a delivery date link"
// staff flow (docs/QUOTE-DELIVERY-DATE-MANUAL-ACTIVATION.md §2). Read-only
// (requireUser() — any logged-in staff, same as the global search; only
// the actual creation below requires write access). Never mutates
// Shopify.
export async function GET(request: NextRequest) {
  try {
    await requireUser();
    const term = request.nextUrl.searchParams.get("q")?.trim() ?? "";
    if (term.length < 2) {
      return NextResponse.json({ results: [] });
    }
    const results = await searchDraftOrdersForHandoff(term);
    return NextResponse.json({ results });
  } catch (error) {
    return toErrorResponse(error);
  }
}
