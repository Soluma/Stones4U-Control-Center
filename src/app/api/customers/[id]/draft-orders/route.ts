import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/platform/auth/guards";
import { prisma } from "@/platform/db/prisma";
import { getShopifyCustomerDraftOrders } from "@/integrations/shopify/draft-orders";
import { isShopifyConfigured } from "@/integrations/shopify/client";
import { toErrorResponse } from "@/lib/api-error";

// Read-only. Same "not configured" / "read for all roles" shape as the
// existing /api/customers/[id]/notes /tasks etc. routes.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await params;

    if (!isShopifyConfigured()) {
      return NextResponse.json({ error: "Shopify is nog niet geconfigureerd.", draftOrders: [] }, { status: 503 });
    }

    const profile = await prisma.customerProfile.findUnique({ where: { id }, select: { shopifyCustomerGid: true } });
    if (!profile) {
      return NextResponse.json({ error: "Klant niet gevonden." }, { status: 404 });
    }

    const result = await getShopifyCustomerDraftOrders(profile.shopifyCustomerGid);
    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
