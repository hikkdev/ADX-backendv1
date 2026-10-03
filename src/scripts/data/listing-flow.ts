/**
 * The listing wizard `scripts/seedConfig` writes to `flows.listing`, as data.
 *
 * Kept apart from the seed so the app-config tests can hold it against the
 * wizard vocabulary (`flow-schema.ts`) without running the seed: the seed
 * opens a database, this file opens nothing. The city list is the one
 * argument, because it is read from the `City` table rather than typed.
 */

import { ELEVATIONS, LISTING_VEHICLE_TYPES, TRAFFIC_GRADES, VISIBILITY_RANGES, flowOptionsOf } from '../../shared/listing-vocabulary';

export type CityOption = { id: string; title: string; description?: string };

/**
 * Physical attributes, in the admin console's own words.
 *
 * These are the exact option strings `listing-create.tsx` writes, deliberately:
 * pricing factors key on them, and "Back-lit", "backlit" and "Illuminated" are
 * one property spelled three ways that no rule can match. A listing keyed in on
 * a phone and one keyed in at a desk have to be the same listing described the
 * same way. Plain strings in the column, so ops can extend the list without a
 * migration — but they have to be *a* list, not prose.
 */
const ILLUMINATION_OPTIONS = [
  { id: 'Non-lit', title: 'Non-lit', description: 'No light of its own' },
  { id: 'Front-lit', title: 'Front-lit', description: 'Lit from the front by fixtures' },
  { id: 'Back-lit', title: 'Back-lit', description: 'Lit from behind the face' },
  { id: 'Digital', title: 'Digital', description: 'A screen — it is its own light source' },
];

const FACING_OPTIONS = [
  { id: 'Single', title: 'Single', description: 'One face, one direction of traffic' },
  { id: 'Double', title: 'Double', description: 'Two faces, both directions' },
  { id: 'Junction', title: 'Junction', description: 'Seen from more than one approach' },
  { id: 'Multi-facing', title: 'Multi-facing', description: 'Three or more faces' },
];

/**
 * The venue proof a desk reviewer reads before an agent is sent to the site.
 *
 * Which kinds are asked for depends on the category, because the papers do:
 * a hoarding on a public road needs the municipal permit that an indoor mirror
 * decal has no concept of, and a thirty-second slot on a television channel has
 * no address to prove. The kinds themselves are `ListingDocumentKind` and are
 * posted to `POST /supply/listings/:listingId/documents` one at a time.
 */
/*
 * LF-2 (the owner, 28 Sep 2026): "I don't want any difference between how
 * website flow works and how app flow works." The website's designed wizard
 * (DR 12 board 08) asked more than this flow did — installation, the vehicle
 * model, a broadcast outlet's language, format and slot, the audience
 * evidence, the booking terms, the rate card's validity and the four photo
 * angles. They are the flow's now, so every surface asks them. The option
 * ids are the words stored in the listing's columns (as ILLUMINATION's are),
 * except where a column is a number of days, where the id is that number.
 */
const opts = (words: readonly string[]) => words.map((word) => ({ id: word, title: word }));

const LANGUAGES = ['Hindi', 'English', 'Hindi · English', 'Kannada', 'Tamil', 'Telugu', 'Malayalam', 'Marathi', 'Bengali', 'Gujarati', 'Punjabi', 'Other'];
const CONTENT_FORMATS = ['Music and entertainment', 'News and current affairs', 'Talk and interviews', 'Sports', 'Regional programming', 'Business', 'Lifestyle', 'Other'];
const SLOT_DURATIONS = ['10 seconds', '15 seconds', '20 seconds', '30 seconds', '60 seconds', 'Quarter page', 'Half page', 'Full page', 'Other'];

