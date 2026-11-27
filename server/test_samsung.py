"""Prove dell'installazione sulle TV Samsung (samsunginstall.py) contro un finto
sdbd: una «TV» locale che parla sdb come quella vera (intestazione da 24 byte con
somma di controllo, flussi con OKAY a ogni WRTE, servizi capability:, sync: e
shell: con i soli comandi «0 <verbo>»).

Avvio: python -m unittest test_samsung
"""
import socket
import struct
import threading
import unittest
from unittest import mock

import samsunginstall as si

CNXN, OPEN, OKAY, CLSE, WRTE = si.CNXN, si.OPEN, si.OKAY, si.CLSE, si.WRTE


class FakeTv:
    """Un sdbd finto su 127.0.0.1. install: risposta di vd_appinstall (o una lista,
    una per installazione); accetta piu' collegamenti uno dopo l'altro."""

    OK = b"app_id[BnkrPlex01] installing[100]\ninstall completed\nspend time for wascmd is [900]ms\n"

    def __init__(self, install=OK, max_data=4096, duid="UFKKHHLLKKJJGG12"):
        self.srv = socket.socket()
        self.srv.bind(("127.0.0.1", 0))
        self.srv.listen(1)
        self.port = self.srv.getsockname()[1]
        self.install = install if isinstance(install, list) else [install]
        self.duid = duid
        self.max = max_data
        self.files = {}
        self.shells = []
        self.errors = []
        threading.Thread(target=self.serve, daemon=True).start()

    def send(self, c, cmd, a0, a1, data=b""):
        c.sendall(struct.pack("<6I", cmd, a0, a1, len(data), sum(data) & 0xFFFFFFFF, cmd ^ 0xFFFFFFFF) + data)

    def read(self, c):
        head = b""
        while len(head) < 24:
            try:
                part = c.recv(24 - len(head))
            except OSError:              # il client ha chiuso: fine della prova
                part = b""
            if not part:
                c.close()
                return None
            head += part
        cmd, a0, a1, n, chk, magic = struct.unpack("<6I", head)
        data = b""
        while len(data) < n:
            data += c.recv(n - len(data))
        if magic != cmd ^ 0xFFFFFFFF:
            self.errors.append("magic")
        if chk != sum(data) & 0xFFFFFFFF:
            self.errors.append("checksum")       # il vero sdbd chiude il collegamento
        if n > self.max:
            self.errors.append("troppo grande")
        return cmd, a0, a1, data

    def reply(self, c, local, remote, data):
        """La TV scrive sul flusso e aspetta OKAY."""
        self.send(c, WRTE, local, remote, data)
        p = self.read(c)
        if not p or p[0] != OKAY:
            self.errors.append("manca OKAY dal client")

    def serve(self):
        while True:
            c, _ = self.srv.accept()
            self.session(c)
            c.close()

    def session(self, c):
        p = self.read(c)
        if not p or p[0] != CNXN or not p[3].startswith(b"host::"):
            self.errors.append("CNXN")
            return
        self.send(c, CNXN, 0x02000000, self.max, b"device::QE55Q80::0\0")
        next_id = 100
        streams = {}
        while True:
            p = self.read(c)
            if p is None:
                return
            cmd, a0, a1, data = p
            if cmd == OPEN:
                next_id += 1
                name = data.rstrip(b"\0").decode()
                if not data.endswith(b"\0"):
                    self.errors.append("OPEN senza \\0")
                if name.startswith("shell:") and not name.startswith("shell:0 "):
                    self.send(c, CLSE, 0, a0)
                    continue
                streams[next_id] = {"name": name, "peer": a0, "buf": b""}
                self.send(c, OKAY, next_id, a0)
                if name == "capability:":
                    caps = b"sdk_toolpath:/home/owner/share/tmp/sdk_tools\nplatform_version:7.0\n"
                    self.reply(c, next_id, a0, struct.pack("<H", len(caps)) + caps)
                    self.send(c, CLSE, next_id, a0)
                elif name.startswith("shell:"):
                    cmdline = name[6:]
                    self.shells.append(cmdline)
                    if "vd_appinstall" in cmdline:
                        self.reply(c, next_id, a0, self.install.pop(0) if len(self.install) > 1 else self.install[0])
                    elif "getduid" in cmdline:
                        self.reply(c, next_id, a0, self.duid.encode() + b"\n")
                    elif "was_execute" in cmdline:
                        self.reply(c, next_id, a0, b"app_id[BnkrPlex01.BunkerPlex] launch start\n")
                    self.send(c, CLSE, next_id, a0)
            elif cmd == WRTE:
                st = streams.get(a1)
                self.send(c, OKAY, a1, a0)
                if not st or st["name"] != "sync:":
                    continue
                st["buf"] += data
                self.sync(c, a1, st)
            elif cmd == CLSE:
                streams.pop(a1, None)

    def sync(self, c, local, st):
        buf = st["buf"]
        while len(buf) >= 8:
            tag, n = buf[:4], struct.unpack("<I", buf[4:8])[0]
            if tag in (b"SEND", b"DATA") and len(buf) < 8 + n:
                break
            if tag == b"SEND":
                st["path"] = buf[8:8 + n].decode().split(",")[0]
                st["file"] = b""
                buf = buf[8 + n:]
            elif tag == b"DATA":
                st["file"] += buf[8:8 + n]
                buf = buf[8 + n:]
            elif tag == b"DONE":
                self.files[st["path"]] = st["file"]
                buf = buf[8:]
                self.reply(c, local, st["peer"], b"OKAY" + struct.pack("<I", 0))
            elif tag == b"QUIT":
                buf = buf[8:]
            else:
                self.errors.append("sync: " + repr(tag))
                buf = b""
        st["buf"] = buf


