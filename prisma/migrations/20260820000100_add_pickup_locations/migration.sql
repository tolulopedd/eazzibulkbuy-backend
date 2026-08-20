CREATE TABLE IF NOT EXISTS "pickup_locations" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "pickup_locations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "pickup_locations_name_key" ON "pickup_locations"("name");

INSERT INTO "pickup_locations" ("id", "name", "is_active", "sort_order")
SELECT gen_random_uuid()::text, seed."name", true, seed."sort_order"
FROM (
  VALUES
    ('Sage Creek', 1),
    ('St. Vital - Dakota Street (4mins from St Vital)', 2),
    ('East Kildonan - Munroe Ave (near Concordia) (3mins from Sobeys Reenders Dr)', 3)
) AS seed("name", "sort_order")
WHERE NOT EXISTS (
  SELECT 1
  FROM "pickup_locations" existing
  WHERE existing."name" = seed."name"
);
