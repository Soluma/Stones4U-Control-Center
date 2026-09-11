-- DropForeignKey
ALTER TABLE "DeliveryDateHandoff" DROP CONSTRAINT "DeliveryDateHandoff_createdById_fkey";

-- AlterTable
ALTER TABLE "DeliveryDateHandoff" ALTER COLUMN "createdById" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "DeliveryDateHandoff" ADD CONSTRAINT "DeliveryDateHandoff_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
