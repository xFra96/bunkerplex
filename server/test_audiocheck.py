"""Riconoscimento delle 5.1 col doppiaggio tutto nel centrale. Avvio: python -m unittest test_audiocheck"""
import os
import tempfile
import unittest

os.environ.setdefault("DATA_DIR", tempfile.mkdtemp())
import app  # noqa: E402


def lv(fc, fl=-39.0, fr=-39.0, sl=-42.0, sr=-42.0, lfe=-31.0):
    return {"FL": fl, "FR": fr, "FC": fc, "LFE": lfe, "SL": sl, "SR": sr}


class CenterOnly(unittest.TestCase):
    def test_dub_over_music_track(self):
        # Dragon Ball Z: Italiano 5.1 (1) e Music & SFX (2) con gli stessi laterali
        self.assertEqual(app.center_only({1: lv(-29.1), 2: lv(-95.2)}), [1])

    def test_two_real_mixes(self):
        # Film con italiano e inglese 5.1: centrali entrambi pieni
        self.assertEqual(app.center_only({0: lv(-30.0), 1: lv(-30.2, fl=-47, fr=-46)}), [])

    def test_music_track_with_different_sides(self):
        self.assertEqual(app.center_only({1: lv(-29.0), 2: lv(-95.0, fl=-30, fr=-30)}), [])

    def test_unreadable_track(self):
        self.assertEqual(app.center_only({1: lv(-29.0), 2: {}}), [])


if __name__ == "__main__":
    unittest.main()
