import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { prismaSectionOverviewsRepository } from '../prisma-section-overviews.repository';
import type { SectionOverviewsRepository } from '../section-overviews.repository';
import { NOW, QUERY, advertisersSeed, agentsSeed, employeesSeed, printPartnersSeed, publishersSeed, usersSeed } from './fixtures';
import { inMemoryRepository, type Seed } from './in-memory.repository';
import { resolveWindow } from '../section-overviews.service';

/**
 * O-B: the repository is aggregates only.
 *
 * Every method resolves to a number, a decimal string, null, a map of
 * numbers, or grouped counts — an array of groups keyed by a string with
 * numeric or money fields beside it. Nothing carries a Date, an id beyond
 * the group's key, or a nested record. The table below names every method
 * of the port with the arguments it takes; the Prisma repository's own keys
 * must match it, so a method added to one and not the other fails here.
 * The Prisma source is also read as text: no `findFirst`, `findUnique`,
 * `create`, `update` or `delete`, and one `findMany` — the department
 * table's names beside their member counts, a group per department.
 */

const resolved = resolveWindow(QUERY, NOW);
const window = resolved.window;
const scope = { city: 'Bengaluru' };

type Method = keyof SectionOverviewsRepository;
const CALLS: Record<Method, unknown[]> = {
  publishersAsAt: [window.end, scope],
  publishersCreated: [window, scope],
  publishersCreatedByDay: [window, scope],
  publishersWithLiveListing: [scope],
  publishersKycByState: [scope],
  publishersSuspended: [scope],
  publishersClosed: [scope],
  publishersFirstListingByDay: [window, scope],
  publishersFirstBookingByDay: [window, scope],
  publishersByCity: [window, scope],
  publishersByCategory: [scope],
  runningSubscriptionsByTier: [NOW, scope],
  publishersByAgent: [scope],
  topPublishersByEarnings: [window, scope, 10],
  publisherEarningsNet: [window, scope],
  publisherPayoutsReleased: [window, scope],
  advertisersAsAt: [window.end, scope],
  advertisersCreated: [window, scope],
  advertisersCreatedByDay: [window, scope],
  advertisersWithLiveCampaign: [window, scope],
  advertisersKycByState: [scope],
  advertisersByIndustry: [scope],
  advertisersFirstCampaignByDay: [window, scope],
  advertiserSpendByDay: [window, scope],
  advertisersByCity: [window, scope],
  activePackageSalesByTier: [scope],
  advertisersByAgent: [scope],
  topAdvertisersBySpend: [window, scope, 10],
  advertiserWalletBalance: [scope],
  advertiserTopUps: [window, scope],
  agentsAsAt: [window.end, scope],
  agentsCreated: [window, scope],
  agentsActive: [window, scope],
  agentsByRole: [scope],
  agentsByTier: [scope],
  agentsKycByState: [scope],
  agentsSuspended: [scope],
  onboardingsByDay: [window, scope],
  visitsCompletedByDay: [window, scope],
  jobsCompletedByDay: [window, scope],
  agentsByCity: [scope],
  topAgentsByCommission: [window, scope, 10],
  incentivesPaid: [window, scope],
  printPartnersAsAt: [window.end, scope],
  printPartnersCreated: [window, scope],
  printPartnersActive: [scope],
  printPartnersAcceptingQuotes: [scope],
  printPartnersKycByState: [scope],
  printPartnersByCity: [scope],
  quoteRequestsByDay: [window, scope],
  quotesReceivedByDay: [window, scope],
  printJobsCompletedByDay: [window, scope],
  printPartnersByCapability: [scope],
  topPrintPartners: [window, scope, 10],
  printTurnaroundDays: [window, scope],
  quoteAwards: [window, scope],
  employeesJoined: [window],
  employeesByDepartment: [],
  employeesByWorkMode: [],
  employeesByEmploymentType: [],
  employeesByRegion: [],
  employeesKycByState: [],
  employeesTenure: [NOW],
  holidaysInWindow: [window],
  usersAsAt: [window.end, scope],
  usersCreated: [window, scope],
  usersCreatedByDay: [window, scope],
  usersByRole: [scope],
  usersWithoutRole: [scope],
  usersActive: [window, scope],
  usersSignInsByDay: [window, scope],
  adminsTwoFactor: [],
  usersClosed: [scope],
  usersClosedInWindow: [window, scope],
  erasureRequestsOpen: [],
  contactsVerified: [scope],
  usersByLanguage: [scope],
  usersByPartyCity: [scope],
};

