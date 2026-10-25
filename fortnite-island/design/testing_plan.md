# Testplan und Testergebnisse

Stand: 25.10.2026. Dieses Dokument trennt strikt zwischen **tatsächlich ausgeführten** Prüfungen und solchen, die **noch im UEFN-Editor oder mit echten Spielern** erfolgen müssen.

## 1. Was in dieser Umgebung tatsächlich ausgeführt wurde

Umgebung: Linux-Container, Python 3.13.17. **Kein UEFN, kein Verse-Compiler, kein Fortnite-Client** (UEFN läuft nur unter Windows; Epic stellt keinen eigenständigen Verse-Compiler bereit).

| # | Prüfung | Werkzeug | Ergebnis (real) |
|---|---|---|---|
| R-1 | Statische API-Prüfung aller 5 Verse-Dateien gegen die offiziellen Digests von Fortnite 42.40 (`++Fortnite+Release-42.40-CL-59247843`) | `tools/verse_static_check.py` | **0 Befunde.** 1.699 Ausdrucksketten analysiert, 177 Digest-Aufrufe und 242 Projekt-Aufrufe aufgelöst, 126 verschiedene APIs bzw. Felder referenziert. Bericht: [`../tools/static_check_report.md`](../tools/static_check_report.md) |
| R-2 | Mutationstests des Prüfers: 18 absichtlich eingebaute Fehlerklassen müssen erkannt werden, das unveränderte Projekt darf keinen Fehler zeigen. | `tests/test_static_checker.py` | **19/19 bestanden** |
| R-3 | Paritätstests: Python-Modell und `heist_rules.verse` haben identische Konstanten und Funktionen. | `tests/test_heist_model.py::RuleParityTests` | **2/2 bestanden** |
| R-4 | Regel- und Szenariotests am Python-Modell der Spiellogik | `tests/test_heist_model.py` | **48/48 bestanden** |
| R-5 | Doku-Konsistenz: alle 44 `@editable`-Felder in `device_setup.md` erklärt, alle Verse-Dateien in der README | `tests/test_docs_consistency.py` | **2/2 bestanden** |
| | **Gesamt** | `python3 -m unittest discover -s tests` | **71/71 bestanden** |

Befehle zum Nachvollziehen:

```bash
python3 tools/verse_static_check.py <digest-dir> Verse --report tools/static_check_report.md
VERSE_DIGEST_DIR=<digest-dir> python3 -m unittest discover -s tests -v
```

### 1.1 Was der statische Prüfer abdeckt

- Existenz jedes Members (Methode, Feld, Event) auf dem aufgelösten Typ, inklusive Vererbung und Extension-Methoden
- Effekt-Spezifizierer: `<decides>` nur mit `[]`, `[]` nur bei `<decides>`, `<suspends>` nur aus suspendierenden Funktionen, keine Aufrufe ohne Rollback-Fähigkeit aus `<transacts>`-Funktionen oder Bedingungen
- Fehlbare Ausdrücke (Map- und Array-Zugriffe, Casts, `<decides>`-Aufrufe) nur in Fehlerkontexten (`if (…)`, `for (…)`, `<decides>`-Funktionen)
- `set` nur auf `var`-Felder und `var`-Locals
- `using`-Importe für jeden Digest-Typ, jede freie Funktion und jede Extension-Methode
- `@experimental` (würde das Veröffentlichen blockieren) und `@deprecated`
- Parameteranzahl bei Aufrufen, Feldnamen in Archetypen (`Type{Field := …}` und die eingerückte Form), Enum-Werte, `NamedColors`
- Format: Tabs, Einrückung, unausgeglichene Klammern und Anführungszeichen, `if`/`for`-Syntax

### 1.2 Was der statische Prüfer **nicht** abdeckt (Restrisiko)

