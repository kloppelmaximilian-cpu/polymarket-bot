"""Scenario tests for the Sky Heist rules and state machine (Python model).

These exercise the logic of Verse/*.verse through tests/heist_model.py. They
cover the scenarios required for phase 6 of the brief: single player start,
simultaneous joins, respawn and elimination, round start/end, simultaneous
events, progression and rewards, reset, missing devices and odd states.

They test the algorithm, not the Fortnite runtime: see heist_model.py.

    python3 -m unittest discover -s tests -v
"""
import os
import re
import unittest

import heist_model as hm

VERSE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "Verse")


class RuleParityTests(unittest.TestCase):
    """The Python mirror must use exactly the constants of heist_rules.verse."""

    def test_constants_match_verse_source(self):
        with open(os.path.join(VERSE_DIR, "heist_rules.verse"), encoding="utf-8") as handle:
            source = handle.read()
        constants = dict(re.findall(r"^([A-Z]\w*):(?:int|float) = ([-\d.]+)\s*$", source, re.MULTILINE))
        self.assertGreaterEqual(len(constants), 20)
        for name, value in constants.items():
            self.assertTrue(hasattr(hm, name), f"model lacks constant {name}")
            expected = float(value) if "." in value else int(value)
            self.assertEqual(getattr(hm, name), expected, name)

    def test_every_rule_function_is_mirrored(self):
        with open(os.path.join(VERSE_DIR, "heist_rules.verse"), encoding="utf-8") as handle:
            source = handle.read()
        functions = re.findall(r"^([A-Z]\w*)\([^)]*\)<transacts>", source, re.MULTILINE)
        self.assertGreaterEqual(len(functions), 15)
        for name in functions:
            self.assertTrue(callable(getattr(hm, name, None)), f"model lacks function {name}")


class RuleTests(unittest.TestCase):

    def test_level_curve(self):
        self.assertEqual(hm.XPForNextLevel(1), 100)
        self.assertEqual(hm.XPForNextLevel(2), 140)
        self.assertEqual(hm.XPForNextLevel(hm.MaxHeistLevel), 0)
        self.assertEqual(hm.LevelFromXP(0), 1)
        self.assertEqual(hm.LevelFromXP(99), 1)
        self.assertEqual(hm.LevelFromXP(100), 2)
        self.assertEqual(hm.LevelFromXP(240), 3)
        self.assertEqual(hm.LevelProgressFromXP(250), dict(Level=3, XPIntoLevel=10, XPForNext=180))

    def test_level_is_bounded(self):
        self.assertEqual(hm.LevelFromXP(10 ** 12), hm.MaxHeistLevel)
        self.assertEqual(hm.LevelFromXP(-500), 1)
        self.assertEqual(hm.LevelProgressFromXP(10 ** 12)["XPForNext"], 0)

    def test_time_to_level_ten_is_reasonable(self):
        total = sum(hm.XPForNextLevel(l) for l in range(1, 10))
        # ~ 2,340 XP. A solid round gives ~80-150 XP, so level 10 takes roughly
        # 16-30 rounds (about 1.5-3 hours): visible progress without a grind wall.
        self.assertEqual(total, 2340)

    def test_capacity_and_unlocks(self):
        self.assertEqual([hm.CarryCapacityForLevel(l) for l in (1, 2, 6, 7, 14, 15, 50)], [20, 25, 25, 30, 30, 35, 35])
        self.assertEqual([hm.LoadoutTierForLevel(l) for l in (1, 2, 3, 9, 10)], [0, 0, 1, 1, 2])
        self.assertEqual(hm.ComboThresholdForLevel(4), 10)
        self.assertEqual(hm.ComboThresholdForLevel(5), 8)

    def test_bank_bonus(self):
        self.assertEqual(hm.BankedValue(0, 1, False), 0)
        self.assertEqual(hm.BankedValue(9, 1, False), 9)
        self.assertEqual(hm.BankedValue(10, 1, False), 12)
        self.assertEqual(hm.BankedValue(8, 5, False), 9)      # lower threshold after level 5
        self.assertEqual(hm.BankedValue(20, 1, False), 30)
        self.assertEqual(hm.BankedValue(20, 1, True), 60)     # heat doubles base + bonus
        self.assertEqual(hm.BankedValue(-5, 1, True), 0)

    def test_steal_and_rob(self):
        self.assertEqual(hm.StealAmount(0), 0)
        self.assertEqual(hm.StealAmount(1), 0)
        self.assertEqual(hm.StealAmount(15), 7)
        self.assertEqual(hm.VaultRobAmount(0), 0)
        self.assertEqual(hm.VaultRobAmount(3), 1)       # at least 1
        self.assertEqual(hm.VaultRobAmount(100), 15)
        self.assertEqual(hm.VaultRobAmount(10000), 30)  # capped

    def test_round_xp(self):
        self.assertEqual(hm.RoundXP(0, 0, 0, 0, False), 0)        # idle players earn nothing
        self.assertEqual(hm.RoundXP(0, 0, 0, 0, True), 25)        # a win still counts
        self.assertEqual(hm.RoundXP(50, 2, 1, 3, True), 50 + 6 + 5 + 6 + 10 + 25)
        self.assertEqual(hm.RoundXP(10 ** 9, 0, 0, 0, False), hm.MaxRoundXP)
        self.assertEqual(hm.RoundXP(-10, -1, -1, -1, False), 0)

    def test_contracts_rotate_without_duplicates(self):
        seen = set()
        for day in range(20000, 20012):
            kinds = hm.ContractKindsForDay(day)
            self.assertEqual(len(set(kinds)), 3)
            seen.add(tuple(kinds))
        self.assertEqual(len(seen), 6)

    def test_clock_format(self):
        self.assertEqual(hm.FormatClock(125), "2:05")
        self.assertEqual(hm.FormatClock(60), "1:00")
        self.assertEqual(hm.FormatClock(-3), "0:00")
        self.assertEqual(hm.WholeSecondsUp(0.2), 1)
        self.assertEqual(hm.WholeSecondsUp(-1.0), 0)


