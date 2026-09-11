import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireWriteAccess } from "@/platform/auth/guards";
import { createOrderDeliveryDateHandoffIfEligible } from "@/modules/delivery/order-delivery-request.service";
import { toErrorResponse } from "@/lib/api-error";
import { buildPublicUrl } from "@/lib/public-url";

// Phase 6AI — the eligibility-gated way to ask a customer for a fulfillment
// date.
//
// Deliberately separate from POST /api/delivery-handoffs/order, which is a
// staff OVERRIDE: that route creates a handoff for any readable, uncancelled
// Order because a human decided to. This one asks the decision engine first
// and refuses if the answer is no.
//
// It exists so the manual action and the future automation share one
// implementation. A "test-only" variant would have proven nothing about what
// automation eventually does — which, after this engagement's history, is a
// property worth paying for.
//
// It creates a handoff and nothing else: no email, no notification, no webhook
// registration. None of those exist in this codebase.

const schema = z.object({
  orderGid: z.string().regex(/^gid:\/\/shopify\/Order\/\d+$/, "Ongeldige Order-referentie."),
});

/** Staff-facing Dutch explanation per decision reason. The enum names are
 * internal (and, since 6AH, somewhat historical — see the decision engine's
 * own note on NOT_A_DELIVERY_ORDER); staff should never see them raw. */
const REASON_COPY: Record<string, string> = {
  ORDER_CANCELLED: "Deze bestelling is geannuleerd.",
  ALREADY_HAS_REQUESTED_DELIVERY_DATE: "Voor deze bestelling is al een datum bekend.",
  NO_SHIPPING_ADDRESS: "Deze bestelling heeft geen afleveradres.",
  NOT_A_DELIVERY_ORDER: "Voor deze bestelling hoeft geen datum te worden afgesproken.",
  MANUAL_ONLY_POLICY: "Voor deze klant wordt nooit automatisch een datum gevraagd.",
  WAITING_FOR_PAYMENT: "Deze bestelling is nog niet betaald.",
  INSUFFICIENT_CLASSIFICATION:
    "De afhandeling of het betaalbeleid van deze bestelling is niet vastgesteld. Kies bij de offerte een verzendmethode, of vul het betaalbeleid van de klant in.",
};

export async function POST(request: NextRequest) {
  try {
    const actor = await requireWriteAccess();
    const input = schema.parse(await request.json());

    const result = await createOrderDeliveryDateHandoffIfEligible({
      orderGid: input.orderGid,
      createdById: actor.id,
    });

    if (result.outcome === "ORDER_NOT_READABLE") {
      return NextResponse.json(
        { outcome: result.outcome, message: "Deze bestelling is niet gevonden in Shopify." },
        { status: 404 },
      );
    }

    if (result.outcome === "NOT_ELIGIBLE") {
      // 200, not an error: the question was answered, and the answer is "no".
      return NextResponse.json({
        outcome: result.outcome,
        reason: result.evaluation.decision.reason,
        message: REASON_COPY[result.evaluation.decision.reason] ?? "Deze bestelling komt niet in aanmerking.",
        fulfillmentMode: result.evaluation.customerFacingMode,
      });
    }

    return NextResponse.json({
      outcome: result.outcome,
      id: result.handoff.id,
      status: result.handoff.status,
      fulfillmentMode: result.evaluation.customerFacingMode,
      reason: result.evaluation.decision.reason,
      // Same "returned exactly once" contract as the other creation routes:
      // a reused handoff yields no token, because reusing must never
      // invalidate a link the customer may already hold.
      publicUrl: result.rawToken ? buildPublicUrl(`/delivery/${result.rawToken}`) : null,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
