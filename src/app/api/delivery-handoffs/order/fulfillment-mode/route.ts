import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, requireWriteAccess } from "@/platform/auth/guards";
import {
  getOrderFulfillmentClassification,
  setOrderFulfillmentModeForStaff,
  clearOrderFulfillmentModeForStaff,
} from "@/modules/delivery/fulfillment-mode.service";
import { FulfillmentModeConfirmationRequiredError } from "@/modules/delivery/errors";
import { EXPLICIT_FULFILLMENT_MODES } from "@/integrations/shopify/fulfillment-contract";
import { toErrorResponse } from "@/lib/api-error";

// Phase 6L — staff inspection and classification of an Order's Stones4U
// fulfillment mode.
//
// GET  — requireUser(): any signed-in staff may inspect a classification,
//        mirroring the read/write split already used by the Order search
//        route next to this one.
// POST — requireWriteAccess(): ADMIN/AGENT only, same level as every other
//        mutating action in this module (VIEWER is refused).
//
// The client sends only the Order GID, the requested mode, and — when
// overwriting an existing choice — an explicit confirmation flag. Everything
// else (current value, native signal, resolved mode, order name) is read
// server-side; see fulfillment-mode.service.ts for why none of it is
// trusted from the client.

const ORDER_GID = z.string().regex(/^gid:\/\/shopify\/Order\/\d+$/, "Ongeldige Order-referentie.");

const bodySchema = z.object({
  orderGid: ORDER_GID,
  // `null` clears the explicit choice. Only canonical values are accepted —
  // "UNKNOWN", a Dutch label, or a lower-cased spelling is rejected here
  // rather than normalized, so a write can never store a non-canonical value
  // (build instruction §8). Read-side tolerance lives in the contract module
  // and deliberately does not apply to writes.
  mode: z.enum(EXPLICIT_FULFILLMENT_MODES).nullable(),
  confirmChange: z.boolean().optional(),
  // Echoed back verbatim from the 409 prompt. Never trusted as truth — the
  // service compares it against its own fresh read so a confirmation can
  // only authorize the exact transition staff were shown.
  expectedCurrentState: z.string().max(64).optional(),
});

export async function GET(request: NextRequest) {
  try {
    await requireUser();
    const orderGid = ORDER_GID.parse(request.nextUrl.searchParams.get("orderGid"));
    return NextResponse.json(await getOrderFulfillmentClassification(orderGid));
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await requireWriteAccess();
    const input = bodySchema.parse(await request.json());

    const result =
      input.mode === null
        ? await clearOrderFulfillmentModeForStaff({
            orderGid: input.orderGid,
            actorId: actor.id,
            confirmChange: input.confirmChange,
            expectedCurrentState: input.expectedCurrentState,
          })
        : await setOrderFulfillmentModeForStaff({
            orderGid: input.orderGid,
            actorId: actor.id,
            mode: input.mode,
            confirmChange: input.confirmChange,
            expectedCurrentState: input.expectedCurrentState,
          });

    return NextResponse.json(result);
  } catch (error) {
    // A typed confirmation-required response, not a generic error: staff
    // intent is missing, not invalid input. Only server-read state is handed
    // back, so the prompt can never be seeded with client-supplied values.
    if (error instanceof FulfillmentModeConfirmationRequiredError) {
      return NextResponse.json(
        {
          code: "FULFILLMENT_MODE_CONFIRMATION_REQUIRED",
          currentMode: error.currentMode,
          currentState: error.currentState,
          requestedMode: error.requestedMode,
          currentStateToken: error.currentStateToken,
        },
        { status: 409 },
      );
    }
    return toErrorResponse(error);
  }
}
