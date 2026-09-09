-- CreateEnum
CREATE TYPE "DeliveryCommerceObjectType" AS ENUM ('SHOPIFY_DRAFT_ORDER', 'SHOPIFY_ORDER');

-- AlterTable
ALTER TABLE "DeliveryDateHandoff" ADD COLUMN     "commerceObjectType" "DeliveryCommerceObjectType" NOT NULL DEFAULT 'SHOPIFY_DRAFT_ORDER',
ADD COLUMN     "publicReference" TEXT,
ADD COLUMN     "shopifyOrderGid" TEXT;
