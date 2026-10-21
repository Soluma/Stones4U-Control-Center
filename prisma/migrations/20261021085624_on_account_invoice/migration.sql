-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OnAccountState" ADD VALUE 'INVOICE_GENERATING';
ALTER TYPE "OnAccountState" ADD VALUE 'INVOICE_READY';

-- AlterTable
ALTER TABLE "OnAccountOrder" ADD COLUMN     "invoiceGeneratingAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "OnAccountInvoice" (
    "id" TEXT NOT NULL,
    "onAccountOrderId" TEXT NOT NULL,
    "shopifyOrderGid" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "shopifyOrderName" TEXT NOT NULL,
    "invoiceDate" TEXT NOT NULL,
    "deliveredAt" TIMESTAMP(3) NOT NULL,
    "termDays" INTEGER NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "currency" TEXT NOT NULL,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "taxAmount" DECIMAL(12,2) NOT NULL,
    "outstandingAmount" DECIMAL(12,2) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "snapshotSha256" TEXT NOT NULL,
    "pdfSha256" TEXT NOT NULL,
    "pdfSize" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sendKey" TEXT NOT NULL,
    "mailRecipient" TEXT,
    "mailMessageId" TEXT,
    "sentAt" TIMESTAMP(3),
    "mailSuppressedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnAccountInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OnAccountInvoice_onAccountOrderId_key" ON "OnAccountInvoice"("onAccountOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "OnAccountInvoice_shopifyOrderGid_key" ON "OnAccountInvoice"("shopifyOrderGid");

-- CreateIndex
CREATE UNIQUE INDEX "OnAccountInvoice_invoiceNumber_key" ON "OnAccountInvoice"("invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "OnAccountInvoice_sendKey_key" ON "OnAccountInvoice"("sendKey");

-- AddForeignKey
ALTER TABLE "OnAccountInvoice" ADD CONSTRAINT "OnAccountInvoice_onAccountOrderId_fkey" FOREIGN KEY ("onAccountOrderId") REFERENCES "OnAccountOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
