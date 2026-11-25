"""HTTPS valido nella rete di casa, CORS per la PWA e chiavi dei video.
Avvio: python -m unittest test_secure"""
import asyncio
import base64
import datetime
import os
import tempfile
import time
import unittest
from unittest import mock

os.environ.setdefault("DATA_DIR", tempfile.mkdtemp())
import app  # noqa: E402

from cryptography import x509  # noqa: E402
from cryptography.hazmat.primitives import hashes, serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402
from cryptography.x509.oid import NameOID  # noqa: E402

SID = "1234abcd"
CRED = {"secret": "s_" + SID + "_" + "0" * 64, "owner": 7}


def prepara():
    app.init_db()
    con = app.db(raw=True)
    con.execute("DELETE FROM users")
    con.execute("INSERT INTO users(name, created, cloud_id, admin, must_change) VALUES('anna', 1, 7, 0, 0)")
    con.commit()
    con.close()
    app.user_cache.clear()
    with app.config_lock:
        app.config["pc_id"] = SID
    app.set_server_cred(dict(CRED))


def firma(csr_der, giorni=90):
    """Una piccola autorita' finta: firma la richiesta del server."""
    csr = x509.load_der_x509_csr(csr_der)
    ca = ec.generate_private_key(ec.SECP256R1())
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(csr.subject)
            .issuer_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "CA di prova")]))
            .public_key(csr.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now).not_valid_after(now + datetime.timedelta(days=giorni))
            .add_extension(csr.extensions.get_extension_for_class(x509.SubjectAlternativeName).value, critical=False)
            .sign(ca, hashes.SHA256()))
    return cert.public_bytes(serialization.Encoding.PEM).decode()


class Certificato(unittest.TestCase):
    def setUp(self):
        prepara()
        for f in app.secure_files():
            if f.exists():
                f.unlink()
        app.secure.update(domain="bpx.test", on=False, ctx=None, error="")
        self.calls = []
        self.giorni = 90

    def cloud(self, method, path, body=None, token=None, timeout=12):
        self.calls.append(path)
        self.assertEqual(token, CRED["secret"])
        if path == "/server/cert/start":
            self.csr = base64.urlsafe_b64decode(body["csr"] + "=" * (-len(body["csr"]) % 4))
            return {"status": "pending", "retry": 3}
        if path == "/server/cert/poll":
            return {"status": "valid", "cert": firma(self.csr, self.giorni)}
        raise AssertionError(path)

    def prova(self):
        with mock.patch.object(app.accounts, "call", side_effect=self.cloud), \
                mock.patch.object(app.time, "sleep"), \
                mock.patch.object(app, "secure_listener"), mock.patch.object(app, "sync_soon"):
            app.secure_check()

    def test_chiede_e_salva_il_certificato(self):
        self.prova()
        self.assertEqual(self.calls, ["/server/cert/start", "/server/cert/poll"])
        exp, names = app.secure_cert_info()
        self.assertEqual(names, ["*.1234abcd.bpx.test"])
        self.assertGreater(exp, time.time() + 80 * 86400)
        self.assertTrue(app.secure["on"])
        self.assertIsNotNone(app.secure["ctx"])
        # La richiesta e' per il nome giusto e la chiave resta qui
        req = x509.load_der_x509_csr(self.csr)
        self.assertEqual(req.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
                         .get_values_for_type(x509.DNSName), ["*.1234abcd.bpx.test"])
        self.assertIn(b"PRIVATE KEY", app.secure_files()[0].read_bytes())
        # Al controllo dopo non si richiede niente
        self.calls.clear()
        self.prova()
        self.assertEqual(self.calls, [])

    def test_rinnovo_vicino_alla_scadenza_e_dominio_cambiato(self):
        self.giorni = 10
        self.prova()
        self.calls.clear()
        self.giorni = 90
        self.prova()
        self.assertEqual(self.calls, ["/server/cert/start", "/server/cert/poll"])
        self.calls.clear()
        app.secure["domain"] = "altro.test"
        self.prova()
        self.assertEqual(app.secure_cert_info()[1], ["*.1234abcd.altro.test"])

    def test_senza_dominio_o_credenziale_niente(self):
        app.secure["domain"] = ""
        self.prova()
        app.secure["domain"] = "bpx.test"
        app.set_server_cred(None)
        self.prova()
        self.assertEqual(self.calls, [])
        self.assertFalse(app.secure["on"])


