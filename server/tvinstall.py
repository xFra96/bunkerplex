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
import traceback
import urllib.request
import zipfile
from collections import deque
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

_hooks = {"lan_ip": lambda host="": "", "apk_version": lambda: (None, None), "apk": None,
          "server_version": ""}
_lock = threading.Lock()            # un comando adb "lungo" alla volta (scansione, installazione)
_state = {"phase": "", "message": "", "error": "", "target": "", "done_at": 0.0,
          "scanned_at": 0.0, "found": [], "names": {}, "step": "", "pc": ""}
# Il racconto di quello che succede, mostrato nella pagina (e nel log di Docker).
# Non si svuota tra un tentativo e l'altro: chi chiede aiuto copia tutto con
# «Copia il log» (comandi adb e risposte esatte comprese, righe "dbg").
_log = deque(maxlen=400)
LOG_FILE = DATA / "tv.log"          # lo stesso racconto su file: resta anche dopo un riavvio
LOG_MAX = 512 * 1024
_log_lock = threading.Lock()
# «Interrompi» nella pagina: il lavoro in corso si ferma al primo controllo
_cancel = threading.Event()
_job = {"thread": None}


class Interrotto(Exception):
    pass


def _stopping():
    """True se nella pagina si e' premuto «Interrompi» e siamo nel lavoro in corso
    (la pagina che chiede lo stato usa adb da un altro thread: quello non si ferma)."""
    return _cancel.is_set() and threading.current_thread() is _job["thread"]


def _check_cancel():
    if _stopping():
        raise Interrotto()


def setup(lan_ip, apk_version, apk_path, server_version=""):
    """Lo chiama app.py: come sapere l'IP del PC e dov'e' l'APK."""
    _hooks.update(lan_ip=lan_ip, apk_version=apk_version, apk=Path(apk_path),
                  server_version=server_version)


# ---------------------------------------------------------------- adb

def _set(**kw):
    _state.update(kw)


def log(text, kind="info"):
    """kind: info, wait (aspetto la TV), ok, err, dbg (dettagli tecnici: comandi
    adb e risposte), sep (inizio di un tentativo)."""
    now = time.time()
    with _log_lock:
        _log.append({"at": now, "text": text, "kind": kind})
        line = f"{time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(now))} [{kind}] {text}\n"
        try:
            DATA.mkdir(parents=True, exist_ok=True)
            if LOG_FILE.is_file() and LOG_FILE.stat().st_size > LOG_MAX:
                keep = LOG_FILE.read_bytes()[-LOG_MAX // 2:]
                LOG_FILE.write_bytes(keep[keep.find(b"\n") + 1:])
            with open(LOG_FILE, "a", encoding="utf-8") as f:
                f.write(line)
        except OSError:
            pass
    print(f"TV [{kind}]:", text, flush=True)


def _load_log():
    """All'avvio la pagina mostra di nuovo le ultime righe del file: dopo un riavvio
    o un aggiornamento del server l'ultimo errore resta visibile."""
    try:
        lines = LOG_FILE.read_text(encoding="utf-8", errors="replace").splitlines()[-300:]
    except OSError:
        return
    for line in lines:
        m = re.match(r"(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) \[(\w+)\] (.*)", line)
        if m:
            try:
                at = time.mktime(time.strptime(m.group(1), "%Y-%m-%d %H:%M:%S"))
            except ValueError:
                continue
            _log.append({"at": at, "text": m.group(3), "kind": m.group(2)})
        elif _log:                                   # seguito di una risposta su piu' righe
            _log[-1]["text"] += "\n" + line


_load_log()


def _short(out, limit=1500):
    out = (out or "").strip() or "(nessuna risposta)"
    return out if len(out) <= limit else out[:limit] + f"… (+{len(out) - limit} caratteri)"


def _say(text, kind="info", step=None):
    """Messaggio di adesso + riga nel racconto."""
    _set(message=text, **({"step": step} if step else {}))
    log(text, kind)


def _label(ip):
    name = _state["names"].get(ip.split(":")[0], "")
    return f"{name} ({ip.split(':')[0]})" if name else ip.split(":")[0]


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
    _say("Preparo adb, lo strumento per parlare con la TV (la prima volta lo scarico da Google, circa 7 MB)…")
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
    log("adb pronto", "ok")
    return str(local)


def _env():
    home = DATA / "home"
    home.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, HOME=str(home), ANDROID_USER_HOME=str(home / ".android"),
               ADB_MDNS="0")
    return env


