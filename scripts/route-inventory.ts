/**
 * Writes docs/route-inventory.json — the baseline the structure-only modular
 * refactor is verified against. See scripts/collect-routes.ts for how the
 * route tree is recovered from Express 5.
 *
 * Usage:  npx tsx scripts/route-inventory.ts            # print JSON
 *         npx tsx scripts/route-inventory.ts --write    # write the snapshot
 */
import fs from 'fs';
import path from 'path';
import { collectRoutes, type RouteInventory } from './collect-routes';

async function main(): Promise<void> {
  const routes = await collectRoutes();
  const snapshot: RouteInventory = {
    generatedBy: 'scripts/route-inventory.ts',
    routeCount: routes.length,
    routes,
  };
  const json = `${JSON.stringify(snapshot, null, 2)}
`;

  if (process.argv.includes('--write')) {
    const out = path.resolve(__dirname, '../docs/route-inventory.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, json);
    console.log(`Wrote ${routes.length} routes to ${path.relative(process.cwd(), out)}`);
  } else {
    process.stdout.write(json);
  }

  process.exit(0);
}

void main();
