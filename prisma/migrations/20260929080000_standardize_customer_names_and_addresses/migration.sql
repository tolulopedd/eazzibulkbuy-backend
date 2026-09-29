UPDATE "users"
SET
  "first_name" = CASE
    WHEN "first_name" IS NULL THEN NULL
    ELSE INITCAP(LOWER(REGEXP_REPLACE(BTRIM("first_name"), '[[:space:]]+', ' ', 'g')))
  END,
  "last_name" = CASE
    WHEN "last_name" IS NULL THEN NULL
    ELSE INITCAP(LOWER(REGEXP_REPLACE(BTRIM("last_name"), '[[:space:]]+', ' ', 'g')))
  END,
  "name" = INITCAP(LOWER(REGEXP_REPLACE(BTRIM("name"), '[[:space:]]+', ' ', 'g'))),
  "address" = CASE
    WHEN "address" IS NULL THEN NULL
    ELSE INITCAP(LOWER(REGEXP_REPLACE(BTRIM("address"), '[[:space:]]+', ' ', 'g')))
  END
WHERE "role" = 'USER';
