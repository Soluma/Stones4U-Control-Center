import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyExtensionSessionToken } from "@/integrations/shopify/extension-session-token";
import {
  readOrderStatusFulfillmentState,
  submitOrderStatusFulfillmentDate,
} from "@/modules/delivery/order-status-extension.service";

// Phase 6AJ — the only endpoints the Shopify Order Status extension talks to.
//
// AUTHENTICATION is the Shopify-signed session token in the Authorization
// header, and nothing else. There is no session cookie, no handoff token, no
// order number and no email address in this route's authorization path.
//
// CORS: customer-account UI extensions run in a sandboxed Web Worker with a
// null origin, so Shopify's own documentation requires
// `Access-Control-Allow-Origin: *` here. That is safe precisely because the
// route carries no cookie-based authority — a wildcard origin grants a
// browser nothing it could not already do by presenting a valid signed token,
// and `credentials` is never used. Never add cookie auth to this route
// without removing the wildcard first.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
} as const;

/** Every response leaves through here, so a future early-return can't
 * accidentally ship without the headers the extension needs. */
function cors(body: unknown, init?: { status?: number }): NextResponse {
  return NextResponse.json(body, { status: init?.status ?? 200, headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

const orderGidSchema = z
  .string()
  .regex(/^gid:\/\/shopify\/Order\/\d+$/, "Ongeldige Order-referentie.");

const submitSchema = z.object({
  orderGid: orderGidSchema,
  requestedDeliveryDate: z.string().optional(),
  deliveryComment: z.string().nullable().optional(),
  largeTruckAccessConfirmed: z.boolean().optional(),
});

/** Rejection reasons are reported to the extension as one opaque state. The
 * extension renders "log in to continue" for NO_CUSTOMER_IDENTITY and a
 * neutral unavailable state for everything else — a caller learns nothing
 * about *why* a signature failed. */
function authFailure(reason: string) {
  if (reason === "NO_CUSTOMER_IDENTITY") {
    return cors({ status: "LOGIN_REQUIRED" }, { status: 401 });
  }
  // Deliberately identical for a bad signature, a wrong audience, a wrong
  // shop and an unconfigured server.
  return cors({ status: "UNAUTHORIZED" }, { status: 401 });
}

export async function GET(request: NextRequest) {
  const verification = verifyExtensionSessionToken(request.headers.get("authorization"));
  if (!verification.ok) {
    // Logged as a category only — never the token, never the claims.
    console.warn("order_status_extension_auth_rejected", verification.reason);
    return authFailure(verification.reason);
  }

  const parsed = orderGidSchema.safeParse(request.nextUrl.searchParams.get("orderGid") ?? "");
  if (!parsed.success) {
    return cors({ status: "UNAVAILABLE", reason: "ORDER_NOT_READABLE" }, { status: 400 });
  }

  const state = await readOrderStatusFulfillmentState({
    orderGid: parsed.data,
    customerGid: verification.claims.customerGid,
  });
  return cors(state);
}

export async function POST(request: NextRequest) {
  const verification = verifyExtensionSessionToken(request.headers.get("authorization"));
  if (!verification.ok) {
    console.warn("order_status_extension_auth_rejected", verification.reason);
    return authFailure(verification.reason);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return cors({ status: "INVALID", message: "Ongeldig verzoek." }, { status: 400 });
  }

  const parsed = submitSchema.safeParse(body);
  if (!parsed.success) {
    return cors({ status: "INVALID", message: "Ongeldig verzoek." }, { status: 400 });
  }

  try {
    const result = await submitOrderStatusFulfillmentDate({
      orderGid: parsed.data.orderGid,
      // From the signature, never from the body. The schema above has no
      // customerGid field at all, so a crafted one cannot even be parsed.
      customerGid: verification.claims.customerGid,
      requestedDeliveryDate: parsed.data.requestedDeliveryDate,
      deliveryComment: parsed.data.deliveryComment,
      largeTruckAccessConfirmed: parsed.data.largeTruckAccessConfirmed,
    });

    if (result.ok) {
      return cors({
        status: "SUBMITTED",
        mode: result.mode,
        requestedDeliveryDate: result.requestedDeliveryDate,
        largeTruckAccessConfirmed: result.largeTruckAccessConfirmed,
      });
    }

    if (result.kind === "INVALID") {
      return cors({ status: "INVALID", message: result.message }, { status: 400 });
    }

    return cors({ status: "UNAVAILABLE", reason: result.reason }, { status: 409 });
  } catch (error) {
    console.error(
      "order_status_extension_submit_failed",
      error instanceof Error ? error.name : "UNKNOWN_ERROR",
    );
    return cors({ status: "ERROR", message: "Er ging iets mis. Probeer het opnieuw." }, { status: 500 });
  }
}
