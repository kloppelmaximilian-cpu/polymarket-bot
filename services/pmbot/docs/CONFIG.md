# Configuration

Every setting is an environment variable, optionally in a `.env` file. Nothing
that affects trading behaviour is hard-coded anywhere else.

`bot config` prints the effective configuration with secrets redacted.

## Mode and safety

| Variable | Default | Meaning |
|---|---|---|
| `TRADING_MODE` | `paper` | `paper` or `live`. |
| `LIVE_CONFIRMATION` | `false` | Second switch. `TRADING_MODE=live` without it fails at config load. |
| `DRY_RUN_LIVE` | `false` | In live mode, build and sign orders but never POST them. |

## Credentials

Only needed for live trading. All are `SecretStr` and never appear in logs,
tracebacks or `bot config`.

| Variable | Meaning |
|---|---|
| `POLYMARKET_PRIVATE_KEY` | Signs orders (EIP-712). |
| `POLYMARKET_API_KEY` / `_SECRET` / `_PASSPHRASE` | L2 credentials for authenticated endpoints. |
| `POLYMARKET_FUNDER` | Address holding the USDC. For a proxy wallet this is **not** your EOA. |
| `POLYMARKET_SIGNATURE_TYPE` | `0` EOA, `1` Magic Link proxy, `2` Gnosis Safe (default). |

## Markets

| Variable | Default | Meaning |
|---|---|---|
| `ASSETS` | `BTC,ETH,SOL,XRP,DOGE` | Assets to hunt. Unknown ones are skipped, new ones are auto-discovered by the series sweep. |
| `SERIES_SLUG_TEMPLATES` | `{asset_lower}-up-or-down-5m,{asset_lower}-updown-5m` | Probed in order per asset. Change if Polymarket renames a series. |
| `MARKET_WINDOW_SECONDS` | `300` | Contract length. Markets whose window is not this length are rejected. |
| `DISCOVERY_INTERVAL_SECONDS` | `20` | Discovery cadence. |
| `DISCOVERY_LOOKAHEAD_SECONDS` | `900` | Also track markets opening within this horizon. |
| `MAX_TRACKED_MARKETS` | `40` | Subscription cap. |

## Market quality filters

A market failing any of these is not traded, and the reason is named in
`bot signals` and the `opportunities` table.

| Variable | Default | Meaning |
|---|---|---|
| `MAX_SPREAD` | `0.03` | Maximum bid-ask spread in probability. |
| `MIN_LIQUIDITY_USD` | `200` | Minimum resting notional within 5c of the touch. |
| `MIN_TOP_OF_BOOK_SHARES` | `5` | Minimum size at the ask. |
| `MAX_SLIPPAGE` | `0.02` | Size is bounded so the average fill stays within this of the touch. |
| `MIN_SECONDS_REMAINING` | `20` | Never open with less time left. |
| `MAX_SECONDS_REMAINING` | `270` | Skip the first 30s: the strike is not yet stable. |
| `STALE_BOOK_SECONDS` | `5` | A book older than this is not tradable. |

## Signal thresholds

| Variable | Default | Meaning |
|---|---|---|
| `MIN_EDGE` | `0.025` | **Base** edge bar in probability. Scaled up dynamically (see below). |
| `MIN_CONFIDENCE` | `0.55` | Minimum model confidence. |
| `MIN_MODEL_AGREEMENT` | `0.5` | Minimum confidence-weighted share of strategies pointing the same way. |
| `EDGE_UNCERTAINTY_MULTIPLE` | `1.0` | Edge must also exceed `k × uncertainty`. |
| `MAX_PLAUSIBLE_EDGE` | `0.12` | Edges above this are refused as model error. |
| `MARKET_ANCHOR_WEIGHT` | `0.35` | **The most important knob.** Weight on our model vs the market's own price. |
| `ADAPTIVE_ANCHOR` | `true` | Let measured relative skill move that weight. |
| `ANCHOR_WEIGHT_UNCERTAINTY` | `0.10` | Standard error of the anchor weight; the only extra uncertainty anchoring adds. |

### The edge bar is dynamic

`MIN_EDGE` is a floor, multiplied by up to `MAX_EDGE_MULTIPLIER` (2.5) based on:

