ALTER TABLE "customer_notes"
ADD COLUMN IF NOT EXISTS "read_at" TIMESTAMP(3);

ALTER TABLE "customer_notes"
ADD COLUMN IF NOT EXISTS "read_by_user_id" TEXT;

CREATE INDEX IF NOT EXISTS "customer_notes_source_read_at_created_at_idx"
ON "customer_notes"("source", "read_at", "created_at");

CREATE INDEX IF NOT EXISTS "customer_notes_read_by_user_id_idx"
ON "customer_notes"("read_by_user_id");

DO $$
BEGIN
  ALTER TABLE "customer_notes"
  ADD CONSTRAINT "customer_notes_read_by_user_id_fkey"
  FOREIGN KEY ("read_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;
