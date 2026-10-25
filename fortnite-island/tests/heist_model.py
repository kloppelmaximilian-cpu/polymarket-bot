"""Executable Python model of the Sky Heist rules and game-state machine.

Why this exists: the Verse compiler and the Fortnite runtime are not available
in this environment, so the gameplay logic cannot be executed in UEFN here.
This module mirrors the Verse code closely (same function names, same order of
operations) so the *logic* can be exercised with concrete scenarios:

  * heist_rules.verse      -> the module-level functions below (1:1)
  * heist_player.verse     -> PlayerState
  * main_game.verse        -> SkyHeistModel (handlers + round flow)

Devices are replaced by tiny recording stubs. Passing tests show that the
design and algorithms behave as intended; they do NOT prove that the Verse code
compiles or that devices behave exactly like these stubs in Fortnite.
test_heist_model.RuleParityTests keeps the constants in sync with the Verse
source.
"""
import math

# ---------------------------------------------------------------------------
# heist_rules.verse
# ---------------------------------------------------------------------------

MaxHeistLevel = 50
BaseCarryCapacity = 20
MaxStoredXP = 100000000
MaxStoredStat = 1000000000
MaxRoundXP = 1000
OrbLootValue = 1
SafeLootValue = 5
GuardLootValue = 8
JackpotLootValue = 25
BountyBonusLoot = 10
StealPercent = 50
VaultRobPercent = 15
VaultRobMax = 30
XPPerSteal = 3
XPPerVaultRob = 5
XPPerSafe = 2
XPForWin = 25
XPForTakingPart = 10
ContractsPerDay = 3
ContractKindCount = 6
ContractRewardXP = 60
SecondsPerDay = 86400.0


def clamp(value, low, high):
    return max(low, min(high, value))


def PercentOf(value, percent):
    if value > 0 and percent > 0:
        return (value * percent) // 100   # Quotient[] == floor division for positive divisors
    return 0


def AddCapped(current, amount, cap):
    return clamp(current + amount, 0, cap)


def WholeSecondsUp(seconds):
    return math.ceil(seconds) if seconds > 0.0 else 0


def FormatClock(total_seconds):
    s = max(total_seconds, 0)
    minutes, seconds = divmod(s, 60)
    return f"{minutes}:0{seconds}" if seconds < 10 else f"{minutes}:{seconds}"


def XPForNextLevel(level):
    if level >= MaxHeistLevel:
        return 0
    return 100 + 40 * (clamp(level, 1, MaxHeistLevel) - 1)


def LevelProgressFromXP(total_xp):
    level = 1
    remaining = clamp(total_xp, 0, MaxStoredXP)
    while True:
        need = XPForNextLevel(level)
        if need <= 0 or remaining < need:
            break
        remaining -= need
        level += 1
    return dict(Level=level, XPIntoLevel=remaining, XPForNext=XPForNextLevel(level))


def LevelFromXP(total_xp):
    return LevelProgressFromXP(total_xp)["Level"]


def CarryCapacityForLevel(level):
    if level >= 15:
        return BaseCarryCapacity + 15
    if level >= 7:
        return BaseCarryCapacity + 10
    if level >= 2:
        return BaseCarryCapacity + 5
    return BaseCarryCapacity


def LoadoutTierForLevel(level):
    return 2 if level >= 10 else 1 if level >= 3 else 0


def ComboThresholdForLevel(level):
    return 8 if level >= 5 else 10


def TitleForLevel(level):
    if level >= 35:
        return "Legend"
    if level >= 20:
        return "Mastermind"
    if level >= 10:
        return "Vault Breaker"
    if level >= 5:
        return "Pickpocket"
    return "Rookie"


def BankComboBonus(amount, level):
    if amount >= 20:
        return PercentOf(amount, 50)
    if amount >= ComboThresholdForLevel(level):
        return PercentOf(amount, 20)
    return 0


