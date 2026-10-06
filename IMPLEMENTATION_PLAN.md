# Automated Opportunity Center — Implementierungsplan

Stand: 2026-10-06 · Modus: **PAPER / SIMULATION ONLY** · Live: **DISABLED**

Dieses Dokument ist der verbindliche Plan (Phasen A–C) für den Umbau dieses
Repositories zu einem *Automated Opportunity Research & Experimentation Center*.
Alle Architekturentscheidungen, die während der Umsetzung getroffen wurden, sind
hier mit Begründung dokumentiert (Abschnitt 12).

---

## 1. Analyse des bestehenden Repositories (Phase A)

| Befund | Bewertung |
|---|---|
| Python-Projekt `pmbot` (Polymarket 5-Minuten-Crypto-Bot), ~870 Tests, SQLite, eigener Paper-/Live-Executor, Walk-Forward, Monte Carlo | Hochwertig, gut getestet, aber ein **einzelnes** Trading-System — keine Plattform |
| `docs/API.md` dokumentiert die Polymarket-Endpunkte, verifiziert gegen den offiziellen `py-clob-client` | Wird als Referenz für die neuen Prediction-Market-Connectoren genutzt (kein Code kopiert, nur verifizierte Fakten) |
| Kein Node/TypeScript-Code, keine Web-App außer einem lokalen HTML-Dashboard | Plattform wird neu gebaut |
| Toolchain in der Build-Umgebung: Node 22.22, pnpm 10.28, PostgreSQL 16 (Binaries), Python 3.13, Docker-CLI ohne Daemon | Integrationstests laufen gegen echtes PostgreSQL 16; Docker-Compose wird geschrieben, kann hier aber nicht gestartet werden |
| Netzwerk der Build-Umgebung: npm/PyPI erreichbar; **Binance, Coinbase, Kraken, Polymarket, GitHub-API, arXiv blockiert** | Connectoren werden gegen die offizielle Dokumentation implementiert, alle Antworten per Schema validiert und mit Fixtures getestet. Live-Verifikation muss beim Benutzer erfolgen (`pnpm aoc doctor`). Das wird überall ehrlich ausgewiesen. |

**Entscheidung:** Das bestehende Python-Projekt wird unverändert nach
`services/pmbot/` verschoben (Git-Historie bleibt erhalten) und dort weiter
betrieben. Es wird in der Plattform als eigenes Experiment registriert. Das
Repository-Root wird zum Monorepo der Plattform.

---

## 2. Architektur (Phase B)

```
                         ┌──────────────────────────────────────────┐
                         │            apps/web  (Next.js 16)         │
                         │  Dashboard · Opportunities · Experiments  │
                         │  Strategies · Lab · Compare · Research    │
                         │  Portfolio · Performance · Risk · Logs    │
                         │  Settings · System · EMERGENCY STOP       │
                         └───────────────┬──────────────────────────┘
                                         │ server-side fetch + Proxy (Token)
                         ┌───────────────▼──────────────────────────┐
                         │          apps/api  (Fastify 5)           │
                         │  REST + OpenAPI (/docs) · Auth-Token ·   │
                         │  Validation (zod) · Rate-Limit · Health  │
                         └───────────────┬──────────────────────────┘
                                         │
   ┌─────────────────────────────────────▼──────────────────────────────────┐
   │                packages/platform  (Application Services)              │
   │  ExperimentService · PipelineService · PaperService · RiskService     │
   │  ResearchService · ScoringService · LabService · HealthService ·      │
   │  AuditService · NotificationService                                   │
   └──┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬───┘
      │          │          │          │          │          │          │
  database  paper-engine   risk     backtest   scoring   experiments  research
  (Drizzle) (Decimal-      (Limits, (Walk-Fwd, (Opport.  (Lifecycle,  (Ideen,
   Postgres  Ledger)        Stop)    MC, PSR)   Score)    Gates,Lab)   Monitor)
      │                                │
      │                         packages/strategies (Interfaces, Registry)
      │                                │
      │        strategies/trading · prediction-markets · arbitrage
      │        strategies/business · saas · lead-generation
      │
  packages/connectors (Binance, Coinbase, Kraken, Polymarket, Funding,
                       GitHub, arXiv, HN; Health; Synthetic Data)
      │
  packages/jobs (Postgres-Job-Queue: Dedupe, Lease, Retry, Heartbeat)
      ▲
      └──── apps/worker (Scheduler + Job-Handler + WebSocket-Streams)
```

