-- Where the publisher is, as given at sign-up.
--
-- This is the meeting point an agent is sent to when a booking is accepted. It
-- was a required field on the accept endpoint that no screen ever collected, so
-- every publisher acceptance answered 400; the address had to exist before it
-- could be the default. Nullable because the publishers already in the table
-- were never asked, and city/state stand in until they are.
ALTER TABLE "Publisher" ADD COLUMN "address" TEXT;
