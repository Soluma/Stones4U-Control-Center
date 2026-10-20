import { NextRequest, NextResponse } from "next/server";
import { verifyBearerToken } from "@/platform/security/service-token";
import { isOnAccountServiceEnabled, ON_ACCOUNT_WORKER_TOKEN_ENV } from "@/modules/on-account/config";
import { runOnAccountWorker } from "@/modules/on-account/on-account.service";
import { offerteAppPickupEvents } from "@/modules/on-account/pickup-source";

// Op rekening v1 worker pass — called by a scheduler (Fly scheduled machine /
// cron) with Authorization: Bearer $ON_ACCOUNT_WORKER_TOKEN. Idempotent; safe
// to call as often as you like.
export async function POST(request: NextRequest) {
  if (!verifyBearerToken(request.headers.get("authorization"), ON_ACCOUNT_WORKER_TOKEN_ENV)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isOnAccountServiceEnabled()) {
    return NextResponse.json({ error: "on-account service disabled" }, { status: 503 });
  }
  const result = await runOnAccountWorker({ limit: 25, pickupEvents: offerteAppPickupEvents });
  return NextResponse.json({ advanced: result.advanced.length, polled: result.polled.length, detail: result });
}