async def chiama(gate, method, path, headers=(), query=b""):
    sent = []
    seen = {}

    async def send(m):
        sent.append(m)

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}
    scope = {"type": "http", "method": method, "path": path, "query_string": query, "headers": list(headers),
             "server": ("127.0.0.1", 32500), "client": ("192.168.1.9", 5000)}
    await gate(scope, receive, send)
    return sent, seen


class CorsEChiavi(unittest.TestCase):
    def setUp(self):
        prepara()
        app.cors_cache.update(at=0.0)
        p = mock.patch.object(app, "DATA_PROBLEM", "")
        p.start()
        self.addCleanup(p.stop)
        self.seen = {}

        async def inner(scope, receive, send):
            self.seen["user"] = app.CURRENT.get()
            await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/plain")]})
            await send({"type": "http.response.body", "body": b"ok"})
        self.gate = app.Cors(app.AuthGate(inner))

    def test_preflight_e_intestazioni(self):
        with mock.patch.object(app.accounts, "cloud_url", return_value="https://acc.example.dev"):
            sent, _ = asyncio.run(chiama(self.gate, "OPTIONS", "/api/home", [
                (b"origin", b"https://acc.example.dev"), (b"access-control-request-method", b"GET"),
                (b"access-control-request-private-network", b"true")]))
            h = dict(sent[0]["headers"])
            self.assertEqual(sent[0]["status"], 204)
            self.assertEqual(h[b"access-control-allow-origin"], b"https://acc.example.dev")
            self.assertIn(b"Authorization", h[b"access-control-allow-headers"])
            self.assertEqual(h[b"access-control-allow-private-network"], b"true")
            # Un sito qualsiasi non riceve niente
            sent, _ = asyncio.run(chiama(self.gate, "GET", "/api/info", [(b"origin", b"https://cattivo.example")]))
            self.assertNotIn(b"access-control-allow-origin", dict(sent[0]["headers"]))

    def test_chiave_dei_video(self):
        tok = app.CURRENT.set({"id": app.server_owner(), "linked": True})
        try:
            k = app.access_media()
        finally:
            app.CURRENT.reset(tok)
        self.assertEqual(k["param"], "bpk")
        asyncio.run(chiama(self.gate, "GET", "/api/stream/1", query=b"bpk=" + k["key"].encode()))
        self.assertEqual(self.seen["user"]["name"], "anna")
        # Solo GET, niente chiavi ritoccate o scadute
        self.seen.clear()
        sent, _ = asyncio.run(chiama(self.gate, "POST", "/api/stream/1", query=b"bpk=" + k["key"].encode()))
        self.assertEqual(sent[0]["status"], 401)
        uid, exp, sig = k["key"].split(".")
        for bad in (f"{uid}.{exp}.{'0' * 32}", f"{uid}.{int(time.time()) - 5}.{app.media_sign(uid + '.' + str(int(time.time()) - 5))}"):
            sent, _ = asyncio.run(chiama(self.gate, "GET", "/api/stream/1", query=b"bpk=" + bad.encode()))
            self.assertEqual(sent[0]["status"], 401)
        # Un ospite o un amico non ne riceve
        tok = app.CURRENT.set({"id": 99, "linked": True, "guest": True})
        try:
            with self.assertRaises(app.HTTPException):
                app.access_media()
        finally:
            app.CURRENT.reset(tok)

    def test_porta_https_solo_con_gli_account(self):
        async def run():
            sent = []

            async def send(m):
                sent.append(m)
            scope = {"type": "http", "method": "GET", "path": "/api/info", "query_string": b"", "headers": [],
                     "server": ("0.0.0.0", app.SECURE_PORT), "client": ("192.168.1.9", 5000)}
            await self.gate(scope, None, send)
            return sent
        with mock.patch.object(app, "auth_on", return_value=False):
            self.assertEqual(asyncio.run(run())[0]["status"], 403)
        with mock.patch.object(app, "auth_on", return_value=True):
            self.assertEqual(asyncio.run(run())[0]["status"], 200)


if __name__ == "__main__":
    unittest.main()
