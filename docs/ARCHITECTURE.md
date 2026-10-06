# Architektur

## Überblick

```
                ┌──────────────────────────── apps/web (Next.js) ────────────────────────────┐
 Browser ──────►│ Server Components lesen die API, Server Actions schreiben; Token bleibt     │
                │ serverseitig; optionale Basic-Auth (proxy.ts)                              │
                └───────────────────────────────┬────────────────────────────────────────────┘
                                                │ REST + Bearer-Token
                ┌───────────────────────────────▼────────────────────────────────────────────┐
                │ apps/api (Fastify)  zod-validiert · OpenAPI /docs · Rate-Limit · Audit      │
                └───────────────────────────────┬────────────────────────────────────────────┘
                                                │ packages/platform (Service-Schicht)
 ┌──────────────────────────┐   Job-Queue (Postgres)   ┌──────────────────────────────────────┐
 │ apps/worker              │◄────────────────────────►│ PostgreSQL 16 / PGlite               │
 │ Scheduler + Worker + CLI │                          │ Experimente, Versionen, Runs,         │
 │ Pipeline · Paper-Ticks · │                          │ Paper-Ledger, Scores, Audit, Jobs     │
 │ Risk · Scores · Research │                          └──────────────────────────────────────┘
 └────────────┬─────────────┘
              │ packages/connectors (allowlist, Rate-Limits, Health, Schema-Validierung)
              ▼
   Binance · Coinbase · Kraken · Polymarket (öffentlich, nur lesend) · GitHub · arXiv · HN · Claude (optional)
```

## Schichten

| Schicht | Pakete | Regel |
| --- | --- | --- |
| Domäne (rein) | `core`, `paper-engine`, `risk`, `strategies`, `backtest`, `scoring`, `experiments`, `research` | keine Datenbank, kein Netzwerk, deterministisch testbar |
| I/O | `database`, `connectors`, `jobs` | eine Aufgabe je Paket |
| Orchestrierung | `platform` | einziger Ort, der Domäne, Datenbank und I/O verbindet |
| Prozesse | `apps/api`, `apps/worker`, `apps/web` | dünn: Validierung, Transport, Darstellung |
| Module | `strategies/*` | eigene Implementierungen des Strategy-SDK |

Interne Pakete exportieren TypeScript-Quellen (kein Build-Schritt in der
Entwicklung). API und Worker werden für die Produktion mit tsup gebündelt
(`dist/`, inkl. SQL-Migrationen); das Dashboard als Next.js-Standalone-Server.

## Lebenszyklus eines Experiments

```
DISCOVERED ──(Mensch)──► RESEARCHING ─► PROTOTYPE ─► BACKTESTING ─► EVALUATING
                                                         ▲              │
                       (neue aktive Version) ────────────┘              ├─► PAPER ─► (Review alle 6 h) ─► PROMISING ─► READY_FOR_LIVE_REVIEW*
                                                                        ├─► PROBATION (Nachbesserung / Lab)
                                                                        └─► FAILED (Gründe gespeichert)
 jederzeit: PAUSED (Mensch, Risk-Limit, Emergency Stop) · ARCHIVED · FAILED/ARCHIVED ─(Mensch)─► RESEARCHING
 * nur manuelle Prüfung – es gibt keinen Live-Executor
```

Statuswechsel laufen nur über `transition()` (optimistisch: `WHERE status = alt`),
werden im Audit-Log festgehalten und erzeugen Benachrichtigungen in derselben
Transaktion.

## Datenmodell (Auszug)

* `strategies` – registrierte Module (Spiegel des Code-Registers)
* `ideas`, `research_sources`, `idea_sources`, `experiment_sources`
* `experiments` – Hypothese, Annahmen, Risikolimits, Compliance, Status, **Seed**
* `experiment_versions` – unveränderliche Parameter/Annahmen (DB-Trigger)
* `strategy_runs` – Backtest, Train/Test, Walk-Forward, Monte Carlo, Sensitivität, Simulation, Lab – mit Seed, Konfiguration, Herkunft
* `datasets`, `market_bars`, `dataset_points`, `data_snapshots` – Marktdaten-Cache und Live-Aufzeichnungen
* `paper_accounts`, `paper_orders`, `paper_fills`, `paper_positions`, `paper_transactions` (append-only), `performance_snapshots`
* `scores`, `metrics`, `risk_events`
* `audit_logs` (append-only, Trigger), `system_events`, `notifications`
* `job_runs`, `worker_heartbeats`, `data_sources`, `system_settings`, `users`

Migrationen: `packages/database/migrations` (Drizzle-generiert + eigene SQL-Guards).

## Reproduzierbarkeit

* Jedes Experiment hat einen gespeicherten Seed (Standard: aus Modul + Name abgeleitet).
  Alle Zufallsprozesse (DEMO-Daten, Monte Carlo, Business-Simulation, Lab) leiten
  ihren Seed daraus und aus dem Versions-Label ab.
* Jeder Run speichert Seed, Parameter, Datensatz und Konfiguration.
* Die Tests prüfen, dass gleiche Seeds gleiche Ergebnisse liefern.

## Jobs

| Job | Takt | stoppt bei Emergency Stop |
| --- | --- | --- |
| `pipeline.advance` | 1 min | ja |
| `paper.tick` | `PAPER_TICK_SECONDS` | ja |
| `risk.monitor` | 1 min | nein |
| `scores.recompute` | 5 min | nein |
| `data.health` (+ Probe) | 1 min (15 min) | nein |
| `research.monitor` | 12 h | nein |
| `ideas.generate` | 24 h | nein |
| `lab.run` | 24 h | ja |
| `notifications.deliver` | 30 s (mit Webhook) | nein |
| `maintenance.prune` | 24 h | nein |

Die Queue garantiert: keine Duplikate (eindeutiger `dedupe_key`), kein
doppeltes Abarbeiten (`FOR UPDATE SKIP LOCKED`), Leases mit Wiederaufnahme
nach Absturz, Retries mit Backoff nur für wiederholbare Fehler.

## Erweiterungen

* **Neue Trading-Strategie:** Klasse von `BaseTradingStrategy` ableiten
  (`analyze → generateSignal → calculatePositionSize → riskCheck →
  executePaperOrder → managePosition → recordResult`), mit
  `createBarStrategyModule` registrieren, in `strategies/trading/src/index.ts`
  exportieren, Tests schreiben (Kausalität, Negativkontrolle).
* **Neues Business-Modell:** `FunnelBusinessModel` erweitern
  (`discoverMarket, estimateDemand, estimateCosts, acquireCustomer,
  calculateConversion, calculateRevenue, calculateProfit, calculateChurn,
  evaluate`), Annahmen mit Bandbreiten und Quelle (oder `null` = unverifiziert)
  angeben, mit `createBusinessModule` registrieren.
* **Neue Datenquelle:** Host in `ALLOWED_HOSTS` und Rate-Limit in
  `connectors/src/sources.ts`, Antwort mit zod validieren, Health-Tracking nutzen.