def BankedValue(amount, level, heat_active):
    if amount <= 0:
        return 0
    base = amount + BankComboBonus(amount, level)
    return base * 2 if heat_active else base


def StealAmount(victim_carried):
    return PercentOf(victim_carried, StealPercent)


def VaultRobAmount(team_banked):
    if team_banked <= 0:
        return 0
    return clamp(PercentOf(team_banked, VaultRobPercent), 1, min(VaultRobMax, team_banked))


def RoundXP(banked, steals, robs, safes, won):
    took_part = XPForTakingPart if (banked > 0 or steals > 0 or robs > 0 or safes > 0) else 0
    win_xp = XPForWin if won else 0
    raw = max(banked, 0) + XPPerSteal * max(steals, 0) + XPPerVaultRob * max(robs, 0) + XPPerSafe * max(safes, 0) + took_part + win_xp
    return clamp(raw, 0, MaxRoundXP)


def ContractTarget(kind):
    return {0: 60, 1: 3, 2: 2, 3: 5, 4: 1}.get(kind, 2)


def ContractLabel(kind):
    return {0: "Bank loot", 1: "Steal from players", 2: "Rob enemy vaults", 3: "Crack safes",
            4: "Win rounds"}.get(kind, "Combo banks")


def DayIndexFromSeconds(seconds):
    return math.floor(seconds / SecondsPerDay) if seconds > 0.0 else 0


def ContractKindsForDay(day):
    start = day % ContractKindCount
    return [start, (start + 1) % ContractKindCount, (start + 3) % ContractKindCount]


# ---------------------------------------------------------------------------
# heist_save.verse / heist_player.verse
# ---------------------------------------------------------------------------

def fresh_save():
    return dict(Version=1, TotalXP=0, LifetimeBanked=0, LifetimeSteals=0, LifetimeVaultRobs=0,
                RoundsPlayed=0, RoundsWon=0, BestRoundBanked=0, TutorialDone=False,
                ContractDay=-1, ContractProgress=[], ContractClaimed=[])


class PlayerState:
    def __init__(self, player):
        self.Player = player
        self.TeamIndex = 0
        self.Carried = 0
        self.RoundBanked = 0
        self.RoundSteals = 0
        self.RoundRobs = 0
        self.RoundSafes = 0
        self.SessionRounds = 0
        self.BankHintShown = False
        self.TotalXP = 0
        self.LifetimeBanked = 0
        self.LifetimeSteals = 0
        self.LifetimeVaultRobs = 0
        self.RoundsPlayed = 0
        self.RoundsWon = 0
        self.BestRoundBanked = 0
        self.TutorialDone = False
        self.ContractDay = -1
        self.ContractProgress = [0, 0, 0]
        self.ContractClaimed = [0, 0, 0]
        self.LastDamager = None
        self.LastDamageTime = -1000.0
        self.EliminationSubscription = None
        self.DamageSubscription = None

    def GetLevel(self):
        return LevelFromXP(self.TotalXP)

    def GetCapacity(self):
        return CarryCapacityForLevel(self.GetLevel())

    def LoadFrom(self, save):
        self.TotalXP = clamp(save["TotalXP"], 0, MaxStoredXP)
        for key in ("LifetimeBanked", "LifetimeSteals", "LifetimeVaultRobs", "RoundsPlayed", "RoundsWon", "BestRoundBanked"):
            setattr(self, key, clamp(save[key], 0, MaxStoredStat))
        self.TutorialDone = save["TutorialDone"]
        if len(save["ContractProgress"]) == ContractsPerDay and len(save["ContractClaimed"]) == ContractsPerDay:
            self.ContractDay = save["ContractDay"]
            self.ContractProgress = list(save["ContractProgress"])
            self.ContractClaimed = list(save["ContractClaimed"])
        else:
            self.ContractDay = -1
            self.ContractProgress = [0, 0, 0]
            self.ContractClaimed = [0, 0, 0]

    def ToSave(self):
        return dict(Version=1, TotalXP=self.TotalXP, LifetimeBanked=self.LifetimeBanked,
                    LifetimeSteals=self.LifetimeSteals, LifetimeVaultRobs=self.LifetimeVaultRobs,
                    RoundsPlayed=self.RoundsPlayed, RoundsWon=self.RoundsWon, BestRoundBanked=self.BestRoundBanked,
                    TutorialDone=self.TutorialDone, ContractDay=self.ContractDay,
                    ContractProgress=list(self.ContractProgress), ContractClaimed=list(self.ContractClaimed))

    def ResetRound(self):
        self.Carried = 0
        self.RoundBanked = 0
        self.RoundSteals = 0
        self.RoundRobs = 0
        self.RoundSafes = 0
        self.LastDamager = None
        self.LastDamageTime = -1000.0

    def RefreshContracts(self, today):
        if self.ContractDay != today:
            self.ContractDay = today
            self.ContractProgress = [0, 0, 0]
            self.ContractClaimed = [0, 0, 0]

    def AdvanceContract(self, kinds, kind, amount):
        completed = []
        if amount > 0:
            for slot, slot_kind in enumerate(kinds):
                if slot_kind != kind:
                    continue
                if slot < len(self.ContractProgress) and slot < len(self.ContractClaimed) and self.ContractClaimed[slot] == 0:
                    target = ContractTarget(kind)
                    new_progress = min(self.ContractProgress[slot] + amount, target)
                    self.ContractProgress[slot] = new_progress
                    if new_progress >= target:
                        self.ContractClaimed[slot] = 1
                        completed.append(slot)
        return completed


