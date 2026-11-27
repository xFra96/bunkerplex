"""Installa l'app BunkerPlex sulle TV Samsung (Tizen) di casa direttamente dal
server, come tvinstall.py fa con le TV Android, ma col protocollo «sdb» di Samsung.

Sulla TV si accende la Modalita' sviluppatore (App, poi 1 2 3 4 5) scrivendo come
«IP del PC host» l'indirizzo di questo PC: la TV accetta collegamenti sdb (porta
26101) solo da li', niente chiavi ne' conferme. Poi il server:
  1. scarica BunkerPlex.wgt dalla release «samsung-tv» su GitHub (gia' firmato);
  2. lo copia sulla TV (servizio «sync:», come adb push);
  3. lo installa («0 vd_appinstall») e apre l'app («0 was_execute»).

sdb e' il protocollo di adb (stessa intestazione da 24 byte, stessi comandi) con
un'altra porta, senza autenticazione e con i soli comandi «0 <verbo>» ammessi dalla
TV. Riferimenti: il demone sdbd di Tizen (tizenorg/sdk.target.sdbd) e i client
liberi free-my-tv (Python) e TizenSdb.Core (C#).

La porta 8001 (API della TV) dice nome, modello, se la Modalita' sviluppatore e'
accesa e quale IP ha scritto: cosi' si spiega cosa manca prima di provare sdb.
"""

import ipaddress
import json
import re
import socket
import struct
import threading
import time
import traceback
import urllib.request
from collections import deque
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, HTTPException, Request

SDB_PORT = 26101
API_PORT = 8001
PACKAGE = "BnkrPlex01"                 # tizen/config.xml: <tizen:application package=...>
APP_ID = PACKAGE + ".BunkerPlex"       # ...e id=...
WGT_URL = "https://github.com/xFra96/bunkerplex/releases/download/samsung-tv/BunkerPlex.wgt"
TOOLPATH = "/home/owner/share/tmp/sdk_tools"

router = APIRouter(prefix="/api/tv/samsung")

_hooks = {"lan_ip": lambda host="": ""}
_lock = threading.Lock()
_cancel = threading.Event()
_state = {"phase": "", "step": "", "message": "", "error": "", "target": "", "pc": "",
          "scanned_at": 0.0, "done_at": 0.0, "tvs": {}}
_log = deque(maxlen=200)


def setup(lan_ip):
    _hooks["lan_ip"] = lan_ip


def log(text, kind="info"):
    _log.append({"at": time.time(), "text": text, "kind": kind})
    print(f"TV Samsung [{kind}]:", text, flush=True)


def _say(text, kind="info", step=None):
    _state["message"] = text
    if step:
        _state["step"] = step
    log(text, kind)


class Interrotto(Exception):
    pass


def _check_cancel():
    if _cancel.is_set():
        raise Interrotto()


# ---------------------------------------------------------------- sdb

CNXN, AUTH, OPEN, OKAY, CLSE, WRTE = (0x4E584E43, 0x48545541, 0x4E45504F,
                                      0x59414B4F, 0x45534C43, 0x45545257)
MAX_DATA = 4096


class SdbError(Exception):
    pass


