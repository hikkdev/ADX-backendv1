-- Lot E7 addendum: the push knows what its relatedId names, and a notice can carry structured facts.
ALTER TABLE "Notification" ADD COLUMN "relatedType" TEXT;
ALTER TABLE "Notification" ADD COLUMN "payload" JSONB;