def adb(*args, timeout=20):
    """Esegue adb e restituisce (codice, testo). Nel lavoro in corso si puo'
    interrompere anche a meta' (per esempio mentre copia l'APK sulla TV)."""
    _check_cancel()
    # Nel lavoro in corso ogni comando finisce nel log, con la risposta esatta
    # («adb devices» no: si ripete ogni 2 secondi, si scrivono i cambi di stato)
    traced = threading.current_thread() is _job["thread"] and args[:1] != ("devices",)
    started = time.time()
    p = subprocess.Popen([_ensure_adb(), *args], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True, env=_env())
    end = started + timeout
    while True:
        try:
            out, _ = p.communicate(timeout=0.5)
            code, out = p.returncode, (out or "").strip()
            break
        except subprocess.TimeoutExpired:
            stop = _stopping()
            if stop or time.time() >= end:
                p.kill()
                p.communicate()
                if stop:
                    if traced:
                        log(f"$ adb {' '.join(args)} → interrotto dopo {time.time() - started:.0f} s", "dbg")
                    raise Interrotto()
                code, out = 124, f"tempo scaduto ({timeout} s)"
                break
    if traced:
        log(f"$ adb {' '.join(args)} → codice {code}, {time.time() - started:.1f} s: {_short(out)}", "dbg")
    return code, out


def _devices():
    """{"ip:porta": stato} dei dispositivi collegati ad adb (device, unauthorized, offline)."""
    code, out = adb("devices", timeout=15)
    if "daemon not running" in out and threading.current_thread() is _job["thread"]:
        # Il servizio adb si era chiuso: i collegamenti di prima (e un permesso in attesa) sono persi
        log("Il servizio adb non era acceso: l'ho riavviato, i collegamenti di prima sono persi", "dbg")
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
    _set(pc=pc)
    _say(f"Cerco le TV con il debug acceso nella rete di casa ({net}, {net.num_addresses - 2} indirizzi)…",
         step="scan")
    hosts = [str(h) for h in net.hosts() if str(h) != pc]
    with ThreadPoolExecutor(64) as pool:
        found = [ip for ip, ok in zip(hosts, pool.map(_open, hosts)) if ok]
    _check_cancel()
    log(f"Porta {ADB_PORT} aperta su: {', '.join(found) or 'nessun indirizzo'}", "dbg")
    known = _devices()
    log(f"Già noti ad adb: {', '.join(f'{k} {v}' for k, v in known.items()) or 'nessuno'}", "dbg")
    for serial in known:                   # TV gia' collegate (anche con porta diversa da 5555)
        ip = serial.split(":")[0]
        if ip not in found:
            found.append(ip)
    names = dict(_state["names"])
    with ThreadPoolExecutor(8) as pool:
        futures = {ip: pool.submit(_hostname, ip) for ip in found if ip not in names}
        wait(futures.values(), timeout=2)
        for ip, fut in futures.items():
            if fut.done() and fut.result():
                names[ip] = fut.result()
    _set(found=found, names=names, scanned_at=time.time())
    for ip in found:
        st = next((v for k, v in known.items() if k.startswith(ip + ":")), "")
        log(f"Trovata: {_label(ip)}" + (" · già collegata" if st == "device" else
                                       " · aspetta il permesso sulla TV" if st == "unauthorized" else
                                       " · debug acceso"), "ok")
    if not found:
        _set(step="debug")
        log("Nessuna TV con il debug acceso. Controlla che la TV sia accesa, nella stessa rete del PC "
            "e con «Debug USB» / «Debug ADB» attivo (vedi i passi qui sotto). Puoi anche scrivere il suo indirizzo.", "err")
        return found
    if len(found) == 1:
        # Una sola: ci si collega subito, cosi' sulla TV compare la richiesta del permesso
        log("Una sola TV: mi collego subito a quella")
        _connect_and_wait(f"{found[0]}:{ADB_PORT}" if not any(k.startswith(found[0] + ":") for k in known)
                          else next(k for k in known if k.startswith(found[0] + ":")))
        _set(step="install")
        log("Ora premi «Installa l'app» qui sotto", "ok")
    else:
        _set(step="choose")
        log(f"Ho trovato {len(found)} TV: scegli qui sotto su quale installare l'app", "wait")
    return found


