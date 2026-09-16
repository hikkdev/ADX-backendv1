import { closeDatabase, prisma } from '../shared/database';

/**
 * The controlled lists the pricing engine matches on.
 *
 * Without these the engine cannot accept a single row of market data — an
 * import rejects any slug it does not recognise, which is the whole point of
 * the lists. Threshold matching against free text splits "vinyl", "Vinyl" and
 * "flex vinyl" into three materials within a week of launch, and every
 * comparable set splits with them.
 *
 * This is a starting taxonomy, not a closed one. Ops extends it, and hundreds
 * more media types are expected; anything arriving that is not here is logged
 * as a proposal rather than silently created.
 *
 * Idempotent — safe to re-run. Existing rows are left as ops last edited them.
 */

/** Standard Indian OOH dimensions, in feet. */
const SIZE_CLASSES: { name: string; slug: string; widthFt: number; heightFt: number }[] = [
  { name: '10 x 5', slug: '10x5', widthFt: 10, heightFt: 5 },
  { name: '12 x 8', slug: '12x8', widthFt: 12, heightFt: 8 },
  { name: '15 x 10', slug: '15x10', widthFt: 15, heightFt: 10 },
  { name: '20 x 10', slug: '20x10', widthFt: 20, heightFt: 10 },
  { name: '20 x 15', slug: '20x15', widthFt: 20, heightFt: 15 },
  { name: '25 x 15', slug: '25x15', widthFt: 25, heightFt: 15 },
  { name: '30 x 10', slug: '30x10', widthFt: 30, heightFt: 10 },
  { name: '30 x 20', slug: '30x20', widthFt: 30, heightFt: 20 },
  { name: '40 x 10', slug: '40x10', widthFt: 40, heightFt: 10 },
  { name: '40 x 20', slug: '40x20', widthFt: 40, heightFt: 20 },
  { name: '50 x 20', slug: '50x20', widthFt: 50, heightFt: 20 },
  { name: '60 x 20', slug: '60x20', widthFt: 60, heightFt: 20 },
  { name: '5 x 4', slug: '5x4', widthFt: 5, heightFt: 4 },
  { name: '6 x 4', slug: '6x4', widthFt: 6, heightFt: 4 },
  { name: '8 x 4', slug: '8x4', widthFt: 8, heightFt: 4 },
  { name: '4 x 3', slug: '4x3', widthFt: 4, heightFt: 3 },
  { name: '3 x 2', slug: '3x2', widthFt: 3, heightFt: 2 },
];

const MATERIALS: { name: string; slug: string }[] = [
  { name: 'Flex', slug: 'flex' },
  { name: 'Star flex', slug: 'star-flex' },
  { name: 'Backlit flex', slug: 'backlit-flex' },
  { name: 'Vinyl', slug: 'vinyl' },
  { name: 'Perforated vinyl', slug: 'perforated-vinyl' },
  { name: 'Fabric', slug: 'fabric' },
  { name: 'Painted', slug: 'painted' },
  { name: 'Acrylic', slug: 'acrylic' },
  { name: 'Vitreous enamel', slug: 'vitreous-enamel' },
  { name: 'LED digital', slug: 'led-digital' },
  { name: 'LCD digital', slug: 'lcd-digital' },
];

/*
 * Media types used to be seeded here too — a couple of dozen generic names like
 * "Billboard" and "Gym Panel", each with no venue.
 *
 * `seedVenuesAndContent.ts` now seeds the client's own catalogue: 53 venues and
 * ~1,300 formats, every one of them filed under the venue it lives in. The
 * generic list was not a smaller version of that. It was the *venue-less* pool,
 * so a gym panel seeded here and a gym panel from the catalogue were two
 * different markets that could never be compared — and since the catalogue seed
 * prunes stale seeded types, the two scripts would have spent every run
 * deleting each other's work.
 *
 * Size classes, materials and the settings row stay: those are genuinely
 * cross-cutting, and no other script owns them.
 */

async function main(): Promise<void> {
  for (const size of SIZE_CLASSES) {
    await prisma.sizeClass.upsert({
      where: { slug: size.slug },
      update: {},
      create: {
        name: size.name,
        slug: size.slug,
        widthFt: size.widthFt,
        heightFt: size.heightFt,
        areaSqFt: size.widthFt * size.heightFt,
      },
    });
  }

  for (const material of MATERIALS) {
    await prisma.material.upsert({
      where: { slug: material.slug },
      update: {},
      create: material,
    });
  }

  // The engine reads this on every evaluation; the migration seeds it, and this
  // is the belt to that braces for a database restored without it.
  await prisma.pricingSettings.upsert({
    where: { id: 'default' },
    update: {},
    create: { id: 'default' },
  });

  console.log(
    `Pricing vocabulary seeded: ${SIZE_CLASSES.length} size classes, ` +
      `${MATERIALS.length} materials. Media types come from the catalogue — ` +
      `run "npm run seed:venues".`
  );
  await closeDatabase();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