def make_game(players=("A",), **kwargs):
    game = hm.SkyHeistModel(**kwargs)
    game.OnBegin()
    for index, player in enumerate(players):
        game.join(player, team=index % len(game.Bases))
        game.OnPlayerSpawned(player)
    return game


class StartupTests(unittest.TestCase):

    def test_single_player_start(self):
        game = make_game(("Solo",))
        self.assertIn("Solo", game.States)
        game.StartRound()
        self.assertEqual(game.Phase, hm.ACTIVE)
        self.assertEqual(game.Bases[0].RoundStartTeleporter.count("Teleport"), 1)
        self.assertEqual(game.StarterLoadouts[0].count("GrantItem"), 1)
        # solo players get vault guards to fight right away
        self.assertEqual(game.VaultGuards[0].count("Spawn"), 1)
        self.assertTrue(all(game.SafeAvailable))

    def test_first_success_within_first_minute(self):
        game = make_game(("New",))
        game.StartRound()
        game.OnSafeCracked(0, "New")          # ~3 s interaction next to spawn
        game.OnOrbCollected("New")
        game.OnBankZoneEntered(0, "New")
        state = game.States["New"]
        self.assertEqual(state.RoundBanked, 6)
        self.assertTrue(state.TutorialDone)

    def test_missing_essential_devices_disable_rounds(self):
        game = hm.SkyHeistModel(teams=0)
        self.assertFalse(game.OnBegin())
        self.assertIn("Bases empty", game.print_log)
        game = hm.SkyHeistModel(hub_teleporters=0)
        self.assertFalse(game.OnBegin())

    def test_missing_optional_devices_do_not_break_a_round(self):
        game = make_game(("A", "B"), safes=0, orbs=0, guards=0, jackpots=0, loadouts=0, announcers=0)
        game.StartRound()
        game.StartHeat()
        game.OnJackpotCracked("A")
        game.OnSafeCracked(0, "A")
        results = game.FinishRound()
        self.assertEqual(set(results), {"A", "B"})


class MultiplayerTests(unittest.TestCase):

    def test_many_players_join_at_once(self):
        players = [f"P{i}" for i in range(16)]
        game = make_game(players)
        self.assertEqual(len(game.States), 16)
        for player in players:
            self.assertEqual(game.subscriptions[(player, "elim")], 1)
            self.assertEqual(game.States[player].TeamIndex, game.team_of[player] % 4)

    def test_respawns_never_stack_subscriptions(self):
        game = make_game(("A",))
        for _ in range(25):
            game.OnPlayerSpawned("A")
        self.assertEqual(game.subscriptions[("A", "elim")], 1)
        self.assertEqual(game.subscriptions[("A", "damage")], 1)

    def test_rejoin_keeps_progress(self):
        game = make_game(("A",))
        game.StartRound()
        game.OnSafeCracked(0, "A")
        game.OnBankZoneEntered(0, "A")
        game.FinishRound()
        xp = game.States["A"].TotalXP
        game.leave("A")
        self.assertNotIn("A", game.States)
        self.assertEqual(game.subscriptions[("A", "elim")], 0)
        game.join("A", team=0)
        self.assertEqual(game.States["A"].TotalXP, xp)

    def test_bank_only_at_own_vault(self):
        game = make_game(("A", "B"))
        game.StartRound()
        game.OnSafeCracked(0, "A")
        game.OnBankZoneEntered(1, "A")       # B's vault
        self.assertEqual(game.States["A"].Carried, 5)
        game.OnBankZoneEntered(0, "A")
        self.assertEqual(game.TeamBanked[0], 5)


