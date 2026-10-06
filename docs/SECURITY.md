# Sicherheit

## Grundsatz

**PAPER = DEFAULT. LIVE = DISABLED.** Diese Version kann kein echtes Geld
bewegen: Es gibt keinen Live-Executor, keine Wallet, keine privaten Schlüssel,
keine Order-Endpunkte bei Börsen. Alle Connectoren rufen ausschließlich
öffentliche, lesende Endpunkte auf.

## Schutzschichten (Live-Gate)

`packages/core/src/safety.ts` – `evaluateLiveGate()` listet **alle** nicht
erfüllten Bedingungen; Live wäre nur erlaubt, wenn keine übrig bliebe:

1. Environment-Flag `TRADING_MODE=live`
2. explizites `LIVE_TRADING_ENABLED=true`
3. Bestätigungsphrase `LIVE_CONFIRMATION=I_UNDERSTAND_REAL_MONEY_RISK`
4. Kapitalobergrenze `LIVE_CAPITAL_CAP_USD > 0` und angefordertes Kapital darunter
5. Experiment im Status `READY_FOR_LIVE_REVIEW`
6. menschliche Freigabe (Approval-ID)
7. Emergency Stop nicht ausgelöst
8. **ein Live-Executor – existiert in dieser Version nicht** (immer nicht erfüllt)

`GET /v1/live/status` und die Risk-Seite zeigen diese Liste. Jede Zuteilung
an die Paper-Engine läuft zusätzlich durch Risk-Limits und Audit-Log.

## Emergency Stop

* Dashboard (oben rechts, jede Seite), `POST /v1/risk/emergency-stop`, `pnpm aoc emergency-stop --reason "…"`.
* Wirkung: Flag zuerst gespeichert → Pre-Trade-Hook lehnt jede neue Paper-Order
  ab; der Worker führt keine handelnden Jobs mehr aus (Pipeline, Paper-Ticks,
  Lab); alle automatisierten Experimente werden PAUSED; offene Paper-Orders
  storniert; CRITICAL-Risk-Event, Audit-Eintrag, Benachrichtigung.
* Während des Stopps lassen sich Experimente weder starten noch fortsetzen.
* Freigabe setzt nichts automatisch fort (optional `--resume`).

## Risk-Engine

Limits je Experiment: Max Capital, Max Daily Loss, Max Drawdown, Max Exposure,
Max Positions, Max Orders/Tag, Max Order-Notional, Max API Spend, Max
Experiment Spend. Vor jeder Order (Pre-Trade) und bei jedem Tick (Monitor)
geprüft. Risikoreduzierende Orders sind auch bei verletzten Limits erlaubt
(außer im Emergency Stop). Verletzung von Verlust-, Drawdown- oder
Ausgabenlimits → Experiment PAUSED, Ereignis protokolliert.

## Authentifizierung und Netz

* API: Bearer-Token (`API_TOKEN`, Vergleich in konstanter Zeit); offen sind
  nur `/health`, `/health/ready` und `/docs`. In Produktion ist ein Token ≥ 24
  Zeichen Pflicht (Start schlägt sonst fehl).
* API und Dashboard binden standardmäßig an `127.0.0.1`; Docker Compose
  veröffentlicht alle Ports nur auf `127.0.0.1`.
* Dashboard: Token nur serverseitig; optionale Basic-Auth in `proxy.ts`,
  zusätzlich in jeder Server Action geprüft. Sicherheits-Header
  (`X-Frame-Options: DENY`, `nosniff`, Referrer-Policy, Permissions-Policy),
  Helmet in der API, CORS auf `WEB_ORIGIN` beschränkt, Rate-Limit.
* Ausgehende Requests nur an eine Allowlist von Hosts, mit Timeouts,
  Rate-Limits, Schema-Validierung jeder Antwort.

## Secrets

* Nie im Code oder Repository: `.env` ist in `.gitignore` und `.dockerignore`.
* Logger (pino) redigiert `authorization`, `apiKey`, `secret`, `password`, Token-Felder.
* `/v1/settings` und die Settings-Seite zeigen Secrets als `[REDACTED]`,
  Zugangsdaten in URLs maskiert.
* Docker-Images enthalten keine Secrets; ein Proxy-CA wird nur als
  BuildKit-Secret während des Builds eingebunden.

## Integrität

* Audit-Log und Paper-Ledger sind per Datenbank-Trigger **append-only**.
* Parameter und Annahmen gespeicherter Versionen sind per Trigger **unveränderlich**.
* CHECK-Constraints (z. B. Startkapital ≥ 0, Ordermenge > 0), eindeutige
  `clientOrderId` je Konto (keine doppelten Orders), höchstens ein aktives
  Paper-Konto je Experiment, optimistisches Locking der Konten.
* Migrationen laufen unter einem Advisory-Lock (kein doppeltes Migrieren).

## Plattform- und Rechtsregeln

* Keine Strategie umgeht Sicherheitsmechanismen, Plattformregeln oder
  Zugriffsbeschränkungen; Connectoren nutzen nur dokumentierte öffentliche APIs
  und respektieren Rate-Limits (inkl. `Retry-After`, 418/451 = Abbruch).
* Outreach-Modelle (Lead Generation, Sales Agent) enthalten ein
  verpflichtendes Opt-out-/Stop-System (`honourOptOut` ist fest `true`).
* Jedes Experiment hat eine Compliance-Checkliste (ToS, API-Bedingungen,
  Lizenz, Datenrechte, Spam-Regeln, Plattformregeln, Regulierung); nichts ist
  vorab freigegeben, ein BLOCKER lässt das Experiment scheitern.
* Fremder Code wird nicht kopiert; Quellen werden mit Lizenz und ToS-Hinweis gespeichert.

## Bedrohungsmodell (Kurzfassung)

| Risiko | Gegenmaßnahme |
| --- | --- |
| versehentliches Live-Trading | kein Executor, mehrschichtiges Gate, Tests sichern das Gate ab |
| Fehlkonfiguration öffnet API ins Netz | Bind auf 127.0.0.1, Token-Pflicht in Produktion |
| geleakte Secrets | `.env` ignoriert, Redaction, keine Secrets in Images |
| manipulierte Ergebnisse | append-only Ledger/Audit, unveränderliche Versionen, Seeds |
| fehlerhafte/veraltete Marktdaten | Schema-Validierung, STALE-Erkennung, kein Handel ohne frische Daten |
| durchgehende Kosten (API, Experimente) | API-Spend- und Experiment-Spend-Limits |
| Prompt-Injection über Research-Quellen | Quellen sind Daten, nie Anweisungen; LLM-Ausgaben strukturiert (zod) und als unverifiziert markiert |