- model uncertainty (the dominant term)
- thin liquidity
- poor data quality
- the share of total variance that is basis/measurement noise rather than
  genuine price movement
- a difficult regime (abnormal volatility, news-like, cross-venue divergence)

A fixed threshold would be wrong because the cost of being wrong is not fixed.

### Tuning `MARKET_ANCHOR_WEIGHT`

This governs trade frequency more than anything else. The default of `0.35`
trusts the market roughly twice as much as the model, which is the right prior
for a liquid market you have no track record against — and it means the bot
trades rarely until you have evidence.

Fit it from your own data:

```python
from pmbot.probability.anchor import fit_anchor_weight
weight, diagnostics = fit_anchor_weight(model_probs, market_probs, outcomes)
```

That recovers the log-loss-optimal weight by logistic stacking. Set
`MARKET_ANCHOR_WEIGHT` to the result. Never set it to 1.0 on real money without
walk-forward evidence that the model beats the market out of sample.

## Reference exchanges

| Variable | Default | Meaning |
|---|---|---|
| `EXCHANGES` | `binance,coinbase,kraken,okx,bybit` | Reference venues. |
| `MIN_HEALTHY_EXCHANGES` | `2` | Below this the composite is distrusted and trading pauses. |
| `FEED_STALE_SECONDS` | `3` | Observations older than this are excluded from the composite. |
| `FEED_DIVERGENCE_BPS` | `25` | Cross-venue disagreement that flags a problem. |
| `WS_RECONNECT_BASE_DELAY` / `_MAX_DELAY` | `1` / `30` | Exponential backoff bounds. |
| `WS_PING_INTERVAL` | `10` | Polymarket requires a PING every 10s. |

## Resolution oracle

| Variable | Default | Meaning |
|---|---|---|
| `RESOLUTION_ORACLE` | `composite` | `composite` (CEX proxy) or `chainlink`. |
| `ORACLE_BASIS_BPS` | `2.0` | Assumed std-dev of proxy-vs-oracle basis. Feeds `sigma_basis`. |
| `CHAINLINK_STREAMS_URL` / `_API_KEY` / `_API_SECRET` | unset | For `chainlink` mode. |

The crypto series settles on a Chainlink data stream. Using the CEX composite is
a proxy; `ORACLE_BASIS_BPS` is how much you think that proxy can drift between
the two snapshot instants. It is the term that stops the model claiming
near-certainty with seconds left. Setting it to zero is a mistake unless you are
reading the actual oracle.

## Fees

| Variable | Default | Meaning |
|---|---|---|
| `DEFAULT_TAKER_FEE_RATE` | `0.07` | Fallback when a market carries no schedule. |
| `DEFAULT_MAKER_FEE_RATE` | `0.0` | Makers pay nothing. |
| `MAKER_REBATE_RATE` | `0.0` | Deliberately 0: rebates are a pro-rata share of a daily pool and cannot be relied on per trade. |

Live markets carry their own `feeSchedule`, which always takes precedence.

## Risk

| Variable | Default | Meaning |
|---|---|---|
| `BANKROLL` | `1000` | Paper starting capital. |
| `MAX_STAKE_PER_TRADE` | `25` | Absolute per-trade cap. |
| `MAX_STAKE_FRACTION` | `0.02` | Per-trade cap as a fraction of bankroll. |
| `KELLY_FRACTION` | `0.25` | Fraction of full Kelly. |
| `SIZING_METHOD` | `kelly` | `kelly`, `fixed` or `edge_proportional`. |
| `MAX_PORTFOLIO_EXPOSURE` | `200` | Total committed capital, including resting orders. |
| `MAX_SIMULTANEOUS_POSITIONS` | `6` | Positions plus working orders. |
| `MAX_POSITIONS_PER_ASSET` | `2` | |
| `MAX_POSITIONS_PER_MARKET` | `1` | |
| `MAX_ASSET_EXPOSURE` | `100` | Per-asset notional. |
| `MAX_CORRELATED_EXPOSURE` | `150` | All crypto counts as one bucket. |
| `MAX_DAILY_LOSS` | `100` | Latching stop, resets at UTC midnight. |
| `MAX_SESSION_LOSS` | `150` | Latching stop for the process lifetime. |
| `MAX_CONSECUTIVE_LOSSES` | `8` | Latching stop. |
| `MAX_DRAWDOWN` | `0.25` | Fraction of peak equity. |
| `RISK_PAUSE_SECONDS` | `300` | Cooldown after a stop fires. |
| `MIN_ORDER_NOTIONAL` | `1.0` | |

