-- AlterEnum
ALTER TYPE "ActivityType" ADD VALUE 'DELIVERY_DATE_REQUESTED';

-- AlterTable
ALTER TABLE "Activity" ADD COLUMN     "relatedDeliveryDateHandoffId" TEXT;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_relatedDeliveryDateHandoffId_fkey" FOREIGN KEY ("relatedDeliveryDateHandoffId") REFERENCES "DeliveryDateHandoff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
