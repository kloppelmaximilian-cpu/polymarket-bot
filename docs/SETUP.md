# Setup

## Requirements

- Python 3.11 or newer
- Outbound HTTPS and WSS to `gamma-api.polymarket.com`,
  `clob.polymarket.com`, `ws-subscriptions-clob.polymarket.com` and your chosen
  reference exchanges
- Nothing else for paper mode. No credentials, no funded wallet.

## Get the code

```bash
git clone https://github.com/kloppelmaximilian-cpu/polymarket-bot.git
cd polymarket-bot
```

Every command below is run from inside that directory. `make` and
`./start_bot.sh` only exist there -- from your home directory you will get
`No rule to make target` and `no such file or directory`.

## Install

```bash
make install          # or: make install PYTHON=python3.12
```

Or by hand:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[all]"
```

Extras: `[ml]` adds LightGBM and XGBoost, `[live]` adds `py-clob-client` (needed
only for live order signing), `[dev]` adds pytest and ruff, `[all]` is all three.

### macOS

Two things bite here, both before any of our code runs.

**`python3` is 3.9.** macOS ships the Xcode command-line Python, which this
project does not support. Check with `python3 --version`; if it is below 3.11:

```bash
brew install python@3.12
make install PYTHON=python3.12
```

`make install` refuses to build the venv on too old an interpreter rather than
letting pip fail halfway through with a less obvious message.

**LightGBM needs OpenMP.** Its macOS wheels link against `libomp`, which
Apple's toolchain does not provide, so importing it raises a `dlopen` error
about `libomp.dylib`:

```bash
brew install libomp
```

If you would rather not, install without the ML extra -- the bot runs fine on
the analytic pricer and the nine signal strategies alone, and `bot doctor` will
simply report `lightgbm` and `xgboost` as missing:

```bash
pip install -e ".[live,dev]"
```

Verify:

```bash
bot doctor
```

It checks every dependency, that the database path is writable, whether a model
artifact exists, and whether the Polymarket APIs are actually reachable from
this host. If the APIs show `unreachable`, discovery will not work — check the
network path before anything else.

```bash
bot discover          # should list live 5-minute markets
```

## Configuration

Everything is read from the environment, optionally via a `.env` file:

```bash
cp .env.example .env
```

Nothing in it is required for paper mode; the defaults are deliberately
conservative. See [CONFIG.md](CONFIG.md) for every setting.

The three you are most likely to change first:

```bash
ASSETS=BTC,ETH,SOL          # which assets to hunt
BANKROLL=1000               # paper starting capital
MIN_EDGE=0.025              # the base edge bar, in probability
```

## Paper trading

```bash
./start_bot.sh              # or: bot start
./dashboard.sh              # in another terminal
```

The bot writes:

- `data/pmbot.db` — everything, for later analysis and model training
- `data/state.json` — the snapshot the dashboard reads
- `logs/pmbot.log` — rotating structured JSON logs

Leave it running. Every window it watches is recorded once per second, which is
what you will train and validate on later.

## Collecting data and training

```bash
# after a day or so of paper trading
bot session --hours 24 --out data/recorded.json
bot walkforward --session-file data/recorded.json
bot train --source database
```

`bot train` benchmarks every available model under purged walk-forward
cross-validation, picks the winner by a composite of accuracy, stability and
calibration, fits it, and writes it with a reproducibility manifest to
`models/ensemble_v1/`. The bot picks it up on next start.

See [BACKTESTING.md](BACKTESTING.md) for the full workflow.

## Live trading

**Read this section completely before arming it.**

Live trading requires four independent things. Each one fails closed and each
one is verified separately:

1. `TRADING_MODE=live`
2. `LIVE_CONFIRMATION=true`
3. `POLYMARKET_PRIVATE_KEY` — the key that signs orders
4. `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, `POLYMARKET_API_PASSPHRASE` —
   L2 credentials, derived from the key

Missing any of them and the live venue refuses to be constructed. Setting
`TRADING_MODE=live` without `LIVE_CONFIRMATION=true` fails at configuration
load, before any component starts.

### Deriving L2 credentials

```python
from py_clob_client.client import ClobClient
import os

client = ClobClient(
    "https://clob.polymarket.com",
    key=os.environ["POLYMARKET_PRIVATE_KEY"],
    chain_id=137,
)
creds = client.create_or_derive_api_creds()
print(creds.api_key, creds.api_secret, creds.api_passphrase)
```

Store them in `.env`. **They cannot be recovered if lost.**

### Wallet setup

- `POLYMARKET_SIGNATURE_TYPE`: `0` for an EOA, `1` for a Magic Link proxy, `2`
  for a Gnosis Safe proxy (the usual case for a polymarket.com account).
- `POLYMARKET_FUNDER`: the address that holds the USDC. For signature type 1 or
  2 this is the proxy wallet from polymarket.com settings, **not** your EOA.
- The funder must have approved the CTF Exchange for USDC.e before any buy
  order will fill.

### Before you arm it

```bash
DRY_RUN_LIVE=true bot start --mode live
```

In dry-run the bot builds and signs every order, runs every validation, logs
exactly what it *would* have sent, and returns without POSTing. Watch it for a
few hours. Check that the prices, sizes, tick sizes and neg-risk flags in the
logs are what you expect.

### Checklist

- [ ] `bot doctor` is clean and both APIs are reachable
- [ ] Paper mode has run long enough to collect several hundred resolved windows
- [ ] `bot walkforward` shows positive out-of-sample expectancy across slices
- [ ] `MARKET_ANCHOR_WEIGHT` has been fitted from your own data, not left at the
      default
- [ ] The Monte Carlo stress scenarios survive `slippage +1 tick` and
      `model 2pp overconfident`
- [ ] `MAX_STAKE_PER_TRADE`, `MAX_DAILY_LOSS` and `MAX_DRAWDOWN` are set to
      amounts you are willing to lose
- [ ] The funder address and signature type are correct
- [ ] USDC.e allowance is approved
- [ ] A dry-run session looked right
- [ ] You start at a fraction of the size you think is correct

Live mode logs a warning on startup and the dashboard header turns red. If it is
not red, you are not live.

### Stopping

`Ctrl-C`, or `kill -TERM <pid>` (`start_bot.sh` writes `data/bot.pid`). Shutdown
cancels every open order before exiting.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `bot discover` finds nothing | APIs unreachable, or the series slugs have changed. Check `bot doctor`, then `SERIES_SLUG_TEMPLATES`. |
| Dashboard says "not found" | The bot is not running, or `LOG_DIR` differs between the two processes. |
| `only N healthy reference feeds` | Fewer than `MIN_HEALTHY_EXCHANGES` connected. The bot is correctly refusing to trade on an unverifiable price. |
| `strike unknown` on every market | The bot started mid-window. It needs to be running when a window opens to snapshot the strike. Wait five minutes. |
| No trades at all | Expected at the default `MARKET_ANCHOR_WEIGHT`. Check `bot signals` for the blockers; each rejection is named. |
| `INVALID_ORDER_MIN_TICK_SIZE` | A `tick_size_change` was missed. The websocket handles these; if it persists, restart. |
| Live orders cancelled seconds after placement | The heartbeat is not reaching the venue. Miss it for ~10s and the venue cancels everything. Check connectivity. |
