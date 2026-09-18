# Runbook

## Starting and stopping

```bash
./start_bot.sh            # paper mode, writes data/bot.pid
./start_bot.sh --live     # requires LIVE_CONFIRMATION=true in the environment
kill -TERM $(cat data/bot.pid)
```

Shutdown is clean: it cancels every open order, saves the adaptive strategy
weights, flushes the database and closes connections. Killing with `-9` skips
all of that and can leave live orders resting — don't.

Restart is safe. Positions are reloaded from the database and open orders are
reconciled against the venue on the first poll. The bot does need to be running
when a window *opens* to snapshot the strike, so expect the first five minutes
after a restart to show `strike unknown` and no trades.

## Daily checks

```bash
bot status        # mode, health, equity, drawdown, pause state
bot feeds         # every feed ONLINE? dispersion sane?
bot strategies    # any strategy with persistently negative skill?
bot risk          # how close to each limit?
```

On the dashboard Health tab, the two numbers worth reading every day are the
**proxy-versus-venue resolution agreement** (basis risk) and the **maker fill
share** (execution quality — higher is better, makers pay no fee).

## Alarms

### `only N healthy reference feeds (need M)` — trading paused

The composite price cannot be verified, so the bot refuses to trade on it.
Correct behaviour, not a bug.

Check network egress to the exchange websocket hosts. `bot feeds` shows which
ones are down and their reconnect counts. The feeds reconnect automatically with
exponential backoff; if one venue is permanently blocked in your region, drop it
from `EXCHANGES` and lower `MIN_HEALTHY_EXCHANGES` — but never below 2, because
with one source there is nothing to cross-check against.

### `Polymarket websocket offline` — trading paused

No book data means no trading. It reconnects automatically. If it persists,
check egress to `ws-subscriptions-clob.polymarket.com` and confirm
`WS_PING_INTERVAL` is 10 (the venue drops connections that do not PING).

### `composite price unhealthy` / `cross-exchange divergence N bps`

Venues disagree by more than `FEED_DIVERGENCE_BPS`. Usually one venue is lagging
or has a bad print; the MAD filter excludes outliers, and if the spread is still
wide the composite is marked untrusted and the regime becomes `DIVERGENT`
(leaving only the analytic anchor). During a genuine fast move this is expected
and transient.

### `model degradation: Brier skill -0.0x over N outcomes` — trading paused

The most important alarm. The model has stopped predicting. Mechanically
everything is fine, which is why this check exists separately.

1. Do not just restart. Restarting clears the rolling window and hides it.
2. `bot strategies` — is it one strategy or all of them?
3. If one, remove it from `ENABLED_STRATEGIES`.
4. If all, the market has changed or a model artifact is stale. Move the
   artifact aside so the bot falls back to analytic-only, collect fresh data,
   and re-run `bot train` and `bot walkforward`.

### `daily loss limit` / `session loss limit` / `consecutive losses` / `drawdown`

A latching stop fired. Trading pauses for `RISK_PAUSE_SECONDS`.

Do not raise the limit to keep trading. Look at the trades:

```bash
bot trades --limit 20
bot audit <market-id>        # the full decision record for one of them
```

`bot audit` prints everything: model and market probabilities, the analytic and
ML components, the edge decomposition, every strategy's vote and reason, the
book state, the risk state at the time, and the fill. If the losses came with
high claimed edges and low realised win rates, the model is overconfident —
`MARKET_ANCHOR_WEIGHT` is too high, or the calibrator needs refitting.

### `N execution failures in 5 minutes`

Order rejections or timeouts. Check the `orders` table for the `error` column:

```sql
SELECT ts, state, error, price, size FROM orders
WHERE error IS NOT NULL ORDER BY ts DESC LIMIT 20;
```

`INVALID_ORDER_MIN_TICK_SIZE` after a `tick_size_change` suggests a missed
websocket event — restart. `NOT_ENOUGH_BALANCE` in live mode means the funder
balance or USDC.e allowance is wrong.

### `wide spread` / `thin book`

Informational. The gate is already refusing those markets. Persistently thin
books across all markets usually means an unusually quiet period.

### Live orders cancelled seconds after placement

The heartbeat is not reaching the venue. Miss it for ~10 seconds and **all**
open orders are cancelled. Check connectivity and latency to
`clob.polymarket.com`.

## Common situations

### No trades for hours

