"""Mutation tests for tools/verse_static_check.py.

A static checker that reports nothing is only useful if it would have reported
real mistakes. Each test copies the project's Verse files, injects exactly one
known-bad change and asserts that the checker flags it. The unmodified files
must produce no ERROR findings.

Requires the Verse digests (see README). Set VERSE_DIGEST_DIR or place them at
the default path; the tests are skipped when the digests are missing.

    python3 -m unittest discover -s tests -v
"""
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(PROJECT, "tools"))

import verse_static_check as vsc  # noqa: E402

DIGEST_DIR = os.environ.get("VERSE_DIGEST_DIR", "/home/user/kbfngg/uefn/Modules/FortniteGame")
VERSE_DIR = os.path.join(PROJECT, "Verse")
HAVE_DIGEST = os.path.exists(os.path.join(DIGEST_DIR, "Fortnite", "Fortnite.digest.verse"))

_DIGEST = None


def load_digest():
    global _DIGEST
    if _DIGEST is None:
        digest = vsc.Digest()
        for rel, root in (("Verse/Verse.digest.verse", "/Verse.org"),
                          ("UnrealEngine/UnrealEngine.digest.verse", "/UnrealEngine.com"),
                          ("Fortnite/Fortnite.digest.verse", "/Fortnite.com")):
            digest.load(os.path.join(DIGEST_DIR, rel), root)
        _DIGEST = digest
    return _DIGEST


def run_checker(verse_dir):
    project = vsc.Project()
    for fname in sorted(os.listdir(verse_dir)):
        if fname.endswith(".verse"):
            project.load(os.path.join(verse_dir, fname))
    return vsc.Checker(load_digest(), project).run()


@unittest.skipUnless(HAVE_DIGEST, "Verse digests not available")
class StaticCheckerMutationTests(unittest.TestCase):

    def mutate_and_check(self, fname, old, new, expected, severity="ERROR"):
        tmp = tempfile.mkdtemp()
        try:
            for f in os.listdir(VERSE_DIR):
                shutil.copy(os.path.join(VERSE_DIR, f), tmp)
            path = os.path.join(tmp, fname)
            with open(path, encoding="utf-8") as handle:
                text = handle.read()
            self.assertEqual(text.count(old), 1, f"mutation anchor not unique in {fname}: {old!r}")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(text.replace(old, new))
            findings = run_checker(tmp)
            hits = [f for f in findings if f.severity == severity and expected in f.message]
            self.assertTrue(hits, f"expected {severity} containing {expected!r}; got:\n" +
                            "\n".join(str(f) for f in findings))
        finally:
            shutil.rmtree(tmp)

    def test_unmodified_project_has_no_errors(self):
        findings = run_checker(VERSE_DIR)
        errors = [str(f) for f in findings if f.severity in ("ERROR", "UNRESOLVED")]
        self.assertEqual(errors, [])

    def test_unknown_device_method(self):
        self.mutate_and_check("main_game.verse", "Safe.SetInteractionTime(Max(BaseTime * 0.5, 0.5))",
                              "Safe.SetInteractionSpeed(Max(BaseTime * 0.5, 0.5))", "has no member 'SetInteractionSpeed'")

    def test_decides_called_with_parentheses(self):
        self.mutate_and_check("main_game.verse", "Character := Player.GetFortCharacter[]",
                              "Character := Player.GetFortCharacter()", "must be called with []")

    def test_brackets_on_non_decides_function(self):
        self.mutate_and_check("main_game.verse", "Hub.Teleport(Player)", "Hub.Teleport[Player]",
                              "is not <decides>")

    def test_suspends_call_from_plain_function(self):
        self.mutate_and_check("main_game.verse", "    SpawnLootWave():void =\n",
                              "    SpawnLootWave():void =\n        Sleep(1.0)\n", "<suspends> call")

    def test_device_call_inside_transacts_function(self):
        self.mutate_and_check("main_game.verse",
                              "        if (Name := TeamNames[TeamIndex]) then Name else \"TEAM {TeamIndex + 1}\"",
                              "        for (Safe : Safes):\n            Safe.Disable()\n"
                              "        if (Name := TeamNames[TeamIndex]) then Name else \"TEAM {TeamIndex + 1}\"",
                              "no rollback-safe effect")

    def test_missing_using_for_extension_method(self):
        self.mutate_and_check("main_game.verse", "using { /Fortnite.com/Characters }\n", "",
                              "not imported")

    def test_map_lookup_outside_failure_context(self):
        self.mutate_and_check("main_game.verse",
                              "    OnPlayerRemoved(Player:player):void =\n",
                              "    OnPlayerRemoved(Player:player):void =\n        Lost := States[Player]\n",
                              "outside a failure context")

    def test_unknown_named_color(self):
        self.mutate_and_check("heist_hud.verse", "BagBlock.SetTextColor(NamedColors.Orange)",
                              "BagBlock.SetTextColor(NamedColors.Pinkish)", "no member Pinkish")

    def test_unknown_enum_value(self):
        self.mutate_and_check("main_game.verse", "set Phase = heist_phase.Intermission",
                              "set Phase = heist_phase.Intermision", "has no value Intermision")

    def test_wrong_argument_count(self):
        self.mutate_and_check("main_game.verse", "Granter.GrantItem(Player)",
                              "Granter.GrantItem(Player, Player, Player)", "positional argument")

    def test_unknown_type_in_field(self):
        self.mutate_and_check("main_game.verse", "    VaultGates:[]barrier_device = array{}",
                              "    VaultGates:[]barier_device = array{}", "unknown type 'barier_device'",
                              severity="UNRESOLVED")

    def test_set_on_non_var_field(self):
        self.mutate_and_check("heist_player.verse", "    var RoundSafes:int = 0", "    RoundSafes:int = 0",
                              "is not declared var")

    def test_set_on_non_var_local(self):
        self.mutate_and_check("main_game.verse", "        var BestScore:int = 0", "        BestScore:int = 0",
                              "is not declared var")

    def test_unknown_archetype_field(self):
        self.mutate_and_check("heist_hud.verse", "BagBlock:text_block = text_block{DefaultTextColor := NamedColors.White}",
                              "BagBlock:text_block = text_block{DefaultTextColour := NamedColors.White}",
                              "unknown field 'DefaultTextColour'")

    def test_unknown_color_in_field_default(self):
        self.mutate_and_check("heist_hud.verse", "LevelBlock:text_block = text_block{DefaultTextColor := NamedColors.Gold}",
                              "LevelBlock:text_block = text_block{DefaultTextColor := NamedColors.Golden}",
                              "no member Golden")

    def test_unknown_field_in_colon_archetype(self):
        self.mutate_and_check("heist_player.verse", "            RoundsWon := Self.RoundsWon",
                              "            RoundWins := Self.RoundsWon", "unknown field 'RoundWins'")

    def test_tab_indentation(self):
        self.mutate_and_check("heist_rules.verse", "    Clamp(Current + Amount, 0, Cap)",
                              "\tClamp(Current + Amount, 0, Cap)", "tab character")

    def test_unbalanced_parenthesis(self):
        self.mutate_and_check("heist_rules.verse", "    Clamp(Current + Amount, 0, Cap)",
                              "    Clamp(Current + Amount, 0, Cap", "unbalanced")


if __name__ == "__main__":
    unittest.main()
