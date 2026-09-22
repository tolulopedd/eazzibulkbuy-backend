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

CREATE INDEX IF NOT EXISTS "customer_audit_logs_user_id_idx" ON "customer_audit_logs"("user_id");
CREATE INDEX IF NOT EXISTS "customer_audit_logs_changed_by_user_id_idx" ON "customer_audit_logs"("changed_by_user_id");

DO $$
BEGIN
  ALTER TABLE "customer_audit_logs"
  ADD CONSTRAINT "customer_audit_logs_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  ALTER TABLE "customer_audit_logs"
  ADD CONSTRAINT "customer_audit_logs_changed_by_user_id_fkey"
  FOREIGN KEY ("changed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;
