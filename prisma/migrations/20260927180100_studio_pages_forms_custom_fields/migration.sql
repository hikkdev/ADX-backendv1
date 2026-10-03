-- PB-1…PB-6, FM-1, CF-1 (27 Sep 2026): Studio pages + addresses + redirects, forms, custom fields.

CREATE TYPE "SitePageKind" AS ENUM ('SYSTEM', 'CUSTOM');
CREATE TYPE "SitePageChannel" AS ENUM ('WEBSITE', 'APPS');
CREATE TYPE "SiteRedirectReason" AS ENUM ('ADDRESS_CHANGE', 'MANUAL');
CREATE TYPE "FormDestination" AS ENUM ('LEAD', 'SUPPORT', 'INBOX');
CREATE TYPE "FormAudience" AS ENUM ('PUBLIC', 'SIGNED_IN');
CREATE TYPE "FormSubmissionStatus" AS ENUM ('NEW', 'READ', 'ARCHIVED');
CREATE TYPE "CustomFieldEntity" AS ENUM ('PUBLISHER', 'ADVERTISER', 'LISTING', 'LEAD');

CREATE TABLE "SitePage" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" "SitePageKind" NOT NULL,
    "title" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "internalPath" TEXT,
    "surface" "LayoutSurface",
    "channels" "SitePageChannel"[] DEFAULT ARRAY['WEBSITE']::"SitePageChannel"[],
    "addressLocked" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SitePage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SitePage_key_key" ON "SitePage"("key");
CREATE UNIQUE INDEX "SitePage_path_key" ON "SitePage"("path");
CREATE UNIQUE INDEX "SitePage_surface_key" ON "SitePage"("surface");
CREATE INDEX "SitePage_kind_archivedAt_idx" ON "SitePage"("kind", "archivedAt");

