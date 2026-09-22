-- AG-1 (20 Sep 2026): the agent application ladder, grade, engagement record,
-- the applicant's own details, per-document review, and the two agent
-- platform-agreement kinds. Written by hand: `prisma migrate dev` refuses this
-- tree (a modified historical migration) and would reset the database.

-- Enums
CREATE TYPE "AgentStage" AS ENUM ('APPLIED', 'PROFILE', 'DOCUMENTS', 'BANK', 'AGREEMENT', 'SCREENING', 'TRAINING', 'UNDER_REVIEW', 'ACTIVE', 'ON_HOLD', 'REJECTED', 'WITHDRAWN', 'EXITED');
CREATE TYPE "AgentGrade" AS ENUM ('G1', 'G2', 'G3', 'G4');
CREATE TYPE "AgentEngagementType" AS ENUM ('GIG', 'CONTRACT');
CREATE TYPE "AgentVehicleType" AS ENUM ('NONE', 'BICYCLE', 'SCOOTER', 'MOTORBIKE', 'EV', 'CAR');
CREATE TYPE "AgentEducationLevel" AS ENUM ('BELOW_10TH', 'CLASS_10', 'CLASS_12', 'DIPLOMA', 'GRADUATE', 'POST_GRADUATE');
CREATE TYPE "AgentSourceKind" AS ENUM ('SELF', 'FLEET', 'REFERRAL', 'WALK_IN', 'JOB_PORTAL', 'DESK', 'IMPORT');
CREATE TYPE "AgentExitReason" AS ENUM ('RESIGNED', 'CONTRACT_ENDED', 'NON_PERFORMANCE', 'MISCONDUCT', 'FRAUD', 'OTHER');
CREATE TYPE "AgentDocumentKind" AS ENUM ('AADHAAR_FRONT', 'AADHAAR_BACK', 'PASSPORT', 'PAN', 'SELFIE', 'DRIVING_LICENCE_FRONT', 'DRIVING_LICENCE_BACK', 'VEHICLE_RC', 'VEHICLE_INSURANCE', 'ADDRESS_PROOF', 'BANK_PROOF', 'POLICE_VERIFICATION', 'EDUCATION_CERTIFICATE', 'RESUME', 'EMPLOYER_PROOF', 'PHOTO', 'OTHER');
CREATE TYPE "AgentDocumentStatus" AS ENUM ('SUBMITTED', 'APPROVED', 'FLAGGED', 'REUPLOAD_REQUESTED');

ALTER TYPE "AgreementKind" ADD VALUE 'AGENT_PUBLISHER_PLATFORM';
ALTER TYPE "AgreementKind" ADD VALUE 'AGENT_ADVERTISER_PLATFORM';

