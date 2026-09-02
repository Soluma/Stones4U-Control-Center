-- CreateEnum
CREATE TYPE "MatchSource" AS ENUM ('TELEFOONSYSTEEM', 'GMAIL', 'OFFERTEAPP', 'S4U_QUOTE_APP');

-- CreateEnum
CREATE TYPE "MatchMethod" AS ENUM ('PHONE', 'EMAIL', 'SHOPIFY_GID', 'MANUAL');

-- CreateEnum
CREATE TYPE "MatchConfidence" AS ENUM ('EXACT', 'LIKELY', 'MANUAL', 'AMBIGUOUS');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityType" ADD VALUE 'CALL_INBOUND';
ALTER TYPE "ActivityType" ADD VALUE 'CALL_OUTBOUND';
ALTER TYPE "ActivityType" ADD VALUE 'CALL_MISSED';
ALTER TYPE "ActivityType" ADD VALUE 'EMAIL_INBOUND';
ALTER TYPE "ActivityType" ADD VALUE 'EMAIL_OUTBOUND';
ALTER TYPE "ActivityType" ADD VALUE 'QUOTE_CREATED';
ALTER TYPE "ActivityType" ADD VALUE 'QUOTE_UPDATED';
ALTER TYPE "ActivityType" ADD VALUE 'DRAFT_ORDER_CREATED';

-- CreateTable
CREATE TABLE "ExternalContactMatch" (
    "id" TEXT NOT NULL,
    "customerProfileId" TEXT NOT NULL,
    "source" "MatchSource" NOT NULL,
    "externalRef" TEXT NOT NULL,
    "matchedBy" "MatchMethod" NOT NULL,
    "confidence" "MatchConfidence" NOT NULL,
    "confirmedByUserId" TEXT,
    "unlinkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalContactMatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExternalContactMatch_source_externalRef_idx" ON "ExternalContactMatch"("source", "externalRef");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalContactMatch_customerProfileId_source_externalRef_key" ON "ExternalContactMatch"("customerProfileId", "source", "externalRef");

-- AddForeignKey
ALTER TABLE "ExternalContactMatch" ADD CONSTRAINT "ExternalContactMatch_customerProfileId_fkey" FOREIGN KEY ("customerProfileId") REFERENCES "CustomerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalContactMatch" ADD CONSTRAINT "ExternalContactMatch_confirmedByUserId_fkey" FOREIGN KEY ("confirmedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

