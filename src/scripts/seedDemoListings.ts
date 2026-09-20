/**
 * Demo data for a dev database — QR-20 (the owner, 17 Sep 2026): "5 demo
 * listings under every category, each in its own sub-category, with pictures
 * and details; some campaigns, completed campaigns and their stats, so I can
 * see how it looks with all kinds of data present. I'll delete them later."
 *
 *   npm run seed:demo-listings              # the advertiser is +919000000101, or the newest with an app account
 *   npm run seed:demo-listings -- +91XXXXXXXXXX
 *
 * What it writes, idempotently (a row already there is left alone):
 *   - one publisher, "ADX Demo Spaces" (+919000000999), verified, in Bengaluru;
 *   - twenty live listings on it — five per category, each in a different
 *     venue (MEDIA has four venues, so television carries two), with two
 *     photographs each (picsum.photos, seeded so they stay the same), rates,
 *     sizes, footfall, the venue and a matching media type;
 *   - five campaigns for the advertiser — two completed, one live, one
 *     scheduled (paid, not started), one draft — with their spots on the demo
 *     listings, an order per booked spot, and a daily metric row per day the
 *     campaign ran (scans, clicks, redemptions, spend), which is what the
 *     analytics tiles and the console's campaign pages read.
 *
 * Nothing here touches wallets or invoices: the campaigns say they were paid
 * without a hold behind them. Everything is marked "Demo" in its notes so it
 * can be found and removed: `DELETE FROM "Listing" WHERE "publisherId" = <demo
 * publisher>` and the campaigns by reference `ADX-CMP-2026-DEMO*`.
 */
import { Prisma, prisma } from '../shared/database';
import { allocateIdentifier } from '../modules/identifiers';

const DEMO_PUBLISHER_MOBILE = '+919000000999';
const DEFAULT_ADVERTISER_MOBILE = '+919000000101';

type Spot = {
  venue: string;
  title: string;
  address: string;
  lat: number;
  lng: number;
  rate: number;
  subType: string;
  size: string | null;
  widthFt: number | null;
  heightFt: number | null;
  footfall: number;
  illumination: 'BACKLIT' | 'FRONTLIT' | 'DIGITAL' | 'NONE';
  facing: string | null;
  placement: string;
  media: RegExp;
  digital: boolean;
  instant: boolean;
  usp: string;
  audience: string;
};

