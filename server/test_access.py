"""Credenziale del server, presenza e gettoni d'accesso del servizio account.
Avvio: python -m unittest test_access"""
import asyncio
import base64
import json
import os
import tempfile
import time
import unittest
from unittest import mock

os.environ.setdefault("DATA_DIR", tempfile.mkdtemp())
import app  # noqa: E402

from cryptography.hazmat.primitives import hashes  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature  # noqa: E402

SID = "1234abcd"
OWNER = 7
CRED = "s_" + SID + "_" + "0" * 64


def b64u(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


class Chiave:
    def __init__(self, kid="k1"):
        self.kid = kid
        self.priv = ec.generate_private_key(ec.SECP256R1())
        n = self.priv.public_key().public_numbers()
        self.jwk = {"kty": "EC", "crv": "P-256", "kid": kid, "alg": "ES256",
                    "x": b64u(n.x.to_bytes(32, "big")), "y": b64u(n.y.to_bytes(32, "big"))}

    def token(self, **over):
        now = int(time.time())
        claims = {"iss": "bunkerplex", "sub": str(OWNER), "name": "anna", "sid": SID, "own": OWNER,
                  "role": "owner", "iat": now, "exp": now + 3600, "jti": "abc"}
        claims.update(over)
        head = b64u(json.dumps({"typ": "JWT", "alg": "ES256", "kid": self.kid}).encode())
        body = b64u(json.dumps(claims).encode())
        r, s = decode_dss_signature(self.priv.sign((head + "." + body).encode(), ec.ECDSA(hashes.SHA256())))
        return head + "." + body + "." + b64u(r.to_bytes(32, "big") + s.to_bytes(32, "big"))


def prepara():
    app.init_db()
    con = app.db(raw=True)
    con.execute("DELETE FROM users")
    con.execute("INSERT INTO users(name, created, cloud_id, admin, must_change) VALUES('anna', 1, ?, 0, 0)", (OWNER,))
    con.commit()
    con.close()
    app.user_cache.clear()
    with app.config_lock:
        app.config["pc_id"] = SID
    app.set_server_cred({"secret": CRED, "owner": OWNER, "owner_name": "anna"})
    app.access_seen.clear()
    app.access_keys.update(at=0.0, keys={})


class GettoniAccesso(unittest.TestCase):
    def setUp(self):
        prepara()
        self.k = Chiave()
        self.calls = []

        def cloud(method, path, body=None, token=None, timeout=12):
            self.calls.append((method, path))
            if path == "/keys":
                return {"keys": [self.k.jwk]}
            raise AssertionError("chiamata inattesa " + path)
        p = mock.patch.object(app.accounts, "call", side_effect=cloud)
        p.start()
        self.addCleanup(p.stop)

    def test_gettone_buono(self):
        c = app.access_claims(self.k.token())
        self.assertEqual(c["role"], "owner")
        # Il secondo controllo non richiede piu' la chiave
        app.access_claims(self.k.token(jti="x2"))
        self.assertEqual([p for _, p in self.calls], ["/keys"])

    def test_gettoni_da_rifiutare(self):
        self.assertIsNone(app.access_claims(self.k.token(sid="ffffffff")))           # un altro server
        self.assertIsNone(app.access_claims(self.k.token(exp=int(time.time()) - 5)))  # scaduto
        self.assertIsNone(app.access_claims(self.k.token(own=99)))                   # di un altro proprietario
        self.assertIsNone(app.access_claims(self.k.token(iss="altro")))
        self.assertIsNone(app.access_claims(self.k.token(role="admin")))
        altro = Chiave(kid="k1")                                                      # firmato da un'altra chiave
        self.assertIsNone(app.access_claims(altro.token()))
        t = self.k.token()
        h, b, s = t.split(".")
        ritocco = json.loads(base64.urlsafe_b64decode(b + "=="))
        ritocco["role"] = "owner"
        ritocco["sub"] = "8"
        self.assertIsNone(app.access_claims(h + "." + b64u(json.dumps(ritocco).encode()) + "." + s))
        self.assertIsNone(app.access_claims("non.un.gettone"))
        self.assertIsNone(app.access_claims(""))

    def test_proprietario_entra_con_il_gettone(self):
        u = app.access_user(self.k.token())
        self.assertEqual(u["name"], "anna")
        self.assertTrue(u["linked"])
        # Un amico con il gettone non e' il proprietario: niente API complete
        self.assertIsNone(app.access_user(self.k.token(sub="8", role="friend")))

    def test_authgate_con_bearer(self):
        visto = {}

        async def inner(scope, receive, send):
            visto["user"] = app.CURRENT.get()
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b""})

        sent = []

        async def send(m):
            sent.append(m)

        def scope(auth):
            h = [(b"authorization", ("Bearer " + auth).encode())] if auth else []
            return {"type": "http", "path": "/api/home", "headers": h, "server": ("127.0.0.1", 32500),
                    "client": ("192.168.1.9", 5000)}

        gate = app.AuthGate(inner)
        p = mock.patch.object(app, "DATA_PROBLEM", "")      # nei test la cartella dati non ha il segno del disco
        p.start()
        self.addCleanup(p.stop)
        asyncio.run(gate(scope(self.k.token()), None, send))
        self.assertEqual(visto["user"]["name"], "anna")
        visto.clear()
        sent.clear()
        asyncio.run(gate(scope(self.k.token(sid="ffffffff")), None, send))
        self.assertNotIn("user", visto)
        self.assertEqual(sent[0]["status"], 401)