class Sdb:
    """Client sdb minimo: un collegamento TCP, flussi aperti uno alla volta."""

    def __init__(self, ip, port=SDB_PORT, timeout=10):
        self.sock = socket.create_connection((ip, port), timeout=timeout)
        self.sock.settimeout(timeout)
        self.max = MAX_DATA
        self.next_id = 0
        self.bufs = {}                 # flusso locale -> dati arrivati
        self.closed = set()
        self._send(CNXN, 0x01000000, MAX_DATA, b"host::\0")
        while True:
            cmd, a0, a1, data = self._read()
            if cmd == CNXN:
                self.max = min(MAX_DATA, a1 or MAX_DATA)
                self.banner = data.rstrip(b"\0").decode("utf-8", "replace")
                return
            if cmd == AUTH:
                raise SdbError("La TV chiede una chiave (AUTH): questo modello non e' supportato")

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()

    def _send(self, cmd, a0, a1, data=b""):
        head = struct.pack("<6I", cmd, a0, a1, len(data), sum(data) & 0xFFFFFFFF, cmd ^ 0xFFFFFFFF)
        self.sock.sendall(head + data)

    def _exact(self, n):
        out = bytearray()
        while len(out) < n:
            part = self.sock.recv(n - len(out))
            if not part:
                raise SdbError("La TV ha chiuso il collegamento")
            out += part
        return bytes(out)

    def _read(self):
        cmd, a0, a1, n, _, magic = struct.unpack("<6I", self._exact(24))
        if magic != cmd ^ 0xFFFFFFFF:
            raise SdbError("Risposta della TV non valida")
        return cmd, a0, a1, self._exact(n) if n else b""

    def _pump(self):
        """Legge un pacchetto e lo smista. Ritorna (cmd, flusso locale, remoto)."""
        cmd, a0, a1, data = self._read()
        if cmd == WRTE:
            self.bufs.setdefault(a1, bytearray()).extend(data)
            self._send(OKAY, a1, a0)
        elif cmd == CLSE:
            self.closed.add(a1)
        return cmd, a1, a0

    def open(self, service):
        self.next_id += 1
        local = self.next_id
        self.bufs[local] = bytearray()
        self._send(OPEN, local, 0, service.encode() + b"\0")
        while True:
            cmd, dst, src = self._pump()
            if dst != local:
                continue
            if cmd == OKAY:
                return local, src
            if cmd == CLSE:
                raise SdbError(f"La TV ha rifiutato «{service.split(' ')[0]}»")

    def write(self, stream, data):
        local, remote = stream
        self._send(WRTE, local, remote, data)
        while True:
            cmd, dst, _ = self._pump()
            if dst != local:
                continue
            if cmd == OKAY:
                return
            if cmd == CLSE:
                raise SdbError("La TV ha chiuso il flusso durante la scrittura")

    def read_until(self, stream, done=None, timeout=30):
        """Dati del flusso finche' la TV lo chiude, done(dati) e' vero o scade il tempo."""
        local, remote = stream
        end = time.time() + timeout
        while local not in self.closed and not (done and done(bytes(self.bufs[local]))):
            if time.time() > end:
                break
            self.sock.settimeout(max(0.5, min(5, end - time.time())))
            try:
                self._pump()
            except socket.timeout:
                continue
            finally:
                self.sock.settimeout(10)
        return bytes(self.bufs.get(local, b""))

    def close_stream(self, stream):
        local, remote = stream
        if local not in self.closed:
            try:
                self._send(CLSE, local, remote)
            except OSError:
                pass

    def shell(self, cmd, done=None, timeout=30):
        st = self.open("shell:" + cmd)
        try:
            return self.read_until(st, done, timeout).decode("utf-8", "replace")
        finally:
            self.close_stream(st)

    def capability(self):
        st = self.open("capability:")
        raw = self.read_until(st, timeout=10)
        self.close_stream(st)
        text = raw[2:].decode("utf-8", "replace") if len(raw) >= 2 else ""
        return dict(line.split(":", 1) for line in text.splitlines() if ":" in line)

    def push(self, data, path, progress=None):
        st = self.open("sync:")
        spec = f"{path},{0o100644}".encode()
        self.write(st, b"SEND" + struct.pack("<I", len(spec)) + spec)
        step = self.max - 8
        for i in range(0, len(data), step):
            part = data[i:i + step]
            self.write(st, b"DATA" + struct.pack("<I", len(part)) + part)
            if progress:
                progress(min(len(data), i + step), len(data))
        self.write(st, b"DONE" + struct.pack("<I", int(time.time())))
        answer = self.read_until(st, lambda b: len(b) >= 8, 60)
        if answer[:4] != b"OKAY":
            msg = answer[8:].decode("utf-8", "replace") if answer[:4] == b"FAIL" else answer[:40].hex()
            raise SdbError(f"La TV non ha accettato il file: {msg or 'nessuna risposta'}")
        try:
            self._send(WRTE, st[0], st[1], b"QUIT" + struct.pack("<I", 0))
        except OSError:
            pass
        self.close_stream(st)


def connect(ip, tries=3):
    last = None
    for n in range(tries):
        try:
            return Sdb(ip, SDB_PORT)
        except (OSError, SdbError) as ex:
            last = ex
            time.sleep(0.4)
    raise SdbError(f"La TV non accetta il collegamento ({last}). Sulla TV, in Modalità sviluppatore, "
                   "come IP del PC host deve esserci quello di questo PC; poi la TV va spenta e riaccesa.")


