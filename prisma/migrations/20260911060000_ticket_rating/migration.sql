-- DR 07 wave 6: the periodic satisfaction score, on the ticket that carries it.
ALTER TABLE "SupportTicket" ADD COLUMN "rating" INTEGER;
ALTER TABLE "SupportTicket" ADD COLUMN "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];
