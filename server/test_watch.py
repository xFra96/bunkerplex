"""Video nuovi trovati in fretta e avvisati presto. Avvio: python -m unittest test_watch"""
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("DATA_DIR", tempfile.mkdtemp())
import app  # noqa: E402


def setUpModule():
    app.init_db()


class Watch(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp()) / "Film"
        self.root.mkdir()
        self.libs = [{"id": 1, "name": "Film", "folders": [str(self.root)]}]
        con = app.db(raw=True)
        con.execute("DELETE FROM items")
        con.commit()
        con.close()

    def video(self, name, age=3600):
        p = self.root / name
        p.write_bytes(b"x")
        t = time.time() - age
        os.utime(p, (t, t))
        return p

    def scan(self):
        with mock.patch.object(app, "get_libraries", return_value=self.libs), \
                mock.patch.object(app, "probe", return_value={"duration": 1, "vcodec": "", "acodec": "", "pix": "",
                                                              "width": 0, "height": 0, "fps": 0}), \
                mock.patch.object(app, "tmdb_key", return_value=""), \
                mock.patch.object(app, "announce_new") as ann:
            app.scan()
        return ann

    def test_nuovi_video_elencati_finche_non_in_libreria(self):
        p = self.video("Film A (2020).mkv")
        with mock.patch.object(app, "get_libraries", return_value=self.libs):
            self.assertEqual(list(app.new_videos()), [str(p)])
            self.scan()
            self.assertEqual(app.new_videos(), {})

    def test_file_in_copia_aspetta(self):
        self.video("Film A (2020).mkv")
        fresh = self.video("Film B (2021).mkv", age=5)
        ann = self.scan()
        con = app.db(raw=True)
        paths = {r[0] for r in con.execute("SELECT path FROM items")}
        con.close()
        self.assertNotIn(str(fresh), paths)
        self.assertEqual(len(paths), 1)
        ann.assert_called_once()

    def test_avviso_prima_dei_lavori_lunghi(self):
        self.video("Film A (2020).mkv")
        order = []

        def apply_movie(con, item_id, tmdb_id):     # scheda trovata (senza rete)
            con.execute("UPDATE items SET tmdb_id=?, meta_done=1, coll_done=1 WHERE id=?", (tmdb_id, item_id))

        def tmdb(path, *a, **k):                    # i lavori lunghi dopo: cast, IMDb...
            order.append("tmdb " + path)
            return {}

        with mock.patch.object(app, "get_libraries", return_value=self.libs), \
                mock.patch.object(app, "probe", return_value={"duration": 1, "vcodec": "", "acodec": "", "pix": "",
                                                              "width": 0, "height": 0, "fps": 0}), \
                mock.patch.object(app, "tmdb_key", return_value="k"), \
                mock.patch.object(app, "plan_refresh"), \
                mock.patch.object(app, "find_movie", return_value=[{"id": 5}]), \
                mock.patch.object(app, "apply_movie", side_effect=apply_movie), \
                mock.patch.object(app, "tmdb", side_effect=tmdb), \
                mock.patch.object(app, "announce_new", side_effect=lambda *a: order.append("announce")):
            app.scan()
        self.assertEqual(order[0], "announce")
        self.assertGreater(len(order), 1)
        self.assertEqual(order.count("announce"), 1)


if __name__ == "__main__":
    unittest.main()
