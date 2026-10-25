# ==========================================================================
#  BANK IT! - SKY HEIST | Komplettdatei fuer UEFN (Verse + Bauanleitung)
# ==========================================================================
#  Erzeugt aus fortnite-island/Verse/*.verse mit tools/build_single_file.py.
#  Verse-API statisch geprueft gegen den Digest von Fortnite 42.40
#  (tools/verse_static_check.py, 0 Befunde). NICHT in UEFN kompiliert:
#  UEFN war in der Erstellungsumgebung nicht verfuegbar.
#
#  WAS DIESE DATEI ENTHAELT - UND WAS NICHT
#  - Die komplette Spiellogik als ein Verse-Device: "sky_heist_game".
#  - Sie kann KEINE Inseln, Gebaeude oder Devices erzeugen. UEFN kann eine
#    Map nicht aus einer Textdatei einfuegen. Welt und Devices baust du
#    einmal von Hand nach SCHRITT 3 bis 5 unten. Danach steuert diese Datei
#    das komplette Spiel.
#  - Nutze ENTWEDER diese eine Datei ODER die 5 Einzeldateien aus Verse/,
#    niemals beides im selben Projekt (sonst doppelte Definitionen).
#
# --------------------------------------------------------------------------
#  SCHRITT 1 - Datei einfuegen und bauen
# --------------------------------------------------------------------------
#  1. UEFN -> New Project -> leere Insel.
#  2. Menue Verse -> Verse Explorer -> Rechtsklick auf den Projektordner
#     -> Create New Verse File -> Name: sky_heist_complete
#  3. Den GESAMTEN Inhalt dieser Datei hineinkopieren, speichern.
#  4. Verse -> Build Verse Code (Strg+Umschalt+B).
#  5. Im Content Browser (Projektordner) das Device "sky_heist_game" in die
#     Welt ziehen (Position egal, z. B. unter dem Hub).
#  Bei Compiler-Fehlern: Meldung kopieren und melden; siehe
#  design/testing_plan.md Abschnitt 4.
#
# --------------------------------------------------------------------------
#  SCHRITT 2 - Insel-Einstellungen (Island Settings)
# --------------------------------------------------------------------------
#  Max. Spieler 16 | Teams 4 | Partys zusammenhalten an
#  Spawn-Ort: Player Spawn Pads | Join in Progress: Spawn
#  Respawn an, 3 s | Items bei Eliminierung: loeschen | mit Spitzhacke starten
#  Bauen aus | Friendly Fire aus | Zeitlimit/Siegbedingung aus | Runden 1
#  (Optionsnamen koennen je nach UEFN-Version leicht abweichen.)
#
# --------------------------------------------------------------------------
#  SCHRITT 3 - Map bauen ("Cloud Quarter", Draufsicht, nicht massstaeblich)
# --------------------------------------------------------------------------
#                            N
#                  +-------------------+
#                  | RED BASE (Team 1) |
#                  | Spawn x4          |
#                  | [Bank]  [Vault]   |
#                  +---------+---------+
#      Islet NW  o-----------|   Bruecke  |-----------o  Islet NE
#               \            |            |            /
#   +-------------+   +------+------------+------+   +-------------+
#   | GOLD BASE 4 |---|        MEGA VAULT        |---| BLUE BASE 2 |
# W | [Vault]     |   |   Tore (4 Barrieren)     |   |     [Vault] | E
#   | [Bank]      |   |   Jackpot *  Wachen x3   |   |      [Bank] |
#   | Spawn x4    |   |   Beacon                 |   |    Spawn x4 |
#   +-------------+   +------+------------+------+   +-------------+
#               /            |            |            \
#      Islet SW  o-----------+------------+-----------o  Islet SE
#                  +---------+---------+
#                  | [Vault]  [Bank]   |
#                  | Spawn x4          |
#                  | GREEN (Team 3)    |
#                  +-------------------+
#                            S
#           darunter: Abgrund (-40 m) mit Damage Volume
#  HUB "Hideout": eigene Plattform ~120 m westlich, 30 m hoeher.
#
#  Masse (1 Kachel = 5,12 m):
#  Hub 6x6 Kacheln | Basis 5x5 | Loot-Insel 3x3 | Mega Vault 8x8
#  Bruecken 1 Kachel breit, 6-8 lang, eine Seite ohne Gelaender
#  Basis-Spawn -> eigene Bank-Zone 10-15 m | -> erster Safe 6-10 m
#  Basis -> Mega Vault ~60 m | Basis -> Nachbarbasis ~85 m
#  Ost-/Westbasis 4 m hoeher. Teamfarben Rot/Blau/Gruen/Gold.
#  Nur Fortnite-Galerien/Prefabs aus UEFN verwenden, keine externen Assets.
#
# --------------------------------------------------------------------------
#  SCHRITT 4 - Devices platzieren und einstellen (~144)
# --------------------------------------------------------------------------
#  PRO BASIS (4x):
#   - Mutator Zone "Bank" (~6x6x4 m, sichtbar in Teamfarbe) vor dem Tresor
#   - Button "Vault" am Tresor dahinter: Interaktionszeit 4 s, Text
#     "Rob vault", Ausloesungen unbegrenzt
#   - Teleporter "Rundenstart" in der Basis: KEIN Ziel, keine Gruppe,
#     Rift unsichtbar oder unter dem Boden
#   - 4x Player Spawner: Spieler-Team = Teamnummer der Basis, unsichtbar
#   - Billboard ueber dem Tresor, VFX Spawner (Burst, Start aus) an der
#     Bank-Zone, Audio Player (Alarm, 3D) am Tresor
#   - 2x Button "Safe" 6-10 m vom Spawn, 4x Collectible Object
#  LOOT-INSELN (4x): je 2x Button "Safe" + 6x Collectible Object
#  MEGA VAULT: 4x Barrier (Tore, Start aktiv), 1x Button "Jackpot"
#   (5 s, "Crack the JACKPOT"), 3x Guard Spawner (Spawn bei Start aus,
#   anheuern aus, 1-2 Wachen), 8x Collectible Object, 1x Beacon
#  HUB: 8x Player Spawner (ohne Team), 1x Teleporter (ohne Ziel),
#   Billboard (Ergebnis), Mutator Zone ueber dem Hub ohne Waffenschaden
#  GLOBAL: 2x HUD Message (0 = Toasts unten Mitte 3 s, 1 = Banner oben
#   4 s), 3x Item Granter (Stufe 0/1/2; beim Vergeben Inventar leeren;
#   Knockback-Items MUESSEN Schaden machen), 1x Player Marker (fuer alle,
#   Minimap), optional Score Manager, Audio Player (Pickup, Bank, Steal,
#   Event, Heat-Musik, Sieg), Analytics (first_bank, round_complete,
#   second_round, contract_complete, level_up),
#   Damage Volume im Abgrund (>= 200 Schaden)
#  EINSTELLUNGEN:
#   - Safe-Buttons: Interaktionszeit 3 s, Text "Crack safe", unbegrenzt
#   - Collectibles: "verbraucht, wenn eingesammelt von: alle Spieler",
#     automatisches Respawnen AUS (der Code respawnt alle 30 s)
#   - Keine weiteren Player Spawner auf der Insel ausser Hub und Basen
#
# --------------------------------------------------------------------------
#  SCHRITT 5 - sky_heist_game im Details-Panel verdrahten
# --------------------------------------------------------------------------
#  PFLICHT (sonst startet keine Runde; das Log nennt, was fehlt):
#   Bases            4 Eintraege, Reihenfolge = Team 1..4 (RED, BLUE,
#                    GREEN, GOLD). Pro Eintrag:
#                      BankZone, VaultButton, RoundStartTeleporter,
#                      BaseSpawners (4), optional VaultBillboards,
#                      BankEffects, VaultAlarms
#   HubSpawners      die 8 Hub-Spawner
#   HubTeleporters   der Hub-Teleporter (Index 0)
#  EMPFOHLEN:
#   LootOrbs (alle 48 Collectibles), Safes (alle 16 Safe-Buttons),
#   VaultGuards (3), VaultGates (4 Barrieren), JackpotButtons (1),
#   BountyMarkers (1), StarterLoadouts (Index 0 = Level 1-2,
#   1 = Level 3-9, 2 = ab Level 10), Announcers (0 = Toasts, 1 = Banner)
#  OPTIONAL:
#   TeamNames, BankScoreManagers, PickupSounds, BankSounds, StealSounds,
#   EventSounds, HeatMusic, VictorySounds, ResultBillboards,
#   FirstBankAnalytics, RoundCompleteAnalytics, SecondRoundAnalytics,
#   ContractCompleteAnalytics, LevelUpAnalytics
#  ZEITWERTE (Standard schon gesetzt): IntermissionSeconds 15,
#   RoundSeconds 240, HeatSeconds 45, ResultsSeconds 8, LootWaveSeconds 30,
#   FirstEventDelaySeconds 40, EventIntervalSeconds 50,
#   EventDurationSeconds 25, VaultRobCooldownSeconds 20,
#   KnockoutCreditSeconds 8, MinPlayersToStart 1, SoloGuardThreshold 2
#
# --------------------------------------------------------------------------
#  SCHRITT 6 - Erster Test
# --------------------------------------------------------------------------
#  1. Launch Session allein: Hub -> Countdown 15 s -> Basis -> Safe knacken
#     -> in die eigene Bank-Zone laufen -> "BANKED +..." erscheint.
#  2. Mit 2. Person: Gegner mit Beute von der Insel stossen -> "+X STOLEN".
#     Klappt das nicht, macht das Knockback-Item keinen Schaden: anderes Item.
#  3. Gegnerischen Tresor 4 s halten -> Raub, Alarm, 20 s Sperre.
#  4. Runde inkl. Heat (letzte 45 s, Jackpot) durchspielen, verlassen,
#     neu beitreten -> Level bleibt erhalten.
#  Alle 20 Editor-Tests: design/testing_plan.md
#
# ==========================================================================
#  AB HIER: VERSE-CODE (nicht veraendern, ausser du weisst was du tust)
# ==========================================================================

