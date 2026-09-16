# price-model

The levers ops pulls by hand, and the quotes they exist to produce.

## Three pricing modules, three questions

| Module | Question | Blocks anything |
| --- | --- | --- |
| `pricing` | What is the market within 200 m doing? | Never |
| `rate-cards` | What has ADX approved as sellable? | Publishing, below the floor |
| `price-model` | What do we quote *this* buyer for *these* spots? | A blocked sector |

This one exists because an advertiser taking eleven spots across three cities
and wanting something off the total is a phone call, not a checkout. Everything
here was hardcoded in the console for months and looked exactly like
configuration while being nothing of the kind.

## Owned routes

All ADMIN. Every lever decides what an advertiser is charged, and a quote is an
offer made in ADX's name.

| Method | Path |
| --- | --- |
| GET/POST | `/price-model/dimensions` |
| GET/PATCH/DELETE | `/price-model/dimensions/:id` |
| PUT | `/price-model/dimensions/:id/values` |
| GET/POST | `/price-model/category-rules` |
| PATCH/DELETE | `/price-model/category-rules/:id` |
| GET/POST | `/price-model/rules` |
| GET/PATCH/DELETE | `/price-model/rules/:id` |
| PUT | `/price-model/rules/:id/conditions` |
| POST | `/price-model/quotes/price` |
| GET/POST | `/price-model/quotes` |
| GET | `/price-model/quotes/:id` |
| PATCH | `/price-model/quotes/:id/status` |

`quotes/price` computes and returns; `quotes` writes one down. They are separate
because negotiation is iterative — the operator moves the discount, sees where
it lands against the floors, moves it back — and a row per attempt would fill
the table with abandoned arithmetic.

## Owned Prisma entities

- `PriceDimension` + `PriceDimensionValue` — mutually exclusive option sets. A
  spot is back-lit or front-lit, never both, so a quote picks one value per
  dimension. That exclusivity is why this is not `PricingFactor`, which is per
  media type and applies independently.
- `PricingCategoryRule` — an advertiser's sector against a kind of inventory.
  Not `ContentCategory`, which is brand safety: that asks what may be *shown*,
  this asks what a sector *pays* and whether it may book at all.
- `PriceRule` + `PriceRuleCondition` — conditional adjustments, ordered by an
  explicit priority because "which rule won" is the question somebody asks when
  a price looks wrong.
- `Quote` + `QuoteLine` — the offer, with every step that produced each line.

## How a line is priced

Card rate, then size band (from the measurement), then the chosen dimensions,
then the sector, then rules — rupee adjustments before multipliers — then the
card's rounding. The same order the rate-card simulator uses, deliberately: two
code paths computing one quote in different orders is how a simulator and an
invoice come to disagree.

## Invariants

- **The floor is re-tested after the discount.** It is per line and per day, so
  a quote that passes line by line and breaches once ten per cent comes off is
  a real case, and the operator has to see it before the offer leaves the room.
- **A blocked sector stops the quote.** Returning a number for inventory this
  advertiser may not book is how a salesperson quotes something the platform
  refuses at checkout.
- **A rule testing a fact the line does not carry has not matched.** Treating a
  missing area as zero would fire every "under 200 sq ft" rule on every
  unmeasured spot.
- **The trace is stored, not recomputed.** A card gets superseded and a
  dimension retuned; six weeks later somebody asks how the total was arrived at.
  Recomputing answers a different question.
- **The agent's installation fee is a cost line, never a fee line (Lot B,
  Q134).** The simulator prints `Agent installation fee (cost)` and
  `Installation margin` directly under the advertiser's `Installation` line,
  read from `payouts.installationFeeFor` at the flat rate × spots — the
  simulator has no order to carry a per-order figure — and the running total
  does not move across either row. `Simulation.installation` carries the three
  figures (`fee`, `agentCost`, `margin`), null when the bill has no
  installation line or no agent rate is configured. Nothing here reaches the
  buyer's quote.
