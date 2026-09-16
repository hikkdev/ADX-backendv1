-- The door-to-door QR grant, controlled.
--
-- A code now dies on its own (expiresAt — ninety seconds for onboarding),
-- carries the issuer's fix so the scanner's can be measured against it, and
-- every scan attempt is a row with an outcome, refusals included. A scan no
-- longer claims anything: the person whose code it is approves it, and that
-- approval opens a separate, time-boxed, revocable authority — a
-- DelegatedAccessGrant with purpose ONBOARDING — distinct from the
-- attribution Publisher.agentId records. The demand side gets the same code.

-- AlterEnum
ALTER TYPE "QrType" ADD VALUE 'ADVERTISER';

-- CreateEnum
CREATE TYPE "AccessGrantPurpose" AS ENUM ('SUPPORT', 'ONBOARDING');

-- AlterTable
ALTER TABLE "QrCode"
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "latitude" DOUBLE PRECISION,
  ADD COLUMN "longitude" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "QrScan"
  ADD COLUMN "outcome" TEXT NOT NULL DEFAULT 'GRANTED',
  ADD COLUMN "distanceM" DOUBLE PRECISION,
  ADD COLUMN "decidedAt" TIMESTAMP(3),
  ADD COLUMN "grantId" TEXT;

-- AlterTable
ALTER TABLE "DelegatedAccessGrant"
  ADD COLUMN "purpose" "AccessGrantPurpose" NOT NULL DEFAULT 'SUPPORT';
