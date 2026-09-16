-- The catalogue groups a venue's formats under headings. Presentation only:
-- a mall has sixty-four formats and one flat list is unusable, but nothing in
-- the comparable match key reads this.
-- AlterTable
ALTER TABLE "MediaType" ADD COLUMN "formatGroup" TEXT;
