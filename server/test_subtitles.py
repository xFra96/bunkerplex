"""Abbinamento dei sottotitoli al video. Avvio: python -m unittest test_subtitles"""
import os
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("DATA_DIR", tempfile.mkdtemp())
import app  # noqa: E402


class SubtitleMatch(unittest.TestCase):
    def folder(self, *names):
        d = Path(tempfile.mkdtemp())
        for n in names:
            (d / n).write_text("1\n00:00:01,000 --> 00:00:02,000\nciao\n")
        return d

    def tags(self, d, video):
        return sorted(t for _, t in app.subtitle_files(d / video))

    def test_same_name_it_forced(self):
        d = self.folder("Film.mkv", "Film.it.forced.srt", "Film.it.srt")
        self.assertEqual(self.tags(d, "Film.mkv"), ["it", "it.forced"])

    def test_same_name_ita_forced(self):
        d = self.folder("Film.mkv", "Film_ita_forced.srt")
        self.assertEqual(self.tags(d, "Film.mkv"), ["ita_forced"])

    def test_different_name_ita_forced(self):
        d = self.folder("Toro Scatenato (1980).mkv", "Toro.Scatenato.1980.BDRip_ita_forced.srt",
                        "Altro Film.mkv")
        self.assertEqual(self.tags(d, "Toro Scatenato (1980).mkv"), ["ita_forced"])

    def test_different_name_it_forced(self):
        d = self.folder("Toro.Scatenato.1980.1080p.BluRay.mkv", "toro-scatenato.it.forced.srt",
                        "Altro Film.mkv")
        self.assertEqual(self.tags(d, "Toro.Scatenato.1980.1080p.BluRay.mkv"), ["it.forced"])

    def test_single_video_takes_any_sub(self):
        d = self.folder("Raging Bull.mkv", "Toro.Scatenato_ita_forced.srt")
        self.assertEqual(self.tags(d, "Raging Bull.mkv"), ["ita_forced"])

    def test_other_movie_not_matched(self):
        d = self.folder("Film A.mkv", "Film B.mkv", "Film.B.ita.forced.srt")
        self.assertEqual(self.tags(d, "Film A.mkv"), [])

    def test_other_episode_not_matched(self):
        d = self.folder("Serie.S01E01.mkv", "Serie.S01E02.mkv", "Serie.S01E02_ita_forced.srt")
        self.assertEqual(self.tags(d, "Serie.S01E01.mkv"), [])
        self.assertEqual(self.tags(d, "Serie.S01E02.mkv"), ["ita_forced"])

    def test_split(self):
        self.assertEqual(app._sub_split("Toro.Scatenato_ita_forced"), ("Toro.Scatenato", "ita_forced"))
        self.assertEqual(app._sub_split("Film.it.forced"), ("Film", "it.forced"))
        self.assertEqual(app._sub_split("Film"), ("Film", ""))


if __name__ == "__main__":
    unittest.main()