# ---------------------------------------------------------------------------
# Device stubs
# ---------------------------------------------------------------------------

class Subscription:
    def __init__(self, registry, key):
        self.registry = registry
        self.key = key
        self.active = True
        registry[key] = registry.get(key, 0) + 1

    def Cancel(self):
        if self.active:
            self.active = False
            self.registry[self.key] -= 1


class Recorder:
    """Records every call made on a stub device."""

    def __init__(self, name):
        self.name = name
        self.calls = []
        self.enabled = True

    def __getattr__(self, attr):
        def call(*args, **kwargs):
            self.calls.append((attr, args))
            if attr == "Enable":
                self.enabled = True
            elif attr == "Disable":
                self.enabled = False
        return call

    def count(self, attr):
        return sum(1 for a, _ in self.calls if a == attr)


class Base:
    def __init__(self, index):
        self.BankZone = Recorder(f"bank{index}")
        self.VaultButton = Recorder(f"vault{index}")
        self.RoundStartTeleporter = Recorder(f"tele{index}")
        self.BaseSpawners = [Recorder(f"spawn{index}")]
        self.VaultBillboards = [Recorder(f"board{index}")]
        self.BankEffects = [Recorder(f"vfx{index}")]
        self.VaultAlarms = [Recorder(f"alarm{index}")]


# ---------------------------------------------------------------------------
# main_game.verse
# ---------------------------------------------------------------------------

ACTIVE, INTERMISSION, RESULTS, WAITING = "Active", "Intermission", "Results", "WaitingForPlayers"
NO_EVENT, GOLD_RUSH, VAULT_OPEN, SAFE_STORM, BOUNTY_HUNT = "NoEvent", "GoldRush", "VaultOpen", "SafeStorm", "BountyHunt"


