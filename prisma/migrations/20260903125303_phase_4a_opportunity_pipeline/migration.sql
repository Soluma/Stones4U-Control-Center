-- CreateEnum
CREATE TYPE "OpportunityStage" AS ENUM ('NEW', 'CONTACTED', 'NEEDS_DEFINED', 'QUOTE_PREPARATION', 'QUOTE_SENT', 'NEGOTIATION');

-- CreateEnum
CREATE TYPE "OpportunityStatus" AS ENUM ('OPEN', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "OpportunityLinkType" AS ENUM ('OFFERTEAPP_QUOTE', 'S4U_QUOTE_APP_QUOTE', 'SHOPIFY_DRAFT_ORDER', 'SHOPIFY_ORDER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityType" ADD VALUE 'OPPORTUNITY_CREATED';
ALTER TYPE "ActivityType" ADD VALUE 'OPPORTUNITY_STAGE_CHANGED';
ALTER TYPE "ActivityType" ADD VALUE 'OPPORTUNITY_WON';
ALTER TYPE "ActivityType" ADD VALUE 'OPPORTUNITY_LOST';
ALTER TYPE "ActivityType" ADD VALUE 'OPPORTUNITY_REOPENED';

-- AlterTable
ALTER TABLE "Activity" ADD COLUMN     "relatedOpportunityId" TEXT;

-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "opportunityId" TEXT;

-- AlterTable
ALTER TABLE "File" ADD COLUMN     "opportunityId" TEXT;

-- AlterTable
ALTER TABLE "Note" ADD COLUMN     "opportunityId" TEXT;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "opportunityId" TEXT;

-- CreateTable
CREATE TABLE "Opportunity" (
    "id" TEXT NOT NULL,
    "customerProfileId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "stage" "OpportunityStage" NOT NULL DEFAULT 'NEW',
    "status" "OpportunityStatus" NOT NULL DEFAULT 'OPEN',
    "estimatedValue" DECIMAL(12,2),
    "finalValue" DECIMAL(12,2),
    "probability" INTEGER,
    "expectedCloseDate" TIMESTAMP(3),
    "ownerUserId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "wonAt" TIMESTAMP(3),
    "lostAt" TIMESTAMP(3),
    "lostReason" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpportunityExternalLink" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "linkType" "OpportunityLinkType" NOT NULL,
    "externalRef" TEXT NOT NULL,
    "linkedById" TEXT NOT NULL,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unlinkedAt" TIMESTAMP(3),

    CONSTRAINT "OpportunityExternalLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Opportunity_customerProfileId_idx" ON "Opportunity"("customerProfileId");

-- CreateIndex
CREATE INDEX "Opportunity_ownerUserId_idx" ON "Opportunity"("ownerUserId");

-- CreateIndex
CREATE INDEX "Opportunity_status_stage_idx" ON "Opportunity"("status", "stage");

-- CreateIndex
CREATE INDEX "Opportunity_expectedCloseDate_idx" ON "Opportunity"("expectedCloseDate");

-- CreateIndex
CREATE INDEX "Opportunity_archivedAt_idx" ON "Opportunity"("archivedAt");

-- CreateIndex
CREATE INDEX "OpportunityExternalLink_linkType_externalRef_idx" ON "OpportunityExternalLink"("linkType", "externalRef");

-- CreateIndex
CREATE UNIQUE INDEX "OpportunityExternalLink_opportunityId_linkType_externalRef_key" ON "OpportunityExternalLink"("opportunityId", "linkType", "externalRef");

-- CreateIndex
CREATE INDEX "Activity_relatedOpportunityId_occurredAt_idx" ON "Activity"("relatedOpportunityId", "occurredAt");

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_relatedOpportunityId_fkey" FOREIGN KEY ("relatedOpportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "File" ADD CONSTRAINT "File_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_customerProfileId_fkey" FOREIGN KEY ("customerProfileId") REFERENCES "CustomerProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityExternalLink" ADD CONSTRAINT "OpportunityExternalLink_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityExternalLink" ADD CONSTRAINT "OpportunityExternalLink_linkedById_fkey" FOREIGN KEY ("linkedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