CREATE TABLE "SiteRedirect" (
    "id" TEXT NOT NULL,
    "fromPath" TEXT NOT NULL,
    "toPath" TEXT NOT NULL,
    "pageId" TEXT,
    "permanent" BOOLEAN NOT NULL DEFAULT true,
    "reason" "SiteRedirectReason" NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SiteRedirect_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SiteRedirect_fromPath_key" ON "SiteRedirect"("fromPath");
CREATE INDEX "SiteRedirect_pageId_idx" ON "SiteRedirect"("pageId");
ALTER TABLE "SiteRedirect" ADD CONSTRAINT "SiteRedirect_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "SitePage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "LayoutVersion" ALTER COLUMN "surface" DROP NOT NULL;
ALTER TABLE "LayoutVersion" ADD COLUMN "pageId" TEXT;
ALTER TABLE "LayoutVersion" ADD COLUMN "meta" JSONB;
CREATE UNIQUE INDEX "LayoutVersion_pageId_number_key" ON "LayoutVersion"("pageId", "number");
CREATE INDEX "LayoutVersion_pageId_status_idx" ON "LayoutVersion"("pageId", "status");
ALTER TABLE "LayoutVersion" ADD CONSTRAINT "LayoutVersion_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "SitePage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LayoutVersion" ADD CONSTRAINT "LayoutVersion_surface_or_page_check" CHECK (("surface" IS NULL) <> ("pageId" IS NULL));

CREATE TABLE "Form" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "destination" "FormDestination" NOT NULL DEFAULT 'INBOX',
    "leadSide" TEXT,
    "audience" "FormAudience" NOT NULL DEFAULT 'PUBLIC',
    "notifyEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdByUserId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Form_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Form_key_key" ON "Form"("key");
CREATE INDEX "Form_archivedAt_idx" ON "Form"("archivedAt");

CREATE TABLE "FormVersion" (
    "id" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "LayoutVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "definition" JSONB NOT NULL,
    "changeNote" TEXT,
    "createdByUserId" TEXT,
    "publishedById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FormVersion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FormVersion_formId_number_key" ON "FormVersion"("formId", "number");
CREATE INDEX "FormVersion_formId_status_idx" ON "FormVersion"("formId", "status");
ALTER TABLE "FormVersion" ADD CONSTRAINT "FormVersion_formId_fkey" FOREIGN KEY ("formId") REFERENCES "Form"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "FormSubmission" (
    "id" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "formVersion" INTEGER NOT NULL,
    "answers" JSONB NOT NULL,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "address" TEXT,
    "cityId" TEXT,
    "userId" TEXT,
    "leadId" TEXT,
    "ticketId" TEXT,
    "status" "FormSubmissionStatus" NOT NULL DEFAULT 'NEW',
    "source" TEXT,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "consentAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FormSubmission_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FormSubmission_formId_status_createdAt_idx" ON "FormSubmission"("formId", "status", "createdAt");
CREATE INDEX "FormSubmission_cityId_idx" ON "FormSubmission"("cityId");
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_formId_fkey" FOREIGN KEY ("formId") REFERENCES "Form"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CustomFieldDef" (
    "id" TEXT NOT NULL,
    "entity" "CustomFieldEntity" NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "options" JSONB,
    "hint" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "showOnDesk" BOOLEAN NOT NULL DEFAULT true,
    "showInApps" BOOLEAN NOT NULL DEFAULT false,
    "showOnWebsite" BOOLEAN NOT NULL DEFAULT false,
    "editableByOwner" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CustomFieldDef_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CustomFieldDef_entity_key_key" ON "CustomFieldDef"("entity", "key");
CREATE INDEX "CustomFieldDef_entity_archivedAt_idx" ON "CustomFieldDef"("entity", "archivedAt");

CREATE TABLE "CustomFieldValue" (
    "id" TEXT NOT NULL,
    "defId" TEXT NOT NULL,
    "entity" "CustomFieldEntity" NOT NULL,
    "entityId" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CustomFieldValue_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CustomFieldValue_defId_entityId_key" ON "CustomFieldValue"("defId", "entityId");
CREATE INDEX "CustomFieldValue_entity_entityId_idx" ON "CustomFieldValue"("entity", "entityId");
ALTER TABLE "CustomFieldValue" ADD CONSTRAINT "CustomFieldValue_defId_fkey" FOREIGN KEY ("defId") REFERENCES "CustomFieldDef"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The website's nine own pages, at the addresses they answer today. Home's address is locked.
INSERT INTO "SitePage" ("id", "key", "kind", "title", "path", "internalPath", "surface", "channels", "addressLocked", "updatedAt") VALUES
  ('sp_home',         'home',         'SYSTEM', 'Home',                  '/',             '/',             'WEB_HOME',         ARRAY['WEBSITE']::"SitePageChannel"[], true,  CURRENT_TIMESTAMP),
  ('sp_explore',      'explore',      'SYSTEM', 'Explore ad spaces',     '/spaces',       '/spaces',       'WEB_EXPLORE',      ARRAY['WEBSITE']::"SitePageChannel"[], false, CURRENT_TIMESTAMP),
  ('sp_listing',      'listing',      'SYSTEM', 'Listing page',          '/spaces/:id',   '/spaces/:id',   'WEB_LISTING',      ARRAY['WEBSITE']::"SitePageChannel"[], false, CURRENT_TIMESTAMP),
  ('sp_categories',   'categories',   'SYSTEM', 'All categories',        '/categories',   '/categories',   'WEB_CATEGORIES',   ARRAY['WEBSITE']::"SitePageChannel"[], false, CURRENT_TIMESTAMP),
  ('sp_formats',      'formats',      'SYSTEM', 'Advertising formats',   '/formats',      '/formats',      'WEB_FORMATS',      ARRAY['WEBSITE']::"SitePageChannel"[], false, CURRENT_TIMESTAMP),
  ('sp_how_it_works', 'how-it-works', 'SYSTEM', 'How it works',          '/how-it-works', '/how-it-works', 'WEB_HOW_IT_WORKS', ARRAY['WEBSITE']::"SitePageChannel"[], false, CURRENT_TIMESTAMP),
  ('sp_advertise',    'advertise',    'SYSTEM', 'Advertise with ADX',    '/advertise',    '/advertise',    'WEB_ADVERTISE',    ARRAY['WEBSITE']::"SitePageChannel"[], false, CURRENT_TIMESTAMP),
  ('sp_publishers',   'publishers',   'SYSTEM', 'For publishers',        '/publishers',   '/publishers',   'WEB_PUBLISHERS',   ARRAY['WEBSITE']::"SitePageChannel"[], false, CURRENT_TIMESTAMP),
  ('sp_help',         'help',         'SYSTEM', 'Help',                  '/help',         '/help',         'WEB_HELP',         ARRAY['WEBSITE']::"SitePageChannel"[], false, CURRENT_TIMESTAMP);
