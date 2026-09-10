import { NextRequest, NextResponse } from "next/server";
import { getHandoffByRawToken, submitRequestedDeliveryDate, submitRequestedDeliveryDateForOrder } from "@/modules/delivery/delivery-handoff.service";
import { DeliveryHandoffError } from "@/modules/delivery/errors";
import type { DeliveryDateSubmitResponse } from "@/modules/delivery/submit-response";

// Public, unauthenticated POST — same authorization model as the page
// (opaque token only, no session). No CSRF-token library is used anywhere
// in this app (confirmed during discovery — no middleware, no "csrf"
// reference in src/); this route has no session-bound privilege to protect
// against session-riding CSRF in the first place, since the sole authority
// is the token in the URL itself, not a cookie. The redirect target is
// always server-resolved (submitRequestedDeliveryDate/resolvePaymentTarget)
// — nothing in the request body ever influences it.
//
// Phase 6D — the request body is read for exactly one field,
// `requestedDeliveryDate`. There is no `commerceObjectType`/`type`/
// `orderGid`/`draftOrderGid`/`shopDomain`/`redirectUrl`/`paymentTarget`
// field anywhere in the parsed body, and none is ever read from it — the
// handoff's persisted `commerceObjectType` (resolved server-side from the
// token above, never client-supplied) is the sole dispatch authority
// between the Draft and Order submission services. No GID string-sniffing
// of any kind. An unrecognized commerceObjectType (none exists today; this
// guards a future enum value with no matching branch here) fails closed
// with a generic error, never a silent fallback to either service.

type RouteParams = { params: Promise<{ token: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { token } = await params;
  const handoff = await getHandoffByRawToken(token);
  if (!handoff) {
    return NextResponse.json({ error: "Niet gevonden." }, { status: 404 });
  }

  // Phase 6P — two optional Order-flow fields join the date. Still no
  // commerceObjectType/GID/shop/redirect field is ever read from the body:
  // the persisted handoff remains the sole dispatch authority.
  let body: {
    requestedDeliveryDate?: string;
    deliveryComment?: string | null;
    largeTruckAccessConfirmed?: unknown;
  } = {};
  try {
    body = await request.json();
  } catch {
    // fall through — validateRequestedDeliveryDate() rejects the resulting undefined input cleanly
  }

  try {
    if (handoff.commerceObjectType === "SHOPIFY_DRAFT_ORDER") {
      const result = await submitRequestedDeliveryDate(handoff, {
        rawDateInput: body.requestedDeliveryDate,
        deliveryComment: body.deliveryComment,
        largeTruckAccessConfirmed: body.largeTruckAccessConfirmed,
      });
      const response: DeliveryDateSubmitResponse = { outcome: "REDIRECT", redirectUrl: result.redirectUrl };
      return NextResponse.json(response);
    }

    if (handoff.commerceObjectType === "SHOPIFY_ORDER") {
      const result = await submitRequestedDeliveryDateForOrder(handoff, {
        rawDateInput: body.requestedDeliveryDate,
        deliveryComment: body.deliveryComment,
        largeTruckAccessConfirmed: body.largeTruckAccessConfirmed,
      });
      const response: DeliveryDateSubmitResponse = {
        outcome: "COMPLETED",
        requestedDeliveryDate: result.requestedDeliveryDate,
        largeTruckAccessConfirmed: result.largeTruckAccessConfirmed,
      };
      return NextResponse.json(response);
    }

    console.error("delivery_handoff_unsupported_commerce_object_type", handoff.commerceObjectType);
    return NextResponse.json({ error: "Er ging iets mis. Probeer het opnieuw." }, { status: 500 });
  } catch (error) {
    if (error instanceof DeliveryHandoffError) {
      return NextResponse.json({ error: error.message, retryable: error.retryable }, { status: 400 });
    }
    console.error("delivery_handoff_submit_failed", error);
    return NextResponse.json({ error: "Er ging iets mis. Probeer het opnieuw." }, { status: 500 });
  }
}
