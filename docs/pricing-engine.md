# Pricing engine

## What this is, and what it deliberately is not

ADX does not set prices. Publishers set their own, and the engine tells them
whether the number they typed looks right for where they are. The output is a
sentence under a form field, never a quote and never a block.

That single sentence decides the whole design. An engine that quotes needs to be
right. An engine that comments needs to be *defensible* — when a publisher
disagrees, we have to be able to show them the spots we compared them against
and let them judge for themselves. Everything below follows from that: the
comparable set is small, local and inspectable rather than large and modelled.

The one exception is publishers under an exclusive agreement, who are offered a
price by ADX. That price comes from this same engine — there is no second
source — and they remain free to reject it.

## The comparable set

A listing's comparables are the other spots that a reasonable person would say
are the same kind of thing in the same place.

**Match key — all four, exactly:**

| Attribute | Rule |
| --- | --- |
| Media type | Exact |
| Category | Exact (implied by media type) |
| Size class | Exact — a 10-footer compares only to 10-footers |
| Location | Within 200 m |

Material is *not* in the match key. It is approximate by nature and adding it
would empty the set; it earns its keep in media-type matching instead, where it
is one of the attributes the similarity threshold reads.

**The radius does not widen.** A spot with no comparables within 200 m has no
comparables. We say nothing rather than compare it to somewhere else — a
hoarding two kilometres away is not evidence about this one, and pretending
otherwise is how a suggester quietly becomes wrong.

**One data point per publisher.** A publisher with ten hoardings along one road,
priced identically, is one opinion, not ten. Their contribution is the median of
their matching listings. Six competitors with ten listings each is six data
points, which is the honest count.

## The range, and the four things it can say

The range is simply the lowest and highest of those data points. No percentiles,
no distribution fitting — with the handful of points a 200 m circle yields, a
percentile is arithmetic theatre performed on three numbers.

Given `lo` and `hi`, a typed price `p` reads as:

Outside the range first, where the verdict is unambiguous whatever the spread:

| State | Condition |
| --- | --- |
| `TOO_LOW` | `p < lo` |
| `TOO_HIGH` | `p > hi` (after surge) |

Inside the range, the verdict is settled against the market **as it actually
is, with surge ignored entirely**. `p` is near the ceiling if within 5% of the
top, near the floor if within 5% of the bottom; whichever fires alone decides,
and where both fire the nearer end wins. An exact tie is dead centre, which is
neither cheap nor expensive but the going rate — and that is also what makes a
single comparable read `GOOD` at its own price.

Only then does surge apply, and it may do exactly one thing: **relax a
`TOO_HIGH` into a `GOOD`.** It lifts the ceiling a publisher is allowed to
reach. It is not evidence about the market, so it must never touch `TOO_LOW`,
`LOW_SIDE`, or the proximity comparison.

Three attempts at this failed, all in ways that only show up in cases that are
common rather than exotic, so they are worth recording:

- Testing the ceiling first reported the **floor** of a tight range as the
  ceiling — a publisher typing the cheapest nearby rate was told they were the
  most expensive.
- Suppressing both edges whenever they could overlap threw away a **correct**
  ceiling warning across a band twice as wide as the actual conflict.
- Letting surge into the proximity comparison meant a publisher who typed the
  exact price of the only comparable nearby was told they were **on the cheaper
  side**, because an invisible national window had moved the ceiling out from
  under the calculation. It reverted when the event ended, with nothing on
  screen to explain either flip.

The edges overlap for any spread under about 10.5%, which two neighbouring
hoardings routinely are, so none of these is a corner case.

**The caveat.** Below a comfortable count, the indicator still appears but says
what it is standing on: *"based on only 2 nearby spots."* A thin range is worth
more than silence as long as it admits to being thin.

**It informs, it never blocks.** A publisher can list at any price. If they
insist on a number the indicator dislikes, that is a conversation for ops, not a
validation error.

## Where the data comes from

Three sources, in descending order of trust:

1. **ADX listings that have sold.** A price that sat on the marketplace and drew
   orders is the strongest evidence we will ever have. Same number as a listed
   price, far more meaning. "Sold" means the campaign actually ran — deliberately
   not an early state like a confirmed slot, which is cheap to reach: three of
   those inside one circle would discard the research-derived range entirely, so
   gaming the local rate has to cost three real campaigns rather than three
   arrangements with a friend.