using { /Verse.org/Simulation }
using { /Fortnite.com/UI }
using { /UnrealEngine.com/Temporary/UI }
using { /UnrealEngine.com/Temporary/SpatialMath }
using { /Verse.org/Colors }
using { /Fortnite.com/Devices }
using { /Fortnite.com/Characters }
using { /Fortnite.com/Game }
using { /Fortnite.com/Playspaces }
using { /Fortnite.com/Teams }
using { /Verse.org/Random }

##########################################################################
# Modul: heist_rules.verse
##########################################################################

# Sky Heist - pure game rules.
#
# Everything in this file is a plain function of its inputs: level curve,
# unlocks, bank bonuses, steal and vault-rob amounts, round XP and daily
# contracts. Nothing here touches a device or the playspace, which keeps the
# rules easy to reason about and lets tests/heist_model.py mirror them 1:1.
#
# All functions are <transacts> so they can also be called from inside
# failure contexts (if/for conditions). Integer division always goes through
# Quotient[], which fails instead of dividing by zero.

# ---------------------------------------------------------------------------
# Tuning constants
# ---------------------------------------------------------------------------

MaxHeistLevel:int = 50
BaseCarryCapacity:int = 20

# Hard caps keep persisted numbers bounded even after years of play.
MaxStoredXP:int = 100000000
MaxStoredStat:int = 1000000000
MaxRoundXP:int = 1000

# Loot values (per pickup).
OrbLootValue:int = 1
SafeLootValue:int = 5
GuardLootValue:int = 8
JackpotLootValue:int = 25
BountyBonusLoot:int = 10

# Steal / rob rules.
StealPercent:int = 50
VaultRobPercent:int = 15
VaultRobMax:int = 30

# Round XP rewards.
XPPerSteal:int = 3
XPPerVaultRob:int = 5
XPPerSafe:int = 2
XPForWin:int = 25
XPForTakingPart:int = 10

# Daily contracts.
ContractsPerDay:int = 3
ContractKindCount:int = 6
ContractRewardXP:int = 60
SecondsPerDay:float = 86400.0

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

# Value * Percent / 100, rounded down. Returns 0 for non-positive input.
PercentOf(Value:int, Percent:int)<transacts>:int =
    if (Value > 0, Percent > 0, Result := Quotient[Value * Percent, 100]):
        Result
    else:
        0

# Adds Amount to Current without exceeding Cap and without going below 0.
AddCapped(Current:int, Amount:int, Cap:int)<transacts>:int =
    Clamp(Current + Amount, 0, Cap)

# Seconds rounded up to a whole number, never negative.
WholeSecondsUp(Seconds:float)<transacts>:int =
    if (Seconds > 0.0, Whole := Ceil[Seconds]):
        Whole
    else:
        0

# 125 -> "2:05"
FormatClock(TotalSeconds:int)<transacts>:string =
    NonNegative:int = Max(TotalSeconds, 0)
    if (Minutes := Quotient[NonNegative, 60], Seconds := Mod[NonNegative, 60]):
        if (Seconds < 10) then "{Minutes}:0{Seconds}" else "{Minutes}:{Seconds}"
    else:
        "0:00"

# ---------------------------------------------------------------------------
# Level curve
# ---------------------------------------------------------------------------

# XP needed to go from Level to Level + 1. 0 once the max level is reached.
XPForNextLevel(Level:int)<transacts>:int =
    if (Level >= MaxHeistLevel):
        0
    else:
        100 + 40 * (Clamp(Level, 1, MaxHeistLevel) - 1)

level_progress := struct:
    Level:int = 1
    XPIntoLevel:int = 0
    XPForNext:int = 100

# Walks the level curve. Bounded by MaxHeistLevel iterations.
LevelProgressFromXP(TotalXP:int)<transacts>:level_progress =
    var CurrentLevel:int = 1
    var Remaining:int = Clamp(TotalXP, 0, MaxStoredXP)
    loop:
        Need:int = XPForNextLevel(CurrentLevel)
        if (Need <= 0 or Remaining < Need):
            break
        set Remaining -= Need
        set CurrentLevel += 1
    level_progress{Level := CurrentLevel, XPIntoLevel := Remaining, XPForNext := XPForNextLevel(CurrentLevel)}

LevelFromXP(TotalXP:int)<transacts>:int =
    LevelProgressFromXP(TotalXP).Level

# ---------------------------------------------------------------------------
# Unlocks
# ---------------------------------------------------------------------------

CarryCapacityForLevel(Level:int)<transacts>:int =
    if (Level >= 15):
        BaseCarryCapacity + 15
    else if (Level >= 7):
        BaseCarryCapacity + 10
    else if (Level >= 2):
        BaseCarryCapacity + 5
    else:
        BaseCarryCapacity

# Index into the starting-loadout item granters (0 = basic kit).
LoadoutTierForLevel(Level:int)<transacts>:int =
    if (Level >= 10):
        2
    else if (Level >= 3):
        1
    else:
        0

# Banking at least this much at once earns the combo bonus.
ComboThresholdForLevel(Level:int)<transacts>:int =
    if (Level >= 5) then 8 else 10

TitleForLevel(Level:int)<transacts>:string =
    if (Level >= 35):
        "Legend"
    else if (Level >= 20):
        "Mastermind"
    else if (Level >= 10):
        "Vault Breaker"
    else if (Level >= 5):
        "Pickpocket"
    else:
        "Rookie"

# ---------------------------------------------------------------------------
# Banking, stealing, robbing
# ---------------------------------------------------------------------------

# Bonus loot for banking Amount at once (before the Heat multiplier).
BankComboBonus(Amount:int, Level:int)<transacts>:int =
    if (Amount >= 20):
        PercentOf(Amount, 50)
    else if (Amount >= ComboThresholdForLevel(Level)):
        PercentOf(Amount, 20)
    else:
        0

# Total loot credited for banking Amount. Heat doubles base + bonus.
BankedValue(Amount:int, Level:int, HeatActive:logic)<transacts>:int =
    if (Amount <= 0):
        0
    else:
        Base:int = Amount + BankComboBonus(Amount, Level)
        if (HeatActive?) then Base * 2 else Base

# Share of the victim's carried loot that goes to the eliminator.
StealAmount(VictimCarried:int)<transacts>:int =
    PercentOf(VictimCarried, StealPercent)

# Loot taken from a team vault per successful rob. At least 1 while the vault
# holds anything, never more than VaultRobMax or what the vault holds.
VaultRobAmount(TeamBanked:int)<transacts>:int =
    if (TeamBanked <= 0):
        0
    else:
        Clamp(PercentOf(TeamBanked, VaultRobPercent), 1, Min(VaultRobMax, TeamBanked))

# XP for one round. Capped so no single round can explode progression.
RoundXP(Banked:int, Steals:int, Robs:int, Safes:int, Won:logic)<transacts>:int =
    TookPart:int = if (Banked > 0 or Steals > 0 or Robs > 0 or Safes > 0) then XPForTakingPart else 0
    WinXP:int = if (Won?) then XPForWin else 0
    Raw:int = Max(Banked, 0) + XPPerSteal * Max(Steals, 0) + XPPerVaultRob * Max(Robs, 0) + XPPerSafe * Max(Safes, 0) + TookPart + WinXP
    Clamp(Raw, 0, MaxRoundXP)

# ---------------------------------------------------------------------------
# Daily contracts
# ---------------------------------------------------------------------------

# Contract kinds by index:
#   0 = bank loot, 1 = steal from players, 2 = rob vaults,
#   3 = crack safes, 4 = win rounds, 5 = combo banks (bank >= threshold at once)
ContractTarget(Kind:int)<transacts>:int =
    if (Kind = 0):
        60
    else if (Kind = 1):
        3
    else if (Kind = 2):
        2
    else if (Kind = 3):
        5
    else if (Kind = 4):
        1
    else:
        2

ContractLabel(Kind:int)<transacts>:string =
    if (Kind = 0):
        "Bank loot"
    else if (Kind = 1):
        "Steal from players"
    else if (Kind = 2):
        "Rob enemy vaults"
    else if (Kind = 3):
        "Crack safes"
    else if (Kind = 4):
        "Win rounds"
    else:
        "Combo banks"

