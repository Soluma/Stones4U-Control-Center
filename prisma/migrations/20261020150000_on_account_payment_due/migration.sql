-- Op rekening v1 (docs/ON-ACCOUNT-PAYMENT-DUE.md). Purely additive: two new
-- enums and two new tables; no existing table, column or row is touched.

-- CreateEnum
CREATE TYPE "OnAccountState" AS ENUM ('REGISTERED', 'PENDING_TEMP_TERMS', 'WAITING_FOR_DELIVERY', 'DELIVERED', 'TERMS_SET', 'INVOICE_SENDING', 'INVOICE_SENT', 'PAID', 'CANCELLED', 'MANUAL_REVIEW');

-- CreateEnum
CREATE TYPE "OnAccountTriggerSource" AS ENUM ('COUNTER_HANDOVER', 'PICKUP_HANDOVER', 'MANUAL_DELIVERY', 'MANUAL_INVOICE');

-- CreateTable
CREATE TABLE "OnAccountOrder" (
    "id" TEXT NOT NULL,
    "shopifyOrderGid" TEXT NOT NULL,
    "orderName" TEXT,
    "sourceApp" TEXT NOT NULL,
    "termDays" INTEGER,
    "state" "OnAccountState" NOT NULL DEFAULT 'REGISTERED',
    "reviewReason" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "triggerSource" "OnAccountTriggerSource",
    "triggerEventId" TEXT,
    "deliveredByUserId" TEXT,
    "dueAt" TIMESTAMP(3),
    "paymentTermsId" TEXT,
    "termsSetAt" TIMESTAMP(3),
    "invoiceSendingAt" TIMESTAMP(3),
    "invoiceSentAt" TIMESTAMP(3),
    "invoiceRecipient" TEXT,
    "paidAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnAccountOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnAccountEvent" (
    "id" TEXT NOT NULL,
    "onAccountOrderId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "outcome" TEXT NOT NULL,
    "actorUserId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OnAccountEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OnAccountOrder_shopifyOrderGid_key" ON "OnAccountOrder"("shopifyOrderGid");

-- CreateIndex
CREATE INDEX "OnAccountOrder_state_nextAttemptAt_idx" ON "OnAccountOrder"("state", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "OnAccountEvent_onAccountOrderId_idx" ON "OnAccountEvent"("onAccountOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "OnAccountEvent_source_eventKey_key" ON "OnAccountEvent"("source", "eventKey");

-- AddForeignKey
ALTER TABLE "OnAccountEvent" ADD CONSTRAINT "OnAccountEvent_onAccountOrderId_fkey" FOREIGN KEY ("onAccountOrderId") REFERENCES "OnAccountOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

