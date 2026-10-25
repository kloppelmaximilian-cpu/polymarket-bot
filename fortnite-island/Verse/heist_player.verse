# Sky Heist - runtime state for one player in the current session.
#
# heist_player_state mirrors the persistent heist_save (loaded on join, written
# back on bank / round end) and adds per-round counters plus the bookkeeping
# needed for fair steal attribution and leak-free event subscriptions.

using { /Verse.org/Simulation }

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
