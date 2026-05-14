import { prisma } from './prisma.js';

export async function ensureDatabaseCompatibility() {
  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF to_regclass('public.users') IS NOT NULL THEN
        ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "title" TEXT;
        ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "first_name" TEXT;
        ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_name" TEXT;
        ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "postal_code" TEXT;
        ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "city" TEXT;
        ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "province" TEXT;
        ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_reset_token_hash" TEXT;
        ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_reset_token_expires_at" TIMESTAMP(3);
      END IF;
    END
    $$;
  `);

  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF to_regclass('public.sales_items') IS NOT NULL THEN
        ALTER TABLE "sales_items" ADD COLUMN IF NOT EXISTS "batch_number" TEXT;
        ALTER TABLE "sales_items" ADD COLUMN IF NOT EXISTS "delivery_enabled" BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE "sales_items" ADD COLUMN IF NOT EXISTS "delivery_base_range_max" INTEGER NOT NULL DEFAULT 10;
        ALTER TABLE "sales_items" ADD COLUMN IF NOT EXISTS "delivery_base_price" INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE "sales_items" ADD COLUMN IF NOT EXISTS "delivery_additional_unit_price" INTEGER NOT NULL DEFAULT 0;
        UPDATE "sales_items"
        SET "batch_number" = 'LEGACY-' || UPPER(SUBSTRING(REPLACE("id"::text, '-', '') FROM 1 FOR 8))
        WHERE "batch_number" IS NULL OR BTRIM("batch_number") = '';
        ALTER TABLE "sales_items" ALTER COLUMN "batch_number" SET NOT NULL;
      END IF;
    END
    $$;
  `);

  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      CREATE TYPE "FulfillmentMethod" AS ENUM ('PICKUP', 'DELIVERY');
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END
    $$;
  `);

  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      CREATE TYPE "FulfillmentStatus" AS ENUM ('PENDING_PICKUP', 'PICKED_UP', 'PENDING_DELIVERY', 'DELIVERED');
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END
    $$;
  `);

  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF to_regclass('public.orders') IS NOT NULL THEN
        ALTER TABLE "orders"
        ADD COLUMN IF NOT EXISTS "fulfillment_method" "FulfillmentMethod" NOT NULL DEFAULT 'PICKUP';
        ALTER TABLE "orders"
        ADD COLUMN IF NOT EXISTS "fulfillment_status" "FulfillmentStatus";
        UPDATE "orders"
        SET "fulfillment_status" = CASE
          WHEN "fulfillment_method" = 'DELIVERY' THEN 'PENDING_DELIVERY'::"FulfillmentStatus"
          ELSE 'PENDING_PICKUP'::"FulfillmentStatus"
        END
        WHERE "fulfillment_status" IS NULL;
        ALTER TABLE "orders"
        ALTER COLUMN "fulfillment_status" SET DEFAULT 'PENDING_PICKUP';
        ALTER TABLE "orders"
        ALTER COLUMN "fulfillment_status" SET NOT NULL;
      END IF;
    END
    $$;
  `);
}