const AGE_BANDS = ['18–24', '25–34', '35–44', '45–54', '55+', 'Mixed'];
const GENDER_SPLITS = ['Mostly men', 'Mostly women', 'Balanced'];
const URBAN_RURAL = ['Urban', 'Semi-urban', 'Rural', 'Mixed'];
const SEC_PROFILES = ['SEC A', 'SEC A / B', 'SEC B', 'SEC B / C', 'SEC C', 'Mixed'];
const INCOME_BRACKETS = ['Under ₹3 lakh a year', '₹3 – 6 lakh', '₹6 – 12 lakh', '₹12 – 25 lakh', 'Over ₹25 lakh', 'Mixed'];
const OCCUPATIONS = ['Office workers', 'Students', 'Shoppers', 'Commuters', 'Business owners', 'Families', 'Tourists', 'Mixed'];

/** `availableYearRound` on the listing (LF-2): yes → true, no → false. Never `availableNow`, which LD-1 asks as its own switch. */
const YEAR_ROUND = [
  { id: 'yes', title: 'Yes, all year' },
  { id: 'no', title: 'No — only in some seasons' },
];
/** `maxBookingDays` — the id is the number of days. */
const MAX_BOOKING = [
  { id: '7', title: '7 days' },
  { id: '14', title: '14 days' },
  { id: '30', title: '30 days' },
  { id: '90', title: '90 days' },
  { id: '180', title: '180 days' },
  { id: '365', title: '1 year' },
];
/** `advanceBookingDays` — the id is the number of days. */
const ADVANCE_BOOKING = [
  { id: '0', title: 'No notice needed' },
  { id: '3', title: '3 days ahead' },
  { id: '7', title: '7 days ahead' },
  { id: '14', title: '14 days ahead' },
  { id: '30', title: '30 days ahead' },
];
/**
 * `cancellationPolicy` + `cancellationNoticeDays`: flexible → FLEXIBLE; a
 * number → NOTICE with that many days; none → NONE. A days-only column could
 * not say "free up to 48 hours before" or "no cancellation once confirmed".
 */
const CANCELLATION_NOTICE = [
  { id: 'flexible', title: 'Flexible · free up to 48 hours before' },
  { id: '7', title: "7 days' notice" },
  { id: '14', title: "14 days' notice" },
  { id: '30', title: "30 days' notice" },
  { id: 'none', title: 'No cancellation once confirmed' },
];
/** `seasonalVariationNote` — stored as the words chosen. */
const SEASONAL_VARIATIONS = opts([
  'No seasonal change',
  'Higher in the festive season (Oct – Dec)',
  'Higher in the wedding season',
  'Lower in summer',
  'Lower in the monsoon',
  'Premium in event weeks',
  'Other — noted on the card',
]);

/** QR-24: the ways a space is held; everything but OWNED carries a date it runs out. */
const RIGHTS_OPTIONS = [
  { id: 'OWNED', title: 'I own it', description: 'The land, wall or vehicle is yours' },
  { id: 'LEASED', title: 'On a lease', description: 'Rented from the owner for a term' },
  { id: 'LICENSED', title: 'On a licence', description: 'A display licence from the owner or operator' },
  { id: 'PERMIT', title: 'On a permit', description: 'Municipal, highway, railway or airport authority — usually renewed each year' },
];

function documentKinds(category: string) {
  const ownerNoc = {
    id: 'OWNER_NOC',
    title: 'Owner NOC',
    description: "The venue owner's permission to display, if the owner is not you",
  };
  const addressProof = {
    id: 'ADDRESS_PROOF',
    title: 'Address proof',
    description: 'A recent utility bill or rent receipt for the venue',
  };
  const displayAgreement = {
    id: 'DISPLAY_AGREEMENT',
    title: 'Display agreement',
    description: 'The signed agreement covering this spot',
  };
  const municipalPermit = {
    id: 'MUNICIPAL_PERMIT',
    title: 'Municipal permit',
    description: 'The civic or highway authority permit for this site',
  };
  const other = {
    id: 'OTHER',
    title: 'Anything else',
    description: 'Any other paper that shows you may sell this space',
  };

  // A broadcast slot has no landlord and no street address. Asking for either
  // would be asking for a document that cannot exist.
  if (category === 'media') return [displayAgreement, other];
  if (category === 'outdoor' || category === 'transit') {
    return [ownerNoc, addressProof, displayAgreement, municipalPermit];
  }
  return [ownerNoc, addressProof, displayAgreement];
}

