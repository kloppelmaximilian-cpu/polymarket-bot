# Research notes

What was investigated, what was kept, what was thrown away, and why. Including
the things that did not work.

## Verifying the API before writing against it

The first constraint was not to code from memory. Polymarket's published docs
were unreachable from the build host (egress policy), so the authoritative
sources used instead were:

- **`py-clob-client` 0.34.6 source** (PyPI) — endpoint paths, the L1/L2 signing
  schemes, the per-tick-size rounding configuration, order construction, the
  `/fee-rate` endpoint.
- **`Polymarket/agent-skills`** (GitHub) — the current integration guide:
  base URLs, websocket channels and event types, order types, signature types,
  error codes, heartbeat semantics.
- **`Polymarket/clob-client`** TypeScript endpoint list — cross-check, and the
  source of `/prices-history`.
- **A live-API field survey** of the BTC 5-minute series, giving the actual
  `feeSchedule`, `orderMinSize`, `rewardsMinSize` and slug patterns.

The L2 HMAC implementation is native, and there is a test asserting it is
byte-for-byte identical to the official client's across GET, POST and DELETE.
Order *signing* is delegated to `py-clob-client` — a hand-rolled EIP-712 order
signature risks producing orders that are valid but wrong, which is the worst
possible failure.

### Three traps found in the real payloads

1. **`takerBaseFee: 1000`** is present on these markets and looks like 10% in
   basis points. It is not what is charged when a `feeSchedule` exists. Coding
   against it overstates fees by 5×, which would suppress every trade.
2. **The title is in US Eastern time** while `eventStartTime` and `endDate` are
   UTC. Parsing the title puts every window hours out.
3. **`outcomes` and `clobTokenIds` are stringified JSON**, not arrays.

All three are covered by tests against a real payload.

## What the contract actually is

The decisive modelling insight came from reading the markets' own
`description` and `resolutionSource`: they resolve UP if the oracle price at
window end is **greater than or equal to** the price at window start.

That makes each one a **digital option struck at the window-open price**, not a
generic "will it go up" question. Once framed that way, the fair value is a
closed form, and the whole system reorganises around three observable
quantities: distance from strike, time remaining, and volatility.

It also means **ties resolve UP**, and that the oracle is a Chainlink data
stream — *not* an exchange spot price. Tracking the price through a composite of
centralised exchanges is a proxy, and the proxy-versus-oracle basis is a real
risk that has to be modelled rather than ignored. That is the `sigma_basis`
term, and it is what stops the model claiming 0.999 with ten seconds left.

## What the literature contributed

Ideas taken from the microstructure and forecasting literature, each kept only
because it addressed a problem that actually showed up in measurement:

- **Two-scale realized volatility** (Zhang, Mykland & Aït-Sahalia, 2005) and the
  first-order autocovariance noise estimator — kept, and decisive. See below.
- **Bipower variation** (Barndorff-Nielsen & Shephard) — kept, as a jump
  detector feeding the `NEWS_LIKE` regime, not as the primary vol estimate.
- **Kaufman efficiency ratio** — kept. It is the cleanest available separator of
  "trending" from "chopping", and momentum requires it.
- **Microprice / depth imbalance** — kept. Size-weighted top of book is a better
  estimate of the market's own next price than the mid.
- **Purged, embargoed cross-validation** (de Prado) — kept, and essential.
  Samples within one five-minute window are near-identical and share a label; a
  random split reports a fantasy score.
- **Isotonic regression and Platt scaling** for calibration — both kept and both
  available.
- **Logistic stacking** for combining two probability sources — kept, as the
  offline estimator of the market-anchor weight.
- **Fractional Kelly with a lower confidence bound** — kept. Full Kelly on a
  point estimate is how a mathematically sound system blows up.
- **Stationary bootstrap** (Politis & Romano) — kept for the robustness
  distribution, because it preserves losing streaks where an i.i.d. bootstrap
  destroys them.

## Four findings that changed the design

### 1. Microstructure noise makes naive volatility useless here

BTC at 50% annualised moves about **0.9 basis points per second**. Per-venue
quote noise is of the same order. Naive realized variance at 1-second sampling
therefore measures mostly noise:

| Per-observation noise | Naive estimator | Corrected |
|---|---|---|
| 0.0 bps | 0.99× | 0.99× |
| 0.7 bps | 1.49× | 0.99× |
| 1.5 bps | 2.58× | 0.98× |

