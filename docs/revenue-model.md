# Revenue model

What an advertiser pays, and what a publisher keeps.

The pricing engine decides what a publisher **lists at**. This decides
everything that happens to that number afterwards. They are deliberately
separate: one is a claim about the market, the other is a commercial policy, and
conflating them is how a platform ends up unable to change its take rate without
re-pricing the market.

## The two sides of a booking

```
Advertiser pays   =  publisher rate × days
                  +  platform fee
                  +  installation, printing, design where they apply
                  −  rate discount            (reduces taxable value)
                  +  GST on the above
                  −  goodwill credit          (a payment, applied after GST)

Publisher keeps   =  publisher rate × days
                  −  ADX commission
```

**Commission comes out of the publisher's earnings; it is never added to the
advertiser's price.** That is the single most load-bearing fact here. It means
the advertiser sees the publisher's own rate in the cart, ADX's take is
invisible to them, and ADX shares automatically in any surge the publisher
captures — no separate split, because a percentage of a bigger number is bigger.

## Commission: most specific wins

Six places a rate can come from, resolved in this order (Lot B, Q10/Q38 added
the two media-type rows):

| Order | Source | Why it exists |
| --- | --- | --- |
| 1 | **Promotional override** on the publisher | Onboarding a specific publisher, time-boxed, approved by a person |
| 2 | **Subscription tier** the publisher bought | They paid to reduce their commission |
| 3 | **Media-type rate for a rental band** | A ₹1,500/month spot and a ₹10 lakh/month spot of the same kind need not take the same cut |
| 4 | **Media-type rate** | The pricing engine's own "ad type" is a more specific claim than a category |
| 5 | **Category rate** | A transit panel and a hoarding need not take the same cut |
| 6 | **Platform default** | 15%, seeded; the row ops cannot retire without replacing |

The platform default is charged on the **media value the advertiser is billed
for** — after the rate discount, before the campaign discount and the fees.
The rental band is keyed on that same value **per unit per day**, so a
quantity of three does not push one ₹1,000 spot into the ₹3,000 band; the
floor is inclusive and the ceiling exclusive. There is no fallback: a quote
that finds no row refuses (`COMMISSION_DEFAULT_MISSING`) rather than pricing
the marketplace at a number nobody chose.

Each rate is resolved once, at the moment a booking is priced, and **stored on
the booking** — `CampaignSpot.commissionPct` and `commissionSource`, stamped
by checkout from the same quote that priced the review. Never re-derived on
read. A publisher whose subscription lapses next month must still be paid what
was agreed on a campaign booked this month, and an invoice that changes its
own arithmetic later is not an invoice. The daily accrual charges the stamp; a
spot authorised before the stamp existed is resolved once, at the flight's
start, and the accrual records `RESOLVED_AT_ACCRUAL` beside it.

## Where the advertiser's spend is posted — once

Two places could post the advertiser-side `CAMPAIGN_SPEND`: the capture, when
the campaign starts, or the accrual, a day at a time. **It is the capture,
and only the capture** (B3a): wallet − / `platform:payables` + for the whole
booking, in the same movement that settles the hold. The accrual then
releases each day's gross *out of* payables — `platform:payables` −gross,
wallet +net, `platform:revenue` +commission, `platform:tax-withheld` +tax —
so ADX's take is recognised as the days are delivered and payables runs down
to zero when the flight ends. A second spend leg per day would count the
booking twice on the advertiser's side and leave payables overstated by the
whole campaign. The overview's GMV therefore reads the capture legs by the
day they were posted, and its take rate is the revenue legs over that.

## What a day is worth

A day of a spot is **rate × quantity** — `grossForDay` in
`payouts/accrual.service.ts`. The run split the unit rate alone until Lot B
(B1), so a publisher with three panels booked on one listing was paid for
one. `POST /finance/accruals/quantity-backfill` lists the short days and, on
`dryRun: false`, posts one `ADJUSTMENT` per spot under the rates each day was
accrued at, audited against the spot and idempotent on that audit row.

## Fees: what the advertiser is told, and when

Fees sit on the advertiser's side. Each carries its own GST rate and its own
answer to "does the cart name this before checkout".

| Fee | Shape | In the cart |
| --- | --- | --- |
| Platform fee | Percentage of the media value | Named, amount at checkout |
| Installation | Flat, per spot | Named, amount at checkout |
| Printing | Flat, per spot | Named, amount at checkout |
| Design | Flat, per creative | Named **with amount** |

**The cart names every mandatory fee, even where it does not yet total them.**
The commercial intent — keep the cart clean, put the full breakdown at checkout
— survives that intact. What does not survive scrutiny is a cart that implies
the publisher rate is the price and only reveals mandatory charges at the last
step: the CCPA's 2023 dark-pattern guidelines name drip pricing explicitly, and
"you can expand the breakdown at checkout" is the pattern they describe rather
than a defence against it. So the cart carries a `+ fees` marker and the
checkout carries the numbers.

Design fees are the exception the other way: they were always meant to be
visible early, because an advertiser choosing whether ADX makes their creative
is making that decision in the cart.

## Tax

Two different things happen to two different kinds of reduction, and collapsing
them into one "discount" field is a tax error rather than a rounding one.

- A **rate discount** reduces the taxable value. GST is charged on what is left.
- A **goodwill credit** is a payment. It applies to the gross, after GST.

So the same rupee costs ADX differently depending on which it is, and an invoice
has to show them as separate lines.

Every amount is `Decimal(14,2)` and crosses the wire as a string. Percentages
are `Decimal(5,4)` — `0.0050` is the platform fee, not `0.5`.

## Price locks

Adding a spot to the cart holds its rate for **30 minutes**, with a visible
timer. It locks the price only; it does not hold the inventory, because a lock
that reserves a site lets anyone empty the marketplace by filling a cart.

Bulk behaves differently: a cart of more than five spots takes longer to
assemble and is worth holding longer, so it locks for a working day.

A lock is per advertiser per listing. It expires by time rather than by a
sweeper, so an expired lock simply stops resolving.

## Deliberately not here

The cart and checkout themselves, invoicing, GST return formats, and the payment
gateway. This computes what those will charge; it does not collect anything.
