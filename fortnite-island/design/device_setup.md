# Device-Setup und Verdrahtung in UEFN

Diese Anleitung verbindet den Bauplan ([`map_layout.md`](map_layout.md)) mit dem Verse-Code ([`../Verse/`](../Verse/)). Alle Verse-Feldnamen entsprechen exakt den `@editable`-Feldern in `main_game.verse`.

> **Hinweis zu Optionsnamen:** Die *Verse-API* jedes Devices ist gegen den Digest von Fortnite 42.40 geprüft. Die Beschriftungen im **Details-Panel** des Editors stammen dagegen nicht aus einem prüfbaren Dokument dieser Umgebung und können je nach UEFN-Version leicht abweichen. Wo eine Einstellung entscheidend ist, steht die Absicht dabei, damit sich die passende Option auch bei abweichender Beschriftung findet.

## 0. Projekt anlegen und Verse importieren

1. UEFN öffnen → **New Project** → leere Insel (z. B. „Blank“) → Projektname `SkyHeist`.
2. Menü **Verse → Verse Explorer**. Im Projektordner (`SkyHeist/Content` bzw. dem Verse-Ordner des Projekts) fünf Dateien anlegen: **Rechtsklick → Create New Verse File**, Vorlage „Empty“:
   `heist_rules.verse`, `heist_save.verse`, `heist_player.verse`, `heist_hud.verse`, `main_game.verse`
3. Den Inhalt der gleichnamigen Dateien aus diesem Repository vollständig hineinkopieren und speichern. Alle fünf Dateien müssen im **selben** Verse-Ordner liegen, weil sie sich gegenseitig ohne `using` referenzieren (gleiches Modul).
4. **Verse → Build Verse Code** (Strg+Umschalt+B). Erwartung: keine Fehler. **Dieser Schritt wurde in dieser Umgebung nicht ausgeführt, weil UEFN hier nicht verfügbar ist.** Treten Compiler-Fehler auf, ist das Vorgehen in [`testing_plan.md`](testing_plan.md) § 4 beschrieben.
5. Im **Content Browser** unter dem Projektordner erscheint das Device **`sky_heist_game`**. Per Drag & Drop einmal in die Welt ziehen (Position egal, z. B. unter dem Hub).

## 1. Insel-Einstellungen (Island Settings)

| Bereich | Einstellung | Wert | Warum |
|---|---|---|---|
| Spieler | Max. Spieler | **16** | 4 Teams à 4 |
| Teams | Anzahl Teams | **4** | Verse ordnet Team *n* der Basis `Bases[n-1]` zu |
| Teams | Teamgröße | dynamisch / bis 4 | – |
| Teams | Partys zusammenhalten / Team-Balance | **an** | Freunde landen im selben Team (Discover wertet den Party-Anteil) |
| Spawn | Spawn-Ort | **Player Spawn Pads** | nur die Spawner aus Verse sollen gelten |
| Spawn | Join in Progress | **Spawn** (nicht Spectate) | Einstieg in laufende Runden ohne Wartezeit |
| Respawn | Respawn | **an**, unbegrenzt | – |
| Respawn | Respawn-Zeit | **3 s** | schneller Wiedereinstieg |
| Respawn | Spawn-Schutz | 2–3 s (falls verfügbar) | kein Spawn-Camping |
| Inventar | Items bei Eliminierung | **löschen** (nicht fallen lassen) | Start-Ausrüstung wird beim Respawn neu vergeben |
| Inventar | Mit Spitzhacke starten | an | – |
| Bauen | Bauen erlaubt | **aus** | Fokus auf Heist; Bau-Exploits an Tresoren vermeiden |
| Kampf | Friendly Fire | **aus** | – |
| Kampf | Fallschaden | an | – |
| Spielende | Zeitlimit / Siegbedingung | **aus / keine** | Verse steuert endlose Runden innerhalb einer Session |
| Spielende | Runden | **1** | Verse-Runden laufen innerhalb dieser einen Fortnite-Runde |
| HUD | Ressourcen-Anzeige (Holz/Stein/Metall) | aus | aufgeräumtes HUD |
| Voice | Proximity Chat | **optionaler A/B-Test** | Social-Inseln zeigen lange Sessions; erst im Playtest bewerten |