const MONEY = /^-?\d+\.\d{2}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isMoney = (value: unknown): boolean => typeof value === 'string' && MONEY.test(value);
const isCount = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value);

/**
 * A group: a string `key` (or `day`), an optional string `label`, and nothing
 * else but numbers and money. Lot X-B: a city group instead carries the key
 * as `cityId` with its `slug` and `name` (each a string, or null for the one
 * "typed" bucket) and the typed strings — still no row.
 */
const isCityGroup = (record: Record<string, unknown>): boolean =>
  'cityId' in record &&
  ['cityId', 'slug', 'name'].every((field) => record[field] === null || typeof record[field] === 'string') &&
  Array.isArray(record['typed']) &&
  (record['typed'] as unknown[]).every((s) => typeof s === 'string');
function isGroup(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const city = isCityGroup(record);
  const hasKey = city || typeof record['key'] === 'string' || (typeof record['day'] === 'string' && DAY.test(record['day']));
  if (!hasKey) return false;
  return Object.entries(record).every(([field, entry]) => {
    if (city && ['cityId', 'slug', 'name', 'typed'].includes(field)) return true;
    if (field === 'key' || field === 'day') return typeof entry === 'string';
    if (field === 'label') return typeof entry === 'string';
    return isCount(entry) || isMoney(entry);
  });
}

/** A map of counts: every value a finite number. */
const isCountMap = (value: unknown): boolean =>
  !!value &&
  typeof value === 'object' &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Object.values(value as Record<string, unknown>).every(isCount);

export function isAggregate(value: unknown): boolean {
  if (value === null) return true;
  if (isCount(value) || isMoney(value)) return true;
  if (Array.isArray(value)) return value.every(isGroup);
  return isCountMap(value);
}

const merge = (...seeds: Seed[]): Seed => {
  const out: Seed = {};
  for (const seed of seeds) {
    for (const [key, value] of Object.entries(seed)) {
      const existing = (out as Record<string, unknown>)[key];
      (out as Record<string, unknown>)[key] = Array.isArray(value) && Array.isArray(existing) ? [...existing, ...value] : existing && typeof value === 'object' && !Array.isArray(value) ? { ...(existing as object), ...(value as object) } : value;
    }
  }
  return out;
};

describe('the repository contract', () => {
  const memory = inMemoryRepository(merge(publishersSeed(), advertisersSeed(), agentsSeed(), printPartnersSeed(), employeesSeed(), usersSeed()));
  const methods = Object.keys(CALLS) as Method[];

  it('names every method the Prisma repository implements, and nothing else', () => {
    expect(Object.keys(prismaSectionOverviewsRepository).sort()).toEqual([...methods].sort());
  });

  it.each(methods)('%s resolves to a number, a decimal string or grouped counts', async (method) => {
    const fn = memory[method] as (...args: unknown[]) => Promise<unknown>;
    const result = await fn(...CALLS[method]);
    expect(isAggregate(result), `${method} answered ${JSON.stringify(result)}`).toBe(true);
  });

  it('never returns a row from the Prisma repository — two findMany (the department names, the city labels), and no writes', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'prisma-section-overviews.repository.ts'), 'utf8');
    const occurrences = (needle: RegExp) => (source.match(needle) ?? []).length;
    // Lot X-B: the second is the City label lookup behind every city group — `{ id, slug, name }` per key, never a party row.
    expect(occurrences(/\.findMany\(/g)).toBe(2);
    expect(source).toMatch(/prisma\.department\.findMany\(/);
    expect(source).toMatch(/prisma\.city\.findMany\(\{ where: \{ id: \{ in: ids \} \}, select: \{ id: true, slug: true, name: true \} \}\)/);
    expect(occurrences(/\.findFirst\(|\.findUnique\(|\.create\(|\.createMany\(|\.update\(|\.updateMany\(|\.upsert\(|\.delete\(|\.deleteMany\(|\$executeRaw/g)).toBe(0);
  });

  it('rejects a row-shaped answer', () => {
    expect(isAggregate([{ id: 'pub_1', name: 'Someone', createdAt: new Date() }])).toBe(false);
    expect(isAggregate({ id: 'pub_1' })).toBe(false);
    expect(isAggregate(new Date())).toBe(false);
    expect(isAggregate('1200')).toBe(false);
  });
});
