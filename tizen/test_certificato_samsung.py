"""Prove di certificato_samsung.py con un finto Samsung (una CA locale firma le CSR).

  cd tizen && python -m unittest test_certificato_samsung
"""
import base64
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import certificato_samsung as cs

PW = "prova-password-123"


class FakeSamsung:
    """Firma le CSR con una CA fatta al momento; ricorda le richieste."""

    def __init__(self, work):
        self.work = work
        self.calls = []
        self.key = work / "ca.key"
        self.crt = work / "ca.crt"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(self.key),
                        "-out", str(self.crt), "-subj", "/CN=Finta Samsung", "-days", "30"],
                       check=True, capture_output=True)
        self.fail_with = None

    def __call__(self, path, fields, csr_name, csr):
        self.calls.append((path, dict(fields), csr_name))
        if self.fail_with:
            raise self.fail_with
        if path == "/v1/distributors":
            return "<profile/>"
        n = len(self.calls)
        req, ext, out = self.work / f"r{n}.csr", self.work / f"r{n}.ext", self.work / f"r{n}.crt"
        req.write_text(csr)
        args = ["openssl", "x509", "-req", "-in", str(req), "-CA", str(self.crt), "-CAkey", str(self.key),
                "-CAcreateserial", "-out", str(out), "-days", "365"]
        if "distributors" in path:
            args += ["-copy_extensions", "copy"]
        subprocess.run(args, check=True, capture_output=True)
        return out.read_text()


def p12_pem(path):
    """I certificati di un .p12 (PEM): si legge con la password, quindi e' cifrato giusto."""
    return subprocess.run(["openssl", "pkcs12", "-in", str(path), "-nokeys", "-passin", "env:P12_PW"],
                          check=True, capture_output=True, env={**os.environ, "P12_PW": PW}).stdout


class CertificatoTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.work = Path(self.tmp.name)
        self.fake = FakeSamsung(self.work)
        self.real_ask = cs.ask
        cs.ask = self.fake

    def tearDown(self):
        cs.ask = self.real_ask
        self.tmp.cleanup()

    def job(self, **kw):
        base = {"duids": ["ABCDEFGHIJ1234567890", "bad duid!"], "listed": [],
                "token": {"access_token": "t", "user_id": "u"}, "keys": None}
        base.update(kw)
        return base

    def test_nuovi_autore_e_distributore(self):
        out = self.work / "out"
        out.mkdir()
        res = cs.issue(self.job(), out, PW)
        self.assertEqual(res["listed"], ["ABCDEFGHIJ1234567890"])
        self.assertTrue(res["author_new"])
        self.assertGreater(res["author_until"], 0)
        self.assertEqual([c[0] for c in self.fake.calls], ["/v3/authors", "/v1/distributors", "/v3/distributors"])
        self.assertEqual(self.fake.calls[0][1]["platform"], "VD")
        self.assertEqual(self.fake.calls[2][1]["privilege_level"], "Public")
        self.assertNotIn("platform", self.fake.calls[2][1])
        # Il distributore elenca la TV; nel .p12 c'e' anche l'autorita' Samsung
        pem = p12_pem(out / "distributor.p12")
        self.assertIn(b"VD DEVELOPER Public CA Class", pem)
        crt = out / "d.pem"
        crt.write_bytes(pem)
        txt = subprocess.run(["openssl", "x509", "-in", str(crt), "-noout", "-text"], capture_output=True).stdout
        self.assertIn(b"URI:URN:tizen:deviceid=ABCDEFGHIJ1234567890", txt)
        self.assertIn(b"URI:URN:tizen:packageid=", txt)
        apem = p12_pem(out / "author.p12")
        self.assertIn(b"Samsung VD Author CA", apem)

    def test_autore_tenuto(self):
        out = self.work / "a"
        out.mkdir()
        cs.issue(self.job(), out, PW)
        keys = {"author": base64.b64encode((out / "author.p12").read_bytes()).decode(),
                "distributor": base64.b64encode((out / "distributor.p12").read_bytes()).decode()}
        self.fake.calls.clear()
        out2 = self.work / "b"
        out2.mkdir()
        res = cs.issue(self.job(duids=["ABCDEFGHIJ1234567890", "ZZZZZZZZZZ00000"], keys=keys), out2, PW)
        self.assertFalse(res["author_new"])
        self.assertEqual((out2 / "author.p12").read_bytes(), (out / "author.p12").read_bytes())
        self.assertEqual([c[0] for c in self.fake.calls], ["/v1/distributors", "/v3/distributors"])
        self.assertEqual(res["listed"], ["ABCDEFGHIJ1234567890", "ZZZZZZZZZZ00000"])

    def test_gettone_scaduto(self):
        self.fake.fail_with = cs.Fail(3, "token", "scaduto")
        with self.assertRaises(cs.Fail) as e:
            cs.issue(self.job(), self.work, PW)
        self.assertEqual(e.exception.kind, "token")
        with self.assertRaises(cs.Fail) as e:
            cs.issue(self.job(token=None), self.work, PW)
        self.assertEqual(e.exception.code, 3)

    def test_impronte_autorita(self):
        for item in (cs.AUTHOR_CA, cs.PUBLIC_CA):
            cs.ca_file(item)

    def test_main_restore(self):
        out = self.work / "a"
        out.mkdir()
        cs.issue(self.job(), out, PW)
        job = {"listed": ["ABCDEFGHIJ1234567890"],
               "keys": {"author": base64.b64encode((out / "author.p12").read_bytes()).decode(),
                        "distributor": base64.b64encode((out / "distributor.p12").read_bytes()).decode()}}
        jp = self.work / "job.json"
        jp.write_text(json.dumps(job))
        os.environ["P12_PW"] = PW
        import sys
        old = sys.argv
        sys.argv = ["x", "restore", str(jp), str(self.work / "r")]
        try:
            self.assertEqual(cs.main(), 0)
        finally:
            sys.argv = old
        res = json.loads((self.work / "r" / "result.json").read_text())
        self.assertEqual(res["listed"], ["ABCDEFGHIJ1234567890"])
        self.assertGreater(res["distributor_until"], 0)


if __name__ == "__main__":
    unittest.main()