/**
 * The listing wizard: ten steps, then the papers and a review (LF-2, 28 Sep
 * 2026, added audience evidence, booking terms and the rate card — the
 * numbered list below is the original seven).
 *
 * DR 02 draws it as "Step N of 7", and the seven are a sequence rather than a
 * list — each one narrows what the next may offer. Category decides which
 * venues exist; the venue decides which spot types exist; the spot type decides
 * which sizes and materials exist. Collapsing any of them into a single screen
 * would mean offering a publisher a mall's atrium LED wall inside a hospital.
 *
 *   1  Ad space category      branches the flow
 *   2  Venue                  part of the comparable match key
 *   3  Ad spot type           part of the match key, filtered by venue
 *   4  Spot details           the pin and the tape; the size class is derived
 *   5  More info              the selling story
 *   6  Content rules          brand safety, per listing
 *   7  Pricing & availability the publisher's own unit, with the indicator
 *      Documents & permits    unnumbered — the frame heads it "Verification"
 *      Review & submit        unnumbered, because it collects nothing new
 *
 * The version this replaces asked for a free-text size ("e.g. 40ft x 20ft"), a
 * free-text space type and a monthly price on a slider — a perfectly reasonable
 * form that produced listings the engine could never match. Comparables are
 * keyed on an exact venue, media type and size class within 200 m, so free text
 * is not a lesser version of that key; it is not that key at all.
 */
export const LISTING_FLOW = {
  label: 'Listing',
  version: 1,
  screens: [
    {
      key: 'select-category',
      title: 'Ad space category',
      subtitle: 'Choose the ad space category for this listing.',
      step: 1, totalSteps: 10, ctaLabel: 'Continue',
      fields: [
        {
          id: 'category',
          type: 'selectable-cards',
          label: 'Category',
          required: true,
          branching: true,
          options: [
            { id: 'indoor', title: 'Indoor', description: 'Malls, gyms, clinics, offices, cinemas' },
            { id: 'outdoor', title: 'Outdoor', description: 'Hoardings, gantries, roadside sites' },
            { id: 'transit', title: 'Transit', description: 'Metro, rail, bus, taxi, airport' },
            // Offline media only. Anything that needs the internet to run —
            // OTT, connected TV, podcasts — is out of scope, so it is out of
            // the catalogue too.
            { id: 'media', title: 'Media', description: 'Television, radio and print' },
          ],
        },
      ],
    },
  ],
  branches: {},
};

/**
 * Every branch is the same seven steps.
 *
 * They were three to five before, differing in ways nothing depended on — and
 * the shorter ones skipped the location step entirely, which is why a transit
 * spot could be listed with no address at all. One shape means a listing is the
 * same record whatever it is, and the category still does real work: it filters
 * the venues offered, and it gates comparable matching.
 */
