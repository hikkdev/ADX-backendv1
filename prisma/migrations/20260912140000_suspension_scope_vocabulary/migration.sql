-- Lot A: one suspension vocabulary for every party. The 110000 migration
-- carried agent-only names (OFFERS, OPEN_WORK) beside the publisher ones
-- (STOP_ORDERS); an agent's "no new offers" is BLOCK_NEW and "release what is
-- in flight" is STOP_OPEN_WORK, the same words a listing, a publisher and an
-- advertiser use. Every array is still empty, so the cast carries no data.
ALTER TYPE "SuspensionScope" RENAME TO "SuspensionScope_old";
CREATE TYPE "SuspensionScope" AS ENUM ('BLOCK_NEW', 'STOP_OPEN_WORK', 'STOP_ACCRUAL', 'FREEZE_WALLET', 'BLOCK_SIGNIN');

ALTER TABLE "Listing"
  ALTER COLUMN "suspensionScopes" DROP DEFAULT,
  ALTER COLUMN "suspensionScopes" TYPE "SuspensionScope"[] USING "suspensionScopes"::text[]::"SuspensionScope"[],
  ALTER COLUMN "suspensionScopes" SET DEFAULT ARRAY[]::"SuspensionScope"[];
ALTER TABLE "Publisher"
  ALTER COLUMN "suspensionScopes" DROP DEFAULT,
  ALTER COLUMN "suspensionScopes" TYPE "SuspensionScope"[] USING "suspensionScopes"::text[]::"SuspensionScope"[],
  ALTER COLUMN "suspensionScopes" SET DEFAULT ARRAY[]::"SuspensionScope"[];
ALTER TABLE "Advertiser"
  ALTER COLUMN "suspensionScopes" DROP DEFAULT,
  ALTER COLUMN "suspensionScopes" TYPE "SuspensionScope"[] USING "suspensionScopes"::text[]::"SuspensionScope"[],
  ALTER COLUMN "suspensionScopes" SET DEFAULT ARRAY[]::"SuspensionScope"[];
ALTER TABLE "AgentProfile"
  ALTER COLUMN "suspensionScopes" DROP DEFAULT,
  ALTER COLUMN "suspensionScopes" TYPE "SuspensionScope"[] USING "suspensionScopes"::text[]::"SuspensionScope"[],
  ALTER COLUMN "suspensionScopes" SET DEFAULT ARRAY[]::"SuspensionScope"[];
ALTER TABLE "PartySuspensionEvent"
  ALTER COLUMN "scopes" DROP DEFAULT,
  ALTER COLUMN "scopes" TYPE "SuspensionScope"[] USING "scopes"::text[]::"SuspensionScope"[],
  ALTER COLUMN "scopes" SET DEFAULT ARRAY[]::"SuspensionScope"[];

DROP TYPE "SuspensionScope_old";
