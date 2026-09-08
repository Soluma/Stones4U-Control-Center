import { NextRequest, NextResponse } from "next/server";
import { getHandoffByRawToken, submitRequestedDeliveryDate } from "@/modules/delivery/delivery-handoff.service";
import { DeliveryHandoffError } from "@/modules/delivery/errors";

// Public, unauthenticated POST — same authorization model as the page
// (opaque token only, no session). No CSRF-token library is used anywhere
// in this app (confirmed during discovery — no middleware, no "csrf"
// reference in src/); this route has no session-bound privilege to protect
// against session-riding CSRF in the first place, since the sole authority
// is the token in the URL itself, not a cookie. The redirect target is
// always server-resolved (submitRequestedDeliveryDate/resolvePaymentTarget)
// — nothing in the request body ever influences it.

type RouteParams = { params: Promise<{ token: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { token } = await params;
  const handoff = await getHandoffByRawToken(token);
  if (!handoff) {
    return NextResponse.json({ error: "Niet gevonden." }, { status: 404 });
  }

  let body: { requestedDeliveryDate?: string } = {};
  try {
    body = await request.json();
  } catch {
    // fall through — parseRequestedDeliveryDate() rejects the resulting undefined input cleanly
  }

  try {
    const result = await submitRequestedDeliveryDate(handoff, body.requestedDeliveryDate);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof DeliveryHandoffError) {
      return NextResponse.json({ error: error.message, retryable: error.retryable }, { status: 400 });
    }
    console.error("delivery_handoff_submit_failed", error);
    return NextResponse.json({ error: "Er ging iets mis. Probeer het opnieuw." }, { status: 500 });
  }
}
