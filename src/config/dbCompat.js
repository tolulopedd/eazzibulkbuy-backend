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
    CREATE TABLE IF NOT EXISTS "customer_audit_logs" (
      "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "user_id" TEXT NOT NULL,
      "action" TEXT NOT NULL,
      "before_json" JSONB,
      "after_json" JSONB,
      "changed_by_user_id" TEXT,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "customer_audit_logs_pkey" PRIMARY KEY ("id")
    );
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "customer_audit_logs_user_id_idx" ON "customer_audit_logs"("user_id");
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "customer_audit_logs_changed_by_user_id_idx" ON "customer_audit_logs"("changed_by_user_id");
  `);

  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      ALTER TABLE "customer_audit_logs"
      ADD CONSTRAINT "customer_audit_logs_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END
    $$;
  `);

  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      ALTER TABLE "customer_audit_logs"
      ADD CONSTRAINT "customer_audit_logs_changed_by_user_id_fkey"
      FOREIGN KEY ("changed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END
    $$;
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "customer_notes" (
      "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "user_id" TEXT NOT NULL,
      "order_id" TEXT,
      "order_references" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      "source" TEXT NOT NULL DEFAULT 'ADMIN',
      "note" TEXT NOT NULL,
      "message_type" TEXT,
      "created_by_user_id" TEXT,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "customer_notes_pkey" PRIMARY KEY ("id")
    );
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "customer_notes"
    ADD COLUMN IF NOT EXISTS "order_references" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "customer_notes"
    ADD COLUMN IF NOT EXISTS "read_at" TIMESTAMP(3);
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "customer_notes"
    ADD COLUMN IF NOT EXISTS "read_by_user_id" TEXT;
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "customer_notes_user_id_idx" ON "customer_notes"("user_id");
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "customer_notes_order_id_idx" ON "customer_notes"("order_id");
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "customer_notes_created_by_user_id_idx" ON "customer_notes"("created_by_user_id");
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "customer_notes_source_read_at_created_at_idx" ON "customer_notes"("source", "read_at", "created_at");
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "customer_notes_read_by_user_id_idx" ON "customer_notes"("read_by_user_id");
  `);

  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      ALTER TABLE "customer_notes"
      ADD CONSTRAINT "customer_notes_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END
    $$;
  `);

  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      ALTER TABLE "customer_notes"
      ADD CONSTRAINT "customer_notes_order_id_fkey"
      FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END
    $$;
  `);

  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      ALTER TABLE "customer_notes"
      ADD CONSTRAINT "customer_notes_created_by_user_id_fkey"
      FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END
    $$;
  `);

  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      ALTER TABLE "customer_notes"
      ADD CONSTRAINT "customer_notes_read_by_user_id_fkey"
      FOREIGN KEY ("read_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
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
	        ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "store_credit_applied" INTEGER NOT NULL DEFAULT 0;
	        ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "amount_due" INTEGER NOT NULL DEFAULT 0;
	        UPDATE "orders"
	        SET "amount_due" = "total_amount"
	        WHERE "amount_due" = 0;
	        ALTER TABLE "orders"
	        ADD COLUMN IF NOT EXISTS "fulfillment_method" "FulfillmentMethod" NOT NULL DEFAULT 'PICKUP';
        ALTER TABLE "orders"
        ADD COLUMN IF NOT EXISTS "fulfillment_status" "FulfillmentStatus";
        WITH existing_sequences AS (
          SELECT
            "sales_item_id",
            COALESCE(MAX("order_sequence"), 0) AS max_sequence
          FROM "orders"
          WHERE "order_sequence" IS NOT NULL
          GROUP BY "sales_item_id"
        ),
        missing_sequences AS (
          SELECT
            o."id",
            COALESCE(existing_sequences.max_sequence, 0)
              + ROW_NUMBER() OVER (PARTITION BY o."sales_item_id" ORDER BY o."created_at", o."id") AS next_sequence
          FROM "orders" AS o
          LEFT JOIN existing_sequences ON existing_sequences."sales_item_id" = o."sales_item_id"
          WHERE o."order_sequence" IS NULL
        )
        UPDATE "orders" AS o
        SET "order_sequence" = missing_sequences.next_sequence
        FROM missing_sequences
        WHERE o."id" = missing_sequences."id";
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
	    DO $$
	    BEGIN
	      CREATE TYPE "StoreCreditLedgerType" AS ENUM ('CREDIT_ISSUED', 'CREDIT_USED', 'CREDIT_REVERSED');
	    EXCEPTION
	      WHEN duplicate_object THEN NULL;
	    END
	    $$;
	  `);

	  await prisma.$executeRawUnsafe(`
	    CREATE TABLE IF NOT EXISTS "store_credit_ledger" (
	      "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
	      "user_id" TEXT NOT NULL,
	      "order_id" TEXT,
	      "source_order_id" TEXT,
	      "amount" INTEGER NOT NULL,
	      "type" "StoreCreditLedgerType" NOT NULL,
	      "note" TEXT,
	      "created_by_user_id" TEXT,
	      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	      CONSTRAINT "store_credit_ledger_pkey" PRIMARY KEY ("id")
	    );
	  `);

	  await prisma.$executeRawUnsafe(`
	    CREATE INDEX IF NOT EXISTS "store_credit_ledger_user_id_idx" ON "store_credit_ledger"("user_id");
	  `);

	  await prisma.$executeRawUnsafe(`
	    CREATE INDEX IF NOT EXISTS "store_credit_ledger_order_id_idx" ON "store_credit_ledger"("order_id");
	  `);

	  await prisma.$executeRawUnsafe(`
	    CREATE INDEX IF NOT EXISTS "store_credit_ledger_source_order_id_idx" ON "store_credit_ledger"("source_order_id");
	  `);

	  await prisma.$executeRawUnsafe(`
	    DO $$
	    BEGIN
	      ALTER TABLE "store_credit_ledger"
	      ADD CONSTRAINT "store_credit_ledger_user_id_fkey"
	      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
	    EXCEPTION
	      WHEN duplicate_object THEN NULL;
	    END
	    $$;
	  `);

	  await prisma.$executeRawUnsafe(`
	    DO $$
	    BEGIN
	      ALTER TABLE "store_credit_ledger"
	      ADD CONSTRAINT "store_credit_ledger_order_id_fkey"
	      FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
	    EXCEPTION
	      WHEN duplicate_object THEN NULL;
	    END
	    $$;
	  `);

	  await prisma.$executeRawUnsafe(`
	    DO $$
	    BEGIN
	      ALTER TABLE "store_credit_ledger"
	      ADD CONSTRAINT "store_credit_ledger_source_order_id_fkey"
	      FOREIGN KEY ("source_order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
	    EXCEPTION
	      WHEN duplicate_object THEN NULL;
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
    CREATE TABLE IF NOT EXISTS "pickup_notice_templates" (
      "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "name" TEXT NOT NULL,
      "template_type" TEXT NOT NULL DEFAULT 'PICKUP_NOTICE',
      "address" TEXT NOT NULL,
      "ready_date" TEXT NOT NULL,
      "time_window" TEXT NOT NULL,
      "email_subject" TEXT,
      "email_body" TEXT,
      "instructions" TEXT,
      "is_active" BOOLEAN NOT NULL DEFAULT true,
      "sort_order" INTEGER NOT NULL DEFAULT 0,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "pickup_notice_templates_pkey" PRIMARY KEY ("id")
    );
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "pickup_notice_templates" ADD COLUMN IF NOT EXISTS "template_type" TEXT NOT NULL DEFAULT 'PICKUP_NOTICE';
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "pickup_notice_templates" ADD COLUMN IF NOT EXISTS "email_subject" TEXT;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "pickup_notice_templates" ADD COLUMN IF NOT EXISTS "email_body" TEXT;
  `);

  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "pickup_notice_templates_name_key" ON "pickup_notice_templates"("name");
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "pickup_notice_templates_type_active_sort_idx"
      ON "pickup_notice_templates"("template_type", "is_active", "sort_order");
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "pickup_notice_templates_is_active_sort_order_idx"
      ON "pickup_notice_templates"("is_active", "sort_order");
  `);

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

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "produce_items" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::text;
  `);

  for (const item of DEFAULT_PRODUCE_ITEMS) {
    await prisma.$executeRawUnsafe(`
      INSERT INTO "produce_items" ("id", "name", "image_url", "fallback_url", "is_active", "sort_order")
      SELECT gen_random_uuid()::text, $1, $2, $3, true, $4
      WHERE NOT EXISTS (
        SELECT 1
        FROM "produce_items"
        WHERE "name" = $1
      );
    `, item.name, item.imageUrl, item.fallbackUrl, item.sortOrder);
  }
}
