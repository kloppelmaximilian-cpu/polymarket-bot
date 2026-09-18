# Dashboard

Two front-ends over the same data: a terminal UI and a local web page.

```bash
./dashboard.sh          # terminal, or: bot dashboard
./web.sh                # browser at http://127.0.0.1:8787
```

```bash
bot dashboard --simple  # Rich fallback, works over a pipe or a dumb terminal
bot dashboard --once    # one frame and exit (CI, logs, screenshots)
bot web --port 9000 --no-open --interval 2
```

The dashboard is a **separate process**. It reads the atomically-published
snapshot at `data/state.json` and queries the database directly, so nothing
about rendering can block, slow or crash the trading loop. If the snapshot is
missing or stale it says so rather than showing plausible-looking stale numbers.

Two front-ends over identical renderers: a Textual TUI by default, and a
single-screen Rich version with `--simple`. The fallback is not an afterthought
— a dashboard that only works in a modern terminal is unavailable exactly when
something has gone wrong on a remote box.

## The web page

`bot web` (or `./web.sh`) serves the same panels as a page in your browser and
opens it for you. Like the TUI it is a **separate process** reading the same
published snapshot, so a browser tab left open overnight cannot slow the
trading loop.

| | |
|---|---|
| default address | `http://127.0.0.1:8787` |
| refresh | polls `/api/state` once a second (`--interval`) |
| endpoints | `/` the page, `/api/state` the snapshot plus warnings, `/healthz` |
| dependencies | none — the standard library's HTTP server and one HTML file |

It fetches **nothing from the internet**: no CDN, no web fonts, no analytics.
A trading tool should not load code at runtime from anywhere but itself, and
the page works with the machine offline.

### It is not an open endpoint

The payload is a live account statement — positions, balances, P&L — so:

- It binds to **loopback only**. `--host` accepts something else and logs a
  warning saying what you just exposed.
- Requests carrying a foreign `Host` header are refused with 403. A page on
  the public internet can otherwise point a hostname it controls at
  `127.0.0.1` and read this dashboard through your own browser (DNS
  rebinding).
- No `Access-Control-Allow-Origin`, so another site's JavaScript cannot read
  the response either.

It is read-only: there is no route that places, cancels or configures
anything. To act on what you see, use the CLI.

### Staleness

The header shows the snapshot age, and turns red and pulses once it passes
eight seconds. This is the one thing the page will never hide: a frozen
dashboard that looks live is worse than no dashboard. If the bot is not
running you get *"no snapshot published yet"*, not an empty page that reads
like a flat day.

Dark by default, light if your system asks for it, and the `theme` button
overrides both (remembered per browser).

## Keys

| Key | Action |
|---|---|
| `q` | quit |
| `r` | force refresh |
| `e` | sort markets by edge (default) |
| `c` | sort by confidence |
| `a` | sort by asset |
| `t` | sort by time remaining |
| `l` | sort by liquidity |
| `s` | sort by signal strength |
| `p` | freeze the display (the bot keeps trading) |
| tab / arrows | switch tabs |

## Header

Mode (`PAPER` in cyan, `LIVE` in **red**, `LIVE (DRY RUN)` in yellow), running
or paused, uptime, health level and score, markets tracked, loop cycles and
average cycle time, orders attempted versus filled, and the snapshot age.

**If the header is not red, you are not live.**

## Account / risk

Balance, equity, available capital, open exposure, realised and unrealised P&L,
today, session, trades, win rate, trades per hour, expectancy, max drawdown,
open positions, consecutive losses, fees paid.

Open exposure includes resting orders, not just filled positions.

## Markets tab

One row per monitored market: asset, time remaining, YES and NO asks, bid, ask,
spread, liquidity, the composite spot, the strike, distance from strike in basis
points, model probability, market probability, net edge, the **required** edge
for this market right now, confidence, regime and decision.

Showing the required edge next to the actual edge is the point: it makes visible
*why* a market with a 2-point edge is not being traded.

Decisions are colour-coded: `HIGH_CONFIDENCE_TRADE` bold green, `TRADE` green,
`WATCH` yellow, `WEAK_SIGNAL` dim yellow, `NO_TRADE` dim.

## Signals tab

The best current opportunities with full reasoning, and the open positions
beside them.

Each signal shows the model and market probabilities, the net edge, confidence,
time remaining, and the decision — then the **economics broken out**:

```
gross +0.1430 - fee 0.0175 - slip 0.0000 = net +0.0295   size 38.4 sh ($19.97)
drivers: fair_value=0.66@0.82  order_flow=0.71@0.64  momentum=0.69@0.58
```

and, when the trade was rejected, the named blockers.

That layout answers "why this trade?" and "why not that one?" without opening a
log file.

## Trades tab

Recent closed trades — time, asset, side, entry, exit, result, P&L, edge at
entry, confidence, strategy — above per-strategy performance: signals produced,
Brier skill, EWMA Brier, trades, win rate, P&L, expectancy, average edge and
max drawdown.

Brier skill and P&L side by side is deliberate. A strategy can have positive
skill and negative P&L (its good calls are on trades that were not taken, or its
edges are systematically overstated), and that combination is worth noticing.

## Health tab

Per feed: status (`ONLINE` green, `DEGRADED` yellow, `OFFLINE` red), latency,
messages per second, reconnects, errors, clock drift, health score and detail.

Per asset: the composite price, how many venues contributed, cross-venue
dispersion in basis points, the estimated 5-minute volatility, and whether the
composite is trusted.

Then two lines that are easy to miss and worth reading:

- **proxy-versus-venue resolution agreement** — how often the local proxy
  resolution matched the authoritative one. This is the empirical measure of
  basis risk.
- **execution summary** — filled versus submitted, maker versus taker split,
  average slippage, duplicates blocked.

A high maker share is the intended state: makers pay no fee.

## Alerts

Warnings the operator should act on, deduplicated and capped: stale or offline
feeds, API errors, order failures, wide spreads, thin books, high drawdown, a
risk stop, a model anomaly, and any size reduction the self-monitor has applied.

A green "no alerts" is the normal state.

## Reading it

**Healthy and quiet.** Feeds `ONLINE`, composites healthy, markets tracked, and
most decisions `NO_TRADE` with `net edge < required`. This is what the default
configuration does most of the time, and it is correct — the edge bar is set so
that only trades which survive fees and uncertainty get through.

**Something is wrong.** Feeds degraded, `size reduced to 50%`, or a red
`PAUSED`. Check the Health tab first; the pause reason is always named.

**Working.** Positions open with positive expected value, a high maker fill
share, low average slippage, and positive per-strategy Brier skill. Watch the
skill numbers long before the P&L ones: a hundred five-minute trades says almost
nothing about money, but a hundred forecasts says something about calibration.
