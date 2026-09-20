import { Prisma, prisma } from '../shared/database';
import { Decimal, money } from '../shared/money';
import { allocateIdentifier } from '../modules/identifiers';
import { createAgent } from '../modules/agents';
import { captureCampaignHold, holdForCampaign } from '../modules/advertisers';
import { topUp } from '../modules/advertisers/advertisers.service';
import { addMethod, recordIncentiveOnce, requestWithdrawal, runDailyAccrual } from '../modules/payouts';
import { approveWithdrawal, markWithdrawalPaid, verifyMethod, withdrawalAllowance } from '../modules/payouts/payouts.service';
import { creditIncentive } from '../modules/payouts/incentives.service';
import { reviewSpot } from '../modules/reviews/reviews.service';

/**
 * QR-23 (the owner, 17 Sep 2026): "create some agents, publishers and
 * advertisers too, for better understanding of how our platform works.
 * Make sure every stat can be calculated normally."
 *
 * Runs after `seed:demo-listings` (the demo publisher, its twenty spots and
 * Advait's five campaigns) and fills the rest of the platform in around them,
 * so every desk and every overview has something to count:
 *
 *   - three agents (two in Bengaluru, one in Mumbai) with verified KYC, both
 *     roles where they work both sides, credited incentives for the parties
 *     they onboarded, a site visit each, and leads in every stage;
 *   - four more publishers across Bengaluru, Hyderabad and Mumbai — onboarded
 *     by an agent, by the desk and by themselves — in every KYC state, with
 *     the platform agreement accepted where they are live, a subscription
 *     or two, the demo spots redistributed among them by category, and eight
 *     new spots in the other cities in every listing state the desks queue;
 *   - four more advertisers of every legal form and KYC state, with brands,
 *     billing details and the advertiser agreement, funded through the real
 *     top-up door so the wallet, its statement and the ledger agree;
 *   - eight more campaigns — completed, live, scheduled, awaiting payment and
 *     cancelled — booked the way checkout books them (a hold, then a capture
 *     that posts the CAMPAIGN_SPEND ledger legs the dashboard's GMV reads),
 *     with spots, orders, daily metrics, a tracking code with its events, and
 *     reviews on the completed spots; Advait's paid campaigns get their holds
 *     and captures too, since the first seed left them "paid" with nothing
 *     behind it;
 *   - the daily accrual run, so the publishers' earnings, ADX's commission
 *     and the take rate are the real ledger, then a payout method, a paid
 *     withdrawal and a pending one on the publishers who earned.
 *
 * Idempotent: every party is keyed by mobile, every campaign by reference,
 * every listing by title; a second run adds nothing. The ledger is
 * append-only, so removing all of this later means resetting the dev
 * database and re-running the base seeds, not deleting rows — see the
 * listings README.
 */

const ADMIN_MOBILE = '+919000000001';
const DEMO_SPACES_MOBILE = '+919000000999';
const ADVAIT_MOBILE = '+919000000101';
const NOTE = 'Demo — seeded for the dev environment';

const daysAgo = (days: number): Date => new Date(Date.now() - days * 86_400_000);
const dayOf = (date: Date): Date => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
const picsum = (seed: string, w = 900, h = 600) => `https://picsum.photos/seed/${encodeURIComponent(seed)}/${w}/${h}`;
const wobble = (seed: number, min: number, max: number): number => {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return Math.round(min + (x - Math.floor(x)) * (max - min));
};
const rupees = (n: number) => money(new Decimal(n));

type CityRow = { id: string; slug: string; name: string; state: string | null };
type AgentRow = { id: string; userId: string; displayId: string | null; tier: string };
type PublisherRow = { id: string; userId: string; displayId: string | null; name: string; kycStatus: string };
type AdvertiserRow = { id: string; userId: string; displayId: string | null; name: string; type: string };
type ListingRef = { id: string; rate: number; footfall: number; title: string; publisherId: string };

async function cities(): Promise<Record<'bengaluru' | 'mumbai' | 'hyderabad', CityRow>> {
  const rows = await prisma.city.findMany({ where: { slug: { in: ['bengaluru', 'mumbai', 'hyderabad'] } }, select: { id: true, slug: true, name: true, state: true } });
  const byslug = Object.fromEntries(rows.map((row) => [row.slug, row])) as Record<string, CityRow>;
  for (const slug of ['bengaluru', 'mumbai', 'hyderabad']) {
    if (!byslug[slug]) throw new Error(`City ${slug} is missing — run seed:cities first`);
  }
  return byslug as Record<'bengaluru' | 'mumbai' | 'hyderabad', CityRow>;
}

async function adminUser() {
  const admin = await prisma.user.findFirst({ where: { mobile: ADMIN_MOBILE }, select: { id: true, name: true } }) ?? (await prisma.user.findFirst({ where: { roles: { some: { role: 'ADMIN' } } }, select: { id: true, name: true } }));
  if (!admin) throw new Error('No admin user — run prisma/seed.ts first');
  return admin;
}

/** A person's account, opened with an ADX id the day they joined; adopted when the number is known. */
async function ensureUser(input: { mobile: string; name: string; firstName: string; lastName: string; email: string; role: 'PUBLISHER' | 'ADVERTISER'; joinedAt: Date }) {
  let user = await prisma.user.findUnique({ where: { mobile: input.mobile }, select: { id: true } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        mobile: input.mobile,
        displayId: await allocateIdentifier('USER', input.joinedAt),
        name: input.name,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        mobileVerifiedAt: input.joinedAt,
        consentAcceptedAt: input.joinedAt,
        consentTermsVersion: 1,
        consentPrivacyVersion: 1,
        lastLoginAt: daysAgo(wobble(input.mobile.length + input.name.length, 0, 6)),
        createdAt: input.joinedAt,
      },
      select: { id: true },
    });
  }
  await prisma.userRole.upsert({ where: { userId_role: { userId: user.id, role: input.role } }, update: {}, create: { userId: user.id, role: input.role } });
  return user;
}

async function activeTemplate(kind: 'PLATFORM' | 'ADVERTISER_PLATFORM') {
  return prisma.agreementTemplate.findFirst({ where: { kind, isActive: true }, select: { id: true, version: true }, orderBy: { version: 'desc' } });
}

async function acceptAgreement(party: { publisherId?: string; advertiserId?: string }, kind: 'PLATFORM' | 'ADVERTISER_PLATFORM', userId: string, at: Date) {
  const template = await activeTemplate(kind);
  if (!template) {
    console.warn(`  no active ${kind} template — agreement not recorded`);
    return;
  }
  const existing = await prisma.agreementAcceptance.findFirst({ where: { ...party, templateKind: kind }, select: { id: true } });
  if (existing) return;
  await prisma.agreementAcceptance.create({
    data: { templateId: template.id, templateKind: kind, templateVersion: template.version, acceptedByUserId: userId, acceptedAt: at, ...party },
  });
}

/* ── Agents ─────────────────────────────────────────────────────────── */

type AgentSpec = { mobile: string; name: string; email: string; side: 'PUBLISHER' | 'ADVERTISER'; both: boolean; city: 'bengaluru' | 'mumbai'; tier: 'BRONZE' | 'SILVER' | 'GOLD'; joinedDaysAgo: number };
const AGENTS: AgentSpec[] = [
  { mobile: '+919000000301', name: 'Rahul Menon', email: 'rahul.menon@demo.adx.in', side: 'PUBLISHER', both: true, city: 'bengaluru', tier: 'SILVER', joinedDaysAgo: 160 },
  { mobile: '+919000000302', name: 'Priya Nair', email: 'priya.nair@demo.adx.in', side: 'ADVERTISER', both: true, city: 'bengaluru', tier: 'GOLD', joinedDaysAgo: 220 },
  { mobile: '+919000000303', name: 'Imran Shaikh', email: 'imran.shaikh@demo.adx.in', side: 'PUBLISHER', both: false, city: 'mumbai', tier: 'BRONZE', joinedDaysAgo: 45 },
];

