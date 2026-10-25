# Gameplay-Systeme

Alle Zahlen in diesem Dokument stammen direkt aus [`../Verse/heist_rules.verse`](../Verse/heist_rules.verse) beziehungsweise den `@editable`-Standardwerten in [`../Verse/main_game.verse`](../Verse/main_game.verse). Die Regeln sind 1:1 in [`../tests/heist_model.py`](../tests/heist_model.py) gespiegelt und dort getestet. Ein Paritätstest stellt sicher, dass die Konstanten übereinstimmen.

## 1. Spielschleifen auf drei Ebenen

```
Sekunden   : Beute sehen -> greifen -> "+5" Feedback -> Beutel-Anzeige steigt
Minuten    : Beutel füllen -> Risiko abwägen -> einzahlen (Combo) / stehlen / Tresor ausrauben
             -> Events (alle ~50 s) -> Heat-Phase mit Jackpot -> Rundenende
Sessions   : Runden-XP -> Level (größerer Beutel, bessere Start-Ausrüstung, Titel)
             -> 3 Daily Contracts -> persönlicher Rekord -> nächster Tag: neue Contracts
```

## 2. Rundenablauf (Zustandsmaschine)

```
            ┌────────────────────────────────────────────────────────┐
            v                                                        │
 WaitingForPlayers ──(≥ MinPlayersToStart)──> Intermission (15 s, Hub)
                                                  │
                                                  v
                                   Active (240 s, Teams an den Basen)
                                   ├─ alle 30 s: Loot-Welle
                                   ├─ ab 40 s, alle 50 s: Zufalls-Event (25 s)
                                   └─ letzte 45 s: HEAT
                                                  │
                                                  v
                                       Results (8 s) ──> zurück in den Hub ──┘
```

| Phase | Was Verse tut | Spieler sieht |
|---|---|---|
| WaitingForPlayers | wartet auf `PlayerAddedEvent` | „WAITING FOR PLAYERS“ |
| Intermission | Hub-Spawns an, Basis-Spawns aus, Safes/Tresore aus | „NEXT HEIST IN 15…1“ |
| Active | Basis-Spawns an, Teleport zur Basis, Start-Ausrüstung, Loot-Welle, Solo-Wachen | Uhr `HEIST 3  3:42`, Event-Label |
| Heat | Tresor-Tore offen, Jackpot aktiv, Wachen, Musik, Einzahlungen ×2 | „HEAT x2“ |
| Results | XP, Contracts, Rekord, Speichern, Ergebnistafel | „YOUR TEAM WON! You banked 64 (+99 XP)…“ |

Wer während einer laufenden Runde beitritt, spawnt direkt an der Basis seines Teams (Basis-Spawns sind aktiv) und bekommt sofort seine Ausrüstung. **Es gibt keine Wartezeit auf die nächste Runde.**

## 3. Beute

| Quelle | Wert | Verfügbarkeit | Gerät |
|---|---:|---|---|
| Loot-Orb | 1 (Gold Rush: 2) | alle 30 s neu für alle | `collectible_object_device` |
| Safe | 5 (Gold Rush: 10) | 1× pro Safe und Welle, 3 s halten | `button_device` |
| Tresor-Wache | 8 | während Vault Open, Heat und Solo-Runden | `guard_spawner_device` |
| Jackpot | 25 (darf den Beutel überfüllen) | 1× pro Runde, nur in der Heat | `button_device` |
| Gestohlen | 50 % des Opfer-Beutels (+10 bei Bounty) | bei Eliminierung | Verse |
| Tresor-Raub | 15 % des gegnerischen Tresors, min. 1, max. 30 | 20 s Abklingzeit pro Tresor | `button_device` |

**Beutel (Carry Capacity):** 20, ab Level 2: 25, ab Level 7: 30, ab Level 15: 35. Ist der Beutel voll, erscheint „BAG FULL! Bank it at your vault.“ und weitere Beute verfällt. Das zwingt zur Entscheidung.

## 4. Einzahlen (Bank)

Betritt ein Spieler die Tresor-Zone **seines** Teams, wird der ganze Beutel eingezahlt:

| Eingezahlt auf einmal | Bonus |
|---|---|
| < 10 (ab Level 5: < 8) | 0 |
| ≥ 10 (ab Level 5: ≥ 8) | +20 % |
| ≥ 20 | +50 % |
| in der Heat-Phase | Gesamtwert ×2 |

Beispiele (getestet): 10 → 12 · 20 → 30 · 20 in der Heat → 60.
Die fremde Tresor-Zone zahlt nichts aus („Wrong vault!“).

## 5. Stehlen, Knock-offs und Tresor-Raub

