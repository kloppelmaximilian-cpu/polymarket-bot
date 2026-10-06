# API

Fastify-REST-API unter `http://127.0.0.1:4000`. Die vollständige, immer
aktuelle Spezifikation (aus den zod-Schemas generiert) liegt unter
**`/docs`** (Swagger UI) bzw. **`/docs/json`** (OpenAPI 3).

## Grundlagen

* **Auth:** `Authorization: Bearer <API_TOKEN>` für alles außer `/health`,
  `/health/ready` und `/docs`. Ohne konfiguriertes Token ist die API offen –
  sie bindet dann nur an `127.0.0.1`; in Produktion ist ein Token Pflicht.
* **Validierung:** jede Eingabe per zod; Fehler → `400`.
* **Fehlerformat:** `{ "error": { "code": "…", "message": "…", "details"?: … } }`

| Code | HTTP |
| --- | --- |
| `VALIDATION` | 400 |
| `UNAUTHORIZED` | 401 |
| `LIVE_TRADING_DISABLED` | 403 |
| `NOT_FOUND` | 404 |
| `CONFLICT`, `INVALID_TRANSITION`, `DUPLICATE` | 409 |
| `RISK_LIMIT` | 422 |
| `EMERGENCY_STOP` | 423 |
| `EXTERNAL_API` | 502 |
| `DATA_UNAVAILABLE`, `STALE_DATA` | 503 |
| `INTERNAL` | 500 (als System-Event protokolliert) |

* **Rate-Limit:** `API_RATE_LIMIT_PER_MINUTE` pro Client (localhost ausgenommen).
* **Audit:** jede schreibende Anfrage wird mit dem Akteur (`api-token` bzw.
  `local-user`) im Audit-Log festgehalten.
* **Herkunft:** Ergebnisse enthalten `provenance`
  (`HISTORICAL | PAPER | SIMULATED | ESTIMATED | HYPOTHETICAL | DEMO`); fehlende
  Werte sind `null` (= NO DATA), nie `0`.

## Endpunkte

### System

| Methode | Pfad | Zweck |
| --- | --- | --- |
| GET | `/health` | Liveness (offen) |
| GET | `/health/ready` | Readiness: Datenbank erreichbar (offen) |
| GET | `/v1/system/health` | Komponenten ONLINE/DEGRADED/OFFLINE mit Grund |
| GET | `/metrics` | Prometheus-Metriken |
| GET | `/v1/data-sources` | Datenquellen CONNECTED/STALE/DEGRADED/OFFLINE |
| POST | `/v1/data-sources/probe` | Konnektivitätsprobe einreihen |
| GET | `/v1/jobs` | letzte Jobs und Worker-Heartbeats |
| POST | `/v1/jobs/:name` | Job sofort einreihen (dedupliziert) |
| GET | `/v1/notifications` (`?unread=true`) | Benachrichtigungen |
| POST | `/v1/notifications/read` | als gelesen markieren |
| GET | `/v1/settings` | Konfiguration (Secrets redigiert), Gewichte, Schwellen |
| PUT | `/v1/settings/scoring-weights` | Score-Gewichte überschreiben |
| PUT | `/v1/settings/gate-thresholds` | Gate-Schwellen überschreiben |

### Dashboard und Experimente

