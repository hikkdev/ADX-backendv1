-- Lot J2: subscription configuration — auto-renew, free trials.
ALTER TYPE "PackagePaymentMethod" ADD VALUE 'TRIAL';
ALTER TABLE "PublisherSubscription" ADD COLUMN "autoRenew" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PackageSale" ADD COLUMN "autoRenew" BOOLEAN NOT NULL DEFAULT false;
