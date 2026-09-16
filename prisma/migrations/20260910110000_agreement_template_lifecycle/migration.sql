-- The agreement gate needs a screen that writes a version, reads it over, and
-- only then makes it live — which means a version can exist without being
-- live, and the row has to say whether it ever was. `isActive` alone cannot:
-- a draft and a superseded version both read false, and only one of them may
-- still be edited (nobody has accepted a draft; somebody may have accepted
-- the other). Who wrote a version and why also belong on a legal document.

-- AlterTable
ALTER TABLE "AgreementTemplate"
  ADD COLUMN "activatedAt" TIMESTAMP(3),
  ADD COLUMN "retiredAt" TIMESTAMP(3),
  ADD COLUMN "createdByUserId" TEXT,
  ADD COLUMN "changeNote" TEXT;

-- Every row that exists was published and activated in one step, the only
-- path there was, so none is a draft: it went live when it became effective,
-- and the inactive ones were retired when the next version superseded them.
UPDATE "AgreementTemplate" SET "activatedAt" = "effectiveFrom";
UPDATE "AgreementTemplate" SET "retiredAt" = "updatedAt" WHERE "isActive" = false;
