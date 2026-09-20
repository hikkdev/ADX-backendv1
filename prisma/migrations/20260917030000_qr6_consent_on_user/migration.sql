-- QR-6 (17 Sep 2026): the terms of use and privacy policy consent, stamped
-- on the person with the versions live at the click. Additive.
ALTER TABLE "User" ADD COLUMN "consentAcceptedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "consentTermsVersion" INTEGER;
ALTER TABLE "User" ADD COLUMN "consentPrivacyVersion" INTEGER;
