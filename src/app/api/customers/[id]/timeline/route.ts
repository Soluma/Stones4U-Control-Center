import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/platform/auth/guards";
import { getCustomer360 } from "@/modules/crm/customer-profile.service";
import { getCustomerTimeline } from "@/modules/activity/timeline";
import { normalizeDutchPhone } from "@/lib/phone";
import { toErrorResponse } from "@/lib/api-error";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await params;

    const customer360 = await getCustomer360(id);
    if (!customer360) {
      return NextResponse.json({ error: "Klant niet gevonden." }, { status: 404 });
    }

    const phoneNumbers = [normalizeDutchPhone(customer360.profile.phone)].filter((p): p is string => !!p);

    const items = await getCustomerTimeline(id, {
      shopifyOrders: customer360.orders.orders,
      phoneNumbers,
    });

    return NextResponse.json({ items });
  } catch (error) {
    return toErrorResponse(error);
  }
}