const SPOTS: Spot[] = [
  // ── OUTDOOR ──────────────────────────────────────────────────────────
  { venue: 'city-roads-urban-streets-main-roads', title: 'MG Road Unipole — Trinity Circle', address: 'MG Road, near Trinity Circle, Bengaluru 560001', lat: 12.9737, lng: 77.6199, rate: 18000, subType: 'Unipole hoarding', size: '40 x 20 ft', widthFt: 40, heightFt: 20, footfall: 85000, illumination: 'BACKLIT', facing: 'Towards Brigade Road', placement: 'Median, eye level from both carriageways', media: /unipole|hoarding|billboard/i, digital: false, instant: true, usp: 'The busiest stretch of MG Road, seen from both directions.', audience: 'Office-goers, shoppers, tourists' },
  { venue: 'highways-expressways-national-highways', title: 'Hebbal Flyover Approach — Airport Road Billboard', address: 'Ballari Road, Hebbal, Bengaluru 560024', lat: 13.0358, lng: 77.5970, rate: 22000, subType: 'Billboard', size: '60 x 20 ft', widthFt: 60, heightFt: 20, footfall: 140000, illumination: 'FRONTLIT', facing: 'Airport-bound traffic', placement: 'Right of carriageway, 200 m before the flyover', media: /billboard|hoarding|gantry/i, digital: false, instant: false, usp: 'Every airport run passes it.', audience: 'Air travellers, north Bengaluru commuters' },
  { venue: 'flyovers-overpasses-elevated-roads-skywalks', title: 'Silk Board Flyover — Skywalk Panel', address: 'Silk Board junction, Hosur Road, Bengaluru 560068', lat: 12.9177, lng: 77.6233, rate: 9000, subType: 'Skywalk panel', size: '30 x 8 ft', widthFt: 30, heightFt: 8, footfall: 120000, illumination: 'BACKLIT', facing: 'Electronic City-bound', placement: 'Skywalk face over the junction', media: /skywalk|panel|flyover/i, digital: false, instant: true, usp: 'Stuck traffic reads it twice a day.', audience: 'IT corridor commuters' },
  { venue: 'it-parks-sez-tech-parks-business-parks', title: 'Manyata Tech Park — Entry Gantry', address: 'Manyata Embassy Business Park, Nagawara, Bengaluru 560045', lat: 13.0450, lng: 77.6200, rate: 15000, subType: 'Gantry', size: '50 x 10 ft', widthFt: 50, heightFt: 10, footfall: 60000, illumination: 'BACKLIT', facing: 'Main gate, inbound', placement: 'Across the entry road', media: /gantry|arch|entrance|hoarding/i, digital: false, instant: false, usp: 'Sixty thousand techies, every working morning.', audience: 'IT professionals, 24–40' },
  { venue: 'airports-outdoor-perimeter-areas', title: 'KIA Trumpet Junction — Approach Hoarding', address: 'Airport Trumpet Interchange, Devanahalli, Bengaluru 562157', lat: 13.1938, lng: 77.6810, rate: 26000, subType: 'Hoarding', size: '80 x 30 ft', widthFt: 80, heightFt: 30, footfall: 95000, illumination: 'FRONTLIT', facing: 'Terminal-bound', placement: 'Last hoarding before the terminal road', media: /hoarding|billboard|approach/i, digital: false, instant: false, usp: 'The last thing a flyer sees before the terminal.', audience: 'Business and leisure travellers' },
  // ── INDOOR ───────────────────────────────────────────────────────────
  { venue: 'shopping-malls-retail-centers-department-stores', title: 'Phoenix Marketcity — Atrium LED Wall', address: 'Phoenix Marketcity, Whitefield Main Road, Bengaluru 560048', lat: 12.9975, lng: 77.6965, rate: 12000, subType: 'Digital LED wall', size: '24 x 14 ft', widthFt: 24, heightFt: 14, footfall: 45000, illumination: 'DIGITAL', facing: 'Central atrium, all levels', placement: 'Atrium, above the food court escalators', media: /led|digital|screen|atrium/i, digital: true, instant: true, usp: 'Six-slot loop over the busiest atrium in east Bengaluru.', audience: 'Families, young professionals, weekend shoppers' },
  { venue: 'gyms-fitness-clubs-wellness-centers-yoga-studios', title: 'Cult.fit Indiranagar — Mirror Decals', address: '100 Feet Road, Indiranagar, Bengaluru 560038', lat: 12.9784, lng: 77.6408, rate: 2500, subType: 'Mirror decals', size: '4 x 6 ft (x6)', widthFt: 4, heightFt: 6, footfall: 900, illumination: 'NONE', facing: 'Workout floor', placement: 'Six mirror panels, floor level', media: /mirror|decal|wall/i, digital: false, instant: true, usp: 'Ninety minutes of dwell time per visit.', audience: 'Fitness-minded, 22–38' },
  { venue: 'restaurants-cafe-s-food-courts-qsrs-cloud-kitchens', title: 'Third Wave Coffee Koramangala — Table Tents', address: '5th Block, Koramangala, Bengaluru 560095', lat: 12.9345, lng: 77.6190, rate: 1800, subType: 'Table tent cards', size: 'A6 (x40 tables)', widthFt: null, heightFt: null, footfall: 700, illumination: 'NONE', facing: 'Every table', placement: 'Table tents, all seating', media: /table|tent|counter/i, digital: false, instant: true, usp: 'A card in hand for the length of a coffee.', audience: 'Students, start-up crowd' },
  { venue: 'multiplexes-cinemas-movie-theaters', title: 'PVR Forum Mall — Lobby Digital Screen', address: 'Forum Mall, Hosur Road, Koramangala, Bengaluru 560029', lat: 12.9346, lng: 77.6112, rate: 7000, subType: 'Digital lobby screen', size: '10 x 6 ft', widthFt: 10, heightFt: 6, footfall: 8000, illumination: 'DIGITAL', facing: 'Ticket lobby', placement: 'Above the box office', media: /digital|screen|lobby|led/i, digital: true, instant: false, usp: 'Every ticket holder waits under it.', audience: 'Movie-goers, 18–45' },
  { venue: 'supermarkets-hypermarkets-grocery-stores', title: 'More Megastore Jayanagar — Aisle Shelf Branding', address: '9th Block, Jayanagar, Bengaluru 560069', lat: 12.9250, lng: 77.5938, rate: 3200, subType: 'Shelf strip branding', size: '3 ft strips (x30)', widthFt: 3, heightFt: null, footfall: 4500, illumination: 'NONE', facing: 'Aisle 4–6', placement: 'Shelf edges, eye level', media: /shelf|aisle|strip|rack/i, digital: false, instant: true, usp: 'At the point of decision.', audience: 'Households, weekly shoppers' },
  // ── TRANSIT ──────────────────────────────────────────────────────────
  { venue: 'metro-subway-underground', title: 'Namma Metro MG Road Station — Pillar Wrap', address: 'MG Road Metro Station, Bengaluru 560001', lat: 12.9756, lng: 77.6068, rate: 9500, subType: 'Pillar wrap', size: '12 ft high (x4 pillars)', widthFt: 4, heightFt: 12, footfall: 52000, illumination: 'FRONTLIT', facing: 'Concourse', placement: 'Four concourse pillars', media: /pillar|wrap|concourse/i, digital: false, instant: false, usp: 'The busiest interchange on the Purple line.', audience: 'Daily commuters' },
  { venue: 'bus-bus-rapid-transit-brt', title: 'BMTC Shelter — Marathahalli Bridge', address: 'Outer Ring Road, Marathahalli, Bengaluru 560037', lat: 12.9569, lng: 77.7011, rate: 4200, subType: 'Bus shelter panel', size: '6 x 4 ft (x2)', widthFt: 6, heightFt: 4, footfall: 30000, illumination: 'BACKLIT', facing: 'ORR, both sides', placement: 'Shelter back panels', media: /shelter|panel|stop/i, digital: false, instant: true, usp: 'ORR traffic crawls past it every evening.', audience: 'Tech-park commuters' },
  { venue: 'auto-rickshaw', title: 'Auto-rickshaw Hood Wraps — Koramangala fleet (25)', address: 'Koramangala auto stand, Bengaluru 560034', lat: 12.9352, lng: 77.6245, rate: 3000, subType: 'Hood wrap', size: 'Rear hood (x25)', widthFt: null, heightFt: null, footfall: 25000, illumination: 'NONE', facing: 'Following traffic', placement: 'Rear hood, 25 autos', media: /hood|wrap|rear|back/i, digital: false, instant: true, usp: 'Moves through every lane in south Bengaluru.', audience: 'Everyone on the road' },
  { venue: 'taxi-cab-app-based-traditional', title: 'Cab Door Branding — Whitefield corridor (40 cabs)', address: 'Whitefield, Bengaluru 560066', lat: 12.9698, lng: 77.7500, rate: 5500, subType: 'Door branding', size: 'Both rear doors (x40)', widthFt: null, heightFt: null, footfall: 40000, illumination: 'NONE', facing: 'Kerb side', placement: 'Rear doors, 40 cabs', media: /door|cab|wrap|exterior/i, digital: false, instant: false, usp: 'Forty cabs on the airport and tech-park runs.', audience: 'Professionals, travellers' },
  { venue: 'railway-train-stations', title: 'KSR Bengaluru City Station — Platform 1 Digital Screen', address: 'KSR Railway Station, Majestic, Bengaluru 560023', lat: 12.9783, lng: 77.5693, rate: 6800, subType: 'Digital platform screen', size: '8 x 5 ft', widthFt: 8, heightFt: 5, footfall: 110000, illumination: 'DIGITAL', facing: 'Platform 1', placement: 'Above the platform 1 waiting area', media: /digital|screen|platform|led/i, digital: true, instant: false, usp: 'A lakh of passengers a day, most of them waiting.', audience: 'Intercity travellers' },
  // ── MEDIA ────────────────────────────────────────────────────────────
  { venue: 'television', title: 'Regional TV — Prime-time 30s slot (Kannada GEC)', address: 'Statewide broadcast, Karnataka', lat: 12.9716, lng: 77.5946, rate: 40000, subType: '30-second spot', size: '30 s', widthFt: null, heightFt: null, footfall: 1800000, illumination: 'NONE', facing: null, placement: '8–10 pm, weekdays', media: /spot|slot|prime|advert|commercial/i, digital: false, instant: false, usp: 'Eighteen lakh households at prime time.', audience: 'Families, 25–55' },
  { venue: 'news-television', title: 'News Channel — Evening Bulletin Sponsor Tag', address: 'Statewide broadcast, Karnataka', lat: 12.9716, lng: 77.5946, rate: 32000, subType: 'Sponsor tag', size: '10 s', widthFt: null, heightFt: null, footfall: 900000, illumination: 'NONE', facing: null, placement: '7 pm bulletin, daily', media: /sponsor|tag|bulletin|ticker|advert/i, digital: false, instant: false, usp: 'Your name on the day\'s news.', audience: 'Decision-makers, 30–60' },
  { venue: 'radio', title: 'FM Radio — Morning Drive 20s spot (Bengaluru)', address: 'FM broadcast, Bengaluru', lat: 12.9716, lng: 77.5946, rate: 12000, subType: '20-second spot', size: '20 s', widthFt: null, heightFt: null, footfall: 600000, illumination: 'NONE', facing: null, placement: '7–10 am, weekdays', media: /spot|jingle|slot|advert|drive/i, digital: false, instant: true, usp: 'The commute, in every car and cab.', audience: 'Commuters, 22–45' },
  { venue: 'print', title: 'City Daily — Front-page Solus (Bengaluru edition)', address: 'Print, Bengaluru edition', lat: 12.9716, lng: 77.5946, rate: 60000, subType: 'Front-page solus', size: '33 x 12 cm', widthFt: null, heightFt: null, footfall: 450000, illumination: 'NONE', facing: null, placement: 'Front page, below the masthead', media: /front|solus|page|advert|display/i, digital: false, instant: false, usp: 'Above the fold, city-wide.', audience: 'Households, 30+' },
  { venue: 'television', title: 'Regional TV — Late-night 15s slot', address: 'Statewide broadcast, Karnataka', lat: 12.9716, lng: 77.5946, rate: 15000, subType: '15-second spot', size: '15 s', widthFt: null, heightFt: null, footfall: 500000, illumination: 'NONE', facing: null, placement: '11 pm–1 am, daily', media: /spot|slot|advert|commercial/i, digital: false, instant: true, usp: 'The cheapest way onto television.', audience: 'Night owls, 18–35' },
];

