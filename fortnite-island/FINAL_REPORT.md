# Abschlussbericht: BANK IT! – Sky Heist

Datum: 25.10.2026

## 1. Gewähltes Spielkonzept und Begründung

**BANK IT! – Sky Heist:** vier Teams, eine schwebende Himmelsstadt, Runden von 4 Minuten. Man sammelt Beute in einen begrenzten Beutel, sichert sie im eigenen Tresor (Combo-Bonus für große Einzahlungen) oder nimmt sie anderen ab: halber Beutel bei einer Eliminierung oder einem Knock-off, 15 % beim Tresor-Raub. Vier Zufalls-Events, eine Heat-Phase mit Jackpot, dauerhafte Level (größerer Beutel, Start-Ausrüstung, Titel) und drei Daily Contracts.

**Warum:** In den Daten erreichen Partyspiele fast die Reichweite der Tycoons, halten Spieler aber nur halb so gut (Top 10: D7 0,11 gegenüber 0,36). Unter den 58 Top-1.000-Inseln, die lange Spielzeit und hohe Retention verbinden, ist nur ein Partyspiel. Sky Heist kombiniert Kurzrunden und Chaos (Pillars-Welle) mit Besitz, Stehlen und dauerhaftem Fortschritt (Steal-Tycoons) und bedient die unterversorgten Tags „duo“, „2v2“ und „party game“, ohne Pillars oder Brainrot zu kopieren. Gewichtete Bewertung über 12 Kriterien: **80,7/100** gegenüber 72,7 für den nächstbesten Kandidaten ([`design/game_concept.md`](design/game_concept.md)).

## 2. Tatsächlich durchgeführte Marktrecherche

- **6.633 Inseln** mit offiziellen Tageskennzahlen aus Epics öffentlicher Fortnite-Data-API (Unique Players, Peak-CCU, Minuten pro Spieler, D1/D7). Dazu **5.107 Inseln** aus 772 Stunden Genre-Ranglisten (13 Genres) und **12.103 Neuerscheinungen** mit ihren ersten 144 Stunden. Zeitraum 19.09.–24.10.2026.
- Weil Epic nur 7 Tage speichert und die Netzwerkrichtlinie dieser Umgebung `api.fortnite.com`, `fortnite.gg` und `dev.epicgames.com` blockiert hat, stammen die Daten aus einem öffentlichen GitHub-Archiv, das die Epic-API alle 15 Minuten sichert (Commit vom 24.10.2026). Die Zahlen selbst sind Epics eigene.
- **Top-1.000-Tabelle** mit Kennzahlen, Quelle und Vertrauensniveau. Titel für 198 dieser Inseln: 155 aus dem Neuerscheinungs-Katalog, 43 per Websuche nach Inselcode mit URL. **Für 802 fehlen Titel**; das ist offen dokumentiert, nichts wurde erfunden.
- Qualitative Analyse der Spielprinzipien für etwa 45 Inseln aus öffentlichen Beschreibungen, gruppiert nach 7 Archetypen.
- Wirtschaftliche Belege: nur die Ökosystem-Summe (Epic: mehr als 1 Mrd. $ Auszahlungen seit 2023) ist belegt. Einnahmen einzelner Inseln sind nicht öffentlich und werden nicht behauptet.

## 3. Erstellte Dateien

Siehe [`README.md` § 1](README.md). Kurz: die Marktanalyse mit 6 Datentabellen und dem Erzeugungsskript, 7 Design-Dokumente, 5 Verse-Dateien (~1.450 Zeilen), der statische Prüfer mit Bericht, das Python-Modell, 76 Tests und die Komplettdatei `UEFN_IMPORT/sky_heist_complete.verse` (alle Module + Bauanleitung, zum direkten Einfügen in UEFN).

## 4. Implementiertes Gameplay (Verse)