function listingBranch(id: string, title: string, description: string, cities: CityOption[]) {
  return {
    id, title, description,
    screens: [
      {
        key: 'venue',
        title: 'Venue selection',
        subtitle: 'Where the spot lives. This decides which spots yours is priced against.',
        step: 2, totalSteps: 10, ctaLabel: 'Continue',
        fields: [
          // The controlled list, filtered by the category chosen in step 1.
          // Outdoor spots have no venue — a hoarding is on a road, not inside
          // anything — so the branch offers "none" rather than forcing a choice.
          // Required wherever venues exist. Outdoor is the exception: a
          // hoarding stands on a road rather than inside something.
          //
          // Media has venues too, of a different kind — the medium is the venue
          // (television, radio, print) and the channel or paper is the area
          // inside it. A thirty-second spot on Star Plus compares to one on Zee
          // TV; it does not compare to a front-page jacket.
          { type: 'venue-type', id: 'venue_type_id', label: id === 'media' ? 'Medium' : 'Venue', required: id !== 'outdoor', filterByCategory: true },
        ],
      },
      {
        key: 'spot-type',
        title: 'Ad spot type',
        subtitle: 'What kind of spot it is. Only the formats this venue actually has.',
        step: 3, totalSteps: 10, ctaLabel: 'Continue',
        fields: [
          // Resolved against the taxonomy rather than typed. A name that matches
          // nothing is logged for ops instead of quietly minting a duplicate.
          { type: 'media-type', id: 'media_type_id', label: 'Ad spot type', required: true, dependsOn: 'venue_type_id', groupBy: 'formatGroup' },
          { type: 'material', id: 'material_id', label: 'Material', required: false, dependsOn: 'media_type_id' },
        ],
      },
      {
        key: 'spot-details',
        title: 'Spot details',
        subtitle: 'Add core info for the selected ad spot.',
        step: 4, totalSteps: 10, ctaLabel: 'Save spot details',
        fields: [
          // The frame heads this group with the spot type the publisher picked
          // — "Mirror Decals" — rather than a fixed word, so the section names
          // the thing being described. `from` tells the renderer which answer
          // to read; the label is what it prints when that answer is missing.
          { type: 'section', id: 'sec_spot', label: 'Ad spot', from: ['media_type_id'] },
          { type: 'text', id: 'title', label: 'Ad spot name', placeholder: 'Gym mirror decal - reception wall', required: true },
          // Offered from the venue's own list of areas, not typed: "food court",
          // "Food Court" and "FC" are one place spelled three ways.
          { type: 'sub-venue', id: 'placement', label: id === 'media' ? 'Channel or publication' : 'Placement area', required: id === 'media', dependsOn: 'venue_type_id' },
          // A broadcast has a region rather than a street corner, so the address
          // and the pin are asked of physical inventory only. The comparable
          // radius is meaningless for a channel: two spots on the same channel
          // are the same inventory wherever the buyer is standing.
          /*
           * Required on every branch, including media.
           *
           * It was optional for a channel on the grounds that a broadcast slot
           * has no street — true, and it made the whole media branch
           * unsubmittable, because `createListingSchema` requires an address
           * and the create body sent the blank one straight through. A channel
           * does have a findable identity; asking for it under its own name is
           * better than asking for nothing and failing at the API.
           */
          {
            type: 'text',
            id: 'address',
            label: id === 'media' ? 'Channel, station or publication' : 'Full address',
            placeholder:
              id === 'media' ? 'e.g. Radio Mirchi 98.3 FM, Mumbai' : 'Street, area, landmark',
            required: true,
          },
          // Asked separately from the address, and offered from a list, because
          // it is matched rather than read: MARKET_OR_DMA campaigns select
          // inventory by an exact city string, so a spot whose city was buried
          // inside a free-text address — which is where it was until now —
          // matched no market at all.
          { type: 'city', id: 'city', label: 'City', placeholder: 'Bengaluru', required: id !== 'media', options: cities },
          /*
           * VH-3: a moving spot's registration.
           *
           * Transit only, and optional there: the branch covers a metro
           * station and a taxi wrap alike, and a platform hoarding has no
           * plate. Optional is the honest setting — a publisher who cannot
           * find the RC book in the moment must still be able to finish the
           * listing, and ADX can ask later.
           *
           * The app draws a Verify button under this field (it is matched on
           * the id), which checks the number against the vehicle register and
           * says whether the owner matches the publisher. The check is the
           * app's because it calls a vendor; whether the field is ASKED at
           * all is decided here, so the categories can change without a
           * release.
           */
          ...(id === 'transit'
            ? [
                { type: 'section', id: 'sec_vehicle', label: 'Vehicle' },
                // LD-1 (3 Oct 2026): the kind of vehicle, stored as a code (AUTO, CAR, CAB, BUS, TRUCK, OTHER) in `vehicleType`.
                { type: 'select', id: 'vehicle_type', label: 'What kind of vehicle?', required: false, options: flowOptionsOf(LISTING_VEHICLE_TYPES) },
                {
                  type: 'text',
                  id: 'vehicle_number',
                  label: 'Vehicle registration number',
                  placeholder: 'KA 01 AB 1234',
                  hint: 'If this spot is a vehicle. Leave it blank for a station, a platform or a shelter.',
                  required: false,
                },
                // LF-2: the website's "Vehicle type / model" (column `vehicleModel`). LD-1: the kind is
                // asked above as a closed list, so this is the model in the publisher's words.
                { type: 'text', id: 'vehicle_model', label: 'Vehicle model', placeholder: 'e.g. Bajaj RE, Tata Starbus', required: false },
              ]
            : []),
          // LF-2: a broadcast or print outlet, as the website's "Outlet" asked it (columns
          // `broadcastLanguage`, `contentFormat`, and `size` for the slot).
          ...(id === 'media'
            ? [
                { type: 'section', id: 'sec_outlet', label: 'Outlet' },
                { type: 'select', id: 'broadcast_language', label: 'Broadcast language', required: false, options: opts(LANGUAGES) },
                { type: 'select', id: 'content_format', label: 'Content format', required: false, options: opts(CONTENT_FORMATS) },
                { type: 'select', id: 'slot_duration', label: 'Slot duration', required: false, options: opts(SLOT_DURATIONS) },
              ]
            : []),
          { type: 'section', id: 'sec_location', label: 'Location Pin' },
          // Comparables are found within 200 m and the radius never widens, so
          // this has to be the spot rather than the neighbourhood.
          { type: 'geo-point', id: 'location', label: 'Location pin', hint: 'Drag pin to verify exact location', required: id !== 'media' },
          { type: 'section', id: 'sec_dimensions', label: 'Dimensions & Visibility' },
          // Measured, not picked. The size class is derived from the pair the
          // way a media type is derived from a name, and the total area is
          // computed rather than typed so the two can never disagree.
          // A physical spot is measured, and the size class is derived from
          // the pair. A radio slot or a newspaper column has no width, so the
          // media branch cannot require one.
          { type: 'number', id: 'width_ft', label: 'Width (ft)', required: id !== 'media' },
          { type: 'number', id: 'height_ft', label: 'Height (ft)', required: id !== 'media' },
          { type: 'computed', id: 'area_sq_ft', label: 'Total area (sq ft)', from: ['width_ft', 'height_ft'], op: 'multiply', readOnly: true },
          // The frame calls this section "Dimensions & Visibility" and only the
          // dimensions were ever collected. Both of these are columns a pricing
          // factor multiplies on and a buyer reads on the listing page, and a
          // spot that never states them is priced and shown as if it had
          // neither. A screen has no illumination and a radio slot has no
          // face, so the media branch is not asked.
          ...(id === 'media'
            ? []
            : [
                { type: 'select', id: 'illumination', label: 'Illumination', required: false, options: ILLUMINATION_OPTIONS },
                { type: 'select', id: 'facing', label: 'Facing', required: false, options: FACING_OPTIONS },
              ]),
          /*
           * LD-1 (the owner, 3 Oct 2026): the columns a buyer reads and a
           * pricing factor keys on that no form filled. A fixed physical spot
           * is asked how many pass it, how busy and how far it is seen; an
           * outdoor one how high it stands. Not transit (the spot moves) and
           * not media (a broadcast has no street). All optional; the selects
           * store codes (`shared/listing-vocabulary`), the clients print the words.
           */
          ...(id === 'indoor' || id === 'outdoor'
            ? [
                {
                  type: 'number',
                  id: 'estimated_daily_footfall',
                  label: 'About how many people pass this spot in a day?',
                  placeholder: 'e.g. 2500',
                  hint: 'Your best estimate — we may refine it with measured data.',
                  required: false,
                },
                { type: 'select', id: 'traffic_grade', label: 'How busy is it?', required: false, options: flowOptionsOf(TRAFFIC_GRADES) },
                { type: 'select', id: 'visibility', label: 'From how far can it be seen?', required: false, options: flowOptionsOf(VISIBILITY_RANGES) },
              ]
            : []),
          ...(id === 'outdoor'
            ? [{ type: 'select', id: 'elevation', label: 'How high is it?', required: false, options: flowOptionsOf(ELEVATIONS) }]
            : []),
          /*
           * LD-1: a digital screen's resolution, for the artwork spec
           * (`widthPx` x `heightPx`). The flow has no conditional fields, so
           * the clients draw this pair only for a digital screen — the media
           * type's loop rule, or "Digital" illumination — and the section
           * says so for any other renderer.
           */
          ...(id === 'media'
            ? []
            : [
                { type: 'section', id: 'sec_screen', label: 'Screen resolution (pixels)', hint: 'Digital screens only.' },
                { type: 'number', id: 'width_px', label: 'Width (px)', placeholder: 'e.g. 1920', required: false },
                { type: 'number', id: 'height_px', label: 'Height (px)', placeholder: 'e.g. 1080', required: false },
              ]),
          // LF-2: the website's tick (column `installationByAdx`) — a fixed spot ADX may put the creative up on.
          ...(id === 'indoor' || id === 'outdoor'
            ? [{ type: 'checkbox', id: 'installation_by_adx', label: 'Installation by ADX', description: 'ADX installs the creative on this spot. Special pricing applies.', required: false }]
            : []),
        ],
      },
      {
        key: 'more-info',
        title: 'More info',
        subtitle: 'Add the selling story for this ad spot.',
        step: 5, totalSteps: 10, ctaLabel: 'Save listing details',
        fields: [
          // The AI assist DR 02 draws beside this field is a separate feature
          // and deliberately not described here: this config says what the flow
          // collects, and a generated description is still just a description.
          { type: 'textarea', id: 'description', label: 'Advertising space description', placeholder: 'High-visibility mirror decal placement at the main reception and locker mirror wall.', aiAssist: true },
          { type: 'text', id: 'target_audience', label: 'Target audience', placeholder: 'Walk-in fitness and wellness customers' },
          { type: 'text', id: 'unique_selling_point', label: 'Unique selling point', placeholder: 'Eye-level visibility near reception' },
          { type: 'text', id: 'footfall_note', label: 'Past success or footfall', placeholder: 'Average footfall: 350+ daily visitors' },
        ],
      },
      {
        /*
         * LF-2: the website's "Audience evidence" — optional, all of it. The six
         * answers are stored together as the listing's `audienceDemographics`
         * ({ ageBand, genderSplit, urbanRural, secProfile, incomeBracket,
         * occupation }); the two reports are filed as listing documents
         * (AUDIENCE_RATING, FOOTFALL_AUDIT) once the listing exists.
         */
        key: 'audience',
        title: 'Audience evidence',
        subtitle: 'Who sees this space, if you know. All optional.',
        step: 6, totalSteps: 10, ctaLabel: 'Save audience evidence',
        fields: [
          { type: 'section', id: 'sec_audience', label: 'Audience profile' },
          { type: 'select', id: 'age_band', label: 'Primary age band', required: false, options: opts(AGE_BANDS) },
          { type: 'select', id: 'gender_split', label: 'Gender split', required: false, options: opts(GENDER_SPLITS) },
          { type: 'select', id: 'urban_rural', label: 'Urban / rural mix', required: false, options: opts(URBAN_RURAL) },
          { type: 'select', id: 'sec_profile', label: 'SEC profile', required: false, options: opts(SEC_PROFILES) },
          { type: 'section', id: 'sec_income', label: 'Income & occupation' },
          { type: 'select', id: 'income_bracket', label: 'Income bracket', required: false, options: opts(INCOME_BRACKETS) },
          { type: 'select', id: 'occupation', label: 'Top occupation', required: false, options: opts(OCCUPATIONS) },
          { type: 'section', id: 'sec_reports', label: 'Supporting reports' },
          { type: 'file-upload', id: 'barc_report', label: 'BARC / TAM rating sheet', hint: 'PDF or image · the latest quarter', required: false },
          // The website's design said "PDF or Excel"; the upload door takes images, PDF and video only, so the hint says what it takes.
          { type: 'file-upload', id: 'footfall_report', label: 'Footfall audit report', hint: 'PDF or image', required: false },
        ],
      },
      {
        key: 'content-rules',
        title: 'Content rules',
        subtitle: 'Set the brand safety limits for this inventory.',
        step: 7, totalSteps: 10, ctaLabel: 'Save content rules',
        fields: [
          // Two strengths of the same statement, drawn differently because they
          // mean different things: a restricted category can run with the
          // owner's approval, a prohibited one never runs at all.
          { type: 'content-stance', id: 'restricted_categories', label: 'Restricted categories', hint: 'These require owner approval before publishing.', scope: 'RESTRICTED' },
          { type: 'content-prohibited', id: 'prohibited_content', label: 'Prohibited content', hint: 'These are never allowed on this venue.', scope: 'PROHIBITED' },
        ],
      },
      {
        /*
         * LF-2: the website's "Availability & booking terms" (columns `availableNow`,
         * `maxBookingDays`, `advanceBookingDays`, `cancellationPolicy` +
         * `cancellationNoticeDays`). The minimum booking stays with the price.
         */
        key: 'terms',
        title: 'Availability & booking terms',
        subtitle: 'When the space can be booked, and on what terms.',
        step: 8, totalSteps: 10, ctaLabel: 'Save booking terms',
        fields: [
          // LD-1: the live `availableNow` flag, asked plainly; on unless the publisher says otherwise.
          { type: 'switch', id: 'available_now', label: 'Available to book now?', required: false },
          { type: 'select', id: 'available_year_round', label: 'Available year-round?', required: false, options: YEAR_ROUND },
          { type: 'select', id: 'max_booking_days', label: 'Maximum booking period', required: false, options: MAX_BOOKING },
          { type: 'select', id: 'advance_booking_days', label: 'Advance booking required', required: false, options: ADVANCE_BOOKING },
          { type: 'select', id: 'cancellation_notice', label: 'Cancellation notice', required: false, options: CANCELLATION_NOTICE },
        ],
      },
      {
        key: 'pricing',
        title: 'Pricing & availability',
        subtitle: 'You set this. ADX only tells you how it compares to spots nearby.',
        step: 9, totalSteps: 10, ctaLabel: 'Save price & availability',
        fields: [
          // The publisher's own unit. A mall quotes per square foot per month; a
          // billboard owner quotes per day. Converting in their head is how a
          // rate arrives thirty times too large, so the pair is stored and
          // `ratePerDay` is derived from it.
          { type: 'select', id: 'pricing_unit', label: 'Rate basis', required: true, options: [
            { id: 'PER_DAY', title: 'Per day' },
            { id: 'PER_WEEK', title: 'Per week' },
            { id: 'PER_MONTH', title: 'Per month' },
            { id: 'PER_SQFT_PER_DAY', title: 'Per sq.ft / day' },
            { id: 'PER_SQFT_PER_MONTH', title: 'Per sq.ft / month' },
          ] },
          // The indicator renders under this field. It informs and never blocks:
          // a publisher may list at any price they like.
          { type: 'base-price', id: 'base_price', label: 'Base price (Rs)', required: true, showIndicator: true },
          { type: 'number', id: 'min_booking_days', label: 'Min. booking (days)' },
          { type: 'date', id: 'available_from', label: 'Available from' },
          { type: 'time-range', id: 'available_hours', label: 'Visibility hours', placeholder: '10 AM - 10 PM' },
          { type: 'text', id: 'peak_period_note', label: 'Peak period note', placeholder: 'Evenings and weekends' },
        ],
      },
      {
        /*
         * LF-2: the website's "Rate card" — the file, when it holds, and how the
         * price moves through the year (columns `rateCardUrl`, `rateCardValidFrom`,
         * `rateCardValidTo`, `seasonalVariationNote`).
         */
        key: 'rate-card',
        title: 'Rate card',
        subtitle: 'Your published rates, if you have them. All optional.',
        step: 10, totalSteps: 10, ctaLabel: 'Save rate card',
        fields: [
          // Evidence, not a price ADX applies. A publisher's rate card is a
          // PROVISIONAL comparable at best, and never their own listing's price.
          { type: 'file-upload', id: 'rate_card', label: 'Upload rate card', hint: 'PDF or image, optional' },
          { type: 'date', id: 'rate_card_valid_from', label: 'Validity start', required: false },
          { type: 'date', id: 'rate_card_valid_to', label: 'Validity end', required: false },
          { type: 'select', id: 'rate_card_seasonal', label: 'Seasonal variation', required: false, options: SEASONAL_VARIATIONS },
        ],
      },
      {
        key: 'documents',
        title: 'Documents & permits',
        subtitle: 'Upload venue proof for this spot.',
        /*
         * Unnumbered, like the review after it. The frame prints "Verification"
         * in the corner where every numbered step prints "Step N of 7", and the
         * count of seven is drawn on six other screens — so this is a step in
         * the sequence without being one of the seven, and `step` past
         * `totalSteps` is how this config already says that.
         *
         * It sits last because the documents need a listing to belong to. The
         * app holds the uploaded URLs until the listing is created on the
         * review screen, then posts each one to
         * POST /supply/listings/:listingId/documents before submitting.
         */
        step: 11, totalSteps: 10, badge: 'Verification', ctaLabel: 'Save proofs',
        fields: [
          /*
           * QR-24: a hoarding on a highway, a shelter, a digital billboard —
           * many spots are held on a lease, a licence or a permit a civic body
           * renews every year. The listing carries how it is held and until
           * when; ADX reminds the publisher before it runs out and takes the
           * spot off the shelf after, until the renewed paper is approved.
           */
          { type: 'select', id: 'rights_basis', label: 'How do you hold this space?', required: true, options: RIGHTS_OPTIONS },
          { type: 'date', id: 'rights_valid_until', label: 'Right runs out on', hint: 'YYYY-MM-DD — the end date on the lease, licence or permit. Leave blank if you own the space. ADX reminds you 30 and 7 days before; after that day the spot takes no new booking until you upload the renewal.' },
          {
            /*
             * The hint used to end "and add them later", which no app can do.
             * `POST /supply/listings/:listingId/documents` accepts a publisher,
             * but neither phone app has a screen that reaches it outside this
             * wizard, and once the confirmation shows there is no way back to
             * this step — so the only route for a late document today is a
             * console operator. Promising the publisher a door that is not
             * there is worse than telling them who to ask.
             */
            type: 'document-upload',
            id: 'documents',
            label: 'Venue proof',
            hint: 'ADX checks these at a desk before an agent is sent out, so a listing with its papers in order is verified sooner. The listing can be sent without them — but anything missing has to be added by ADX afterwards, so it is quicker to attach it now.',
            options: documentKinds(id),
          },
        ],
      },
      {
        key: 'review',
        title: 'Review & submit',
        subtitle: 'Check everything before it goes for approval.',
        // Unnumbered: DR 02 counts seven steps and this collects nothing new.
        step: 12, totalSteps: 10, ctaLabel: 'Submit listing',
        fields: [
          // LF-2: the website's "3 to 5 angles" — front (the main photo), left, right and wide.
          { type: 'image-upload', id: 'main_photo', label: 'Main photo (front)', required: true },
          { type: 'image-upload', id: 'left_photo', label: 'Left angle' },
          { type: 'image-upload', id: 'right_photo', label: 'Right angle' },
          { type: 'image-upload', id: 'wide_photo', label: 'Wide angle shot' },
          { type: 'checkbox', id: 'terms', label: 'Terms agreement', description: 'I confirm that all information provided is accurate and I agree to ADX listing guidelines.', required: true },
        ],
      },
    ],
  };
}

/** The whole wizard: the root screen and a branch per category, each the same seven steps. */
export function buildListingFlow(cities: CityOption[]) {
  return {
    ...LISTING_FLOW,
    branches: {
      indoor: listingBranch('indoor', 'Indoor', 'Malls, gyms, clinics, offices, cinemas', cities),
      outdoor: listingBranch('outdoor', 'Outdoor', 'Hoardings, gantries, roadside sites', cities),
      transit: listingBranch('transit', 'Transit', 'Metro, rail, bus, taxi, airport', cities),
      media: listingBranch('media', 'Media', 'Television, radio and print', cities),
    },
  };
}
