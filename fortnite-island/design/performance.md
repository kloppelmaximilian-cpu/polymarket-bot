# Performance und Skalierbarkeit

Ziel: stabiler Betrieb mit 16 Spielern über lange Sessions auf allen Plattformen. Die Werte unten stammen aus der Code-Analyse von `Verse/*.verse`. **Gemessen** werden können sie erst in UEFN (`testing_plan.md` § 3).

## 1. Verse-Laufzeit

| Bereich | Häufigkeit | Kosten pro Ausführung | Bewertung |
|---|---|---|---|
| Rundenloop (`RunRound`) | 1× pro Sekunde (`Sleep(1.0)`) | O(Spieler): 1 `SetText` je HUD + einige Vergleiche | ≤ 16 Text-Updates/s, unkritisch |
| Countdown (`RunIntermission`) | 1×/s, 15 s | O(Spieler) | unkritisch |
| Warten auf Spieler | ereignisbasiert (`PlayerAddedEvent().Await()`) | 0 im Leerlauf | kein Polling |
| Beute-Handler | pro Aufnahme, Worst Case ~5/s | O(1), bei Bounty Hunt O(Spieler) | unkritisch |
| Einzahlen | pro Einzahlung | O(Basen + Spieler) für Displays + 1 Persistenz-Schreibvorgang | unkritisch |
| Persistenz-Schreibvorgänge | beim Einzahlen, beim Contract-Abschluss, am Rundenende, beim Verlassen | ein kleiner Datensatz (≈ 12 Werte) | Epic veröffentlicht keine Schreibrate. Bei Problemen nur noch am Rundenende speichern (1 Zeile Code je Aufrufstelle) |
| Join / Leave | pro Spieler | O(Spieler) zum Neuaufbau der Maps | selten |
| Per-Frame-Ticks | **keine** | – | bewusst vermieden |

**Event-Abos:** Alle Welt-Devices werden genau einmal in `OnBegin` abonniert (~100 Abos: 24 Basis-, 8 Hub-Spawner-, 48 Orb-, 16 Safe-, 3 Wachen-, 1 Jackpot-Abo, 2 Playspace-Abos). Pro Spieler gibt es genau 2 Character-Abos, vor jedem Neuabonnieren gekündigt (getestet: 25 Respawns → weiterhin 1 Abo).

## 2. Wachstum über lange Sessions

| Daten | Wächst? | Begrenzung |
|---|---|---|
| `States` / `Huds` Maps | nur mit den Spielern in der Session | werden beim Verlassen entfernt |
| `TeamBanked` / `VaultReadyAt` | feste Länge (Anzahl Basen) | jede Runde neu erzeugt |
| XP / Statistiken | ja | gedeckelt (100 Mio. bzw. 1 Mrd.), getestet |
| `RoundNumber` | +1 pro Runde | int (64 Bit). Nach 1 Mio. Runden ≈ 8 Jahre Dauerbetrieb, unkritisch |
| Subscriptions | nein | siehe oben |
| Widgets | 1 Canvas + 9 Textblöcke pro Spieler | beim Verlassen entfernt |

## 3. Devices und Welt

- **~144 Devices**, überwiegend Instanzen von 15 Typen. Memory-Kosten entstehen vor allem pro einzigartigem Typ bzw. Asset, nicht pro Instanz (siehe Quelle S10 und den Tipp „Instanzen statt neuer Devices“).
- **Keine Physik-Objekte**, kein dynamisches Prop-Spawning und keine Verse-gesteuerte Bewegung von Props. Alle beweglichen Elemente sind Barrieren (an/aus) und Guard-Spawner.
- **Wachen:** maximal 3 Spawner à 1–2 KI-Gegner. KI ist teuer, daher sind die Wachen nur bei Events, in der Heat oder in Solo-Runden aktiv und werden danach mit `Despawn()` entfernt.
- **Arena kompakt** (~210 m). Streaming ist voraussichtlich unnötig; Prüfung per Memory Calculation.

## 4. Plattformen

| Plattform | Risiko | Maßnahme |
|---|---|---|
| Mobile | kleine Schrift, Leistung | HUD-Text standardgroß und kontrastreich, wenige Effekte gleichzeitig, VFX nur als kurze Bursts |
| Konsole / Controller | Interaktionen | alle Aktionen sind „Halten zum Interagieren“ oder Laufen in Zonen, keine Maus-UI (HUD nimmt keine Eingaben an: `ui_input_mode.None`) |
| PC | – | – |
| Switch / ältere Geräte | Memory | Memory-Ziel < 70 %, wenige einzigartige Assets |

## 5. Bekannte Risiken

1. **Persistenz-Schreibfrequenz** ist undokumentiert (siehe oben).
2. **Guard-KI in voller Lobby:** In der Heat können bis zu 6 KI-Gegner gleichzeitig aktiv sein. Die Leistung im 16-Spieler-Playtest beobachten; falls nötig 1 statt 2 Wachen pro Spawner.
3. **HUD-Updates jede Sekunde** für alle Spieler: unkritisch nach Analyse, aber in T-18 (16 Spieler) bestätigen.
