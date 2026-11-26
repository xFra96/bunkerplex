"""Profili nell'account («Chi guarda?» come Netflix) e collegamento del server con il codice.
Avvio: python -m unittest test_profili"""
import asyncio
import os
import tempfile
import time
import unittest
from unittest import mock

os.environ.setdefault("DATA_DIR", tempfile.mkdtemp())
import app  # noqa: E402
from test_access import CRED, OWNER, SID, Chiave, prepara  # noqa: E402


class CloudFinto:
    """Il servizio account, quanto basta: profili, visti per profilo, codice di collegamento."""

    def __init__(self, k):
        self.k = k
        self.profiles = [{"id": 0, "name": "anna", "main": True, "avatar": "", "color": "", "kids": False, "pin": False}]
        self.state = {}               # profilo -> righe ricevute
        self.calls = []
        self.claim = None

    def __call__(self, method, path, body=None, token=None, timeout=12):
        self.calls.append((method, path, token))
        if path == "/keys":
            return {"keys": [self.k.jwk]}
        if path == "/profiles" and method == "GET":
            return {"profiles": self.profiles}
        if path == "/profiles" and method == "POST":
            p = {"id": 100 + len(self.profiles), "name": body["name"], "main": False, "avatar": body.get("avatar", ""),
                 "color": body.get("color", ""), "kids": bool(body.get("kids")), "pin": False}
            self.profiles.append(p)
            return {"profile": p}
        if path.startswith("/profiles/") and path.endswith("/open"):
            if body.get("pin") != "1234":
                raise app.accounts.CloudError(401, "PIN sbagliato")
            return {"ok": True}
        if path.startswith("/state"):
            prof = path.split("profile=")[1].split("&")[0] if "profile=" in path else "0"
            if method == "POST":
                self.state.setdefault(prof, []).extend(body["rows"])
                return {"ok": True}
            return {"rows": [], "more": False}
        if path == "/settings":
            return {"data": {}} if method == "GET" else {"ok": True}
        if path == "/me":
            return {"user": {"admin": False, "must_change": False}}
        if path == "/claim/start":
            self.claim = {"code": "ABCD2345", "poll": "f" * 64, "exp": time.time() + 900}
            return dict(self.claim)
        if path == "/claim/ABCD2345" and method == "POST":
            self.claim["done"] = body
            return {"ok": True}
        if path == "/claim/poll":
            if not self.claim.get("done"):
                return {"status": "pending"}
            sid = self.claim["done"].get("replace") or SID
            return {"status": "done", "sid": sid, "credential": "s_" + sid + "_" + "1" * 64,
                    "name": self.claim["done"]["name"], "owner": {"id": OWNER, "username": "anna"}}
        raise AssertionError("chiamata inattesa " + method + " " + path)


def ingresso(uid):
    con = app.db(raw=True)
    try:
        token = app.open_session(con, uid, "TV")
        con.commit()
        return token
    finally:
        con.close()


