# Map-Layout: „Cloud Quarter“

> **Wichtige Grenze:** Diese Datei ist ein Bauplan. In dieser Arbeitsumgebung gibt es keinen UEFN-Editor, deshalb wurde **keine** Geometrie gebaut oder platziert. Alle Maße sind Planwerte, die im ersten Playtest feinjustiert werden. Ein Fortnite-Bauraster entspricht 512 UE-Einheiten = 5,12 m („Kachel“).

## 1. Übersicht (Draufsicht, nicht maßstäblich)

```
                               N
                     ┌───────────────────┐
                     │  RED BASE (Team 1)│
                     │  Spawn ▢▢▢▢       │
                     │  [Bank] [Vault]   │
                     └────────┬──────────┘
            Islet NW  ◇───────┤        ├───────◇  Islet NE
                 \            │ Brücke │            /
  ┌──────────────┐ \    ┌─────┴────────┴─────┐    / ┌──────────────┐
  │ GOLD BASE (4)│──────│   MEGA VAULT       │──────│ BLUE BASE (2)│
W │ [Vault][Bank]│      │  ╔═══ Tore ═══╗    │      │ [Bank][Vault]│ E
  │ Spawn ▢▢▢▢   │      │  ║ Jackpot ★  ║    │      │   ▢▢▢▢ Spawn │
  └──────────────┘ /    │  ╚════════════╝    │    \ └──────────────┘
                 /      │ Wachen ☗ ☗ ☗ Beacon│     \
            Islet SW  ◇─┴────────┬───────────┴─◇  Islet SE
                                 │
                     ┌───────────┴───────┐
                     │  [Vault] [Bank]   │
                     │  Spawn ▢▢▢▢       │
                     │ GREEN BASE (3)    │
                     └───────────────────┘
                               S
                 (darunter: Abgrund + Eliminierungs-Volumen)

        HUB „Hideout“: eigene Plattform, ~120 m westlich und 30 m höher,
        außerhalb der Arena (kein Sichtkontakt nötig)
```

## 2. Zonen

| Zone | Größe (Plan) | Höhe (relativ) | Zweck |
|---|---|---|---|
| **Hub „Hideout“** | 6 × 6 Kacheln (~31 × 31 m) | +30 m, abseits | Sicherer Ein- und Wiedereinstieg, Countdown, Ergebnistafel, „How to play“-Tafel, Übungsziele |
| **Teambasis ×4** | 5 × 5 Kacheln (~26 × 26 m) | 0 m (N/S), +4 m (O/W) | Spawn, Einzahlen, Tresor verteidigen, 2 Start-Safes |
| **Loot-Inseln ×4** (NW/NO/SW/SO) | 3 × 3 Kacheln | −3 bis +6 m | Safes und Orbs zwischen den Basen, Begegnungspunkte |
| **Mega Vault (Zentrum)** | 8 × 8 Kacheln (~41 m) | +2 m | Event-Brennpunkt: Wachen, Jackpot, Beacon |
| **Brücken** | 1 Kachel breit, 6–8 Kacheln lang | variabel | Wege mit Absturzgefahr (Knock-off-Momente) |
| **Abgrund** | unter der gesamten Arena | −40 m | Eliminierungs-Volumen (Schaden), schneller Respawn |

### Distanzen (Planwerte, Sprint ≈ 6–7 m/s)

| Von → nach | Distanz | Sprintzeit |
|---|---:|---:|
| Basis-Spawn → eigene Bank-Zone | 10–15 m | 2 s |
| Basis-Spawn → erster Safe | 6–10 m | 1–2 s |
| Basis → Mega Vault | ~60 m | 9–10 s |
| Basis → Nachbarbasis (über Loot-Insel) | ~85 m | 13–14 s |
| Bank-Zone → eigener Tresor-Knopf | 6–8 m | sichtbar, gut zu verteidigen |

Mit 240 s pro Runde schafft man 8 bis 12 Wege zwischen Beute und Tresor. Jede Fahrt ist ein Risiko-Moment.

## 3. Spawnpunkte und sichere Einstiege

- **Hub:** 8 `player_spawner_device` ohne Team-Bindung (Einstieg zwischen den Runden). Im Hub kann man nicht kämpfen (Mutator-Zone ohne Waffenschaden, siehe `device_setup.md`).
- **Basen:** je 4 `player_spawner_device` mit Team-Bindung (Team 1–4), nur während einer Runde aktiv. Sie stehen hinter einer flachen Deckung, damit niemand direkt beim Spawn beschossen wird.
- **Spawnschutz (Empfehlung):** 2–3 s Unverwundbarkeit über die Respawn-Einstellungen der Insel. Ob das ohne Ausnutzbarkeit funktioniert, ist ein Punkt im Playtest.

