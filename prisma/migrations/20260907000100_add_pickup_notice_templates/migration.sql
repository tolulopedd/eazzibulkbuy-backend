CREATE TABLE IF NOT EXISTS "pickup_notice_templates" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
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

CREATE UNIQUE INDEX IF NOT EXISTS "pickup_notice_templates_name_key" ON "pickup_notice_templates"("name");
CREATE INDEX IF NOT EXISTS "pickup_notice_templates_is_active_sort_order_idx" ON "pickup_notice_templates"("is_active", "sort_order");
