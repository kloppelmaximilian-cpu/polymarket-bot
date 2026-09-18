# Polymarket 5-Minute Crypto Trading Bot

An end-to-end quantitative trading system for Polymarket's 5-minute crypto
up/down markets (BTC, ETH, SOL, XRP, DOGE and any other asset the same series
structure appears for).

It discovers markets automatically, streams reference prices from five
centralised exchanges, prices the contract as the digital option it actually is,
compares that against the market's own book, and trades only when the edge
survives fees, spread, slippage and its own error bars.

**Paper trading is the default and live trading cannot be switched on by
accident.** It needs `TRADING_MODE=live`, `LIVE_CONFIRMATION=true`, a signing
key and API credentials — four independent things, each of which fails closed.

There is no claim of profitability here. What the repository provides is a
system that measures whether an edge exists, refuses to trade when it cannot
demonstrate one, and records enough about every decision that you can audit it
afterwards. See [What we actually measured](#what-we-actually-measured).

---

## Quick start

```bash
git clone https://github.com/kloppelmaximilian-cpu/polymarket-bot.git
cd polymarket-bot
./start_bot.sh            # creates a venv, installs, runs in PAPER mode
```

In a second terminal, from the same directory:

```bash
./dashboard.sh            # live terminal dashboard
```

That is the whole happy path. Everything below is detail.

Both scripts live **in the repository**, so run them from inside it -- `cd
polymarket-bot` first, or you get `no such file or directory`.

**macOS:** `python3` is Apple's 3.9, which this project does not support, and
LightGBM's wheels need OpenMP. So:

```bash
brew install python@3.12 libomp
make install PYTHON=python3.12
```

[SETUP.md](docs/SETUP.md#macos) covers both, including how to skip LightGBM
entirely if you prefer.

### Manual setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[all]"          # or ".[ml]" to skip live-trading deps
cp .env.example .env             # optional: nothing is required for paper mode

bot doctor                       # check deps and API reachability
bot discover                     # list the 5-minute markets it can see
bot start                        # paper trading
bot dashboard                    # in another terminal
```

`make help` lists every shortcut.

---

## How it works

```
      5 reference exchanges                    Polymarket
  Binance Coinbase Kraken OKX Bybit        Gamma  ·  CLOB  ·  WSS
            │                                      │
            ▼                                      ▼
    composite price  ──── outlier rejection   market discovery
    (weighted median, MAD filter)             (series → windows → tokens)
            │                                      │
            ▼                                      ▼
    noise-corrected volatility            live L2 order books
            │                                      │
            └──────────────┬───────────────────────┘
                           ▼
                   feature engine (80 features)
                           ▼
        ┌──────────────────┴──────────────────┐
        │   8 strategies + regime detector    │
        │   each outputs a drift in sigma     │
        └──────────────────┬──────────────────┘
                           ▼
              meta-model (log-odds fusion)
                           ▼
              ML model (optional) + calibration
                           ▼
              anchor to the market's own price
                           ▼
                 trade gate  ── fees, spread, slippage,
                           │    liquidity, uncertainty, risk
                           ▼
              maker-first execution engine
                           ▼
              risk engine · database · dashboard
```

### The contract, priced correctly

These markets resolve **UP if the oracle price at the end of the five-minute
window is greater than or equal to the price at the start** (ties resolve UP).
That makes each one a *digital option* struck at the window-open price. With
`P_t` the current price, `S` the strike, `tau` seconds remaining and `sigma` the
per-second volatility:

```
P(UP) = Phi( ( ln(P_t/S) + mu*tau ) / sqrt(sigma^2*tau + sigma_basis^2) )
```

Every strategy expresses itself as a **drift** in units of the standard
deviation of the move still to come, and the pricer converts that to a
probability. A momentum reading of "+0.5 sigma" then means the right thing at
both 240 seconds and 20 seconds left, and on both BTC and DOGE, without any
per-asset tuning.

The `sigma_basis` term is what stops the model claiming near-certainty with
seconds left: settlement follows the market's own oracle (a Chainlink data
stream for the crypto series), and a composite of exchange prices is a *proxy*
for it.

### Why fees dominate everything

The crypto fee schedule is `fee = shares × 0.07 × p × (1-p)`, charged to takers
only. At 50c that is **1.75 probability points per share**, plus the one-tick
spread. So a 2-point edge is not an edge.

This single fact drives the execution design: resting at the bid as a *maker*
pays no fee at all, so the same view is worth roughly twice as much passively as
aggressively.

| At a 0.52 ask, model says 0.56 | Net edge |
|---|---|
| Cross the spread (taker) | `0.56 − 0.52 − 0.0175` = **+0.0225** |
| Rest at the 0.51 bid (maker) | `0.56 − 0.51 − 0` = **+0.0500** |

Hence `EXECUTION_STYLE=maker_then_taker`: rest first, re-check the edge on every
cycle, escalate to crossing only if it has not filled and the edge still clears
the taker bar.

### Anchoring to the market

The model's probability is blended with the market's own de-vigged price in
log-odds space:

```
logit(p) = w · logit(p_model) + (1−w) · logit(p_market)
```

This is not a hedge, it is the fix for a specific and expensive failure mode
that this repository's own walk-forward run demonstrated. The trade gate selects
the markets where model and market disagree *most*, and a large disagreement is
far more often model error than market error. Without anchoring, a model with
genuinely positive average skill lost money, because the subset it chose to
trade was the subset where it was wrong.

`MARKET_ANCHOR_WEIGHT` defaults to a conservative `0.35`. **Fit it from your own
data** with `pmbot.probability.anchor.fit_anchor_weight`, which recovers the
optimal weight by logistic stacking. Until you have, the bot trades rarely by
design.

---

## What we actually measured

Everything below is reproducible from this repository. Nothing here is a
projection.

### Engine validation (synthetic)

`python scripts/validate_engine.py` builds a simulated world whose market maker
misprices by an amount the generator chooses, then checks the properties that
must hold:

```
Calibration of the analytic probability by time to expiry
(against a market maker that knows the true volatility)
   horizon      n    brier    skill     ece    auc   vs_market
  240-300s    576   0.2283  +0.0721  0.0972  0.629    +0.0027
  180-240s    576   0.1666  +0.3231  0.1042  0.842    -0.0021
  120-180s    576   0.1384  +0.4375  0.0959  0.890    +0.0049
   60-120s    576   0.1199  +0.5129  0.0781  0.918    +0.0034
    20-60s    384   0.1133  +0.5397  0.0945  0.935    +0.0094
     0-20s    144   0.0694  +0.7179  0.0653  0.977    +0.0043

Scenario sweep
  scenario                            volBias  lag   evals  tradable  trades  pnl
  efficient market (control)            1.000  0.0   15840         0       0  +0.00
  mildly inefficient                    1.120  1.6   15840         0       0  +0.00
  clearly inefficient                   1.210  2.8   15840         1       1  +2.68
  very inefficient                      1.300  4.0   15840         2       1  +1.72

Checks
  accounting identity        PASS      (P&L == payoff − cost − fees, exactly)
  negative control quiet     PASS      (0 trades against a correctly priced market)
  more mispricing -> more    PASS
```

**Read this as an engine test, not an alpha test.** The mispricing in the
synthetic world was injected by the generator, so the P&L measures the
machinery — accounting, fee handling, sizing, risk limits, execution mechanics,
absence of look-ahead — and says nothing about whether real Polymarket books are
mispriced. The most informative line is the negative control: against a
correctly priced market the bot takes **zero** trades out of 15,840 evaluations.

### Two real bugs this validation caught

Both were found by the validation harness disagreeing with expectations, and
both are now covered by regression tests.

**1. A stale strike.** The bot watches a market before its window opens. The
strike back-fill path cached a price from up to five seconds early and the exact
snapshot taken at the boundary was then ignored. That injected ~2.3 bps of
error (std) into every log-moneyness — roughly 15% of an entire five-minute
move. Before the fix the model lost to the market at *every* horizon; after it,
moneyness error is exactly 0.00000 bps and the model wins at nearly all of them.

**2. Resting orders invisible to risk.** While a maker order rested there was no
position, so the next cycle passed every limit and ordered again. Both filled
and the position was double the intended size. Fixed with explicit capital
reservations; the per-trade cap now holds in the backtester (verified: max
notional $19.75 against a $25 cap, max stake fraction 0.0197 against 0.02).

### Volatility estimation

At one-second sampling, per-observation noise is the same order as BTC's actual
per-second move, so naive realized variance measures mostly noise. Measured
over 12 seeds per level:

| Per-observation noise | Naive estimator | This estimator |
|---|---|---|
| 0.0 bps | 0.99× | 0.99× |
| 0.7 bps | 1.49× | 0.99× |
| 1.5 bps | 2.58× | 0.98× |

(1.00× = unbiased.) The correction combines an autocovariance noise estimate
with two-scale realized variance; without it the pricer is systematically
under-confident and every edge calculation is wrong.

### Walk-forward across seeds (synthetic)

With a logistic model fitted only on earlier slices, seven otherwise identical
synthetic worlds (`bot walkforward --windows 60 --efficiency 0.30 --seeds 7`)
give:

| Seed | Trades | Win rate | P&L |
|---|---|---|---|
| 1 | 16 | 81.2% | −14.53 |
| 5 | 28 | 89.3% | +26.57 |
| 11 | 37 | 81.1% | −26.66 |
| 23 | 21 | 71.4% | −15.67 |
| 42 | 44 | 77.3% | −38.90 |
| 77 | 33 | 81.8% | +28.66 |
| 101 | 27 | 77.8% | +24.85 |
| **pooled** | **206** | **80.1%** | **−15.69** |

**Three of seven profitable, pooled expectancy −0.77% per dollar staked.** So:
this repository does *not* demonstrate a positive-expectancy strategy, in a
synthetic world or a real one. It demonstrates an engine that prices, gates,
sizes, executes and accounts correctly, and a validation harness honest enough
to say when the strategy on top of it has not been shown to work. Quoting seed
5 alone — as an earlier draft of this README did — would have been the exact
failure mode `--seeds` exists to prevent.

Note also that every seed wins 71–89% of its trades and four still lose money.
Buying favourites on a binary market makes win rate nearly uninformative:
small wins, whole-stake losses.

### Robustness

`bot backtest` runs a stationary bootstrap and ten stress scenarios over the
trades it actually took. To ask what a thin edge is worth under worse
assumptions, `scripts/robustness_demo.py` feeds the same machinery a sample
whose edge is *stipulated* rather than produced by our model -- 240 trades at a
2.5-point edge, 1.5 points of it real:

```bash
python scripts/robustness_demo.py      # reproduces this table exactly
```

```
baseline                  +106.73  profitable
slippage +1 tick           +11.09  profitable
slippage +2 ticks          -84.41  NOT profitable
spread doubles             +58.89  profitable
fees +50%                  +25.37  profitable
model 2pp overconfident   -213.27  NOT profitable
model 5pp overconfident   -413.27  NOT profitable
10% orders fail           +149.56  profitable
latency eats 30% of edge   +34.99  profitable
combined adverse          -336.82  NOT profitable
```

The stipulated edge is deliberate. The engine's own synthetic runs take a
handful of trades -- far too few for ten scenarios to mean anything -- and
choosing the edge separates *cost sensitivity* from noise in our own signal.
Read the rows as arithmetic about Polymarket's cost structure, not as a
measurement of this bot.

The lesson is blunt and worth internalising: **the edge on these markets is thin
relative to costs, so calibration accuracy is the binding constraint.** A model
two points overconfident turns a winning strategy into a losing one.

### Tests

803 tests, all passing in about 50 seconds:

```bash
make test          # full suite
make test-fast     # skip the slow backtests
make accept        # the acceptance checklist, run against the real modules
```

They include a negative control (no trades against a correctly priced market),
an accounting identity check, a causality check (feeding future data cannot
change a past feature value), a SQLite concurrency stress test, and a full
end-to-end paper cycle with every external boundary faked and nothing internal
faked.

---

## Documentation

| File | Contents |
|---|---|
| [SETUP.md](docs/SETUP.md) | Installation, environment, credentials, live-mode checklist |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Module map, data flow, design decisions |
| [CONFIG.md](docs/CONFIG.md) | Every setting, what it does, how to tune it |
| [STRATEGIES.md](docs/STRATEGIES.md) | All nine strategies (eight on by default), the regime detector, the meta-model |
| [BACKTESTING.md](docs/BACKTESTING.md) | Replay, walk-forward, Monte Carlo, getting real data |
| [RISK.md](docs/RISK.md) | Limits, sizing, kill switches, what is deliberately absent |
| [DASHBOARD.md](docs/DASHBOARD.md) | Every panel and key binding |
| [API.md](docs/API.md) | The Polymarket endpoints used, verified against the official client |
| [RUNBOOK.md](docs/RUNBOOK.md) | Operating it: alarms, failure modes, recovery |
| [RESEARCH.md](docs/RESEARCH.md) | What was investigated, what was kept, what was thrown away and why |

---

## Commands

```bash
bot start [--mode paper|live]   # run the bot
bot dashboard [--simple]        # live TUI (Rich fallback with --simple)
bot status                      # one-screen summary
bot markets [--sort edge]       # monitored markets
bot signals                     # best signals with full reasoning
bot positions / trades / pnl    # position and P&L views
bot risk                        # limits against current values
bot strategies                  # per-strategy skill and P&L
bot feeds                       # data-feed health
bot audit <market-id>           # why did we trade this?
bot discover                    # one-shot live market discovery
bot doctor                      # environment and connectivity check
bot config                      # effective config, secrets redacted
bot session                     # build a replay session from recorded data
bot backtest [--session-file f] # backtest + robustness
bot walkforward --seeds 7       # walk-forward validation over N worlds
bot train                       # benchmark models, fit the winner
```

---

## Getting from here to a real answer

The synthetic results validate the engine. To find out whether an edge exists on
the real markets:

1. **Collect.** Run `bot start` in paper mode. Every window it watches is
   recorded once per second: books, reference prices, features, predictions,
   resolutions. A day gives roughly 300 windows per asset.
2. **Build a replay session.** `bot session --hours 24 --out data/recorded.json`.
   The books and prices are exactly what the bot saw, gaps and all.
3. **Fit the anchor weight.** `fit_anchor_weight(model, market, outcomes)` on the
   recorded samples. This is the parameter that governs trade frequency.
4. **Walk forward.** `bot walkforward --session-file data/recorded.json`. Each
   slice is traded by a model fitted only on the slices before it.
5. **Stress it.** Check the Monte Carlo output survives the adverse scenarios.
6. Only then consider live, and start at a fraction of the size you think is
   right.

`scripts/fetch_history.py` is the alternative path (exchange klines plus
Polymarket price history) but it reconstructs order-book depth rather than
observing it, so it is weaker evidence.

---

## Risks

- **No edge is guaranteed.** The system is built to detect the absence of one
  and to stay flat, which is what it does by default.
- **Basis risk.** Settlement follows the market's own oracle. Tracking the price
  through exchange feeds is a proxy; the bot measures the disagreement rate
  between its proxy resolution and the venue's and shows it on the dashboard.
- **Thin books.** Top of book is often under 50 shares. Size is bounded by a
  slippage budget, not by what you would like to trade.
- **Adverse selection on maker orders.** The passive order that fills is the one
  the market has moved through. The executor re-validates the edge every cycle
  and cancels, but cannot eliminate this.
- **Small samples.** A hundred five-minute trades says almost nothing about P&L.
  Judge the probability metrics — Brier skill and calibration — long before the
  money ones.
- **Live trading moves real funds.** Read [SETUP.md](docs/SETUP.md) before
  arming it.

## Licence

MIT. Third-party dependencies keep their own licences; `py-clob-client`
(Polymarket, MIT) is used for live order signing only.
