ALTER TABLE "orders"
ADD COLUMN "display_order_reference" TEXT;

UPDATE "orders" AS o
SET "display_order_reference" = CASE
  WHEN COALESCE(TRIM(si."batch_number"), '') = ''
    THEN TO_CHAR(o."created_at", 'DDMon') || '-' || LPAD(o."order_sequence"::text, 4, '0')
  ELSE TO_CHAR(o."created_at", 'DDMon') || '-' || UPPER(TRIM(si."batch_number")) || '-' || LPAD(o."order_sequence"::text, 4, '0')
END
FROM "sales_items" AS si
WHERE o."sales_item_id" = si."id"
  AND o."display_order_reference" IS NULL;

CREATE UNIQUE INDEX "orders_display_order_reference_key"
ON "orders" ("display_order_reference");
