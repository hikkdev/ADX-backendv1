-- Lot G: answers 100-131 of 13 Sep 2026 and the feature-flag registry.

-- 116/136 slots
ALTER TABLE "Listing" ADD COLUMN "slotsTotal" INTEGER NOT NULL DEFAULT 1;

-- 118/138 fraud score + ESCALATED
ALTER TYPE "FraudCaseStatus" ADD VALUE 'ESCALATED';
ALTER TABLE "FraudCase" ADD COLUMN "score" DECIMAL(4,3);
ALTER TABLE "FraudCase" ADD COLUMN "signals" JSONB;
ALTER TABLE "FraudCase" ADD COLUMN "scoredAt" TIMESTAMP(3);
ALTER TABLE "FraudCase" ADD COLUMN "escalatedAt" TIMESTAMP(3);
ALTER TABLE "FraudCase" ADD COLUMN "escalatedToUserId" TEXT;
ALTER TABLE "FraudCase" ADD COLUMN "escalationNote" TEXT;

-- 127/142 KYC escalation
CREATE TYPE "KycEscalationSource" AS ENUM ('AGE', 'FRAUD_LINK', 'REVIEWER');
ALTER TABLE "PublisherKyc" ADD COLUMN "escalatedAt" TIMESTAMP(3);
ALTER TABLE "PublisherKyc" ADD COLUMN "escalationSource" "KycEscalationSource";
ALTER TABLE "PublisherKyc" ADD COLUMN "escalationReason" TEXT;
ALTER TABLE "PublisherKyc" ADD COLUMN "escalatedToUserId" TEXT;
ALTER TABLE "PublisherKyc" ADD COLUMN "escalatedById" TEXT;
ALTER TABLE "AdvertiserKyc" ADD COLUMN "escalatedAt" TIMESTAMP(3);
ALTER TABLE "AdvertiserKyc" ADD COLUMN "escalationSource" "KycEscalationSource";
ALTER TABLE "AdvertiserKyc" ADD COLUMN "escalationReason" TEXT;
ALTER TABLE "AdvertiserKyc" ADD COLUMN "escalatedToUserId" TEXT;
ALTER TABLE "AdvertiserKyc" ADD COLUMN "escalatedById" TEXT;

-- 122/140 departments and employee fields
CREATE TYPE "WorkMode" AS ENUM ('OFFICE', 'REMOTE', 'HYBRID', 'FIELD');
CREATE TYPE "EmploymentType" AS ENUM ('FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN');
CREATE TABLE "Department" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "description" TEXT,
  "headId" TEXT,
  "parentId" TEXT,
  "regions" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "openRoles" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Department_name_key" ON "Department"("name");
CREATE UNIQUE INDEX "Department_code_key" ON "Department"("code");
ALTER TABLE "Employee" ADD COLUMN "departmentId" TEXT;
ALTER TABLE "Employee" ADD COLUMN "region" TEXT;
ALTER TABLE "Employee" ADD COLUMN "workMode" "WorkMode";
ALTER TABLE "Employee" ADD COLUMN "employmentType" "EmploymentType";
CREATE INDEX "Employee_departmentId_idx" ON "Employee"("departmentId");
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Department" ADD CONSTRAINT "Department_headId_fkey" FOREIGN KEY ("headId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Department" ADD CONSTRAINT "Department_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 123 holiday kind
CREATE TYPE "HolidayKind" AS ENUM ('PUBLIC', 'OPTIONAL');
ALTER TABLE "Holiday" ADD COLUMN "kind" "HolidayKind" NOT NULL DEFAULT 'PUBLIC';

-- 119 advertiser industry
ALTER TABLE "Advertiser" ADD COLUMN "industry" TEXT;