| Methode | Pfad | Zweck |
| --- | --- | --- |
| GET | `/v1/dashboard` | KPIs, Top Opportunities, Pipeline, Aktivität |
| GET | `/v1/experiments` | Liste mit Filtern: `category, status, kind, riskLevel, minScore, maxScore, minProfit, maxCapital, minAutomation, minScalability, sinceDays, search, sort, dir, limit, includeArchived` |
| POST | `/v1/experiments` | Experiment aus einem Modul anlegen (`strategyId`, optional `name, params, capital, riskLevel, sourceIds, seed, startResearch`) |
| GET | `/v1/experiments/:id` | Detail (ID oder Slug): Versionen, Runs, Scores, Paper-Konto, Limits, Compliance, Logs |
| POST | `/v1/experiments/:id/actions` | `start, pause, resume, archive, revive, advance` |
| GET | `/v1/experiments/:id/versions` | alle Versionen mit Ergebnissen (v2 vs v1) |
| POST | `/v1/experiments/:id/versions` | neue unveränderliche Version (`ACTIVE` startet die Bewertung neu, `CANDIDATE` zum Vergleich) |
| POST | `/v1/experiments/:id/versions/:versionId/promote` | Kandidat aktivieren |
| PUT | `/v1/experiments/:id/risk-limits` | Risikolimits ändern (validiert) |
| PUT | `/v1/experiments/:id/compliance/:item` | Compliance-Review; `BLOCKER` → FAILED |
| POST | `/v1/experiments/:id/lab` | Strategy-Lab-Lauf einreihen |
| POST | `/v1/experiments/:id/flatten` | Paper-Positionen zum letzten Kurs schließen (nur risikoreduzierend) |
| GET | `/v1/compare?ids=a,b,…` | Vergleich (2–8) |
| GET | `/v1/runs/:id` | gespeicherter Run mit vollständigem Ergebnis |
| GET | `/v1/metrics?experimentId=…` | Metriken (Langformat) |
| GET | `/v1/strategies`, `/v1/strategies/:id` | Module und ihre Experimente |

### Portfolio, Performance, Risiko, Logs

| Methode | Pfad | Zweck |
| --- | --- | --- |
| GET | `/v1/portfolio` | Paper-Fonds, Simulationsbudget, alle Konten |
| GET | `/v1/portfolio/accounts/:id` | Positionen, Orders, Fills, Ledger, Equity-Kurve |
| GET | `/v1/performance` | normierte Equity-Kurven, Kategorien |
| GET | `/v1/risk` | Limits, Auslastung, Risk-Events, Emergency Stop |
| POST | `/v1/risk/emergency-stop` | **EMERGENCY STOP** (`{ reason }`) |
| POST | `/v1/risk/emergency-stop/release` | Freigabe (`{ reason, resumePaused? }`) |
| GET | `/v1/live/status` | warum Live gesperrt ist (immer `allowed: false`) |
| GET | `/v1/logs/audit` | Audit-Log (append-only) mit Filtern |
| GET | `/v1/logs/events` | System-Events mit Filtern |

### Research und Ideen

| Methode | Pfad | Zweck |
| --- | --- | --- |
| GET | `/v1/research/sources` | Research-Datenbank |
| POST | `/v1/research/sources` | Quelle hinzufügen (nur http/https), optional mit Experiment verknüpfen |
| POST | `/v1/research/monitor` | Research-Monitor einreihen |
| GET | `/v1/ideas` | Ideen-Datenbank |
| POST | `/v1/ideas` | Idee hinzufügen (Duplikate → 409) |
| GET | `/v1/ideas/prompts` | Prompts des Ideengenerators |
| POST | `/v1/ideas/generate` | Ideengenerator einreihen (`focus, count, maxConvert`) |
| POST | `/v1/ideas/:id/convert` | Experiment aus einer Idee anlegen |

## Beispiele

```bash
TOKEN=$(grep ^API_TOKEN .env | cut -d= -f2)
H="authorization: Bearer $TOKEN"

curl -s -H "$H" http://127.0.0.1:4000/v1/dashboard | jq '.totals, .riskStatus'
curl -s -H "$H" "http://127.0.0.1:4000/v1/experiments?status=PAPER&sort=score" | jq '.[].name'
curl -s -H "$H" -H 'content-type: application/json' \
  -d '{"strategyId":"trading.momentum","name":"Momentum BTC, 72h lookback","params":{"lookbackBars":72},"startResearch":true}' \
  http://127.0.0.1:4000/v1/experiments | jq '.experiment.id'
curl -s -H "$H" -H 'content-type: application/json' -d '{"reason":"Drill"}' \
  http://127.0.0.1:4000/v1/risk/emergency-stop
```
