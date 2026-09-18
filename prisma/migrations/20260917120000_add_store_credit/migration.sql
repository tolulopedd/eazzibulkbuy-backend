DO $$
BEGIN
  CREATE TYPE "StoreCreditLedgerType" AS ENUM ('CREDIT_ISSUED', 'CREDIT_USED', 'CREDIT_REVERSED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

ALTER TABLE "orders"
ADD COLUMN IF NOT EXISTS "store_credit_applied" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "orders"
ADD COLUMN IF NOT EXISTS "amount_due" INTEGER NOT NULL DEFAULT 0;

UPDATE "orders"
SET "amount_due" = "total_amount"
WHERE "amount_due" = 0;

CREATE TABLE IF NOT EXISTS "store_credit_ledger" (
  "id" TEXT NOT NULL,
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

CREATE INDEX IF NOT EXISTS "store_credit_ledger_user_id_idx" ON "store_credit_ledger"("user_id");
CREATE INDEX IF NOT EXISTS "store_credit_ledger_order_id_idx" ON "store_credit_ledger"("order_id");
CREATE INDEX IF NOT EXISTS "store_credit_ledger_source_order_id_idx" ON "store_credit_ledger"("source_order_id");

DO $$
BEGIN
  ALTER TABLE "store_credit_ledger"
  ADD CONSTRAINT "store_credit_ledger_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  ALTER TABLE "store_credit_ledger"
  ADD CONSTRAINT "store_credit_ledger_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  ALTER TABLE "store_credit_ledger"
  ADD CONSTRAINT "store_credit_ledger_source_order_id_fkey"
  FOREIGN KEY ("source_order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;