Pipeline (jede Stufe ist ein persistierter Run mit Provenienz):

```
DISCOVER → RESEARCH → DESIGN → BUILD → SIMULATE → BACKTEST → PAPER TEST
        → EVALUATE → RANK → IMPROVE (Strategy Lab, neue Version) → GRADUATE
                                                   (= READY_FOR_LIVE_REVIEW)
```

### Technologie

| Schicht | Wahl | Begründung |
|---|---|---|
| Monorepo | pnpm Workspaces, interne TS-Pakete (Source-Exports) | Kein Build-Schritt für Pakete in Dev/Test, klare Grenzen |
| Sprache | TypeScript 5.9 (strict) | Stabil, von Next/Vitest/tsx vollständig unterstützt |
| Frontend | Next.js 16 (App Router), React 19, Tailwind 4, Recharts, lucide | Wie gefordert; Server Components für Daten, Client Components für Interaktion |
| API | Fastify 5 + zod + @fastify/swagger | Schnell, schema-validiert, OpenAPI automatisch |
| DB | PostgreSQL 16 + Drizzle ORM + SQL-Migrationen | Typsicher, Migrationen als SQL-Dateien im Repo |
| Embedded-DB | PGlite (Postgres als WASM) | Tests gegen echtes Postgres-SQL ohne Server; Zero-Setup-Modus |
| Geldrechnung | decimal.js | Keine Float-Fehler in Ledger, Gebühren, P&L |
| Jobs | eigene Postgres-Queue (`job_runs`) | Dedupe per Unique-Key, Lease/Reclaim bei Crash, `FOR UPDATE SKIP LOCKED`; keine zusätzliche Infrastruktur (kein Redis) |
| Logs | pino (JSON) | Strukturierte Logs, Secret-Redaction |
| Tests | Vitest, PGlite, echtes Postgres (optional), Playwright (Smoke) | Schnell und reproduzierbar |
| Deployment | Docker Compose (postgres, api, worker, web), Multi-Stage-Dockerfiles | Lokal und produktionsnah |

---

## 3. Hauptmodule

| Paket | Verantwortung | Reinheit |
|---|---|---|
| `packages/core` | Enums (Status, Provenienz, Kategorien), Fehlerklassen, Config (zod, Env), Logger, Seeded-RNG, Clock, Decimal-Helfer, **Live-Gate** | rein |
| `packages/database` | Schema, Migrationen, Client (pg/PGlite), Repositories, Unveränderlichkeits-Trigger | DB |
| `packages/paper-engine` | Virtuelle Konten, Orders, Fills, Positionen (Spot, Perp, Binary-Outcome), Gebühren, Slippage, Funding, Settlement, Ledger-Invarianten | rein |
| `packages/risk` | Limits pro Experiment, Pre-Trade-Checks, Monitoring (Daily Loss, Drawdown, Exposure, Spend), Emergency-Stop-Logik | rein |
| `packages/backtest` | Bar-Backtester ohne Look-Ahead, Train/Test, Walk-Forward, Monte Carlo, Kosten-Sensitivität, Kennzahlen (Sharpe, Sortino, MDD, PF, PSR, DSR) | rein |
| `packages/strategies` | `TradingStrategy`- und `BusinessModel`-Interfaces, Basisklassen, Registry, Broker-Abstraktion | rein |
| `strategies/*` | Konkrete Strategien und Geschäftsmodelle | rein |
| `packages/scoring` | Opportunity Score 0–100 + 7 Einzelscores, nicht-kompensatorische Risikostrafe, Konfidenz | rein |
| `packages/experiments` | Lifecycle-State-Machine, Quality Gates, Auto-Reject, Versionierung, Strategy-Lab-Varianten | rein |
| `packages/research` | Ideen-Modell, Idea Generator (Katalog + optional LLM), Research Monitor (GitHub/arXiv/HN), Compliance-Checkliste | rein + HTTP |
| `packages/connectors` | Marktdaten-Connectoren, Rate-Limiter, Data Health, synthetische Daten (DEMO) | HTTP/WS |
| `packages/jobs` | Job-Queue, Scheduler, Worker-Loop | DB |
| `packages/platform` | Verdrahtung: Services, die Engines mit der DB verbinden; Audit; Notifications | DB |
| `apps/api` | HTTP-API | — |
| `apps/worker` | Hintergrundprozess | — |
| `apps/web` | Dashboard | — |
| `services/pmbot` | Bestehender Python-Bot (unverändert lauffähig) | — |

