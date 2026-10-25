"""Keeps the editor wiring guide in sync with the Verse device.

Every @editable field of sky_heist_game and heist_base must be explained in
design/device_setup.md, otherwise a creator cannot wire the island correctly.
"""
import os
import re
import unittest

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(*parts):
    with open(os.path.join(PROJECT, *parts), encoding="utf-8") as handle:
        return handle.read()


class DeviceSetupDocTests(unittest.TestCase):

    def test_every_editable_field_is_documented(self):
        lines = read("Verse", "main_game.verse").split("\n")
        doc = read("design", "device_setup.md")
        fields = []
        for index, line in enumerate(lines):
            if line.strip() == "@editable":
                match = re.match(r"\s*([A-Za-z_]\w*)\s*:", lines[index + 1])
                self.assertIsNotNone(match, f"@editable without field at line {index + 1}")
                fields.append(match.group(1))
        self.assertGreaterEqual(len(fields), 40)
        missing = [field for field in fields if field not in doc]
        self.assertEqual(missing, [], "fields missing from design/device_setup.md")

    def test_readme_lists_every_verse_file(self):
        readme = read("README.md")
        for name in os.listdir(os.path.join(PROJECT, "Verse")):
            if name.endswith(".verse"):
                self.assertIn(name, readme)


if __name__ == "__main__":
    unittest.main()