## 4. Orte von Interesse und Begegnungen

| Ort | Was dort passiert | Clip-Potenzial |
|---|---|---|
| **Mega Vault** | Vault Open: Wachen. Heat: Jackpot. Beacon ist von überall sichtbar. | Gedränge am Jackpot, letzte Sekunde |
| **Loot-Inseln** | 2 Safes, 6 Orbs je Insel, Konfliktpunkt zwischen zwei Basen | Hinterhalte, Knock-offs |
| **Brücken** | kein Geländer auf einer Seite, wenig Deckung | Sky-Yoink |
| **Tresor-Knopf jeder Basis** | hinter der Bank-Zone, von der eigenen Basis einsehbar | Vault-Heist-Reaktionen |
| **Sprungpads** (je Basis 1 Richtung Zentrum) | schneller Weg zum Zentrum, landet offen | Abfangen in der Luft |

## 5. Orientierung

- **Farbcodes:** jede Basis in Teamfarbe (Rot/Blau/Grün/Gold) über Beleuchtung, Banner und eine leuchtende Bank-Zone (Effekt der Mutator-Zone oder eines VFX-Spawners).
- **Beacon** über der Mega Vault (`beacon_device`), der Richtung Mitte zeigt.
- **Billboards:** Tresorstand über jedem Tresor („RED VAULT: 140“), Ergebnistafel im Hub.
- **Map-Indikatoren** (optional): Mega Vault als Ziel während der Heat.
- **Vertikalität:** Ost- und Westbasis 4 m höher, damit die Basen auch aus der Ferne unterscheidbar sind.

## 6. Platzierung aller Devices (Zusammenfassung)

Details und Einstellungen stehen in [`device_setup.md`](device_setup.md).

| Ort | Devices | Anzahl |
|---|---|---:|
| Pro Basis (×4) | Mutator-Zone (Bank), Button (Tresor), Teleporter (Rundenstart), Player-Spawner ×4, Billboard, VFX-Spawner, Audio-Player (Alarm), Button (Safe) ×2, Collectibles ×4 | 4 × 16 = 64 |
| Loot-Inseln (×4) | Button (Safe) ×2, Collectibles ×6 | 4 × 8 = 32 |
| Mega Vault | Barrier ×4 (Tore), Button (Jackpot), Guard-Spawner ×3, Collectibles ×8, Beacon | 17 |
| Hub | Player-Spawner ×8, Teleporter (Rückkehr), Billboard (Ergebnis), Billboard (How to play), Mutator-Zone (kein Schaden) | 12 |
| Global (irgendwo, unsichtbar) | Verse-Device `sky_heist_game`, HUD-Message ×2, Item-Granter ×3, Player-Marker, Score-Manager, Audio ×5, Analytics ×5, Damage-Volume (Abgrund) | ~19 |
| **Summe** | | **~144** |

## 7. Assets

- Alle Strukturen kommen aus den **in UEFN enthaltenen Fortnite-Galerien und Prefabs** (Content Browser → Fortnite → Galleries/Prefabs). Geeignet sind schwebende Felsinseln, Dach- und Stadtgalerien für die Basen, ein Tresor- oder Bank-Thema für die Mega Vault. Die konkrete Auswahl ist ein manueller Schritt im Editor. In dieser Umgebung gibt es keinen Asset-Browser, deshalb nenne ich hier keine Asset-Namen, die sich nicht überprüfen lassen.
- **Keine externen Assets**, keine Marken, keine geschützten Figuren. Thema und Titel sind eigenständig („Sky Heist“, Fantasie-Himmelsstadt).
- Ein Skydome bzw. eine Himmelsstimmung erzeugt den Eindruck großer Höhe (z. B. `skydome_device` oder die Umgebungseinstellungen der Insel).

## 8. Performance-Budget (Plan)

- **Memory:** Epic zeigt im Editor eine Speicheranzeige mit maximal 100.000 Einheiten pro Bereich (Memory Calculation, siehe Quelle S10 in `research/datasets/sources.csv`). Ziel: **< 70 %** im ersten Build, damit Platz für Updates bleibt.
- **Galerien wiederverwenden:** wenige unterschiedliche Mesh-Typen, viele Instanzen. Die Memory-Kosten entstehen pro *einzigartigem* Asset und Device-Typ.
- **Keine physiksimulierten Objekte**: keine Physik-Bäume oder -Felsbrocken in der Arena.
- **Sichtweite:** Die Arena ist kompakt (~210 m Durchmesser). World Partition oder Streaming ist voraussichtlich nicht nötig. Prüfen mit Memory Calculation und Spatial Profiler.
- **Device-Anzahl ~144**, überwiegend Instanzen derselben Typen.
