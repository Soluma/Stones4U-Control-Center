// One-time production/dev bootstrap for the first ADMIN account — no
// credentials are ever committed to git. Mirrors the pattern already proven
// in OfferteApp (prisma/bootstrap-production.ts, see
// docs/platform-discovery/10 §13): refuses to run if ANY User row already
// exists, reads the new admin's email/password from environment variables
// only (never from a CLI argument, which would leak into shell history).
//
// Usage:
//   BOOTSTRAP_ADMIN_EMAIL=... BOOTSTRAP_ADMIN_PASSWORD=... npm run bootstrap:admin

import "dotenv/config";
import { prisma } from "../src/platform/db/prisma";
import { hashPassword, isPasswordStrongEnough } from "../src/platform/auth/password";
import { logAudit } from "../src/platform/audit/audit";

async function main() {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const name = process.env.BOOTSTRAP_ADMIN_NAME?.trim() || "Beheerder";

  if (!email || !password) {
    console.error("BOOTSTRAP_ADMIN_EMAIL en BOOTSTRAP_ADMIN_PASSWORD zijn verplicht (env vars, geen CLI-argumenten).");
    process.exit(1);
  }

  if (!isPasswordStrongEnough(password)) {
    console.error("BOOTSTRAP_ADMIN_PASSWORD moet minimaal 10 tekens zijn.");
    process.exit(1);
  }

  const existingUserCount = await prisma.user.count();
  if (existingUserCount > 0) {
    console.error(
      `Er bestaan al ${existingUserCount} gebruiker(s) — bootstrap wordt geweigerd. Gebruik de admin-UI om extra gebruikers aan te maken.`,
    );
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);
  const admin = await prisma.user.create({
    data: { email, passwordHash, name, role: "ADMIN" },
  });

  await logAudit({
    userId: admin.id,
    action: "user.created",
    entityType: "User",
    entityId: admin.id,
    metadata: { bootstrap: true, role: "ADMIN" },
  });

  console.log(`Eerste ADMIN-account aangemaakt: ${admin.email}`);
}

main()
  .catch((error) => {
    console.error("Bootstrap mislukt:", error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
