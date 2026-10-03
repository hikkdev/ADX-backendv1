-- 3 Oct 2026: the verification queue logs a visit to the publisher as a compliance contact attempt.
ALTER TYPE "ContactAttemptChannel" ADD VALUE IF NOT EXISTS 'VISIT';
