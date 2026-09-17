# Backtesting

## The backtester *is* the bot

`BacktestEngine` constructs the same objects `bot start` constructs — composite
price engine, order-book manager, feature engine, strategies, meta-model, risk
engine, trade gate, paper venue, executor — and drives them with a
`SimulatedClock` over an event stream. There is no parallel "backtest strategy"
implementation that could quietly diverge from the live one.

### Why there is no look-ahead

Structurally, not by convention:

- The simulated clock only moves forward, and every component reads time from
  it. Nothing calls `time.time()` on a decision path.
- At simulated time `t`, only events with `ts <= t` have been applied.
- The feature engine asks the composite for the price **as of** `t`, never for
  "the latest". If it is ever called after later data has been ingested it says
  so loudly and uses the as-of price. There is a test that feeds a 2× price
  spike after `t` and asserts the features computed at `t` are unchanged.
- Resolution is applied strictly after `window_end`, and the truth dictionary is
  never visible to the feature engine, the strategies or the gate.
- Fills come from walking the replayed book, so execution can never be better
  than the liquidity that actually existed.
- Training labels come from `markets.resolved_outcome`, known only after the
  window closed; any sample timestamped at or after its own `window_end` is
  dropped.

## Three sources of data

### 1. Recorded (best)

Run the bot in paper mode. Every window it watches is recorded once per second:
order books, the composite reference price, the full feature vector, the
prediction, and the resolution.

```bash
bot start                                     # leave it running
bot session --hours 24 --out data/recorded.json
bot backtest --session-file data/recorded.json
```

The books and prices are exactly what the bot saw, including every gap, stale
tick and thin moment. Top of book is as recorded; the levels behind it are
reconstructed from the recorded aggregate depth, which is noted in the session
metadata.

### 2. Downloaded history (weaker)

```bash
python scripts/fetch_history.py --assets BTC ETH --hours 6 --out data/history.json
bot backtest --session-file data/history.json
```

Exchange klines give the reference price path and Polymarket's
`/prices-history` gives the market's own mid. But the **order book has to be
reconstructed** around that mid, so depth and spread are modelling assumptions
rather than observations. The session is tagged accordingly and execution
results from it are weaker evidence. Both endpoints must be reachable.

### 3. Synthetic (engine validation only)

```bash
bot backtest --windows 24 --efficiency 0.5
```

A simulated world whose market maker misprices by an amount the generator
chooses, through `vol_bias`, `quote_lag_seconds` and `quote_noise`.

**A P&L figure from a synthetic session measures the engine, not alpha.**
Accounting, fee handling, sizing, risk limits, execution mechanics, absence of
look-ahead — all of that is genuinely tested. Whether real Polymarket books are
mispriced is not, and cannot be, because the mispricing was injected.

The most useful synthetic test is the negative one: set `--efficiency 1.0` and
the market maker prices with the true volatility and no lag. A correct bot then
finds essentially nothing that survives fees and trades almost nothing. If it
still trades heavily, the edge calculation is wrong.

## Walk-forward validation

```bash
bot walkforward --session-file data/recorded.json --slices 4 --model logistic
```

The session is cut into consecutive time slices. For slice *k*:

1. Training data is the samples harvested from slices `0..k-1` only, and only
   from windows that resolved before slice *k* began, minus an embargo gap.
2. A model is fitted and calibrated on that data alone.
3. Slice *k* is replayed with that model attached. Its results are
   out-of-sample by construction.
4. Repeat, expanding the training window.

This is the only honest way to report a number. Training on the whole history
and reporting performance on that same history measures how well the model
memorised, which on a few hundred five-minute windows is close to perfect and
completely meaningless.

`is_stable` requires positive expectancy in at least 60% of slices with five or
more trades. A strategy that works in two slices and fails in three is not a
strategy.

## Model selection

```bash
bot train --source database
```

Every candidate (logistic regression, random forest, histogram gradient
boosting, LightGBM, XGBoost) is evaluated under **purged** walk-forward
cross-validation. Samples from one window are near-identical and share a label,
so a random split would put near-copies on both sides and report a fantasy
score. `PurgedWalkForwardSplit` splits on time, keeps whole windows together,
and inserts an embargo.

