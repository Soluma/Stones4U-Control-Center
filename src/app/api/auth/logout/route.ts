import { NextResponse } from "next/server";
import { destroySession, sessionCookieOptions, SESSION_COOKIE_NAME } from "@/platform/auth/session";
import { getSessionUser } from "@/platform/auth/session";
import { logAudit } from "@/platform/audit/audit";

export async function POST() {
  const user = await getSessionUser();
  await destroySession();
  if (user) {
    await logAudit({ userId: user.id, action: "auth.logout", entityType: "User", entityId: user.id });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE_NAME, "", { ...sessionCookieOptions(), maxAge: 0 });
  return response;
}
