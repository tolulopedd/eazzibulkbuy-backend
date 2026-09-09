ALTER TABLE "pickup_notice_templates"
ADD COLUMN IF NOT EXISTS "template_type" TEXT NOT NULL DEFAULT 'PICKUP_NOTICE';

CREATE INDEX IF NOT EXISTS "pickup_notice_templates_type_active_sort_idx"
ON "pickup_notice_templates"("template_type", "is_active", "sort_order");