const daysAgo = (days: number): Date => new Date(Date.now() - days * 86_400_000);
const dayOf = (date: Date): Date => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
const picsum = (seed: string, w = 900, h = 600) => `https://picsum.photos/seed/${encodeURIComponent(seed)}/${w}/${h}`;
/** A deterministic wobble, so the stats look lived-in and stay the same between runs. */
const wobble = (seed: number, min: number, max: number): number => {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return Math.round(min + (x - Math.floor(x)) * (max - min));
};

async function ensurePublisher(cityId: string | null) {
  const existing = await prisma.publisher.findUnique({ where: { mobile: DEMO_PUBLISHER_MOBILE } });
  if (existing) return existing;
  return prisma.publisher.create({
    data: {
      name: 'ADX Demo Spaces',
      mobile: DEMO_PUBLISHER_MOBILE,
      email: 'demo-spaces@adx.local',
      type: 'BUSINESS',
      address: '1, Demo Street, Indiranagar',
      city: 'Bengaluru',
      cityId,
      state: 'Karnataka',
      latitude: 12.9784,
      longitude: 77.6408,
      displayId: await allocateIdentifier('PUBLISHER'),
      kycStatus: 'VERIFIED',
      onboardingStatus: 'ONBOARDING_COMPLETE',
      activatedAt: daysAgo(150),
      contactName: 'Demo Desk',
      contactMobile: '9000000999',
    },
  });
}

