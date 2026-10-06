# Polymarket API reference

Every endpoint, field name and signing scheme here was verified against the
official `py-clob-client` source and Polymarket's own published integration
documentation, not from memory or from older examples.

## Surfaces

| API | Base URL | Auth | Used for |
|---|---|---|---|
| Gamma | `https://gamma-api.polymarket.com` | none | market discovery, metadata |
| CLOB | `https://clob.polymarket.com` | L2 for trading | books, prices, orders |
| Data | `https://data-api.polymarket.com` | none | trades, positions |
| Market WSS | `wss://ws-subscriptions-clob.polymarket.com/ws/market` | none | live books |
| User WSS | `wss://ws-subscriptions-clob.polymarket.com/ws/user` | creds in message | order/trade updates |

Chain: Polygon, id `137`. Collateral: USDC.e
`0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`. CTF Exchange
`0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`; Neg-Risk CTF Exchange
`0xC5d563A36AE78145C45a50134d48A1215220f80a`.

## Discovery

The 5-minute crypto markets are **not** reliably returned by
`/markets?active=true` — they carry a hide-from-new tag. Discovery goes through
the recurring **series**:

```
GET /events?series_slug=btc-up-or-down-5m&closed=false
           &limit=500&order=endDate&ascending=true
```

Polymarket pre-lists roughly 24 hours of future windows, all with
`active=true`, `closed=false`, `enableOrderBook=true` and
`acceptingOrders=true` long before their window opens. "The live market" is the
one with `eventStartTime <= now < endDate`.

A second, slower sweep of `/events?active=true&closed=false` keeps markets whose
`series` entry has a 5-minute `recurrence`, which discovers assets nobody
configured.

### Fields that matter

| Field | Note |
|---|---|
| `conditionId` | identifies the market |
| `clobTokenIds` | **stringified JSON** array, `[Up, Down]` |
| `outcomes` | **stringified JSON**, `["Up", "Down"]` |
| `eventStartTime` / `endDate` | ISO-8601 **UTC**; the authoritative window |
| `orderPriceMinTickSize` | 0.01 for these markets |
| `orderMinSize` | 5 (shares, not dollars) |
| `feeSchedule` | `{rate: 0.07, takerOnly: true, ...}` |
| `takerBaseFee` / `makerBaseFee` | **legacy, do not use** — see below |
| `resolutionSource` | the oracle these settle against |
| `negRisk` | false for these markets |

Three traps, all handled and all tested:

1. **The title is in US Eastern time** while every machine field is UTC.
   Parsing the title puts every window hours out. The parser ignores it.
2. **`takerBaseFee: 1000`** looks like 10% in basis points but is *not* what is
   charged when a `feeSchedule` is present. Coding against it overstates fees
   by 5×.
3. **`outcomes` and `clobTokenIds` are strings**, not arrays.

## Fees

```
fee = shares × rate × p × (1 − p)
```

`rate = 0.07` for crypto, takers only; makers pay zero and share a rebate pool.
At 50c that is $1.75 per 100 shares — **1.75 probability points per share** —
and it vanishes toward the extremes. This is the single most important number in
the system.

The rebate is modelled as zero: it is a pro-rata share of a daily pool and
cannot be relied on per trade.

## CLOB endpoints used

Read (no auth):

| Path | Purpose |
|---|---|
| `GET /book?token_id=` | full L2 book |
| `POST /books` | batch books, up to 500 tokens |
| `GET /midpoint`, `/price`, `/spread` | derived prices |
| `GET /tick-size?token_id=` | `{"minimum_tick_size": 0.01}` |
| `GET /neg-risk?token_id=` | which exchange contract applies |
| `GET /fee-rate?token_id=` | `{"base_fee": ...}` |
| `GET /prices-history` | historical mids, for backtesting |
| `GET /time` | server clock, for drift checks |

Authenticated (L2):

| Path | Purpose |
|---|---|
| `POST /order` | place |
| `DELETE /order`, `/orders`, `/cancel-all`, `/cancel-market-orders` | cancel |
| `GET /data/orders`, `/data/trades` | reconciliation |
| `POST /v1/heartbeats` | keep resting orders alive |

**The heartbeat is not optional.** Miss it for ~10 seconds and the venue cancels
every one of your open orders. The live venue runs it on a 5-second timer
whenever anything is resting.

### Book ordering

`/book` returns **bids ascending and asks descending**. The parser normalises to
bids descending / asks ascending so `[0]` is always the touch. Getting this
backwards silently reads the worst level as best — there is a test for it.

## Authentication