def install_result(out):
    """(riuscita, spiegazione) dalla risposta di «0 vd_appinstall»."""
    if re.search(r"install completed|installing\[100\]", out):
        return True, ""
    if re.search(r"118\s*,\s*-11|Author certificate not match", out, re.I):
        return False, ("Sulla TV c'è già BunkerPlex firmata in un altro modo: disinstallala dalla TV "
                       "(App → BunkerPlex → Elimina) e riprova.")
    if re.search(r"118\s*,\s*-12|118012|certificate", out, re.I):
        return False, ("La TV non accetta il certificato dell'app: le TV più nuove (dal 2024 circa) vogliono un "
                       "certificato Samsung fatto per loro (vedi tizen/LEGGIMI.md). Intanto si usa BunkerPlex dal browser della TV.")
    if re.search(r"\[116\]", out):
        return False, "Sulla TV non c'è spazio: togli qualche app e riprova."
    if re.search(r"118\s*,\s*-4\b", out):
        return False, "Questa TV è troppo vecchia per l'app: usa BunkerPlex dal browser della TV."
    m = re.search(r"failed\[[^\]]*\][^\n]*", out)
    return False, "La TV non ha installato l'app" + (f": {m.group(0).strip()}" if m else ".")


# ---------------------------------------------------------------- ricerca

def tv_info(ip, timeout=1.5):
    """Nome e Modalita' sviluppatore dall'API della TV (porta 8001), se risponde."""
    try:
        with urllib.request.urlopen(f"http://{ip}:{API_PORT}/api/v2/", timeout=timeout) as r:
            d = json.loads(r.read().decode("utf-8", "replace")).get("device") or {}
    except Exception:
        return None
    if "tizen" not in str(d.get("OS", "Tizen")).lower() and not d.get("developerMode"):
        return None
    return {"name": str(d.get("name") or "").replace("[TV] ", "").strip(),
            "model": str(d.get("modelName") or ""),
            "dev": str(d.get("developerMode") or "") == "1",
            "dev_ip": str(d.get("developerIP") or "")}


def _port_open(ip, port):
    try:
        with socket.create_connection((ip, port), timeout=0.6):
            return True
    except OSError:
        return False


def _probe(ip):
    api = _port_open(ip, API_PORT)
    sdb = _port_open(ip, SDB_PORT)
    if not api and not sdb:
        return None
    info = tv_info(ip) if api else None
    if api and info is None and not sdb:
        return None                        # porta 8001 aperta ma non e' una Samsung
    tv = {"ip": ip, "name": "", "model": "", "dev": sdb, "dev_ip": "", "sdb": sdb}
    if info:
        tv.update(info)
        tv["dev"] = info["dev"] or sdb
    return tv


def _scan(host_header):
    pc = _hooks["lan_ip"](host_header)
    try:
        net = ipaddress.ip_network(f"{pc}/24", strict=False) if pc else None
    except ValueError:
        net = None
    if not net:
        raise RuntimeError("Non conosco ancora l'indirizzo di questo PC nella rete di casa: apri questa pagina "
                           "con l'indirizzo del PC (es. http://192.168.1.50:32500), non con localhost")
    _state["pc"] = pc
    _say(f"Cerco le TV Samsung nella rete di casa ({net})…", step="scan")
    hosts = [str(h) for h in net.hosts() if str(h) != pc]
    with ThreadPoolExecutor(64) as pool:
        found = [tv for tv in pool.map(_probe, hosts) if tv]
    _check_cancel()
    _state["tvs"] = {tv["ip"]: tv for tv in found}
    _state["scanned_at"] = time.time()
    if not found:
        _say("Nessuna TV Samsung trovata: controlla che sia accesa e sulla stessa rete del PC", "err", step="dev")
        return
    for tv in found:
        what = (f"Modalità sviluppatore accesa, IP del PC host {tv['dev_ip']}" if tv["dev"] and tv["dev_ip"]
                else "Modalità sviluppatore accesa" if tv["dev"] else "Modalità sviluppatore spenta")
        log(f"{tv['name'] or 'TV Samsung'} {tv['model']} ({tv['ip']}): {what}", "ok")
    ready = [tv for tv in found if tv["dev"]]
    _say(f"Trovate {len(found)} TV Samsung" if len(found) > 1 else "Trovata la TV Samsung", "ok",
         step="install" if ready else "dev")


# ---------------------------------------------------------------- installazione

