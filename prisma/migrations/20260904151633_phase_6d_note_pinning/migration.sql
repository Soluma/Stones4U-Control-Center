-- AlterTable
ALTER TABLE "Note" ADD COLUMN     "isPinned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pinnedAt" TIMESTAMP(3),
ADD COLUMN     "pinnedById" TEXT;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_pinnedById_fkey" FOREIGN KEY ("pinnedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