## 2. Verse-Device `sky_heist_game`: Felder

### 2.1 Zeitwerte (Standard ist schon eingestellt)

| Feld | Standard | Bereich | Bedeutung |
|---|---:|---|---|
| IntermissionSeconds | 15 | 5–30 | Countdown im Hub |
| RoundSeconds | 240 | ≥ 60 | Rundenlänge |
| HeatSeconds | 45 | 0 bis Runde − 10 | Schlussphase |
| ResultsSeconds | 8 | ≥ 1 | Ergebnisanzeige |
| LootWaveSeconds | 30 | ≥ 5 | Orbs und Safes erneuern |
| FirstEventDelaySeconds | 40 | ≥ 5 | erstes Event |
| EventIntervalSeconds | 50 | ≥ Dauer + 5 | Event-Abstand |
| EventDurationSeconds | 25 | ≥ 5 | Event-Länge |
| VaultRobCooldownSeconds | 20 | – | Sperre pro Tresor nach einem Raub |
| KnockoutCreditSeconds | 8 | – | Zeitfenster für Knock-off-Gutschrift |
| MinPlayersToStart | 1 | ≥ 1 | Solo-Start erlaubt |
| SoloGuardThreshold | 2 | – | Bis zu dieser Spielerzahl spawnen zu Rundenbeginn Wachen. |

### 2.2 Welt

| Feld | Typ | Pflicht | Was zuweisen |
|---|---|---|---|
| **Bases** | Array von `heist_base` | **ja** | 4 Einträge, Reihenfolge = Teamnummer (Index 0 = Team 1 = RED). Jeder Eintrag siehe § 3. |
| TeamNames | Array von string | nein | `RED, BLUE, GREEN, GOLD` (Anzeige im HUD) |
| **HubSpawners** | Array `player_spawner_device` | **ja** | die 8 Hub-Spawner |
| **HubTeleporters** | Array `teleporter_device` | **ja** | 1 Teleporter im Hub (Index 0 wird genutzt) |
| LootOrbs | Array `collectible_object_device` | empfohlen | alle 48 Orbs |
| Safes | Array `button_device` | empfohlen | alle 16 Safe-Buttons |
| VaultGuards | Array `guard_spawner_device` | empfohlen | 3 Guard-Spawner in der Mega Vault |
| VaultGates | Array `barrier_device` | empfohlen | 4 Barrieren als Tore der Mega Vault |
| JackpotButtons | Array `button_device` | empfohlen | 1 Button im Inneren der Mega Vault |
| BountyMarkers | Array `player_marker_device` | empfohlen | 1 Player-Marker |
| StarterLoadouts | Array `item_granter_device` | empfohlen | 3 Granter: Index 0 = Level 1–2, 1 = Level 3–9, 2 = ab Level 10 |
| BankScoreManagers | Array `score_manager_device` | optional | 1 Score-Manager (natives Scoreboard) |

### 2.3 Feedback

| Feld | Pflicht | Zuweisen |
|---|---|---|
| Announcers | empfohlen | Index 0 = HUD-Message „Toasts“ (unten Mitte), Index 1 = HUD-Message „Banner“ (oben Mitte, optional) |
| PickupSounds, BankSounds, StealSounds, EventSounds, HeatMusic, VictorySounds | optional | je 1 `audio_player_device` |
| ResultBillboards | optional | Billboard im Hub |

### 2.4 Analytics (optional, empfohlen für das Kennzahlen-Monitoring)

