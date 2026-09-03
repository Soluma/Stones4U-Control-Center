-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "customerContactId" TEXT;

-- AlterTable
ALTER TABLE "ExternalContactMatch" ADD COLUMN     "customerContactId" TEXT;

-- AlterTable
ALTER TABLE "Note" ADD COLUMN     "customerContactId" TEXT;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "customerContactId" TEXT;

-- CreateTable
CREATE TABLE "CustomerContact" (
    "id" TEXT NOT NULL,
    "customerProfileId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "jobTitle" TEXT,
    "email" TEXT,
    "emailNormalized" TEXT,
    "phone" TEXT,
    "phoneNormalized" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "isDecisionMaker" BOOLEAN NOT NULL DEFAULT false,
    "isBillingContact" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "CustomerContact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerContact_customerProfileId_idx" ON "CustomerContact"("customerProfileId");

-- CreateIndex
CREATE INDEX "CustomerContact_emailNormalized_idx" ON "CustomerContact"("emailNormalized");

-- CreateIndex
CREATE INDEX "CustomerContact_phoneNormalized_idx" ON "CustomerContact"("phoneNormalized");

-- CreateIndex
CREATE INDEX "CustomerContact_customerProfileId_archivedAt_idx" ON "CustomerContact"("customerProfileId", "archivedAt");

-- CreateIndex
CREATE INDEX "ExternalContactMatch_customerContactId_idx" ON "ExternalContactMatch"("customerContactId");

-- AddForeignKey
ALTER TABLE "CustomerContact" ADD CONSTRAINT "CustomerContact_customerProfileId_fkey" FOREIGN KEY ("customerProfileId") REFERENCES "CustomerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerContact" ADD CONSTRAINT "CustomerContact_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_customerContactId_fkey" FOREIGN KEY ("customerContactId") REFERENCES "CustomerContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_customerContactId_fkey" FOREIGN KEY ("customerContactId") REFERENCES "CustomerContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_customerContactId_fkey" FOREIGN KEY ("customerContactId") REFERENCES "CustomerContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalContactMatch" ADD CONSTRAINT "ExternalContactMatch_customerContactId_fkey" FOREIGN KEY ("customerContactId") REFERENCES "CustomerContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Phase 4C build instruction §3 — hard invariant: at most one ACTIVE
-- (isPrimary = true AND archivedAt IS NULL) CustomerContact per
-- CustomerProfile. The service layer already enforces this inside a
-- $transaction (unset the previous primary, then set the new one), which
-- is race-safe for the normal single-request-at-a-time case, but a
-- transaction alone cannot prevent two truly concurrent requests from each
-- independently deciding "there is currently no active primary, I may set
-- mine" and both committing — the same class of race a `SELECT` followed
-- by an `UPDATE` can never close without a DB-level constraint backing it.
-- This partial unique index is not expressible in Prisma's declarative
-- schema (`@@unique` has no WHERE clause), so it is added here directly.
-- A second, concurrent primary-set now fails at the database with a unique
-- violation instead of silently producing two active primaries — the
-- service layer catches that specific constraint violation and surfaces it
-- as a normal "please retry" validation error, never an unhandled 500.
CREATE UNIQUE INDEX "CustomerContact_one_active_primary_per_customer" ON "CustomerContact"("customerProfileId") WHERE "isPrimary" = true AND "archivedAt" IS NULL;