class CombatTests(unittest.TestCase):

    def setUp(self):
        self.game = make_game(("A", "B", "C", "D", "E"))   # E is on team 0 with A
        self.game.StartRound()
        for _ in range(4):
            self.game.OnSafeCracked(0, "A") if self.game.SafeAvailable[0] else None
        self.game.States["A"].Carried = 16

    def test_direct_elimination_steals_half(self):
        self.game.OnPlayerEliminated("A", eliminating="B")
        self.assertEqual(self.game.States["A"].Carried, 0)
        self.assertEqual(self.game.States["B"].Carried, 8)
        self.assertEqual(self.game.States["B"].RoundSteals, 1)

    def test_knock_off_credits_recent_damager(self):
        self.game.now = 100.0
        self.game.OnPlayerDamaged("A", "C")
        self.game.now = 106.0
        self.game.OnPlayerEliminated("A", eliminating=None)   # fell into the void
        self.assertEqual(self.game.States["C"].Carried, 8)

    def test_old_damage_does_not_credit(self):
        self.game.now = 100.0
        self.game.OnPlayerDamaged("A", "C")
        self.game.now = 109.0
        self.game.OnPlayerEliminated("A", eliminating=None)
        self.assertEqual(self.game.States["C"].Carried, 0)

    def test_environment_and_self_damage_do_not_credit(self):
        self.game.OnPlayerDamaged("A", None)
        self.game.OnPlayerDamaged("A", "A")
        self.game.OnPlayerEliminated("A", eliminating="A")
        self.assertTrue(all(s.Carried == 0 for p, s in self.game.States.items()))

    def test_teammates_cannot_steal(self):
        self.game.OnPlayerEliminated("A", eliminating="E")
        self.assertEqual(self.game.States["E"].Carried, 0)
        self.assertEqual(self.game.States["A"].Carried, 0)

    def test_steal_respects_thief_capacity(self):
        self.game.States["B"].Carried = 18
        self.game.OnPlayerEliminated("A", eliminating="B")
        self.assertEqual(self.game.States["B"].Carried, 20)

    def test_trade_kill_is_consistent(self):
        self.game.States["B"].Carried = 10
        self.game.OnPlayerEliminated("A", eliminating="B")   # B: 10 + 8 = 18
        self.game.OnPlayerEliminated("B", eliminating="A")   # A was eliminated but the event still credits A
        self.assertEqual(self.game.States["B"].Carried, 0)
        self.assertEqual(self.game.States["A"].Carried, 9)
        self.assertEqual(sum(s.Carried for s in self.game.States.values()), 9)

    def test_events_outside_active_phase_are_ignored(self):
        self.game.FinishRound()
        before = {p: s.Carried for p, s in self.game.States.items()}
        self.game.OnPlayerEliminated("A", eliminating="B")
        self.game.OnOrbCollected("B")
        self.game.OnBankZoneEntered(1, "B")
        self.assertEqual(before, {p: s.Carried for p, s in self.game.States.items()})


class VaultTests(unittest.TestCase):

    def setUp(self):
        self.game = make_game(("A", "B"))
        self.game.StartRound()
        self.game.TeamBanked[1] = 100

    def test_rob_enemy_vault(self):
        self.assertEqual(self.game.OnVaultInteracted(1, "A"), "robbed")
        self.assertEqual(self.game.TeamBanked[1], 85)
        self.assertEqual(self.game.States["A"].Carried, 15)

    def test_cannot_rob_own_vault(self):
        self.assertEqual(self.game.OnVaultInteracted(1, "B"), "own")
        self.assertEqual(self.game.TeamBanked[1], 100)

    def test_cooldown_blocks_back_to_back_robs(self):
        self.game.now = 10.0
        self.game.OnVaultInteracted(1, "A")
        self.game.now = 20.0
        self.assertEqual(self.game.OnVaultInteracted(1, "A"), "cooldown")
        self.game.now = 30.0
        self.assertEqual(self.game.OnVaultInteracted(1, "A"), "robbed")   # cooldown over, 15 < 20 bag
        self.assertEqual(self.game.States["A"].Carried, 20)

    def test_rob_never_exceeds_bag_space(self):
        self.game.States["A"].Carried = 18
        self.game.OnVaultInteracted(1, "A")
        self.assertEqual(self.game.States["A"].Carried, 20)
        self.assertEqual(self.game.TeamBanked[1], 98)

    def test_empty_vault(self):
        self.game.TeamBanked[1] = 0
        self.assertEqual(self.game.OnVaultInteracted(1, "A"), "empty")


