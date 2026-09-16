-- Lot A (Q24/Q25/Q26/Q27/Q71): the console's own identity layer.
--
-- RoleConfig gains the super-admin marker and a membership table (one named
-- role per user); the ADMIN Role stays the gate on every route until a module
-- is moved onto requirePermission. Admins get a mandatory second factor with
-- an email backup whose repeated use is counted. Invitations carry a hashed
-- one-time token. An impersonation session is read-only by construction.

ALTER TYPE "OtpPurpose" ADD VALUE 'TWO_FACTOR';
ALTER TYPE "OtpPurpose" ADD VALUE 'TWO_FACTOR_EMAIL';
ALTER TYPE "OtpPurpose" ADD VALUE 'CHANGE_MOBILE_OLD';

ALTER TABLE "User"
  ADD COLUMN "twoFactorRequiredAt" TIMESTAMP(3),
  ADD COLUMN "emailOtpFallbackCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "emailOtpFallbackResetAt" TIMESTAMP(3);

ALTER TABLE "RoleConfig" ADD COLUMN "isSystem" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Employee" ADD COLUMN "displayId" TEXT;
CREATE UNIQUE INDEX "Employee_displayId_key" ON "Employee"("displayId");

CREATE TABLE "UserRoleConfig" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "roleConfigId" TEXT NOT NULL,
  "assignedById" TEXT,
  "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserRoleConfig_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UserRoleConfig_userId_key" ON "UserRoleConfig"("userId");
CREATE INDEX "UserRoleConfig_roleConfigId_idx" ON "UserRoleConfig"("roleConfigId");
ALTER TABLE "UserRoleConfig"
  ADD CONSTRAINT "UserRoleConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "UserRoleConfig_roleConfigId_fkey" FOREIGN KEY ("roleConfigId") REFERENCES "RoleConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TYPE "AdminInviteMethod" AS ENUM ('PASSWORD', 'GOOGLE');

CREATE TABLE "AdminInvite" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "method" "AdminInviteMethod" NOT NULL DEFAULT 'PASSWORD',
  "roleConfigId" TEXT,
  "tokenHash" TEXT NOT NULL,
  "invitedByUserId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "acceptedUserId" TEXT,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminInvite_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdminInvite_tokenHash_key" ON "AdminInvite"("tokenHash");
CREATE INDEX "AdminInvite_email_idx" ON "AdminInvite"("email");
ALTER TABLE "AdminInvite"
  ADD CONSTRAINT "AdminInvite_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TYPE "ImpersonationScope" AS ENUM ('READ');

CREATE TABLE "ImpersonationSession" (
  "id" TEXT NOT NULL,
  "adminUserId" TEXT NOT NULL,
  "targetUserId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "scope" "ImpersonationScope" NOT NULL DEFAULT 'READ',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "endedAt" TIMESTAMP(3),
  CONSTRAINT "ImpersonationSession_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ImpersonationSession_adminUserId_startedAt_idx" ON "ImpersonationSession"("adminUserId", "startedAt");
CREATE INDEX "ImpersonationSession_targetUserId_startedAt_idx" ON "ImpersonationSession"("targetUserId", "startedAt");