| System | Umgesetzt in |
|---|---|
| Rundenablauf: Warten → Pause → Runde → Ergebnis, Join in laufende Runden | `main_game.verse` (`WaitForPlayers`, `RunIntermission`, `RunRound`, `RunResults`) |
| Beute aus Orbs, Safes, Wachen und Jackpot mit Kapazitätsgrenze | `OnOrbCollected`, `OnSafeCracked`, `OnGuardEliminated`, `OnJackpotCracked`, `GiveLoot` |
| Einzahlen mit Combo und Heat-Verdopplung, Team-Tresor | `OnBankZoneEntered`, `BankLoot`, `BankedValue` |
| Stehlen bei Eliminierung, Knock-off-Gutschrift über den letzten Schaden (8 s) | `OnPlayerEliminated`, `OnPlayerDamaged`, `CreditedThief` |
| Tresor-Raub mit Abklingzeit, Schutz des eigenen Teams | `OnVaultInteracted` |
| 4 Zufalls-Events ohne direkte Wiederholung, Heat-Phase | `StartRandomEvent`, `EndEvent`, `StartHeat` |
| Bounty (vollster Beutel bzw. Jackpot-Träger), Marker | `UpdateBountyTarget`, `SetBounty`, `ClearBounty` |
| Level 1–50, Beutelgröße, Start-Ausrüstung, Titel, Runden-XP | `heist_rules.verse`, `AddXP` |
| Daily Contracts (3 pro UTC-Tag, rotierend, ohne Strafen) | `ContractKindsForDay`, `AdvanceContract`, `RefreshDay` |
| Persistenz mit Bereinigung und Obergrenzen | `heist_save.verse`, `heist_player.verse` |
| HUD (Level, XP, Beutel, Team-Tresor, Uhr, Event, Contracts) | `heist_hud.verse` |
| Onboarding-Hinweise, Toasts, Banner, Sounds, VFX, Billboards, Analytics | `Toast`, `AnnounceAll`, Refresh-Funktionen |
| Join, Leave und Respawn ohne doppelte Abos, Schutz vor doppelter Auszahlung, Setup-Validierung | `SubscribeCharacter`, `SafeAvailable`, `JackpotClaimed`, `ValidateSetup` |

## 5. Ergebnisse der real ausgeführten Tests

| Prüfung | Ergebnis |
|---|---|
| Statische Prüfung gegen die Verse-Digests von Fortnite 42.40 | **0 Befunde**, 1.699 Ausdrucksketten, 126 APIs bzw. Felder ([`tools/static_check_report.md`](tools/static_check_report.md)) |
| Mutationstests des Prüfers (20 eingebaute Fehlerklassen) | **21/21** |
| Komplettdatei: aktuell, vollständig, statisch fehlerfrei | **3/3** |
| Paritäts-, Regel- und Szenariotests am Spielmodell | **50/50** |
| Doku-Konsistenz | **2/2** |
| **Gesamt** | **76/76 bestanden** (`python3 -m unittest discover -s tests`, Python 3.13.17) |

Durch diese Prüfungen gefunden und behoben: doppelte Auszahlung bei gleichzeitigem Safe oder Jackpot, zurückgerollte Fehlermeldungen in der Setup-Validierung, fehlendes HUD bei spät bereiter Player-UI, überschriebene Level-up-Meldung, ein `for`-Filter auf eine veränderliche Variable, dazu drei Lücken im Prüfer selbst ([`design/testing_plan.md` § 1.4](design/testing_plan.md)).

## 6. Nicht ausführbare Tests und Gründe

| Test | Grund |
|---|---|
| Verse-Kompilierung | UEFN und der Verse-Compiler laufen nur unter Windows; Epic stellt keinen eigenständigen Compiler bereit. |
| Spielen im Editor, Device-Verhalten, HUD-Darstellung | kein UEFN bzw. Fortnite-Client in der Umgebung |
| Echter Mehrspieler-, Netzwerk- und Plattformtest | kein Client, keine Testkonten |
| Persistenz auf Epic-Servern | nur in Live-Edit- oder veröffentlichten Sessions möglich |
| Memory Calculation, Spatial Profiler | Editor-Werkzeuge |
| Playtests mit echten Spielern | Insel noch nicht gebaut |

Diese Tests sind als T-01 bis T-20 und P1 bis P4 in [`design/testing_plan.md`](design/testing_plan.md) mit erwarteten Ergebnissen beschrieben.

## 7. Noch notwendige manuelle Schritte in UEFN

1. Projekt anlegen, Verse importieren und bauen (T-01)
2. Insel-Einstellungen setzen
3. Welt nach `map_layout.md` bauen
4. ~144 Devices platzieren und konfigurieren
5. Das Device `sky_heist_game` verdrahten (44 Felder, Checkliste)
6. Start-Ausrüstung mit schadensverursachenden Knockback-Items wählen
7. Editor-Tests T-02 bis T-20
8. Memory prüfen
9. Private Playtests