2. **Competitor research.** Gathered by the market research team entirely
   outside this platform — their process touches no admin screen. Only the
   *output* is imported: rows carrying coordinates, media type, category, size
   class, material and rate. At launch this is nearly all the data there is.
3. **Publisher rate cards.** Unverified, and used only where the first two are
   absent. Marked provisional, and displaced automatically once real
   comparables appear.

The weighting shifts on its own as ADX accumulates listings, because trust is
expressed as *which tier is present*, not as a hand-tuned coefficient someone
has to remember to change.

Two rules keep that honest. The crossover has **its own setting**
(`validatedTakeoverCount`) rather than borrowing the one that governs the
thin-evidence caveat — they start equal but answer different questions, and
sharing a column meant raising the caveat threshold silently postponed the
handover. And a mixed set is **labelled by its weakest member**: one ADX sale
pooled with five field observations is `LISTED`, because calling it `VALIDATED`
would show ops the highest possible provenance for a range five-sixths of the
market has not tested.

**Only listed prices ever enter the pool.** Booked prices carry surge, and surge
is an event, not a market rate. The pool holds baselines exclusively.

## Staleness

A data point past six months is labelled old and its owner is nudged to refresh
it. It still counts — stale evidence beats no evidence in a 200 m circle — but
it is visibly stale, both to ops and to the publisher looking at the comparables.

## Media types, and keeping the taxonomy from shattering

A new listing's attributes are matched against existing media types by
similarity threshold — a Dice coefficient over name tokens, gated on category
matching exactly. Deliberately simple: when ops asks why two things matched, the
answer has to be a sentence rather than a model.

Tokens are singularised before comparison, which is not stemming and must not
become it. It exists for one otherwise-constant failure: somebody types
"Unipole Hoardings" and the plural alone drops the score under the threshold,
minting a duplicate that splits a comparable set which should have been one.
"Hoarding" collapsing to "hoard" would be the opposite error.

The bias is deliberately toward **matching**: two media types that should have
been one is a repairable mistake, while a fragmented taxonomy silently empties
every comparable set and nobody notices until the indicator has stopped
appearing for half the catalogue.

Every match decision is **logged** — what was proposed, what it matched, at what
similarity, and whether it created something new. That log is how fragmentation
gets spotted early.

When the threshold gets it wrong anyway, ops **merges**. Merging is the repair
tool and matters more than naming: it re-points listings, folds market data
across, and leaves the merged-away type in place as a tombstone so old
references still resolve.

**Controlled vocabularies.** Category, size class and material come from fixed
lists that ops can extend. Threshold matching against free text does not work —
"vinyl", "Vinyl" and "flex vinyl" become three materials and split the pool
three ways within a week of launch. An unrecognised value is logged for ops
rather than silently created.

## Factors

Factors are per media type. Two kinds:

- **Base adjusters**, which move the base rate.
- **Multipliers**, which scale it.

Multipliers cover the non-core character of a place — locality type,
neighbourhood profile, and whatever else research turns up. Size is *not* a
multiplier; it is a base pricing factor, already counted once in the size class,
and counting it twice is the classic double-count.

**The engine suggests; ADX decides.** Factor values are derived from the
listing's own attributes and coordinates rather than typed by hand, because they
are properties of the place and not judgments about the spot. But the engine
only ever *proposes* the favourable ones. Every potential factor is listed
alongside, and a person applies them. Nothing multiplies a price automatically.

**A compounding cap.** Whatever values research settles on, ten individually
reasonable multipliers still compound into something absurd. The cap is
ops-settable and a listing that hits it is flagged rather than silently clamped.

## Surge

Surge moves **the indicator, not the price**. During a surge window a publisher
can raise their price without being flagged as too high — the `TOO_HIGH` edge
lifts by the window's uplift and nothing else changes.

Keeping surge out of the pool takes one more step than it first appears.
Comparables read listing prices *live*, so a publisher who accepts the
indicator's invitation to price higher would otherwise feed that inflated rate
straight into every neighbour's baseline. So a listing records **when the window
ends** (`ratePerDaySurgeUntil`), stamped at write time while the surge state is
still known rather than reconstructed later against a calendar that may since
have changed, and such rates sit out of every pool until then.

