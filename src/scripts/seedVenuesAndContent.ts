import { closeDatabase, prisma } from '../shared/database';
import type { ListingCategory } from '../shared/database';
import taxonomy from './data/ad-taxonomy.json';

/**
 * The venue and spot-type catalogue, from "Products and Services provided by ADX".
 *
 * That document is written as Advertising Type > Venue Category > Sub-Venues >
 * Advertising Formats, which is the shape the pricing engine already needs:
 * category and venue decide which pool a spot is compared against, and the
 * format is the media type inside it. `data/ad-taxonomy.json` is that document
 * parsed — 53 venues and 1,296 formats across indoor, outdoor and transport.
 *
 * Media advertising is deliberately absent. Its catalogue is a list of
 * television channels and newspapers, which have no venue, no dimensions and no
 * coordinates, so nothing about the comparables model applies to them. Forcing
 * them in would fill the taxonomy with rows that can never enter a pool.
 *
 * Venue is part of the comparable match key, so this list decides how the market
 * is divided. Adding a venue splits a pool; merging two joins them.
 *
 * Idempotent. Ops edits survive: an existing row keeps its name, description and
 * whatever sub-venues somebody has curated.
 */

type Format = {
  name: string;
  slug: string;
  group: string | null;
  description?: string;
  /** Named variants of one format — "Mega Unipoles: 40x20 ft face". */
  variants?: string[];
};

type Venue = {
  category: string;
  /** The catalogue heading a lettered sub-venue sat under, or null. */
  group: string | null;
  name: string;
  slug: string;
  subVenues: string[];
  formats: Format[];
};

const VENUES = taxonomy as Venue[];

/**
 * The six venues DR 02 drew, mapped onto the catalogue rows that supersede them.
 *
 * The design mock named a handful; the catalogue names fifty-three, and in every
 * case but one the mock's venue is a catalogue venue under a shorter label.
 * Renaming the existing row rather than adding a second one keeps its id, so the
 * listings and media types already filed under it stay where they are. Seeding
 * both would split every one of those pools in half — silently, and permanently,
 * because nothing downstream would ever report that two venues mean one market.
 *
 * "Gym / Spa / Salon" is the exception: the catalogue splits it into gyms and
 * salons. The row becomes the gym, which is the reading a spot filed under that
 * label is likeliest to have meant, and salons arrive as their own venue.
 */
const SUPERSEDED: Record<string, string> = {
  'gym-spa-salon': 'gyms-fitness-clubs-wellness-centers-yoga-studios',
  'office-coworking': 'business-centers-corporate-offices-coworking-spaces',
  'cinema-auditorium': 'multiplexes-cinemas-movie-theaters',
  'hospital-clinic': 'hospitals-clinics-diagnostic-centers-pharmacies-medical-faci',
  'school-college': 'colleges-universities-schools-educational-institutions',
  'shopping-mall': 'shopping-malls-retail-centers-department-stores',
};

/**
 * What a publisher will and will not carry, from DR 02 step 6.
 *
 * `isSensitive` marks the ones the design draws as checkboxes under Prohibited
 * Content rather than dropdowns under Restricted Categories. Same mechanism
 * underneath — a stance per listing — because "no alcohol" and "adult content is
 * never allowed here" are the same statement at different strengths. What
 * separates them is whether the owner can say yes: a restricted category runs
 * with their approval, a prohibited one never runs at all.
 */
const CONTENT_CATEGORIES = [
  { slug: 'healthcare-ads', name: 'Healthcare ads', isSensitive: false },
  { slug: 'financial-services', name: 'Financial services', isSensitive: false },
  { slug: 'political-religious', name: 'Political or religious content', isSensitive: false },
  // Not in the mock, and a real one in India: state lotteries are legal in some
  // states and betting is not, so a publisher has to be able to say no to it
  // separately from saying no to alcohol.
  { slug: 'gambling-betting', name: 'Gambling / betting', isSensitive: false },
  { slug: 'adult-content', name: 'Adult content', isSensitive: true },
  { slug: 'tobacco-alcohol', name: 'Tobacco / alcohol', isSensitive: true },
  { slug: 'violence-extremism', name: 'Violence or extremism', isSensitive: true },
];

/**
 * Earlier slugs the design has since merged, retired rather than deleted.
 *
 * DR 02 asks one question about political *or* religious content and one about
 * tobacco *or* alcohol; the first pass asked four. Two rows cannot be renamed
 * into one, and deleting them would take any stance a publisher has already
 * recorded with them. Deactivating keeps the history and stops them being
 * offered again.
 */
const SUPERSEDED_CATEGORIES = ['alcohol-bar', 'political-ads', 'religious-content', 'tobacco'];

/** A format's description, with its named variants folded in. */
function describe(format: Format): string | null {
  const parts = [format.description, format.variants?.join('; ')].filter(Boolean);
  return parts.length > 0 ? parts.join(' — ') : null;
}

/** Rows are inserted in batches; one round trip per media type would be 1,296. */
const CHUNK = 250;

async function renameSuperseded(): Promise<number> {
  let renamed = 0;
  for (const [oldSlug, newSlug] of Object.entries(SUPERSEDED)) {
    const existing = await prisma.venueType.findUnique({ where: { slug: oldSlug } });
    if (!existing) continue;
    // If the catalogue row has already been created separately, renaming would
    // collide on the unique slug. Leave both alone and say so: merging two
    // venues that already hold listings is an ops decision, not a seed's.
    if (await prisma.venueType.findUnique({ where: { slug: newSlug } })) {
      console.warn(
        `  ! "${oldSlug}" and "${newSlug}" both exist — they name one market, ` +
          `and every spot in it is now compared against half its neighbours. ` +
          `There is no venue merge: re-point the listings and media types on ` +
          `"${oldSlug}" to "${newSlug}" and retire it.`
      );
      continue;
    }
    const replacement = VENUES.find((v) => v.slug === newSlug);
    if (!replacement) continue;
    await prisma.venueType.update({
      where: { id: existing.id },
      data: { slug: newSlug, name: replacement.name, category: replacement.category as ListingCategory },
    });
    renamed += 1;
  }
  return renamed;
}

