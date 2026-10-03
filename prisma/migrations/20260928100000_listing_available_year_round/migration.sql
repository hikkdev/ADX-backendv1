-- LF-2 (28 Sep 2026): "Available year-round?" gets its own column. It was written onto
-- `availableNow`, the live occupied flag the campaign planner filters on and orders flip,
-- so a seasonal spot vanished from planning and the next booking erased the answer.
ALTER TABLE "Listing" ADD COLUMN IF NOT EXISTS "availableYearRound" BOOLEAN;