---

## 4. Datenmodell (Phase D)

Alle Tabellen in PostgreSQL, Geldbeträge als `numeric(30,10)` (exakt), Zeit als
`timestamptz`, IDs als UUID. Änderungen ausschließlich über Migrationen.

| Tabelle | Zweck / wichtigste Felder |
|---|---|
| `users` | id, email, name, role (OWNER) |
| `strategies` | Strategie-Module: id (`trading.momentum`), kind, category, module_version, params_schema, default_params, required_data |
| `experiments` | strategy_id, idea_id, name, category, description, hypothesis, assumptions, required_data, capital_requirement, estimated_cost, risk_level, automation/scalability/complexity_score, expected_time_to_revenue_days, status, status_reason, failure_reasons, current_version_id, risk_limits, compliance, is_demo, timestamps |
| `experiment_versions` | experiment_id, seq, label (`v1`, `v1.1`), params (**unveränderlich**, Trigger), parent_version_id, created_by, change_note, status |
| `experiment_sources` | Verknüpfung Experiment ↔ research_sources |
| `strategy_runs` | Run pro Phase: run_type, provenance, status, dataset_id, config, seed, summary, result, error, Zeiten |
| `ideas` | Name, Kategorie, Beschreibung, Discovery-Datum, geschätztes Kapital, Automatisierbarkeit, Komplexität, Einnahmequelle, Risiken, Abhängigkeiten, Regulatorik/ToS, Testbarkeit, Skalierbarkeit, origin (CATALOG/LLM/MONITOR/MANUAL), status, assessment |
| `idea_sources` | Verknüpfung Idee ↔ Quelle |
| `research_sources` | source_type, title, url, author/repository, found_at, summary, relevant_concept, advantages, disadvantages, risk, implementation_idea, license, terms_concerns, github (stars, activity, last_update, architecture, limitations), monitor_category, relevance |
| `datasets` | Herkunft, Symbol, Intervall, Zeitraum, provenance (HISTORICAL/SYNTHETIC), Checksumme |
| `market_bars` | OHLCV je Dataset (PK dataset_id+ts) |
| `data_snapshots` | Live-Snapshots (Ticker, Books, Funding) mit Zeitstempel und Quelle |
| `data_sources` | Status CONNECTED/STALE/DEGRADED/OFFLINE, letzte Aktualisierung, Fehler, Latenz |
| `paper_accounts` | experiment_id, version_id, starting_capital, cash, peak_equity, day_start_equity, status, lock_version |
| `paper_orders` | client_order_id (**unique pro Konto** → keine Duplikate), Instrument, Seite, Typ, Menge, Limit, Status, Ablehnungsgrund |
| `paper_fills` | Preis, Menge, Gebühr, Slippage, Liquidität (MAKER/TAKER) |
| `paper_positions` | Instrument, Menge, Durchschnittspreis, realisiert, Mark |
| `paper_transactions` | Ledger: DEPOSIT, WITHDRAWAL, TRADE, FEE, FUNDING, SETTLEMENT, REALIZED_PNL, REVENUE, COST — **Summe = Cash** |
| `performance_snapshots` | Equity-Kurve je Konto |
| `metrics` | Kennzahlen im Long-Format mit Provenienz |
| `scores` | Score-Historie mit Einzelscores, Konfidenz, Rang, Erklärung |
| `risk_events` | Limitverletzungen, Emergency Stop |
| `system_events` | Fehler, Zustandswechsel, Datenqualität |
| `audit_logs` | append-only (Trigger verhindert UPDATE/DELETE) |
| `job_runs` | Queue: name, dedupe_key (unique), status, attempts, lease, Fehler |
| `worker_heartbeats` | Worker-Lebenszeichen |
| `notifications` | In-App + Webhook-Zustellung |
| `system_settings` | Emergency-Stop-Flag, Laufzeit-Einstellungen |

