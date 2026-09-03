import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/platform/auth/guards";
import { syncCustomerIdentityFromShopify } from "@/modules/crm/customer-profile.service";
import { toErrorResponse } from "@/lib/api-error";

const bodySchema = z.object({ shopifyGid: z.string().min(1) });

// Lazily creates (or refreshes) the local CustomerProfile the first time a
// Shopify search result is opened — never on search itself. Dedup is
// guaranteed by the unique constraint on shopifyCustomerGid (see
// customer-profile.service.ts), so re-opening the same customer from
// search never produces a second profile.
export async function POST(request: NextRequest) {
  try {
    await requireUser();
    const { shopifyGid } = bodySchema.parse(await request.json());

    const profile = await syncCustomerIdentityFromShopify(shopifyGid);
    if (!profile) {
      return NextResponse.json({ error: "Shopify-klant niet gevonden." }, { status: 404 });
    }

    return NextResponse.json({ customerProfileId: profile.id });
  } catch (error) {
    return toErrorResponse(error);
  }
}
