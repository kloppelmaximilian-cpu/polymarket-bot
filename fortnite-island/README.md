# BANK IT! – Sky Heist (Fortnite / UEFN)

Ein rundenbasiertes Heist-Partyspiel für Fortnite Creative (UEFN). Vier Teams sammeln auf schwebenden Inseln Beute, sichern sie im eigenen Tresor und schubsen Gegner von der Insel, um ihnen den halben Beutel abzunehmen. Dazu kommen dauerhafter Fortschritt (Level, größerer Beutel, Start-Ausrüstung, Titel) und drei Daily Contracts pro Tag.

> **Ehrlicher Stand in einem Satz:** Recherche, Konzept, Bauplan und der vollständige Verse-Code sind fertig und statisch gegen die offizielle Verse-API (Fortnite 42.40) geprüft, die Spiellogik ist mit 71 Tests am Python-Modell abgesichert. **Nicht** passiert ist: Kompilieren in UEFN, Bauen der 3D-Welt und Spielen im Editor. UEFN ist in dieser Umgebung nicht verfügbar.

Dieser Ordner liegt im Repository `polymarket-bot`, weil es kein Fortnite-Projekt gab. Er ist vollständig eigenständig und berührt den Bot-Code nicht.

---

## 1. Erstellte Dateien

| Datei | Inhalt |
|---|---|
| [`research/fortnite_market_analysis.md`](research/fortnite_market_analysis.md) | Marktanalyse: 6.633 Inseln mit offiziellen Kennzahlen, Top 50, Genres, Tag-Nachfrage, Launch-Realität, Spielprinzipien, Designprinzipien |
| [`research/datasets/island_metrics_top1000.csv`](research/datasets/island_metrics_top1000.csv) | Top-1.000-Inseln mit Kennzahlen, Quelle, Abrufdatum und Vertrauensniveau |
| `research/datasets/genre_summary.csv`, `tag_demand.csv`, `launch_outcomes.csv`, `summary.json` | Auswertungen |
| [`research/datasets/title_lookup.csv`](research/datasets/title_lookup.csv) | 43 per Inselcode ermittelte Titel mit URL und Vertrauen |
| [`research/datasets/sources.csv`](research/datasets/sources.csv) | alle Quellen mit Datum, Verwendung und Zuverlässigkeit |
| [`research/scripts/build_market_dataset.py`](research/scripts/build_market_dataset.py) | reproduzierbare Erzeugung aller Tabellen |
| [`design/game_concept.md`](design/game_concept.md) | 6 Konzepte, gewichtete Bewertung, Auswahl, USP, Clip-Momente |
| [`design/gameplay_systems.md`](design/gameplay_systems.md) | alle Regeln, Zahlen, Events, Fortschritt, Sonderfälle |
| [`design/map_layout.md`](design/map_layout.md) | Bauplan der Insel: Zonen, Distanzen, Spawns, Device-Positionen, Budget |
| [`design/device_setup.md`](design/device_setup.md) | **exakte Verdrahtung** aller Devices und Insel-Einstellungen |
| [`design/testing_plan.md`](design/testing_plan.md) | ausgeführte Tests mit Ergebnissen, Editor-Testfälle T-01 bis T-20, Playtest-Plan |
| [`design/performance.md`](design/performance.md) | Laufzeit- und Speicheranalyse, Risiken |
| [`design/launch_strategy.md`](design/launch_strategy.md) | Titel, Beschreibung, Thumbnails, Trailer, Clips, Update-Plan, KPIs mit Maßnahmen |
| [`Verse/main_game.verse`](Verse/main_game.verse) | Haupt-Device `sky_heist_game`: Rundenablauf, Events, Beute, Einzahlen, Stehlen, Tresor-Raub, Bounty, HUD-Anbindung |
| [`Verse/heist_rules.verse`](Verse/heist_rules.verse) | reine Spielregeln (Level-Kurve, Boni, Steal-/Raub-Mengen, Contracts) |
| [`Verse/heist_player.verse`](Verse/heist_player.verse) | Laufzeit-Zustand pro Spieler |
| [`Verse/heist_save.verse`](Verse/heist_save.verse) | persistenter Spielstand (`weak_map(player, heist_save)`) |
| [`Verse/heist_hud.verse`](Verse/heist_hud.verse) | HUD mit Verse UI |
| [`tools/verse_static_check.py`](tools/verse_static_check.py) | statischer Prüfer gegen Epics Verse-Digests |
| [`tools/static_check_report.md`](tools/static_check_report.md) | letzter Prüfbericht (0 Befunde) |
| [`tests/heist_model.py`](tests/heist_model.py) | ausführbares Python-Modell der Spiellogik |
| `tests/test_heist_model.py`, `tests/test_static_checker.py`, `tests/test_docs_consistency.py` | 71 Tests |
| [`FINAL_REPORT.md`](FINAL_REPORT.md) | Abschlussbericht |

