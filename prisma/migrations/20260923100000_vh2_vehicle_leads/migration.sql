-- VH-2 (vehicles as ad spots): a captured lead may be a vehicle, so it carries
-- the registration and Cashfree's RC answer the way a listing already does.
--
-- The registration is UNIQUE across leads on purpose. A wall stays where it
-- is, so LH4's thirty-metre dedup catches the same wall twice; an auto does
-- not, and two agents can meet the same vehicle a kilometre apart on the same
-- afternoon. For a vehicle the registration IS the identity.

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "vehicleNumber" TEXT,
ADD COLUMN     "vehicleRcPayload" JSONB,
ADD COLUMN     "vehicleRcVerifiedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Lead_vehicleNumber_key" ON "Lead"("vehicleNumber");
