"""The paste-ready single file must match the modules and pass the checker."""
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(PROJECT, "tools"))

import build_single_file  # noqa: E402
from test_static_checker import HAVE_DIGEST, run_checker  # noqa: E402

SINGLE = os.path.join(PROJECT, "UEFN_IMPORT", "sky_heist_complete.verse")


class SingleFileTests(unittest.TestCase):

    def test_single_file_is_up_to_date(self):
        with tempfile.TemporaryDirectory() as tmp:
            fresh = build_single_file.build(os.path.join(PROJECT, "Verse"), os.path.join(tmp, "out.verse"))
        with open(SINGLE, encoding="utf-8") as handle:
            committed = handle.read()
        self.assertEqual(committed, fresh, "run tools/build_single_file.py after changing Verse/*.verse")

    def test_single_file_contains_every_module_once(self):
        with open(SINGLE, encoding="utf-8") as handle:
            text = handle.read()
        for name in build_single_file.ORDER:
            self.assertEqual(text.count(f"# Modul: {name}"), 1)
        self.assertEqual(text.count("sky_heist_game := class(creative_device):"), 1)
        self.assertNotIn("<#", text)

    @unittest.skipUnless(HAVE_DIGEST, "Verse digests not available")
    def test_single_file_passes_static_check(self):
        findings = run_checker(os.path.dirname(SINGLE))
        errors = [str(f) for f in findings if f.severity in ("ERROR", "UNRESOLVED")]
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