## 2. Feature-Status

| Feature | Status | Abhängigkeit | Teststatus |
|---|---|---|---|
| Kern-Gameplay (Beute, Beutel, Einzahlen, Combo) | **implementiert** (Verse) | Devices: Button, Collectible, Mutator Zone | statisch geprüft ✔ · Modelltests ✔ · im Editor **offen** (T-03 bis T-06) |
| Stehlen und Knock-off-Gutschrift | **implementiert** | `fort_character`-Events, Knockback-Items mit Schaden | statisch ✔ · Modell ✔ · Editor **offen** (T-07/T-08); Item-Wahl muss Schaden verursachen |
| Tresor-Raub mit Abklingzeit | **implementiert** | Button pro Basis | statisch ✔ · Modell ✔ · Editor **offen** (T-10/T-11) |
| Zufalls-Events (4) + Heat + Jackpot | **implementiert** | Barrier, Guard-Spawner, Button, Player-Marker | statisch ✔ · Modell ✔ · Editor **offen** (T-12/T-13) |
| Fortschrittssystem (Level 1–50, Beutel, Ausrüstung, Titel) | **implementiert** | Item-Granter (3 Stufen), Persistenz | statisch ✔ · Modell ✔ · Persistenz im Live-Betrieb **offen** (T-15) |
| Daily Contracts | **implementiert** | `GetSecondsSinceEpoch` | statisch ✔ · Modell ✔ · Editor **offen** |
| HUD (Verse UI) | **implementiert** | Verse UI | statisch ✔ · Darstellung **offen** (T-03) |
| Multiplayer (4 Teams, Join in Progress, Leave) | **implementiert** (Verse) / **offen** (Insel-Einstellungen) | UEFN-Konfiguration (Teams, Spawns) | Modell: 16 gleichzeitige Joins ✔ · echter Mehrspielertest **offen** (T-16/T-18) |
| Runde und Respawn | **implementiert** | Player-Spawner, Teleporter, Insel-Respawn | Modell ✔ (Respawn-Abos, Rundenreset) · Editor **offen** (T-09/T-14) |
| Setup-Validierung / fehlende Devices | **implementiert** | – | Modell ✔ · Editor **offen** (T-02) |
| Analytics-Trichter | **implementiert** (optional) | Analytics-Devices | Editor **offen** |
| 3D-Welt (Geometrie, Assets, Platzierung) | **offen** – nur Bauplan | UEFN-Editor | – |
| Kompilieren in UEFN | **offen** | UEFN (Windows) | **nicht ausgeführt** |

## 3. Manuelle Schritte in UEFN (Reihenfolge)

1. **Projekt anlegen**, die 5 Verse-Dateien importieren und bauen: [`device_setup.md` § 0](design/device_setup.md).
2. **Insel-Einstellungen** setzen (4 Teams, 16 Spieler, Spawn Pads, Join in Progress, kein Bauen): [`device_setup.md` § 1](design/device_setup.md).
3. **Welt bauen** nach [`map_layout.md`](design/map_layout.md): Hub, 4 Basen, 4 Loot-Inseln, Mega Vault, Brücken, Abgrund. Galerien und Prefabs aus UEFN.
4. **Devices platzieren** (~144, Liste in `map_layout.md` § 6) und **konfigurieren** ([`device_setup.md` § 3–4](design/device_setup.md)).
5. **`sky_heist_game` verdrahten:** alle Arrays im Details-Panel füllen ([`device_setup.md` § 2–3](design/device_setup.md), Checkliste § 5).
6. **Start-Ausrüstung** wählen: Knockback-Items, die Schaden verursachen (Test T-07).
7. **Editor-Tests T-01 bis T-20** durchführen ([`testing_plan.md` § 2](design/testing_plan.md)).
8. Memory Calculation prüfen (Ziel < 70 %).
9. Privater Playtest (P1/P2), dann Veröffentlichung nach [`launch_strategy.md`](design/launch_strategy.md).

## 4. Benötigte Devices und Assets

**Devices** (alle Standard-UEFN-Devices, Verse-APIs gegen Digest 42.40 geprüft): `mutator_zone_device` (Bank-Zonen, Hub-Schutz), `button_device` (Tresore, Safes, Jackpot), `teleporter_device` (Rundenstart, Hub), `player_spawner_device` (Hub, Basen), `collectible_object_device` (Orbs), `guard_spawner_device` (Wachen), `barrier_device` (Tore), `player_marker_device` (Bounty), `item_granter_device` (Start-Ausrüstung), `hud_message_device` (Toasts, Banner), `billboard_device`, `vfx_spawner_device`, `audio_player_device`, `score_manager_device` (optional), `analytics_device` (optional), `damage_volume_device` (Abgrund), `beacon_device`.