---

## 5. Score-Modell

Einzelscores 0–100 (höher = besser): **Profit, Risk (= Sicherheit), Automation,
Scalability, Capital Efficiency, Reliability, Time-to-Revenue**, plus
Kontextfaktoren: Recurring Revenue, Competition, Dependency Risk, Data
Availability, Execution Risk, Operational Complexity.

* Gewichteter Mittelwert der vorhandenen Scores.
* **Nicht-kompensatorische Risikostrafe:** `score × (0.5 + 0.5 · risk/100)`;
  Deckel: EXTREME-Risiko ≤ 40, negative Erwartung ≤ 25, FAILED ≤ 15.
* **Fehlende Daten werden nicht erfunden:** Profit ohne Ergebnisse = `NO DATA`,
  der Gesamtscore ist dann auf 60 gedeckelt und als `LOW confidence` markiert;
  ungetestete Experimente (HYPOTHETICAL) ≤ 50; Business-Schätzungen mit
  < 50 % belegten Annahmen ≤ 60 und `LOW`. Details: `docs/SCORING.md`.
* Konfidenz nach Evidenzstufe: HYPOTHETICAL < ESTIMATED < SIMULATED <
  HISTORICAL < PAPER.

---

## 6. Teststrategie (Phase K)

| Ebene | Inhalt |
|---|---|
| Unit | Decimal-Helfer, RNG-Determinismus, Config-Validierung, Live-Gate |
| Paper Engine | Gebühren (Bps, Polymarket-Formel), Slippage, Teilfüllungen, Durchschnittspreis, realisierte/unrealisierte P&L, Short-Perps, Funding, Settlement, Duplikat-Orders, Ledger-Invariante (Cash = Σ Transaktionen), Property-Tests mit Zufallssequenzen |
| Risk Engine | jedes Limit einzeln an der Grenze (=, <, >), Emergency Stop, Tageswechsel, Drawdown vom Peak |
| Backtest | Kausalitätstest (Zukunft verändern ⇒ Vergangenheit identisch), Ausführung erst am nächsten Bar, Kosten, Walk-Forward-Folds disjunkt, PSR/DSR gegen Referenzwerte |
| Strategien | Signale auf konstruierten Reihen, negative Kontrolle (Random Walk ⇒ kein Edge nach Kosten) |
| Business | Funnel-Arithmetik exakt, Monte-Carlo reproduzierbar per Seed, Sensitivität |
| Scoring | Monotonie, Hochrisiko-Modell rankt nicht automatisch höher, NO DATA |
| Lifecycle/Gates | erlaubte/verbotene Übergänge, Glückstreffer-Schutz, Auto-Reject-Gründe |
| Connectoren | Parser gegen Fixtures, kaputte/fehlende Felder, Timeouts, 429, Staleness-Erkennung |
| Jobs | Dedupe, Lease-Ablauf nach Crash, max. Versuche, parallele Claims |
| Database | Migrationen auf PGlite und echtem Postgres, Trigger (Audit append-only, Version unveränderlich) |
| API | Fastify `inject` gegen PGlite: CRUD, Validation, Auth, Emergency Stop |
| Integration | Gesamte Pipeline: Idee → Experiment → Backtest → Paper → Score → Ranking |
| UI | Typecheck, Production-Build, Playwright-Smoke (Seiten laden, Emergency Stop) |

---

## 7. Sicherheitsmaßnahmen

1. `TRADING_MODE=paper` ist Default; Live erfordert **alle**: `TRADING_MODE=live`,
   `LIVE_TRADING_ENABLED=true`, `LIVE_CONFIRMATION=I_UNDERSTAND_REAL_MONEY_RISK`,
   gesetzten `LIVE_CAPITAL_CAP_USD`, Experiment-Status `READY_FOR_LIVE_REVIEW`
   **plus** dokumentierte manuelle Freigabe, Emergency Stop aus.
