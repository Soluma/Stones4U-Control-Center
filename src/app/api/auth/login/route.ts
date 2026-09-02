import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/platform/db/prisma";
import { verifyPassword } from "@/platform/auth/password";
import { createSession, sessionCookieOptions, SESSION_COOKIE_NAME } from "@/platform/auth/session";
import { logAudit } from "@/platform/audit/audit";
import { isRateLimited } from "@/platform/security/rate-limit";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for") ?? "unknown";

  if (isRateLimited(`login:${ip}`)) {
    return NextResponse.json({ error: "Te veel inlogpogingen. Probeer het later opnieuw." }, { status: 429 });
  }

  const parsed = loginSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Ongeldige invoer." }, { status: 400 });
  }

  const email = parsed.data.email.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });

  const passwordOk = user ? await verifyPassword(user.passwordHash, parsed.data.password) : false;

  if (!user || !user.active || !passwordOk) {
    await logAudit({
      userId: user?.id ?? null,
      action: "auth.login_failed",
      entityType: "User",
      entityId: user?.id ?? null,
      ipAddress: ip,
      metadata: { email },
    });
    return NextResponse.json({ error: "Onjuiste combinatie van e-mail en wachtwoord." }, { status: 401 });
  }

  const rawToken = await createSession(user.id, {
    userAgent: request.headers.get("user-agent"),
    ipAddress: ip,
  });

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await logAudit({ userId: user.id, action: "auth.login", entityType: "User", entityId: user.id, ipAddress: ip });

  const response = NextResponse.json({
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  });
  response.cookies.set(SESSION_COOKIE_NAME, rawToken, sessionCookieOptions());
  return response;
}