async function ensureListings(publisherId: string, cityId: string | null): Promise<Map<string, { id: string; rate: number; footfall: number; title: string }>> {
  const venues = await prisma.venueType.findMany({ select: { id: true, slug: true, category: true } });
  const bySlug = new Map(venues.map((venue) => [venue.slug, venue]));
  const made = new Map<string, { id: string; rate: number; footfall: number; title: string }>();
  let index = 0;
  for (const spot of SPOTS) {
    index += 1;
    const venue = bySlug.get(spot.venue);
    if (!venue) {
      console.warn(`  skip "${spot.title}": no venue "${spot.venue}" in the catalogue`);
      continue;
    }
    const existing = await prisma.listing.findFirst({ where: { publisherId, title: spot.title }, select: { id: true } });
    if (existing) {
      made.set(spot.title, { id: existing.id, rate: spot.rate, footfall: spot.footfall, title: spot.title });
      console.log(`  kept    ${spot.title}`);
      continue;
    }
    const mediaType =
      (await prisma.mediaType.findFirst({ where: { venueTypeId: venue.id, status: 'ACTIVE', name: { contains: spot.media.source.split('|')[0]!.replace(/[^a-z ]/gi, ''), mode: 'insensitive' } }, select: { id: true } })) ??
      (await prisma.mediaType.findFirst({ where: { venueTypeId: venue.id, status: 'ACTIVE' }, select: { id: true }, orderBy: { name: 'asc' } }));
    const publishedAt = daysAgo(wobble(index, 3, 90));
    const listing = await prisma.listing.create({
      data: {
        publisherId,
        title: spot.title,
        category: venue.category,
        subType: spot.subType,
        description: `${spot.usp} Demo listing seeded for the dev environment — ${spot.placement}.`,
        address: spot.address,
        city: 'Bengaluru',
        cityId,
        latitude: spot.lat,
        longitude: spot.lng,
        size: spot.size,
        ratePerDay: new Prisma.Decimal(spot.rate),
        basePrice: new Prisma.Decimal(spot.rate),
        pricingUnit: 'PER_DAY',
        monthlyPrice: spot.rate * 30,
        instantBooking: spot.instant,
        slotsTotal: spot.digital ? 6 : 1,
        widthFt: spot.widthFt === null ? null : new Prisma.Decimal(spot.widthFt),
        heightFt: spot.heightFt === null ? null : new Prisma.Decimal(spot.heightFt),
        areaSqFt: spot.widthFt !== null && spot.heightFt !== null ? new Prisma.Decimal(spot.widthFt * spot.heightFt) : null,
        estimatedDailyFootfall: spot.footfall,
        illumination: spot.illumination,
        facing: spot.facing,
        placement: spot.placement,
        uniqueSellingPoint: spot.usp,
        targetAudience: spot.audience,
        venueTypeId: venue.id,
        mediaTypeId: mediaType?.id ?? null,
        availableNow: true,
        status: 'ACTIVE',
        displayId: await allocateIdentifier('LISTING'),
        publishedAt,
        verifiedAt: publishedAt,
        ratingAvg: new Prisma.Decimal((wobble(index * 7, 36, 49) / 10).toFixed(1)),
        reviewCount: wobble(index * 11, 3, 40),
        photos: {
          create: [
            { url: picsum(`adx-demo-${index}-a`), type: 'main' },
            { url: picsum(`adx-demo-${index}-b`, 900, 700), type: 'gallery' },
          ],
        },
      },
      select: { id: true },
    });
    made.set(spot.title, { id: listing.id, rate: spot.rate, footfall: spot.footfall, title: spot.title });
    console.log(`  created ${spot.title}`);
  }
  return made;
}

