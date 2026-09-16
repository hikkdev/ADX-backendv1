-- Register-or-login: an unknown number may now ask for an OTP and gets a
-- roleless User row at send time, because Otp.userId is NOT NULL and the code
-- has to reference something. This column records when that number first
-- entered a correct code. A row with it still null is a number that asked and
-- never proved itself — harmless, since no token is issued without a verified
-- code, and this is what a cleanup job would key on.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "mobileVerifiedAt" TIMESTAMP(3);
