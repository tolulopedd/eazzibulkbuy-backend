import { prisma } from './prisma.js';
import { DEFAULT_PICKUP_LOCATIONS } from '../services/pickupLocationService.js';
import { DEFAULT_PRODUCE_ITEMS } from '../services/produceItemService.js';

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
      CREATE TYPE "SalesItemType" AS ENUM ('NORMAL_SALE', 'BUNDLE_DISCOUNTED_SALE');
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END
    $$;
  `);

  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF to_regclass('public.sales_items') IS NOT NULL THEN
        ALTER TABLE "sales_items" ADD COLUMN IF NOT EXISTS "sale_type" "SalesItemType";
        ALTER TABLE "sales_items" ADD COLUMN IF NOT EXISTS "batch_number" TEXT;
        ALTER TABLE "sales_items" ADD COLUMN IF NOT EXISTS "bundle_items_json" JSONB;
        ALTER TABLE "sales_items" ADD COLUMN IF NOT EXISTS "delivery_enabled" BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE "sales_items" ADD COLUMN IF NOT EXISTS "delivery_base_range_max" INTEGER NOT NULL DEFAULT 10;
        ALTER TABLE "sales_items" ADD COLUMN IF NOT EXISTS "delivery_base_price" INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE "sales_items" ADD COLUMN IF NOT EXISTS "delivery_additional_unit_price" INTEGER NOT NULL DEFAULT 0;
        UPDATE "sales_items"
        SET "sale_type" = 'NORMAL_SALE'::"SalesItemType"
        WHERE "sale_type" IS NULL;
        ALTER TABLE "sales_items" ALTER COLUMN "sale_type" SET DEFAULT 'NORMAL_SALE';
        ALTER TABLE "sales_items" ALTER COLUMN "sale_type" SET NOT NULL;
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
        ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "order_sequence" INTEGER;
        ALTER TABLE "orders"
        ADD COLUMN IF NOT EXISTS "fulfillment_method" "FulfillmentMethod" NOT NULL DEFAULT 'PICKUP';
        ALTER TABLE "orders"
        ADD COLUMN IF NOT EXISTS "fulfillment_status" "FulfillmentStatus";
        WITH ranked_orders AS (
          SELECT "id", ROW_NUMBER() OVER (PARTITION BY "sales_item_id" ORDER BY "created_at", "id") AS next_sequence
          FROM "orders"
        )
        UPDATE "orders" AS o
        SET "order_sequence" = ranked_orders.next_sequence
        FROM ranked_orders
        WHERE o."id" = ranked_orders."id"
          AND (o."order_sequence" IS NULL OR o."order_sequence" <> ranked_orders.next_sequence);
        UPDATE "orders"
        SET "order_sequence" = 1
        WHERE "order_sequence" IS NULL;
        ALTER TABLE "orders"
        ALTER COLUMN "order_sequence" SET DEFAULT 1;
        ALTER TABLE "orders"
        ALTER COLUMN "order_sequence" SET NOT NULL;
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
        CREATE UNIQUE INDEX IF NOT EXISTS "orders_sales_item_id_order_sequence_key"
          ON "orders"("sales_item_id", "order_sequence");
      END IF;
    END
    $$;
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "pickup_locations" (
      "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "name" TEXT NOT NULL,
      "is_active" BOOLEAN NOT NULL DEFAULT true,
      "sort_order" INTEGER NOT NULL DEFAULT 0,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "pickup_locations_pkey" PRIMARY KEY ("id")
    );
  `);

  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "pickup_locations_name_key" ON "pickup_locations"("name");
  `);

  for (const location of DEFAULT_PICKUP_LOCATIONS) {
    await prisma.$executeRawUnsafe(`
      INSERT INTO "pickup_locations" ("name", "is_active", "sort_order")
      SELECT $1, true, $2
      WHERE NOT EXISTS (
        SELECT 1
        FROM "pickup_locations"
        WHERE "name" = $1
      );
    `, location.name, location.sortOrder);
  }

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "produce_items" (
      "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "name" TEXT NOT NULL,
      "image_url" TEXT NOT NULL,
      "fallback_url" TEXT,
      "is_active" BOOLEAN NOT NULL DEFAULT true,
      "sort_order" INTEGER NOT NULL DEFAULT 0,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "produce_items_pkey" PRIMARY KEY ("id")
    );
  `);

  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "produce_items_name_key" ON "produce_items"("name");
  `);

  for (const item of DEFAULT_PRODUCE_ITEMS) {
    await prisma.$executeRawUnsafe(`
      INSERT INTO "produce_items" ("name", "image_url", "fallback_url", "is_active", "sort_order")
      SELECT $1, $2, $3, true, $4
      WHERE NOT EXISTS (
        SELECT 1
        FROM "produce_items"
        WHERE "name" = $1
      );
    `, item.name, item.imageUrl, item.fallbackUrl, item.sortOrder);
  }
}
