import { closeDatabase, prisma } from '../shared/database';
import {
  AGENT_JOB_FLOW_KEY,
  APP_ENUMS,
  EMPLOYEE_INTAKE_FLOW_KEY,
  agentJobLadderSchema,
  employeeIntakeLadderSchema,
  onboardingTemplateSchema,
  seedAppConfig,
  wizardFlowSchema,
} from '../modules/app-config';
import { CODE_ONBOARDING_TEMPLATE } from '../modules/users';
import { CODE_AGENT_JOB_LADDER } from '../modules/orders';
import { CODE_EMPLOYEE_INTAKE_LADDER } from '../modules/kyc';
import { buildListingFlow } from './data/listing-flow';

/**
 * The onboarding ladder (Q83) is no longer typed here. `flows.onboarding` is
 * the phone's DR 08 ladder in the template vocabulary of
 * `app-config/onboarding-template.ts`, and the seed writes the ladder the
 * code falls back to — `CODE_ONBOARDING_TEMPLATE` in `users` — so the
 * manifest served from the row is byte-identical to the one served without
 * it. The console edits it from there through `PATCH /config/flows/onboarding`.
 *
 * The wizard-shaped "Onboarding" flow that used to sit here (profile type,
 * documents, personal details, a monthly price on a slider) was never read by
 * anything; it predates the DR 08 ladder.
 */

import type { CityOption } from './data/listing-flow';

/**
 * The city list the phone offers — read from the `City` table, never typed here.
 *
 * Inventory matching compares this column exactly (case-insensitively) — see
 * `prisma-campaigns.repository.ts` — so "Bangalore" and "Bengaluru" are two
 * markets rather than one city spelled two ways, and a MARKET_OR_DMA campaign
 * naming the canonical one matches none of the other. Both ends of that
 * comparison have to be choosing from one vocabulary, and that vocabulary is
 * the `City` table `seedCities.ts` fills.
 *
 * It used to be a hand-written list of twenty-five names sitting in this file,
 * which is how a second vocabulary gets born: the table already held forty-four
 * cities with their aliases, the apps' `src/lib/cities.ts` mirrors that table
 * for the advertiser's market picker, and nineteen markets an advertiser could
 * target were missing from what a publisher was offered — so a publisher in
 * Patna was told their city was not one of ADX's markets while a campaign was
 * buying it. Reading the table means the two cannot drift again.
 *
 * Suggestions rather than a closed set, still: a spot in a town the table has
 * not reached has to be listable, and a name that resolves to nothing simply
 * never matches on city, which is a visible failure rather than a wrong match.
 */
async function suggestedCities(): Promise<CityOption[]> {
  const rows = await prisma.city.findMany({
    where: { isActive: true },
    orderBy: { name: 'asc' },
    select: { name: true },
  });
  if (rows.length === 0) {
    // Loud rather than empty. A config seeded with no cities turns the listing
    // field back into the free-text box that put the city inside the address.
    throw new Error(
      'The City table is empty. Run `npm run seed:cities` before `npm run seed:config` — ' +
        'the listing flow offers that table and nothing else.',
    );
  }
  return rows.map((city) => ({ id: city.name, title: city.name }));
}

async function main() {
  // The branches are built here rather than at module scope because one field
  // on them is read from the database: the city list is the `City` table's, and
  // a list this file invented for itself is what the apps had to disagree with.
  const cities = await suggestedCities();
  const listing = buildListingFlow(cities);

  // Both flows go through the vocabulary the console's PATCH enforces, so a
  // seed that drifts from what the apps render fails here rather than on a
  // phone. The versions carry forward (Lot F, through `seedAppConfig`): a
  // flow the console has since bumped keeps its number when the seed writes
  // byte-equal content, and moves on by one when the content differs —
  // never backwards — with the replaced flow kept as `flows.<key>:v<N>`
  // the way the editor keeps it, so a party mid-ladder is still served the
  // version they started on.
  wizardFlowSchema.parse(listing);
  onboardingTemplateSchema.parse(CODE_ONBOARDING_TEMPLATE);
  // Lot G (Q126/Q141): the two step ladders, seeded from the code ladders
  // `orders` and `kyc/employee` fall back to, through the same door.
  agentJobLadderSchema.parse(CODE_AGENT_JOB_LADDER);
  employeeIntakeLadderSchema.parse(CODE_EMPLOYEE_INTAKE_LADDER);

  const report = await seedAppConfig({
    flows: {
      onboarding: CODE_ONBOARDING_TEMPLATE as unknown as Record<string, unknown>,
      listing: listing as unknown as Record<string, unknown>,
      [AGENT_JOB_FLOW_KEY]: CODE_AGENT_JOB_LADDER as unknown as Record<string, unknown>,
      [EMPLOYEE_INTAKE_FLOW_KEY]: CODE_EMPLOYEE_INTAKE_LADDER as unknown as Record<string, unknown>,
    },
    enums: APP_ENUMS,
  });

  for (const [key, { version, changed }] of Object.entries(report)) {
    console.log(`flows.${key}: v${version}${changed ? '' : ' (unchanged)'}`);
  }
  console.log('AppConfig seeded successfully.');
  await closeDatabase();
}

main().catch((e) => { console.error(e); process.exit(1); });