class SimultaneousEventTests(unittest.TestCase):

    def test_same_safe_cracked_twice_in_one_frame_pays_once(self):
        game = make_game(("A", "B"))
        game.StartRound()
        game.OnSafeCracked(2, "A")
        game.OnSafeCracked(2, "B")
        self.assertEqual(game.States["A"].Carried, 5)
        self.assertEqual(game.States["B"].Carried, 0)

    def test_jackpot_pays_once_and_only_in_heat(self):
        game = make_game(("A", "B"))
        game.StartRound()
        game.OnJackpotCracked("A")
        self.assertEqual(game.States["A"].Carried, 0)       # not heat yet
        game.StartHeat()
        game.OnJackpotCracked("A")
        game.OnJackpotCracked("B")
        self.assertEqual(game.States["A"].Carried, 25)
        self.assertEqual(game.States["B"].Carried, 0)
        self.assertEqual(game.BountyTarget, "A")

    def test_jackpot_never_wasted_on_full_bag(self):
        game = make_game(("A",))
        game.StartRound()
        game.States["A"].Carried = 20
        game.StartHeat()
        game.OnJackpotCracked("A")
        self.assertEqual(game.States["A"].Carried, 45)
        game.OnOrbCollected("A")                           # overflowed bag accepts nothing more
        self.assertEqual(game.States["A"].Carried, 45)

    def test_double_bank_enter_is_harmless(self):
        game = make_game(("A",))
        game.StartRound()
        game.States["A"].Carried = 12
        game.OnBankZoneEntered(0, "A")
        game.OnBankZoneEntered(0, "A")
        self.assertEqual(game.TeamBanked[0], 14)           # 12 + 20 % combo

    def test_heat_ends_running_event_first(self):
        game = make_game(("A", "B"))
        game.StartRound()
        self.assertTrue(game.StartEvent(hm.VAULT_OPEN))
        game.StartHeat()
        self.assertEqual(game.ActiveEvent, hm.NO_EVENT)
        self.assertFalse(game.VaultGates[0].enabled)        # heat keeps the vault open

    def test_same_event_never_twice_in_a_row(self):
        game = make_game(("A",))
        game.StartRound()
        self.assertTrue(game.StartEvent(hm.GOLD_RUSH))
        game.EndEvent()
        self.assertFalse(game.StartEvent(hm.GOLD_RUSH))

    def test_safe_storm_restores_interaction_time(self):
        game = make_game(("A",))
        game.StartRound()
        game.StartEvent(hm.SAFE_STORM)
        game.EndEvent()
        last = [args for name, args in game.Safes[0].calls if name == "SetInteractionTime"][-1]
        self.assertEqual(last, (3.0,))


class BountyTests(unittest.TestCase):

    def test_bounty_follows_fullest_bag_and_pays_bonus(self):
        game = make_game(("A", "B"))
        game.StartRound()
        game.StartEvent(hm.BOUNTY_HUNT)
        game.States["A"].Carried = 4
        game.OnOrbCollected("A")                           # 5 -> marked
        self.assertEqual(game.BountyTarget, "A")
        game.OnPlayerEliminated("A", eliminating="B")
        self.assertEqual(game.States["B"].Carried, 2 + hm.BountyBonusLoot)
        # The thief now holds the fullest bag, so the mark passes to them
        # ("hot potato") - intended, see design/gameplay_systems.md.
        self.assertEqual(game.BountyTarget, "B")

    def test_bounty_cleared_when_target_leaves(self):
        game = make_game(("A", "B"))
        game.StartRound()
        game.StartEvent(hm.BOUNTY_HUNT)
        game.States["A"].Carried = 9
        game.UpdateBountyTarget()
        game.leave("A")
        self.assertIsNone(game.BountyTarget)