Details: [`README.md` § 3](README.md).

## 8. Bekannte Probleme und Risiken

| Risiko | Wahrscheinlichkeit | Auswirkung | Gegenmaßnahme |
|---|---|---|---|
| Compiler-Fehler aus Klassen, die der Prüfer nicht abdeckt (Typen, Grammatik) | mittel | gering bis mittel (lokal behebbar) | Vorgehen in `testing_plan.md` § 4 |
| API-Änderungen nach 42.40 | gering | mittel | Prüfer gegen den Digest der eigenen UEFN-Version laufen lassen |
| Knockback ohne Schaden → keine Knock-off-Gutschrift | mittel | mittel (Kernmechanik) | Item-Wahl (T-07); notfalls die Steal-Gutschrift nur auf direkte Eliminierungen stützen |
| Diebstahl fühlt sich zu hart an | mittel | Retention | Steal-Quote und Spawn-Schutz anpassen (`launch_strategy.md` § 8) |
| Leere Lobbys zum Start | hoch (für jede neue Insel) | Spaß für Solo-Spieler | Solo-Wachen, persönlicher Rekord, Contracts; `SoloGuardThreshold` |
| Discover-Sichtbarkeit | unbekannt | Reichweite | ehrliche Optimierung von CTR und Retention; Sichtbarkeit ist **nicht** garantiert (49 % aller Neuerscheinungen bleiben unter 5 CCU) |
| Persistenz-Schreibrate undokumentiert | gering | gering | nur am Rundenende speichern |

## 9. Nächste Schritte bis zum ersten veröffentlichungsfähigen Playtest

1. **Tag 1:** Projekt anlegen, Verse bauen (T-01), Compiler-Fehler beheben und hier einpflegen, Prüfer und Tests erneut laufen lassen.
2. **Tag 1–3:** Graybox-Welt (Basen, Mitte, Brücken, Hub) mit einfachen Formen, alle Devices platzieren und verdrahten, Setup-Validierung grün (T-02).
3. **Tag 3–4:** Solo- und 2-Personen-Tests T-03 bis T-15; Knockback-Item festlegen (T-07).
4. **Tag 5–7:** Optik aus Galerien und Prefabs, Teamfarben, Beacon, Sounds; Memory unter 70 %.
5. **Woche 2:** Playtest P1 (intern) und P2 (8–16 Personen), Balance anpassen (Rundenlänge, Steal-Quote, Safe-Zeiten).
6. **Woche 3:** P3 mit privatem Code (30–60 Spieler), Analytics-Trichter auswerten, Thumbnails A und B produzieren.
7. **Release**, wenn: T-01 bis T-20 bestanden, ≥ 80 % erste Einzahlung, ≥ 60 % zweite Runde, keine offenen Blocker. Danach Update-Plan Woche 1–4.

## Qualitätskontrolle aus drei Perspektiven

**Spieler:** Das Ziel ist in Sekunden klar (Beute greifen, einzahlen, klauen). Das erste Erfolgserlebnis kommt in unter einer Minute (Safe neben dem Spawn, Bank-Zone 10–15 m entfernt). Abwechslung entsteht durch 4 Events, die Heat-Phase und wechselnde Rollen (Bounty). Langfristig tragen Level 1–50 und tägliche Contracts. Schwachpunkt bis zum ersten Content-Update: nur eine Map.

**Entwickler:** Die Verse-Logik ist in Regeln, Persistenz, Spielerzustand, HUD und Device-Steuerung getrennt. Jede Event-Registrierung erfolgt einmal oder mit Kündigung. Alle 44 Editor-Felder sind dokumentiert (testgesichert), optionale Devices als Arrays sauber abschaltbar, Pflicht-Devices werden beim Start validiert. Offen ist der echte Build.

**Betreiber:** Es gibt keine irreführenden Belohnungen, keine V-Bucks- oder XP-Versprechen, keine künstliche Knappheit und keine Kopie bestehender Inseln. AFK-Spieler bekommen keine XP. Die Performance ist eingeplant (1-Hz-Loop, keine Ticks, gedeckelte Werte, ~144 Devices, Memory-Ziel unter 70 %). Neue Events, Maps und Freischaltungen lassen sich ohne Umbau ergänzen.