-- AgentProfile: the ladder, the grade, the engagement, the applicant's details, the exit.
ALTER TABLE "AgentProfile"
  ADD COLUMN "stage" "AgentStage" NOT NULL DEFAULT 'APPLIED',
  ADD COLUMN "applicationSubmittedAt" TIMESTAMP(3),
  ADD COLUMN "activatedAt" TIMESTAMP(3),
  ADD COLUMN "activatedById" TEXT,
  ADD COLUMN "holdReason" TEXT,
  ADD COLUMN "rejectionReason" TEXT,
  ADD COLUMN "rejectedAt" TIMESTAMP(3),
  ADD COLUMN "withdrawnAt" TIMESTAMP(3),
  ADD COLUMN "reviewNote" TEXT,
  ADD COLUMN "grade" "AgentGrade",
  ADD COLUMN "gradeSetAt" TIMESTAMP(3),
  ADD COLUMN "gradeSetById" TEXT,
  ADD COLUMN "gradeNote" TEXT,
  ADD COLUMN "engagementType" "AgentEngagementType",
  ADD COLUMN "engagementStartAt" TIMESTAMP(3),
  ADD COLUMN "engagementEndAt" TIMESTAMP(3),
  ADD COLUMN "probationEndsAt" TIMESTAMP(3),
  ADD COLUMN "reportingManagerId" TEXT,
  ADD COLUMN "weeklyHours" INTEGER,
  ADD COLUMN "languages" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "vehicleType" "AgentVehicleType",
  ADD COLUMN "vehicleNumber" TEXT,
  ADD COLUMN "currentAddress" TEXT,
  ADD COLUMN "currentLatitude" DOUBLE PRECISION,
  ADD COLUMN "currentLongitude" DOUBLE PRECISION,
  ADD COLUMN "permanentAddress" TEXT,
  ADD COLUMN "emergencyContactName" TEXT,
  ADD COLUMN "emergencyContactRelation" TEXT,
  ADD COLUMN "emergencyContactPhone" TEXT,
  ADD COLUMN "highestEducation" "AgentEducationLevel",
  ADD COLUMN "salesExperienceYears" INTEGER,
  ADD COLUMN "industries" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "noticePeriodDays" INTEGER,
  ADD COLUMN "sourceKind" "AgentSourceKind" NOT NULL DEFAULT 'DESK',
  ADD COLUMN "sourceNote" TEXT,
  ADD COLUMN "referredByAgentId" TEXT,
  ADD COLUMN "exitedAt" TIMESTAMP(3),
  ADD COLUMN "exitedById" TEXT,
  ADD COLUMN "exitReason" "AgentExitReason",
  ADD COLUMN "exitNote" TEXT,
  ADD COLUMN "rehireEligible" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "blacklistedAt" TIMESTAMP(3);

-- Every agent that existed before the ladder was created at the desk and is working: ACTIVE from when it was made.
UPDATE "AgentProfile" SET "stage" = 'ACTIVE', "activatedAt" = "createdAt", "sourceKind" = 'DESK';