2. **Es existiert in dieser Version kein Live-Executor.** Das Interface ist
   vorbereitet, die Implementierung wirft immer `LiveTradingDisabledError`.
   Paper- und Live-Pfad sind getrennte Klassen.
3. Keine Credentials nötig; Secrets nur aus der Umgebung, Redaction in Logs und
   `/settings`; `.env` in `.gitignore`.
4. API: Bearer-Token (in Produktion Pflicht), CORS auf Web-Origin, Rate-Limit,
   Security-Header, zod-Validierung aller Eingaben, parametrisierte SQL.
5. Emergency Stop: ein Schalter stoppt Scheduler-Jobs, pausiert alle laufenden
   Experimente, sperrt neue Paper-Orders; Aufhebung nur explizit, auditiert.
6. Audit-Log append-only per DB-Trigger.
7. Outbound-HTTP nur zu einer Allowlist bekannter API-Hosts (kein SSRF über
   Research-URLs).
8. Outreach-Modelle müssen Opt-out/Suppression modellieren; Compliance-Blocker
   verhindern das Fortschreiten im Lifecycle.

---

## 8. Erste Experimente (Phase I)

| # | Experiment | Typ | Testmethode |
|---|---|---|---|
| 1 | AI Lead Generation | Business | Funnel-Monte-Carlo, Sensitivität, Paper-Betriebssimulation |
| 2 | AI SaaS | Business | Besucher→Signup→Paid, MRR/ARR, Churn, API-/Serverkosten |
| 3 | AI Customer Support Agent | Business | Kunden, Ticketvolumen, API-Kosten, Support, Marge, Churn |
| 4 | AI Sales Agent | Business | Outreach-Funnel mit Opt-out, Meetings, Abschlüsse |
| 5 | Automatisierte digitale Produkte | Business | Traffic, Conversion, Plattformgebühren, Refunds |
| 6 | Crypto Momentum (Paper) | Trading | Walk-Forward auf Klines, Paper mit Live-Daten |
| 7 | Crypto Mean Reversion (Paper) | Trading | dto. |
| 8 | Crypto Cross-Exchange-Arbitrage | Arbitrage | Ticker-Snapshots mehrerer Börsen, Gebühren, Inventar, Rebalancing |
| 9 | Funding-Rate-Arbitrage | Arbitrage | Historische Funding-Raten, Cash-and-Carry, 4 Legs Gebühren, Basis |
| 10 | Prediction-Market-Arbitrage | Prediction Market | YES+NO bzw. Σ Outcomes < 1 nach Gebühren auf Orderbüchern |
| 11 | Prediction-Market Market Making | Prediction Market | Quotes mit Inventar-Skew, Fill-Modell, Adverse Selection |

Weitere registrierte Strategiemodule (als Experimente im Status DISCOVERED/
PROTOTYPE): Breakout, Trend Following, Volatility Breakout, Statistical
Arbitrage (Pairs), Mispricing Detection, Value Trading, Orderbook Imbalance,
Resolution/Near-Certainty, sowie der bestehende `pmbot` als externes Experiment.

---

## 9. Phasen und Reihenfolge

