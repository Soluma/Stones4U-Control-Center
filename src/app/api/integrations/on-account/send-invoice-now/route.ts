import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyBearerToken } from "@/platform/security/service-token";
import { isOnAccountServiceEnabled, ON_ACCOUNT_SERVICE_TOKEN_ENV } from "@/modules/on-account/config";
import { requestInvoiceNow } from "@/modules/on-account/on-account.service";

// Op rekening v1 — "Betaallink nu versturen" from OfferteApp. Service-to-
// service only (Authorization: Bearer $ON_ACCOUNT_SERVICE_TOKEN). OfferteApp
// has already checked the employee's permission, the confirmation and
// written its own audit; this endpoint performs the single, idempotent
// action through the central service.

const bodySchema = z.object({
  shopifyOrderGid: z.string().regex(/^gid:\/\/shopify\/Order\/\d+$/),
  requestId: z.string().uuid(),
  requestedBy: z.object({ name: z.string().max(200).nullable().optional(), email: z.string().max(320).nullable().optional() }),
  confirmed: z.literal(true),
});

const STATUS_BY_OUTCOME: Record<string, number> = {
  APPLIED: 200,
  DUPLICATE: 200,
  IGNORED_ALREADY_DELIVERED: 409,
  IGNORED_NOT_ELIGIBLE: 409,
  MANUAL_REVIEW: 409,
  NOT_ON_ACCOUNT: 404,
  ORDER_NOT_FOUND: 404,
};

export async function POST(request: NextRequest) {
  if (!verifyBearerToken(request.headers.get("authorization"), ON_ACCOUNT_SERVICE_TOKEN_ENV)) {
    return NextResponse.json({ error: "unauthorized", code: "UNAUTHORIZED" }, { status: 401 });
  }
  if (!isOnAccountServiceEnabled()) {
    return NextResponse.json({ error: "Op-rekening-service staat uit in deze omgeving.", code: "SERVICE_DISABLED" }, { status: 503 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Ongeldig verzoek.", code: "INVALID_REQUEST" }, { status: 400 });
  }
  const { shopifyOrderGid, requestId, requestedBy } = parsed.data;
  const { outcome, row } = await requestInvoiceNow({
    orderGid: shopifyOrderGid,
    requestId,
    requestedBy: { name: requestedBy.name ?? null, email: requestedBy.email ?? null },
    source: "offerteapp-api",
  });
  const status = STATUS_BY_OUTCOME[outcome] ?? 500;
  return NextResponse.json(
    {
      outcome,
      code: status === 200 ? undefined : outcome,
      state: row?.state ?? null,
      reviewReason: row?.reviewReason ?? null,
      dueAt: row?.dueAt?.toISOString() ?? null,
      invoiceSentAt: row?.invoiceSentAt?.toISOString() ?? null,
      invoiceRecipient: row?.invoiceRecipient ?? null,
      triggerSource: row?.triggerSource ?? null,
    },
    { status },
  );
}