def _connect_and_wait(serial, wait_s=120):
    """Collega la TV e aspetta che sulla TV si prema «Consenti». True se pronta."""
    state = _devices().get(serial)
    log(f"Stato di {serial} per adb: {state or 'non collegata'}", "dbg")
    if state == "device":
        return True
    if state == "unauthorized":
        # Collegamento rimasto da un tentativo di prima: la TV la richiesta l'ha gia'
        # mostrata (e magari chiusa) e non la ripropone finche' non ci si ricollega.
        log(f"{_label(serial)} non ha ancora dato il permesso: mi ricollego, così la TV lo chiede di nuovo")
        adb("disconnect", serial, timeout=10)
        time.sleep(1)
        state = None
    if state in (None, "offline"):
        _say(f"Mi collego a {_label(serial)}…", step="connect")
        _connect(serial)
        time.sleep(1)
        state = _devices().get(serial)
        log(f"Stato di {serial} dopo il collegamento: {state or 'non collegata'}", "dbg")
    if state == "device":
        log(f"Collegata a {_label(serial)}: il permesso c'era già", "ok")
        return True
    start = time.time()
    if state == "unauthorized":
        _say("In attesa di conferma sulla TV: sullo schermo della TV compare «Consentire il debug?» "
             "(su alcune TV solo dalla schermata Home: premi il tasto Home del telecomando). "
             "Metti la spunta su «Consenti sempre da questo computer» e premi «OK».",
             "wait", step="confirm")
    next_note = start + 15
    retries = 0
    while state == "unauthorized" and time.time() - start < wait_s:
        for _ in range(4):
            time.sleep(0.5)
            _check_cancel()
        was, state = state, _devices().get(serial)
        if state != was:
            log(f"Stato di {serial}: {was} → {state or 'non collegata'}", "dbg")
        if state in (None, "offline") and retries < 3:
            # Collegamento perso mentre si aspettava (TV in standby, adb riavviato...): un
            # «OK» premuto adesso andrebbe perso, quindi ci si ricollega e la TV lo richiede
            retries += 1
            log(f"Collegamento con {_label(serial)} perso durante l'attesa: mi ricollego "
                f"(tentativo {retries} di 3), la TV ripropone la richiesta", "wait")
            try:
                _connect(serial)
                time.sleep(1)
                state = _devices().get(serial)
                log(f"Stato di {serial} dopo il nuovo collegamento: {state or 'non collegata'}", "dbg")
            except RuntimeError as ex:
                log(str(ex), "dbg")
        if state == "unauthorized" and time.time() >= next_note:
            left = int(wait_s - (time.time() - start))
            _say(f"Ancora in attesa della conferma sulla TV (aspetto altri {left} secondi)… "
                 "Non compare niente? Premi il tasto Home del telecomando: su alcune TV la richiesta "
                 "si vede solo dalla schermata Home.", "wait", step="confirm")
            next_note += 15
    if state == "device":
        log("Permesso dato: la TV è collegata", "ok")
        return True
    if state == "unauthorized":
        raise RuntimeError(f"Sulla TV non è stato dato il permesso in {wait_s} secondi (adb la vede ancora "
                           "«unauthorized»). Se la richiesta «Consentire il debug?» non è comparsa: porta la TV "
                           "sulla schermata Home (tasto Home del telecomando) e riprova: su alcune TV, per esempio "
                           "TCL, compare solo lì. Se ancora niente: sulla TV, in Opzioni sviluppatore, scegli "
                           "«Revoca autorizzazioni debug USB», spegni e riaccendi «Debug USB» e riprova, oppure "
                           "usa «Debug wireless» con il codice di associazione (passi qui sotto)")
    raise RuntimeError(f"{_label(serial)} non risponde (stato per adb: {state or 'non collegata'}): "
                       "è accesa e con il debug attivo?")