# UTC day number. Contracts rotate when it changes.
DayIndexFromSeconds(Seconds:float)<transacts>:int =
    if (Seconds > 0.0, Day := Floor[Seconds / SecondsPerDay]):
        Day
    else:
        0

# The three contract kinds for a day. Offsets 0, 1 and 3 are always distinct
# modulo 6, so a day never repeats a kind, and six different sets rotate.
ContractKindsForDay(Day:int)<transacts>:[]int =
    if (Start := Mod[Day, ContractKindCount], B := Mod[Start + 1, ContractKindCount], C := Mod[Start + 3, ContractKindCount]):
        array{Start, B, C}
    else:
        array{0, 1, 3}

##########################################################################
# Modul: heist_save.verse
##########################################################################

# Sky Heist - persistent player progress.
#
# Fortnite persists a module-scoped `var weak_map(player, t)` whose value type
# is <persistable>. Every field needs a default so that `heist_save{}` is a
# valid fresh save, and the class is <final> as persistable classes must be.
# Keep the record small: a handful of ints and two 3-element arrays.
#
# Versioning: bump CurrentSaveVersion when fields change meaning. New fields
# must always get a default so older saves keep loading.


CurrentSaveVersion:int = 1

heist_save := class<final><persistable>:
    Version:int = 1
    TotalXP:int = 0
    LifetimeBanked:int = 0
    LifetimeSteals:int = 0
    LifetimeVaultRobs:int = 0
    RoundsPlayed:int = 0
    RoundsWon:int = 0
    BestRoundBanked:int = 0
    TutorialDone:logic = false
    # UTC day the contract progress below belongs to (-1 = none yet).
    ContractDay:int = -1
    ContractProgress:[]int = array{}
    # 1 = reward already paid out for that contract slot today.
    ContractClaimed:[]int = array{}

var HeistSaves:weak_map(player, heist_save) = map{}

# Returns the stored save, or a fresh one for first-time players.
LoadHeistSave(Player:player)<transacts>:heist_save =
    if (Existing := HeistSaves[Player]):
        Existing
    else:
        heist_save{}

# Writes the save. Fails silently (no write) if the player already left the
# session, which is the documented behaviour of persistent weak_maps.
StoreHeistSave(Player:player, Save:heist_save)<transacts>:void =
    if (set HeistSaves[Player] = Save) {}

##########################################################################
# Modul: heist_player.verse
##########################################################################

# Sky Heist - runtime state for one player in the current session.
#
# heist_player_state mirrors the persistent heist_save (loaded on join, written
# back on bank / round end) and adds per-round counters plus the bookkeeping
# needed for fair steal attribution and leak-free event subscriptions.


heist_player_state := class:
    Player:player

    # Team base index (0-based) resolved from the playspace team collection.
    var TeamIndex:int = 0

    # --- Current round ---
    var Carried:int = 0
    var RoundBanked:int = 0
    var RoundSteals:int = 0
    var RoundRobs:int = 0
    var RoundSafes:int = 0
    var SessionRounds:int = 0
    var BankHintShown:logic = false

    # --- Mirror of heist_save ---
    var TotalXP:int = 0
    var LifetimeBanked:int = 0
    var LifetimeSteals:int = 0
    var LifetimeVaultRobs:int = 0
    var RoundsPlayed:int = 0
    var RoundsWon:int = 0
    var BestRoundBanked:int = 0
    var TutorialDone:logic = false
    var ContractDay:int = -1
    var ContractProgress:[]int = array{0, 0, 0}
    var ContractClaimed:[]int = array{0, 0, 0}

    # --- Combat attribution (knock-offs give no EliminatingCharacter) ---
    var LastDamager:?agent = false
    var LastDamageTime:float = -1000.0

    # --- Subscriptions on the current fort_character; cancelled before every
    # re-subscribe so a respawn can never stack duplicate handlers. ---
    var EliminationSubscription:?cancelable = false
    var DamageSubscription:?cancelable = false

    GetLevel()<transacts>:int = LevelFromXP(TotalXP)

    GetCapacity()<transacts>:int = CarryCapacityForLevel(GetLevel())

    LoadFrom(Save:heist_save):void =
        set TotalXP = Clamp(Save.TotalXP, 0, MaxStoredXP)
        set LifetimeBanked = Clamp(Save.LifetimeBanked, 0, MaxStoredStat)
        set LifetimeSteals = Clamp(Save.LifetimeSteals, 0, MaxStoredStat)
        set LifetimeVaultRobs = Clamp(Save.LifetimeVaultRobs, 0, MaxStoredStat)
        set RoundsPlayed = Clamp(Save.RoundsPlayed, 0, MaxStoredStat)
        set RoundsWon = Clamp(Save.RoundsWon, 0, MaxStoredStat)
        set BestRoundBanked = Clamp(Save.BestRoundBanked, 0, MaxStoredStat)
        set TutorialDone = Save.TutorialDone
        if (Save.ContractProgress.Length = ContractsPerDay, Save.ContractClaimed.Length = ContractsPerDay):
            set ContractDay = Save.ContractDay
            set ContractProgress = Save.ContractProgress
            set ContractClaimed = Save.ContractClaimed
        else:
            set ContractDay = -1
            set ContractProgress = array{0, 0, 0}
            set ContractClaimed = array{0, 0, 0}

    ToSave()<transacts>:heist_save =
        heist_save:
            Version := CurrentSaveVersion
            TotalXP := Self.TotalXP
            LifetimeBanked := Self.LifetimeBanked
            LifetimeSteals := Self.LifetimeSteals
            LifetimeVaultRobs := Self.LifetimeVaultRobs
            RoundsPlayed := Self.RoundsPlayed
            RoundsWon := Self.RoundsWon
            BestRoundBanked := Self.BestRoundBanked
            TutorialDone := Self.TutorialDone
            ContractDay := Self.ContractDay
            ContractProgress := Self.ContractProgress
            ContractClaimed := Self.ContractClaimed

    ResetRound():void =
        set Carried = 0
        set RoundBanked = 0
        set RoundSteals = 0
        set RoundRobs = 0
        set RoundSafes = 0
        set LastDamager = false
        set LastDamageTime = -1000.0

    # Starts a fresh set of contracts when the UTC day changed.
    RefreshContracts(Today:int):void =
        if (ContractDay <> Today):
            set ContractDay = Today
            set ContractProgress = array{0, 0, 0}
            set ContractClaimed = array{0, 0, 0}

    # Adds Amount to every open contract slot of Kind. Returns the slots that
    # were completed by this call; a slot can complete only once per day.
    AdvanceContract(Kinds:[]int, Kind:int, Amount:int):[]int =
        var Completed:[]int = array{}
        if (Amount > 0):
            for (Slot -> SlotKind : Kinds, SlotKind = Kind):
                if (Progress := ContractProgress[Slot], Claimed := ContractClaimed[Slot], Claimed = 0):
                    Target:int = ContractTarget(Kind)
                    NewProgress:int = Min(Progress + Amount, Target)
                    if (set ContractProgress[Slot] = NewProgress) {}
                    if (NewProgress >= Target):
                        if (set ContractClaimed[Slot] = 1) {}
                        set Completed += array{Slot}
        Completed

##########################################################################
# Modul: heist_hud.verse
##########################################################################

# Sky Heist - per-player HUD built with Verse UI.
#
# Layout (non-interactive, never captures input):
#   top centre : round phase + timer + active event
#   left side  : level / title, XP, bag, team vault, three daily contracts
#
# Every setter only changes text, so callers can update a single line when
# its value changes instead of rebuilding the widget tree.


HudText<localizes>(Text:string):message = "{Text}"

