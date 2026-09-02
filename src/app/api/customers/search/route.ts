import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/platform/auth/guards";
import { searchCustomers } from "@/modules/crm/customer-profile.service";
import { toErrorResponse } from "@/lib/api-error";
import { isShopifyConfigured } from "@/integrations/shopify/client";

export async function GET(request: NextRequest) {
  try {
    await requireUser();

    if (!isShopifyConfigured()) {
      return NextResponse.json(
        { error: "Shopify is nog niet geconfigureerd (zie .env.example).", results: [] },
        { status: 503 },
      );
    }

    const term = request.nextUrl.searchParams.get("q")?.trim() ?? "";
    if (term.length < 2) {
      return NextResponse.json({ results: [] });
    }

    const results = await searchCustomers(term);
    return NextResponse.json({ results });
  } catch (error) {
    return toErrorResponse(error);
  }
}
