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

CREATE INDEX IF NOT EXISTS "customer_notes_user_id_idx" ON "customer_notes"("user_id");
CREATE INDEX IF NOT EXISTS "customer_notes_order_id_idx" ON "customer_notes"("order_id");
CREATE INDEX IF NOT EXISTS "customer_notes_created_by_user_id_idx" ON "customer_notes"("created_by_user_id");

ALTER TABLE "customer_notes"
ADD COLUMN IF NOT EXISTS "order_references" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

DO $$
BEGIN
  ALTER TABLE "customer_notes"
  ADD CONSTRAINT "customer_notes_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  ALTER TABLE "customer_notes"
  ADD CONSTRAINT "customer_notes_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  ALTER TABLE "customer_notes"
  ADD CONSTRAINT "customer_notes_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;