| Feld | Analytics-Device-Name (Vorschlag) | Bedeutet |
|---|---|---|
| FirstBankAnalytics | `first_bank` | Erste Einzahlung überhaupt (Onboarding-Trichter) |
| RoundCompleteAnalytics | `round_complete` | Runde zu Ende gespielt |
| SecondRoundAnalytics | `second_round` | zweite Runde in derselben Session |
| ContractCompleteAnalytics | `contract_complete` | Daily Contract erfüllt |
| LevelUpAnalytics | `level_up` | Level-up |

## 3. Pro Basis: `heist_base`-Eintrag (4×)

| Feld | Device | Einstellungen im Device |
|---|---|---|
| **BankZone** | `mutator_zone_device`, ~6 × 6 × 4 m, vor dem Tresor | Zone im Spiel sichtbar (Teamfarbe). Keine Team-Einschränkung nötig, Verse prüft das Team selbst. Aktiviert beim Spielstart: egal, Verse schaltet um. |
| **VaultButton** | `button_device` am Tresor-Objekt hinter der Bank-Zone | Interaktionszeit **4 s**, Interaktionstext „Rob vault“, Auslösungen **unbegrenzt**. Verse ignoriert das eigene Team und regelt die Abklingzeit. |
| **RoundStartTeleporter** | `teleporter_device` mitten in der Basis | **kein Ziel und keine Gruppe** (Verse ruft `Teleport(Player)` = „zu diesem Gerät“). Effekt bzw. Rift im Spiel unsichtbar oder unter dem Boden versenken, damit niemand ihn betritt. |
| **BaseSpawners** | 4 × `player_spawner_device` | **Spieler-Team = Teamnummer der Basis**, im Spiel unsichtbar. Verse schaltet sie zu Rundenbeginn an und im Hub aus. |
| VaultBillboards | `billboard_device` über dem Tresor | große Schrift; Verse schreibt „RED VAULT: 140“ |
| BankEffects | `vfx_spawner_device` an der Bank-Zone | kurzer Burst-Effekt; „beim Spielstart aktiviert“ aus. Verse ruft `Restart()`. |
| VaultAlarms | `audio_player_device` am Tresor | Alarmton, räumlich (3D), Reichweite ~40 m |

Dazu pro Basis platzieren (Verdrahtung über die globalen Arrays): **2 Safes** (Buttons) 6–10 m vom Spawn und **4 Orbs** (Collectibles).

## 4. Einstellungen der übrigen Devices

