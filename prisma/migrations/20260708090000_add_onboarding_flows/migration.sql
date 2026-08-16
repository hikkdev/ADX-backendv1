-- CreateEnum
CREATE TYPE "OnboardingSubmissionStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "OnboardingFlowTemplate" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "userType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "steps" JSONB NOT NULL,
    "schema" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingFlowTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnboardingSubmission" (
    "id" TEXT NOT NULL,
    "flowTemplateId" TEXT,
    "userId" TEXT,
    "userType" TEXT NOT NULL,
    "accountType" TEXT,
    "status" "OnboardingSubmissionStatus" NOT NULL DEFAULT 'SUBMITTED',
    "data" JSONB NOT NULL,
    "submittedById" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OnboardingFlowTemplate_key_key" ON "OnboardingFlowTemplate"("key");

-- CreateIndex
CREATE INDEX "OnboardingFlowTemplate_userType_isActive_idx" ON "OnboardingFlowTemplate"("userType", "isActive");

-- CreateIndex
CREATE INDEX "OnboardingSubmission_flowTemplateId_idx" ON "OnboardingSubmission"("flowTemplateId");

-- CreateIndex
CREATE INDEX "OnboardingSubmission_userId_idx" ON "OnboardingSubmission"("userId");

-- CreateIndex
CREATE INDEX "OnboardingSubmission_userType_status_idx" ON "OnboardingSubmission"("userType", "status");

-- CreateIndex
CREATE INDEX "OnboardingSubmission_createdAt_idx" ON "OnboardingSubmission"("createdAt");

-- AddForeignKey
ALTER TABLE "OnboardingSubmission" ADD CONSTRAINT "OnboardingSubmission_flowTemplateId_fkey" FOREIGN KEY ("flowTemplateId") REFERENCES "OnboardingFlowTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingSubmission" ADD CONSTRAINT "OnboardingSubmission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
