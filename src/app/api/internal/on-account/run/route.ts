import { NextRequest, NextResponse } from "next/server";
import { verifyBearerToken } from "@/platform/security/service-token";
import { isOnAccountServiceEnabled, ON_ACCOUNT_WORKER_TOKEN_ENV } from "@/modules/on-account/config";
import { runScheduledOnAccountPass } from "@/modules/on-account/scheduler";
import { offerteAppPickupEvents } from "@/modules/on-account/pickup-source";

// Op rekening v1 worker pass — called by the in-process scheduler
// (src/instrumentation.ts) and, if needed, by hand, with
// Authorization: Bearer $ON_ACCOUNT_WORKER_TOKEN. One pass at a time across
// all machines (advisory lock); a concurrent call gets SKIPPED_LOCKED.
export async function POST(request: NextRequest) {
  if (!verifyBearerToken(request.headers.get("authorization"), ON_ACCOUNT_WORKER_TOKEN_ENV)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isOnAccountServiceEnabled()) {
    return NextResponse.json({ error: "on-account service disabled" }, { status: 503 });
  }
  const trigger = request.headers.get("x-on-account-trigger") === "scheduler" ? "scheduler" : "manual";
  const result = await runScheduledOnAccountPass({ trigger, pickupEvents: offerteAppPickupEvents });
  return NextResponse.json(result, { status: result.status === "FAILED" ? 500 : 200 });
}
