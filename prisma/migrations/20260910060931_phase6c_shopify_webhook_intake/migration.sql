-- CreateEnum
CREATE TYPE "ShopifyWebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED');

-- CreateTable
CREATE TABLE "ShopifyWebhookEvent" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "status" "ShopifyWebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "eligible" BOOLEAN,
    "eligibilityReason" TEXT,
    "createdHandoffId" TEXT,
    "errorSummary" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "ShopifyWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShopifyWebhookEvent_status_idx" ON "ShopifyWebhookEvent"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyWebhookEvent_shopDomain_webhookId_key" ON "ShopifyWebhookEvent"("shopDomain", "webhookId");