class RoundAndProgressionTests(unittest.TestCase):

    def test_round_end_awards_xp_once_and_resets_next_round(self):
        game = make_game(("A", "B"))
        game.StartRound()
        game.States["A"].Carried = 10
        game.OnBankZoneEntered(0, "A")
        results = game.FinishRound()
        self.assertTrue(results["A"]["won"])
        self.assertFalse(results["B"]["won"])
        xp_after = game.States["A"].TotalXP
        game.OnBankZoneEntered(0, "A")                     # late event: ignored
        self.assertEqual(game.States["A"].TotalXP, xp_after)
        game.RunResults()
        game.StartRound()
        self.assertEqual(game.TeamBanked, [0, 0, 0, 0])
        self.assertEqual(game.States["A"].RoundBanked, 0)
        self.assertEqual(game.States["A"].Carried, 0)

    def test_tie_means_both_teams_win(self):
        game = make_game(("A", "B"))
        game.StartRound()
        game.TeamBanked[0] = game.TeamBanked[1] = 40
        results = game.FinishRound()
        self.assertTrue(results["A"]["won"] and results["B"]["won"])

    def test_nobody_banked_nobody_wins(self):
        game = make_game(("A", "B"))
        game.StartRound()
        results = game.FinishRound()
        self.assertFalse(any(r["won"] for r in results.values()))
        self.assertEqual(game.States["A"].TotalXP, 0)

    def test_level_up_increases_capacity(self):
        game = make_game(("A",))
        state = game.States["A"]
        game.AddXP("A", state, 100)
        self.assertEqual(state.GetLevel(), 2)
        self.assertEqual(state.GetCapacity(), 25)

    def test_contract_completes_once_per_day(self):
        game = make_game(("A",), seconds_since_epoch=86400.0 * 20000)   # day 20000 -> kinds [2, 3, 5]
        self.assertEqual(game.TodayContracts, [2, 3, 5])
        game.StartRound()
        state = game.States["A"]
        for index in range(len(game.Safes)):
            game.OnSafeCracked(index, "A")
        game.SpawnLootWave()
        game.OnSafeCracked(0, "A")                         # 5th safe completes "Crack safes"
        xp = state.TotalXP
        self.assertEqual(xp, hm.ContractRewardXP)
        game.SpawnLootWave()
        game.OnSafeCracked(1, "A")
        self.assertEqual(state.TotalXP, xp)                # no second payout

    def test_day_rollover_resets_contracts(self):
        game = make_game(("A",), seconds_since_epoch=86400.0 * 20000)
        game.States["A"].ContractProgress = [1, 4, 0]
        game.seconds_since_epoch += 86400.0
        game.StartRound()                                  # RefreshDay runs at round start
        self.assertEqual(game.States["A"].ContractProgress, [0, 0, 0])
        self.assertEqual(game.TodayContracts, hm.ContractKindsForDay(20001))

    def test_corrupt_or_old_save_is_sanitised(self):
        game = hm.SkyHeistModel()
        game.OnBegin()
        bad = hm.fresh_save()
        bad.update(TotalXP=-50, LifetimeBanked=10 ** 15, ContractProgress=[1, 2], ContractClaimed=[0])
        game.saves["X"] = bad
        game.join("X")
        state = game.States["X"]
        self.assertEqual(state.TotalXP, 0)
        self.assertEqual(state.LifetimeBanked, hm.MaxStoredStat)
        self.assertEqual(state.ContractProgress, [0, 0, 0])

    def test_leaver_cannot_be_saved_after_leaving(self):
        game = make_game(("A",))
        game.leave("A")
        game.store_save("A", {"TotalXP": 999})
        self.assertNotEqual(game.saves["A"].get("TotalXP"), 999)

    def test_long_session_values_stay_bounded(self):
        game = make_game(("A", "B"))
        for _ in range(300):                               # ~20 hours of rounds
            game.StartRound()
            game.States["A"].Carried = 20
            game.OnBankZoneEntered(0, "A")
            game.FinishRound()
            game.RunResults()
        state = game.States["A"]
        # 300 rounds x (30 banked + 10 taking part + 25 win) = 19,500 XP, plus the
        # day's "Win rounds" and "Combo banks" contracts (60 XP each, once) -> level 30.
        # Level 50 needs 51,940 XP: a long-term goal, not reachable in a weekend.
        self.assertEqual(game.TodayContracts, [4, 5, 1])
        self.assertEqual(state.TotalXP, 300 * 65 + 2 * hm.ContractRewardXP)
        self.assertEqual(state.GetLevel(), 30)
        self.assertEqual(sum(hm.XPForNextLevel(l) for l in range(1, hm.MaxHeistLevel)), 51940)
        self.assertEqual(game.subscriptions[("A", "elim")], 1)
        game.AddXP("A", state, 10 ** 12)
        self.assertEqual(state.TotalXP, hm.MaxStoredXP)
        self.assertEqual(state.GetLevel(), hm.MaxHeistLevel)


if __name__ == "__main__":
    unittest.main()
