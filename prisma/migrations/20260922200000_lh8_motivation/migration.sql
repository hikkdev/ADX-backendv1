-- LH8 (the Lead Hunt, motivation layer): two milestone types the board can
-- count on — lead conversions and first contacts inside a window — so the
-- seeded "5 lead conversions this month" and "10 first contacts this week"
-- templates have a type to derive from.

-- AlterEnum
ALTER TYPE "MilestoneType" ADD VALUE 'LEAD_CONVERSIONS';
ALTER TYPE "MilestoneType" ADD VALUE 'LEAD_CONTACTS';