class SkyHeistModel:
    def __init__(self, teams=4, safes=4, orbs=10, guards=1, jackpots=1, loadouts=3, announcers=1,
                 hub_teleporters=1, hub_spawners=1, seconds_since_epoch=1_761_350_400.0,
                 knockout_credit_seconds=8.0, vault_rob_cooldown=20.0, solo_guard_threshold=2):
        self.Bases = [Base(i) for i in range(teams)]
        self.TeamNames = ["RED", "BLUE", "GREEN", "GOLD"]
        self.HubSpawners = [Recorder("hubspawn") for _ in range(hub_spawners)]
        self.HubTeleporters = [Recorder("hubtele") for _ in range(hub_teleporters)]
        self.Safes = [Recorder(f"safe{i}") for i in range(safes)]
        self.SafeInteractTimes = [3.0] * safes
        self.LootOrbs = [Recorder(f"orb{i}") for i in range(orbs)]
        self.VaultGuards = [Recorder(f"guards{i}") for i in range(guards)]
        self.VaultGates = [Recorder("gate")]
        self.JackpotButtons = [Recorder(f"jackpot{i}") for i in range(jackpots)]
        self.BountyMarkers = [Recorder("marker")]
        self.StarterLoadouts = [Recorder(f"loadout{i}") for i in range(loadouts)]
        self.Announcers = [Recorder("announcer") for _ in range(announcers)]
        self.KnockoutCreditSeconds = knockout_credit_seconds
        self.VaultRobCooldownSeconds = vault_rob_cooldown
        self.SoloGuardThreshold = solo_guard_threshold
        self.seconds_since_epoch = seconds_since_epoch
        self.now = 0.0
        # runtime
        self.Phase = WAITING
        self.ActiveEvent = NO_EVENT
        self.LastEvent = NO_EVENT
        self.HeatActive = False
        self.RoundNumber = 0
        self.TeamBanked = []
        self.VaultReadyAt = []
        self.SafeBaseInteractTimes = []
        self.SafeAvailable = []
        self.JackpotClaimed = False
        self.States = {}
        self.Huds = {}
        self.BountyTarget = None
        self.Today = -1
        self.TodayContracts = [0, 1, 3]
        # environment
        self.team_of = {}            # player -> island team index (Fortnite team assignment)
        self.in_session = set()
        self.saves = {}              # persistent weak_map
        self.subscriptions = {}      # (player, kind) -> active count
        self.toasts = []             # (player, text)
        self.print_log = []
        self.setup_valid = None

    # -- startup ---------------------------------------------------------------

    def ValidateSetup(self):
        valid = True
        if not self.Bases:
            self.print_log.append("Bases empty")
            valid = False
        for i, base in enumerate(self.Bases):
            if not base.BaseSpawners:
                self.print_log.append(f"Bases[{i}] has no spawners")
                valid = False
        if not self.HubSpawners:
            self.print_log.append("HubSpawners empty")
            valid = False
        if not self.HubTeleporters:
            self.print_log.append("HubTeleporters empty")
            valid = False
        return valid

    def OnBegin(self, players=()):
        self.setup_valid = self.ValidateSetup()
        if not self.setup_valid:
            return False
        self.RefreshDay()
        self.SafeBaseInteractTimes = list(self.SafeInteractTimes)
        self.SafeAvailable = [False for _ in self.Safes]
        for player in players:
            self.join(player)
        self.EnterHubMode()
        return True

    # -- environment helpers (what Fortnite does) ---------------------------------

    def join(self, player, team=None):
        self.in_session.add(player)
        self.team_of[player] = team if team is not None else len(self.team_of) % max(len(self.Bases), 1)
        self.OnPlayerAdded(player)

    def leave(self, player):
        self.OnPlayerRemoved(player)
        self.in_session.discard(player)

    def TeamIndexOf(self, player):
        found = self.team_of.get(player, 0)
        return found % len(self.Bases) if self.Bases else 0

    def store_save(self, player, save):
        if player in self.in_session:   # weak_map writes fail for players who left
            self.saves[player] = save

    # -- players ------------------------------------------------------------------

    def OnPlayerAdded(self, player):
        if player not in self.States:
            state = PlayerState(player)
            state.LoadFrom(self.saves.get(player, fresh_save()))
            state.RefreshContracts(self.Today)
            state.TeamIndex = self.TeamIndexOf(player)
            self.States[player] = state
            self.Huds[player] = {"shown": True}
            self.SubscribeCharacter(player)

    def OnPlayerSpawned(self, player):
        if player not in self.States:
            self.OnPlayerAdded(player)
        self.SubscribeCharacter(player)
        state = self.States.get(player)
        if state:
            state.TeamIndex = self.TeamIndexOf(player)
            state.LastDamager = None
            if self.Phase == ACTIVE:
                self.GrantLoadout(player, state)

    def OnPlayerRemoved(self, player):
        state = self.States.get(player)
        if state:
            self.CancelCharacterSubscriptions(state)
            self.store_save(player, state.ToSave())
        if player in self.Huds:
            self.Huds[player]["shown"] = False
        if self.BountyTarget == player:
            self.ClearBounty()
        self.States.pop(player, None)
        self.Huds.pop(player, None)

    def CancelCharacterSubscriptions(self, state):
        if state.EliminationSubscription:
            state.EliminationSubscription.Cancel()
        if state.DamageSubscription:
            state.DamageSubscription.Cancel()
        state.EliminationSubscription = None
        state.DamageSubscription = None

    def SubscribeCharacter(self, player):
        state = self.States.get(player)
        if state:
            self.CancelCharacterSubscriptions(state)
            state.EliminationSubscription = Subscription(self.subscriptions, (player, "elim"))
            state.DamageSubscription = Subscription(self.subscriptions, (player, "damage"))

    def GrantLoadout(self, player, state):
        tier = LoadoutTierForLevel(state.GetLevel())
        if tier < len(self.StarterLoadouts):
            self.StarterLoadouts[tier].GrantItem(player)
        elif self.StarterLoadouts:
            self.StarterLoadouts[0].GrantItem(player)

    # -- round flow -----------------------------------------------------------------

    def StartRound(self):
        """RunRound up to the tick loop."""
        self.RoundNumber += 1
        self.StartRoundState()
        self.Phase = ACTIVE
        self.EnterRoundMode()
        self.TeleportEveryoneToBases()

    def StartRoundState(self):
        self.TeamBanked = [0 for _ in self.Bases]
        self.VaultReadyAt = [0.0 for _ in self.Bases]
        self.HeatActive = False
        self.JackpotClaimed = False
        self.ActiveEvent = NO_EVENT
        self.ClearBounty()
        self.RefreshDay()
        for player, state in self.States.items():
            state.ResetRound()
            state.TeamIndex = self.TeamIndexOf(player)

    def EnterRoundMode(self):
        for base in self.Bases:
            for spawner in base.BaseSpawners:
                spawner.Enable()
        for spawner in self.HubSpawners:
            spawner.Disable()
        for base in self.Bases:
            base.BankZone.Enable()
            base.VaultButton.Enable()
        for gate in self.VaultGates:
            gate.Enable()
        for jackpot in self.JackpotButtons:
            jackpot.Disable()
        self.SpawnLootWave()
        if len(self.in_session) <= self.SoloGuardThreshold:
            self.SpawnGuards()

    def EnterHubMode(self):
        for spawner in self.HubSpawners:
            spawner.Enable()
        for base in self.Bases:
            for spawner in base.BaseSpawners:
                spawner.Disable()
            base.BankZone.Disable()
            base.VaultButton.Disable()
        self.SetAllSafesUnavailable()
        for jackpot in self.JackpotButtons:
            jackpot.Disable()
        for gate in self.VaultGates:
            gate.Enable()
        self.DespawnGuards()
        self.ClearBounty()

    def TeleportEveryoneToBases(self):
        for player, state in self.States.items():
            state.TeamIndex = self.TeamIndexOf(player)
            if state.TeamIndex < len(self.Bases):
                self.Bases[state.TeamIndex].RoundStartTeleporter.Teleport(player)
            self.GrantLoadout(player, state)

    def SpawnLootWave(self):
        for orb in self.LootOrbs:
            orb.RespawnForAll()
        self.SetAllSafesAvailable()

    def SetAllSafesAvailable(self):
        for safe in self.Safes:
            safe.Enable()
        self.SafeAvailable = [True for _ in self.Safes]

    def SetAllSafesUnavailable(self):
        for safe in self.Safes:
            safe.Disable()
        self.SafeAvailable = [False for _ in self.Safes]

    def SpawnGuards(self):
        for guards in self.VaultGuards:
            guards.Enable()
            guards.Spawn()

    def DespawnGuards(self):
        for guards in self.VaultGuards:
            guards.Despawn()
            guards.Disable()

    def StartHeat(self):
        if self.ActiveEvent != NO_EVENT:
            self.EndEvent()
        self.HeatActive = True
        for gate in self.VaultGates:
            gate.Disable()
        for jackpot in self.JackpotButtons:
            jackpot.Enable()
        self.SpawnGuards()

    def FinishRound(self):
        self.Phase = RESULTS
        self.HeatActive = False
        self.ClearBounty()
        for jackpot in self.JackpotButtons:
            jackpot.Disable()
        best = max(self.TeamBanked) if self.TeamBanked else 0
        best = max(best, 0)
        results = {}
        for player, state in self.States.items():
            score = self.TeamBanked[state.TeamIndex] if state.TeamIndex < len(self.TeamBanked) else None
            won = best > 0 and score == best
            xp = RoundXP(state.RoundBanked, state.RoundSteals, state.RoundRobs, state.RoundSafes, won)
            state.RoundsPlayed = AddCapped(state.RoundsPlayed, 1, MaxStoredStat)
            state.SessionRounds += 1
            if won:
                state.RoundsWon = AddCapped(state.RoundsWon, 1, MaxStoredStat)
                self.AdvanceContracts(player, state, 4, 1)
            if state.RoundBanked > state.BestRoundBanked:
                state.BestRoundBanked = state.RoundBanked
            self.AddXP(player, state, xp, False)
            self.store_save(player, state.ToSave())
            results[player] = dict(won=won, xp=xp)
        return results

    def RunResults(self):
        self.EnterHubMode()
        if self.HubTeleporters:
            for player in self.States:
                self.HubTeleporters[0].Teleport(player)

    # -- events -----------------------------------------------------------------------

    def StartEvent(self, picked):
        """StartRandomEvent with the random choice made by the caller."""
        if picked == self.LastEvent:
            return False
        self.ActiveEvent = picked
        self.LastEvent = picked
        if picked == VAULT_OPEN:
            for gate in self.VaultGates:
                gate.Disable()
            self.SpawnGuards()
        elif picked == SAFE_STORM:
            self.SetAllSafesAvailable()
            for index, safe in enumerate(self.Safes):
                if index < len(self.SafeBaseInteractTimes):
                    safe.SetInteractionTime(max(self.SafeBaseInteractTimes[index] * 0.5, 0.5))
        elif picked == BOUNTY_HUNT:
            self.UpdateBountyTarget()
        return True

    def EndEvent(self):
        ended = self.ActiveEvent
        self.ActiveEvent = NO_EVENT
        if ended == VAULT_OPEN:
            if not self.HeatActive:
                for gate in self.VaultGates:
                    gate.Enable()
                self.DespawnGuards()
        elif ended == SAFE_STORM:
            for index, safe in enumerate(self.Safes):
                if index < len(self.SafeBaseInteractTimes):
                    safe.SetInteractionTime(self.SafeBaseInteractTimes[index])
        elif ended == BOUNTY_HUNT:
            self.ClearBounty()

    # -- loot -------------------------------------------------------------------------

    def OnOrbCollected(self, player):
        state = self.States.get(player)
        if self.Phase == ACTIVE and state:
            value = OrbLootValue * 2 if self.ActiveEvent == GOLD_RUSH else OrbLootValue
            self.GiveLoot(player, state, value, 0, "loot")

    def OnSafeCracked(self, index, player):
        if index < len(self.Safes):
            self.Safes[index].Disable()
        state = self.States.get(player)
        if index < len(self.SafeAvailable) and self.SafeAvailable[index] and self.Phase == ACTIVE and state:
            self.SafeAvailable[index] = False
            value = SafeLootValue * 2 if self.ActiveEvent == GOLD_RUSH else SafeLootValue
            self.GiveLoot(player, state, value, 0, "from a safe")
            state.RoundSafes += 1
            self.AdvanceContracts(player, state, 3, 1)

    def OnGuardEliminated(self, source):
        state = self.States.get(source) if source is not None else None
        if self.Phase == ACTIVE and state:
            self.GiveLoot(source, state, GuardLootValue, 0, "from a vault guard")

    def OnJackpotCracked(self, player):
        for jackpot in self.JackpotButtons:
            jackpot.Disable()
        state = self.States.get(player)
        if not self.JackpotClaimed and self.Phase == ACTIVE and self.HeatActive and state:
            self.JackpotClaimed = True
            self.GiveLoot(player, state, JackpotLootValue, JackpotLootValue, "JACKPOT")
            self.SetBounty(player)

    def GiveLoot(self, player, state, amount, extra_capacity, source):
        capacity = state.GetCapacity()
        before = state.Carried
        limit = max(capacity + max(extra_capacity, 0), before)
        state.Carried = AddCapped(before, amount, limit)
        added = state.Carried - before
        if added > 0:
            self.toasts.append((player, f"+{added} {source}"))
        elif amount > 0:
            self.toasts.append((player, "BAG FULL! Bank it at your vault."))
        if not state.TutorialDone and not state.BankHintShown and state.Carried >= 5:
            state.BankHintShown = True
        self.UpdateBountyTarget()
        return added

    # -- banking ----------------------------------------------------------------------

    def OnBankZoneEntered(self, base_index, player):
        state = self.States.get(player)
        if self.Phase == ACTIVE and state:
            state.TeamIndex = self.TeamIndexOf(player)
            if state.TeamIndex != base_index:
                if state.Carried > 0:
                    self.toasts.append((player, "Wrong vault!"))
            elif state.Carried > 0:
                self.BankLoot(player, state, base_index)

    def BankLoot(self, player, state, base_index):
        amount = state.Carried
        level = state.GetLevel()
        value = BankedValue(amount, level, self.HeatActive)
        state.Carried = 0
        state.RoundBanked = AddCapped(state.RoundBanked, value, MaxStoredStat)
        state.LifetimeBanked = AddCapped(state.LifetimeBanked, value, MaxStoredStat)
        if base_index < len(self.TeamBanked):
            self.TeamBanked[base_index] = AddCapped(self.TeamBanked[base_index], value, MaxStoredStat)
        if amount >= ComboThresholdForLevel(level):
            self.AdvanceContracts(player, state, 5, 1)
        self.AdvanceContracts(player, state, 0, value)
        if not state.TutorialDone:
            state.TutorialDone = True
        if self.BountyTarget == player:
            self.ClearBounty()
        self.store_save(player, state.ToSave())
        self.UpdateBountyTarget()
        return value

    # -- stealing / robbing -------------------------------------------------------------

    def OnPlayerDamaged(self, victim, attacker):
        state = self.States.get(victim)
        if state and attacker is not None and attacker != victim:
            state.LastDamager = attacker
            state.LastDamageTime = self.now

    def CreditedThief(self, victim, victim_state, eliminating):
        if eliminating is not None and eliminating != victim:
            return eliminating
        damager = victim_state.LastDamager
        if damager is not None and damager != victim and self.now - victim_state.LastDamageTime <= self.KnockoutCreditSeconds:
            return damager
        return None

    def OnPlayerEliminated(self, victim, eliminating=None):
        victim_state = self.States.get(victim)
        if self.Phase == ACTIVE and victim_state:
            lost = victim_state.Carried
            was_bounty = self.BountyTarget == victim
            victim_state.Carried = 0
            thief = self.CreditedThief(victim, victim_state, eliminating)
            thief_state = self.States.get(thief) if thief is not None else None
            if thief_state and thief_state.TeamIndex != victim_state.TeamIndex:
                bonus = BountyBonusLoot if was_bounty else 0
                take = StealAmount(lost) + bonus
                if take > 0:
                    self.GiveLoot(thief, thief_state, take, bonus, "STOLEN")
                    thief_state.RoundSteals += 1
                    thief_state.LifetimeSteals = AddCapped(thief_state.LifetimeSteals, 1, MaxStoredStat)
                    self.AdvanceContracts(thief, thief_state, 1, 1)
            victim_state.LastDamager = None
            if was_bounty:
                self.ClearBounty()
            self.UpdateBountyTarget()

    def OnVaultInteracted(self, base_index, player):
        state = self.States.get(player)
        if not (self.Phase == ACTIVE and state):
            return "ignored"
        state.TeamIndex = self.TeamIndexOf(player)
        if state.TeamIndex == base_index:
            return "own"
        if base_index < len(self.VaultReadyAt) and self.now < self.VaultReadyAt[base_index]:
            return "cooldown"
        if base_index >= len(self.TeamBanked):
            return "ignored"
        banked = self.TeamBanked[base_index]
        space = state.GetCapacity() - state.Carried
        take = min(VaultRobAmount(banked), space)
        if banked <= 0:
            return "empty"
        if take <= 0:
            return "full"
        self.TeamBanked[base_index] = banked - take
        self.VaultReadyAt[base_index] = self.now + self.VaultRobCooldownSeconds
        self.GiveLoot(player, state, take, 0, "ROBBED")
        state.RoundRobs += 1
        state.LifetimeVaultRobs = AddCapped(state.LifetimeVaultRobs, 1, MaxStoredStat)
        self.AdvanceContracts(player, state, 2, 1)
        return "robbed"

    # -- bounty -------------------------------------------------------------------------

    def SetBounty(self, player):
        self.ClearBounty()
        self.BountyTarget = player
        for marker in self.BountyMarkers:
            marker.Attach(player)

    def ClearBounty(self):
        if self.BountyTarget is not None:
            for marker in self.BountyMarkers:
                marker.Detach(self.BountyTarget)
        self.BountyTarget = None

    def UpdateBountyTarget(self):
        if self.ActiveEvent == BOUNTY_HUNT:
            best, best_carried = None, 4
            for player, state in self.States.items():
                if state.Carried > best_carried:
                    best, best_carried = player, state.Carried
            if best is not None:
                if self.BountyTarget != best:
                    self.SetBounty(best)
            else:
                self.ClearBounty()

    # -- progression ---------------------------------------------------------------------

    def RefreshDay(self):
        new_day = DayIndexFromSeconds(self.seconds_since_epoch)
        if new_day != self.Today:
            self.Today = new_day
            self.TodayContracts = ContractKindsForDay(new_day)
            for state in self.States.values():
                state.RefreshContracts(self.Today)

    def AddXP(self, player, state, amount, announce_level_up=True):
        if amount > 0:
            old = state.GetLevel()
            state.TotalXP = AddCapped(state.TotalXP, amount, MaxStoredXP)
            if state.GetLevel() > old and announce_level_up:
                self.toasts.append((player, f"LEVEL UP {state.GetLevel()}"))

    def AdvanceContracts(self, player, state, kind, amount):
        completed = state.AdvanceContract(self.TodayContracts, kind, amount)
        for _slot in completed:
            self.AddXP(player, state, ContractRewardXP)
        if completed:
            self.store_save(player, state.ToSave())
        return completed