async function ensureAgents(city: Record<string, CityRow>, adminId: string): Promise<Record<string, AgentRow>> {
  const made: Record<string, AgentRow> = {};
  for (const spec of AGENTS) {
    const held = await prisma.user.findUnique({ where: { mobile: spec.mobile }, select: { id: true, agentProfile: { select: { id: true, displayId: true, tier: true } } } });
    let profile = held?.agentProfile ?? null;
    let userId = held?.id ?? null;
    if (!profile) {
      const created = await createAgent({ mobile: spec.mobile, name: spec.name, email: spec.email, side: spec.side, city: city[spec.city]!.name, state: city[spec.city]!.state ?? undefined });
      profile = { id: created.id, displayId: created.displayId ?? null, tier: created.tier ?? 'BRONZE' };
      userId = (await prisma.agentProfile.findUnique({ where: { id: created.id }, select: { userId: true } }))!.userId;
      const joined = daysAgo(spec.joinedDaysAgo);
      await prisma.agentProfile.update({ where: { id: profile.id }, data: { tier: spec.tier, status: 'ACTIVE', createdAt: joined, workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'], hoursFrom: '09:00', hoursTo: '19:00', radiusKm: 25 } });
      await prisma.user.update({ where: { id: userId }, data: { createdAt: joined, lastLoginAt: daysAgo(wobble(spec.joinedDaysAgo, 0, 3)), mobileVerifiedAt: joined, consentAcceptedAt: joined } });
      if (spec.both) {
        const other = spec.side === 'PUBLISHER' ? 'AGENT_ADVERTISER' : 'AGENT_PUBLISHER';
        await prisma.userRole.upsert({ where: { userId_role: { userId, role: other } }, update: {}, create: { userId, role: other } });
      }
      await prisma.agentKyc.upsert({
        where: { agentId: profile.id },
        update: {},
        create: { agentId: profile.id, status: 'VERIFIED', method: 'MANUAL', submittedAt: new Date(joined.getTime() + 86_400_000), reviewedAt: new Date(joined.getTime() + 3 * 86_400_000), reviewedById: adminId },
      });
      console.log(`  created agent ${spec.name} (${profile.displayId ?? profile.id}, ${spec.city}, ${spec.tier})`);
    } else {
      console.log(`  kept    agent ${spec.name}`);
    }
    made[spec.mobile] = { id: profile.id, userId: userId!, displayId: profile.displayId, tier: spec.tier };
  }
  return made;
}

/* ── Publishers ──────────────────────────────────────────────────────── */

type PublisherSpec = {
  mobile: string; name: string; person: { first: string; last: string }; email: string; type: 'INDIVIDUAL' | 'BUSINESS';
  city: 'bengaluru' | 'mumbai' | 'hyderabad'; address: string; lat: number; lng: number; gstin: string | null;
  kyc: 'VERIFIED' | 'PENDING' | 'NEEDS_INFO'; via: 'SELF' | 'AGENT' | 'DESK'; agent: string | null; joinedDaysAgo: number;
  /** Which of the first seed's categories move under this publisher. */
  takes: Array<'OUTDOOR' | 'TRANSIT'>; subscription: 'PLUS' | 'PRO' | null;
};
const PUBLISHERS: PublisherSpec[] = [
  { mobile: '+919000000201', name: 'Skyline Outdoor Media', person: { first: 'Vikram', last: 'Rao' }, email: 'vikram@skylineoutdoor.demo', type: 'BUSINESS', city: 'bengaluru', address: '14, Residency Road, Bengaluru 560025', lat: 12.9719, lng: 77.6062, gstin: '29ABCDE1234F1Z5', kyc: 'VERIFIED', via: 'AGENT', agent: '+919000000301', joinedDaysAgo: 140, takes: ['OUTDOOR'], subscription: 'PRO' },
  { mobile: '+919000000202', name: 'Metro Transit Ads Pvt Ltd', person: { first: 'Anjali', last: 'Krishnan' }, email: 'anjali@metrotransit.demo', type: 'BUSINESS', city: 'bengaluru', address: '3rd Floor, Brigade Towers, Brigade Road, Bengaluru 560001', lat: 12.9698, lng: 77.6083, gstin: '29PQRSX5678G1Z2', kyc: 'VERIFIED', via: 'DESK', agent: null, joinedDaysAgo: 110, takes: ['TRANSIT'], subscription: 'PLUS' },
  { mobile: '+919000000203', name: 'Sunita Reddy', person: { first: 'Sunita', last: 'Reddy' }, email: 'sunita.reddy@demo.adx.in', type: 'INDIVIDUAL', city: 'hyderabad', address: 'Plot 22, Jubilee Hills, Hyderabad 500033', lat: 17.4325, lng: 78.4071, gstin: null, kyc: 'PENDING', via: 'SELF', agent: null, joinedDaysAgo: 12, takes: [], subscription: null },
  { mobile: '+919000000204', name: 'Mumbai Hoardings Co', person: { first: 'Farhan', last: 'Khan' }, email: 'farhan@mumbaihoardings.demo', type: 'BUSINESS', city: 'mumbai', address: '2, Linking Road, Bandra West, Mumbai 400050', lat: 19.0596, lng: 72.8295, gstin: '27LMNOP9012H1Z8', kyc: 'NEEDS_INFO', via: 'AGENT', agent: '+919000000303', joinedDaysAgo: 30, takes: [], subscription: null },
];

async function ensurePublishers(city: Record<string, CityRow>, agents: Record<string, AgentRow>, adminId: string): Promise<Record<string, PublisherRow>> {
  const made: Record<string, PublisherRow> = {};
  for (const spec of PUBLISHERS) {
    const joined = daysAgo(spec.joinedDaysAgo);
    const existing = await prisma.publisher.findUnique({ where: { mobile: spec.mobile }, select: { id: true, userId: true, displayId: true, name: true, kycStatus: true } });
    if (existing?.userId) {
      made[spec.mobile] = { id: existing.id, userId: existing.userId, displayId: existing.displayId, name: existing.name, kycStatus: existing.kycStatus };
      console.log(`  kept    publisher ${spec.name}`);
      continue;
    }
    const user = await ensureUser({ mobile: spec.mobile, name: `${spec.person.first} ${spec.person.last}`, firstName: spec.person.first, lastName: spec.person.last, email: spec.email, role: 'PUBLISHER', joinedAt: joined });
    const agent = spec.agent ? agents[spec.agent]! : null;
    const verified = spec.kyc === 'VERIFIED';
    const town = city[spec.city]!;
    const publisher = await prisma.publisher.create({
      data: {
        displayId: await allocateIdentifier('PUBLISHER', joined),
        userId: user.id,
        name: spec.name,
        mobile: spec.mobile,
        email: spec.email,
        type: spec.type,
        gstin: spec.gstin,
        contactName: `${spec.person.first} ${spec.person.last}`,
        contactMobile: spec.mobile,
        contactEmail: spec.email,
        address: spec.address,
        city: town.name,
        cityId: town.id,
        state: town.state,
        latitude: spec.lat,
        longitude: spec.lng,
        kycStatus: spec.kyc,
        onboardingStatus: 'ONBOARDING_COMPLETE',
        activatedAt: verified ? new Date(joined.getTime() + 4 * 86_400_000) : null,
        agentId: agent?.id ?? null,
        onboardedVia: spec.via,
        onboardedById: spec.via === 'AGENT' ? agent!.userId : spec.via === 'DESK' ? adminId : user.id,
        onboardedByRole: spec.via === 'AGENT' ? 'AGENT_PUBLISHER' : spec.via === 'DESK' ? 'ADMIN' : 'PUBLISHER',
        onboardedAt: joined,
        sizeBand: spec.type === 'BUSINESS' ? 'SMALL_AGENCY' : 'INDIVIDUAL',
        createdAt: joined,
      },
      select: { id: true, userId: true, displayId: true, name: true, kycStatus: true },
    });
    await prisma.publisherKyc.create({
      data: {
        publisherId: publisher.id,
        status: spec.kyc,
        method: 'MANUAL',
        submittedAt: new Date(joined.getTime() + 86_400_000),
        ...(spec.kyc === 'PENDING' ? {} : { reviewedAt: new Date(joined.getTime() + 3 * 86_400_000), reviewedById: adminId }),
        ...(spec.kyc === 'NEEDS_INFO' ? { rejectionReason: 'The address proof is older than three months. Send a current one.' } : {}),
      },
    });
    if (verified) await acceptAgreement({ publisherId: publisher.id }, 'PLATFORM', user.id, new Date(joined.getTime() + 2 * 86_400_000));
    if (spec.subscription) {
      await prisma.publisherSubscription.create({
        data: { publisherId: publisher.id, tier: spec.subscription, ratePct: new Prisma.Decimal(spec.subscription === 'PRO' ? '0.0800' : '0.1000'), pricePerMonth: new Prisma.Decimal(spec.subscription === 'PRO' ? 2999 : 999), startsAt: new Date(joined.getTime() + 7 * 86_400_000), source: 'SELF_SERVICE' },
      });
    }
    if (agent) {
      try {
        const incentive = (await recordIncentiveOnce({ agentId: agent.id, event: 'PUBLISHER_ONBOARDED', tier: agent.tier, publisherId: publisher.id, note: NOTE }, new Date(joined.getTime() + 4 * 86_400_000))) as { id: string } | null;
        if (incentive?.id && verified) await creditIncentive(incentive.id, { byUserId: adminId }, new Date(joined.getTime() + 6 * 86_400_000));
      } catch (error) {
        console.warn(`  incentive for ${spec.name} not recorded: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    made[spec.mobile] = { id: publisher.id, userId: user.id, displayId: publisher.displayId, name: publisher.name, kycStatus: publisher.kycStatus };
    console.log(`  created publisher ${spec.name} (${publisher.displayId ?? publisher.id}, ${spec.city}, ${spec.kyc}, via ${spec.via})`);
  }
  return made;
}

/** The first seed put every spot under ADX Demo Spaces; the outdoor and transit ones move to the publishers who would own them. */
async function redistributeListings(demoSpacesId: string, publishers: Record<string, PublisherRow>, agents: Record<string, AgentRow>) {
  for (const spec of PUBLISHERS) {
    if (spec.takes.length === 0) continue;
    const owner = publishers[spec.mobile]!;
    const agent = spec.agent ? agents[spec.agent]! : null;
    const moved = await prisma.listing.updateMany({ where: { publisherId: demoSpacesId, category: { in: spec.takes } }, data: { publisherId: owner.id, agentId: agent?.id ?? null } });
    if (moved.count > 0) console.log(`  moved ${moved.count} ${spec.takes.join('/')} spots to ${owner.name}`);
  }
}

/* ── More listings, in the other cities and the other states ─────────── */

type ExtraSpot = {
  owner: string; city: 'mumbai' | 'hyderabad' | 'bengaluru'; venue: string; title: string; address: string; lat: number; lng: number; rate: number; subType: string;
  size: string | null; footfall: number; illumination: 'BACKLIT' | 'FRONTLIT' | 'DIGITAL' | 'NONE'; placement: string; media: RegExp; digital: boolean; usp: string; audience: string;
  status: 'ACTIVE' | 'PENDING_REVIEW' | 'AWAITING_SITE_VERIFICATION' | 'SUSPENDED' | 'DRAFT';
};
const EXTRA: ExtraSpot[] = [
  { owner: '+919000000204', city: 'mumbai', venue: 'city-roads-urban-streets-main-roads', title: 'Bandra Reclamation — Sea Link Approach Hoarding', address: 'Bandra Reclamation, Mumbai 400050', lat: 19.0455, lng: 72.8210, rate: 45000, subType: 'Hoarding', size: '60 x 30 ft', footfall: 210000, illumination: 'FRONTLIT', placement: 'Facing Sea Link inbound', media: /hoarding|billboard/i, digital: false, usp: 'Every Sea Link crossing sees it.', audience: 'South Mumbai commuters', status: 'ACTIVE' },
  { owner: '+919000000204', city: 'mumbai', venue: 'shopping-malls-retail-centers-department-stores', title: 'Phoenix Palladium — Atrium Digital Screen', address: 'High Street Phoenix, Lower Parel, Mumbai 400013', lat: 18.9940, lng: 72.8258, rate: 20000, subType: 'Digital LED wall', size: '20 x 12 ft', footfall: 60000, illumination: 'DIGITAL', placement: 'Central atrium', media: /led|digital|screen/i, digital: true, usp: 'Luxury shoppers, all week.', audience: 'Affluent shoppers, 25–50', status: 'PENDING_REVIEW' },
  { owner: '+919000000204', city: 'mumbai', venue: 'highways-expressways-national-highways', title: 'Western Express Highway — Andheri Gantry', address: 'WEH, Andheri East, Mumbai 400069', lat: 19.1136, lng: 72.8697, rate: 38000, subType: 'Gantry', size: '70 x 12 ft', footfall: 250000, illumination: 'BACKLIT', placement: 'Across the highway, airport-bound', media: /gantry|arch|hoarding/i, digital: false, usp: 'Verification lapsed — the demo of a suspended spot.', audience: 'Airport-bound traffic', status: 'SUSPENDED' },
  { owner: '+919000000203', city: 'hyderabad', venue: 'shopping-malls-retail-centers-department-stores', title: 'Inorbit Mall Hitec City — Food Court Panels', address: 'Inorbit Mall, Hitec City, Hyderabad 500081', lat: 17.4342, lng: 78.3866, rate: 6500, subType: 'Backlit panels', size: '8 x 4 ft (x4)', footfall: 35000, illumination: 'BACKLIT', placement: 'Food court pillars', media: /panel|pillar|backlit/i, digital: false, usp: 'Lunch and dinner crowds from the tech parks.', audience: 'IT professionals, families', status: 'ACTIVE' },
  { owner: '+919000000203', city: 'hyderabad', venue: 'metro-subway-underground', title: 'Hyderabad Metro Ameerpet — Concourse Wall', address: 'Ameerpet Metro Station, Hyderabad 500016', lat: 17.4375, lng: 78.4483, rate: 11000, subType: 'Wall wrap', size: '30 x 10 ft', footfall: 90000, illumination: 'FRONTLIT', placement: 'Interchange concourse', media: /wall|wrap|concourse/i, digital: false, usp: 'The busiest interchange on the network.', audience: 'Daily commuters', status: 'AWAITING_SITE_VERIFICATION' },
  { owner: '+919000000201', city: 'bengaluru', venue: 'city-roads-urban-streets-main-roads', title: 'Koramangala 80 Feet Road — Corner Billboard', address: '80 Feet Road, Koramangala 4th Block, Bengaluru 560034', lat: 12.9330, lng: 77.6220, rate: 14000, subType: 'Billboard', size: '40 x 20 ft', footfall: 70000, illumination: 'BACKLIT', placement: 'Corner, facing Sony World signal', media: /billboard|hoarding/i, digital: false, usp: 'Half-written — the demo of a draft.', audience: 'Start-up crowd', status: 'DRAFT' },
  { owner: '+919000000202', city: 'bengaluru', venue: 'bus-bus-rapid-transit-brt', title: 'Vayu Vajra Airport Bus — Full Wrap (10 buses)', address: 'Kempegowda Bus Station, Bengaluru 560009', lat: 12.9774, lng: 77.5720, rate: 8000, subType: 'Bus wrap', size: 'Full body (x10)', footfall: 45000, illumination: 'NONE', placement: 'Ten airport buses, full wrap', media: /wrap|bus|exterior/i, digital: false, usp: 'Airport runs from every corner of the city.', audience: 'Air travellers', status: 'ACTIVE' },
  { owner: '+919000000201', city: 'bengaluru', venue: 'flyovers-overpasses-elevated-roads-skywalks', title: 'Electronic City Elevated Expressway — Pier Panels', address: 'Hosur Road elevated expressway, Bengaluru 560100', lat: 12.8452, lng: 77.6602, rate: 10000, subType: 'Pier panels', size: '12 x 8 ft (x8)', footfall: 130000, illumination: 'BACKLIT', placement: 'Eight piers, both carriageways', media: /pier|panel|flyover/i, digital: false, usp: 'The IT corridor, morning and evening.', audience: 'Electronic City commuters', status: 'ACTIVE' },
];

async function ensureExtraListings(city: Record<string, CityRow>, publishers: Record<string, PublisherRow>, agents: Record<string, AgentRow>): Promise<ListingRef[]> {
  const made: ListingRef[] = [];
  let index = 100;
  for (const spot of EXTRA) {
    index += 1;
    const owner = publishers[spot.owner]!;
    const existing = await prisma.listing.findFirst({ where: { title: spot.title }, select: { id: true, publisherId: true } });
    if (existing) {
      made.push({ id: existing.id, rate: spot.rate, footfall: spot.footfall, title: spot.title, publisherId: existing.publisherId ?? owner.id });
      continue;
    }
    const venue = await prisma.venueType.findUnique({ where: { slug: spot.venue }, select: { id: true, category: true } });
    if (!venue) {
      console.warn(`  venue ${spot.venue} missing — ${spot.title} skipped (run seed:venues)`);
      continue;
    }
    const mediaType =
      (await prisma.mediaType.findFirst({ where: { venueTypeId: venue.id, status: 'ACTIVE', name: { contains: spot.media.source.split('|')[0]!.replace(/[^a-z ]/gi, ''), mode: 'insensitive' } }, select: { id: true } })) ??
      (await prisma.mediaType.findFirst({ where: { venueTypeId: venue.id, status: 'ACTIVE' }, select: { id: true }, orderBy: { name: 'asc' } }));
    const town = city[spot.city]!;
    const spec = PUBLISHERS.find((p) => p.mobile === spot.owner)!;
    const agent = spec.agent ? agents[spec.agent]! : null;
    const live = spot.status === 'ACTIVE' || spot.status === 'SUSPENDED';
    const publishedAt = live ? daysAgo(wobble(index, 20, 200)) : null;
    const listing = await prisma.listing.create({
      data: {
        publisherId: owner.id,
        agentId: agent?.id ?? null,
        title: spot.title,
        category: venue.category,
        subType: spot.subType,
        description: `${spot.usp} Demo listing seeded for the dev environment — ${spot.placement}.`,
        address: spot.address,
        city: town.name,
        cityId: town.id,
        latitude: spot.lat,
        longitude: spot.lng,
        size: spot.size,
        ratePerDay: new Prisma.Decimal(spot.rate),
        basePrice: new Prisma.Decimal(spot.rate),
        pricingUnit: 'PER_DAY',
        monthlyPrice: spot.rate * 30,
        instantBooking: false,
        slotsTotal: spot.digital ? 6 : 1,
        estimatedDailyFootfall: spot.footfall,
        illumination: spot.illumination,
        placement: spot.placement,
        uniqueSellingPoint: spot.usp,
        targetAudience: spot.audience,
        venueTypeId: venue.id,
        mediaTypeId: mediaType?.id ?? null,
        availableNow: spot.status === 'ACTIVE',
        status: spot.status,
        displayId: await allocateIdentifier('LISTING'),
        submittedAt: spot.status === 'DRAFT' ? null : daysAgo(wobble(index + 1, 5, 220)),
        publishedAt,
        verifiedAt: live ? new Date(publishedAt!.getTime()) : null,
        // The suspended spot: a permanent structure whose 180-day verification ran out three weeks ago.
        ...(spot.status === 'SUSPENDED' ? { verifiedAt: daysAgo(201), verificationExpiresAt: daysAgo(21), suspendedAt: daysAgo(16), removability: 'PERMANENT' as const } : {}),
        ...(spot.status === 'ACTIVE' ? { verificationExpiresAt: new Date(publishedAt!.getTime() + 180 * 86_400_000) } : {}),
        reviewCount: 0,
        photos: spot.status === 'DRAFT' ? undefined : { create: [{ url: picsum(`adx-demo-${index}-a`), type: 'main' }, { url: picsum(`adx-demo-${index}-b`, 900, 700), type: 'gallery' }] },
      },
      select: { id: true },
    });
    made.push({ id: listing.id, rate: spot.rate, footfall: spot.footfall, title: spot.title, publisherId: owner.id });
    console.log(`  created ${spot.status.padEnd(26)} ${spot.title}`);
  }
  return made;
}

/* ── Advertisers ─────────────────────────────────────────────────────── */

type AdvertiserSpec = {
  mobile: string; name: string; person: { first: string; last: string }; email: string; type: 'INDIVIDUAL' | 'COMMERCIAL' | 'NGO' | 'AGENCY';
  company: string | null; industry: string; brand: { name: string; sector: 'GENERAL' | 'HEALTHCARE' | 'EDUCATION' | 'REAL_ESTATE' }; city: 'bengaluru' | 'mumbai'; address: string; gstin: string | null;
  kyc: 'VERIFIED' | 'PENDING' | 'REJECTED'; via: 'SELF' | 'AGENT' | 'DESK'; agent: string | null; joinedDaysAgo: number; topUp: number;
};
const ADVERTISERS: AdvertiserSpec[] = [
  { mobile: '+919000000401', name: 'Meera Sharma', person: { first: 'Meera', last: 'Sharma' }, email: 'meera.sharma@demo.adx.in', type: 'INDIVIDUAL', company: null, industry: 'Food & beverage', brand: { name: 'Meera\'s Kitchen', sector: 'GENERAL' }, city: 'bengaluru', address: '7, 12th Main, Indiranagar, Bengaluru 560038', gstin: null, kyc: 'VERIFIED', via: 'SELF', agent: null, joinedDaysAgo: 130, topUp: 600000 },
  { mobile: '+919000000402', name: 'Bright Dental Clinics', person: { first: 'Arjun', last: 'Iyer' }, email: 'arjun@brightdental.demo', type: 'COMMERCIAL', company: 'Bright Dental Clinics Pvt Ltd', industry: 'Healthcare', brand: { name: 'Bright Dental', sector: 'HEALTHCARE' }, city: 'bengaluru', address: '221, HSR Layout Sector 2, Bengaluru 560102', gstin: '29BRDNT4321K1Z9', kyc: 'PENDING', via: 'AGENT', agent: '+919000000302', joinedDaysAgo: 95, topUp: 900000 },
  { mobile: '+919000000403', name: 'Karnataka Tourism Board', person: { first: 'Lakshmi', last: 'Hegde' }, email: 'lakshmi@ktb.demo', type: 'NGO', company: 'Karnataka Tourism Board', industry: 'Travel & tourism', brand: { name: 'One State Many Worlds', sector: 'GENERAL' }, city: 'bengaluru', address: 'Khanija Bhavan, Race Course Road, Bengaluru 560001', gstin: null, kyc: 'VERIFIED', via: 'DESK', agent: null, joinedDaysAgo: 75, topUp: 1500000 },
  { mobile: '+919000000404', name: 'Pixel Ads Agency', person: { first: 'Neha', last: 'Kulkarni' }, email: 'neha@pixelads.demo', type: 'AGENCY', company: 'Pixel Ads Agency LLP', industry: 'Advertising agency', brand: { name: 'Pixel Ads', sector: 'GENERAL' }, city: 'mumbai', address: '5th Floor, Trade Centre, BKC, Mumbai 400051', gstin: '27PXLAD7788M1Z3', kyc: 'REJECTED', via: 'SELF', agent: null, joinedDaysAgo: 20, topUp: 0 },
];

async function ensureAdvertisers(city: Record<string, CityRow>, agents: Record<string, AgentRow>, adminId: string): Promise<Record<string, AdvertiserRow>> {
  const made: Record<string, AdvertiserRow> = {};
  for (const spec of ADVERTISERS) {
    const joined = daysAgo(spec.joinedDaysAgo);
    const existing = await prisma.advertiser.findUnique({ where: { mobile: spec.mobile }, select: { id: true, userId: true, displayId: true, name: true, type: true } });
    if (existing?.userId) {
      made[spec.mobile] = { id: existing.id, userId: existing.userId, displayId: existing.displayId, name: existing.name, type: existing.type };
      console.log(`  kept    advertiser ${spec.name}`);
      continue;
    }
    const user = await ensureUser({ mobile: spec.mobile, name: `${spec.person.first} ${spec.person.last}`, firstName: spec.person.first, lastName: spec.person.last, email: spec.email, role: 'ADVERTISER', joinedAt: joined });
    const agent = spec.agent ? agents[spec.agent]! : null;
    const town = city[spec.city]!;
    const advertiser = await prisma.advertiser.create({
      data: {
        displayId: await allocateIdentifier('ADVERTISER', joined),
        userId: user.id,
        name: spec.name,
        mobile: spec.mobile,
        email: spec.email,
        type: spec.type,
        companyName: spec.company,
        industry: spec.industry,
        gstin: spec.gstin,
        billingAddress: spec.address,
        city: town.name,
        cityId: town.id,
        state: town.state,
        kycStatus: spec.kyc,
        activatedAt: spec.kyc === 'VERIFIED' ? new Date(joined.getTime() + 3 * 86_400_000) : null,
        agentId: agent?.id ?? null,
        onboardedVia: spec.via,
        onboardedById: spec.via === 'AGENT' ? agent!.userId : spec.via === 'DESK' ? adminId : user.id,
        onboardedByRole: spec.via === 'AGENT' ? 'AGENT_ADVERTISER' : spec.via === 'DESK' ? 'ADMIN' : 'ADVERTISER',
        onboardedAt: joined,
        createdAt: joined,
      },
      select: { id: true, userId: true, displayId: true, name: true, type: true },
    });
    await prisma.advertiserKyc.create({
      data: {
        advertiserId: user.id,
        advertiserProfileId: advertiser.id,
        status: spec.kyc,
        method: 'MANUAL',
        submittedAt: new Date(joined.getTime() + 86_400_000),
        ...(spec.kyc === 'PENDING' ? {} : { reviewedAt: new Date(joined.getTime() + 2 * 86_400_000), reviewedById: adminId }),
        ...(spec.kyc === 'REJECTED' ? { rejectionReason: 'The GST certificate and the PAN name do not match.' } : {}),
      },
    });
    await prisma.brand.upsert({ where: { advertiserId_name: { advertiserId: advertiser.id, name: spec.brand.name } }, update: {}, create: { advertiserId: advertiser.id, name: spec.brand.name, sector: spec.brand.sector } });
    await acceptAgreement({ advertiserId: advertiser.id }, 'ADVERTISER_PLATFORM', user.id, new Date(joined.getTime() + 60 * 60_000));
    if (agent) {
      try {
        const incentive = (await recordIncentiveOnce({ agentId: agent.id, event: 'ADVERTISER_ONBOARDED', tier: agent.tier, advertiserId: advertiser.id, note: NOTE }, new Date(joined.getTime() + 2 * 86_400_000))) as { id: string } | null;
        if (incentive?.id) await creditIncentive(incentive.id, { byUserId: adminId }, new Date(joined.getTime() + 5 * 86_400_000));
      } catch (error) {
        console.warn(`  incentive for ${spec.name} not recorded: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    made[spec.mobile] = { id: advertiser.id, userId: advertiser.userId!, displayId: advertiser.displayId, name: advertiser.name, type: advertiser.type };
    console.log(`  created advertiser ${spec.name} (${advertiser.displayId ?? advertiser.id}, ${spec.type}, ${spec.kyc}, via ${spec.via})`);
  }
  return made;
}

/** Money in through the real door: the wallet, its statement line and the ledger legs agree. */
async function fund(advertiser: AdvertiserRow, amount: number, adminId: string, receivedAt: Date) {
  if (amount <= 0) return;
  const utr = `DEMO-${advertiser.displayId ?? advertiser.id}-${amount}`;
  const already = await prisma.walletTopUp.findFirst({ where: { utr }, select: { id: true } });
  if (already) return;
  await topUp(advertiser.id, { amount: rupees(amount), method: 'BANK_TRANSFER', utr, receivedAt }, adminId);
  console.log(`  funded ${advertiser.name} with ₹${amount.toLocaleString('en-IN')}`);
}

/* ── Campaigns ───────────────────────────────────────────────────────── */

type CampaignSpec = {
  reference: string; advertiser: string; name: string; status: 'PENDING_PAYMENT' | 'SCHEDULED' | 'LIVE' | 'COMPLETED' | 'CANCELLED';
  startsInDays: number; lengthDays: number; goal: 'LOCAL_FOOTFALL' | 'BRAND_AWARENESS' | 'DIGITAL_LIFT'; spots: string[]; tracked: boolean; industry: string;
};
const CAMPAIGNS: CampaignSpec[] = [
  { reference: 'ADX-CMP-2026-DEMO06', advertiser: '+919000000401', name: 'Weekend Brunch Launch', status: 'COMPLETED', startsInDays: -80, lengthDays: 21, goal: 'LOCAL_FOOTFALL', spots: ['Third Wave Coffee Koramangala — Table Tents', 'Auto-rickshaw Hood Wraps — Koramangala fleet (25)'], tracked: true, industry: 'Food & beverage' },
  { reference: 'ADX-CMP-2026-DEMO07', advertiser: '+919000000401', name: 'Festive Menu — Indiranagar', status: 'LIVE', startsInDays: -6, lengthDays: 30, goal: 'LOCAL_FOOTFALL', spots: ['Cult.fit Indiranagar — Mirror Decals', 'BMTC Shelter — Marathahalli Bridge'], tracked: false, industry: 'Food & beverage' },
  { reference: 'ADX-CMP-2026-DEMO08', advertiser: '+919000000402', name: 'Free Dental Check-up Month', status: 'COMPLETED', startsInDays: -50, lengthDays: 30, goal: 'BRAND_AWARENESS', spots: ['Silk Board Flyover — Skywalk Panel', 'More Megastore Jayanagar — Aisle Shelf Branding', 'FM Radio — Morning Drive 20s spot (Bengaluru)'], tracked: true, industry: 'Healthcare' },
  { reference: 'ADX-CMP-2026-DEMO09', advertiser: '+919000000402', name: 'Aligners — HSR & Koramangala', status: 'SCHEDULED', startsInDays: 9, lengthDays: 30, goal: 'DIGITAL_LIFT', spots: ['PVR Forum Mall — Lobby Digital Screen'], tracked: false, industry: 'Healthcare' },
  { reference: 'ADX-CMP-2026-DEMO10', advertiser: '+919000000403', name: 'Hampi Utsav — Statewide', status: 'LIVE', startsInDays: -12, lengthDays: 45, goal: 'BRAND_AWARENESS', spots: ['Regional TV — Prime-time 30s slot (Kannada GEC)', 'KIA Trumpet Junction — Approach Hoarding', 'Namma Metro MG Road Station — Pillar Wrap'], tracked: true, industry: 'Travel & tourism' },
  { reference: 'ADX-CMP-2026-DEMO11', advertiser: '+919000000403', name: 'Coastal Karnataka — Monsoon (cancelled)', status: 'CANCELLED', startsInDays: -40, lengthDays: 30, goal: 'BRAND_AWARENESS', spots: ['Hebbal Flyover Approach — Airport Road Billboard'], tracked: false, industry: 'Travel & tourism' },
  { reference: 'ADX-CMP-2026-DEMO12', advertiser: '+919000000404', name: 'Client pitch — Mumbai OOH', status: 'PENDING_PAYMENT', startsInDays: 20, lengthDays: 30, goal: 'BRAND_AWARENESS', spots: ['Bandra Reclamation — Sea Link Approach Hoarding'], tracked: false, industry: 'Advertising agency' },
  { reference: 'ADX-CMP-2026-DEMO13', advertiser: '+919000000401', name: 'Airport bus takeover', status: 'COMPLETED', startsInDays: -120, lengthDays: 14, goal: 'BRAND_AWARENESS', spots: ['Vayu Vajra Airport Bus — Full Wrap (10 buses)', 'Manyata Tech Park — Entry Gantry'], tracked: false, industry: 'Food & beverage' },
];

async function listingIndex(): Promise<Map<string, ListingRef>> {
  const rows = await prisma.listing.findMany({ where: { description: { contains: 'Demo listing seeded' } }, select: { id: true, title: true, ratePerDay: true, estimatedDailyFootfall: true, publisherId: true } });
  return new Map(rows.map((row) => [row.title, { id: row.id, title: row.title, rate: Number(row.ratePerDay), footfall: row.estimatedDailyFootfall ?? 0, publisherId: row.publisherId ?? '' }]));
}

async function ensureCampaigns(advertisers: Record<string, AdvertiserRow>, listings: Map<string, ListingRef>, city: CityRow, adminId: string) {
  let index = 20;
  for (const spec of CAMPAIGNS) {
    index += 1;
    const advertiser = advertisers[spec.advertiser]!;
    if (await prisma.campaign.findUnique({ where: { reference: spec.reference }, select: { id: true } })) {
      console.log(`  kept    ${spec.reference} ${spec.name}`);
      continue;
    }
    const brand = await prisma.brand.findFirst({ where: { advertiserId: advertiser.id }, select: { id: true, name: true } });
    const startDate = dayOf(daysAgo(-spec.startsInDays));
    const endDate = new Date(startDate.getTime() + spec.lengthDays * 86_400_000);
    const spots = spec.spots.map((title) => listings.get(title)).filter((row): row is ListingRef => Boolean(row));
    if (spots.length === 0) {
      console.warn(`  ${spec.reference}: none of its spots exist — skipped`);
      continue;
    }
    const subtotal = spots.reduce((sum, spot) => sum + spot.rate * spec.lengthDays, 0);
    const fees = Math.round(subtotal * 0.1);
    const gst = Math.round((subtotal + fees) * 0.18);
    const total = subtotal + fees + gst;
    const paid = spec.status === 'SCHEDULED' || spec.status === 'LIVE' || spec.status === 'COMPLETED' || spec.status === 'CANCELLED';
    const spotStatus = spec.status === 'COMPLETED' ? 'COMPLETED' : spec.status === 'LIVE' ? 'LIVE' : spec.status === 'SCHEDULED' ? 'BOOKED' : spec.status === 'CANCELLED' ? 'CANCELLED' : 'RESERVED';
    const paidAt = new Date(startDate.getTime() - 3 * 86_400_000);
    const campaign = await prisma.campaign.create({
      data: {
        reference: spec.reference,
        advertiserId: advertiser.id,
        brandId: brand?.id ?? null,
        createdByUserId: advertiser.userId,
        name: spec.name,
        status: spec.status,
        step: 17,
        brandName: brand?.name ?? advertiser.name,
        industry: spec.industry,
        goal: spec.goal,
        awareness: 'ALREADY_ESTABLISHED',
        targetingMethod: 'RADIUS',
        targetLocation: city.name,
        targetLatitude: 12.9716,
        targetLongitude: 77.5946,
        targetRadiusKm: 20,
        targetMarket: city.name,
        targetMarketCityId: city.id,
        strategy: 'GENERAL',
        persona: 'HIGH_INCOME_CONSUMERS',
        budget: new Prisma.Decimal(Math.round(total * 1.1)),
        startDate,
        endDate,
        creativePath: 'STATIC_IMAGES',
        trackingMethod: spec.tracked ? 'QR_OR_DEEPLINK' : 'NONE',
        fulfilment: 'ADX_PRINTS',
        spotsSubtotal: new Prisma.Decimal(subtotal),
        feesTotal: new Prisma.Decimal(fees),
        gstAmount: new Prisma.Decimal(gst),
        discount: new Prisma.Decimal(0),
        total: new Prisma.Decimal(total),
        ...(paid ? { paidAt } : {}),
        launchedAt: spec.status === 'LIVE' || spec.status === 'COMPLETED' ? startDate : null,
        completedAt: spec.status === 'COMPLETED' ? endDate : null,
        cancelledAt: spec.status === 'CANCELLED' ? new Date(startDate.getTime() - 86_400_000) : null,
        createdAt: new Date(paidAt.getTime() - 2 * 86_400_000),
      },
      select: { id: true },
    });
    for (const spot of spots) {
      const order = paid && spec.status !== 'CANCELLED'
        ? await prisma.order.create({
            data: {
              advertiserId: advertiser.userId,
              listingId: spot.id,
              status: spec.status === 'COMPLETED' ? 'COMPLETED' : spec.status === 'LIVE' ? 'IN_PROGRESS' : 'PENDING_PRINT',
              campaignName: spec.name,
              budget: spot.rate * spec.lengthDays,
              startDate,
              endDate,
              notes: `${NOTE} — campaign ${spec.reference}`,
              publisherAcceptedAt: new Date(startDate.getTime() - 2 * 86_400_000),
              adminApprovedAt: new Date(startDate.getTime() - 86_400_000),
              createdAt: paidAt,
            },
            select: { id: true },
          })
        : null;
      await prisma.campaignSpot.create({
        data: {
          campaignId: campaign.id,
          listingId: spot.id,
          status: spotStatus,
          ratePerDay: new Prisma.Decimal(spot.rate),
          days: spec.lengthDays,
          quantity: 1,
          lineTotal: new Prisma.Decimal(spot.rate * spec.lengthDays),
          startDate,
          endDate,
          commissionPct: new Prisma.Decimal('0.12'),
          commissionSource: 'PLATFORM_DEFAULT',
          orderId: order?.id ?? null,
          ...(spec.status === 'PENDING_PAYMENT' ? { reservedUntil: new Date(Date.now() + 2 * 86_400_000) } : {}),
        },
      });
    }
    // The money, the way checkout moves it: a hold on the funded wallet, captured when the campaign was paid.
    if (paid && spec.status !== 'CANCELLED') {
      try {
        const { holdId } = await holdForCampaign(advertiser.id, campaign.id, rupees(total));
        await captureCampaignHold(holdId);
        await prisma.campaign.update({ where: { id: campaign.id }, data: { walletHoldId: holdId } });
      } catch (error) {
        console.warn(`  ${spec.reference}: hold/capture failed — ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // The stats: a row per day it has run, and the tracked ones get a code with its scans and clicks.
    if (spec.status === 'LIVE' || spec.status === 'COMPLETED') {
      const code = spec.tracked
        ? await prisma.campaignTrackingCode.create({
            data: { campaignId: campaign.id, code: `demo${index}${spec.reference.slice(-2).toLowerCase()}`, method: 'QR_OR_DEEPLINK', destination: 'https://example.com/demo', createdAt: paidAt },
            select: { id: true },
          })
        : null;
      const ranUntil = spec.status === 'COMPLETED' ? endDate : dayOf(new Date());
      const reach = spots.reduce((sum, spot) => sum + spot.footfall, 0);
      const perDay = total / spec.lengthDays;
      let scansTotal = 0;
      let clicksTotal = 0;
      for (let day = new Date(startDate); day < ranUntil; day = new Date(day.getTime() + 86_400_000)) {
        const seed = index * 1000 + Math.round((day.getTime() - startDate.getTime()) / 86_400_000);
        const scans = code ? wobble(seed, 20, 140) * spots.length : 0;
        const clicks = code ? Math.round(scans * (wobble(seed + 1, 20, 45) / 100)) : 0;
        scansTotal += scans;
        clicksTotal += clicks;
        await prisma.campaignDailyMetric.upsert({
          where: { campaignId_day: { campaignId: campaign.id, day } },
          update: {},
          create: { campaignId: campaign.id, day, spotsLive: spots.length, spend: new Prisma.Decimal(perDay.toFixed(2)), scans, clicks, redemptions: code ? wobble(seed + 2, 0, 6) : 0, estimatedReach: reach, reachFromSpots: reach },
        });
        if (code && scans > 0) {
          // A handful of the day's scans as events — enough for the hour and device breakdowns to draw.
          const sample = Math.min(scans, 6);
          await prisma.trackingEvent.createMany({
            data: Array.from({ length: sample }, (_, i) => ({
              codeId: code.id,
              type: i < Math.max(1, Math.round(sample * (clicks / Math.max(scans, 1)))) ? ('CLICK' as const) : ('SCAN' as const),
              occurredAt: new Date(day.getTime() + (8 + i * 2) * 3_600_000),
              city: city.name,
              device: i % 2 === 0 ? 'Android' : 'iOS',
              hourIst: 8 + i * 2,
            })),
          });
        }
      }
      if (code) await prisma.campaignTrackingCode.update({ where: { id: code.id }, data: { scans: scansTotal, clicks: clicksTotal } });
    }
    console.log(`  created ${spec.reference} ${spec.name} (${spec.status}, ${spots.length} spots, ₹${total.toLocaleString('en-IN')})`);
  }
}

/** Advait's first-seed campaigns said they were paid with nothing behind it; they get their holds and captures now. */
async function backfillAdvaitHolds(advait: AdvertiserRow) {
  const rows = await prisma.campaign.findMany({ where: { advertiserId: advait.id, reference: { startsWith: 'ADX-CMP-2026-DEMO0' }, paidAt: { not: null }, walletHoldId: null }, select: { id: true, reference: true, total: true } });
  for (const row of rows) {
    if (row.total === null) continue;
    try {
      const { holdId } = await holdForCampaign(advait.id, row.id, money(new Decimal(row.total)));
      await captureCampaignHold(holdId);
      await prisma.campaign.update({ where: { id: row.id }, data: { walletHoldId: holdId } });
      console.log(`  captured ${row.reference} (₹${Number(row.total).toLocaleString('en-IN')})`);
    } catch (error) {
      console.warn(`  ${row.reference}: hold/capture failed — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/* ── Reviews on the completed spots ──────────────────────────────────── */

const REVIEW_NOTES = ['Bright, well placed, easy to find.', 'Footfall as promised; the publisher was quick to install.', 'Good spot, though the print faded in the rain.', 'Excellent visibility from the road.', 'Would book again for the next season.'];

async function ensureReviews(advertisers: Record<string, AdvertiserRow>) {
  const completed = await prisma.campaignSpot.findMany({
    where: { status: 'COMPLETED', campaign: { reference: { startsWith: 'ADX-CMP-2026-DEMO' } } },
    select: { id: true, campaignId: true, campaign: { select: { advertiserId: true, createdByUserId: true } } },
  });
  let written = 0;
  let index = 0;
  for (const spot of completed) {
    index += 1;
    const advertiser = Object.values(advertisers).find((row) => row.id === spot.campaign.advertiserId);
    if (!advertiser) continue;
    try {
      await reviewSpot(spot.campaignId, spot.id, { rating: wobble(index * 3, 3, 5), note: REVIEW_NOTES[index % REVIEW_NOTES.length] }, { userId: advertiser.userId, roles: ['ADVERTISER'], advertiserId: advertiser.id, agentId: null } as never);
      written += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already|once/i.test(message)) console.warn(`  review on spot ${spot.id} not written: ${message}`);
    }
  }
  // The first seed invented ratings with no reviews behind them; a spot with none says so now.
  const reviewed = (await prisma.review.findMany({ where: { subjectType: 'LISTING' }, select: { subjectId: true }, distinct: ['subjectId'] })).map((row) => row.subjectId);
  const reset = await prisma.listing.updateMany({ where: { description: { contains: 'Demo listing seeded' }, id: { notIn: reviewed } }, data: { ratingAvg: null, reviewCount: 0 } });
  console.log(`  ${written} reviews written; ${reset.count} invented ratings cleared`);
}

/* ── Earnings, payouts ───────────────────────────────────────────────── */

async function ensureEarningsAndPayouts(publishers: Record<string, PublisherRow>, demoSpaces: PublisherRow, adminId: string) {
  // Over a remote database a day's ledger transaction can outlive Prisma's
  // 5 s interactive-transaction window; the run is idempotent per spot and
  // day, so a second and third pass fill what the first one dropped.
  for (let pass = 1; pass <= 3; pass += 1) {
    const run = await runDailyAccrual(new Date());
    console.log(`  accrual pass ${pass}: ${JSON.stringify(run)}`);
    if (run.daysCredited === 0) break;
  }
  for (const publisher of [publishers['+919000000201']!, demoSpaces]) {
    const wallet = await prisma.wallet.findFirst({ where: { publisherId: publisher.id }, select: { id: true, balance: true } });
    if (!wallet || new Decimal(wallet.balance).lessThan(20000)) {
      console.log(`  ${publisher.name}: nothing cleared to withdraw yet`);
      continue;
    }
    if (await prisma.withdrawalRequest.findFirst({ where: { walletId: wallet.id }, select: { id: true } })) {
      console.log(`  kept    withdrawals of ${publisher.name}`);
      continue;
    }
    try {
      const method = await addMethod(publisher.userId, { type: 'BANK', accountHolder: publisher.name, bankName: 'HDFC Bank', accountNumber: `50100${wobble(publisher.name.length, 100000, 999999)}`, ifscCode: 'HDFC0001234' });
      await verifyMethod(method.id, { via: 'MANUAL', reference: NOTE, byUserId: adminId });
      // DR 04: the daily cap is tiered by size band and months on the platform; the demo asks for what is allowed.
      const allowance = await withdrawalAllowance(wallet.id);
      const first = Decimal.min(new Decimal(20000), new Decimal(allowance.maximum));
      if (first.lessThan(allowance.minimum)) {
        console.log(`  ${publisher.name}: allowed only ₹${allowance.maximum} today — no withdrawal`);
        continue;
      }
      const paid = await requestWithdrawal(wallet.id, { amount: money(first), payoutMethodId: method.id, userId: publisher.userId }, daysAgo(9));
      await approveWithdrawal(paid.id, { byUserId: adminId, rail: 'MANUAL_NEFT' }, daysAgo(8));
      await markWithdrawalPaid(paid.id, { railReference: `NEFT-DEMO-${wobble(publisher.name.length, 1000, 9999)}`, byUserId: adminId }, daysAgo(7));
      const again = await withdrawalAllowance(wallet.id);
      const second = Decimal.min(new Decimal(15000), new Decimal(again.maximum));
      if (second.greaterThanOrEqualTo(again.minimum)) {
        await requestWithdrawal(wallet.id, { amount: money(second), payoutMethodId: method.id, userId: publisher.userId }, daysAgo(1));
        console.log(`  ${publisher.name}: one withdrawal paid (₹${first}), one waiting (₹${second})`);
      } else {
        console.log(`  ${publisher.name}: one withdrawal paid (₹${first})`);
      }
    } catch (error) {
      console.warn(`  ${publisher.name}: payout steps failed — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/* ── Agents' field work: visits and leads ─────────────────────────────── */

async function ensureFieldWork(agents: Record<string, AgentRow>, city: Record<string, CityRow>, publishers: Record<string, PublisherRow>, advertisers: Record<string, AdvertiserRow>) {
  const rahul = agents['+919000000301']!;
  const priya = agents['+919000000302']!;
  const imran = agents['+919000000303']!;
  const leads: Array<{ agent: AgentRow; city: CityRow; side: 'PUBLISHER' | 'ADVERTISER'; business: string; category: string; status: 'NEW' | 'CONTACTED' | 'HOT' | 'VISIT_BOOKED' | 'LOST'; days: number; commission: number }> = [
    { agent: rahul, city: city['bengaluru']!, side: 'PUBLISHER', business: 'Garuda Mall', category: 'Shopping mall', status: 'VISIT_BOOKED', days: 5, commission: 4500 },
    { agent: rahul, city: city['bengaluru']!, side: 'PUBLISHER', business: 'Orion Mall Brigade Gateway', category: 'Shopping mall', status: 'HOT', days: 9, commission: 6000 },
    { agent: priya, city: city['bengaluru']!, side: 'ADVERTISER', business: 'Namma Fitness Studios', category: 'Fitness', status: 'CONTACTED', days: 2, commission: 2500 },
    { agent: priya, city: city['bengaluru']!, side: 'ADVERTISER', business: 'Sri Krishna Sweets', category: 'Food & beverage', status: 'NEW', days: 1, commission: 1800 },
    { agent: imran, city: city['mumbai']!, side: 'PUBLISHER', business: 'Juhu Beach Kiosks Association', category: 'Outdoor', status: 'LOST', days: 20, commission: 3000 },
  ];
  const leadIds = new Map<string, string>();
  for (const lead of leads) {
    const held = await prisma.lead.findFirst({ where: { businessName: lead.business, side: lead.side }, select: { id: true } });
    if (held) {
      leadIds.set(lead.business, held.id);
      continue;
    }
    const at = daysAgo(lead.days);
    const row = await prisma.lead.create({
      data: { displayId: await allocateIdentifier('LEAD', at), side: lead.side, businessName: lead.business, category: lead.category, contactName: 'Front desk', phone: `+9198000${wobble(lead.business.length, 10000, 99999)}`, city: lead.city.name, cityId: lead.city.id, status: lead.status, estimatedCommission: new Prisma.Decimal(lead.commission), assignedAgentId: lead.agent.id, createdAt: at },
      select: { id: true },
    });
    leadIds.set(lead.business, row.id);
  }
  // A visit is to exactly one party — the publisher or advertiser it onboarded, or the lead it is chasing.
  const visits: Array<{ agent: AgentRow; city: CityRow; business: string; kind: 'ONBOARDING' | 'RENEWAL' | 'AUDIT'; status: 'COMPLETED' | 'SCHEDULED'; days: number; party: { publisherId?: string; advertiserId?: string; leadId?: string } }> = [
    { agent: rahul, city: city['bengaluru']!, business: 'Skyline Outdoor Media', kind: 'ONBOARDING', status: 'COMPLETED', days: -136, party: { publisherId: publishers['+919000000201']!.id } },
    { agent: rahul, city: city['bengaluru']!, business: 'Garuda Mall', kind: 'AUDIT', status: 'SCHEDULED', days: 3, party: { leadId: leadIds.get('Garuda Mall')! } },
    { agent: priya, city: city['bengaluru']!, business: 'Bright Dental Clinics', kind: 'ONBOARDING', status: 'COMPLETED', days: -93, party: { advertiserId: advertisers['+919000000402']!.id } },
    { agent: imran, city: city['mumbai']!, business: 'Mumbai Hoardings Co', kind: 'ONBOARDING', status: 'COMPLETED', days: -28, party: { publisherId: publishers['+919000000204']!.id } },
  ];
  for (const visit of visits) {
    if (await prisma.fieldVisit.findFirst({ where: { agentId: visit.agent.id, businessName: visit.business, kind: visit.kind }, select: { id: true } })) continue;
    const when = daysAgo(-visit.days);
    await prisma.fieldVisit.create({
      data: { displayId: await allocateIdentifier('VISIT', when), kind: visit.kind, status: visit.status, agentId: visit.agent.id, businessName: visit.business, city: visit.city.name, cityId: visit.city.id, scheduledFor: when, ...visit.party, ...(visit.status === 'COMPLETED' ? { completedAt: new Date(when.getTime() + 2 * 3_600_000) } : {}), createdAt: new Date(when.getTime() - 2 * 86_400_000) },
    });
  }
  console.log('  visits and leads in place');
}

/* ── Main ────────────────────────────────────────────────────────────── */

async function main() {
  const admin = await adminUser();
  const city = await cities();
  let demoSpaces = await prisma.publisher.findUnique({ where: { mobile: DEMO_SPACES_MOBILE }, select: { id: true, userId: true, displayId: true, name: true, kycStatus: true } });
  if (!demoSpaces) throw new Error('Run seed:demo-listings first — the demo publisher is missing');
  if (!demoSpaces.userId) {
    // The first seed opened the publisher without an account; the desk gives it one, so it can be signed into and paid.
    const user = await ensureUser({ mobile: DEMO_SPACES_MOBILE, name: 'Demo Spaces', firstName: 'Demo', lastName: 'Spaces', email: 'spaces@demo.adx.in', role: 'PUBLISHER', joinedAt: daysAgo(150) });
    demoSpaces = await prisma.publisher.update({
      where: { id: demoSpaces.id },
      data: { userId: user.id, onboardedVia: 'DESK', onboardedById: admin.id, onboardedByRole: 'ADMIN', onboardedAt: daysAgo(150), onboardingStatus: 'ONBOARDING_COMPLETE' },
      select: { id: true, userId: true, displayId: true, name: true, kycStatus: true },
    });
    await acceptAgreement({ publisherId: demoSpaces.id }, 'PLATFORM', user.id, daysAgo(149));
  }
  const advait = await prisma.advertiser.findUnique({ where: { mobile: ADVAIT_MOBILE }, select: { id: true, userId: true, displayId: true, name: true, type: true } });

  console.log('Agents…');
  const agents = await ensureAgents(city, admin.id);
  console.log('Publishers…');
  const publishers = await ensurePublishers(city, agents, admin.id);
  await redistributeListings(demoSpaces.id, publishers, agents);
  console.log('More listings…');
  await ensureExtraListings(city, publishers, agents);
  console.log('Advertisers…');
  const advertisers = await ensureAdvertisers(city, agents, admin.id);
  console.log('Funding…');
  for (const spec of ADVERTISERS) await fund(advertisers[spec.mobile]!, spec.topUp, admin.id, daysAgo(spec.joinedDaysAgo - 1));
  if (advait?.userId) {
    const row: AdvertiserRow = { id: advait.id, userId: advait.userId, displayId: advait.displayId, name: advait.name, type: advait.type };
    await fund(row, 4000000, admin.id, daysAgo(70));
    console.log("Advait's holds…");
    await backfillAdvaitHolds(row);
    advertisers[ADVAIT_MOBILE] = row;
  }
  console.log('Campaigns…');
  const listings = await listingIndex();
  await ensureCampaigns(advertisers, listings, city.bengaluru, admin.id);
  console.log('Reviews…');
  await ensureReviews(advertisers);
  console.log('Earnings and payouts…');
  await ensureEarningsAndPayouts(publishers, { ...demoSpaces, userId: demoSpaces.userId! }, admin.id);
  console.log('Field work…');
  await ensureFieldWork(agents, city, publishers, advertisers);
  console.log('Done.');
  process.exit(0);
}

main().catch((error) => {
  console.error('seed:demo-platform failed:', error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