heist_hud := class:
    Player:player

    var MaybeRoot:?canvas = false

    PhaseBlock:text_block = text_block{DefaultTextColor := NamedColors.White, DefaultJustification := text_justification.Center}
    LevelBlock:text_block = text_block{DefaultTextColor := NamedColors.Gold}
    XPBlock:text_block = text_block{DefaultTextColor := NamedColors.White}
    BagBlock:text_block = text_block{DefaultTextColor := NamedColors.White}
    VaultBlock:text_block = text_block{DefaultTextColor := NamedColors.Cyan}
    ContractHeader:text_block = text_block{DefaultTextColor := NamedColors.Gold}
    ContractBlock0:text_block = text_block{DefaultTextColor := NamedColors.White}
    ContractBlock1:text_block = text_block{DefaultTextColor := NamedColors.White}
    ContractBlock2:text_block = text_block{DefaultTextColor := NamedColors.White}

    Show():void =
        if (not MaybeRoot?, PlayerUI := GetPlayerUI[Player]):
            Panel:stack_box = stack_box{Orientation := orientation.Vertical}
            Panel.AddWidget(stack_box_slot{Widget := LevelBlock, HorizontalAlignment := horizontal_alignment.Left})
            Panel.AddWidget(stack_box_slot{Widget := XPBlock, HorizontalAlignment := horizontal_alignment.Left})
            Panel.AddWidget(stack_box_slot{Widget := BagBlock, HorizontalAlignment := horizontal_alignment.Left})
            Panel.AddWidget(stack_box_slot{Widget := VaultBlock, HorizontalAlignment := horizontal_alignment.Left})
            Panel.AddWidget(stack_box_slot{Widget := ContractHeader, HorizontalAlignment := horizontal_alignment.Left})
            Panel.AddWidget(stack_box_slot{Widget := ContractBlock0, HorizontalAlignment := horizontal_alignment.Left})
            Panel.AddWidget(stack_box_slot{Widget := ContractBlock1, HorizontalAlignment := horizontal_alignment.Left})
            Panel.AddWidget(stack_box_slot{Widget := ContractBlock2, HorizontalAlignment := horizontal_alignment.Left})

            Root:canvas = canvas{}
            Root.AddWidget(canvas_slot{Anchors := anchors{Minimum := vector2{X := 0.015, Y := 0.30}, Maximum := vector2{X := 0.015, Y := 0.30}}, Alignment := vector2{X := 0.0, Y := 0.0}, SizeToContent := true, Widget := Panel})
            Root.AddWidget(canvas_slot{Anchors := anchors{Minimum := vector2{X := 0.5, Y := 0.07}, Maximum := vector2{X := 0.5, Y := 0.07}}, Alignment := vector2{X := 0.5, Y := 0.0}, SizeToContent := true, Widget := PhaseBlock})
            PlayerUI.AddWidget(Root, player_ui_slot{InputMode := ui_input_mode.None})
            set MaybeRoot = option{Root}

    Hide():void =
        if (Root := MaybeRoot?, PlayerUI := GetPlayerUI[Player]):
            PlayerUI.RemoveWidget(Root)
        set MaybeRoot = false

    SetPhase(Text:string):void =
        PhaseBlock.SetText(HudText(Text))

    SetLevel(Level:int, Title:string, XPIntoLevel:int, XPForNext:int):void =
        LevelBlock.SetText(HudText("LEVEL {Level}  {Title}"))
        if (XPForNext > 0):
            XPBlock.SetText(HudText("XP {XPIntoLevel} / {XPForNext}"))
        else:
            XPBlock.SetText(HudText("MAX LEVEL"))

    SetBag(Carried:int, Capacity:int):void =
        BagBlock.SetText(HudText("BAG {Carried} / {Capacity}"))
        if (Carried >= Capacity):
            BagBlock.SetTextColor(NamedColors.Orange)
        else:
            BagBlock.SetTextColor(NamedColors.White)

    SetVault(TeamName:string, Banked:int):void =
        VaultBlock.SetText(HudText("{TeamName} VAULT {Banked}"))

    SetContracts(Lines:[]string):void =
        ContractHeader.SetText(HudText("DAILY CONTRACTS"))
        if (Line0 := Lines[0]):
            ContractBlock0.SetText(HudText(Line0))
        if (Line1 := Lines[1]):
            ContractBlock1.SetText(HudText(Line1))
        if (Line2 := Lines[2]):
            ContractBlock2.SetText(HudText(Line2))

##########################################################################
# Modul: main_game.verse
##########################################################################

# Sky Heist: BANK IT! - main game device.
#
# Round loop:  waiting -> intermission (hub) -> heist round -> results -> ...
# Core loop:   grab loot (orbs, safes, guards, jackpot) into a capacity-limited
#              bag -> bank it at your team's vault zone (combo bonus) -> knock
#              opponents out to steal half their bag, or rob their vault.
# Meta loop:   round XP -> persistent level (bigger bag, better starting kit,
#              titles) + three rotating daily contracts.
#
# Design rules enforced here:
#   * Every device event is subscribed exactly once (OnBegin). Per-character
#     events are cancelled before every re-subscribe, so respawns never stack.
#   * Handlers ignore everything outside the Active phase, so late events from
#     the previous round cannot pay out twice.
#   * One coroutine (the round loop) owns phase changes and ticks once per
#     second; everything else is event driven.
#   * Optional devices are arrays: an empty array switches the feature off.
#
# See design/device_setup.md for the exact editor wiring.


GameText<localizes>(Text:string):message = "{Text}"

heist_phase := enum:
    WaitingForPlayers
    Intermission
    Active
    Results

heist_event := enum:
    NoEvent
    GoldRush
    VaultOpen
    SafeStorm
    BountyHunt

# One team base: where the team spawns during a round, banks and defends.
heist_base := class<concrete>:
    # Entering this zone banks the bag of a player on this team.
    @editable
    BankZone:mutator_zone_device = mutator_zone_device{}

    # Enemies hold-interact here to rob this team's banked loot.
    @editable
    VaultButton:button_device = button_device{}

    # Players are moved here when a round starts.
    @editable
    RoundStartTeleporter:teleporter_device = teleporter_device{}

    # Team-restricted spawn pads, enabled only while a round runs.
    @editable
    BaseSpawners:[]player_spawner_device = array{}

    # Optional: shows this team's banked total.
    @editable
    VaultBillboards:[]billboard_device = array{}

    # Optional: burst effect when someone banks here.
    @editable
    BankEffects:[]vfx_spawner_device = array{}

    # Optional: alarm when this vault gets robbed.
    @editable
    VaultAlarms:[]audio_player_device = array{}

# Verse callbacks cannot capture variables, so small handler objects carry the
# index of the device that fired.
bank_zone_handler := class:
    Game:sky_heist_game
    BaseIndex:int
    OnEnter(Agent:agent):void = Game.OnBankZoneEntered(BaseIndex, Agent)

vault_rob_handler := class:
    Game:sky_heist_game
    BaseIndex:int
    OnInteract(Agent:agent):void = Game.OnVaultInteracted(BaseIndex, Agent)

safe_handler := class:
    Game:sky_heist_game
    SafeIndex:int
    OnInteract(Agent:agent):void = Game.OnSafeCracked(SafeIndex, Agent)

character_handler := class:
    Game:sky_heist_game
    Player:player
    OnEliminated(Result:elimination_result):void = Game.OnPlayerEliminated(Player, Result)
    OnDamaged(Result:damage_result):void = Game.OnPlayerDamaged(Player, Result)

