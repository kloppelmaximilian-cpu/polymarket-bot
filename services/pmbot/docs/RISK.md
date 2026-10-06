# Risk management

## Two jobs, kept separate

The risk engine does **accounting** — the single source of truth for bankroll,
exposure, positions and P&L; nothing else in the system computes equity — and
**permission**, a hard gate in front of every order. Each limit is checked
independently and the first breach blocks the trade with a named reason that is
logged, stored and shown on the dashboard.

## Position sizing

For a binary contract bought at `p` that pays $1, staking `p` per share, the
Kelly-optimal fraction of bankroll given true probability `q` is

```
f* = (q - p) / (1 - p)
```

Three modifications, all conservative:

**1. Fees enter the price.** `p` becomes `p + fee_per_share + slippage`, so size
shrinks as execution worsens — which is exactly when it should.

**2. Uncertainty shrinks the edge.** Sizing uses a lower confidence bound
`q - k·sigma_q`, not the point estimate. Kelly is notoriously sensitive to
over-estimated edge, and sizing on a point estimate is the most common way a
mathematically sound system blows up.

**3. Hard caps dominate.** A fraction of Kelly (`KELLY_FRACTION`, default 0.25),
a fraction of bankroll (`MAX_STAKE_FRACTION`, 2%), an absolute cap
(`MAX_STAKE_PER_TRADE`, $25), the venue's minimum order size, and a
slippage-bounded maximum derived from the actual book — all applied after Kelly.

The binding constraint is reported on every opportunity, so you can see whether
size came from the edge or from a cap.

### Slippage-bounded sizing

The book is a step function, so the largest size whose *average* fill stays
within `MAX_SLIPPAGE` of the touch is found by bisection over the real book. If
that is below the venue minimum, the trade is refused. Size is bounded by what
the book can actually absorb, not by what you would like to trade.

## What is deliberately absent

**No Martingale.** No loss-doubling, no revenge trading, no averaging down, no
unbounded position growth. Size is a function of edge and bankroll only; it
never depends on recent results except through the bankroll itself. There is a
test asserting exactly this.

**No maker rebate in the edge calculation.** Polymarket shares a fraction of
taker fees back to qualifying makers, but it is a pro-rata share of a daily pool
and cannot be relied on per trade. `MAKER_REBATE_RATE` defaults to 0. Any rebate
received is upside that was never counted on.

## Limits

Every count and exposure figure includes **resting orders**, not just filled
positions. This is not cosmetic: it fixes a real bug found during validation.
While a maker order rested there was no position, so the next cycle passed every
limit and placed a second order. Both filled and the position was double the
intended size.

| Limit | Default | Scope |
|---|---|---|
| `MAX_STAKE_PER_TRADE` | $25 | per order |
| `MAX_STAKE_FRACTION` | 2% | per order, of bankroll |
| `MAX_PORTFOLIO_EXPOSURE` | $200 | positions + reservations |
| `MAX_SIMULTANEOUS_POSITIONS` | 6 | positions + working orders |
| `MAX_POSITIONS_PER_ASSET` | 2 | |
| `MAX_POSITIONS_PER_MARKET` | 1 | |
| `MAX_ASSET_EXPOSURE` | $100 | per asset |
| `MAX_CORRELATED_EXPOSURE` | $150 | all crypto is one bucket |

The correlation bucket matters. BTC, ETH and SOL five-minute windows are not
independent bets — in a market-wide move they all go the same way. Treating them
as one exposure is the difference between six small bets and one large one.

## Kill switches

These **latch**: once fired, trading pauses for `RISK_PAUSE_SECONDS` rather than
resuming on the next tick that happens to look better. They are evaluated both
before every order and immediately after each settlement, so a breach is visible
on the dashboard the moment it happens.

| Switch | Default |
|---|---|
| `MAX_DAILY_LOSS` | $100, resets at UTC midnight |
| `MAX_SESSION_LOSS` | $150, process lifetime |
| `MAX_CONSECUTIVE_LOSSES` | 8 |
| `MAX_DRAWDOWN` | 25% of peak equity |

## System-health stops

Separately from P&L, the health monitor pauses trading or halves size on the
conditions below. Unlike the kill switches these **do not latch**: the pause
lifts as soon as health recovers, and `trading resumed: health recovered`
appears in the log and the alerts panel.

The distinction matters more than it looks. A losing streak is evidence about
the model, and the model does not improve because the next tick looked
friendlier — so it rides out the cooldown. A reconnecting feed is
infrastructure we are already watching, and it clears itself. Latching both
alike means that feeds flapping every few minutes keep the bot switched off
almost permanently while every panel reads healthy, which is exactly what the
first overnight run did: eight hours up, zero trades, health 100%.

A latched pause always outranks an unlatched one, so a loss stop that fires
during an outage is *not* cancelled when the feed returns.

| Condition | Action |
|---|---|
| Fewer than `MIN_HEALTHY_EXCHANGES` connected | pause |
| Polymarket websocket offline | pause |
| Polymarket websocket degraded | halve size |
| Composite price unhealthy for an asset | degrade |
| 5+ execution failures in 5 minutes | pause |
| 3+ execution failures in 5 minutes | halve size |
| 20+ API errors in 5 minutes | halve size |
| Rolling prediction Brier skill ≤ −0.06 over 40+ outcomes | pause |

The last one is the important one. A model can be perfectly healthy
mechanically while having stopped predicting, and that failure is far more
expensive than a disconnected socket. Thresholds are deliberately slow —
five-minute outcomes are noisy and a reactive tripwire would fire constantly.

## The trade gate

The single place where a view becomes an order. Every condition is checked and
every failure is named, so the audit log answers "why was this *not* taken?" as
precisely as "why was it?".

```
data quality OK
AND market valid and tradable
AND two-sided, fresh, uncrossed book
AND spread acceptable
AND liquidity sufficient
AND enough size inside the slippage budget
AND time remaining in the usable band
AND net edge ≥ dynamic threshold
AND net edge ≥ k × model uncertainty
AND net edge ≤ MAX_PLAUSIBLE_EDGE
AND confidence sufficient
AND strategy agreement sufficient
AND risk permits the notional
→ otherwise NO TRADE
```

Economics are computed on the price we would actually get — the touch we must
cross plus the slippage of walking the book for the intended size — never on the
mid. Trading off the mid is the fastest way to turn a real 2-point edge into a
real loss, because the spread alone is one tick and the taker fee at 50c is
another 1.75 points.

### The implausible-edge guard

`MAX_PLAUSIBLE_EDGE` (default 0.12) refuses edges that are too large. This looks
like leaving money on the table and is not: a 16-point disagreement with a
liquid market is far more often a bug in our inputs than free money. The stale-
strike bug found during validation produced exactly such edges. Real
opportunities of that size will still be available once the cause is understood.

## Opportunity ranking

When several markets are tradable at once, they are ranked by an expected-value
estimate discounted for execution quality, model uncertainty, disagreement,
liquidity and time remaining — **not** by the largest signal. A large edge on an
illiquid, uncertain market with four seconds left is worse than a moderate edge
that can actually be executed.

## Duplicate-order protection

Every request carries an idempotency key *and* a semantic fingerprint (token,
side, price bucket, size bucket). The guard rejects a repeat of either within a
30-second window, so a retry racing a slow acknowledgement cannot double the
position. A genuine re-quote after a cancel is allowed, because the cancel
releases the fingerprint.
