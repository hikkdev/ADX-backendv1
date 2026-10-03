-- PB-3 (27 Sep 2026): the website's other coded pages become layout surfaces. Its own
-- migration so the next one may use the new values (Postgres will not use an enum value
-- in the transaction that added it).
ALTER TYPE "LayoutSurface" ADD VALUE IF NOT EXISTS 'WEB_CATEGORIES';
ALTER TYPE "LayoutSurface" ADD VALUE IF NOT EXISTS 'WEB_HOW_IT_WORKS';
ALTER TYPE "LayoutSurface" ADD VALUE IF NOT EXISTS 'WEB_ADVERTISE';
ALTER TYPE "LayoutSurface" ADD VALUE IF NOT EXISTS 'WEB_PUBLISHERS';
ALTER TYPE "LayoutSurface" ADD VALUE IF NOT EXISTS 'WEB_HELP';