type CampaignSpec = {
  reference: string;
  name: string;
  status: 'DRAFT' | 'SCHEDULED' | 'LIVE' | 'COMPLETED';
  startsInDays: number;
  lengthDays: number;
  goal: 'BRAND_AWARENESS' | 'DIGITAL_LIFT' | 'LOCAL_FOOTFALL';
  spots: string[];
};

const CAMPAIGNS: CampaignSpec[] = [
  { reference: 'ADX-CMP-2026-DEMO01', name: 'Monsoon Coffee Launch', status: 'COMPLETED', startsInDays: -60, lengthDays: 30, goal: 'LOCAL_FOOTFALL', spots: ['MG Road Unipole — Trinity Circle', 'Third Wave Coffee Koramangala — Table Tents', 'Namma Metro MG Road Station — Pillar Wrap'] },
  { reference: 'ADX-CMP-2026-DEMO02', name: 'Summer Fitness Push', status: 'COMPLETED', startsInDays: -120, lengthDays: 30, goal: 'BRAND_AWARENESS', spots: ['Cult.fit Indiranagar — Mirror Decals', 'More Megastore Jayanagar — Aisle Shelf Branding'] },
  { reference: 'ADX-CMP-2026-DEMO03', name: 'Diwali Sale — Whitefield', status: 'LIVE', startsInDays: -10, lengthDays: 30, goal: 'DIGITAL_LIFT', spots: ['Phoenix Marketcity — Atrium LED Wall', 'Cab Door Branding — Whitefield corridor (40 cabs)', 'PVR Forum Mall — Lobby Digital Screen', 'BMTC Shelter — Marathahalli Bridge'] },
  { reference: 'ADX-CMP-2026-DEMO04', name: 'New Year Countdown', status: 'SCHEDULED', startsInDays: 14, lengthDays: 16, goal: 'BRAND_AWARENESS', spots: ['KIA Trumpet Junction — Approach Hoarding', 'Regional TV — Prime-time 30s slot (Kannada GEC)'] },
  { reference: 'ADX-CMP-2026-DEMO05', name: 'Autumn brand recall (draft)', status: 'DRAFT', startsInDays: 30, lengthDays: 14, goal: 'BRAND_AWARENESS', spots: ['Hebbal Flyover Approach — Airport Road Billboard'] },
];

