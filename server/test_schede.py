"""Voti IMDb e scelta della locandina. Avvio: python -m unittest test_schede"""
import gzip
import io
import os
import tempfile
import unittest
from unittest import mock

os.environ.setdefault("DATA_DIR", tempfile.mkdtemp())
import app  # noqa: E402


class Locandina(unittest.TestCase):
    def test_principale_di_una_stagione_scartata(self):
        m = {"poster_path": "/stagione4.jpg", "images": {"posters": [
            {"file_path": "/stagione4.jpg", "iso_639_1": "it", "vote_count": 0, "vote_average": 0},
            {"file_path": "/serie.jpg", "iso_639_1": "en", "vote_count": 32, "vote_average": 7.0},
            {"file_path": "/altra.jpg", "iso_639_1": "en", "vote_count": 3, "vote_average": 7.5}]}}
        self.assertEqual(app.show_poster(m), "/altra.jpg")

    def test_italiana_votata_vince(self):
        m = {"poster_path": "/a.jpg", "images": {"posters": [
            {"file_path": "/a.jpg", "iso_639_1": "it", "vote_count": 0},
            {"file_path": "/it.jpg", "iso_639_1": "it", "vote_count": 2, "vote_average": 5.3},
            {"file_path": "/en.jpg", "iso_639_1": "en", "vote_count": 40, "vote_average": 6}]}}
        self.assertEqual(app.show_poster(m), "/it.jpg")

    def test_principale_votata_resta(self):
        m = {"poster_path": "/en.jpg", "images": {"posters": [
            {"file_path": "/en.jpg", "iso_639_1": "en", "vote_count": 5, "vote_average": 5},
            {"file_path": "/x.jpg", "iso_639_1": "en", "vote_count": 9, "vote_average": 6}]}}
        self.assertEqual(app.show_poster(m), "/en.jpg")
        self.assertEqual(app.show_poster({"poster_path": "/p.jpg"}), "/p.jpg")


class VotiImdb(unittest.TestCase):
    def test_voti_dal_file_giornaliero(self):
        app.init_db()
        con = app.db(raw=True)
        con.execute("DELETE FROM items")
        con.execute("INSERT INTO items(id, kind, path, title, imdb_id) VALUES(901, 'movie', '/x/a.mkv', 'A', 'tt0111161')")
        con.execute("INSERT INTO items(id, kind, path, title, imdb_id) VALUES(902, 'movie', '/x/b.mkv', 'B', 'tt9999999')")
        con.commit()
        con.close()
        data = gzip.compress(b"tconst\taverageRating\tnumVotes\ntt0000001\t5.7\t2100\ntt0111161\t9.3\t3000000\n")
        with mock.patch.object(app.urllib.request, "urlopen", return_value=io.BytesIO(data)), \
                mock.patch.object(app, "save_config"):
            app.config.pop("imdb_ratings_at", None)
            app.imdb_ratings()
        con = app.db(raw=True)
        rows = {r["id"]: (r["imdb_rating"], r["imdb_votes"])
                for r in con.execute("SELECT id, imdb_rating, imdb_votes FROM items")}
        con.close()
        self.assertEqual(rows[901], (9.3, 3000000))
        self.assertEqual(rows[902], (0, 0))


if __name__ == "__main__":
    unittest.main()
