"""Installa l'app BunkerPlex sulle TV Android di casa direttamente dal server,
con il "debug di rete" (adb), senza Downloader ne' chiavette.

Il server gira dentro Docker: da li' raggiunge la rete di casa, quindi cerca le
TV che hanno il debug acceso (porta 5555 aperta) nella stessa rete del PC, si
collega (la TV chiede una volta «Consentire il debug?») e installa l'APK che sta
sul PC. Poi apre l'app sulla TV, che trova il server da sola.

adb arriva con l'immagine Docker (pacchetto «adb»); se l'immagine e' di prima,
la prima volta lo scarica da Google (platform-tools ufficiali, solo PC x86-64).
Le chiavi di adb stanno in data/adb: la TV, dopo «Consenti sempre», non lo
richiede piu', neanche dopo un riavvio o un aggiornamento del server.
"""

import ipaddress
import os
import platform
import re
import shutil
import socket
import subprocess
import threading
import time
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, wait
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request

PACKAGE = "it.bunkerplex.tv"
OLD_PACKAGE = "it.francoplex.tv"      # l'app di prima, che non si aggiorna da sola
ADB_PORT = 5555
DATA = Path(os.environ.get("DATA_DIR", "/data")) / "adb"
TOOLS_URL = "https://dl.google.com/android/repository/platform-tools-latest-linux.zip"
TOOLS_DIR = Path("/tmp/bunkerplex-adb")    # dentro il contenitore: li' i file sono eseguibili

router = APIRouter(prefix="/api/tv")

_hooks = {"lan_ip": lambda host="": "", "apk_version": lambda: (None, None), "apk": None}
_lock = threading.Lock()            # un comando adb "lungo" alla volta (scansione, installazione)
_state = {"phase": "", "message": "", "error": "", "target": "", "done_at": 0.0,
          "scanned_at": 0.0, "found": [], "names": {}}


def setup(lan_ip, apk_version, apk_path):
    """Lo chiama app.py: come sapere l'IP del PC e dov'e' l'APK."""
    _hooks.update(lan_ip=lan_ip, apk_version=apk_version, apk=Path(apk_path))


# ---------------------------------------------------------------- adb

def _set(**kw):
    _state.update(kw)


def _adb_path():
    found = shutil.which("adb")
    if found:
        return found
    local = TOOLS_DIR / "platform-tools" / "adb"
    return str(local) if local.is_file() else ""


def _ensure_adb():
    """adb, scaricato la prima volta se l'immagine Docker non ce l'ha."""
    path = _adb_path()
    if path:
        return path
    if platform.machine().lower() not in ("x86_64", "amd64"):
        raise RuntimeError("adb manca: rilancia «Installa BunkerPlex» sul computer per aggiornare Docker")
    _set(message="Preparo adb (la prima volta lo scarico da Google)…")
    DATA.mkdir(parents=True, exist_ok=True)
    cached = DATA / "platform-tools.zip"
    if not cached.is_file() or cached.stat().st_size < 1_000_000:
        part = cached.with_suffix(".nuovo")
        with urllib.request.urlopen(TOOLS_URL, timeout=60) as r, open(part, "wb") as f:
            shutil.copyfileobj(r, f)
        os.replace(part, cached)
    shutil.rmtree(TOOLS_DIR, ignore_errors=True)
    TOOLS_DIR.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(cached) as z:
        z.extractall(TOOLS_DIR)
    local = TOOLS_DIR / "platform-tools" / "adb"
    os.chmod(local, 0o755)
    return str(local)


def _env():
    home = DATA / "home"
    home.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, HOME=str(home), ANDROID_USER_HOME=str(home / ".android"),
               ADB_MDNS="0")
    return env


def adb(*args, timeout=20):
    """Esegue adb e restituisce (codice, testo)."""
    try:
        p = subprocess.run([_ensure_adb(), *args], capture_output=True, text=True,
                           timeout=timeout, env=_env())
    except subprocess.TimeoutExpired:
        return 124, "tempo scaduto"
    return p.returncode, ((p.stdout or "") + (p.stderr or "")).strip()


def _devices():
    """{"ip:porta": stato} dei dispositivi collegati ad adb (device, unauthorized, offline)."""
    code, out = adb("devices", timeout=15)
    found = {}
    for line in out.splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 2 and re.fullmatch(r"[\d.]+:\d+", parts[0]):
            found[parts[0]] = parts[1]
    return found


def _shell(serial, cmd, timeout=10):
    code, out = adb("-s", serial, "shell", cmd, timeout=timeout)
    return out if code == 0 else ""