- **Typkompatibilität von Argumenten.** Beispiel: `string` statt `message` würde nicht erkannt. Manuell geprüft: Alle Device-Aufrufe mit `message` nutzen `GameText()`/`HudText()`.
- Vollständige Verse-Grammatik und Präzedenz, Shadowing-Regeln, Typinferenz bei Overloads nach Typ, Variance, Effekt-Untertypisierung im Detail
- Verhalten der Devices zur Laufzeit (siehe § 3)
- Neuere UEFN-Versionen als 42.40: Die Digests für 43.x/44.x waren nicht öffentlich gespiegelt. APIs werden selten entfernt, das Risiko ist gering, aber vorhanden.

**Deshalb gilt: „0 Befunde“ heißt „konsistent mit der Digest-API und den geprüften Regeln“, nicht „kompiliert“.** Der echte Build in UEFN steht noch aus (§ 2, T-01).

### 1.3 Was die Modelltests belegen

Das Python-Modell (`tests/heist_model.py`) bildet `heist_rules.verse` 1:1 nach und die Handler und den Rundenablauf von `main_game.verse` sehr eng. Die Tests belegen, dass **Design und Algorithmen** wie beabsichtigt funktionieren. Sie belegen **nicht**, dass Devices in Fortnite exakt wie die Stubs reagieren.

| Gefordertes Szenario | Abgedeckt durch |
|---|---|
| Einzelspielerstart | `test_single_player_start`, `test_first_success_within_first_minute` |
| Mehrere Spieler treten gleichzeitig bei | `test_many_players_join_at_once` (16 Spieler) |
| Respawn und Eliminierung | `test_respawns_never_stack_subscriptions` (25 Respawns), `CombatTests` (7 Tests) |
| Rundenstart und Rundenende | `test_round_end_awards_xp_once_and_resets_next_round`, `test_tie_means_both_teams_win`, `test_nobody_banked_nobody_wins` |
| Gleichzeitige Events | `SimultaneousEventTests` (7 Tests: doppelter Safe, doppelter Jackpot, doppeltes Betreten, Heat während eines Events …) |
| Fortschritt und Belohnungen | `RuleTests`, `test_level_up_increases_capacity`, `test_contract_completes_once_per_day` |
| Neustart und Zurücksetzen | `test_rejoin_keeps_progress`, `test_day_rollover_resets_contracts`, Reset in `test_round_end_…` |
| Fehlende Device-Referenzen | `test_missing_essential_devices_disable_rounds`, `test_missing_optional_devices_do_not_break_a_round` |
| Unvollständige Aktionen und ungewöhnliche Zustände | `test_events_outside_active_phase_are_ignored`, `test_bounty_cleared_when_target_leaves`, `test_corrupt_or_old_save_is_sanitised`, `test_leaver_cannot_be_saved_after_leaving`, `test_long_session_values_stay_bounded` (300 Runden) |

### 1.4 Fehler, die durch Tests und Reviews gefunden und behoben wurden

| Fehler | Gefunden durch | Behebung |
|---|---|---|
| Zwei Spieler knacken denselben Safe im selben Frame → doppelte Auszahlung | Szenario-Entwurf | `SafeAvailable`-Flags |
| Doppelt ausgelöster Jackpot → doppelte Auszahlung | Szenario-Entwurf | `JackpotClaimed` |
| `Print`-Meldungen in `<decides>`-Validierung wären zurückgerollt worden | Code-Review | `ValidateSetup()` gibt `logic` zurück |
| HUD erscheint nicht, wenn die Player-UI beim Join noch nicht bereit ist | Code-Review | `Show()` idempotent, zusätzlich beim Spawn aufgerufen |
| Level-up-Meldung wurde am Rundenende durch die Ergebnismeldung überschrieben | Code-Review | Level-up wird in die Ergebnismeldung integriert; optionaler zweiter Announcer für Banner |
| Filter auf veränderliche Variable im `for`-Kopf (Bounty-Suche) | Code-Review | Vergleich in den Schleifenkörper verschoben |
| Prüfer-Lücken: verschachtelte Argumente, Feld-Standardwerte und Archetyp-Felder wurden nicht geprüft | Mutationstests | Prüfer erweitert, Mutationstests ergänzt |

