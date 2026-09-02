import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/platform/auth/guards";
import { searchCustomers } from "@/modules/crm/customer-profile.service";
import { isShopifyConfigured } from "@/integrations/shopify/client";
import { toErrorResponse } from "@/lib/api-error";

// Global command-palette search (Ctrl/Cmd+K). Phase 1 scope: customers only
// (see docs/platform-discovery/25 §1). Deliberately structured as a single
// endpoint returning typed result groups so Phase 2+ can add tasks/notes/
// orders/etc. as additional groups without a breaking response-shape change.
export async function GET(request: NextRequest) {
  try {
    await requireUser();
    const term = request.nextUrl.searchParams.get("q")?.trim() ?? "";

    if (term.length < 2 || !isShopifyConfigured()) {
      return NextResponse.json({ groups: [] });
    }

    const customers = await searchCustomers(term);
    return NextResponse.json({
      groups: [
        {
          key: "customers",
          label: "Klanten",
          items: customers.map((c) => ({
            id: c.customerProfileId ?? c.shopify.gid,
            title: c.shopify.displayName,
            subtitle: [c.shopify.company, c.shopify.email].filter(Boolean).join(" · "),
            shopifyGid: c.shopify.gid,
          })),
        },
      ],
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
