-- LH2 (the Lead Hunt, 22 Sep 2026): the three incentive events the pipeline
-- pays on (D1) — the rates are seeded by the service beside the others.
ALTER TYPE "IncentiveEvent" ADD VALUE 'LEAD_CONVERTED';
ALTER TYPE "IncentiveEvent" ADD VALUE 'LEAD_ACTIVATED';
ALTER TYPE "IncentiveEvent" ADD VALUE 'LEAD_RETAINED';