## 2. Tests im UEFN-Editor (noch durchzuführen)

Voraussetzung: Aufbau nach `device_setup.md`. Für Mehrspieler-Tests eine private Session mit Testkonten starten.

| ID | Test | Schritte | Erwartet |
|---|---|---|---|
| **T-01** | **Verse-Build** | Verse → Build Verse Code | 0 Fehler. Bei Fehlern siehe § 4. |
| T-02 | Setup-Validierung | Session starten, Log ansehen | Keine Meldung „setup incomplete“. Test mit absichtlich leerem `HubTeleporters`: Meldung erscheint, keine Runde startet. |
| T-03 | Solo-Start | allein starten | Hub, Countdown 15 s, Teleport zur Basis, Start-Ausrüstung, Wachen spawnen, HUD sichtbar |
| T-04 | Erstes Erfolgserlebnis | Safe knacken, Orb nehmen, einzahlen | Toasts „+5 from a safe“, „+1 loot“, Hinweis bei 5 Beute, „BANKED +6“ in < 60 s |
| T-05 | Falscher Tresor | in die gegnerische Bank-Zone laufen | „Wrong vault!“, keine Einzahlung |
| T-06 | Combo und Heat | 10 bzw. 20 einzahlen, in der Heat einzahlen | +20 % / +50 % / ×2 |
| **T-07** | **Knock-off-Gutschrift** | Gegner mit vollem Beutel per Knockback-Item in den Abgrund stoßen | Angreifer bekommt 50 %. **Wenn nicht:** Das Item verursacht keinen Schaden, also ein anderes Item wählen. |
| T-08 | Direkte Eliminierung | Gegner eliminieren | 50 % Diebstahl, Toast bei beiden |
| T-09 | Respawn-Stabilität | 10× sterben | genau eine Diebstahl-Gutschrift pro Tod, keine doppelten Toasts |
| T-10 | Tresor-Raub | gegnerischen Tresor 4 s halten | 15 %, Alarm, Banner beim Opferteam, 20 s Sperre |
| T-11 | Eigener Tresor | eigenen Tresor halten | „That's YOUR vault“, keine Änderung |
| T-12 | Events | eine Runde komplett spielen | alle 50 s ein Event, nie dasselbe zweimal hintereinander. Safe Storm halbiert und stellt Zeiten wieder her. Vault Open öffnet und schließt die Tore. |
| T-13 | Jackpot | in der Heat 2 Spieler gleichzeitig | einmalige Auszahlung, Marker auf dem Gewinner |
| T-14 | Rundenende | Runde auslaufen lassen | Ergebnis-Toast, Ergebnistafel, Teleport in den Hub, neuer Countdown |
| T-15 | Persistenz | Level aufsteigen, Session verlassen, neu beitreten | Level, XP, Contracts und Tutorial-Status bleiben erhalten |
| T-16 | Join in Progress | 2. Konto tritt mitten in der Runde bei | spawnt an der Teambasis mit Ausrüstung |
| T-17 | Spieler verlässt mit Bounty | markierter Spieler verlässt das Spiel | Marker verschwindet |
| T-18 | 16 Spieler | volle Lobby (Testkonten oder Playtest-Gruppe) | keine Verzögerung bei Toasts und HUD, Teams korrekt |
| T-19 | Leere Session | alle verlassen mitten in der Runde | Runde endet, Insel wartet auf Spieler |
| T-20 | Langzeit | 60 Minuten durchspielen | kein Speicheranstieg (Spatial Profiler), HUD korrekt, keine Log-Fehler |

## 3. Performance-Prüfung (Editor)