def _version_of(serial, package):
    out = _shell(serial, f"dumpsys package {package} | grep -m1 versionCode")
    m = re.search(r"versionCode=(\d+)", out)
    return int(m.group(1)) if m else None


_details_cache = {}


def _details(serial):
    """Nome e versione dell'app per un dispositivo che ha gia' dato il permesso
    (ricordati 20 secondi: la pagina chiede lo stato ogni paio di secondi)."""
    hit = _details_cache.get(serial)
    if hit and time.time() - hit[0] < 20:
        return hit[1]
    model = _shell(serial, "getprop ro.product.model").strip()
    brand = _shell(serial, "getprop ro.product.manufacturer").strip()
    name = " ".join(x for x in (brand.capitalize() if brand and brand.lower() not in model.lower() else "", model) if x)
    out = {"name": name, "installed": _version_of(serial, PACKAGE),
           "old_app": _version_of(serial, OLD_PACKAGE) is not None}
    _details_cache[serial] = (time.time(), out)
    return out


# ---------------------------------------------------------------- ricerca

def _subnet(ip):
    try:
        return ipaddress.ip_network(f"{ip}/24", strict=False)
    except ValueError:
        return None


def _open(ip, port=ADB_PORT):
    try:
        with socket.create_connection((str(ip), port), timeout=0.6):
            return True
    except OSError:
        return False


def _hostname(ip):
    try:
        name = socket.gethostbyaddr(ip)[0].split(".")[0]
        return "" if name == ip else name
    except Exception:
        return ""


def _scan(host_header):
    pc = _hooks["lan_ip"](host_header)
    net = _subnet(pc) if pc else None
    if not net:
        raise RuntimeError("Non conosco ancora l'indirizzo di questo PC nella rete di casa: "
                           "apri questa pagina con l'indirizzo del PC (es. http://192.168.1.50:32500), non con localhost")
    _set(message=f"Cerco le TV con il debug acceso nella rete {net}…")
    hosts = [str(h) for h in net.hosts() if str(h) != pc]
    with ThreadPoolExecutor(64) as pool:
        found = [ip for ip, ok in zip(hosts, pool.map(_open, hosts)) if ok]
    names = dict(_state["names"])
    with ThreadPoolExecutor(8) as pool:
        futures = {ip: pool.submit(_hostname, ip) for ip in found if ip not in names}
        wait(futures.values(), timeout=2)
        for ip, fut in futures.items():
            if fut.done() and fut.result():
                names[ip] = fut.result()
    # Collegarsi subito fa comparire sulla TV la richiesta del permesso
    for ip in found:
        _set(message=f"Mi collego a {ip}…")
        adb("connect", f"{ip}:{ADB_PORT}", timeout=12)
    _set(found=found, names=names, scanned_at=time.time())
    return found


def _connect(target):
    code, out = adb("connect", target, timeout=15)
    if "connected" not in out or "cannot" in out or "failed" in out:
        raise RuntimeError(f"Non riesco a collegarmi a {target}: controlla che sulla TV sia acceso il debug "
                           "e che l'indirizzo sia giusto")
    ip = target.split(":")[0]
    if ip not in _state["found"]:
        _set(found=_state["found"] + [ip])


def _pair(target, code_):
    code, out = adb("pair", target, code_, timeout=20)
    if "Successfully paired" not in out:
        raise RuntimeError("Associazione non riuscita: controlla indirizzo, porta e codice mostrati sulla TV "
                           f"({out.splitlines()[-1] if out else 'nessuna risposta'})")


def _install(serial, replace):
    apk = _hooks["apk"]
    if not apk or not apk.is_file():
        raise RuntimeError("Sul PC non c'è ancora l'APK: aspetta il prossimo aggiornamento o avvia «Compila APK.bat»")
    state = _devices().get(serial)
    if state in (None, "offline"):
        _connect(serial)
        state = _devices().get(serial)
    deadline = time.time() + 60
    while state == "unauthorized" and time.time() < deadline:
        _set(message="Sulla TV premi «Consenti» (metti la spunta su «Consenti sempre»)…")
        time.sleep(2)
        state = _devices().get(serial)
    if state == "unauthorized":
        raise RuntimeError("Sulla TV non è stato dato il permesso: premi «Consenti» quando compare, poi riprova")
    if state != "device":
        raise RuntimeError("La TV non risponde: è accesa e con il debug attivo?")
    if replace:
        _set(message="Tolgo dalla TV l'app con la firma diversa…")
        adb("-s", serial, "uninstall", PACKAGE, timeout=60)
    _set(message="Copio e installo l'app sulla TV (meno di un minuto)…")
    code, out = adb("-s", serial, "install", "-r", str(apk), timeout=600)
    if "Success" not in out:
        if "INSTALL_FAILED_UPDATE_INCOMPATIBLE" in out or "signatures do not match" in out:
            raise RuntimeError("INCOMPATIBILE")
        if "INSTALL_FAILED_INSUFFICIENT_STORAGE" in out:
            raise RuntimeError("Sulla TV non c'è abbastanza spazio libero")
        if "INSTALL_FAILED_VERSION_DOWNGRADE" in out:
            raise RuntimeError("Sulla TV c'è già una versione più nuova dell'app")
        raise RuntimeError("Installazione non riuscita: " + (out.splitlines()[-1] if out else "nessuna risposta"))
    _details_cache.pop(serial, None)
    if _version_of(serial, OLD_PACKAGE) is not None:
        _set(message="Tolgo dalla TV la vecchia app (quella di prima di BunkerPlex)…")
        adb("-s", serial, "uninstall", OLD_PACKAGE, timeout=60)
    _set(message="Apro BunkerPlex sulla TV…")
    for category in ("android.intent.category.LEANBACK_LAUNCHER", "android.intent.category.LAUNCHER"):
        c, o = adb("-s", serial, "shell", "monkey", "-p", PACKAGE, "-c", category, "1", timeout=20)
        if c == 0 and "No activities found" not in o:
            break


