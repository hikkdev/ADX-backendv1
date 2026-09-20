/**
 * The listing wizard `scripts/seedConfig` writes to `flows.listing`, as data.
 *
 * Kept apart from the seed so the app-config tests can hold it against the
 * wizard vocabulary (`flow-schema.ts`) without running the seed: the seed
 * opens a database, this file opens nothing. The city list is the one
 * argument, because it is read from the `City` table rather than typed.
 */

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
 * The listing wizard: seven steps, then a review.
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
      step: 1, totalSteps: 7, ctaLabel: 'Continue',
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
        step: 2, totalSteps: 7, ctaLabel: 'Continue',
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
        step: 3, totalSteps: 7, ctaLabel: 'Continue',
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
        step: 4, totalSteps: 7, ctaLabel: 'Save spot details',
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
        ],
      },
      {
        key: 'more-info',
        title: 'More info',
        subtitle: 'Add the selling story for this ad spot.',
        step: 5, totalSteps: 7, ctaLabel: 'Save listing details',
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
        key: 'content-rules',
        title: 'Content rules',
        subtitle: 'Set the brand safety limits for this inventory.',
        step: 6, totalSteps: 7, ctaLabel: 'Review listing',
        fields: [
          // Two strengths of the same statement, drawn differently because they
          // mean different things: a restricted category can run with the
          // owner's approval, a prohibited one never runs at all.
          { type: 'content-stance', id: 'restricted_categories', label: 'Restricted categories', hint: 'These require owner approval before publishing.', scope: 'RESTRICTED' },
          { type: 'content-prohibited', id: 'prohibited_content', label: 'Prohibited content', hint: 'These are never allowed on this venue.', scope: 'PROHIBITED' },
        ],
      },
      {
        key: 'pricing',
        title: 'Pricing & availability',
        subtitle: 'You set this. ADX only tells you how it compares to spots nearby.',
        step: 7, totalSteps: 7, ctaLabel: 'Save price & availability',
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
          // Evidence, not a price ADX applies. A publisher's rate card is a
          // PROVISIONAL comparable at best, and never their own listing's price.
          { type: 'file-upload', id: 'rate_card', label: 'Upload rate card', hint: 'PDF or image, optional' },
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
        step: 8, totalSteps: 7, badge: 'Verification', ctaLabel: 'Save proofs',
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
        step: 9, totalSteps: 7, ctaLabel: 'Submit listing',
        fields: [
          { type: 'image-upload', id: 'main_photo', label: 'Main photo', required: true },
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
