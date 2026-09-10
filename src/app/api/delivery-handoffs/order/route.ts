import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireWriteAccess } from "@/platform/auth/guards";
import { createOrderDeliveryHandoffForStaff } from "@/modules/delivery/delivery-handoff.service";
import { ExistingRequestedDeliveryDateError } from "@/modules/delivery/errors";
import { toErrorResponse } from "@/lib/api-error";
import { buildPublicUrl } from "@/lib/public-url";

// Phase 6E — Order-equivalent of POST /api/delivery-handoffs (the existing
// Draft creation route), deliberately its own route rather than a branch
// added to that one: the two request/validation shapes are genuinely
// different (a Draft handoff accepts an optional client-supplied
// shopifyCustomerGid because the Draft search result already carries it
// trustworthily from Shopify; an Order handoff accepts *only* the selected
// Order's GID (and, when needed, a narrow confirmation flag) — publicReference
// and the customer link are both re-derived server-side from a fresh
// Shopify read, never from the client, see
// createOrderDeliveryHandoffForStaff()'s own doc comment for why).
//
// ADMIN/AGENT only (requireWriteAccess()) — same write-access level as
// every other mutating action in this module.

const createSchema = z.object({
  // The client identifies which Order was selected — nothing else. No
  // publicReference, no customerProfileId, no commerceObjectType: the
  // server derives every trusted field itself from a fresh Shopify read.
  orderGid: z.string().regex(/^gid:\/\/shopify\/Order\/\d+$/, "Ongeldige Order-referentie."),
  // Authorizes exactly one thing — "staff knowingly wants a new handoff
  // even though Shopify already has a requested_delivery_date for this
  // Order" — nothing else. See createOrderDeliveryHandoffForStaff()'s doc
  // comment for the full reasoning (an existing date does not imply
  // customer-portal origin, so this can never be inferred automatically).
  confirmExistingRequestedDeliveryDate: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const actor = await requireWriteAccess();
    const input = createSchema.parse(await request.json());

    const { handoff, rawToken } = await createOrderDeliveryHandoffForStaff({
      orderGid: input.orderGid,
      createdById: actor.id,
      confirmExistingRequestedDeliveryDate: input.confirmExistingRequestedDeliveryDate,
    });

    // Same "rawToken is only ever returned once" contract as the Draft
    // creation route — see that route's own comment for the full reasoning.
    return NextResponse.json({
      id: handoff.id,
      status: handoff.status,
      alreadyExisted: rawToken === null,
      publicUrl: rawToken ? buildPublicUrl(`/delivery/${rawToken}`) : null,
    });
  } catch (error) {
    // A typed confirmation-required response, not a generic error — staff
    // intent is missing, not invalid input. Only safe data goes back:
    // a fixed reason code and the date value itself (already server-read,
    // never client-supplied).
    if (error instanceof ExistingRequestedDeliveryDateError) {
      return NextResponse.json(
        { code: "EXISTING_REQUESTED_DELIVERY_DATE", requestedDeliveryDate: error.requestedDeliveryDate },
        { status: 409 },
      );
    }
    return toErrorResponse(error);
  }
}
