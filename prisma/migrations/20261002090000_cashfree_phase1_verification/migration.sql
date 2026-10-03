-- Cashfree Phase 1 (the owner, 1 Oct 2026): the verification layer.
--
-- Digio stays the primary KYC provider; Cashfree Secure ID is its automatic
-- backup and the provider of every single check (PAN, bank account, GSTIN,
-- vehicle RC, driving licence, face, name match, DigiLocker). Three tables:
--
--   VerificationSession  one run of Cashfree's equivalent of a Digio workflow
--   VerificationAttempt  every call to a verification provider (a failover is two rows)
--   ProviderEvent        inbound verification webhooks, for de-duplication
--
-- The statuses, case types, check types and provider names are text held to
-- their vocabularies in the code (`shared/verification/checks.ts`), not
-- database enums: the vocabulary grows with the providers, and a new check
-- must not need an ALTER TYPE. Nothing existing is altered.

CREATE TABLE "VerificationSession" (
    "id" TEXT NOT NULL,
    "caseType" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "workflowKey" TEXT,
    "provider" TEXT NOT NULL,
    "ownerUserId" TEXT,
    "subject" JSONB,
    "steps" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerificationSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VerificationAttempt" (
    "id" TEXT NOT NULL,
    "caseType" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "sessionId" TEXT,
    "checkType" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "verificationId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "errorClass" TEXT,
    "failureCode" TEXT,
    "latencyMs" INTEGER,
    "providerRef" TEXT,
    "nameMatchScore" DECIMAL(5,2),
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerificationAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProviderEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "outcome" TEXT,

    CONSTRAINT "ProviderEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VerificationSession_caseType_caseId_createdAt_idx" ON "VerificationSession"("caseType", "caseId", "createdAt");
CREATE INDEX "VerificationSession_status_expiresAt_idx" ON "VerificationSession"("status", "expiresAt");

CREATE UNIQUE INDEX "VerificationAttempt_verificationId_key" ON "VerificationAttempt"("verificationId");
CREATE INDEX "VerificationAttempt_caseType_caseId_createdAt_idx" ON "VerificationAttempt"("caseType", "caseId", "createdAt");
CREATE INDEX "VerificationAttempt_provider_createdAt_idx" ON "VerificationAttempt"("provider", "createdAt");
CREATE INDEX "VerificationAttempt_status_checkType_idx" ON "VerificationAttempt"("status", "checkType");
CREATE INDEX "VerificationAttempt_sessionId_idx" ON "VerificationAttempt"("sessionId");

CREATE UNIQUE INDEX "ProviderEvent_provider_eventId_key" ON "ProviderEvent"("provider", "eventId");
CREATE INDEX "ProviderEvent_receivedAt_idx" ON "ProviderEvent"("receivedAt");

ALTER TABLE "VerificationAttempt" ADD CONSTRAINT "VerificationAttempt_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "VerificationSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