async function main(): Promise<void> {
  const renamed = await renameSuperseded();

  let venuesAdded = 0;
  let subVenuesFilled = 0;
  let backfilled = 0;
  const venueIdBySlug = new Map<string, string>();

  for (const venue of VENUES) {
    const existing = await prisma.venueType.findUnique({ where: { slug: venue.slug } });
    if (existing) {
      venueIdBySlug.set(venue.slug, existing.id);
      // Only when nobody has curated a list yet. Overwriting would undo an ops
      // edit every time this script runs.
      if (existing.subVenues.length === 0 && venue.subVenues.length > 0) {
        await prisma.venueType.update({
          where: { id: existing.id },
          data: { subVenues: venue.subVenues },
        });
        subVenuesFilled += 1;
      }
      continue;
    }
    const created = await prisma.venueType.create({
      data: {
        slug: venue.slug,
        name: venue.name,
        category: venue.category as ListingCategory,
        description: venue.group,
        subVenues: venue.subVenues,
      },
    });
    venueIdBySlug.set(venue.slug, created.id);
    venuesAdded += 1;
  }

  // Every slug already present, in one query. Checking per format would be
  // thirteen hundred round trips to a database in another region.
  const present = await prisma.mediaType.findMany({
    select: { slug: true, id: true, venueTypeId: true, formatGroup: true },
  });
  const known = new Map(present.map((row) => [row.slug, row]));

  const pending: {
    slug: string;
    name: string;
    category: ListingCategory;
    description: string | null;
    formatGroup: string | null;
    venueTypeId: string;
    origin: 'SEEDED';
  }[] = [];

  for (const venue of VENUES) {
    const venueTypeId = venueIdBySlug.get(venue.slug);
    if (!venueTypeId) continue;
    for (const format of venue.formats) {
      const existing = known.get(format.slug);
      if (existing) {
        // Backfill rather than skip. A row seeded before the venue level
        // existed sits at `venueTypeId: null`, which is not "unknown" — it is
        // the venue-less pool, where no indoor listing will ever look for it.
        // Skipping meant re-running the seed could never repair that.
        const repair = {
          ...(existing.venueTypeId === null ? { venueTypeId } : {}),
          ...(existing.formatGroup === null && format.group !== null
            ? { formatGroup: format.group }
            : {}),
        };
        if (Object.keys(repair).length > 0) {
          await prisma.mediaType.update({ where: { id: existing.id }, data: repair });
          backfilled += 1;
        }
        continue;
      }
      pending.push({
        slug: format.slug,
        // Named with its venue, because the same words mean different markets in
        // different buildings: a mall's floor graphic and a hospital's are not
        // comparable, and an ops screen listing both as "Floor Graphics" gives
        // nobody a way to tell them apart.
        name: `${venue.name} — ${format.name}`,
        category: venue.category as ListingCategory,
        description: describe(format),
        formatGroup: format.group,
        venueTypeId,
        origin: 'SEEDED',
      });
    }
  }

  let spotsAdded = 0;
  for (let offset = 0; offset < pending.length; offset += CHUNK) {
    const batch = pending.slice(offset, offset + CHUNK);
    const { count } = await prisma.mediaType.createMany({ data: batch, skipDuplicates: true });
    spotsAdded += count;
  }

  // Formats the catalogue no longer names, dropped only when nothing points at
  // them. Re-parsing the source document is how a mistake in it gets fixed —
  // three formats were once read as one line and became a single media type,
  // merging three comparable pools — and without this the wrong row would
  // outlive every correction. Guarded hard: seeded origin only, and only when
  // no listing, no observation and no merge references it.
  const catalogueSlugs = new Set(VENUES.flatMap((v) => v.formats.map((f) => f.slug)));
  const orphans = await prisma.mediaType.findMany({
    where: {
      origin: 'SEEDED',
      slug: { notIn: [...catalogueSlugs] },
      mergedIntoId: null,
      listings: { none: {} },
      dataPoints: { none: {} },
      mergedFrom: { none: {} },
    },
    select: { id: true, slug: true },
  });
  let pruned = 0;
  if (orphans.length > 0) {
    const { count } = await prisma.mediaType.deleteMany({
      where: { id: { in: orphans.map((row) => row.id) } },
    });
    pruned = count;
    for (const orphan of orphans) console.log(`  - dropped stale spot type ${orphan.slug}`);
  }

  let categoriesAdded = 0;
  for (const category of CONTENT_CATEGORIES) {
    const existing = await prisma.contentCategory.findUnique({ where: { slug: category.slug } });
    if (existing) continue;
    await prisma.contentCategory.create({ data: category });
    categoriesAdded += 1;
  }

  const { count: categoriesRetired } = await prisma.contentCategory.updateMany({
    where: { slug: { in: SUPERSEDED_CATEGORIES }, isActive: true },
    data: { isActive: false },
  });

  console.log(
    `Venues: ${VENUES.length} in the catalogue, ${venuesAdded} added, ${renamed} renamed off ` +
      `their DR 02 labels, ${subVenuesFilled} given sub-venues.\n` +
      `Spot types: ${spotsAdded} added, ${backfilled} given a venue or group, ` +
      `${pruned} stale ones dropped.\n` +
      `Content categories added: ${categoriesAdded}, ${categoriesRetired} superseded ones retired.`
  );
  await closeDatabase();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
