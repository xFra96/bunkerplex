"""Gli amici vedono cosa stai guardando adesso (e lo si puo' spegnere).
Avvio: python -m unittest test_amici_ora"""
import io
import json
import os
import tempfile
import unittest
from unittest import mock

os.environ.setdefault("DATA_DIR", tempfile.mkdtemp())
import app  # noqa: E402


def come(uid, sid=None, libs=(), friend=False):
    u = {"id": uid, "sid": sid or uid, "linked": True, "libs": list(libs)}
    if friend:
        u["friend"] = True
    return app.CURRENT.set(u)


def gioca(uid, what, pos, dur=3600, ended=False, sid=None):
    tok = come(uid, sid)
    try:
        app.note_playing(what, pos, dur, ended)
    finally:
        app.CURRENT.reset(tok)


FILM = {"id": 7, "kind": "movie", "title": "Il sorpasso", "year": 1962, "show": "", "show_id": None,
        "season": None, "episode": None, "lib": 1}
EPISODIO = {"id": 9, "kind": "episode", "title": "Pilota", "year": None, "show": "Boris", "show_id": 3,
            "season": 1, "episode": 1, "lib": 2}


class OraInOnda(unittest.TestCase):
    def setUp(self):
        app.now_playing.clear()
        self.impostazioni = {}
        p = mock.patch.object(app, "user_setting", lambda uid, k: self.impostazioni.get((uid, k)))
        p.start()
        self.addCleanup(p.stop)

    def test_cosa_guarda_e_pausa(self):
        gioca(5, FILM, 100)
        w = app.watching_now(5, {1})
        self.assertEqual(len(w), 1)
        self.assertEqual((w[0]["title"], w[0]["year"], w[0]["id"], w[0]["paused"]), ("Il sorpasso", 1962, 7, False))
        gioca(5, FILM, 100.4)                     # punto fermo: in pausa
        self.assertTrue(app.watching_now(5, {1})[0]["paused"])
        gioca(5, FILM, 110)
        self.assertFalse(app.watching_now(5, {1})[0]["paused"])

    def test_solo_il_suo_account_e_i_profili(self):
        gioca(5, FILM, 100)
        gioca(5, EPISODIO, 50, sid=-2)            # un altro profilo dello stesso account
        gioca(6, FILM, 100)
        self.assertEqual(len(app.watching_now(5, {1, 2})), 2)
        self.assertEqual(len(app.watching_now(6, {1})), 1)
        self.assertEqual(app.watching_now(8, {1}), [])

    def test_raccolta_non_condivisa_niente_id(self):
        gioca(5, EPISODIO, 50)
        w = app.watching_now(5, {1})[0]
        self.assertEqual((w["show"], w["season"], w["episode"]), ("Boris", 1, 1))
        self.assertNotIn("id", w)
        self.assertNotIn("show_id", w)
        self.assertEqual(app.watching_now(5, {2})[0]["show_id"], 3)

    def test_finito_o_silenzio(self):
        gioca(5, FILM, 100)
        gioca(5, FILM, 3500, ended=True)
        self.assertEqual(app.watching_now(5, {1}), [])
        gioca(5, FILM, 100)
        with mock.patch.object(app.time, "time", return_value=app.time.time() + app.NOW_SECONDS + 1):
            self.assertEqual(app.watching_now(5, {1}), [])

    def test_spento_dalle_impostazioni(self):
        gioca(5, FILM, 100)
        self.impostazioni[(5, "share_activity")] = False
        self.assertEqual(app.watching_now(5, {1}), [])

    def test_amico_non_registra(self):
        tok = come(5, friend=True)
        try:
            app.note_playing(FILM, 100, 3600, False)
        finally:
            app.CURRENT.reset(tok)
        self.assertEqual(app.now_playing, {})

    def test_share_now_per_chi_chiede(self):
        gioca(5, FILM, 100)
        tok = come(5, libs=[1], friend=True)
        try:
            self.assertEqual(app.share_now()["watching"][0]["id"], 7)
        finally:
            app.CURRENT.reset(tok)


class Risposta(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class DallAmico(unittest.TestCase):
    def setUp(self):
        app.friend_now_cache.clear()
        app.friend_status.clear()

    def test_id_dell_amico_e_pulizia(self):
        body = {"watching": [{"title": "Boris", "kind": "episode", "show": "Boris", "season": 1, "episode": 2,
                              "id": 9, "show_id": 3, "paused": 1, "position": 60, "duration": 1500},
                             {"title": 5}, "x"]}
        f = {"n": 2, "token": "t", "url": "http://x"}
        with mock.patch.object(app, "friend_open", return_value=Risposta(json.dumps(body).encode())):
            w = app.friend_now(f)
        self.assertEqual(len(w), 1)
        self.assertEqual(w[0]["id"], app.fvid(2, 9))
        self.assertEqual(w[0]["show_id"], app.fvid(2, 3))
        self.assertTrue(w[0]["paused"])

    def test_server_vecchio_o_spento(self):
        f = {"n": 3, "token": "t", "url": "http://x"}
        with mock.patch.object(app, "friend_open", side_effect=OSError("giu'")):
            self.assertEqual(app.friend_now(f), [])
        self.assertNotIn(3, app.friend_status)    # non lo segna spento
        app.friend_status[4] = {"online": False}
        with mock.patch.object(app, "friend_open") as fo:
            self.assertEqual(app.friend_now({"n": 4, "token": "t", "url": "http://x"}), [])
            fo.assert_not_called()


if __name__ == "__main__":
    unittest.main()
