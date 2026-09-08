-- CreateEnum
CREATE TYPE "QuoteSourceSystem" AS ENUM ('SHOPIFY', 'OFFERTEAPP', 'S4U_QUOTE_APP');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('SHOPIFY', 'MOLLIE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "DeliveryDateHandoffStatus" AS ENUM ('PENDING', 'MIRRORED', 'ERROR');

-- CreateTable
CREATE TABLE "DeliveryDateHandoff" (
    "id" TEXT NOT NULL,
    "publicTokenHash" TEXT NOT NULL,
    "sourceSystem" "QuoteSourceSystem" NOT NULL,
    "externalId" TEXT NOT NULL,
    "shopifyDraftOrderGid" TEXT,
    "customerProfileId" TEXT,
    "requestedDeliveryDate" DATE,
    "paymentProvider" "PaymentProvider" NOT NULL DEFAULT 'UNKNOWN',
    "status" "DeliveryDateHandoffStatus" NOT NULL DEFAULT 'PENDING',
    "lastMirrorAt" TIMESTAMP(3),
    "mirrorErrorCode" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryDateHandoff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryDateHandoff_publicTokenHash_key" ON "DeliveryDateHandoff"("publicTokenHash");

-- CreateIndex
CREATE INDEX "DeliveryDateHandoff_customerProfileId_idx" ON "DeliveryDateHandoff"("customerProfileId");

-- CreateIndex
CREATE INDEX "DeliveryDateHandoff_shopifyDraftOrderGid_idx" ON "DeliveryDateHandoff"("shopifyDraftOrderGid");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryDateHandoff_sourceSystem_externalId_key" ON "DeliveryDateHandoff"("sourceSystem", "externalId");

-- AddForeignKey
ALTER TABLE "DeliveryDateHandoff" ADD CONSTRAINT "DeliveryDateHandoff_customerProfileId_fkey" FOREIGN KEY ("customerProfileId") REFERENCES "CustomerProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryDateHandoff" ADD CONSTRAINT "DeliveryDateHandoff_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
