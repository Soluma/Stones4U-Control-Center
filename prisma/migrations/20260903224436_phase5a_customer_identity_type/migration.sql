-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('INDIVIDUAL', 'ORGANIZATION');

-- AlterTable
ALTER TABLE "CustomerProfile" ADD COLUMN     "companyNameConfirmed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "customerTypeOverride" "CustomerType";