| Device | Einstellungen (Absicht) |
|---|---|
| **Safe** (`button_device`) ×16 | Interaktionszeit **3 s**, Text „Crack safe“, Auslösungen unbegrenzt. Verse deaktiviert den Safe nach dem Knacken bis zur nächsten Welle und liest die Interaktionszeit beim Start (Safe Storm halbiert sie). Optisch: Tresor- oder Kisten-Prop direkt dahinter. |
| **Loot-Orb** (`collectible_object_device`) ×48 | „Verbraucht, wenn eingesammelt von“: **alle Spieler** (einer nimmt, für alle weg). Automatisches Respawnen **aus**, Verse ruft alle 30 s `RespawnForAll()`. Optik: goldene Münze oder Juwel. |
| **Vault-Wache** (`guard_spawner_device`) ×3 | Beim Spielstart spawnen: **aus**. Anheuern erlaubt: **aus**. Gegner aller Spieler-Teams. Anzahl 1–2 pro Spawner. Waffe mit moderatem Schaden. Verse ruft `Enable/Spawn` bzw. `Despawn/Disable`. |
| **Tor** (`barrier_device`) ×4 | Sichtbar, beim Start aktiviert (geschlossen). Verse öffnet sie bei Vault Open und Heat. |
| **Jackpot** (`button_device`) ×1 | Interaktionszeit **5 s**, Text „Crack the JACKPOT“, im Inneren der Mega Vault. Verse aktiviert ihn nur in der Heat und nur einmal pro Runde. |
| **Bounty-Marker** (`player_marker_device`) | Für alle sichtbar, auf der Minimap. Verse setzt ihn mit `Attach/Detach` auf den markierten Spieler. |
| **Start-Ausrüstung** (`item_granter_device`) ×3 | Stufe 0: Spitzhacke + 1 Knockback-Item. Stufe 1: + Mobilitäts-Item. Stufe 2: + stärkere Variante. Beim Vergeben: **Inventar leeren**, dann vergeben (verhindert Stapeln beim Respawn). Die Knockback-Items müssen **Schaden** verursachen, sonst kann Verse Knock-offs keinem Angreifer gutschreiben (Test T-07). |
| **Score-Manager** | Verse setzt per `SetScoreAward` die eingezahlte Menge und vergibt sie per `Activate(Player)`. |
| **HUD-Message „Toasts“** | Position unten Mitte, Anzeigedauer 3 s. Verse übergibt Text und Spieler direkt (`Show(Agent, Message)`). |
| **HUD-Message „Banner“** | Position oben Mitte, Anzeigedauer 4 s. |
| **Abgrund** (`damage_volume_device`) | großes Volumen ~20 m unter der Arena, Schaden pro Tick ≥ 200, damit Abstürze sofort eliminieren und der Knock-off zählt. |
| **Hub-Schutz** (`mutator_zone_device`) | deckt den Hub ab; Waffenschaden bzw. Waffeneinsatz deaktivieren (Option je nach Version, z. B. „Allow Weapon Fire“ aus). |
| **Beacon** (`beacon_device`) | über der Mega Vault, immer sichtbar |
| **Hub-Teleporter** | wie die Basis-Teleporter: ohne Ziel, Rift unsichtbar oder versenkt |
| **Audio-Player** | Pickup, Bank und Steal: 2D und nur für den auslösenden Spieler (Verse ruft `Play(Player)`). Event und Heat-Musik: für alle. |

## 5. Checkliste vor dem ersten Start

- [ ] 4 Teams in den Insel-Einstellungen, 4 Einträge in `Bases` (Reihenfolge Team 1–4)
- [ ] Jede Basis: BankZone, VaultButton, RoundStartTeleporter, 4 BaseSpawners mit korrektem Team
- [ ] Hub: mindestens 1 Spawner in `HubSpawners`, Teleporter in `HubTeleporters[0]`
- [ ] Außer den in `HubSpawners` und `BaseSpawners` eingetragenen gibt es keine weiteren Player-Spawner auf der Insel
- [ ] Safes und Orbs in die Arrays eingetragen; Orbs mit „von allen verbraucht“ und ohne Auto-Respawn
- [ ] Item-Granter leeren das Inventar beim Vergeben; die Knockback-Items verursachen Schaden
- [ ] Verse gebaut ohne Fehler. Beim Session-Start zeigt das Log keine Meldung „Sky Heist: setup incomplete“.
- [ ] Memory Calculation unter 70 %

## 6. Fehlende Referenzen: was passiert?

`ValidateSetup()` läuft beim Start und schreibt per `Print` ins Log:

| Fehlt | Folge |
|---|---|
| `Bases` leer oder eine Basis ohne Spawner, `HubSpawners` leer, `HubTeleporters` leer | **Runden starten nicht.** Im Log steht genau, was fehlt. |
| `Announcers` leer | Warnung; das Spiel läuft, aber ohne Toasts |
| `LootOrbs` und `Safes` leer | Warnung; Beute nur über Wachen und Diebstahl |
| `StarterLoadouts` leer | Warnung; Spieler starten ohne Items |
| jedes andere optionale Array leer | das jeweilige Feature ist einfach aus |

Ein einzelnes Device-Feld, das nicht zugewiesen ist, hält standardmäßig ein nicht platziertes Default-Device. Deshalb sind alle optionalen Devices in diesem Projekt **Arrays**: Ein leeres Array ist eindeutig erkennbar und schaltet das Feature sauber ab.