def _connect(target):
    code, out = adb("connect", target, timeout=15)
    if "failed to authenticate" in out:
        pass        # adb 34: la TV c'e' ma non ha ancora dato il permesso, la richiesta e' sullo schermo
    elif "connected" not in out or "cannot" in out or "failed" in out:
        if "refused" in out:
            why = "la TV risponde ma il debug è spento"
        elif "timed out" in out or "No route" in out or code == 124:
            why = "nessuna risposta: la TV è spenta, in un'altra rete o l'indirizzo è sbagliato"
        else:
            why = out.splitlines()[-1] if out else "nessuna risposta"
        raise RuntimeError(f"Non riesco a collegarmi a {target}: {why}")
    ip = target.split(":")[0]
    if ip not in _state["found"]:
        _set(found=_state["found"] + [ip])


def _connect_job(target):
    _connect_and_wait(target)
    _set(step="install")
    log("Ora premi «Installa l'app» qui sotto", "ok")


def _pair(target, code_):
    _say(f"Associo la TV {target} con il codice…", step="connect")
    code, out = adb("pair", target, code_, timeout=20)
    if "Successfully paired" in out:
        log("Associata. Ora scrivi l'indirizzo:porta di «Debug wireless» e premi Collega", "ok")
    else:
        raise RuntimeError("Associazione non riuscita: controlla indirizzo, porta e codice mostrati sulla TV "
                           f"({out.splitlines()[-1] if out else 'nessuna risposta'})")


def _install(serial, replace):
    apk = _hooks["apk"]
    if not apk or not apk.is_file():
        raise RuntimeError("Sul PC non c'è ancora l'APK: aspetta il prossimo aggiornamento o avvia «Compila APK.bat»")
    log(f"Installo BunkerPlex su {_label(serial)}")
    _connect_and_wait(serial)
    if replace:
        _say("Tolgo dalla TV la BunkerPlex con la firma diversa…", step="install")
        adb("-s", serial, "uninstall", PACKAGE, timeout=60)
    before = _version_of(serial, PACKAGE)
    mb = apk.stat().st_size / 1_048_576
    _say(f"Copio l'app sulla TV ({mb:.0f} MB) e la installo: di solito meno di un minuto…", step="install")
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
    log("App aggiornata" if before else "App installata", "ok")
    if _version_of(serial, OLD_PACKAGE) is not None:
        _say("Tolgo dalla TV la vecchia app (quella di prima di BunkerPlex)…")
        adb("-s", serial, "uninstall", OLD_PACKAGE, timeout=60)
    _say("Apro BunkerPlex sulla TV…")
    for category in ("android.intent.category.LEANBACK_LAUNCHER", "android.intent.category.LAUNCHER"):
        c, o = adb("-s", serial, "shell", "monkey", "-p", PACKAGE, "-c", category, "1", timeout=20)
        if c == 0 and "No activities found" not in o:
            break
    _set(step="done")
    log(f"Fatto: BunkerPlex è aperta su {_label(serial)} e trova il server da sola", "ok")


PHASES = {"scan": "Cerca le TV", "connect": "Collega", "pair": "Associa con codice",
          "install": "Installa l'app"}


