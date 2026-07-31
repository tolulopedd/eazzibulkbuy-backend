CREATE TYPE "CustomerUpdateRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED');

CREATE TABLE "customer_update_requests" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "phone" TEXT,
  "address" TEXT,
  "city" TEXT,
  "province" TEXT,
  "postal_code" TEXT,
  "status" "CustomerUpdateRequestStatus" NOT NULL DEFAULT 'PENDING',
  "reviewed_at" TIMESTAMP(3),
  "reviewed_by_user_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "customer_update_requests_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "customer_update_requests"
ADD CONSTRAINT "customer_update_requests_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "customer_update_requests"
ADD CONSTRAINT "customer_update_requests_reviewed_by_user_id_fkey"
FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
