import { closeDatabase, prisma } from '../shared/database';

/**
 * Commission, fees and tax as ADX intends to start.
 *
 * Every figure here is a placeholder that market research will move — the
 * platform fee in particular is described as varying with live testing. What is
 * *not* placeholder is the shape: which fees exist, which are named in the cart,
 * and what tax each carries.
 *
 * Idempotent. Rates are inserted only when none is active, because replacing a
 * live commission rate is a commercial decision that belongs to ops rather than
 * to whoever last ran a seed script.
 */

const COMMISSION_DEFAULT_PCT = '0.15';

/**
 * `amountShownInCart` is the only field here with a legal edge to it.
 *
 * Design is shown with its amount because an advertiser deciding whether ADX
 * should make their creative is deciding that in the cart. The others are named
 * in the cart without their amounts and totalled at checkout — which is the
 * commercial intent, and stays the right side of the CCPA's drip-pricing
 * guidance precisely because they are *named*.
 */
const FEES = [
  {
    kind: 'PLATFORM' as const,
    name: 'Platform fee',
    percentPct: '0.005',
    flatAmount: null,
    gstPct: '0.18',
    amountShownInCart: false,
    perSpot: false,
  },
  {
    kind: 'INSTALLATION' as const,
    name: 'Installation',
    percentPct: null,
    flatAmount: '1500.00',
    gstPct: '0.18',
    amountShownInCart: false,
    perSpot: true,
  },
  {
    kind: 'PRINTING' as const,
    name: 'Printing',
    percentPct: null,
    flatAmount: '2500.00',
    // Printed matter is taxed differently from the advertising service it
    // carries, which is exactly why GST is per line rather than one rate over a
    // total.
    gstPct: '0.05',
    amountShownInCart: false,
    perSpot: true,
  },
  {
    kind: 'DESIGN' as const,
    name: 'Creative design',
    percentPct: null,
    flatAmount: '5000.00',
    gstPct: '0.18',
    amountShownInCart: true,
    perSpot: false,
  },
];

async function main(): Promise<void> {
  const existingDefault = await prisma.commissionRate.findFirst({
    where: { category: null, isActive: true },
  });
  if (existingDefault) {
    console.log('Platform commission already set — left alone.');
  } else {
    await prisma.commissionRate.create({
      data: { category: null, ratePct: COMMISSION_DEFAULT_PCT, note: 'Seeded default' },
    });
    console.log(`Platform commission seeded at ${COMMISSION_DEFAULT_PCT}.`);
  }

  let added = 0;
  for (const fee of FEES) {
    const already = await prisma.feeSchedule.findFirst({
      where: { kind: fee.kind, isActive: true },
    });
    if (already) continue;
    await prisma.feeSchedule.create({ data: fee });
    added += 1;
  }
  console.log(`Fees seeded: ${added} added, ${FEES.length - added} already present.`);

  await prisma.taxSettings.upsert({
    where: { id: 'default' },
    update: {},
    create: { id: 'default' },
  });

  await closeDatabase();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