def _run(phase, target, fn, *args):
    if not _lock.acquire(blocking=False):
        raise HTTPException(409, "Sto già lavorando su una TV: aspetta un attimo")

    def job():
        try:
            _set(phase=phase, target=target, error="", message="")
            fn(*args)
            _set(message="", done_at=time.time(), last=phase)
        except Exception as ex:
            print("TV:", phase, repr(ex), flush=True)
            _set(error=str(ex) or repr(ex), message="", done_at=time.time(), last=phase)
        finally:
            _set(phase="")
            _lock.release()

    threading.Thread(target=job, daemon=True, name=f"tv-{phase}").start()


# ---------------------------------------------------------------- API

def _target(body, default_port=ADB_PORT):
    raw = str(body.get("target") or "").strip()
    m = re.fullmatch(r"(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{2,5}))?", raw)
    if not m:
        raise HTTPException(400, "Scrivi l'indirizzo della TV, es. 192.168.1.180")
    try:
        ip = ipaddress.ip_address(m.group(1))
    except ValueError:
        raise HTTPException(400, "Indirizzo non valido")
    if not ip.is_private:
        raise HTTPException(400, "Solo TV della rete di casa")
    return f"{ip}:{m.group(2) or default_port}"


def _status():
    code, name = _hooks["apk_version"]()
    out = {"phase": _state["phase"], "message": _state["message"], "error": _state["error"],
           "target": _state["target"], "last": _state.get("last", ""), "done_at": _state["done_at"],
           "scanned_at": _state["scanned_at"], "adb": bool(_adb_path()),
           "apk": bool(_hooks["apk"] and _hooks["apk"].is_file()), "apk_version": code, "devices": []}
    if not out["adb"] and not _state["scanned_at"]:
        return out
    try:
        devs = _devices() if out["adb"] else {}
    except Exception:
        devs = {}
    seen = set()
    for serial, st in devs.items():
        ip = serial.split(":")[0]
        seen.add(ip)
        d = {"serial": serial, "ip": ip, "state": st, "name": _state["names"].get(ip, "")}
        if st == "device" and not _state["phase"]:
            d.update({k: v for k, v in _details(serial).items() if v or k != "name"})
        out["devices"].append(d)
    for ip in _state["found"]:
        if ip not in seen:
            out["devices"].append({"serial": f"{ip}:{ADB_PORT}", "ip": ip, "state": "found",
                                   "name": _state["names"].get(ip, "")})
    return out


@router.get("")
def tv_status():
    return _status()


@router.post("/scan")
def tv_scan(request: Request):
    _run("scan", "", _scan, request.headers.get("host", ""))
    return _status()


@router.post("/connect")
async def tv_connect(request: Request):
    body = await request.json()
    _run("connect", _target(body), _connect, _target(body))
    return _status()


@router.post("/pair")
async def tv_pair(request: Request):
    body = await request.json()
    code = re.sub(r"\D", "", str(body.get("code") or ""))
    if len(code) != 6:
        raise HTTPException(400, "Il codice di associazione ha 6 cifre")
    target = _target(body, default_port=0)
    if target.endswith(":0"):
        raise HTTPException(400, "Scrivi anche la porta di associazione, es. 192.168.1.180:37123")
    _run("pair", target, _pair, target, code)
    return _status()


@router.post("/install")
async def tv_install(request: Request):
    body = await request.json()
    target = _target(body)
    _run("install", target, _install, target, bool(body.get("replace")))
    return _status()
