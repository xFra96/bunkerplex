"""Riconoscimento di serie ed episodi dai nomi. Avvio: python -m unittest test_classify"""
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("DATA_DIR", tempfile.mkdtemp())
import app  # noqa: E402


class Classify(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def make(self, root, *names):
        out = []
        for n in names:
            p = self.tmp / root / n
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(b"")
            out.append(p)
        return out

    def test_typo_nel_nome_file(self):
        p, = self.make("Serie TV", "True Detective/True Detective S02e01-08 (1080p Ita Eng Spa h265 10bit SubS) "
                       "byMe7alh/True.Detectives.S02e01.Ita.Eng.Spa.1080p.h265.10bit.SubS-Me7alh.mkv")
        ep = app.classify(p, self.tmp / "Serie TV", {})
        self.assertEqual(ep[:4], ("True Detective", None, 2, 1))

    def test_serie_diverse_restano_diverse(self):
        p, = self.make("Serie TV", "Dragon Ball/Dragon Ball Z 1x001.mkv")
        self.assertEqual(app.classify(p, self.tmp / "Serie TV", {})[0], "Dragon Ball Z")
        self.assertFalse(app.typo_of("Fargo 2", "Fargo 3"))
        self.assertFalse(app.typo_of("Naruto Shippuden", "Naruto"))

    def miniserie(self, root):
        folder = "Band of Brothers - Fratelli al fronte (2001) 1080p H265 AC3 5.1 ITA.ENG Sp33dy94-MIRCrew/"
        return self.make(root, *[folder + f"Band of Brothers - Fratelli al fronte {n} {t} Sp33dy94-MIRCrew.mkv"
                                 for n, t in ((1, "Currahee - L'inizio"), (2, "Day of Days - D-Day"),
                                              (3, "Carentan"), (10, "Points - Il nido delle aquile"))])

    def test_miniserie_con_puntate_lunghe(self):
        files = self.miniserie("Serie TV")
        with mock.patch.object(app, "probe", return_value={"duration": 73 * 60}):
            ep = app.classify(files[0], self.tmp / "Serie TV", {})
        self.assertEqual(ep[:4], ("Band of Brothers - Fratelli al fronte", 2001, 1, 1))

    def test_saga_di_film_resta_film(self):
        files = self.miniserie("Film")
        with mock.patch.object(app, "probe", return_value={"duration": 73 * 60}):
            self.assertIsNone(app.classify(files[0], self.tmp / "Film", {}))

    def test_stagione_ed_episodio_col_trattino(self):
        p, q = self.make("Serie TV",
                         "House of Cards/1^ stagione/House of Cards - S01 - 01 - Capitolo 1.ITA-ENG.1080p.BDMux.DD5.1.x264-NovaRip.mkv",
                         "House of Cards/6^ stagione/House of Cards - S06 - 02 Capitolo 67.ITA.ENG.1080p.WEBMux.DD5.1.x264-Morpheus.mkv")
        self.assertEqual(app.classify(p, self.tmp / "Serie TV", {}), ("House of Cards", None, 1, 1, "Capitolo 1"))
        self.assertEqual(app.classify(q, self.tmp / "Serie TV", {}), ("House of Cards", None, 6, 2, "Capitolo 67"))

    def test_cartella_stagione_col_numero_davanti(self):
        for name, n in (("1^ stagione", 1), ("2a Stagione", 2), ("3° stagione", 3), ("1st Season", 1)):
            self.assertEqual(app.SEASON_DIR.match(app.clean(name)).group(2), str(n))

    def test_film_con_trattino_resta_film(self):
        p, = self.make("Film", "Mission Impossible - Dead Reckoning (2023)/Mission Impossible - Dead Reckoning (2023).mkv")
        self.assertIsNone(app.classify(p, self.tmp / "Film", {}))

    def test_id_imdb_nei_nomi_e_nfo(self):
        film, = self.make("Film", "Le ali della liberta (1994) {imdb-tt0111161}/Le ali della liberta (1994).mkv")
        ep, = self.make("Serie TV", "The Office (2005)/Season 01/The Office S01E01.mkv")
        (ep.parent.parent / "tvshow.nfo").write_text("<tvshow><uniqueid type=\"imdb\">tt0386676</uniqueid></tvshow>")
        libs = [{"folders": [str(self.tmp / "Film"), str(self.tmp / "Serie TV")]}]
        with mock.patch.object(app, "get_libraries", return_value=libs):
            self.assertEqual(app.imdb_in_path(str(film), "movie"), "tt0111161")
            self.assertEqual(app.imdb_in_path(str(ep), "show"), "tt0386676")
        self.assertEqual(app.parse_title("Le ali della liberta (1994) {imdb-tt0111161}"), ("Le ali della liberta", 1994))


if __name__ == "__main__":
    unittest.main()