| Prüfung | Werkzeug | Ziel |
|---|---|---|
| Memory | Project → Memory Calculation; Ergebnisse im Message Log | < 70 % der Anzeige (100.000 Einheiten) |
| Laufzeit-Speicher | Spatial Profiler in einer Live-Edit-Session | kein stetiger Anstieg über 60 Minuten |
| Verse-Kosten | Verse-Profiling bzw. Log-Zeiten | Der Rundenloop tickt 1×/s; keine Tick-Schleifen, keine Spitzen beim Event-Start |
| Netzwerk / Spieler | 16-Spieler-Playtest | keine Rubberbanding-Beschwerden; Toasts kommen sofort |
| Plattformen | Playtest auf PC, Konsole, Mobile, Controller | HUD lesbar (linker Rand 1,5 %), Interaktionen mit Controller gut erreichbar |

Details zur Laufzeit-Analyse: [`performance.md`](performance.md).

## 4. Vorgehen bei Verse-Compiler-Fehlern

1. Fehlermeldung vollständig kopieren (Datei, Zeile, Code).
2. Die Ursache ist wahrscheinlich eine dieser Klassen, die der statische Prüfer nicht abdeckt (§ 1.2): Typ-Inkompatibilität, Shadowing, Grammatik-Feinheiten oder eine API-Änderung nach 42.40.
3. Den Digest der **eigenen** UEFN-Version vergleichen: `Fortnite.digest.verse` liegt im Projekt unter dem Verse-Ordner bzw. im UEFN-Installationsverzeichnis. Den Prüfer gegen genau diesen Digest erneut laufen lassen.
4. Fix in **dieser** Repository-Version einpflegen, Prüfer und Tests erneut ausführen, dann in UEFN neu kopieren.

## 5. Tests mit echten Spielern

### 5.1 Phasen

| Phase | Wer | Umfang | Ziel |
|---|---|---|---|
| P1 Intern | 2–4 Personen | 3 Sessions à 30 min | Bugs, Verständlichkeit, erste Balance |
| P2 Freunde & Familie | 8–16 Personen, gemischte Plattformen | 2 Sessions à 45 min, mindestens 1 volle Lobby | Gruppendynamik, Diebstahl-Frust und -Spaß, Performance |
| P3 Private Code | 30–60 Personen (Discord/Community) | 1 Woche, privater Inselcode | erste Kennzahlen, Retention-Signal |
| P4 Release | öffentlich | ab Woche 0 | Kennzahlen laut `launch_strategy.md` |

### 5.2 Was beobachtet und gefragt wird

- **Beobachten (P1/P2, ohne Erklärung vorab):** Sekunden bis zur ersten Einzahlung; ob der Spieler den Tresor-Raub selbst entdeckt; wo Spieler stehen bleiben oder suchen.
- **Fragen danach (1–5-Skala + offen):**
  1. Wusstest du in den ersten 30 Sekunden, was zu tun ist?
  2. Wie unfair fühlte sich gestohlen werden an?
  3. Was war dein bester Moment? (Clip-Kandidaten sammeln)
  4. Würdest du morgen wieder spielen, und warum (nicht)?
  5. Würdest du die Insel Freunden schicken?

### 5.3 Abbruchkriterien und Erfolgsschwellen (P3)

| Signal | Schwelle | Bei Unterschreitung |
|---|---|---|
| Erste Einzahlung (Analytics `first_bank`) / Spieler | ≥ 80 % | Onboarding verkürzen, Safe näher an den Spawn |
| Zweite Runde (`second_round`) / Spieler | ≥ 60 % | Pause zwischen den Runden kürzen, Ergebnis-Belohnung sichtbarer machen |
| „Gestohlen werden ist unfair“ (≥ 4 von 5) | < 30 % | Steal-Quote 50 → 40 %, Spawn-Schutz, Deckung auf den Brücken |
| D1 (Epic-Analytics) | ≥ 0,25 | siehe Maßnahmen in `launch_strategy.md` § 8 |
