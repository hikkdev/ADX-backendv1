/*
  Warnings:

  - The values [PENDING,ACCEPTED,VERIFICATION] on the enum `OrderStatus` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `advertiserName` on the `Order` table. All the data in the column will be lost.
  - You are about to drop the column `payout` on the `Order` table. All the data in the column will be lost.
  - You are about to drop the column `siteId` on the `Order` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[qrToken]` on the table `Listing` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[mobile]` on the table `Publisher` will be added. If there are existing duplicate values, this will fail.
  - The required column `qrToken` was added to the `Listing` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.
  - Added the required column `advertiserId` to the `Order` table without a default value. This is not possible if the table is not empty.
  - Added the required column `listingId` to the `Order` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "OnboardingStatus" AS ENUM ('PENDING_ONBOARDING', 'IN_ONBOARDING', 'ONBOARDING_COMPLETE', 'ONBOARDING_CANCELLED');

-- CreateEnum
CREATE TYPE "OrderMilestoneType" AS ENUM ('SURVEY', 'CREATIVE_COLLECTION', 'INSTALLATION', 'VERIFICATION', 'HEALTH_CHECK', 'CUSTOM');

-- CreateEnum
CREATE TYPE "OrderMilestoneStatus" AS ENUM ('PENDING', 'DISPATCHED', 'IN_PROGRESS', 'COMPLETED', 'SKIPPED');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'ORDER';

-- AlterEnum
BEGIN;
CREATE TYPE "OrderStatus_new" AS ENUM ('DRAFT', 'PENDING_PUBLISHER', 'PUBLISHER_REJECTED', 'PENDING_PRINT', 'SELF_INSTALL', 'PENDING_AGENT', 'AGENT_REJECTED', 'SLOT_PROPOSED', 'SLOT_CONFIRMED', 'IN_PROGRESS', 'PENDING_OTP', 'PENDING_APPROVAL', 'COMPLETED', 'CANCELLED');
ALTER TABLE "public"."Order" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Order" ALTER COLUMN "status" TYPE "OrderStatus_new" USING ("status"::text::"OrderStatus_new");
ALTER TYPE "OrderStatus" RENAME TO "OrderStatus_old";
ALTER TYPE "OrderStatus_new" RENAME TO "OrderStatus";
DROP TYPE "public"."OrderStatus_old";
ALTER TABLE "Order" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
COMMIT;

-- AlterEnum
ALTER TYPE "OtpPurpose" ADD VALUE 'REGISTER';

-- AlterEnum
ALTER TYPE "QrType" ADD VALUE 'PUBLISHER';

-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_agentId_fkey";

-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_siteId_fkey";

-- DropForeignKey
ALTER TABLE "Publisher" DROP CONSTRAINT "Publisher_agentId_fkey";

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "agentCanInstall" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "planId" TEXT,
ADD COLUMN     "qrToken" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "MilestoneTemplate" ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Order" DROP COLUMN "advertiserName",
DROP COLUMN "payout",
DROP COLUMN "siteId",
ADD COLUMN     "adminApprovedAt" TIMESTAMP(3),
ADD COLUMN     "advertiserId" TEXT NOT NULL,
ADD COLUMN     "agentEscalated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "agentLatitude" DOUBLE PRECISION,
ADD COLUMN     "agentLocationUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "agentLongitude" DOUBLE PRECISION,
ADD COLUMN     "agentRejectionCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "budget" DOUBLE PRECISION,
ADD COLUMN     "completionOtp" TEXT,
ADD COLUMN     "completionOtpExpiry" TIMESTAMP(3),
ADD COLUMN     "completionOtpPlain" TEXT,
ADD COLUMN     "designUrl" TEXT,
ADD COLUMN     "listingId" TEXT NOT NULL,
ADD COLUMN     "meetingPlace" TEXT,
ADD COLUMN     "printReadyAt" TIMESTAMP(3),
ADD COLUMN     "publisherAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "publisherRejectedAt" TIMESTAMP(3),
ADD COLUMN     "publisherRejectionReason" TEXT,
ADD COLUMN     "publisherTimerExpiry" TIMESTAMP(3),
ADD COLUMN     "selfInstallCheckedInAt" TIMESTAMP(3),
ADD COLUMN     "selfInstallCollectPhotoUrl" TEXT,
ADD COLUMN     "selfInstallConditionPhotoUrls" TEXT[],
ADD COLUMN     "selfInstallInstallPhotoUrl" TEXT,
ADD COLUMN     "slotConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "slotCounterCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "slotProposedAt" TIMESTAMP(3),
ADD COLUMN     "slotTime" TIMESTAMP(3),
ALTER COLUMN "agentId" DROP NOT NULL,
ALTER COLUMN "status" SET DEFAULT 'DRAFT';

-- AlterTable
ALTER TABLE "Publisher" ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "onboardingStatus" "OnboardingStatus" NOT NULL DEFAULT 'PENDING_ONBOARDING',
ALTER COLUMN "agentId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "PublisherKyc" ADD COLUMN     "digioPayload" JSONB,
ADD COLUMN     "digioReferenceId" TEXT,
ADD COLUMN     "digioRequestId" TEXT,
ADD COLUMN     "digioStatus" TEXT,
ADD COLUMN     "digioVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "method" TEXT NOT NULL DEFAULT 'MANUAL';

-- CreateTable
CREATE TABLE "OrderAgentAssignment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "OrderAgentAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountHolder" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "ifscCode" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UploadedFile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "purpose" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UploadedFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppConfig" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderMilestoneTemplate" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" "OrderMilestoneType" NOT NULL,
    "requirements" JSONB NOT NULL,
    "estimatedDurationMins" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderMilestoneTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MilestonePlan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MilestonePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MilestonePlanItem" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "isOptional" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "MilestonePlanItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderMilestone" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "planId" TEXT,
    "assignedAgentId" TEXT,
    "status" "OrderMilestoneStatus" NOT NULL DEFAULT 'PENDING',
    "order" INTEGER NOT NULL,
    "isOptional" BOOLEAN NOT NULL DEFAULT false,
    "dueDate" TIMESTAMP(3),
    "notes" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderMilestoneEvidence" (
    "id" TEXT NOT NULL,
    "milestoneId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderMilestoneEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderAgentAssignment_orderId_idx" ON "OrderAgentAssignment"("orderId");

-- CreateIndex
CREATE INDEX "OrderAgentAssignment_agentId_idx" ON "OrderAgentAssignment"("agentId");

-- CreateIndex
CREATE INDEX "NotificationPreference_userId_idx" ON "NotificationPreference"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_userId_type_key" ON "NotificationPreference"("userId", "type");

-- CreateIndex
CREATE INDEX "BankAccount_userId_idx" ON "BankAccount"("userId");

-- CreateIndex
CREATE INDEX "UploadedFile_userId_idx" ON "UploadedFile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AppConfig_key_key" ON "AppConfig"("key");

-- CreateIndex
CREATE INDEX "MilestonePlanItem_planId_idx" ON "MilestonePlanItem"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "MilestonePlanItem_planId_order_key" ON "MilestonePlanItem"("planId", "order");

-- CreateIndex
CREATE INDEX "OrderMilestone_orderId_order_idx" ON "OrderMilestone"("orderId", "order");

-- CreateIndex
CREATE INDEX "OrderMilestone_assignedAgentId_status_dueDate_idx" ON "OrderMilestone"("assignedAgentId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "OrderMilestone_planId_idx" ON "OrderMilestone"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderMilestone_orderId_order_key" ON "OrderMilestone"("orderId", "order");

-- CreateIndex
CREATE INDEX "OrderMilestoneEvidence_milestoneId_idx" ON "OrderMilestoneEvidence"("milestoneId");

-- CreateIndex
CREATE UNIQUE INDEX "Listing_qrToken_key" ON "Listing"("qrToken");

-- CreateIndex
CREATE UNIQUE INDEX "Publisher_mobile_key" ON "Publisher"("mobile");

-- CreateIndex
CREATE INDEX "Publisher_agentId_idx" ON "Publisher"("agentId");

-- CreateIndex
CREATE INDEX "Publisher_mobile_idx" ON "Publisher"("mobile");

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_publisherId_fkey" FOREIGN KEY ("publisherId") REFERENCES "Publisher"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderAgentAssignment" ADD CONSTRAINT "OrderAgentAssignment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderAgentAssignment" ADD CONSTRAINT "OrderAgentAssignment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Publisher" ADD CONSTRAINT "Publisher_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Publisher" ADD CONSTRAINT "Publisher_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_planId_fkey" FOREIGN KEY ("planId") REFERENCES "MilestonePlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadedFile" ADD CONSTRAINT "UploadedFile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MilestonePlanItem" ADD CONSTRAINT "MilestonePlanItem_planId_fkey" FOREIGN KEY ("planId") REFERENCES "MilestonePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MilestonePlanItem" ADD CONSTRAINT "MilestonePlanItem_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "OrderMilestoneTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderMilestone" ADD CONSTRAINT "OrderMilestone_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderMilestone" ADD CONSTRAINT "OrderMilestone_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "OrderMilestoneTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderMilestone" ADD CONSTRAINT "OrderMilestone_planId_fkey" FOREIGN KEY ("planId") REFERENCES "MilestonePlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderMilestone" ADD CONSTRAINT "OrderMilestone_assignedAgentId_fkey" FOREIGN KEY ("assignedAgentId") REFERENCES "AgentProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderMilestoneEvidence" ADD CONSTRAINT "OrderMilestoneEvidence_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "OrderMilestone"("id") ON DELETE CASCADE ON UPDATE CASCADE;
