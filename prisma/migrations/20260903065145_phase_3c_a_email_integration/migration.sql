-- CreateEnum
CREATE TYPE "EmailProvider" AS ENUM ('MICROSOFT365', 'IMAP');

-- AlterEnum
ALTER TYPE "MatchSource" ADD VALUE 'EMAIL';

-- CreateTable
CREATE TABLE "MonitoredMailbox" (
    "id" TEXT NOT NULL,
    "emailAddress" TEXT NOT NULL,
    "displayName" TEXT,
    "provider" "EmailProvider" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonitoredMailbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MonitoredMailbox_emailAddress_key" ON "MonitoredMailbox"("emailAddress");
