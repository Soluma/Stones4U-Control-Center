import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, requireWriteAccess } from "@/platform/auth/guards";
import {
  createDeliveryDateHandoff,
  listAllDeliveryDateHandoffs,
  resolveCustomerProfileIdForShopifyGid,
} from "@/modules/delivery/delivery-handoff.service";
import { toErrorResponse } from "@/lib/api-error";
import { buildPublicUrl } from "@/lib/public-url";

// Phase 5A — manual staff activation
// (docs/QUOTE-DELIVERY-DATE-MANUAL-ACTIVATION.md). GET is the read-only
// management listing (any logged-in staff, same requireUser() level as
// the global search); POST is the actual creation (ADMIN/AGENT only,
// requireWriteAccess() — a VIEWER may see the list but never create).

const createSchema = z.object({
  shopifyDraftOrderGid: z.string().min(1),
  // A Shopify Customer GID, not a CustomerProfile.id — the server resolves
  // this to an existing CustomerProfile itself (or leaves the handoff
  // unlinked). Never accept a raw CustomerProfile.id from the client: that
  // would let staff link a handoff to an arbitrary, unrelated customer
  // instead of only the one Shopify itself already associates with this
  // Draft Order.
  shopifyCustomerGid: z.string().min(1).optional(),
});

export async function GET() {
  try {
    await requireUser();
    const handoffs = await listAllDeliveryDateHandoffs();
    return NextResponse.json({ handoffs });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await requireWriteAccess();
    const input = createSchema.parse(await request.json());

    // Read-only lookup — never creates a CustomerProfile (see the
    // function's own doc comment for why).
    const customerProfileId = await resolveCustomerProfileIdForShopifyGid(input.shopifyCustomerGid);

    const { handoff, rawToken } = await createDeliveryDateHandoff({
      shopifyDraftOrderGid: input.shopifyDraftOrderGid,
      customerProfileId,
      createdById: actor.id,
    });

    // rawToken is null when a handoff already existed for this Draft Order
    // (idempotent creation) — the raw token is only ever returned once, at
    // the moment it's first generated (never re-derivable from the stored
    // hash), so a repeat call cannot hand it out again. The client must
    // treat publicUrl: null as "a link already exists — use 'vernieuw
    // link' in the management list to issue a fresh one."
    return NextResponse.json({
      id: handoff.id,
      status: handoff.status,
      alreadyExisted: rawToken === null,
      publicUrl: rawToken ? buildPublicUrl(`/delivery/${rawToken}`) : null,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