- **Eliminierung:** Das Opfer verliert den ganzen Beutel. Der Eliminierer bekommt 50 % (abgerundet), begrenzt durch seinen eigenen freien Platz. Teamkameraden bekommen nichts.
- **Knock-off in den Abgrund:** Fortnite meldet dann keinen Eliminierer (`EliminatingCharacter` leer). Deshalb merkt sich Verse den letzten Spieler, der Schaden verursacht hat (`DamagedEvent`), und schreibt ihm den Diebstahl gut, wenn der Treffer höchstens **8 s** zurückliegt (`KnockoutCreditSeconds`).
- **Tresor-Raub:** Gegner halten am Tresor-Knopf eines fremden Teams die Interaktion und nehmen 15 % (min. 1, max. 30, höchstens so viel wie in ihren Beutel passt). Danach sperrt der Tresor 20 s. Das bestohlene Team bekommt „YOUR VAULT WAS ROBBED! -X loot“ und einen Alarm. Den eigenen Tresor kann man nicht ausrauben.
- Der **persönliche Fortschritt** (XP, Level, Lebenszeit-Statistik) kann nie gestohlen werden. Raub reduziert nur den Team-Tresor der laufenden Runde.

## 6. Zufalls-Events

Ab Sekunde 40 alle 50 s für jeweils 25 s. Dasselbe Event kommt nie zweimal hintereinander. In der Heat-Phase gibt es keine Events.

| Event | Effekt | Warum |
|---|---|---|
| GOLD RUSH | Orbs und Safes zählen doppelt | Tempo und Gier |
| VAULT OPEN | Tore der Mega-Vault öffnen sich, Wachen spawnen (8 Beute pro Wache) | PvE-Brennpunkt in der Mitte, Begegnungen |
| SAFE STORM | alle Safes wieder verfügbar, Knackzeit halbiert | schnelle Erfolge, auch für Neue |
| BOUNTY HUNT | Der vollste Beutel (≥ 5) wird markiert, sein Eliminierer bekommt +10. Die Markierung wandert weiter, auch auf den Dieb („Hot Potato“). | Jäger-Gejagter-Dynamik, Clips |

**Heat (letzte 45 s):** Einzahlungen zählen doppelt, die Mega-Vault ist offen, der Jackpot (25) ist aktiv und wer ihn knackt, wird markiert. Zum Schluss laufen alle zum Zentrum, so entsteht der Höhepunkt jeder Runde.

## 7. Rundenende und Sieg

- Gewinner ist das Team mit dem höchsten Tresor. Bei Gleichstand gewinnen alle gleichauf liegenden Teams. Hat niemand eingezahlt, gewinnt niemand.
- **Runden-XP** = persönlich eingezahlt + 3/Diebstahl + 5/Tresor-Raub + 2/Safe + 10 Teilnahme (nur bei Aktivität) + 25 Sieg, gedeckelt bei 1.000.
- Ein persönlicher Rekord wird angezeigt („NEW PERSONAL BEST!“). Für Solo-Spieler ist das das wichtigste Ziel.
- Danach folgen 8 s Ergebnis, Rückkehr in den Hub und 15 s Countdown bis zum nächsten Heist.

## 8. Dauerhafter Fortschritt

| Level | XP bis zum nächsten Level | Freischaltung |
|---|---:|---|
| 1 | 100 | Rookie |
| 2 | 140 | Beutel 25 |
| 3 | 180 | Start-Ausrüstung Stufe 2 |
| 5 | 260 | Combo schon ab 8, Titel „Pickpocket“ |
| 7 | 340 | Beutel 30 |
| 10 | 460 | Start-Ausrüstung Stufe 3, Titel „Vault Breaker“ |
| 15 | 660 | Beutel 35 |
| 20 | 860 | Titel „Mastermind“ |
| 35 | 1.460 | Titel „Legend“ |
| 50 | – | Maximalstufe (51.940 XP gesamt) |

Formel: `XP bis zum nächsten Level = 100 + 40 × (Level − 1)`. Level 10 braucht insgesamt 2.340 XP, also etwa 16 bis 30 aktive Runden. Level 50 ist ein Langzeitziel.

**Design-Absicht:** Die Freischaltungen machen das Spiel *komfortabler* (größerer Beutel, bessere Startwaffe), aber nicht unfair. Ein Neuling mit 20 Beutel kann einen Veteranen mit 35 genauso von der Insel schubsen und dabei mehr erbeuten.

## 9. Daily Contracts

Drei Aufgaben pro UTC-Tag aus sechs Typen. Der Satz rotiert über 6 Tage, und an einem Tag kommt nie derselbe Typ doppelt vor.

