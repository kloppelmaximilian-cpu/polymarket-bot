# Runbook

## Täglicher Blick

1. Dashboard: **System**-Kachel ONLINE? **Risk status** NORMAL?
2. **Next to review**: PROMISING / PROBATION / READY_FOR_LIVE_REVIEW ansehen.
3. **System → Notifications**: Risk-Events, Fehler, neue Ideen.
4. `pnpm aoc doctor` meldet Konfigurations- und Verbindungsprobleme.

## Notfall: EMERGENCY STOP

```bash
pnpm aoc emergency-stop --reason "was ist passiert"     # oder Knopf im Dashboard
pnpm aoc status                                          # prüft: EMERGENCY STOP ENGAGED
# Ursache klären (Risk-Seite, Logs → System-Events) …
pnpm aoc release --reason "behoben: …"                   # Experimente bleiben pausiert
pnpm aoc release --reason "…" --resume                   # oder: vom Stopp pausierte fortsetzen
```

Was passiert: neue Paper-Orders werden abgelehnt, handelnde Jobs laufen nicht,
alle automatisierten Experimente → PAUSED, offene Paper-Orders storniert,
CRITICAL-Event + Audit + Benachrichtigung. Monitoring, Scores und
Datenqualität laufen weiter.

## Ein Experiment wurde gestoppt (PAUSED durch Risk-Limit)

1. Experiment öffnen → **Risk limits** und **Risk events**: welches Limit?
2. Ursache prüfen (Paper-Ledger, Orders, Equity-Kurve).
3. Entweder Limits bewusst anpassen (auditiert) oder Parameter ändern
   (neue Version) – dann **Resume**.

## Datenquellen OFFLINE / STALE

* `pnpm aoc probe` zeigt jede Quelle mit Fehler.
* STALE: Daten älter als `DATA_STALE_AFTER_MS` → Paper-Ticks handeln nicht,
  der Tick protokolliert das Problem (`dataTicks`), die Daten-Uptime sinkt
  (Gate-Kriterium).
* 418/451 von einer Börse = Zugriff verweigert (z. B. Region) → nicht umgehen;
  Quelle deaktivieren bzw. andere Börse nutzen.

## Worker läuft nicht

* `System → Workers`: kein Heartbeat → `pnpm dev:worker` bzw. `docker compose up -d worker`.
* Jobs mit abgelaufenem Lease werden automatisch wieder eingereiht (max. Versuche, dann DEAD).
* Einzelnen Job manuell: `pnpm aoc job pipeline.advance`.

## Datenbank

* Migrationen: laufen beim Start von API/Worker (Advisory-Lock) oder `pnpm db:migrate`.
* Neue Migration: Schema in `packages/database/src/schema.ts` ändern, `pnpm db:generate`,
  SQL prüfen (Bestandsdaten!), committen.
* Backup (Docker): `docker compose exec postgres pg_dump -U aoc aoc > backup.sql`
* Restore: `docker compose exec -T postgres psql -U aoc aoc < backup.sql`
* Embedded (PGlite): Verzeichnis `.data/pglite` bei gestopptem Prozess kopieren.
* Aufbewahrung: `maintenance.prune` löscht täglich Jobs > 14 Tage und
  Live-Snapshots > 30 Tage; Ledger, Audit, Runs bleiben.

## Neue Strategie / neues Geschäftsmodell aufnehmen

1. Modul im passenden `strategies/*`-Paket implementieren (siehe `docs/ARCHITECTURE.md` → Erweiterungen).
2. Tests: Kausalität (kein Look-ahead), Negativkontrolle, Reproduzierbarkeit;
   Business: Annahmen mit Bandbreite und Quelle.
3. `pnpm typecheck && pnpm test`.
4. Beim nächsten Start wird das Modul registriert; Experiment im Dashboard anlegen.

## Annahmen eines Geschäftsmodells belegen

Experiment → **Versions → Create a new version** ist für Parameter; Annahmen
mit Quelle über `POST /v1/experiments/:id/versions` mit `assumptions`
(vollständige Liste, `source` = URL). Ab ≥ 50 % belegten Annahmen entfällt der
Score-Deckel für unverifizierte Schätzungen.

## Live-Trading?

Nicht vorgesehen. `READY_FOR_LIVE_REVIEW` ist ein Hinweis für eine manuelle,
gründliche Prüfung. Ein Live-Executor müsste separat entwickelt, geprüft und
freigegeben werden – mit allen Schichten aus `docs/SECURITY.md`.