def _run(phase, target, fn, *args):
    if not _lock.acquire(blocking=False):
        raise HTTPException(409, "Sto già lavorando su una TV: aspetta un attimo")

    def job():
        try:
            _set(phase=phase, target=target, error="", message="")
            log(f"{PHASES.get(phase, phase)}{' · ' + target if target else ''}", "sep")
            fn(*args)
            _set(message="", done_at=time.time(), last=phase)
        except Interrotto:
            _set(error="", message="", done_at=time.time(), last=phase, step="")
            log("Interrotto: puoi riprovare quando vuoi", "err")
        except Exception as ex:
            err = str(ex) or repr(ex)
            if not isinstance(ex, (RuntimeError, HTTPException)):
                log("Errore imprevisto:\n" + traceback.format_exc(), "dbg")
                err = f"Errore imprevisto ({type(ex).__name__}: {ex}): copia il log e mandalo a chi ti aiuta"
            _set(error=err, message="", done_at=time.time(), last=phase)
            log("Sulla TV c'è una BunkerPlex con firma diversa: va tolta prima (pulsante qui sotto)"
                if err == "INCOMPATIBILE" else err, "err")
        finally:
            _set(phase="")
            _lock.release()

    _cancel.clear()
    th = threading.Thread(target=job, daemon=True, name=f"tv-{phase}")
    _job["thread"] = th
    th.start()


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
           "scanned_at": _state["scanned_at"], "adb": bool(_adb_path()), "step": _state["step"],
           "log": list(_log)[-80:],
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
    _run("connect", _target(body), _connect_job, _target(body))
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


def _report(host_header=""):
    lines = ["BunkerPlex · registro dell'installazione sulla TV",
             f"Copiato il {time.strftime('%Y-%m-%d %H:%M:%S')} (ora del server, fuso {time.strftime('%Z %z')}: "
             "è anche l'ora delle righe qui sotto)"]
    try:
        code, name = _hooks["apk_version"]()
        apk = _hooks["apk"]
        size = f", {apk.stat().st_size / 1_048_576:.1f} MB" if apk and apk.is_file() else ", file assente"
        lines.append(f"Server {_hooks['server_version'] or '?'} · app per la TV sul PC: "
                     f"{name or '?'} (versionCode {code or '?'}{size})")
        pc = _state["pc"] or _hooks["lan_ip"](host_header)
        net = _subnet(pc) if pc else None
        lines.append(f"PC nella rete di casa: {pc or 'sconosciuto'}" + (f" (cerco in {net})" if net else "")
                     + f" · {platform.system()} {platform.machine()}")
        if _adb_path():
            _, ver = adb("version", timeout=5)
            lines.append("adb: " + " · ".join(x.strip() for x in ver.splitlines()[:2]))
            key = DATA / "home" / ".android" / "adbkey.pub"
            lines.append("Chiave adb: " + (
                f"c'è (creata il {time.strftime('%Y-%m-%d %H:%M', time.localtime(key.stat().st_mtime))})"
                if key.is_file() else "non ancora creata"))
            devs = _devices()
            lines.append("Dispositivi per adb adesso: " + (", ".join(f"{k} {v}" for k, v in devs.items()) or "nessuno"))
        else:
            lines.append("adb: non ancora presente")
        lines.append(f"Stato: {_state['phase'] or 'fermo'} · passo {_state['step'] or '-'}"
                     + (f" · ultimo errore: {_state['error']}" if _state["error"] else ""))
    except Exception as ex:
        lines.append(f"(intestazione incompleta: {ex!r})")
    lines.append("─" * 60)
    try:
        body = LOG_FILE.read_text(encoding="utf-8", errors="replace").splitlines()[-400:]
    except OSError:
        body = []
    if not body:
        body = [f"{time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(x['at']))} [{x['kind']}] {x['text']}"
                for x in list(_log)]
    return "\n".join(lines + (body or ["(ancora niente)"])) + "\n"


@router.get("/log")
def tv_log(request: Request):
    return {"text": _report(request.headers.get("host", ""))}


@router.post("/cancel")
def tv_cancel():
    if _state["phase"]:
        _cancel.set()
        log("Interrompo…", "wait")
    return _status()


@router.post("/install")
async def tv_install(request: Request):
    body = await request.json()
    target = _target(body)
    _run("install", target, _install, target, bool(body.get("replace")))
    return _status()