Selection is by a composite score, not raw accuracy:

```
composite = mean(brier_skill) − 0.5·std(brier_skill) − 0.5·mean(ECE)
```

so a slightly worse but consistent and well-calibrated model wins. The output
table also reports `vs_market`: the Brier improvement over simply quoting the
market's own price. A model that cannot beat the market on that metric has no
business trading against it.

Logistic regression is the baseline and frequently wins. That is not a
disappointment; it is what a small, noisy sample should produce, and a tree
ensemble that cannot beat it is telling you something.

The fitted artifact is saved with a manifest recording config, seed, code
commit, dataset fingerprint, feature list and held-out test metrics. The bot
refuses to load an artifact whose feature list does not match the running
feature engine.

## Calibration

A probability of 0.70 must win about 70% of the time or every downstream edge
calculation is wrong in a way no amount of risk management can fix.

Both isotonic regression and Platt scaling are available. The calibrator is
always fitted on the **training fold only** — fitting it on the validation fold
is a subtle and common leak.

### Reading an ECE

A raw expected calibration error is nearly uninterpretable. With 50 samples in a
bin, a *perfectly* calibrated model still shows a gap of about 0.05 purely from
sampling. Every report therefore includes `ece_noise_floor` — the expected ECE
for a perfectly calibrated model at that sample size — and `ece_excess`, the
difference. Only the excess is evidence of real miscalibration.

Calibration is also reported **by time to expiry**. A single aggregate number
flatters the model: near expiry the analytic probability is almost
deterministic and will look brilliant. The interesting question is whether it is
calibrated with minutes still to run.

## Monte Carlo robustness

Included in `bot backtest` by default.

**Stationary bootstrap** over the realised trades gives the sampling
distribution of P&L, drawdown, win rate and losing-streak length. Geometric
blocks preserve short-range dependence, so losing streaks are not destroyed.
Drawdown in particular is extremely path-dependent: the same trade set can
produce a 5% or a 25% peak drawdown depending only on the order of the losses.

**Stress scenarios** re-price the realised trades under adverse assumptions,
holding the decisions fixed so execution and model risk are isolated from signal
risk:

| Scenario | What it models |
|---|---|
| slippage +1 / +2 ticks | every fill worse |
| spread doubles | more spread crossed |
| fees +50% | schedule raised |
| model 2pp / 5pp overconfident | true probability worse than predicted; **outcomes are re-drawn**, because an overconfident model does not just earn less on the same wins, it wins less often |
| 10% orders fail | fills lost to rejects and timeouts |
| latency eats 30% of edge | slower than the backtest assumed |
| combined adverse | everything mildly worse at once |

The headline number is the fraction of scenarios that stay profitable. A
strategy whose edge survives only the exact assumptions of its own backtest is
not a strategy.

## Reproducibility

Every run writes a manifest with the run id, seed, code commit, a hash of the
redacted config, the session description, the dataset fingerprint and the
decision interval. Re-running the same command with the same seed on the same
commit reproduces the result.

## Metrics

**P&L**: expectancy per trade and per dollar staked, profit factor, max
drawdown, per-trade Sharpe and Sortino, longest losing streak, trades per hour,
realised-versus-expected edge, maker fill share.

**Probability**: Brier score and skill, log loss, ECE with its noise floor,
reliability curve, AUC, and Brier versus the market's own price.

**Judge the probability metrics first.** A hundred five-minute trades says
almost nothing about P&L, but a hundred probability forecasts is enough to start
saying something about calibration — and a well-calibrated model with a genuine
edge produces the P&L eventually.

Per-trade Sharpe and Sortino are computed on P&L scaled by the *average* stake,
not each trade's own stake. Return-on-own-stake is degenerate for binaries:
every loss is almost exactly −100% of that trade's stake, the downside
dispersion collapses, and Sortino explodes into a meaningless number.

Nothing is annualised. Annualising a ratio from a few hundred five-minute bets
produces impressive nonsense.