-- 117 transactional flag; 121 delivery attempts
ALTER TABLE "NotificationTemplate" ADD COLUMN "transactional" BOOLEAN NOT NULL DEFAULT true;
CREATE TABLE "DeliveryAttempt" (
  "id" TEXT NOT NULL,
  "deliveryId" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL,
  "provider" TEXT,
  "providerMessageId" TEXT,
  "ok" BOOLEAN NOT NULL,
  "responseText" TEXT,
  "error" TEXT,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeliveryAttempt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DeliveryAttempt_deliveryId_attempt_key" ON "DeliveryAttempt"("deliveryId", "attempt");
ALTER TABLE "DeliveryAttempt" ADD CONSTRAINT "DeliveryAttempt_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "NotificationDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 103 device tokens
CREATE TYPE "DeviceApp" AS ENUM ('USER', 'AGENT');
CREATE TYPE "DevicePlatform" AS ENUM ('ANDROID', 'IOS');
CREATE TABLE "DeviceToken" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "app" "DeviceApp" NOT NULL,
  "platform" "DevicePlatform" NOT NULL,
  "token" TEXT NOT NULL,
  "appVersion" TEXT,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeviceToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DeviceToken_token_key" ON "DeviceToken"("token");
CREATE INDEX "DeviceToken_userId_idx" ON "DeviceToken"("userId");
ALTER TABLE "DeviceToken" ADD CONSTRAINT "DeviceToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 104 data export
CREATE TYPE "DataExportStatus" AS ENUM ('PENDING', 'READY', 'FAILED', 'EXPIRED');
CREATE TABLE "DataExportRequest" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "status" "DataExportStatus" NOT NULL DEFAULT 'PENDING',
  "fileId" TEXT,
  "error" TEXT,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "readyAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  CONSTRAINT "DataExportRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DataExportRequest_userId_requestedAt_idx" ON "DataExportRequest"("userId", "requestedAt");
ALTER TABLE "DataExportRequest" ADD CONSTRAINT "DataExportRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- feature registry
CREATE TYPE "FeatureSurface" AS ENUM ('APP_USER', 'APP_AGENT', 'CONSOLE', 'BACKEND', 'WEBSITE');
CREATE TYPE "FeatureKind" AS ENUM ('FEATURE', 'KILL_SWITCH', 'EXPERIMENT');
CREATE TYPE "FlagSource" AS ENUM ('REGISTERED', 'MANUAL');
ALTER TABLE "FeatureFlag" ADD COLUMN "surfaces" "FeatureSurface"[] DEFAULT ARRAY[]::"FeatureSurface"[];
ALTER TABLE "FeatureFlag" ADD COLUMN "kind" "FeatureKind" NOT NULL DEFAULT 'FEATURE';
ALTER TABLE "FeatureFlag" ADD COLUMN "source" "FlagSource" NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "FeatureFlag" ADD COLUMN "owner" TEXT;
ALTER TABLE "FeatureFlag" ADD COLUMN "variant" TEXT;
ALTER TABLE "FeatureFlag" ADD COLUMN "variants" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "FeatureFlag" ADD COLUMN "rollout" JSONB;
ALTER TABLE "FeatureFlag" ADD COLUMN "lastGoodState" JSONB;
ALTER TABLE "FeatureFlag" ADD COLUMN "registeredAt" TIMESTAMP(3);
ALTER TABLE "FeatureFlagChange" ADD COLUMN "variant" TEXT;
ALTER TABLE "FeatureFlagChange" ADD COLUMN "rollout" JSONB;
ALTER TABLE "FeatureFlagChange" ADD COLUMN "rollbackOfId" TEXT;

-- 129/143 reports
CREATE TYPE "ReportCadence" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');
CREATE TYPE "ReportFormat" AS ENUM ('CSV', 'PDF');
CREATE TYPE "ReportRunStatus" AS ENUM ('RUNNING', 'READY', 'FAILED');
CREATE TABLE "ReportSchedule" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "cadence" "ReportCadence" NOT NULL,
  "format" "ReportFormat" NOT NULL DEFAULT 'CSV',
  "recipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "filters" JSONB,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdById" TEXT NOT NULL,
  "lastRunAt" TIMESTAMP(3),
  "nextRunAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReportSchedule_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ReportSchedule_enabled_nextRunAt_idx" ON "ReportSchedule"("enabled", "nextRunAt");
CREATE TABLE "ReportRun" (
  "id" TEXT NOT NULL,
  "scheduleId" TEXT,
  "kind" TEXT NOT NULL,
  "format" "ReportFormat" NOT NULL,
  "status" "ReportRunStatus" NOT NULL DEFAULT 'RUNNING',
  "filters" JSONB,
  "fileId" TEXT,
  "rowCount" INTEGER,
  "error" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "requestedById" TEXT,
  CONSTRAINT "ReportRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ReportRun_kind_startedAt_idx" ON "ReportRun"("kind", "startedAt");
CREATE INDEX "ReportRun_scheduleId_startedAt_idx" ON "ReportRun"("scheduleId", "startedAt");
ALTER TABLE "ReportRun" ADD CONSTRAINT "ReportRun_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "ReportSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 130 health samples, incidents, subscribers
CREATE TYPE "HealthService" AS ENUM ('API', 'POSTGRES', 'REDIS', 'STORAGE', 'JOBS');
CREATE TYPE "IncidentSeverity" AS ENUM ('MINOR', 'MAJOR', 'CRITICAL');
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'MONITORING', 'RESOLVED');
CREATE TABLE "HealthSample" (
  "id" TEXT NOT NULL,
  "service" "HealthService" NOT NULL,
  "ok" BOOLEAN NOT NULL,
  "latencyMs" INTEGER,
  "detail" TEXT,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HealthSample_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "HealthSample_service_at_idx" ON "HealthSample"("service", "at");
CREATE TABLE "Incident" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "severity" "IncidentSeverity" NOT NULL DEFAULT 'MINOR',
  "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
  "body" TEXT NOT NULL,
  "services" "HealthService"[] DEFAULT ARRAY[]::"HealthService"[],
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Incident_status_startedAt_idx" ON "Incident"("status", "startedAt");
CREATE TABLE "IncidentUpdate" (
  "id" TEXT NOT NULL,
  "incidentId" TEXT NOT NULL,
  "status" "IncidentStatus" NOT NULL,
  "body" TEXT NOT NULL,
  "byUserId" TEXT NOT NULL,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IncidentUpdate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "IncidentUpdate_incidentId_at_idx" ON "IncidentUpdate"("incidentId", "at");
ALTER TABLE "IncidentUpdate" ADD CONSTRAINT "IncidentUpdate_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE "StatusSubscriber" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "confirmedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StatusSubscriber_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StatusSubscriber_email_key" ON "StatusSubscriber"("email");
CREATE UNIQUE INDEX "StatusSubscriber_token_key" ON "StatusSubscriber"("token");

-- 109 audience snapshots
CREATE TABLE "AudienceSnapshot" (
  "id" TEXT NOT NULL,
  "listingId" TEXT NOT NULL,
  "vendor" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "data" JSONB NOT NULL,
  "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3),
  CONSTRAINT "AudienceSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AudienceSnapshot_listingId_vendor_period_key" ON "AudienceSnapshot"("listingId", "vendor", "period");
CREATE INDEX "AudienceSnapshot_listingId_idx" ON "AudienceSnapshot"("listingId");
