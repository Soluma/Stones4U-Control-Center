import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/platform/auth/guards";
import { listCustomerProfiles, getCustomerListCounts, type CustomerListScope } from "@/modules/crm/customer-profile.service";
import { toErrorResponse } from "@/lib/api-error";

// Phase 6b — local customer list (docs/platform-discovery/48-PHASE-6B-BUILD-SPEC.md).
// Deliberately distinct from /api/customers/search (live Shopify search,
// unchanged): this route only ever lists locally-materialized
// CustomerProfile rows. requireUser()-gated — every role, including
// VIEWER, can already read every customer today (no existing row-level
// restriction, discovery §6), so this list introduces no new restriction
// either.
const VALID_SCOPES: CustomerListScope[] = ["mine", "unassigned", "all"];

export async function GET(request: NextRequest) {
  try {
    const actor = await requireUser();
    const params = request.nextUrl.searchParams;

    const scopeParam = params.get("scope");
    const scope: CustomerListScope = VALID_SCOPES.includes(scopeParam as CustomerListScope) ? (scopeParam as CustomerListScope) : "mine";
    const search = params.get("q")?.trim() || undefined;
    const pageParam = Number(params.get("page"));
    const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;

    const [{ customers, total }, counts] = await Promise.all([
      listCustomerProfiles(actor, { scope, search, page }),
      getCustomerListCounts(actor),
    ]);

    return NextResponse.json({ customers, total, counts, scope, page });
  } catch (error) {
    return toErrorResponse(error);
  }
}