Usually correct. Check `bot signals` — every rejection is named. The most common
reasons, in order:

1. `net edge < required` — no edge. The expected state.
2. `edge inside uncertainty band` — the edge exists but is smaller than the
   model's own error bar.
3. `liquidity` / `not enough size inside slippage budget` — books too thin.
4. `implausibly large` — the edge was rejected as model error. If you see this
   repeatedly, something is wrong with the inputs; check the strike quality and
   feed health before touching `MAX_PLAUSIBLE_EDGE`.

If you want more trades, the honest route is to fit `MARKET_ANCHOR_WEIGHT` from
your own data and show out-of-sample evidence, not to lower `MIN_EDGE`.

### `strike unknown` on every market

The bot started mid-window. It needs to be running when a window opens. Wait
five minutes.

**If it persists for hours, it is not that.** The strike is the composite
price at the moment a window opens, and it is only recorded when the composite
is healthy at that instant. Feeds that keep dropping mean no window ever opens
under a healthy composite, so `DIST` stays `—` for ever, `fair_value` abstains
permanently and every model probability collapses towards the market's. Fix
the feeds first — `bot feeds`, then the log:

```bash
grep '"event": "connection failed"' logs/pmbot.log | tail -20
grep 'socket open but silent' logs/pmbot.log | tail
```

### Feeds go offline and never come back

Look at what the log says, because two very different faults look identical on
the dashboard.

`keepalive ping timeout` or `no close frame received` on **several venues
within seconds of each other** is your machine, not the venues. A laptop that
sleeps, or Wi-Fi reconnecting, drops every socket at once. The bot reconnects
on its own; if it happens nightly, stop the laptop sleeping:

```bash
caffeinate -i ./start_bot.sh
```

`socket open but silent, forcing reconnect` means the socket stayed open and
stopped delivering — a dropped subscription, or a venue that went quiet after
a network hiccup. The watchdog closes it so the reconnect path can run. Seeing
it occasionally is the system working; seeing it constantly on one venue means
that venue's subscription payload needs looking at.

### Database growing quickly

Roughly 1 row per market per second across several tables. Prune old rows:

```sql
DELETE FROM features WHERE ts < strftime('%s','now') - 7*86400;
DELETE FROM book_snapshots WHERE ts < strftime('%s','now') - 7*86400;
VACUUM;
```

Keep `markets`, `positions`, `orders`, `fills` and `audit_events` — they are
small and they are the audit trail. Or set `RECORD_TRAINING_DATA=false`, at the
cost of having nothing to train on.

### Disk full

Writes fail but deletes still succeed. Delete old `features` and
`book_snapshots` rows, then `VACUUM`. Log files rotate at 32 MB with 5 backups.

## Investigating a single trade

```bash
bot audit <market-id>
```

Or from the database:

```sql
SELECT ts, kind, payload FROM audit_events WHERE market_id = ? ORDER BY ts;

SELECT ts, probability_up, confidence, uncertainty, regime, implied_up
FROM predictions WHERE market_id = ? ORDER BY ts;

SELECT ts, strategy, probability_up, confidence, abstain, reason
FROM signals WHERE market_id = ? ORDER BY ts;

SELECT ts, decision, net_edge, required_edge, blockers
FROM opportunities WHERE market_id = ? ORDER BY ts;
```

Between them: what every strategy said, what the fused probability was, what the
market said, what the edge was after costs, what the required bar was, what
blocked it if anything, and what the fill actually was.

## Weekly maintenance

```bash
bot session --hours 168 --out data/week.json
bot walkforward --session-file data/week.json --slices 5
bot train --source database
```

Then compare the new model's held-out metrics against the deployed one's
manifest (`models/ensemble_v1/manifest.json`). **Only promote a model that beats
the incumbent out of sample on both Brier skill and calibration.** A better
in-sample fit is not a reason.

Also re-fit the anchor weight — if the model has genuinely improved, it deserves
more weight against the market, and that is a measurable quantity rather than a
judgement call.

## Emergency

```bash
kill -TERM $(cat data/bot.pid)      # clean stop, cancels orders
```

If it does not respond and you are live, cancel from the Polymarket web
interface, then `kill -9`. Orders can also be cancelled directly on the
`CTFExchange` contract if the API is unreachable.

To stop trading but keep collecting data, set `MIN_EDGE=1.0` and restart.
Nothing will ever clear that bar, and every window is still recorded.