def _download():
    _say("Scarico l'app per Samsung da GitHub…", step="install")
    req = urllib.request.Request(WGT_URL, headers={"User-Agent": "BunkerPlex"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    if data[:2] != b"PK":
        raise RuntimeError("Il file dell'app scaricato da GitHub non è valido")
    log(f"Scaricata BunkerPlex.wgt ({len(data) // 1024} kB)", "ok")
    return data


def _install(ip, host_header):
    pc = _hooks["lan_ip"](host_header)
    tv = _state["tvs"].get(ip) or {"ip": ip, "name": "", "model": ""}
    info = tv_info(ip)
    if info:
        tv.update(info)
        _state["tvs"][ip] = tv
        if not info["dev"]:
            raise RuntimeError("Sulla TV la Modalità sviluppatore è spenta: App → 1 2 3 4 5 → accendila, "
                               f"scrivi {pc or 'l’IP di questo PC'} come IP del PC host, poi spegni e riaccendi la TV.")
        if pc and info["dev_ip"] and info["dev_ip"] != pc:
            log(f"Sulla TV come IP del PC host c'è {info['dev_ip']}, il PC è {pc}", "dbg")
    data = _download()
    _check_cancel()
    _say("Mi collego alla TV…", step="install")
    with connect(ip) as sdb:
        name = sdb.banner.split("::")[1] if "::" in sdb.banner else ""
        log(f"Collegata: {name or ip} ({sdb.banner})", "dbg")
        try:
            caps = sdb.capability()
        except SdbError:
            caps = {}
        ver = caps.get("platform_version", "")
        if ver:
            log(f"Tizen {ver}", "dbg")
        base = (caps.get("sdk_toolpath") or TOOLPATH).rstrip("/")
        path = f"{base}/BunkerPlex.wgt"
        _check_cancel()
        _say("Copio l'app sulla TV…")
        sdb.push(data, path)
        log(f"Copiata in {path}", "dbg")
        _check_cancel()
        _say("Installo l'app sulla TV…")
        out = sdb.shell(f"0 vd_appinstall {PACKAGE} {path}",
                        done=lambda b: b"spend time" in b or b"install completed" in b or b"failed[" in b,
                        timeout=180)
        log("vd_appinstall: " + (out.strip()[-1500:] or "(nessuna risposta)"), "dbg")
        ok, why = install_result(out)
        if not ok:
            raise RuntimeError(why)
        log("App installata", "ok")
        try:
            sdb.shell("0 rmfile", timeout=5)
        except (OSError, SdbError):
            pass
        try:
            out = sdb.shell(f"0 was_execute {APP_ID}", done=lambda b: b"launch" in b, timeout=15)
            log("was_execute: " + (out.strip() or "(nessuna risposta)"), "dbg")
        except (OSError, SdbError):
            pass
    tv["installed"] = True
    _say("Fatto: BunkerPlex è tra le App della TV e si è aperta. Collegala dal telefono con il codice.", "ok", step="done")


def _run(phase, target, fn, *args):
    if not _lock.acquire(blocking=False):
        raise HTTPException(409, "Sto già lavorando su una TV: aspetta un attimo")

    def job():
        try:
            _cancel.clear()
            _state.update(phase=phase, target=target, error="", message="")
            log(("Cerco le TV Samsung" if phase == "scan" else f"Installo su {target}"), "sep")
            fn(*args)
        except Interrotto:
            _state.update(error="", step="")
            log("Interrotto: puoi riprovare quando vuoi", "err")
        except Exception as ex:
            msg = str(ex) or ex.__class__.__name__
            _state["error"] = msg
            log(msg, "err")
            if not isinstance(ex, (RuntimeError, SdbError)):
                log(traceback.format_exc(limit=3), "dbg")
        finally:
            _state.update(phase="", message="", done_at=time.time())
            _lock.release()

    threading.Thread(target=job, name="samsung-" + phase, daemon=True).start()


def _status(host_header=""):
    return {"phase": _state["phase"], "step": _state["step"] or "dev", "message": _state["message"],
            "error": _state["error"], "target": _state["target"],
            "pc": _state["pc"] or _hooks["lan_ip"](host_header),
            "scanned_at": _state["scanned_at"], "tvs": list(_state["tvs"].values()), "log": list(_log)[-60:]}


def _ip(body):
    ip = str((body or {}).get("ip") or "").strip()
    try:
        ipaddress.IPv4Address(ip)
    except ValueError:
        raise HTTPException(400, "Indirizzo non valido: scrivi per esempio 192.168.1.180")
    return ip


@router.get("")
def samsung_status(request: Request):
    return _status(request.headers.get("host", ""))


@router.post("/scan")
def samsung_scan(request: Request):
    host = request.headers.get("host", "")
    _run("scan", "", _scan, host)
    return _status(host)


@router.post("/install")
async def samsung_install(request: Request):
    host = request.headers.get("host", "")
    ip = _ip(await request.json())
    _run("install", ip, _install, ip, host)
    return _status(host)


@router.post("/cancel")
def samsung_cancel(request: Request):
    if _state["phase"]:
        _cancel.set()
    return _status(request.headers.get("host", ""))