**Assets:** nur die in UEFN enthaltenen Fortnite-Galerien, Prefabs, Effekte und Sounds. Keine externen oder geschützten Inhalte.

## 5. Verse importieren und kompilieren

1. In UEFN: **Verse → Verse Explorer → Rechtsklick auf den Projektordner → Create New Verse File**, je eine Datei mit exakt diesen Namen: `heist_rules.verse`, `heist_save.verse`, `heist_player.verse`, `heist_hud.verse`, `main_game.verse`.
2. Den Inhalt aus `Verse/` dieses Repositorys einfügen. Alle Dateien müssen im **selben** Ordner liegen (gleiches Modul).
3. **Verse → Build Verse Code**. Bei Fehlern: [`testing_plan.md` § 4](design/testing_plan.md).
4. Das Device `sky_heist_game` aus dem Content Browser in die Welt ziehen.

## 6. Referenzen im Editor zuweisen

`sky_heist_game` auswählen und im **Details-Panel**:

- **Bases:** 4 Einträge hinzufügen (Reihenfolge = Team 1–4). Je Eintrag BankZone, VaultButton, RoundStartTeleporter, 4× BaseSpawners sowie optional Billboard, VFX und Alarm.
- **HubSpawners**, **HubTeleporters** (Pflicht), dann LootOrbs, Safes, VaultGuards, VaultGates, JackpotButtons, BountyMarkers, StarterLoadouts (Index 0/1/2), Announcers (0 = Toasts, 1 = Banner), Sounds, Billboards, Analytics.

Jedes der 44 Felder ist in [`design/device_setup.md`](design/device_setup.md) erklärt (ein Test stellt das sicher). Fehlen Pflicht-Devices, schreibt das Device beim Start ins Log, was fehlt, und startet keine Runden.

## 7. Erster Playtest

1. **Launch Session** im Editor, allein: T-02 bis T-06 (Hub → Countdown → Basis → Safe → Einzahlen).
2. Mit einem zweiten Konto bzw. einer zweiten Person: T-07 bis T-11 (Stehlen, Knock-off, Tresor-Raub).
3. Eine volle Runde inklusive Heat (T-12 bis T-14), danach verlassen und neu beitreten (T-15, Persistenz).
4. Beobachtungen und Fragen aus [`testing_plan.md` § 5](design/testing_plan.md) notieren.

## 8. Prüfungen in diesem Repository reproduzieren

```bash
# Verse-API-Digests (Fortnite 42.40) besorgen
git clone --depth 1 https://github.com/vz-creates/uefn digests
# Statische Prüfung
python3 tools/verse_static_check.py digests/Modules/FortniteGame Verse --report tools/static_check_report.md
# Alle Tests (Modell, Prüfer-Mutationen, Doku-Konsistenz)
VERSE_DIGEST_DIR=digests/Modules/FortniteGame python3 -m unittest discover -s tests -v
# Marktdaten neu erzeugen (Archiv der Epic Data API)
git clone --depth 1 https://github.com/Chawewo/fortniteDiscoveryTracker tracker
python3 research/scripts/build_market_dataset.py tracker/data research/datasets
```

Python 3.11+ und nur die Standardbibliothek.

## 9. Offene Punkte und Einschränkungen

1. **Nicht in UEFN kompiliert.** Der statische Prüfer deckt API-Existenz, Effekte, Fehlerkontexte, `set`/`var`, Importe und Archetyp-Felder ab, aber keine vollständige Typprüfung der Argumente und keine komplette Grammatik ([`testing_plan.md` § 1.2](design/testing_plan.md)).
2. **Digest-Version 42.40.** Neuere UEFN-Versionen (43.x/44.x) waren nicht öffentlich gespiegelt. API-Entfernungen sind selten, aber möglich.
3. **3D-Welt nicht gebaut.** Es gibt nur den Bauplan.
4. **Device-Laufzeitverhalten ungeprüft**, vor allem: ob Knockback-Items `DamagedEvent` auslösen (T-07), ob `hud_message_device.Show(Agent, …)` nur dem Spieler angezeigt wird, und das Respawn-Verhalten von Collectibles mit `RespawnForAll`.
5. **Optionsnamen im Details-Panel** stammen aus Erfahrungswissen, nicht aus einer in dieser Umgebung prüfbaren Quelle. Die Absicht jeder Einstellung ist beschrieben.
6. **Persistenz-Schreibrate:** Epic veröffentlicht keine Grenze; bei Problemen nur noch am Rundenende speichern.
7. **Marktdaten:** Für 802 der Top-1.000-Inseln fehlen Titel (Netzwerkrichtlinie dieser Umgebung, siehe Marktanalyse § 11). Discover-Platzierungen, Klickraten und Einnahmen sind öffentlich nicht verfügbar.