| Phase | Inhalt | Ergebnis |
|---|---|---|
| A | Repository-Analyse | Abschnitt 1 |
| B | Architektur | Abschnitt 2–3 |
| C | dieser Plan | `IMPLEMENTATION_PLAN.md` |
| D | Datenmodell | Drizzle-Schema + Migration `0000` |
| E | Core/Backend | core, database, platform, api |
| F | Paper Engine | paper-engine + Tests |
| G | Risk Engine | risk + Tests |
| H | Research/Idea Engine | research, connectors (Monitor) |
| I | Strategien | strategies/*, backtest, scoring, experiments |
| J | Dashboard | apps/web |
| K | Tests | alle Ebenen aus Abschnitt 6 |
| L | Integration | echtes Postgres, Pipeline-Durchlauf, Screenshots |
| M | UI-Finalisierung | Feinschliff, Responsiveness, Dark Mode |

---

## 10. Ehrlichkeitsregeln (im Code erzwungen)

* Jede Kennzahl trägt eine Provenienz: `HISTORICAL`, `SIMULATED`, `PAPER`,
  `ESTIMATED`, `HYPOTHETICAL`, `DEMO`. Die UI zeigt sie als Badge.
* Ohne Daten wird `NO DATA` angezeigt, niemals eine Zahl.
* Ergebnisse auf synthetischen Daten sind `DEMO` und zählen nicht in die
  Summen realer Paper-Ergebnisse.
* Trading-Strategien können nur mit `HISTORICAL`-Daten `PROMISING` werden —
  synthetische Daten beweisen keinen Edge.
* Kein Text im System behauptet garantierten Gewinn; Ergebnistexte lauten
  „unter den getesteten Annahmen und Daten …“.

---

## 11. Bekannte Grenzen dieser Version

* Live-Marktdaten konnten in der Build-Umgebung nicht abgerufen werden
  (Egress blockiert). Parser sind gegen dokumentierte Formate getestet; die
  erste echte Verbindung prüft `pnpm aoc doctor`.
* Business-Modelle basieren auf Annahmen (Bandbreiten), nicht auf Marktdaten;
  sie sind als `ESTIMATED` gekennzeichnet und dienen dem Vergleich, nicht der
  Prognose.
* Kein Live-Executor (bewusst).

---

## 12. Entscheidungslog

| # | Entscheidung | Grund |
|---|---|---|
| D1 | Python-Bot nach `services/pmbot` | Root wird Monorepo; Bot bleibt lauffähig |
| D2 | Pakete exportieren TypeScript-Source | Kein Build-Schritt für interne Pakete; API/Worker werden für Produktion gebündelt |
| D3 | Eigene Postgres-Queue statt pg-boss/Redis | Läuft auf Postgres **und** PGlite, deterministisch testbar |
| D4 | decimal.js für Geld | Korrektheit vor Performance (Priorität 3) |
| D5 | Reine Engines + `platform`-Service-Schicht | Engines ohne DB testbar; Persistenz an einer Stelle |
| D6 | Embedded-Modus (PGlite) mit In-Process-Worker | `pnpm dev:embedded` startet ohne Docker/Postgres |
| D7 | Business-„Paper“ = tägliche agentenbasierte Betriebssimulation im Paper-Ledger | Einheitliche P&L-Darstellung über alle Kategorien |
| D8 | Kein Live-Executor implementiert | Sicherheit hat Priorität 1 |
| D9 | Eigener Budget-Topf für simulierte Geschäftsbetriebe (`BUSINESS_SIM_BUDGET_USD`); Budget ≈ P70 des geschätzten Cash-Bedarfs | Ein fixes Budget ließ Geschäftsmodelle an zu wenig virtuellem Geld scheitern statt an ihrer Ökonomie; Trading-Fonds bleibt unberührt |
| D10 | Webhook-Benachrichtigungen per Job `notifications.deliver` statt in der Transaktion | Keine Benachrichtigung für zurückgerollte Statuswechsel; kein Deadlock auf PGlite |
| D11 | Gespeicherter, deterministischer Seed je Experiment (Migration `0002`) | Seeds aus Zufalls-IDs machten Ergebnisse (und Tests) nicht reproduzierbar |
| D12 | Emergency Stop pausiert alle automatisierten Status und sperrt Start/Resume bis zur Freigabe | Ein Not-Aus muss alles Automatische anhalten, nicht nur den Paper-Handel |
| D13 | Dashboard serverseitig gerendert, Mutationen als Server Actions mit erneuter Auth-Prüfung, Typen aus den Platform-Queries abgeleitet | Token verlässt nie den Server; UI kann nicht von der API abdriften |
| D14 | Kein ROI für Business-Schätzungen; ungetestete Experimente ≤ 50 Punkte | Gewinn / Cash-Puffer ergab irreführende Prozentwerte; Ungetestetes darf Getestetes nicht überholen |
| D15 | Produktion: tsup-Bundles (inkl. SQL-Migrationen) + `pnpm deploy --prod`; Next.js standalone | Kleine, selbstständige Images ohne Workspace-Quellen |
| D16 | Optionales Proxy-CA im Docker-Build nur als BuildKit-Secret | Builds hinter TLS-abfangenden Proxys, ohne Secrets im Image |