(1.00× = unbiased, 12 seeds per level.) An estimator 2.6× too high pushes every
probability toward 0.50, making the model systematically under-confident — and
that was visible in the first validation run as a *negative* Brier skill against
a market maker who knew the true volatility.

The correction combines the autocovariance noise estimate with a two-scale
estimator, on a regular one-second grid. It is the single highest-value piece of
quantitative machinery in the repository.

### 2. The biggest edges are almost always your own bugs

The first walk-forward run produced: 58% win rate, **negative** P&L, an average
claimed edge at entry of **+15.7 percentage points**, and a Brier skill of
−0.21 on the traded subset despite +0.21 on all samples.

The diagnosis is worth stating plainly. The trade gate selects the markets where
model and market disagree most. A large disagreement with a liquid market is far
more often model error than market error. So a model with genuinely positive
*average* skill lost money, because the subset it chose to trade was precisely
the subset where it was wrong.

Two changes followed, and both are principled rather than patches:

- **Market anchoring.** The model's probability is blended with the market's own
  de-vigged price in log-odds, weighted by relative precision. A 17-point raw
  disagreement becomes a 6-point posterior deviation. Only disagreements large
  relative to our own error survive.
- **An implausible-edge guard.** Net edges above `MAX_PLAUSIBLE_EDGE` are
  refused outright as model error.

An early version of the anchoring also charged the full disagreement as
uncertainty *on top of* shrinking the point estimate. That double-counts, and
the two terms cancelled so precisely that the bot stopped trading entirely.
Combining two independent estimates *reduces* variance; what remains genuinely
unknown is the blend weight, so only the weight's standard error is charged.

### 3. A five-second-stale strike destroyed the model

Found by the validation harness disagreeing with a direct oracle-parameter
calculation: with a *perfect* price feed and a correct volatility estimate, the
model still lost to the market at every horizon. That should have been
impossible.

The cause: the bot watches a market before its window opens. The strike
back-fill path cached a price from up to five seconds early, and the exact
snapshot taken at the boundary was then ignored because a record already
existed.

The effect: **2.3 basis points of standard deviation in every log-moneyness** —
roughly 15% of an entire five-minute move.

After fixing it (quality ranking, upgrade-on-better, and refusing to invent a
strike for a window that has not opened), moneyness error is exactly
`0.00000 bps` and the model beats the market at nearly every horizon:

| Horizon | Model Brier | Market Brier | Model wins |
|---|---|---|---|
| 240–300s | 0.2162 | 0.2244 | yes |
| 180–240s | 0.1680 | 0.1775 | yes |
| 120–180s | 0.1412 | 0.1484 | yes |
| 60–120s | 0.1116 | 0.1149 | yes |
| 30–60s | 0.0721 | 0.0755 | yes |
| 0–30s | 0.0357 | 0.0448 | yes |

The lesson is about method, not about strikes: a validation harness is only
useful if you take its disagreements seriously instead of explaining them away.

### 4. A single walk-forward run says nothing, including ours

The walk-forward with a fitted logistic model was run over seven synthetic
seeds, identical in every other parameter (`--windows 60 --efficiency 0.30
--slices 4 --model logistic`, now reproducible as `bot walkforward --seeds 7`):

| Seed | Trades | Win rate | P&L | Expectancy/$ |
|---|---|---|---|---|
| 1 | 16 | 81.2% | −14.53 | −0.0757 |
| 5 | 28 | 89.3% | **+26.57** | +0.0832 |
| 11 | 37 | 81.1% | −26.66 | −0.0811 |
| 23 | 21 | 71.4% | −15.67 | −0.0845 |
| 42 | 44 | 77.3% | −38.90 | −0.0810 |
| 77 | 33 | 81.8% | +28.66 | +0.0960 |
| 101 | 27 | 77.8% | +24.85 | +0.1026 |
| **pooled** | **206** | **80.1%** | **−15.69** | **−0.0077** |

Three of seven seeds profitable, and a spread from −38.90 to +28.66 around a
pooled result of roughly zero. An earlier version of this document reported
seed 5 on its own. That number is real and reproducible, and it is also the
best of seven — quoting it alone was the mistake, not the measurement.

Two things are worth extracting.