class VerificaDalServizio(unittest.TestCase):
    """Immagine Docker senza cryptography: il gettone lo controlla il servizio account."""

    def setUp(self):
        prepara()
        self.k = Chiave()

    def test_senza_cryptography(self):
        risposte = {}

        def cloud(method, path, body=None, token=None, timeout=12):
            self.assertEqual((path, token), ("/server/verify", CRED))
            if risposte.get("no"):
                raise app.accounts.CloudError(403, "Non siete più amici")
            return {"claims": {"jti": "abc"}}
        with mock.patch.object(app, "ec", None), mock.patch.object(app.accounts, "call", side_effect=cloud):
            self.assertEqual(app.access_claims(self.k.token())["role"], "owner")
            risposte["no"] = True
            self.assertIsNone(app.access_claims(self.k.token(jti="nuovo")))


class Presenza(unittest.TestCase):
    def setUp(self):
        prepara()
        app.set_server_cred(None)
        app.cloud_v2.update(on=None, error="")
        self.uid = app.server_owner()
        self.calls = []
        self.answers = {}

    def cloud(self, method, path, body=None, token=None, timeout=12):
        self.calls.append((method, path, token))
        a = self.answers.get(path)
        if isinstance(a, list):
            a = a.pop(0)
        if isinstance(a, Exception):
            raise a
        return a if a is not None else {"ok": True}

    def test_prende_la_credenziale_e_manda_la_presenza(self):
        self.answers[f"/servers/{SID}/claim"] = {"credential": CRED, "owner": {"id": OWNER, "username": "anna"}}
        with mock.patch.object(app.accounts, "call", side_effect=self.cloud):
            app.publish_presence(self.uid, "tok-utente")
        self.assertEqual([c[:2] for c in self.calls], [("POST", f"/servers/{SID}/claim"), ("POST", "/server/heartbeat")])
        self.assertEqual(self.calls[0][2], "tok-utente")
        self.assertEqual(self.calls[1][2], CRED)
        self.assertEqual(app.server_cred()["owner"], OWNER)
        # Al giro dopo solo la presenza
        self.calls.clear()
        with mock.patch.object(app.accounts, "call", side_effect=self.cloud):
            app.publish_presence(self.uid, "tok-utente")
        self.assertEqual([c[1] for c in self.calls], ["/server/heartbeat"])

    def test_credenziale_persa_si_riprende(self):
        app.set_server_cred({"secret": "s_" + SID + "_" + "1" * 64, "owner": OWNER})
        self.answers["/server/heartbeat"] = [app.accounts.CloudError(401, "va ripresa"), {"ok": True}]
        self.answers[f"/servers/{SID}/claim"] = {"credential": CRED, "owner": {"id": OWNER, "username": "anna"}}
        with mock.patch.object(app.accounts, "call", side_effect=self.cloud):
            app.publish_presence(self.uid, "tok")
        self.assertEqual([c[1] for c in self.calls], ["/server/heartbeat", f"/servers/{SID}/claim", "/server/heartbeat"])
        self.assertEqual(app.server_cred()["secret"], CRED)

    def test_servizio_di_prima_resta_put_servers(self):
        self.answers[f"/servers/{SID}/claim"] = app.accounts.CloudError(404, "Non trovato")
        with mock.patch.object(app.accounts, "call", side_effect=self.cloud), \
                mock.patch.object(app, "presence_url", return_value="https://1.2.3.4:32501"), \
                mock.patch.object(app, "self_reach", return_value=True):
            app.share_tls.update(on=True, pin="c" * 64)
            try:
                app.publish_presence(self.uid, "tok")
            finally:
                app.share_tls.update(on=False, pin="")
        self.assertEqual([c[:2] for c in self.calls], [("POST", f"/servers/{SID}/claim"), ("PUT", "/servers")])
        self.assertIs(app.cloud_v2["on"], False)

    def test_proprietario_cambiato(self):
        app.set_server_cred({"secret": "s_" + SID + "_" + "2" * 64, "owner": 99})
        self.answers[f"/servers/{SID}/claim"] = {"credential": CRED, "owner": {"id": OWNER, "username": "anna"}}
        with mock.patch.object(app.accounts, "call", side_effect=self.cloud):
            app.publish_presence(self.uid, "tok")
        self.assertEqual([c[1] for c in self.calls], ["/server", f"/servers/{SID}/claim", "/server/heartbeat"])
        self.assertEqual(self.calls[0][0], "DELETE")


if __name__ == "__main__":
    unittest.main()
