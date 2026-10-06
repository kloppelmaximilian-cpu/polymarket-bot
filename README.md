# Automated Opportunity Center

Eine zentrale Plattform, die automatisierbare Geschäftsmodelle, Bots und
Trading-Strategien **entdeckt, recherchiert, entwirft, baut, simuliert,
backtestet, paper-testet, bewertet, rankt, verbessert und – nur zur manuellen
Prüfung – „graduiert“**.

```
DISCOVER → RESEARCH → DESIGN → BUILD → SIMULATE → BACKTEST → PAPER TEST → EVALUATE → RANK → IMPROVE → GRADUATE
```

> **PAPER = DEFAULT. LIVE = DISABLED.**
> Kein echtes Geld, keine echten Käufe, keine echten Trades, keine echten
> Auszahlungen. Diese Version enthält **keinen Live-Executor**; Live-Trading
> lässt sich auch per Konfiguration nicht einschalten. Kein Ergebnis in dieser
> Plattform ist eine Gewinngarantie.

---

## Inhalt

1. [Was die Plattform tut](#was-die-plattform-tut)
2. [Voraussetzungen](#voraussetzungen)
3. [Installation](#installation)
4. [Umgebungsvariablen](#umgebungsvariablen)
5. [Datenbank starten](#datenbank-starten)
6. [App starten](#app-starten)
7. [Paper Mode](#paper-mode)
8. [Dashboard öffnen](#dashboard-öffnen)
9. [Tests ausführen](#tests-ausführen)
10. [Betrieb mit Docker Compose](#betrieb-mit-docker-compose)
11. [Operator-CLI](#operator-cli)
12. [Architektur](#architektur)
13. [Startexperimente](#startexperimente)
14. [Datenherkunft und Ehrlichkeitsregeln](#datenherkunft-und-ehrlichkeitsregeln)
15. [Sicherheit](#sicherheit)
16. [Bekannte Grenzen](#bekannte-grenzen)
17. [Fehlersuche](#fehlersuche)

Weitere Dokumente: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
[`docs/API.md`](docs/API.md) · [`docs/SCORING.md`](docs/SCORING.md) ·
[`docs/SECURITY.md`](docs/SECURITY.md) · [`docs/RUNBOOK.md`](docs/RUNBOOK.md) ·
[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) (Analyse, Plan, Entscheidungslog).

---

## Was die Plattform tut

* **Ideen finden:** Ideengenerator (eingebauter Katalog oder optional Claude
  mit strukturierter Ausgabe) und Research-Monitor (GitHub, arXiv, Hacker News).
  Jede Idee und Quelle wird mit Herkunft, Lizenz und ToS-Hinweisen gespeichert;
  fremder Code wird nie kopiert.
* **Experimente** mit Hypothese, Annahmen, Parametern, Risikolimits,
  Compliance-Review und **unveränderlichen Versionen** (v1, v1.1, v2 …).
* **Automatische Pipeline:** RESEARCHING → PROTOTYPE → BACKTESTING →
  EVALUATING → PAPER → PROMISING / PROBATION / FAILED →
  READY_FOR_LIVE_REVIEW (nur manuelle Prüfung).
* **Backtests ohne Look-ahead** (Ausführung zur nächsten Kerze), Train/Test,
  Out-of-Sample, Walk-Forward, Monte Carlo, Kosten- und
  Parametersensitivität, Deflated Sharpe Ratio.
* **Business-Modelle** als Monte-Carlo-Schätzung über Annahmen-Bandbreiten
  und als tägliche Betriebssimulation im Paper-Ledger.
* **Paper-Engine** mit Cash, Equity, realisiertem/unrealisiertem P&L,
  Gebühren, Slippage, Funding, Positionen, Orders, Fills und einem
  unveränderlichen Transaktions-Ledger.
* **Zentrale Risk-Engine** (Max Capital, Daily Loss, Drawdown, Exposure,
  Positions, Orders, API Spend, Experiment Spend) und **EMERGENCY STOP**.
* **Opportunity Score 0–100** mit Teil-Scores, Risikomultiplikator und
  Evidenz-Deckeln – hoher Gewinn bei extremem Risiko rankt nicht automatisch höher.
* **Dashboard** (Next.js, Dark Mode) mit allen Seiten aus der Anforderung.

## Voraussetzungen

| Werkzeug | Version | Hinweis |
| --- | --- | --- |
| Node.js | ≥ 22.12 | getestet mit 22.22 |
| pnpm | 10.x | `corepack enable` aktiviert die im Repo festgelegte Version |
| PostgreSQL | 16 | per Docker Compose – **oder** ohne Postgres im Embedded-Modus (PGlite) |
| Docker (optional) | aktuell, mit Compose v2 | für Postgres bzw. den kompletten Stack |

## Installation

```bash
git clone <repo> && cd polymarket-bot
corepack enable

# Variante A – mit PostgreSQL (empfohlen)
docker compose up -d postgres
pnpm run setup                # .env anlegen (mit zufälligem API_TOKEN), Abhängigkeiten, Migration, Seed

# Variante B – ohne Docker, eingebettete Datenbank in .data/pglite
pnpm run setup --embedded
```

`pnpm run setup` prüft Node/pnpm, legt `.env` aus `.env.example` an (bestehende
`.env` wird nie überschrieben), installiert Abhängigkeiten, migriert die
Datenbank und legt Startexperimente, Ideen und Research-Quellen an
(idempotent; `--no-seed` überspringt das).

## Umgebungsvariablen

Alle Variablen stehen kommentiert in [`.env.example`](.env.example). Die
wichtigsten:

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://aoc:aoc@127.0.0.1:5432/aoc` | `postgres://…`, `pglite://<verzeichnis>` (embedded) oder `memory://` (Tests) |
| `API_HOST` / `API_PORT` | `127.0.0.1` / `4000` | API nur lokal erreichbar |
| `API_TOKEN` | – | Bearer-Token der API (≥ 16 Zeichen, in Produktion ≥ 24 Pflicht). Das Dashboard sendet ihn serverseitig |
| `API_URL` | `http://127.0.0.1:4000` | wo das Dashboard die API erreicht |
| `WEB_BASIC_AUTH_USER` / `_PASSWORD` | – | optionale Basic-Auth vor dem Dashboard |
| `TRADING_MODE` | `paper` | `live` wird erkannt, bleibt aber deaktiviert |
| `LIVE_TRADING_ENABLED`, `LIVE_CONFIRMATION`, `LIVE_CAPITAL_CAP_USD` | aus | Teile des Live-Gates; auch vollständig gesetzt bleibt Live gesperrt |
| `PAPER_TOTAL_CAPITAL_USD` | `10000` | virtueller Trading-Fonds |
| `PAPER_DEFAULT_ALLOCATION_USD` | `1000` | Zuteilung pro Trading-Experiment |
| `BUSINESS_SIM_BUDGET_USD` | `20000` | separater Topf für simulierte Geschäftsbetriebe |
| `PAPER_TICK_SECONDS` | `60` | Takt des Paper-Tradings |
| `BUSINESS_PAPER_DAYS_PER_TICK` | `1` | simulierte Geschäftstage pro Tick |
| `MARKET_DATA_ENABLED` / `MARKET_DATA_WEBSOCKETS` | `true` | öffentliche Marktdaten (Binance, Coinbase, Kraken, Polymarket); ohne Daten wird nichts gehandelt |
| `DATA_STALE_AFTER_MS` | `120000` | ältere Daten gelten als STALE |
| `RESEARCH_MONITOR_ENABLED` | `true` | GitHub/arXiv/Hacker-News-Monitor |
| `ANTHROPIC_API_KEY` + `IDEA_GENERATOR_LLM_ENABLED=true` | aus | Ideengenerator mit Claude (`LLM_MODEL`, Standard `claude-opus-5-5`) |
| `GITHUB_TOKEN` | – | höheres Rate-Limit für die GitHub-Suche |
| `WORKER_CONCURRENCY`, `WORKER_POLL_MS`, `JOB_LEASE_MS` | 2 / 1000 / 300000 | Job-Worker |
| `EMBEDDED_WORKER` | `false` | Worker im API-Prozess (bei `pglite://` automatisch) |
| `SEED_ON_START` | `false` | Startexperimente beim Worker-Start anlegen (idempotent) |
| `NOTIFY_WEBHOOK_URL` / `NOTIFY_WEBHOOK_FORMAT` | – / `generic` | Benachrichtigungen an Slack/Discord/generischen Webhook |

**Secrets** (`API_TOKEN`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, Webhook-URL,
Datenbank-Passwort) gehören nur in `.env` – diese Datei ist in `.gitignore`
und `.dockerignore` ausgeschlossen. Logs und die Settings-Seite zeigen sie nie an.

## Datenbank starten

```bash
docker compose up -d postgres     # PostgreSQL 16 auf 127.0.0.1:5432 (Volume: pgdata)
pnpm db:migrate                   # Migrationen (laufen auch beim Start von API/Worker, mit Advisory-Lock)
pnpm db:seed                      # Startexperimente (idempotent)
```

Ohne Docker: `DATABASE_URL=pglite://.data/pglite` (eingebettetes Postgres als
WebAssembly). PGlite erlaubt nur einen Prozess – der Worker läuft dann im API-Prozess.

## App starten

```bash
pnpm dev             # API (:4000) + Worker + Dashboard (:3000) gegen PostgreSQL
pnpm dev:embedded    # API mit eingebautem Worker + Dashboard, ohne Docker
pnpm dev:api | dev:worker | dev:web   # einzeln
```

Produktion (ohne Docker): `pnpm build`, dann `node apps/api/dist/main.js`,
`node apps/worker/dist/main.js` und `pnpm --filter @aoc/web start`.

## Paper Mode

Paper Mode ist **immer aktiv** – es gibt keinen anderen Modus. Nach dem Start
arbeitet der Worker selbstständig:

1. **Pipeline (jede Minute):** Startexperimente durchlaufen Research →
   Prototype → Backtest-Suite → Quality Gates.
2. **Paper-Ticks (`PAPER_TICK_SECONDS`):** Experimente in `PAPER`,
   `PROBATION`, `PROMISING` handeln virtuelles Geld auf Live-Daten; Business-
   Modelle simulieren Betriebstage. Jeder Tick schreibt Ledger und Equity-Snapshot.
3. **Risk-Monitor (jede Minute):** Limit-Verletzungen pausieren das Experiment.
4. **Review alle 6 h:** PROMISING / PROBATION / FAILED / READY_FOR_LIVE_REVIEW.
5. **Scores (alle 5 min), Ideen (täglich), Strategy Lab (täglich), Research-Monitor (12 h).**

Experimente in `DISCOVERED` startet ein Mensch (Dashboard → Experiment →
„Start research“). Alles lässt sich auch sofort auslösen:
`pnpm aoc advance`, `pnpm aoc job paper.tick`.

## Dashboard öffnen

* Dashboard: <http://localhost:3000>
* API-Dokumentation (OpenAPI/Swagger): <http://127.0.0.1:4000/docs>
* Health: <http://127.0.0.1:4000/health>, Prometheus-Metriken: `/metrics`

Seiten: Dashboard, Opportunities, Experiments (+ Detail), Strategies, Compare,
Research & Ideas, Paper Portfolio (+ Konto-Ledger), Performance, Risk, Logs,
System, Settings. Der **EMERGENCY-STOP**-Knopf ist auf jeder Seite oben rechts.

## Tests ausführen

```bash
pnpm test                 # alle Vitest-Projekte (unit + db + integration)
pnpm test:unit            # reine Logik, keine Datenbank
pnpm test:db              # Migrationen, Trigger, Constraints (PGlite)
pnpm test:integration     # Pipeline, API, Worker (PGlite)
pnpm test:coverage
pnpm typecheck            # TypeScript in allen Paketen

# dieselben DB-/Integrationstests gegen echtes PostgreSQL (eigene Wegwerf-DB pro Testdatei):
TEST_DATABASE_URL=postgres://aoc:aoc@127.0.0.1:5432/postgres pnpm test:db
TEST_DATABASE_URL=postgres://aoc:aoc@127.0.0.1:5432/postgres pnpm test:integration

# Browser-Smoke-Tests gegen ein laufendes Dashboard
WEB_URL=http://localhost:3000 pnpm test:e2e
# (PLAYWRIGHT_CHROMIUM_PATH=/pfad/zu/chromium, falls der Playwright-Browser nicht installiert werden kann)

# der bestehende Python-Bot
cd services/pmbot && python -m pytest
```

Abgedeckt: Paper-Engine (inkl. randomisierter Invarianten), Risk-Engine,
Backtester (Kausalität/kein Look-ahead, Negativkontrolle auf Random Walks),
Strategien, Business-Modelle, Scoring, Lifecycle & Gates, Connectoren (gegen
dokumentierte Formate), Job-Queue, Plattform end-to-end, API, Worker,
Dashboard (Playwright).

## Betrieb mit Docker Compose

```bash
cp .env.example .env       # API_TOKEN setzen (oder pnpm run setup)
docker compose up -d --build
docker compose exec worker node dist/cli.js doctor
```

Dienste: `postgres`, `api` (migriert beim Start), `worker` (legt Startexperimente
an, `SEED_ON_START=true`), `web`. Alle Ports sind an `127.0.0.1` gebunden.
Hinter einem TLS-abfangenden Firmen-Proxy: `docker build --secret id=ca,src=ca.pem
--build-arg HTTPS_PROXY=… .` (siehe `Dockerfile`).

## Operator-CLI

```bash
pnpm aoc help
pnpm aoc doctor                         # Konfiguration, DB, Worker, Datenquellen, Live-Gate
pnpm aoc status                         # Dashboard-Zusammenfassung im Terminal
pnpm aoc experiments --status PAPER
pnpm aoc advance [experimentId]         # nächster Pipeline-Schritt
pnpm aoc job paper.tick                 # einen Job sofort ausführen
pnpm aoc probe                          # Marktdatenquellen prüfen
pnpm aoc emergency-stop --reason "…"
pnpm aoc release --reason "…" [--resume]
```

## Architektur

```
apps/
  api/        Fastify-REST-API (OpenAPI unter /docs), Auth, Rate-Limit
  worker/     Job-Worker + Scheduler + Operator-CLI
  web/        Next.js-Dashboard
packages/
  core/          Typen, Enums, Fehler, Decimal-Geld, RNG, Statistik, Konfiguration, Safety-Gate
  database/      Drizzle-Schema, SQL-Migrationen, Trigger (Audit append-only, Versionen unveränderlich)
  paper-engine/  virtuelles Konto: Orders, Fills, Positionen, Gebühren, Slippage, Ledger
  risk/          Limits, Pre-Trade-Checks, Monitoring, Kapitalzuteilung
  strategies/    Strategy-SDK (Trading- und BusinessModel-Interface), Indikatoren
  backtest/      Backtester, Metriken, Walk-Forward, Monte Carlo, Sensitivität
  scoring/       Opportunity Score
  experiments/   Lebenszyklus, Quality Gates, Strategy Lab
  research/      Ideengenerator, Research-Monitor, Compliance
  connectors/    Binance, Coinbase, Kraken, Polymarket, WebSockets, Health
  jobs/          Postgres-Job-Queue mit Leases, Retries, Dedupe
  platform/      Service-Schicht: Pipeline, Persistenz, Abfragen, Runtime
strategies/
  trading/ prediction-markets/ arbitrage/ business/ saas/ lead-generation/
services/
  pmbot/      der ursprüngliche Python-Polymarket-Bot (unverändert lauffähig)
```

Details: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Startexperimente

| Experiment | Modul | Art |
| --- | --- | --- |
| AI Lead Generation | `business.ai-lead-generation` | Business (Opt-out-Pflicht eingebaut) |
| AI SaaS | `business.ai-saas` | Business |
| AI Customer Support Agent | `business.ai-support-agent` | Business |
| AI Sales Agent | `business.ai-sales-agent` | Business |
| Automated Digital Products | `business.digital-products` | Business |
| Crypto Momentum Paper Strategy | `trading.momentum` | Trading |
| Crypto Mean Reversion Paper Strategy | `trading.mean-reversion` | Trading |
| Crypto Arbitrage Simulator | `arb.cross-exchange` | Arbitrage |
| Funding-Rate Arbitrage Simulator | `arb.funding-rate` | Arbitrage |
| Prediction-Market Arbitrage Simulator | `pm.arbitrage` | Prediction Market |
| Prediction-Market Market-Making Simulator | `pm.market-making` | Prediction Market |

Dazu acht weitere Module in `DISCOVERED` (Breakout, Trend Following,
Volatility Breakout, Stat-Arb, Mispricing, Value, Orderbuch-Imbalance,
Near-Resolution) – sie warten auf eine menschliche Entscheidung.

## Datenherkunft und Ehrlichkeitsregeln

Jede Zahl trägt ihre Herkunft – im API-Ergebnis und als Badge im Dashboard:

| Herkunft | Bedeutung |
| --- | --- |
| `HISTORICAL` | Backtest auf aufgezeichneten historischen Marktdaten |
| `PAPER` | virtuelles Geld auf Live-Marktdaten |
| `SIMULATED` | simulierter Geschäftsbetrieb (virtuelle Kunden) |
| `ESTIMATED` | Monte-Carlo-Schätzung aus (meist unverifizierten) Annahmen |
| `HYPOTHETICAL` | noch nichts getestet |
| `DEMO` | synthetische Daten – beweist nur, dass der Code läuft |

* Fehlen Daten, steht dort **NO DATA** – nie eine erfundene Null.
* DEMO-Ergebnisse zählen nie als Gewinnnachweis und können ein Experiment weder
  bestehen noch scheitern lassen.
* PAPER- und SIMULATED-Gewinne werden nie addiert.
* Unverifizierte Annahmen deckeln den Score bei 60 mit LOW confidence;
  ungetestete Experimente bei 50.
* `READY_FOR_LIVE_REVIEW` heißt nur: ein Mensch sollte genau hinsehen.

## Sicherheit

Schutzschichten gegen echtes Geld (alle müssten bestehen – die letzte besteht
in dieser Version nie): Environment-Flag `TRADING_MODE=live`, explizites
`LIVE_TRADING_ENABLED`, Bestätigungsphrase, Kapitalobergrenze, Risikolimits,
menschliche Freigabe, nicht ausgelöster Emergency Stop, Audit-Log – und ein
Live-Executor, den es nicht gibt. `GET /v1/live/status` zeigt jederzeit alle
Gründe. Details und Bedrohungsmodell: [`docs/SECURITY.md`](docs/SECURITY.md).

## Bekannte Grenzen

* In der Build-Umgebung waren Marktdaten-Hosts gesperrt. Die Connectoren sind
  gegen die dokumentierten Formate getestet; die erste echte Verbindung prüft
  `pnpm aoc probe`. Ohne Marktdaten laufen Finanz-Backtests auf klar markierten
  DEMO-Daten und Paper-Konten handeln nicht (sie protokollieren das Datenproblem).
* Business-Modelle beruhen auf Annahmen-Bandbreiten ohne Quellen; sie dienen
  dem Vergleich und der Sensitivitätsanalyse, nicht der Prognose. Annahmen mit
  Quelle versehen = neue Version anlegen.
* Kein Live-Executor (bewusst).

## Fehlersuche

| Problem | Lösung |
| --- | --- |
| Dashboard: „The API is not reachable“ | `pnpm dev` läuft? `API_URL` korrekt? |
| `401 UNAUTHORIZED` | `API_TOKEN` in `.env` für API und Dashboard identisch |
| Worker OFFLINE | `pnpm dev:worker` starten (bei PGlite läuft er im API-Prozess) |
| Data Sources OFFLINE | `pnpm aoc probe`; Firewall/Proxy prüfen; `MARKET_DATA_ENABLED` |
| PostgreSQL nicht erreichbar | `docker compose up -d postgres` oder `pnpm run setup --embedded` |
| Alles pausiert | Emergency Stop aktiv? `pnpm aoc release --reason "…"` |