WGT = b"PK" + bytes(range(256)) * 120          # ~30 kB: piu' blocchi DATA


class SamsungInstall(unittest.TestCase):
    def run_install(self, tv, cert=None, signed_seen=None):
        """cert: risposte del servizio a GET /samsung/tv/<duid> (una per chiamata)."""
        answers = list(cert or [{"state": "unknown"}])
        calls = []

        def fake_call(method, path, body=None, token=None, timeout=12):
            calls.append((method, path, body, token))
            if method == "POST":
                return {"state": "waiting", "login": True}
            return answers.pop(0) if len(answers) > 1 else answers[0]

        def fake_download(signed=False):
            if signed_seen is not None:
                signed_seen.append(signed)
            return WGT

        with mock.patch.object(si, "SDB_PORT", tv.port), \
             mock.patch.object(si, "_download", side_effect=fake_download), \
             mock.patch.object(si, "tv_info", return_value=None), \
             mock.patch.object(si.accounts, "call", side_effect=fake_call), \
             mock.patch.object(si.time, "sleep", lambda s: None), \
             mock.patch.dict(si._hooks, {"cloud_token": lambda: "s_1234abcd_" + "0" * 64}):
            si._state["tvs"] = {}
            si._install("127.0.0.1", "")
        return calls

    def test_installa_e_apre(self):
        tv = FakeTv()
        self.run_install(tv)
        self.assertEqual(tv.errors, [])
        self.assertEqual(tv.files.get("/home/owner/share/tmp/sdk_tools/BunkerPlex.wgt"), WGT)
        self.assertIn("0 vd_appinstall BnkrPlex01 /home/owner/share/tmp/sdk_tools/BunkerPlex.wgt", tv.shells)
        self.assertIn("0 was_execute BnkrPlex01.BunkerPlex", tv.shells)
        self.assertEqual(si._state["step"], "done")

    def test_blocchi_piccoli(self):
        tv = FakeTv(max_data=1024)       # la TV chiede pacchetti piu' piccoli: si rispettano
        self.run_install(tv)
        self.assertEqual(tv.errors, [])
        self.assertEqual(tv.files.get("/home/owner/share/tmp/sdk_tools/BunkerPlex.wgt"), WGT)

    REFUSED = (b"app_id[BnkrPlex01] install failed[118, -12], reason: Check certificate error\n"
               b"spend time for wascmd is [300]ms\n")

    def test_certificato_chiesto_poi_app_firmata(self):
        # La TV rifiuta il certificato generico: si manda il DUID, si aspetta, poi l'app firmata
        tv = FakeTv(install=[self.REFUSED, FakeTv.OK])
        signed = []
        calls = self.run_install(tv, cert=[{"state": "unknown"}, {"state": "waiting", "login": False},
                                           {"state": "ready", "version": "1.0.2"}], signed_seen=signed)
        self.assertEqual(tv.errors, [])
        self.assertEqual(signed, [False, True])
        post = [c for c in calls if c[0] == "POST"]
        self.assertEqual(post[0][1], "/samsung/tv")
        self.assertEqual(post[0][2]["duid"], "UFKKHHLLKKJJGG12")
        self.assertTrue(post[0][3].startswith("s_"))
        self.assertIn("0 getduid", tv.shells)
        self.assertIn("0 was_execute BnkrPlex01.BunkerPlex", tv.shells)
        self.assertEqual(si._state["tvs"]["127.0.0.1"]["duid"], "UFKKHHLLKKJJGG12")
        self.assertEqual(si._state["step"], "done")

    def test_tv_gia_nel_certificato(self):
        tv = FakeTv()
        signed = []
        self.run_install(tv, cert=[{"state": "ready"}], signed_seen=signed)
        self.assertEqual(signed, [True])

    def test_certificato_senza_credenziale(self):
        tv = FakeTv(install=self.REFUSED)
        with mock.patch.dict(si._hooks, {"cloud_token": lambda: ""}):
            with self.assertRaises(RuntimeError) as e:
                self.run_install_plain(tv)
        self.assertIn("certificato Samsung", str(e.exception))
        self.assertNotIn("0 was_execute BnkrPlex01.BunkerPlex", tv.shells)

    def run_install_plain(self, tv):
        with mock.patch.object(si, "SDB_PORT", tv.port), \
             mock.patch.object(si, "_download", return_value=WGT), \
             mock.patch.object(si, "tv_info", return_value=None), \
             mock.patch.object(si.accounts, "call", return_value={"state": "unknown"}):
            si._state["tvs"] = {}
            si._install("127.0.0.1", "")

    def test_risposte(self):
        self.assertEqual(si.install_result("installing[100]")[0], True)
        self.assertIn("disinstallala", si.install_result("install failed[118, -11], reason: Author certificate not match")[1])
        self.assertIn("spazio", si.install_result("download failed[116]")[1])


if __name__ == "__main__":
    unittest.main()