**L1** — EIP-712 over the `ClobAuth` struct (domain `ClobAuthDomain`, version
`1`), used only to derive API credentials. Delegated to `py-clob-client`.

**L2** — HMAC-SHA256 over `timestamp + method + path + body`, keyed on the
base64url-*decoded* API secret, result base64url-encoded. Implemented natively
in `polymarket/auth.py`; a test asserts byte-for-byte agreement with the
official client across GET, POST and DELETE. The body must be the exact bytes
sent, which is why the client serialises once and signs that string.

Headers: `POLY_ADDRESS`, `POLY_SIGNATURE`, `POLY_TIMESTAMP`, `POLY_API_KEY`,
`POLY_PASSPHRASE`.

## Order types

| Type | Behaviour | Used for |
|---|---|---|
| `GTC` | rests until filled or cancelled | maker orders |
| `GTD` | expires at a timestamp (minimum `now + 60 + N`) | not used |
| `FOK` | fill entirely or cancel | not used |
| `FAK` | fill what is available, cancel the rest | taker orders |

For `FOK`/`FAK`, a BUY `amount` is **dollars** and a SELL `amount` is **shares**.
`price` is the worst-price limit, not a target.

Post-only (`GTC`/`GTD` only) guarantees maker status and is *rejected* rather
than executed if it would cross — which is exactly the behaviour a maker-first
executor wants.

### Rounding

Tick sizes are `0.1`, `0.01`, `0.001`, `0.0001` and prices must be exact
multiples or the order is rejected. Amounts are 6-decimal USDC integers. All of
this is delegated to `py-clob-client`'s order builder; the per-tick-size
rounding configuration is not something to reimplement.

## Market websocket

Subscribe:

```json
{"assets_ids": ["..."], "type": "market", "custom_feature_enabled": true}
```

Modify in place without reconnecting:

```json
{"assets_ids": ["..."], "operation": "subscribe", "custom_feature_enabled": true}
{"assets_ids": ["..."], "operation": "unsubscribe"}
```

This matters here: markets roll over every five minutes, and reconnecting each
time would be a reconnect storm.

Send the literal text `PING` every 10 seconds or the connection drops.

| Event | Contents |
|---|---|
| `book` | full snapshot; sent on subscribe and after trades |
| `price_change` | `price_changes[]`; `size: "0"` means the level was removed |
| `last_trade_price` | executed trade |
| `tick_size_change` | **must be honoured** — quoting against a stale tick gets orders rejected |
| `best_bid_ask` | top-of-book (needs `custom_feature_enabled`) |
| `new_market`, `market_resolved` | lifecycle (needs `custom_feature_enabled`) |

A delta arriving before the first snapshot is **dropped**, not applied: applying
it to an empty book would fabricate a one-sided book.

## Resolution

The crypto series settles on the data stream named in each market's own
`resolutionSource` — a Chainlink price stream, not an exchange spot price:

> resolves to "Up" if the price at the end of the range is **greater than or
> equal to** the price at the beginning. Otherwise "Down".

So **ties resolve UP**, and the strike is the oracle price at `window_start`.

Source hierarchy, strictly ordered:

1. `market_resolved` from the websocket — authoritative
2. Gamma reporting `closed` with a decided `outcomePrices` — authoritative
3. Local computation from the CEX composite — **provisional**

Provisional resolutions are labelled, used for paper settlement so learning does
not stall, and reconciled when the authoritative answer arrives. The
disagreement rate is tracked and shown on the dashboard — it is the best
empirical measure of how much basis risk the proxy carries.

Gamma's `closed` flag lags `endDate` by 60–120 seconds, and the book stays open
briefly after `endDate` as winners trade toward $1.

## Rate limits and error handling

Requests go through a token bucket (Gamma 6/s, CLOB 10/s) with bounded jittered
retries. 5xx, 429, 408 and timeouts are retried; 4xx is terminal.

| Error | Meaning |
|---|---|
| `INVALID_ORDER_MIN_TICK_SIZE` | price off the tick grid |
| `INVALID_ORDER_MIN_SIZE` | below the venue minimum |
| `INVALID_ORDER_DUPLICATED` | identical order already placed |
| `INVALID_ORDER_NOT_ENOUGH_BALANCE` | funder balance or allowance |
| `INVALID_POST_ONLY_ORDER` | post-only would have crossed |
| `FOK_ORDER_NOT_FILLED_ERROR` | could not fill in full |
| `MARKET_NOT_READY` | not accepting orders yet |

Insert statuses: `matched`, `live`, `delayed`, `unmatched`. Trade lifecycle:
`MATCHED → MINED → CONFIRMED`, with `RETRYING` and terminal `FAILED`.
