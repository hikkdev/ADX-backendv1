-- DR 06 wave 2: LED-#### on a prospect.
--
-- Its own migration rather than an edit to 20260911070000_leads, which has
-- already been applied — changing an applied migration breaks its checksum and
-- every later deploy with it.
--
-- Minted through the same counter every other party uses. A second numbering
-- scheme is how two different things end up both called LED-0001.
ALTER TYPE "PartyType" ADD VALUE IF NOT EXISTS 'LEAD';