async function ensureCampaigns(advertiserMobile: string, listings: Map<string, { id: string; rate: number; footfall: number; title: string }>, cityId: string | null) {
  const advertiser =
    (await prisma.advertiser.findFirst({ where: { mobile: advertiserMobile } })) ??
    (await prisma.advertiser.findFirst({ where: { userId: { not: null } }, orderBy: { createdAt: 'desc' } }));
  if (!advertiser || !advertiser.userId) {
    console.warn('  no advertiser with an app account to hang the campaigns on — skipped');
    return;
  }
  const brand = await prisma.brand.findFirst({ where: { advertiserId: advertiser.id }, select: { id: true, name: true } });
  // A run that failed half-way leaves a campaign with no spots; start it over.
  const halfMade = await prisma.campaign.findMany({ where: { reference: { startsWith: 'ADX-CMP-2026-DEMO' }, spots: { none: {} } }, select: { id: true, reference: true } });
  for (const row of halfMade) {
    await prisma.campaignDailyMetric.deleteMany({ where: { campaignId: row.id } });
    await prisma.campaign.delete({ where: { id: row.id } });
    console.log(`  redoing ${row.reference}`);
  }
  console.log(`  campaigns for ${advertiser.name} (${advertiser.displayId ?? advertiser.id})`);
  let index = 0;
  for (const spec of CAMPAIGNS) {
    index += 1;
    if (await prisma.campaign.findUnique({ where: { reference: spec.reference }, select: { id: true } })) {
      console.log(`  kept    ${spec.reference} ${spec.name}`);
      continue;
    }
    const startDate = dayOf(daysAgo(-spec.startsInDays));
    const endDate = new Date(startDate.getTime() + spec.lengthDays * 86_400_000);
    const spots = spec.spots.map((title) => listings.get(title)).filter((row): row is { id: string; rate: number; footfall: number; title: string } => Boolean(row));
    const subtotal = spots.reduce((sum, spot) => sum + spot.rate * spec.lengthDays, 0);
    const fees = Math.round(subtotal * 0.1);
    const gst = Math.round((subtotal + fees) * 0.18);
    const total = subtotal + fees + gst;
    const paid = spec.status !== 'DRAFT';
    const spotStatus = spec.status === 'COMPLETED' ? 'COMPLETED' : spec.status === 'LIVE' ? 'LIVE' : spec.status === 'SCHEDULED' ? 'BOOKED' : 'RESERVED';
    const campaign = await prisma.campaign.create({
      data: {
        reference: spec.reference,
        advertiserId: advertiser.id,
        brandId: brand?.id ?? null,
        createdByUserId: advertiser.userId,
        name: spec.name,
        status: spec.status,
        step: spec.status === 'DRAFT' ? 6 : 17,
        brandName: brand?.name ?? advertiser.companyName ?? advertiser.name,
        industry: 'Retail',
        goal: spec.goal,
        awareness: 'ALREADY_ESTABLISHED',
        targetingMethod: 'RADIUS',
        targetLocation: 'Bengaluru',
        targetLatitude: 12.9716,
        targetLongitude: 77.5946,
        targetRadiusKm: 15,
        targetMarket: 'Bengaluru',
        targetMarketCityId: cityId,
        strategy: 'GENERAL',
        persona: 'HIGH_INCOME_CONSUMERS',
        budget: new Prisma.Decimal(Math.round(total * 1.1)),
        startDate,
        endDate,
        creativePath: 'STATIC_IMAGES',
        trackingMethod: 'QR_OR_DEEPLINK',
        fulfilment: 'ADX_PRINTS',
        ...(paid
          ? {
              spotsSubtotal: new Prisma.Decimal(subtotal),
              feesTotal: new Prisma.Decimal(fees),
              gstAmount: new Prisma.Decimal(gst),
              discount: new Prisma.Decimal(0),
              total: new Prisma.Decimal(total),
              paidAt: new Date(startDate.getTime() - 2 * 86_400_000),
            }
          : {}),
        launchedAt: spec.status === 'LIVE' || spec.status === 'COMPLETED' ? startDate : null,
        completedAt: spec.status === 'COMPLETED' ? endDate : null,
      },
      select: { id: true },
    });
    for (const spot of spots) {
      const order = paid
        ? await prisma.order.create({
            data: {
              // The legacy order table keys the advertiser by their USER, not the profile.
              advertiserId: advertiser.userId,
              listingId: spot.id,
              status: spec.status === 'COMPLETED' ? 'COMPLETED' : spec.status === 'LIVE' ? 'IN_PROGRESS' : 'PENDING_PRINT',
              campaignName: spec.name,
              budget: spot.rate * spec.lengthDays,
              startDate,
              endDate,
              notes: `Demo — campaign ${spec.reference}`,
              publisherAcceptedAt: new Date(startDate.getTime() - 86_400_000),
              adminApprovedAt: new Date(startDate.getTime() - 86_400_000),
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
          ...(spec.status === 'DRAFT' ? { reservedUntil: new Date(Date.now() + 86_400_000) } : {}),
        },
      });
    }
    // The stats: one row per day the campaign has run so far — what the tiles and the trend read.
    if (spec.status === 'LIVE' || spec.status === 'COMPLETED') {
      const ranUntil = spec.status === 'COMPLETED' ? endDate : dayOf(new Date());
      const reach = spots.reduce((sum, spot) => sum + spot.footfall, 0);
      const perDay = total / spec.lengthDays;
      for (let day = new Date(startDate); day < ranUntil; day = new Date(day.getTime() + 86_400_000)) {
        const seed = index * 1000 + Math.round((day.getTime() - startDate.getTime()) / 86_400_000);
        const scans = wobble(seed, 30, 180) * spots.length;
        await prisma.campaignDailyMetric.upsert({
          where: { campaignId_day: { campaignId: campaign.id, day } },
          update: {},
          create: {
            campaignId: campaign.id,
            day,
            spotsLive: spots.length,
            spend: new Prisma.Decimal(perDay.toFixed(2)),
            scans,
            clicks: Math.round(scans * (wobble(seed + 1, 18, 42) / 100)),
            redemptions: wobble(seed + 2, 0, 9),
            estimatedReach: reach,
            reachFromSpots: reach,
          },
        });
      }
    }
    console.log(`  created ${spec.reference} ${spec.name} (${spec.status}, ${spots.length} spots, ₹${total.toLocaleString('en-IN')})`);
  }
}

async function main() {
  const advertiserMobile = process.argv[2] ?? DEFAULT_ADVERTISER_MOBILE;
  const city = await prisma.city.findFirst({ where: { slug: 'bengaluru' }, select: { id: true } });
  console.log('Demo publisher…');
  const publisher = await ensurePublisher(city?.id ?? null);
  console.log(`  ${publisher.name} (${publisher.displayId ?? publisher.id})`);
  console.log('Demo listings…');
  const listings = await ensureListings(publisher.id, city?.id ?? null);
  console.log('Demo campaigns…');
  await ensureCampaigns(advertiserMobile, listings, city?.id ?? null);
  console.log('Done.');
  process.exit(0);
}

main().catch((error) => {
  console.error('seed:demo-listings failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
