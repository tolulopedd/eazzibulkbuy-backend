/*
  Warnings:

  - A unique constraint covering the columns `[orderReference]` on the table `Order` will be added. If there are existing duplicate values, this will fail.
  - The required column `orderReference` was added to the `Order` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.

*/
-- CreateEnum
CREATE TYPE "SalesItemStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'CONFIRMED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PaymentStatus" ADD VALUE 'PENDING_PAYMENT';
ALTER TYPE "PaymentStatus" ADD VALUE 'PAID';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "orderReference" TEXT,
ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'REQUIRES_ACTION',
ADD COLUMN     "quantity" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "salesItemId" TEXT,
ADD COLUMN     "unitPrice" INTEGER NOT NULL DEFAULT 0;

-- Backfill existing orders before enforcing NOT NULL + UNIQUE
UPDATE "Order" SET "orderReference" = "id" WHERE "orderReference" IS NULL;
ALTER TABLE "Order" ALTER COLUMN "orderReference" SET NOT NULL;

-- CreateTable
CREATE TABLE "SalesItem" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "pricePerUnit" INTEGER NOT NULL,
    "status" "SalesItemStatus" NOT NULL DEFAULT 'ACTIVE',
    "closingDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Order_orderReference_key" ON "Order"("orderReference");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_salesItemId_fkey" FOREIGN KEY ("salesItemId") REFERENCES "SalesItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