sky_heist_game := class(creative_device):

    # ------------------------------------------------------------------
    # Timing (seconds). Defaults are the tuned starting point; see
    # design/gameplay_systems.md before changing them.
    # ------------------------------------------------------------------
    @editable
    IntermissionSeconds:float = 15.0
    @editable
    RoundSeconds:float = 240.0
    @editable
    HeatSeconds:float = 45.0
    @editable
    ResultsSeconds:float = 8.0
    @editable
    LootWaveSeconds:float = 30.0
    @editable
    FirstEventDelaySeconds:float = 40.0
    @editable
    EventIntervalSeconds:float = 50.0
    @editable
    EventDurationSeconds:float = 25.0
    @editable
    VaultRobCooldownSeconds:float = 20.0
    @editable
    KnockoutCreditSeconds:float = 8.0
    @editable
    MinPlayersToStart:int = 1
    # Vault guards also spawn at round start when this many players or fewer
    # are in the session, so solo players always have something to fight.
    @editable
    SoloGuardThreshold:int = 2

    # ------------------------------------------------------------------
    # World
    # ------------------------------------------------------------------
    # One entry per team, in island team order (team 1 = index 0).
    @editable
    Bases:[]heist_base = array{}
    @editable
    TeamNames:[]string = array{"RED", "BLUE", "GREEN", "GOLD"}
    # Spawn pads in the hub, enabled between rounds.
    @editable
    HubSpawners:[]player_spawner_device = array{}
    # Players return here after each round (first entry is used).
    @editable
    HubTeleporters:[]teleporter_device = array{}
    @editable
    LootOrbs:[]collectible_object_device = array{}
    @editable
    Safes:[]button_device = array{}
    @editable
    VaultGuards:[]guard_spawner_device = array{}
    # Barriers that keep the central Mega Vault closed until an event opens it.
    @editable
    VaultGates:[]barrier_device = array{}
    # Hold-interact buttons inside the Mega Vault, active during Heat only.
    @editable
    JackpotButtons:[]button_device = array{}
    @editable
    BountyMarkers:[]player_marker_device = array{}
    # Starting kit per loadout tier (index 0 = level 1). See heist_rules.
    @editable
    StarterLoadouts:[]item_granter_device = array{}
    # Optional: mirrors banked loot into Fortnite's native scoreboard.
    @editable
    BankScoreManagers:[]score_manager_device = array{}

    # ------------------------------------------------------------------
    # Feedback
    # ------------------------------------------------------------------
    # Entry 0 shows per-player toasts. Optional entry 1 shows round and event
    # banners, so a banner never hides a personal message (a HUD message
    # device displays one message at a time).
    @editable
    Announcers:[]hud_message_device = array{}
    @editable
    PickupSounds:[]audio_player_device = array{}
    @editable
    BankSounds:[]audio_player_device = array{}
    @editable
    StealSounds:[]audio_player_device = array{}
    @editable
    EventSounds:[]audio_player_device = array{}
    @editable
    HeatMusic:[]audio_player_device = array{}
    @editable
    VictorySounds:[]audio_player_device = array{}
    @editable
    ResultBillboards:[]billboard_device = array{}

    # ------------------------------------------------------------------
    # Analytics (optional, shows up in the island's analytics dashboard)
    # ------------------------------------------------------------------
    @editable
    FirstBankAnalytics:[]analytics_device = array{}
    @editable
    RoundCompleteAnalytics:[]analytics_device = array{}
    @editable
    SecondRoundAnalytics:[]analytics_device = array{}
    @editable
    ContractCompleteAnalytics:[]analytics_device = array{}
    @editable
    LevelUpAnalytics:[]analytics_device = array{}

    # ------------------------------------------------------------------
    # Runtime state
    # ------------------------------------------------------------------
    var Phase:heist_phase = heist_phase.WaitingForPlayers
    var ActiveEvent:heist_event = heist_event.NoEvent
    var LastEvent:heist_event = heist_event.NoEvent
    var HeatActive:logic = false
    var RoundNumber:int = 0
    var TeamBanked:[]int = array{}
    var VaultReadyAt:[]float = array{}
    var SafeBaseInteractTimes:[]float = array{}
    # Explicit availability flags: two players finishing the same interaction in
    # the same frame both fire InteractedWithEvent, so the device being
    # disabled is not enough to prevent a double payout.
    var SafeAvailable:[]logic = array{}
    var JackpotClaimed:logic = false
    var States:[player]heist_player_state = map{}
    var Huds:[player]heist_hud = map{}
    var BountyTarget:?player = false
    var Today:int = -1
    var TodayContracts:[]int = array{0, 1, 3}

    # ==================================================================
    # Startup
    # ==================================================================

    OnBegin<override>()<suspends>:void =
        SetupIsValid:logic = ValidateSetup()
        if (not SetupIsValid?):
            Print("Sky Heist: setup incomplete, rounds disabled. See messages above and design/device_setup.md.")
        else:
            RefreshDay()
            CaptureSafeTimes()
            SubscribeWorldDevices()
            Playspace := GetPlayspace()
            Playspace.PlayerAddedEvent().Subscribe(OnPlayerAdded)
            Playspace.PlayerRemovedEvent().Subscribe(OnPlayerRemoved)
            for (Player : Playspace.GetPlayers()):
                OnPlayerAdded(Player)
            EnterHubMode()
            loop:
                WaitForPlayers()
                RunIntermission()
                RunRound()
                RunResults()

    # Prints what is missing and returns false when the island cannot run
    # rounds. Deliberately not <decides>: a failing <decides> call would roll
    # back the Print calls that explain the problem.
    ValidateSetup():logic =
        var Valid:logic = true
        if (Bases.Length = 0):
            Print("Sky Heist: 'Bases' is empty - add one heist_base per team.")
            set Valid = false
        for (Index -> Base : Bases, Base.BaseSpawners.Length = 0):
            Print("Sky Heist: Bases[{Index}] has no BaseSpawners.")
            set Valid = false
        if (HubSpawners.Length = 0):
            Print("Sky Heist: 'HubSpawners' is empty - players need a hub spawn.")
            set Valid = false
        if (HubTeleporters.Length = 0):
            Print("Sky Heist: 'HubTeleporters' is empty - players cannot return to the hub.")
            set Valid = false
        if (Announcers.Length = 0):
            Print("Sky Heist: warning - no Announcers, players will not see toast messages.")
        if (LootOrbs.Length = 0 and Safes.Length = 0):
            Print("Sky Heist: warning - no LootOrbs or Safes, the only loot comes from guards and steals.")
        if (StarterLoadouts.Length = 0):
            Print("Sky Heist: warning - no StarterLoadouts, players start without items.")
        Valid

    CaptureSafeTimes():void =
        set SafeBaseInteractTimes = for (Safe : Safes) { Safe.GetInteractionTime() }
        set SafeAvailable = for (Safe : Safes) { false }

    SubscribeWorldDevices():void =
        for (Index -> Base : Bases):
            ZoneHandler := bank_zone_handler{Game := Self, BaseIndex := Index}
            Base.BankZone.AgentEntersEvent.Subscribe(ZoneHandler.OnEnter)
            VaultHandler := vault_rob_handler{Game := Self, BaseIndex := Index}
            Base.VaultButton.InteractedWithEvent.Subscribe(VaultHandler.OnInteract)
            for (Spawner : Base.BaseSpawners):
                Spawner.SpawnedEvent.Subscribe(OnPlayerSpawned)
        for (Spawner : HubSpawners):
            Spawner.SpawnedEvent.Subscribe(OnPlayerSpawned)
        for (Orb : LootOrbs):
            Orb.CollectedEvent.Subscribe(OnOrbCollected)
        for (Index -> Safe : Safes):
            Handler := safe_handler{Game := Self, SafeIndex := Index}
            Safe.InteractedWithEvent.Subscribe(Handler.OnInteract)
        for (Guards : VaultGuards):
            Guards.EliminatedEvent.Subscribe(OnGuardEliminated)
        for (Jackpot : JackpotButtons):
            Jackpot.InteractedWithEvent.Subscribe(OnJackpotCracked)

    # ==================================================================
    # Players joining, spawning and leaving
    # ==================================================================

    OnPlayerAdded(Player:player):void =
        if (not States[Player]):
            State := heist_player_state{Player := Player}
            State.LoadFrom(LoadHeistSave(Player))
            State.RefreshContracts(Today)
            set State.TeamIndex = TeamIndexOf(Player)
            if (set States[Player] = State) {}
            Hud := heist_hud{Player := Player}
            Hud.Show()
            if (set Huds[Player] = Hud) {}
            RefreshFullHud(Player, State)
            SubscribeCharacter(Player)

    OnPlayerSpawned(Agent:agent):void =
        if (Player := player[Agent]):
            if (not States[Player]):
                OnPlayerAdded(Player)
            SubscribeCharacter(Player)
            # The player UI may not exist yet when PlayerAddedEvent fires;
            # Show() is idempotent, so retrying on every spawn is safe.
            if (Hud := Huds[Player]):
                Hud.Show()
            if (State := States[Player]):
                set State.TeamIndex = TeamIndexOf(Player)
                set State.LastDamager = false
                RefreshFullHud(Player, State)
                if (Phase = heist_phase.Active):
                    GrantLoadout(Player, State)
                    if (not State.TutorialDone?):
                        Toast(Player, "Grab glowing LOOT and hold to crack SAFES!")

    OnPlayerRemoved(Player:player):void =
        if (State := States[Player]):
            CancelCharacterSubscriptions(State)
            # Carried loot of a leaver is lost; banked loot stays with the team.
            StoreHeistSave(Player, State.ToSave())
        if (Hud := Huds[Player]):
            Hud.Hide()
        if (IsBountyTarget[Player]):
            ClearBounty()
        set States = WithoutPlayerState(States, Player)
        set Huds = WithoutPlayerHud(Huds, Player)

    CancelCharacterSubscriptions(State:heist_player_state):void =
        if (OldElimination := State.EliminationSubscription?):
            OldElimination.Cancel()
        if (OldDamage := State.DamageSubscription?):
            OldDamage.Cancel()
        set State.EliminationSubscription = false
        set State.DamageSubscription = false

    # Safe to call any number of times: the previous subscriptions are always
    # cancelled first.
    SubscribeCharacter(Player:player):void =
        if (State := States[Player], Character := Player.GetFortCharacter[]):
            CancelCharacterSubscriptions(State)
            Handler := character_handler{Game := Self, Player := Player}
            set State.EliminationSubscription = option{Character.EliminatedEvent().Subscribe(Handler.OnEliminated)}
            set State.DamageSubscription = option{Character.DamagedEvent().Subscribe(Handler.OnDamaged)}

    WithoutPlayerState(Input:[player]heist_player_state, Removed:player)<transacts>:[player]heist_player_state =
        var Result:[player]heist_player_state = map{}
        for (Key -> Value : Input, Key <> Removed):
            if (set Result[Key] = Value) {}
        Result

    WithoutPlayerHud(Input:[player]heist_hud, Removed:player)<transacts>:[player]heist_hud =
        var Result:[player]heist_hud = map{}
        for (Key -> Value : Input, Key <> Removed):
            if (set Result[Key] = Value) {}
        Result

    # Team index of Agent, wrapped onto the configured bases.
    TeamIndexOf(Agent:agent)<transacts>:int =
        TeamCollection := GetPlayspace().GetTeamCollection()
        var Found:int = 0
        for (Index -> Team : TeamCollection.GetTeams(), TeamCollection.IsOnTeam[Agent, Team]):
            set Found = Index
        if (Wrapped := Mod[Found, Bases.Length]) then Wrapped else 0

    TeamName(TeamIndex:int)<transacts>:string =
        if (Name := TeamNames[TeamIndex]) then Name else "TEAM {TeamIndex + 1}"

    GrantLoadout(Player:player, State:heist_player_state):void =
        if (Granter := StarterLoadouts[LoadoutTierForLevel(State.GetLevel())]):
            Granter.GrantItem(Player)
        else if (Fallback := StarterLoadouts[0]):
            Fallback.GrantItem(Player)

    # ==================================================================
    # Round flow
    # ==================================================================

    WaitForPlayers()<suspends>:void =
        loop:
            if (GetPlayspace().GetPlayers().Length >= Max(MinPlayersToStart, 1)):
                break
            set Phase = heist_phase.WaitingForPlayers
            SetPhaseTextForAll("WAITING FOR PLAYERS")
            GetPlayspace().PlayerAddedEvent().Await()

    RunIntermission()<suspends>:void =
        set Phase = heist_phase.Intermission
        var Remaining:int = WholeSecondsUp(IntermissionSeconds)
        loop:
            if (Remaining <= 0):
                break
            SetPhaseTextForAll("NEXT HEIST IN {Remaining}")
            Sleep(1.0)
            set Remaining -= 1

    RunRound()<suspends>:void =
        set RoundNumber += 1
        StartRoundState()
        set Phase = heist_phase.Active
        EnterRoundMode()
        TeleportEveryoneToBases()
        AnnounceAll("HEIST STARTED! Grab loot and BANK IT at your vault.")
        RoundLength:float = Max(RoundSeconds, 60.0)
        HeatLength:float = Clamp(HeatSeconds, 0.0, RoundLength - 10.0)
        StartTime:float = GetSimulationElapsedTime()
        EndTime:float = StartTime + RoundLength
        var NextWaveAt:float = StartTime + Max(LootWaveSeconds, 5.0)
        var NextEventAt:float = StartTime + Max(FirstEventDelaySeconds, 5.0)
        var EventEndsAt:float = 0.0
        loop:
            Now:float = GetSimulationElapsedTime()
            if (Now >= EndTime or GetPlayspace().GetPlayers().Length = 0):
                break
            if (not HeatActive?, Now >= EndTime - HeatLength):
                StartHeat()
            if (Now >= NextWaveAt):
                SpawnLootWave()
                set NextWaveAt = Now + Max(LootWaveSeconds, 5.0)
            if (ActiveEvent <> heist_event.NoEvent, Now >= EventEndsAt):
                EndEvent()
            if (not HeatActive?, ActiveEvent = heist_event.NoEvent, Now >= NextEventAt):
                StartRandomEvent()
                set EventEndsAt = Now + Max(EventDurationSeconds, 5.0)
                set NextEventAt = Now + Max(EventIntervalSeconds, EventDurationSeconds + 5.0)
            SetRoundClockForAll(WholeSecondsUp(EndTime - Now))
            Sleep(1.0)
        if (ActiveEvent <> heist_event.NoEvent):
            EndEvent()
        FinishRound()

    RunResults()<suspends>:void =
        Sleep(Max(ResultsSeconds, 1.0))
        EnterHubMode()
        if (Hub := HubTeleporters[0]):
            for (Player -> State : States):
                Hub.Teleport(Player)

    StartRoundState():void =
        var Zeros:[]int = array{}
        var ZeroTimes:[]float = array{}
        for (Base : Bases):
            set Zeros += array{0}
            set ZeroTimes += array{0.0}
        set TeamBanked = Zeros
        set VaultReadyAt = ZeroTimes
        set HeatActive = false
        set JackpotClaimed = false
        set ActiveEvent = heist_event.NoEvent
        ClearBounty()
        RefreshDay()
        for (Player -> State : States):
            State.ResetRound()
            set State.TeamIndex = TeamIndexOf(Player)
            RefreshFullHud(Player, State)
        UpdateVaultDisplays()

    EnterRoundMode():void =
        for (Base : Bases, Spawner : Base.BaseSpawners):
            Spawner.Enable()
        for (Spawner : HubSpawners):
            Spawner.Disable()
        for (Base : Bases):
            Base.BankZone.Enable()
            Base.VaultButton.Enable()
        for (Gate : VaultGates):
            Gate.Enable()
        for (Jackpot : JackpotButtons):
            Jackpot.Disable()
        SpawnLootWave()
        if (GetPlayspace().GetPlayers().Length <= SoloGuardThreshold):
            SpawnGuards()

    EnterHubMode():void =
        for (Spawner : HubSpawners):
            Spawner.Enable()
        for (Base : Bases, Spawner : Base.BaseSpawners):
            Spawner.Disable()
        for (Base : Bases):
            Base.BankZone.Disable()
            Base.VaultButton.Disable()
        SetAllSafesUnavailable()
        for (Jackpot : JackpotButtons):
            Jackpot.Disable()
        for (Gate : VaultGates):
            Gate.Enable()
        for (Music : HeatMusic):
            Music.Stop()
        DespawnGuards()
        ClearBounty()

    TeleportEveryoneToBases():void =
        for (Player -> State : States):
            set State.TeamIndex = TeamIndexOf(Player)
            if (Base := Bases[State.TeamIndex]):
                Base.RoundStartTeleporter.Teleport(Player)
            GrantLoadout(Player, State)
            if (not State.TutorialDone?):
                Toast(Player, "Grab glowing LOOT and hold to crack SAFES!")

    SpawnLootWave():void =
        for (Orb : LootOrbs):
            Orb.RespawnForAll()
        SetAllSafesAvailable()

    SetAllSafesAvailable():void =
        for (Safe : Safes):
            Safe.Enable()
        set SafeAvailable = for (Safe : Safes) { true }

    SetAllSafesUnavailable():void =
        for (Safe : Safes):
            Safe.Disable()
        set SafeAvailable = for (Safe : Safes) { false }

    SpawnGuards():void =
        for (Guards : VaultGuards):
            Guards.Enable()
            Guards.Spawn()

    DespawnGuards():void =
        for (Guards : VaultGuards):
            Guards.Despawn()
            Guards.Disable()

    StartHeat():void =
        if (ActiveEvent <> heist_event.NoEvent):
            EndEvent()
        set HeatActive = true
        for (Gate : VaultGates):
            Gate.Disable()
        for (Jackpot : JackpotButtons):
            Jackpot.Enable()
        SpawnGuards()
        for (Music : HeatMusic):
            Music.Play()
        AnnounceAll("HEAT! Banked loot counts DOUBLE - the Mega Vault is open!")

    FinishRound():void =
        set Phase = heist_phase.Results
        set HeatActive = false
        ClearBounty()
        for (Music : HeatMusic):
            Music.Stop()
        for (Jackpot : JackpotButtons):
            Jackpot.Disable()
        var BestScore:int = 0
        for (Score : TeamBanked):
            set BestScore = Max(BestScore, Score)
        for (Player -> State : States):
            Won:logic = if (BestScore > 0, Score := TeamBanked[State.TeamIndex], Score = BestScore) then true else false
            XP:int = RoundXP(State.RoundBanked, State.RoundSteals, State.RoundRobs, State.RoundSafes, Won)
            set State.RoundsPlayed = AddCapped(State.RoundsPlayed, 1, MaxStoredStat)
            set State.SessionRounds += 1
            if (Won?):
                set State.RoundsWon = AddCapped(State.RoundsWon, 1, MaxStoredStat)
                AdvanceContracts(Player, State, 4, 1)
                PlayFor(VictorySounds, Player)
            NewBest:logic = if (State.RoundBanked > State.BestRoundBanked) then true else false
            if (NewBest?):
                set State.BestRoundBanked = State.RoundBanked
            OldLevel:int = State.GetLevel()
            # The round summary is the last toast of the round, so it carries the
            # level-up news itself instead of being overwritten by it.
            AddXP(Player, State, XP, false)
            NewLevel:int = State.GetLevel()
            ResultText:string = if (Won?) then "YOUR TEAM WON!" else "Round over."
            BestText:string = if (NewBest?, State.RoundBanked > 0) then " NEW PERSONAL BEST!" else ""
            LevelText:string = if (NewLevel > OldLevel) then " LEVEL UP: {NewLevel} {TitleForLevel(NewLevel)}! {UnlockText(NewLevel)}" else ""
            Toast(Player, "{ResultText} You banked {State.RoundBanked} (+{XP} XP).{BestText}{LevelText}")
            StoreHeistSave(Player, State.ToSave())
            for (Tracker : RoundCompleteAnalytics):
                Tracker.Submit(Player)
            if (State.SessionRounds = 2):
                for (Tracker : SecondRoundAnalytics):
                    Tracker.Submit(Player)
        ShowResultsBoard(BestScore)
        SetPhaseTextForAll("ROUND OVER")

    ShowResultsBoard(BestScore:int):void =
        var Parts:[]string = array{}
        for (Index -> Score : TeamBanked):
            set Parts += array{"{TeamName(Index)} {Score}"}
        Summary:string = Join(Parts, "  |  ")
        Headline:string = if (BestScore > 0) then "LAST HEIST: {Summary}" else "LAST HEIST: nobody banked anything!"
        for (Board : ResultBillboards):
            Board.SetText(GameText(Headline))

    # ==================================================================
    # Events
    # ==================================================================

    StartRandomEvent():void =
        Choices:[]heist_event = array{heist_event.GoldRush, heist_event.VaultOpen, heist_event.SafeStorm, heist_event.BountyHunt}
        Candidates:[]heist_event = for (Candidate : Shuffle(Choices), Candidate <> LastEvent) { Candidate }
        if (Picked := Candidates[0]):
            set ActiveEvent = Picked
            set LastEvent = Picked
            for (Sound : EventSounds):
                Sound.Play()
            if (Picked = heist_event.GoldRush):
                AnnounceAll("GOLD RUSH! Loot is worth DOUBLE for a short time.")
            else if (Picked = heist_event.VaultOpen):
                for (Gate : VaultGates):
                    Gate.Disable()
                SpawnGuards()
                AnnounceAll("VAULT OPEN! Take out the guards for big loot.")
            else if (Picked = heist_event.SafeStorm):
                SetAllSafesAvailable()
                for (Index -> Safe : Safes, BaseTime := SafeBaseInteractTimes[Index]):
                    Safe.SetInteractionTime(Max(BaseTime * 0.5, 0.5))
                AnnounceAll("SAFE STORM! Every safe is back and cracks twice as fast.")
            else if (Picked = heist_event.BountyHunt):
                AnnounceAll("BOUNTY HUNT! The fullest bag gets marked - knock them out for a bonus.")
                UpdateBountyTarget()

    EndEvent():void =
        Ended:heist_event = ActiveEvent
        set ActiveEvent = heist_event.NoEvent
        if (Ended = heist_event.VaultOpen):
            if (not HeatActive?):
                for (Gate : VaultGates):
                    Gate.Enable()
                DespawnGuards()
        else if (Ended = heist_event.SafeStorm):
            for (Index -> Safe : Safes, BaseTime := SafeBaseInteractTimes[Index]):
                Safe.SetInteractionTime(BaseTime)
        else if (Ended = heist_event.BountyHunt):
            ClearBounty()

    EventLabel()<transacts>:string =
        if (HeatActive?):
            "  HEAT x2"
        else if (ActiveEvent = heist_event.GoldRush):
            "  GOLD RUSH"
        else if (ActiveEvent = heist_event.VaultOpen):
            "  VAULT OPEN"
        else if (ActiveEvent = heist_event.SafeStorm):
            "  SAFE STORM"
        else if (ActiveEvent = heist_event.BountyHunt):
            "  BOUNTY HUNT"
        else:
            ""

    # ==================================================================
    # Loot sources
    # ==================================================================

    OnOrbCollected(Agent:agent):void =
        if (Phase = heist_phase.Active, Player := player[Agent], State := States[Player]):
            Value:int = if (ActiveEvent = heist_event.GoldRush) then OrbLootValue * 2 else OrbLootValue
            GiveLoot(Player, State, Value, 0, "loot")

    OnSafeCracked(SafeIndex:int, Agent:agent):void =
        # One crack per safe per loot wave; the next wave re-enables it.
        if (Safe := Safes[SafeIndex]):
            Safe.Disable()
        if (Available := SafeAvailable[SafeIndex], Available?, set SafeAvailable[SafeIndex] = false, Phase = heist_phase.Active, Player := player[Agent], State := States[Player]):
            Value:int = if (ActiveEvent = heist_event.GoldRush) then SafeLootValue * 2 else SafeLootValue
            GiveLoot(Player, State, Value, 0, "from a safe")
            set State.RoundSafes += 1
            AdvanceContracts(Player, State, 3, 1)

    OnGuardEliminated(Result:device_ai_interaction_result):void =
        if (Phase = heist_phase.Active, Source := Result.Source?, Player := player[Source], State := States[Player]):
            GiveLoot(Player, State, GuardLootValue, 0, "from a vault guard")

    OnJackpotCracked(Agent:agent):void =
        # Only one jackpot per round, whoever finishes the interaction first.
        for (Jackpot : JackpotButtons):
            Jackpot.Disable()
        if (not JackpotClaimed?, Phase = heist_phase.Active, HeatActive?, Player := player[Agent], State := States[Player]):
            set JackpotClaimed = true
            # The jackpot may overflow a full bag so it is never wasted.
            GiveLoot(Player, State, JackpotLootValue, JackpotLootValue, "JACKPOT")
            AnnounceAll("JACKPOT CRACKED! Stop the carrier before they bank it!")
            SetBounty(Player)

    # Puts loot into the bag (capacity + ExtraCapacity). Returns what fit.
    GiveLoot(Player:player, State:heist_player_state, Amount:int, ExtraCapacity:int, Source:string):int =
        Capacity:int = State.GetCapacity()
        Before:int = State.Carried
        Limit:int = Max(Capacity + Max(ExtraCapacity, 0), Before)
        set State.Carried = AddCapped(Before, Amount, Limit)
        Added:int = State.Carried - Before
        if (Added > 0):
            PlayFor(PickupSounds, Player)
            if (State.Carried >= Capacity):
                Toast(Player, "+{Added} {Source} - BAG FULL! Bank it at your vault.")
            else:
                Toast(Player, "+{Added} {Source}")
        else if (Amount > 0):
            Toast(Player, "BAG FULL! Bank it at your vault.")
        if (not State.TutorialDone?, not State.BankHintShown?, State.Carried >= 5):
            set State.BankHintShown = true
            Toast(Player, "Run to your team's VAULT ZONE to bank your bag!")
        RefreshBag(Player, State)
        UpdateBountyTarget()
        Added

    # ==================================================================
    # Banking
    # ==================================================================

    OnBankZoneEntered(BaseIndex:int, Agent:agent):void =
        if (Phase = heist_phase.Active, Player := player[Agent], State := States[Player]):
            set State.TeamIndex = TeamIndexOf(Player)
            if (State.TeamIndex <> BaseIndex):
                if (State.Carried > 0):
                    Toast(Player, "Wrong vault! Bank at YOUR team's vault.")
            else if (State.Carried > 0):
                BankLoot(Player, State, BaseIndex)

    BankLoot(Player:player, State:heist_player_state, BaseIndex:int):void =
        Amount:int = State.Carried
        Level:int = State.GetLevel()
        Value:int = BankedValue(Amount, Level, HeatActive)
        Bonus:int = Max(Value - Amount, 0)
        set State.Carried = 0
        set State.RoundBanked = AddCapped(State.RoundBanked, Value, MaxStoredStat)
        set State.LifetimeBanked = AddCapped(State.LifetimeBanked, Value, MaxStoredStat)
        if (Current := TeamBanked[BaseIndex], set TeamBanked[BaseIndex] = AddCapped(Current, Value, MaxStoredStat)) {}
        BonusText:string = if (Bonus > 0) then " (bonus +{Bonus})" else ""
        Toast(Player, "BANKED +{Value}{BonusText}")
        PlayFor(BankSounds, Player)
        if (Base := Bases[BaseIndex]):
            for (Effect : Base.BankEffects):
                Effect.Restart()
        for (ScoreManager : BankScoreManagers):
            ScoreManager.SetScoreAward(Value)
            ScoreManager.Activate(Player)
        if (Amount >= ComboThresholdForLevel(Level)):
            AdvanceContracts(Player, State, 5, 1)
        AdvanceContracts(Player, State, 0, Value)
        if (not State.TutorialDone?):
            set State.TutorialDone = true
            for (Tracker : FirstBankAnalytics):
                Tracker.Submit(Player)
            Toast(Player, "Banked! Careful: enemies can rob your vault and steal your bag.")
        if (IsBountyTarget[Player]):
            ClearBounty()
        StoreHeistSave(Player, State.ToSave())
        RefreshBag(Player, State)
        UpdateVaultDisplays()
        UpdateBountyTarget()

    # ==================================================================
    # Stealing and robbing
    # ==================================================================

    OnPlayerDamaged(Victim:player, Result:damage_result):void =
        VictimAgent:agent = Victim
        if (State := States[Victim], Instigator := Result.Instigator?, Attacker := Instigator.GetInstigatorAgent[], Attacker <> VictimAgent):
            set State.LastDamager = option{Attacker}
            set State.LastDamageTime = GetSimulationElapsedTime()

    # Who gets credit for knocking Victim out: the eliminating character, or
    # (for knock-offs into the void) the last player who damaged them recently.
    CreditedThief(Victim:player, VictimState:heist_player_state, Result:elimination_result)<transacts><decides>:player =
        var Credited:?player = false
        if (Killer := Result.EliminatingCharacter?, KillerAgent := Killer.GetAgent[], KillerPlayer := player[KillerAgent], KillerPlayer <> Victim):
            set Credited = option{KillerPlayer}
        else if (Damager := VictimState.LastDamager?, DamagerPlayer := player[Damager], DamagerPlayer <> Victim, GetSimulationElapsedTime() - VictimState.LastDamageTime <= KnockoutCreditSeconds):
            set Credited = option{DamagerPlayer}
        Credited?

    OnPlayerEliminated(Victim:player, Result:elimination_result):void =
        if (Phase = heist_phase.Active, VictimState := States[Victim]):
            Lost:int = VictimState.Carried
            WasBounty:logic = if (IsBountyTarget[Victim]) then true else false
            set VictimState.Carried = 0
            if (Lost > 0):
                Toast(Victim, "Knocked out! You lost your bag of {Lost} loot.")
            if (Thief := CreditedThief[Victim, VictimState, Result], ThiefState := States[Thief], ThiefState.TeamIndex <> VictimState.TeamIndex):
                BountyBonus:int = if (WasBounty?) then BountyBonusLoot else 0
                Take:int = StealAmount(Lost) + BountyBonus
                if (Take > 0):
                    GiveLoot(Thief, ThiefState, Take, BountyBonus, "STOLEN")
                    set ThiefState.RoundSteals += 1
                    set ThiefState.LifetimeSteals = AddCapped(ThiefState.LifetimeSteals, 1, MaxStoredStat)
                    AdvanceContracts(Thief, ThiefState, 1, 1)
                    PlayFor(StealSounds, Thief)
            set VictimState.LastDamager = false
            if (WasBounty?):
                ClearBounty()
            RefreshBag(Victim, VictimState)
            UpdateBountyTarget()

    OnVaultInteracted(BaseIndex:int, Agent:agent):void =
        if (Phase = heist_phase.Active, Player := player[Agent], State := States[Player]):
            set State.TeamIndex = TeamIndexOf(Player)
            Now:float = GetSimulationElapsedTime()
            if (State.TeamIndex = BaseIndex):
                Toast(Player, "That's YOUR vault - defend it!")
            else if (ReadyAt := VaultReadyAt[BaseIndex], Now < ReadyAt):
                Toast(Player, "The vault alarm is still resetting. Try again soon!")
            else if (Banked := TeamBanked[BaseIndex]):
                Space:int = State.GetCapacity() - State.Carried
                Take:int = Min(VaultRobAmount(Banked), Space)
                if (Banked <= 0):
                    Toast(Player, "This vault is empty.")
                else if (Take <= 0):
                    Toast(Player, "Your bag is full - bank it first!")
                else if (set TeamBanked[BaseIndex] = Banked - Take, set VaultReadyAt[BaseIndex] = Now + VaultRobCooldownSeconds):
                    GiveLoot(Player, State, Take, 0, "ROBBED from their vault")
                    set State.RoundRobs += 1
                    set State.LifetimeVaultRobs = AddCapped(State.LifetimeVaultRobs, 1, MaxStoredStat)
                    AdvanceContracts(Player, State, 2, 1)
                    if (Base := Bases[BaseIndex]):
                        for (Alarm : Base.VaultAlarms):
                            Alarm.Play()
                    for (Member -> MemberState : States, MemberState.TeamIndex = BaseIndex):
                        Toast(Member, "YOUR VAULT WAS ROBBED! -{Take} loot")
                    UpdateVaultDisplays()

    # ==================================================================
    # Bounty
    # ==================================================================

    IsBountyTarget(Player:player)<transacts><decides>:void =
        Current := BountyTarget?
        Current = Player

    SetBounty(Player:player):void =
        ClearBounty()
        set BountyTarget = option{Player}
        for (Marker : BountyMarkers):
            Marker.Attach(Player)
        Toast(Player, "You are MARKED! Bank fast!")

    ClearBounty():void =
        if (Current := BountyTarget?):
            for (Marker : BountyMarkers):
                Marker.Detach(Current)
        set BountyTarget = false

    # During Bounty Hunt the fullest bag (at least 5) carries the mark.
    UpdateBountyTarget():void =
        if (ActiveEvent = heist_event.BountyHunt):
            var Best:?player = false
            var BestCarried:int = 4
            for (Player -> State : States):
                if (State.Carried > BestCarried):
                    set Best = option{Player}
                    set BestCarried = State.Carried
            if (NewTarget := Best?):
                if (not IsBountyTarget[NewTarget]):
                    SetBounty(NewTarget)
            else:
                ClearBounty()

    # ==================================================================
    # Progression
    # ==================================================================

    RefreshDay():void =
        NewDay:int = DayIndexFromSeconds(GetSecondsSinceEpoch())
        if (NewDay <> Today):
            set Today = NewDay
            set TodayContracts = ContractKindsForDay(NewDay)
            for (Player -> State : States):
                State.RefreshContracts(Today)
                RefreshContractsHud(Player, State)

    AddXP(Player:player, State:heist_player_state, Amount:int, AnnounceLevelUp:logic):void =
        if (Amount > 0):
            OldLevel:int = State.GetLevel()
            set State.TotalXP = AddCapped(State.TotalXP, Amount, MaxStoredXP)
            NewLevel:int = State.GetLevel()
            if (NewLevel > OldLevel):
                if (AnnounceLevelUp?):
                    Toast(Player, "LEVEL UP! Level {NewLevel} - {TitleForLevel(NewLevel)}. {UnlockText(NewLevel)}")
                for (Tracker : LevelUpAnalytics):
                    Tracker.Submit(Player)
            RefreshLevel(Player, State)
            RefreshBag(Player, State)

    UnlockText(Level:int)<transacts>:string =
        if (CarryCapacityForLevel(Level) > CarryCapacityForLevel(Level - 1)):
            "Bigger bag: {CarryCapacityForLevel(Level)}!"
        else if (LoadoutTierForLevel(Level) > LoadoutTierForLevel(Level - 1)):
            "New starting kit unlocked!"
        else if (ComboThresholdForLevel(Level) < ComboThresholdForLevel(Level - 1)):
            "Combo bonus now from {ComboThresholdForLevel(Level)} loot!"
        else:
            ""

    AdvanceContracts(Player:player, State:heist_player_state, Kind:int, Amount:int):void =
        Completed:[]int = State.AdvanceContract(TodayContracts, Kind, Amount)
        for (Slot : Completed):
            Toast(Player, "CONTRACT COMPLETE: {ContractLabel(Kind)} (+{ContractRewardXP} XP)")
            AddXP(Player, State, ContractRewardXP, true)
            for (Tracker : ContractCompleteAnalytics):
                Tracker.Submit(Player)
        if (Completed.Length > 0):
            StoreHeistSave(Player, State.ToSave())
        RefreshContractsHud(Player, State)

    # ==================================================================
    # Feedback helpers
    # ==================================================================

    Toast(Player:player, Text:string):void =
        if (Announcer := Announcers[0]):
            Announcer.Show(Player, GameText(Text), ?DisplayTime := 3.0)

    AnnounceAll(Text:string):void =
        if (Banner := Announcers[1]):
            for (Player -> State : States):
                Banner.Show(Player, GameText(Text), ?DisplayTime := 4.0)
        else:
            for (Player -> State : States):
                Toast(Player, Text)

    PlayFor(Sounds:[]audio_player_device, Player:player):void =
        for (Sound : Sounds):
            Sound.Play(Player)

    SetPhaseTextForAll(Text:string):void =
        for (Player -> Hud : Huds):
            Hud.SetPhase(Text)

    SetRoundClockForAll(SecondsLeft:int):void =
        SetPhaseTextForAll("HEIST {RoundNumber}  {FormatClock(SecondsLeft)}{EventLabel()}")

    RefreshFullHud(Player:player, State:heist_player_state):void =
        RefreshLevel(Player, State)
        RefreshBag(Player, State)
        RefreshContractsHud(Player, State)
        if (Hud := Huds[Player]):
            Banked:int = if (Value := TeamBanked[State.TeamIndex]) then Value else 0
            Hud.SetVault(TeamName(State.TeamIndex), Banked)

    RefreshLevel(Player:player, State:heist_player_state):void =
        if (Hud := Huds[Player]):
            Progress:level_progress = LevelProgressFromXP(State.TotalXP)
            Hud.SetLevel(Progress.Level, TitleForLevel(Progress.Level), Progress.XPIntoLevel, Progress.XPForNext)

    RefreshBag(Player:player, State:heist_player_state):void =
        if (Hud := Huds[Player]):
            Hud.SetBag(State.Carried, State.GetCapacity())

    RefreshContractsHud(Player:player, State:heist_player_state):void =
        if (Hud := Huds[Player]):
            Lines:[]string = for (Slot -> Kind : TodayContracts) { ContractLine(State, Slot, Kind) }
            Hud.SetContracts(Lines)

    ContractLine(State:heist_player_state, Slot:int, Kind:int)<transacts>:string =
        Progress:int = if (Value := State.ContractProgress[Slot]) then Value else 0
        if (Claimed := State.ContractClaimed[Slot], Claimed = 1):
            "[DONE] {ContractLabel(Kind)}"
        else:
            "{ContractLabel(Kind)} {Progress}/{ContractTarget(Kind)}"

    UpdateVaultDisplays():void =
        for (Index -> Base : Bases):
            Banked:int = if (Value := TeamBanked[Index]) then Value else 0
            for (Board : Base.VaultBillboards):
                Board.SetText(GameText("{TeamName(Index)} VAULT: {Banked}"))
        for (Player -> State : States, Hud := Huds[Player]):
            TeamValue:int = if (Value := TeamBanked[State.TeamIndex]) then Value else 0
            Hud.SetVault(TeamName(State.TeamIndex), TeamValue)