class Profili(unittest.TestCase):
    def setUp(self):
        prepara()
        self.k = Chiave()
        self.cloud = CloudFinto(self.k)
        p = mock.patch.object(app.accounts, "call", side_effect=self.cloud)
        p.start()
        self.addCleanup(p.stop)
        con = app.db(raw=True)
        con.execute("DELETE FROM profiles")
        con.execute("UPDATE users SET token=?", ("t" * 64,))
        self.uid = con.execute("SELECT id FROM users WHERE cloud_id=?", (OWNER,)).fetchone()["id"]
        con.commit()
        con.close()

    def test_profilo_di_prima_sale_nell_account_con_i_suoi_visti(self):
        con = app.db(raw=True)
        lid = con.execute("INSERT INTO profiles(user_id, name, created) VALUES(?, 'Leo', 1)", (self.uid,)).lastrowid
        con.execute("INSERT INTO items(id, kind, tmdb_id, title) VALUES(9001, 'movie', 555, 'Film')")
        con.execute("INSERT INTO user_items(user_id, item_id, watched, t, dirty) VALUES(?, 9001, 1, 5, 0)", (-lid,))
        con.commit()
        con.close()
        with mock.patch.object(app, "sync_friends"), mock.patch.object(app, "sync_notices"):
            app.sync_user(self.uid, "t" * 64)
        leo = next(p for p in self.cloud.profiles if p["name"] == "Leo")
        self.assertEqual(self.cloud.state[str(leo["id"])][0]["k"], "m555")
        con = app.db(raw=True)
        try:
            self.assertEqual(con.execute("SELECT cloud_pid FROM profiles WHERE id=?", (lid,)).fetchone()[0], leo["id"])
            con.execute("DELETE FROM items WHERE id=9001")
            con.commit()
        finally:
            con.close()

    def test_profili_dal_servizio_e_pin(self):
        self.cloud.profiles.append({"id": 201, "name": "Bimbi", "main": False, "avatar": "fox", "color": "",
                                    "kids": True, "pin": False})
        self.cloud.profiles.append({"id": 202, "name": "Papà", "main": False, "avatar": "", "color": "",
                                    "kids": False, "pin": True})
        app.sync_profiles(self.uid, "t" * 64)
        session = ingresso(self.uid)
        u = app.session_user(session)
        tok = app.CURRENT.set(u)
        try:
            ids = [p["id"] for p in app.profiles_list()["profiles"]]
            self.assertEqual(ids, [0, 201, 202])

            def scegli(**b):
                async def body(_):
                    return b
                with mock.patch.object(app, "read_json", side_effect=body):
                    return asyncio.run(app.profiles_select(None))
            with self.assertRaises(app.HTTPException) as e:
                scegli(id=202)
            self.assertEqual(e.exception.status_code, 412)
            with self.assertRaises(app.HTTPException) as e:
                scegli(id=202, pin="0000")
            self.assertEqual(e.exception.status_code, 401)
            self.assertEqual(scegli(id=202, pin="1234")["current"], 202)
            # Con il biglietto del servizio non serve il PIN
            now = int(time.time())
            ticket = self.k.token(typ="profile", pid=202, sid=None, role=None, exp=now + 60)
            self.assertEqual(scegli(id=202, ticket=ticket)["current"], 202)
            bad = self.k.token(typ="profile", pid=201, sid=None, role=None, exp=now + 60)
            with self.assertRaises(app.HTTPException):
                scegli(id=202, ticket=bad)
            # Bambini: niente gestione, solo raccolte per bambini
            scegli(id=201)
        finally:
            app.CURRENT.reset(tok)
        kid = app.session_user(session)
        self.assertTrue(kid["kids"])
        self.assertEqual(kid["profile"], 201)
        self.assertFalse(kid["admin"])
        tok = app.CURRENT.set(kid)
        try:
            with self.assertRaises(app.HTTPException) as e:
                app.manager_only()
            self.assertEqual(e.exception.status_code, 403)
        finally:
            app.CURRENT.reset(tok)
        # Tolto dal servizio: sparisce anche qui
        self.cloud.profiles = [p for p in self.cloud.profiles if p["id"] != 201]
        app.sync_profiles(self.uid, "t" * 64)
        self.assertIsNone(app.session_user(session)["profile"])

    def test_gettone_con_il_profilo_scelto(self):
        self.cloud.profiles.append({"id": 301, "name": "Leo", "main": False, "avatar": "", "color": "",
                                    "kids": False, "pin": True})
        now = int(time.time())
        ticket = self.k.token(typ="profile", pid=301, sid=None, role=None, exp=now + 60)

        async def body(_):
            return {"token": self.k.token(), "profile": 301, "profile_ticket": ticket}
        with mock.patch.object(app, "read_json", side_effect=body):
            r = asyncio.run(app.auth_access(None))
        self.assertEqual(r["profile"], 301)
        self.assertEqual(app.session_user(r["session"])["profile"], 301)


class Collegamento(unittest.TestCase):
    def setUp(self):
        prepara()
        self.k = Chiave()
        self.cloud = CloudFinto(self.k)
        p = mock.patch.object(app.accounts, "call", side_effect=self.cloud)
        p.start()
        self.addCleanup(p.stop)
        app.set_server_cred(None)
        app.claim_state.update(code="", poll="", exp=0.0, need=False)
        con = app.db(raw=True)
        con.execute("DELETE FROM users")
        con.commit()
        con.close()
        app.user_cache.clear()
        t = mock.patch.object(app.threading, "Thread")         # niente attesa in sottofondo nei test
        t.start()
        self.addCleanup(t.stop)

    def test_codice_confermato_poi_il_proprietario_entra_dalla_pwa(self):
        info = app.claim_start()
        self.assertEqual(info["code"], "ABCD2345")
        self.assertFalse(app.claim_poll())
        self.cloud.claim["done"] = {"name": "Salotto", "replace": "abcdef12"}
        self.assertTrue(app.claim_poll())
        cred = app.server_cred()
        self.assertEqual(cred["owner"], OWNER)
        # Sostituisce il server di prima: ne prende il sid e il nome
        self.assertEqual(app.pc_id(), "abcdef12")
        self.assertEqual(app.pc_name(), "Salotto")
        self.assertEqual(app.claim_info()["claimed"], True)
        # Il proprietario ha la sua copia anche senza essere mai entrato con la password
        self.assertIsNotNone(app.server_owner())
        with app.config_lock:
            app.config["pc_id"] = SID

    def test_presenza_di_un_server_nuovo_chiede_il_codice(self):
        def cloud(method, path, body=None, token=None, timeout=12):
            raise app.accounts.CloudError(428, "Serve il codice")
        con = app.db(raw=True)
        uid = con.execute("INSERT INTO users(name, created, cloud_id, token) VALUES('anna', 1, ?, 'x')", (OWNER,)).lastrowid
        con.commit()
        con.close()
        with mock.patch.object(app.accounts, "call", side_effect=cloud):
            self.assertTrue(app.presence_v2(uid, "t" * 64))
        self.assertTrue(app.claim_info()["need"])

    def test_impronta_della_macchina(self):
        with mock.patch.dict(os.environ, {"BUNKERPLEX_MACHINE": "ABC-123"}):
            a = app.machine_id()
        self.assertRegex(a, r"^[0-9a-f]{32}$")
        with mock.patch.dict(os.environ, {"BUNKERPLEX_MACHINE": "abc-123"}):
            self.assertEqual(app.machine_id(), a)      # maiuscole o minuscole: stessa macchina


if __name__ == "__main__":
    unittest.main()
