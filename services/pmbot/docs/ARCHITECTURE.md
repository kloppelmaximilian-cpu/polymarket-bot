# Architecture

## Layout

```
src/pmbot/
  config.py            every tunable, env-overridable, secrets as SecretStr
  logging_setup.py     structured JSON logging with secret redaction
  runner.py            the orchestrator: three async loops
  resolution.py        outcome determination and proxy/authoritative reconciliation
  cli.py               `bot ...`

  core/
    types.py           domain dataclasses (Market, BookSnapshot, Opportunity, ...)
    clock.py           Clock / SimulatedClock — the only source of "now"
    health.py          component health and model-degradation detection

  polymarket/
    gamma.py           market metadata and discovery
    clob_rest.py       books, prices, tick sizes, order placement
    clob_ws.py         market-channel websocket
    auth.py            L1 EIP-712 / L2 HMAC headers
    fees.py            fee = shares × rate × p × (1-p)
    parsers.py         defensive parsing of every payload shape
    discovery.py       automatic 5-minute market discovery
    http.py            rate limiting, retries, error classification

  exchanges/
    base.py            resilient websocket framework (reconnect, staleness, dedup)
    venues.py          Binance, Coinbase, Kraken, OKX, Bybit
    composite.py       robust composite price + strike registry

  orderbook/book.py    L2 book state machine and microstructure maths

  features/
    indicators.py      causal technical indicators
    engine.py          the 80-feature vector

  probability/
    analytic.py        the digital-option pricer
    vol.py             noise-corrected volatility estimation
    calibration.py     isotonic / Platt + reliability diagnostics
    anchor.py          market-anchored blending
    engine.py          features → calibrated probability

  strategies/
    base.py            Strategy ABC; drift → probability conversion
    signals.py         the nine strategies
    regime.py          regime detection and per-regime preferences
    ensemble.py        log-odds meta-model + adaptive weights
    ml_strategy.py     a trained model as one more voice

  ml/
    dataset.py         samples + purged walk-forward splitting
    models.py          logistic / RF / GBM / LightGBM / XGBoost / ensemble
    train.py           benchmark, select, fit, manifest
    registry.py        artifact loading with feature-list verification

  risk/
    sizing.py          fractional Kelly with uncertainty shrinkage
    engine.py          accounting, limits, kill switches, reservations

  execution/
    base.py            venue interface + duplicate-order guard
    paper.py           realistic paper fills (latency, queue, book walking)
    live.py            live CLOB execution behind four safety gates
    gate.py            the trade gate and opportunity ranking
    executor.py        maker-first execution strategy

  backtesting/
    replay.py          replay format + synthetic world generator
    real.py            replay sessions from recorded or downloaded data
    engine.py          event-driven replay through the real components
    walkforward.py     expanding-window walk-forward validation
    montecarlo.py      bootstrap + stress scenarios
    metrics.py         P&L and probability metrics

  database/
    schema.py          19 tables
    store.py           batched async writer over a mutex-guarded SQLite
    repo.py            read queries and leakage-safe dataset construction

  dashboard/
    state.py           reads the published snapshot
    render.py          Rich renderables (shared by both front-ends)
    app.py             Textual TUI + Rich fallback

  alerts/manager.py    deduplicated, rate-limited alerting; optional Telegram
```

## Runtime

Three asyncio loops plus the feed tasks:

**Discovery loop** (every 20s) refreshes the tracked market set and reconciles
the websocket subscription in place, so a five-minute rollover does not cause a
reconnect.

**Main loop** (~2 Hz) per cycle:

1. Refresh composite prices; update feed health.
2. Evaluate system health → possibly scale size down or pause.
3. Mark open positions.
4. For each tracked market: features → regime → strategies → meta-model →
   anchor → calibration → trade gate (both outcomes).
5. Rank every candidate globally; execute the best, re-checking risk before each
   order.
6. Advance working maker orders (re-validate, escalate, or cancel).
7. Settle closed windows; feed outcomes back into the adaptive weights.

**Persistence loop** (1 Hz) flushes batched writes and atomically publishes
`data/state.json`.

Every stage is individually guarded: a failure evaluating one market must not
stop the others from being traded. Errors are counted, logged and surfaced on
the dashboard — never swallowed silently.

## Design decisions

### The clock is injected everywhere

Nothing calls `time.time()` on a decision path. Every component takes a `Clock`,
so the backtester can drive the identical code with a `SimulatedClock`. This is
what makes "the backtest is the live system with a different data source"
literally true rather than aspirational.

### Strategies output drift, not probabilities

A strategy returns a tilt in units of the standard deviation of the remaining
move. The pricer converts it. Time-scaling and volatility-scaling then happen
once, consistently, instead of being re-derived (and got wrong) in nine places.

### Fusion happens in log-odds

Averaging 0.95 and 0.55 in probability space gives 0.75 and discards how strong
the first view was. Log-odds averaging respects the geometry and is invariant to
which outcome we happen to call "UP".

### The analytic model keeps a floor weight

The ensemble cannot be dragged away from fair value by a chorus of weak signals:
the `fair_value` anchor retains a minimum weight regardless of how many other
strategies speak.

### Uncertainty is first-class

Every probability carries an error bar, widened for poor data quality, an
unreliable volatility estimate, a difficult regime and disagreement with the
market. The trade gate requires the edge to clear `k × uncertainty`, so a wide
error bar cannot masquerade as an edge. Sizing uses a *lower confidence bound*
on the probability, not the point estimate — Kelly is notoriously sensitive to
over-estimated edge.

### Missing features are absent, not zero

A model must be able to distinguish "not observed" from "observed zero". The
feature engine omits a feature it cannot compute and drops `data_quality`
instead of filling in a plausible-looking number.

### The dashboard is a separate process

It reads an atomically-published snapshot and queries the database directly, so
nothing about rendering can block, slow or crash the trading loop.

### Live trading lives in one file

`execution/live.py` is the only module that can move real money, and it refuses
to construct unless four independent conditions hold. Order signing is delegated
to the official `py-clob-client`: a hand-rolled EIP-712 order signature risks
producing orders that are valid but wrong.

## Extending it

**A new reference exchange**: subclass `ExchangeFeed` with three members
(`url`, `subscribe_messages`, `parse`) and register it in `FEED_REGISTRY`. The
reconnect, heartbeat, staleness, dedup and health machinery is inherited.

**A new strategy**: subclass `Strategy`, implement `_evaluate` returning
`self.from_drift(...)` or `self.from_probability(...)`, register it in
`DEFAULT_STRATEGIES` and add it to `ENABLED_STRATEGIES`. The ensemble will
weight it by its realised skill automatically.

**A different database**: implement `Backend`'s three methods and add the URL
scheme to `Database._make_backend`. The DDL is plain SQL.

**A different resolution oracle**: set `RESOLUTION_ORACLE=chainlink` and supply
the stream credentials. This removes the proxy basis disadvantage entirely and
is the single highest-value improvement available.
