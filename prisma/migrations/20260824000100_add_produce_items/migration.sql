CREATE TABLE IF NOT EXISTS "produce_items" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "image_url" TEXT NOT NULL,
  "fallback_url" TEXT,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "produce_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "produce_items_name_key" ON "produce_items"("name");

INSERT INTO "produce_items" ("id", "name", "image_url", "fallback_url", "is_active", "sort_order")
SELECT gen_random_uuid()::text, seed."name", seed."image_url", seed."fallback_url", true, seed."sort_order"
FROM (
  VALUES
    ('Tomatoes', '/images/products/tomatoes-box.jpg', 'https://source.unsplash.com/1200x800/?tomatoes,crate', 1),
    ('Red Habanero', '/images/products/habanero-box.jpg', 'https://source.unsplash.com/1200x800/?habanero,pepper,box', 2),
    ('Orange Habanero Pepper', '/images/products/orange-habanero-pepper.jpg', 'https://source.unsplash.com/1200x800/?orange-habanero,pepper,box', 3),
    ('Brown Habanero Pepper', '/images/products/brown-habanero-pepper.jpg', 'https://source.unsplash.com/1200x800/?brown-habanero,pepper,box', 4),
    ('Scorpion Pepper', '/images/products/scorpion-pepper.jpg', 'https://source.unsplash.com/1200x800/?scorpion-pepper,pepper,box', 5),
    ('Armageddon Pepper', '/images/products/armageddon-pepper.jpg', 'https://source.unsplash.com/1200x800/?armageddon-pepper,pepper,box', 6),
    ('Carolina Reaper Pepper', '/images/products/carolina-reaper-pepper.jpg', 'https://source.unsplash.com/1200x800/?carolina-reaper,pepper,box', 7),
    ('Ghost Pepper', '/images/products/ghost-pepper.jpg', 'https://source.unsplash.com/1200x800/?ghost-pepper,pepper,box', 8),
    ('Cayenne Pepper', '/images/products/cayenne-pepper.jpg', 'https://source.unsplash.com/1200x800/?cayenne-pepper,red-pepper,box', 9),
    ('Crimson Pepper', '/images/products/crimson-pepper.jpg', 'https://source.unsplash.com/1200x800/?crimson-pepper,red-pepper,box', 10),
    ('Shepherd Pepper', '/images/products/shepherd-pepper.jpg', 'https://source.unsplash.com/1200x800/?shepherd-pepper,red-pepper,box', 11),
    ('Red Bell Pepper', '/images/products/red-bell-pepper.jpg', 'https://source.unsplash.com/1200x800/?red-bell-pepper,vegetable,box', 12),
    ('Green Bell Pepper', '/images/products/green-bell-pepper.jpg', 'https://source.unsplash.com/1200x800/?green-bell-pepper,vegetable,box', 13),
    ('Green Habanero Pepper', '/images/products/green-pepper-box.jpg', 'https://source.unsplash.com/1200x800/?green-pepper,vegetable,box', 14),
    ('Yam', '/images/products/yam-box.jpg', 'https://source.unsplash.com/1200x800/?yam,tuber,box', 15),
    ('Sweet Potatoes', '/images/products/caribbean-sweet-potatoes.jpg', 'https://source.unsplash.com/1200x800/?sweet-potatoes,box,produce', 16),
    ('Red Onions', '/images/products/red-onions.jpg', 'https://source.unsplash.com/1200x800/?red-onions,produce,bag', 17),
    ('Yellow Onions', '/images/products/yellow-onions.jpg', 'https://source.unsplash.com/1200x800/?yellow-onions,produce,basket', 18),
    ('Plantain', '/images/products/plantain.jpg', 'https://source.unsplash.com/1200x800/?plantain,box,produce', 19)
) AS seed("name", "image_url", "fallback_url", "sort_order")
WHERE NOT EXISTS (
  SELECT 1
  FROM "produce_items" existing
  WHERE existing."name" = seed."name"
);
