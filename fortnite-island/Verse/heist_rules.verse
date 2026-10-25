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
