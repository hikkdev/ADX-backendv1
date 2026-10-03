import { prisma, closeDatabase } from '../shared/database';
import { seedAppConfig, wizardFlowSchema } from '../modules/app-config';
import { buildListingFlow, type CityOption } from './data/listing-flow';

/**
 * LF-2 (28 Sep 2026): write `flows.listing` from `data/listing-flow.ts` — and
 * nothing else.
 *
 * `seed:config` writes all four flows and the enums at once, which would put
 * the code's onboarding ladder back over one the Flow Editor changed. This
 * writes the listing flow alone, through the same versioned door (the old
 * flow kept as `flows.listing:v<N>`, the number moving on by one), and
 * refuses when the stored flow asks something the code's does not — that
 * would be an edit made in the Flow Editor, which this must not erase.
 *
 *   npm run seed:listing-flow            write it
 *   npm run seed:listing-flow -- --check say what would change, write nothing
 */

type Field = { id?: unknown };
type Screen = { key?: unknown; fields?: Field[] };
type Flow = { screens?: Screen[]; branches?: Record<string, { screens?: Screen[] }> };

function fieldIds(flow: Flow): Set<string> {
  const ids = new Set<string>();
  const walk = (screens: Screen[] | undefined, prefix: string) => {
    for (const screen of screens ?? []) for (const field of screen.fields ?? []) if (typeof field.id === 'string') ids.add(`${prefix}${field.id}`);
  };
  walk(flow.screens, '');
  for (const [key, branch] of Object.entries(flow.branches ?? {})) walk(branch.screens, `${key}:`);
  return ids;
}

async function cities(): Promise<CityOption[]> {
  const rows = await prisma.city.findMany({ where: { isActive: true }, orderBy: { name: 'asc' }, select: { name: true } });
  if (rows.length === 0) throw new Error('The City table is empty. Run `npm run seed:cities` first — the listing flow offers that table.');
  return rows.map((city) => ({ id: city.name, title: city.name }));
}

async function main() {
  const check = process.argv.includes('--check');
  const next = buildListingFlow(await cities());
  wizardFlowSchema.parse(next);

  const row = await prisma.appConfig.findUnique({ where: { key: 'main' } });
  const document = (row?.value ?? {}) as { flows?: Record<string, Flow>; enums?: Record<string, unknown> };
  const stored = document.flows?.['listing'];

  const before = stored ? fieldIds(stored) : new Set<string>();
  const after = fieldIds(next as Flow);
  const added = [...after].filter((id) => !before.has(id));
  const lost = [...before].filter((id) => !after.has(id));
  console.log(`flows.listing: ${added.length} question(s) to add, ${lost.length} the code no longer asks.`);
  for (const id of added) console.log(`  + ${id}`);
  for (const id of lost) console.log(`  - ${id}`);

  if (lost.length > 0) {
    console.error('Refusing: the stored flow asks questions the code does not — an edit made in the Flow Editor. Put them into data/listing-flow.ts first.');
    process.exitCode = 1;
    return;
  }
  if (check) return;

  const report = await seedAppConfig({ flows: { listing: next as unknown as Record<string, unknown> }, enums: document.enums ?? {} });
  const listing = report['listing']!;
  console.log(`flows.listing: v${listing.version}${listing.changed ? '' : ' (unchanged)'}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