A timestamp rather than a flag, because the exclusion has to expire. A boolean
was never cleared by anything — and since a national window covers every spot in
the country, one election would have removed every listing priced during it from
every pool permanently. The symptom would have been the indicator quietly going
silent more often, which is exactly the kind of failure nobody reports. Once the
window has passed, a rate the publisher chose to leave in place *is* their
baseline.

Overlapping windows do not compound: the strongest wins. Two events in one week
are two descriptions of a busy week, not two reasons to double a price.

Windows come from an event calendar: city-level events, plus national and
international ones, fed by a scraper and eventually by a generative agent with
the research team validating the uplift. It is a backend tool with no
authoring UI.

**It does have an off switch.** A scraper that invents an event, or applies a
window to the wrong city, must be stoppable without a deploy. Ops gets a list of
active windows and a per-window disable — nothing more.

Advertisers see one price, with a line explaining that it is higher because of
the event. National events are surfaced publicly; city ones are not.

ADX shares in surge automatically, because commission is a percentage of what
the publisher earns. No separate split.

## Canonical unit

**Rate per day per spot**, stored as `Decimal(14,2)`.

Everything reduces to a rate per period, and the day is the period that divides
cleanly into every flight length without repeating decimals. Console,
marketplace and mobile currently disagree with each other; they all move to
this.

Listing creation and bulk import both accept `ratePerDay` as a decimal string,
and classify the spot on the way in: a `mediaTypeName` given in words is
resolved through the similarity threshold, which is the only moment the taxonomy
grows. A bulk batch matches **once per distinct name** — five hundred scraped
spots are usually a dozen real media types described five hundred slightly
different ways.

`Listing.monthlyPrice` is a `Float`, which is the wrong type for money. Both
shapes are accepted and each is derived from the other, so existing callers keep
working while new ones move across; the divisor is a flat 30 rather than the
real month length, so a daily rate does not wobble by 3% depending on which
month a publisher listed in. Retiring the column is a separate change with a
blast radius worth naming: listings, orders, the marketplace and both apps.

## Deliberately not in this document

Commission, platform fees, installation and design charges, publisher
subscriptions and promotional commission overrides are all settled but belong to
the money model rather than the engine. They decide what an advertiser pays;
this decides what a publisher lists at. Built separately, next.

---

## Carried over from the old rate-card model, not yet ported

The console used to render a "pricing model" screen from fixtures: size bands,
illumination multipliers and a set of aspect factors. That screen has been
deleted — it described a system the comparables engine replaced, and it sat next
to the live engine looking equally authoritative.

The **numbers** are worth keeping, because they are somebody's considered
starting point for what moves an out-of-home rate. They belong as `PricingFactor`
rows, which is where a multiplier lives now. Nothing reads them today; they are
recorded here so deleting a fixture file did not lose them.

None of these are confirmed business rules. They were placeholder values on a
design, and the same caveat that covers every figure on DR 10 applies.

### Size bands

| Band | Dimensions | Area | Rate basis | Multiplier |
| --- | --- | --- | --- | --- |
| Compact | Up to 12 x 6 ft | <= 72 sq ft | Flat | 0.80x |
| Standard | 12 x 6 to 20 x 10 ft | 72-200 sq ft | Per sq ft | 1.00x |
| Large | 20 x 10 to 30 x 15 ft | 200-450 sq ft | Per sq ft | 1.15x |
| Super | 30 x 15 to 40 x 20 ft | 450-800 sq ft | Per sq ft | 1.30x |
| Landmark | Above 40 x 20 ft | > 800 sq ft | Negotiated | 1.50x |

Note the overlap with `SizeClass`, which the engine already has and matches on.
A size band is a *multiplier*; a size class is part of the comparables match
key. Porting these means deciding whether both concepts survive.

### Illumination

| | Multiplier |
| --- | --- |
| Non-lit | 0.85x |
| Front-lit | 1.00x |
| Back-lit | 1.15x |
| Digital / LED | 1.60x |

### Aspect

**Facing** — towards oncoming traffic 1.10x, parallel to road 0.95x, junction or
multi-face 1.20x.

**Elevation** — eye level (<= 20 ft) 1.05x, mid rise (20-40 ft) 1.00x, high rise
(> 40 ft) 0.90x.

**Visibility** — clear 100 m+ approach 1.10x, partial obstruction 0.90x, signal
wait zone 1.15x, flyover shadow 0.85x.

Compounding all of these would reach well past `maxCompoundMultiplier`, which is
3.0 by default — another reason they need judgement rather than a bulk import.
