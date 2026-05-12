import { prisma } from './prisma.js';

export async function ensureDatabaseCompatibility() {
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "title" TEXT;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "first_name" TEXT;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "last_name" TEXT;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "postal_code" TEXT;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "city" TEXT;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "province" TEXT;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "password_reset_token_hash" TEXT;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "password_reset_token_expires_at" TIMESTAMP(3);
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "sales_items"
    ADD COLUMN IF NOT EXISTS "delivery_enabled" BOOLEAN NOT NULL DEFAULT false;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "sales_items"
    ADD COLUMN IF NOT EXISTS "delivery_base_range_max" INTEGER NOT NULL DEFAULT 10;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "sales_items"
    ADD COLUMN IF NOT EXISTS "delivery_base_price" INTEGER NOT NULL DEFAULT 0;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "sales_items"
    ADD COLUMN IF NOT EXISTS "delivery_additional_unit_price" INTEGER NOT NULL DEFAULT 0;
  `);

  await prisma.$executeRawUnsafe(`
    DO $$ BEGIN
      CREATE TYPE "FulfillmentMethod" AS ENUM ('PICKUP', 'DELIVERY');
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "orders"
    ADD COLUMN IF NOT EXISTS "fulfillment_method" "FulfillmentMethod" NOT NULL DEFAULT 'PICKUP';
  `);
}