CREATE INDEX "AgentProfile_stage_idx" ON "AgentProfile"("stage");
CREATE INDEX "AgentProfile_reportingManagerId_idx" ON "AgentProfile"("reportingManagerId");
ALTER TABLE "AgentProfile" ADD CONSTRAINT "AgentProfile_reportingManagerId_fkey" FOREIGN KEY ("reportingManagerId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The documents, one row per kind with its own decision.
CREATE TABLE "AgentDocument" (
  "id" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "kind" "AgentDocumentKind" NOT NULL,
  "url" TEXT NOT NULL,
  "numberMasked" TEXT,
  "numberHash" TEXT,
  "expiresAt" TIMESTAMP(3),
  "status" "AgentDocumentStatus" NOT NULL DEFAULT 'SUBMITTED',
  "reviewNote" TEXT,
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "uploadedVia" TEXT NOT NULL DEFAULT 'APP',
  "uploadedById" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgentDocument_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AgentDocument_agentId_kind_key" ON "AgentDocument"("agentId", "kind");
CREATE INDEX "AgentDocument_status_idx" ON "AgentDocument"("status");
CREATE INDEX "AgentDocument_expiresAt_idx" ON "AgentDocument"("expiresAt");
CREATE INDEX "AgentDocument_numberHash_idx" ON "AgentDocument"("numberHash");
ALTER TABLE "AgentDocument" ADD CONSTRAINT "AgentDocument_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AgentEducation" (
  "id" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "level" "AgentEducationLevel" NOT NULL,
  "degree" TEXT,
  "institution" TEXT,
  "year" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentEducation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AgentEducation_agentId_idx" ON "AgentEducation"("agentId");
ALTER TABLE "AgentEducation" ADD CONSTRAINT "AgentEducation_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AgentEmployment" (
  "id" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "employer" TEXT NOT NULL,
  "role" TEXT,
  "industry" TEXT,
  "fromMonth" TEXT,
  "toMonth" TEXT,
  "current" BOOLEAN NOT NULL DEFAULT false,
  "reasonForLeaving" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentEmployment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AgentEmployment_agentId_idx" ON "AgentEmployment"("agentId");
ALTER TABLE "AgentEmployment" ADD CONSTRAINT "AgentEmployment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AgentReference" (
  "id" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "relation" TEXT,
  "phone" TEXT NOT NULL,
  "checkedAt" TIMESTAMP(3),
  "checkedById" TEXT,
  "checkNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentReference_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AgentReference_agentId_idx" ON "AgentReference"("agentId");
ALTER TABLE "AgentReference" ADD CONSTRAINT "AgentReference_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AgentPlatformExperience" (
  "id" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "platform" TEXT NOT NULL,
  "partnerId" TEXT,
  "years" DECIMAL(4,1),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "ratingNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentPlatformExperience_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AgentPlatformExperience_agentId_idx" ON "AgentPlatformExperience"("agentId");
ALTER TABLE "AgentPlatformExperience" ADD CONSTRAINT "AgentPlatformExperience_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One-time copy of the desk's seven KYC slots into the document table, so the
-- application ladder sees what the desk already holds. The AgentKyc row keeps
-- the set's status and the Digio fields; the desk's PUT writes both from now on.
INSERT INTO "AgentDocument" ("id", "agentId", "kind", "url", "numberMasked", "status", "uploadedVia", "uploadedById", "createdAt", "updatedAt")
SELECT 'agdoc_' || md5(k."agentId" || ':' || k.kind), k."agentId", k.kind::"AgentDocumentKind", k.url, k.masked,
       CASE WHEN k.status = 'VERIFIED' THEN 'APPROVED'::"AgentDocumentStatus" ELSE 'SUBMITTED'::"AgentDocumentStatus" END,
       'DESK', k."recordedById", COALESCE(k."submittedAt", k."createdAt"), CURRENT_TIMESTAMP
FROM (
  SELECT a."agentId", a."recordedById", a."submittedAt", a."createdAt", a.status,
         CASE a."govIdType" WHEN 'PASSPORT' THEN 'PASSPORT' WHEN 'DRIVING_LICENCE' THEN 'DRIVING_LICENCE_FRONT' ELSE 'AADHAAR_FRONT' END AS kind,
         a."govIdFrontUrl" AS url, NULL::TEXT AS masked
  FROM "AgentKyc" a WHERE a."govIdFrontUrl" IS NOT NULL
  UNION ALL
  SELECT a."agentId", a."recordedById", a."submittedAt", a."createdAt", a.status,
         CASE a."govIdType" WHEN 'DRIVING_LICENCE' THEN 'DRIVING_LICENCE_BACK' WHEN 'PASSPORT' THEN 'OTHER' ELSE 'AADHAAR_BACK' END,
         a."govIdBackUrl", NULL
  FROM "AgentKyc" a WHERE a."govIdBackUrl" IS NOT NULL
  UNION ALL
  SELECT a."agentId", a."recordedById", a."submittedAt", a."createdAt", a.status, 'PAN', a."panFrontUrl",
         CASE WHEN a."panNumber" IS NOT NULL THEN LEFT(a."panNumber", 5) || '****' || RIGHT(a."panNumber", 1) END
  FROM "AgentKyc" a WHERE a."panFrontUrl" IS NOT NULL
  UNION ALL
  SELECT a."agentId", a."recordedById", a."submittedAt", a."createdAt", a.status, 'ADDRESS_PROOF', a."addressProofUrl", NULL
  FROM "AgentKyc" a WHERE a."addressProofUrl" IS NOT NULL
  UNION ALL
  SELECT a."agentId", a."recordedById", a."submittedAt", a."createdAt", a.status, 'SELFIE', a."selfieUrl", NULL
  FROM "AgentKyc" a WHERE a."selfieUrl" IS NOT NULL
  UNION ALL
  SELECT a."agentId", a."recordedById", a."submittedAt", a."createdAt", a.status, 'BANK_PROOF', a."bankProofUrl", NULL
  FROM "AgentKyc" a WHERE a."bankProofUrl" IS NOT NULL
) k
ON CONFLICT ("agentId", "kind") DO NOTHING;