| Typ | Ziel | Belohnung |
|---|---:|---:|
| Bank loot | 60 Beute einzahlen | 60 XP |
| Steal from players | 3 Diebstähle | 60 XP |
| Rob enemy vaults | 2 Tresor-Raube | 60 XP |
| Crack safes | 5 Safes | 60 XP |
| Win rounds | 1 Sieg | 60 XP |
| Combo banks | 2× Combo-Einzahlung | 60 XP |

Jede Aufgabe zahlt einmal pro Tag. Verpasste Tage haben **keine Folgen**: keine Streaks, keine verfallenden Belohnungen.

## 10. Persistenz

`heist_save` (persistable) speichert pro Spieler: TotalXP, Lebenszeit-Statistik, Runden, Siege, Rekord, Tutorial-Status, Contract-Tag und -Fortschritt. Gespeichert wird beim Einzahlen, beim Abschluss eines Contracts, am Rundenende und beim Verlassen. Alle Werte sind gedeckelt (XP ≤ 100.000.000, Statistiken ≤ 1.000.000.000), beschädigte oder alte Datensätze werden beim Laden bereinigt (getestet).

## 11. Feedback-System

| Ereignis | Sicht | Ton | Effekt |
|---|---|---|---|
| Beute aufgenommen | Toast „+5 from a safe“, HUD-Beutel | PickupSounds | – |
| Beutel voll | Toast, HUD-Beutel orange | – | – |
| Eingezahlt | Toast „BANKED +30 (bonus +10)“, Team-Tresor im HUD, Tresor-Billboard | BankSounds | BankEffects (VFX) |
| Gestohlen | Toast beim Dieb und beim Opfer | StealSounds | – |
| Tresor ausgeraubt | Toast für das ganze Opferteam | VaultAlarms | – |
| Event-Start | Banner (Announcer 1) | EventSounds | Tore, Wachen |
| Heat | Banner, „HEAT x2“ in der Uhr | HeatMusic | Mega-Vault offen |
| Level-up | Toast mit Freischaltung | – | – |
| Rundenende | Zusammenfassung, Ergebnistafel | VictorySounds (Gewinner) | – |

## 12. Sonderfälle und wie sie behandelt werden

| Situation | Verhalten | Test |
|---|---|---|
| Zwei Spieler beenden denselben Safe im selben Frame | Nur der erste wird bezahlt (`SafeAvailable`). | `test_same_safe_cracked_twice_in_one_frame_pays_once` |
| Jackpot doppelt ausgelöst | Wird nur einmal bezahlt (`JackpotClaimed`). | `test_jackpot_pays_once_and_only_in_heat` |
| Respawn | Alte Character-Abos werden vor dem Neuabonnieren gekündigt, sie stapeln sich nie. | `test_respawns_never_stack_subscriptions` |
| Spieler verlässt das Spiel mit Bounty | Die Markierung wird entfernt, Fortschritt gespeichert, Beutel verfällt. | `test_bounty_cleared_when_target_leaves` |
| Späte Events nach Rundenende | Werden ignoriert, alle Handler prüfen `Phase = Active`. | `test_events_outside_active_phase_are_ignored` |
| Eigener Schaden, Umgebungsschaden | Wird niemandem gutgeschrieben. | `test_environment_and_self_damage_do_not_credit` |
| Gegenseitige Eliminierung (Trade) | Konsistent, es entsteht keine Beute aus dem Nichts. | `test_trade_kill_is_consistent` |
| Tageswechsel während einer Session | Contracts werden beim nächsten Rundenstart neu gesetzt. | `test_day_rollover_resets_contracts` |
| Pflicht-Devices fehlen | `ValidateSetup` meldet per `Print`, was fehlt; es starten keine Runden. | `test_missing_essential_devices_disable_rounds` |
| Optionale Devices fehlen (leere Arrays) | Das Feature ist aus, das Spiel läuft weiter. | `test_missing_optional_devices_do_not_break_a_round` |
| Alle Spieler verlassen die Runde | Die Runde endet sofort, danach wird auf Spieler gewartet. | Code: Abbruchbedingung in `RunRound` |

## 13. Erweiterbarkeit (für Updates)

- **Neue Events:** einen Wert in `heist_event` ergänzen, einen Zweig in `StartRandomEvent`/`EndEvent` und ein Label in `EventLabel`.
- **Neue Loot-Quellen:** zusätzliche Device-Arrays mit `GiveLoot(...)`.
- **Neue Maps / Saisons:** dieselbe Verse-Logik, andere Insel-Geometrie. Alle Positionen kommen aus Devices, nicht aus Code.
- **Neue Freischaltungen:** `CarryCapacityForLevel`, `LoadoutTierForLevel` und weitere Granter im Array `StarterLoadouts`.
- **Prestige / Saison-Ränge:** zusätzliches Feld in `heist_save` mit Standardwert (abwärtskompatibel), `CurrentSaveVersion` erhöhen.