Every count and exposure figure includes **resting orders**, not just filled
positions. See [RISK.md](RISK.md).

## Execution

| Variable | Default | Meaning |
|---|---|---|
| `EXECUTION_STYLE` | `maker_then_taker` | `taker`, `maker` or `maker_then_taker`. |
| `MAKER_WAIT_SECONDS` | `20` | How long a passive order rests before escalating. |
| `ORDER_TIMEOUT_SECONDS` | `30` | Resting-order lifetime. |
| `MAX_ORDER_RETRIES` | `2` | |
| `PAPER_LATENCY_MS` | `250` | Simulated round trip. The book we execute against is the one after this delay. |
| `PAPER_MAKER_FILL_RATIO` | `0.45` | Share of a print through our price that we get — our queue position. |
| `PAPER_QUEUE_MODEL` | `realistic` | `realistic` randomises queue position; `optimistic` does not. |

`maker_then_taker` is the default because makers pay no fee: at a one-tick
spread the same view is worth roughly twice as much passively.

## Strategies and models

| Variable | Default | Meaning |
|---|---|---|
| `ENABLED_STRATEGIES` | all nine | See [STRATEGIES.md](STRATEGIES.md). |
| `ADAPTIVE_WEIGHTS` | `true` | Weight strategies by realised skill. |
| `STRATEGY_WEIGHT_HALFLIFE` | `200` | Trades. Deliberately long: fast adaptation on five-minute outcomes fits noise. |
| `MIN_STRATEGY_WEIGHT` / `MAX_STRATEGY_WEIGHT` | `0.2` / `2.0` | Bounds. |
| `ML_ENABLED` | `true` | Load a model artifact if one exists. |
| `ML_BLEND_WEIGHT` | `0.5` | ML influence beyond its ensemble vote. |
| `MODEL_DIR` / `MODEL_NAME` | `models` / `ensemble_v1` | Artifact location. |
| `CALIBRATION_METHOD` | `isotonic` | `isotonic`, `platt` or `none`. |
| `MIN_CALIBRATION_SAMPLES` | `500` | Below this the calibrator stays the identity, visibly. |
| `PROBABILITY_FLOOR` / `_CAP` | `0.02` / `0.98` | Never claim more certainty than this. |

## Storage, logging, alerts

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `sqlite:///data/pmbot.db` | |
| `DB_FLUSH_INTERVAL_SECONDS` | `2` | |
| `DB_BATCH_SIZE` | `200` | |
| `SNAPSHOT_INTERVAL_SECONDS` | `1` | Feature/book recording cadence — this is your training data. |
| `RECORD_TRAINING_DATA` | `true` | Turn off only if disk is a problem. |
| `LOG_LEVEL` | `INFO` | |
| `LOG_DIR` | `logs` | |
| `LOG_JSON` | `true` | |
| `TELEGRAM_ENABLED` | `false` | |
| `TELEGRAM_BOT_TOKEN` / `_CHAT_ID` | unset | |
| `DASHBOARD_REFRESH_HZ` | `2` | Also sets the main-loop cadence. |
| `RANDOM_SEED` | `42` | Reproducibility. |

## Profiles

**Conservative** — few, high-quality trades:

```bash
MIN_EDGE=0.04
MIN_CONFIDENCE=0.65
MARKET_ANCHOR_WEIGHT=0.25
MAX_STAKE_FRACTION=0.01
KELLY_FRACTION=0.15
MAX_SIMULTANEOUS_POSITIONS=3
```

**Higher frequency** — only after walk-forward evidence:

```bash
MIN_EDGE=0.02
MIN_CONFIDENCE=0.5
MARKET_ANCHOR_WEIGHT=<your fitted value>
MAX_SIMULTANEOUS_POSITIONS=10
MAX_POSITIONS_PER_ASSET=3
ASSETS=BTC,ETH,SOL,XRP,DOGE,BNB
```

**Data collection only** — never trades, records everything:

```bash
MIN_EDGE=1.0
RECORD_TRAINING_DATA=true
SNAPSHOT_INTERVAL_SECONDS=1
```
