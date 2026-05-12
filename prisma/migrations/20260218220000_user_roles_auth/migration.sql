-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'PARTNER', 'USER');

-- AlterTable
ALTER TABLE "users"
  ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'USER',
  ADD COLUMN "password_hash" TEXT,
  ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "invited_at" TIMESTAMP(3),
  ADD COLUMN "invited_by_user_id" TEXT,
  ADD COLUMN "invite_token_hash" TEXT,
  ADD COLUMN "invite_token_expires_at" TIMESTAMP(3),
  ADD COLUMN "last_login_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");
CREATE INDEX "users_is_active_idx" ON "users"("is_active");