**The win rate is not the story.** Every seed wins 71–89% of its trades and
four of them still lose money. On a binary market the bot mostly buys
favourites, so the modal trade is a small win and the tail trade is a total
loss of the stake. Any win rate below `1 − p` at the average entry price `p` is
a losing strategy, and 80% at an average entry near 0.80 is exactly break-even
before costs. **Win rate on binaries is close to uninformative** and it is the
first number a dashboard tempts you to optimise.

**The gate still overstates its own edge.** Pooled across 206 trades the
average net edge claimed at entry was +8.2 points per share while the realised
edge was about 1 point *worse than zero* — a residual overstatement of roughly
ten points. Market anchoring at `w = 0.35` reduced the adverse selection that
finding 2 describes; it did not remove it. The remaining gap is our own
estimation error being selected for, and it is the strongest argument in this
repository for fitting `MARKET_ANCHOR_WEIGHT` on real data before trading it.

What was deliberately *not* done: lowering the anchor weight until the synthetic
sweep turned positive. The generator's mispricing is a parameter chosen here, so
tuning against it optimises a number nobody will ever be paid for. The
`--seeds` flag exists so the spread is reported by default rather than
discovered later.

## What was rejected

**Deep learning.** Not used. With a few thousand samples from a handful of days
of five-minute windows, the failure mode is overfitting in every direction. The
spec's own condition — only if backtests show robust additional value — is not
met, and could not be met on this sample size. Logistic regression is the
baseline and frequently wins the benchmark outright.

**Stacking the strategy ensemble with another learned layer.** Rejected in
favour of weighted log-odds averaging. Fitting another layer on the same small
sample is where stacking usually goes wrong, and it destroys interpretability
for no measured gain.

**A large indicator library.** RSI, MACD, Bollinger, stochastic, ROC and an
ATR/ADX proxy are computed because they are cheap and the model can select among
them. Anything requiring OHLC bars was dropped — on a tick mid-price series the
bar boundaries are arbitrary and the indicator measures the boundary choice.

**Maker rebates in the edge calculation.** Polymarket shares taker fees back to
qualifying makers (`rewardsMinSize=50`, `rewardsMaxSpread=4.5`) and on paper
this is a genuine edge for a tight-quoting bot. It is modelled as **zero**
because it is a pro-rata share of a daily pool: it cannot be attributed to a
trade at decision time, and counting it would flatter every result.

**Trading the last seconds of a window.** Economically tempting — the analytic
probability is nearly deterministic — and rejected. That is exactly where
measurement and basis error dominate the remaining diffusive move, and where the
`sigma_basis` term correctly collapses our confidence. `MIN_SECONDS_REMAINING`
defaults to 20.

**Fast adaptive strategy weights.** Tried with a short half-life; it tracks
noise. The half-life is 200 trades, and weights are shrunk toward neutral until
there is real evidence.

**Annualised Sharpe ratios.** Removed. Annualising a ratio from a few hundred
five-minute bets produces impressive nonsense. Everything is reported per trade.

**Return-on-own-stake for risk ratios.** Degenerate for binaries: every loss is
almost exactly −100% of that trade's stake, downside dispersion collapses, and
Sortino explodes. P&L is scaled by the *average* stake instead.

## What is still open

**The resolution oracle.** The highest-value remaining improvement by a wide
margin. Reading the actual Chainlink stream the markets settle against removes
the proxy basis disadvantage entirely — both the `sigma_basis` penalty and the
residual strike/settle measurement error. The `RESOLUTION_ORACLE=chainlink`
configuration path exists and is unimplemented.

**The anchor weight on real data.** `MARKET_ANCHOR_WEIGHT` governs trade
frequency more than any other setting, and its correct value is an empirical
question this repository cannot answer without real recorded windows.
`fit_anchor_weight` does the estimation; it needs data.

**Cross-market structure.** BTC, ETH and SOL windows on the same grid are
correlated, and a market-wide move is the one situation where all positions lose
together. They are currently treated as one correlation bucket for exposure
purposes but not modelled jointly.

**Queue position.** The paper venue models it as a random share of volume
printing through our price. Real fill rates depend on actual queue position,
which is unobservable from the public feed. Measuring realised maker fill rates
in live trading would let the model be replaced with something calibrated.

**Adverse selection on maker orders.** The passive order that fills is the one
the market has moved through. The executor re-validates the edge every cycle and
cancels, but this cannot be eliminated — only measured, by comparing maker fill
P&L against taker fill P&L once there is enough of both.
