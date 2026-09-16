-- DR 05 wave 6: the training curriculum.
--
-- `TrainingResource` is a flat library two apps read and it stays exactly as
-- it is. The curriculum is new beside it: ordered modules with a lesson, a
-- transcript and takeaways; questions whose correctness never crosses the
-- wire; per-agent progress (the resume card and the "60%"); attempts (the
-- "Score 5/5" and the retry rule); and the certificate, minted through the
-- identifier counter like every other number ADX prints.

CREATE TABLE "TrainingModule" (
  "id" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "summary" TEXT,
  "durationMins" INTEGER,
  "videoUrl" TEXT,
  "lessonBody" TEXT,
  "transcript" TEXT,
  "takeaways" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "unlockAfterOrdinal" INTEGER,
  "passPercent" INTEGER NOT NULL DEFAULT 80,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TrainingModule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TrainingModule_pass_percent" CHECK ("passPercent" >= 1 AND "passPercent" <= 100),
  CONSTRAINT "TrainingModule_ordinal_positive" CHECK ("ordinal" >= 1),
  CONSTRAINT "TrainingModule_duration_positive" CHECK ("durationMins" IS NULL OR "durationMins" > 0)
);
CREATE INDEX "TrainingModule_isActive_ordinal_idx" ON "TrainingModule"("isActive", "ordinal");

CREATE TABLE "TrainingQuestion" (
  "id" TEXT NOT NULL,
  "moduleId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "prompt" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TrainingQuestion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TrainingQuestion_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "TrainingModule"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "TrainingQuestion_moduleId_ordinal_idx" ON "TrainingQuestion"("moduleId", "ordinal");

CREATE TABLE "TrainingOption" (
  "id" TEXT NOT NULL,
  "questionId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "label" TEXT NOT NULL,
  "isCorrect" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "TrainingOption_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TrainingOption_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "TrainingQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "TrainingOption_questionId_ordinal_idx" ON "TrainingOption"("questionId", "ordinal");

CREATE TABLE "AgentTrainingProgress" (
  "id" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "moduleId" TEXT NOT NULL,
  "percent" INTEGER NOT NULL DEFAULT 0,
  "lastPositionSec" INTEGER,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentTrainingProgress_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AgentTrainingProgress_percent_range" CHECK ("percent" >= 0 AND "percent" <= 100),
  CONSTRAINT "AgentTrainingProgress_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AgentTrainingProgress_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "TrainingModule"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AgentTrainingProgress_agentId_moduleId_key" ON "AgentTrainingProgress"("agentId", "moduleId");

CREATE TABLE "TrainingAttempt" (
  "id" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "moduleId" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "submittedAt" TIMESTAMP(3) NOT NULL,
  "score" INTEGER NOT NULL,
  "total" INTEGER NOT NULL,
  "passed" BOOLEAN NOT NULL,
  "answers" JSONB NOT NULL,
  CONSTRAINT "TrainingAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TrainingAttempt_score_le_total" CHECK ("score" >= 0 AND "score" <= "total"),
  CONSTRAINT "TrainingAttempt_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TrainingAttempt_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "TrainingModule"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "TrainingAttempt_agentId_moduleId_idx" ON "TrainingAttempt"("agentId", "moduleId");

CREATE TABLE "AgentCertification" (
  "id" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "certificateId" TEXT NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  "revokedReason" TEXT,
  "revokedByUserId" TEXT,
  CONSTRAINT "AgentCertification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AgentCertification_revoked_has_reason" CHECK (("revokedAt" IS NULL) = ("revokedReason" IS NULL)),
  CONSTRAINT "AgentCertification_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AgentCertification_agentId_key" ON "AgentCertification"("agentId");
CREATE UNIQUE INDEX "AgentCertification_certificateId_key" ON "AgentCertification"("certificateId");

-- ADX-CERT-… is issued once, off the same counter as every other identifier.
ALTER TYPE "PartyType" ADD VALUE IF NOT EXISTS 'CERTIFICATE';
