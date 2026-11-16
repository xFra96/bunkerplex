"""Aggiornamento di BunkerPlex da GitHub, fatto dal server stesso.

Fa lo stesso lavoro di strumenti/Aggiorna.ps1, ma da dentro Docker: cosi' il
server controlla da solo ogni 12 ore e l'aggiornamento si puo' lanciare anche
dalla TV. La cartella di BunkerPlex e' montata in /programma: i file nuovi
vengono scritti li' e il server si riavvia per usarli.

Regole uguali allo script del PC (con cui divide strumenti/versione.json):
  - mai toccati catalogo, .env, chiave di firma, token;
  - si tolgono solo i file arrivati da un aggiornamento precedente;
  - la copia di sviluppo (cartella .git) non viene sovrascritta: li' i file
    del programma li gestisce git, da qui arriva solo l'app per la TV.

L'accesso al repository privato viene dal file strumenti/github-token.txt
(un token di sola lettura). Solo libreria standard: niente dipendenze.
"""
import hashlib
import json
import os
import shutil
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

PROGRAM = Path(os.environ.get("PROGRAM_DIR", "/programma"))
TOOLS = PROGRAM / "strumenti"
CFG_FILE = TOOLS / "aggiornamenti.json"
STATE_FILE = TOOLS / "versione.json"
TOKEN_FILE = TOOLS / "github-token.txt"
APK_FILE = PROGRAM / "apk" / "FrenkPlex.apk"
try:
    CHECK_HOURS = max(1.0, float(os.environ.get("UPDATE_CHECK_HOURS", "12") or 12))
except ValueError:
    CHECK_HOURS = 12.0

# I percorsi in versione.json sono scritti alla Windows (li legge anche Aggiorna.ps1)
PROTECTED_DIRS = ("data", "apk", ".git", "android\\out", "android\\keystore")
PROTECTED_FILES = {".env", "docker-compose.override.yml",
                   "strumenti\\github-token.txt", "strumenti\\versione.json"}
# Se cambiano questi non basta riavviare il server: va rilanciato "Avvia BunkerPlex.bat"
NEEDS_HOST = {"server\\Dockerfile", "server\\requirements.txt", "docker-compose.yml"}
BUSY_SECONDS = 10 * 60        # un film in corso: l'aggiornamento automatico aspetta

_op = threading.Lock()        # un'operazione alla volta (controllo o installazione)
_guard = threading.Lock()
_status = {"phase": "", "access": None, "checked_at": 0, "code": False, "apk": False,
           "error": "", "result": "", "remote": ""}
_asset = None
_last_play = 0.0


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def _set(**values):
    with _guard:
        _status.update(values)


def playing():
    """Chiamata dal server a ogni richiesta di video: qualcuno sta guardando."""
    global _last_play
    _last_play = time.time()


def busy():
    return time.time() - _last_play < BUSY_SECONDS


def _config():
    try:
        cfg = json.loads(CFG_FILE.read_text("utf-8-sig"))
        repo = str(cfg.get("repo") or "").strip()
        if repo.count("/") != 1 or any(c.isspace() for c in repo):
            return None
        return {"repo": repo, "branch": str(cfg.get("branch") or "main").strip(),
                "apk_release": str(cfg.get("apk_release") or "app-tv").strip()}
    except Exception:
        return None


def _state():
    try:
        return json.loads(STATE_FILE.read_text("utf-8-sig"))
    except Exception:
        return {}


def _dev_copy():
    return (PROGRAM / ".git").exists()


def token():
    env = os.environ.get("FRENKPLEX_GITHUB_TOKEN", "").strip()
    if env:
        return env
    try:
        for line in TOKEN_FILE.read_text("utf-8-sig").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                return line
    except OSError:
        pass
    return ""


def _fetch(url, accept, tok, timeout=30, dest=None):
    """Scarica da GitHub. I rimandi verso altri server (pacchetti, allegati) si
    seguono a mano e senza token: il loro indirizzo e' gia' firmato."""
    headers = {"Accept": accept, "User-Agent": "BunkerPlex-updater",
               "X-GitHub-Api-Version": "2022-11-28"}
    if tok:
        headers["Authorization"] = "Bearer " + tok
    try:
        resp = _opener.open(urllib.request.Request(url, headers=headers), timeout=timeout)
    except urllib.error.HTTPError as ex:
        where = ex.headers.get("Location") if ex.code in (301, 302, 303, 307, 308) else None
        if not where:
            raise
        plain = {"User-Agent": "BunkerPlex-updater"}
        if urllib.parse.urlsplit(where).hostname == "api.github.com":
            plain = headers
        resp = urllib.request.urlopen(urllib.request.Request(where, headers=plain), timeout=timeout)
    with resp:
        if dest is None:
            return resp.read()
        with open(dest, "wb") as out:
            shutil.copyfileobj(resp, out, 1 << 20)
    return None


def _api(cfg, path, tok, accept="application/vnd.github+json", **kw):
    return _fetch(f"https://api.github.com/repos/{cfg['repo']}/{path}", accept, tok, **kw)


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _apk_asset(cfg, tok):
    """L'APK allegato alla release, se e' piu' nuovo di quello sul disco."""
    try:
        release = json.loads(_api(cfg, f"releases/tags/{cfg['apk_release']}", tok))
    except Exception:
        return None
    asset = next((a for a in release.get("assets", []) if a.get("name") == "FrenkPlex.apk"), None)
    if not asset:
        return None
    if APK_FILE.is_file():
        st = APK_FILE.stat()
        try:
            when = datetime.fromisoformat(str(asset.get("updated_at", "")).replace("Z", "+00:00"))
            if when.tzinfo is None:
                when = when.replace(tzinfo=timezone.utc)
            # Un APK compilato qui dopo l'ultima pubblicazione e' piu' nuovo: resta lui
            if st.st_mtime >= when.timestamp():
                return None
        except ValueError:
            pass
        digest = str(asset.get("digest") or "")
        if digest.startswith("sha256:"):
            if _sha256(APK_FILE).lower() == digest[7:].lower():
                return None
        elif st.st_size == asset.get("size"):
            return None
    return asset


def _check():
    global _asset
    cfg = _config()
    if not cfg or not TOOLS.is_dir():
        _set(access=None, code=False, apk=False, error="", checked_at=time.time())
        return None
    tok = token()
    try:
        sha = _api(cfg, f"commits/{cfg['branch']}", tok, "application/vnd.github.sha",
                   timeout=20).decode("ascii", "replace").strip()
    except urllib.error.HTTPError as ex:
        if ex.code in (401, 403, 404):
            _set(access=False, code=False, apk=False, error="", checked_at=time.time())
        else:
            _set(error=f"GitHub ha risposto con errore {ex.code}", checked_at=time.time())
        return None
    except Exception:
        _set(error="GitHub non raggiungibile: il PC è collegato a Internet?", checked_at=time.time())
        return None
    if len(sha) != 40 or any(c not in "0123456789abcdef" for c in sha):
        _set(error="Risposta di GitHub non valida", checked_at=time.time())
        return None
    _asset = _apk_asset(cfg, tok)
    code = (not _dev_copy()) and _state().get("commit") != sha
    _set(access=True, code=code, apk=bool(_asset), error="", remote=sha, checked_at=time.time())
    return cfg, tok, sha


def check():
    """Controlla su GitHub se c'e' qualcosa di nuovo (non installa niente)."""
    if not _op.acquire(blocking=False):
        return
    try:
        _set(phase="checking")
        _check()
    except Exception as ex:
        _set(error=f"Controllo non riuscito: {ex}")
    finally:
        _set(phase="")
        _op.release()


def _protected(rel):
    r = rel.replace("/", "\\")
    if not r or r.startswith("\\") or ":" in r or ".." in r.split("\\"):
        return True
    if any(r == d or r.startswith(d + "\\") for d in PROTECTED_DIRS):
        return True
    return r in PROTECTED_FILES


def _same(a, b):
    try:
        return a.stat().st_size == b.stat().st_size and _sha256(a) == _sha256(b)
    except OSError:
        return False


def _install_files(cfg, tok, sha):
    """Scarica il pacchetto del programma e copia i file cambiati. Restituisce
    l'elenco (alla Windows) dei file nuovi, cambiati o tolti."""
    old = _state()
    touched = []
    with tempfile.TemporaryDirectory(prefix="frenkplex-") as tmp:
        tmp = Path(tmp)
        _api(cfg, f"zipball/{sha}", tok, timeout=120, dest=tmp / "p.zip")
        with zipfile.ZipFile(tmp / "p.zip") as z:
            names = [n for n in z.namelist() if not n.endswith("/")]
            if not names:
                raise RuntimeError("pacchetto vuoto")
            top = names[0].split("/", 1)[0] + "/"
            if not all(n.startswith(top) for n in names) or top + "strumenti/Aggiorna.ps1" not in names:
                raise RuntimeError("il pacchetto scaricato non sembra BunkerPlex")
            files = []
            for name in names:
                rel = name[len(top):].replace("/", "\\")
                if _protected(rel):
                    continue
                files.append(rel)
                fresh = tmp / "f"
                with z.open(name) as src, open(fresh, "wb") as out:
                    shutil.copyfileobj(src, out, 1 << 20)
                dest = PROGRAM / rel.replace("\\", "/")
                if dest.is_file() and _same(fresh, dest):
                    continue
                dest.parent.mkdir(parents=True, exist_ok=True)
                # Prima accanto, poi lo scambio: niente file a meta' se il disco si stacca
                part = dest.with_name(dest.name + ".nuovo")
                shutil.copyfile(fresh, part)
                os.replace(part, dest)
                touched.append(rel)
    for gone in old.get("files") or []:
        gone = str(gone)
        if gone in files or _protected(gone):
            continue
        path = PROGRAM / gone.replace("\\", "/")
        if path.is_file():
            try:
                path.unlink()
                touched.append(gone)
            except OSError:
                pass
    state = {"commit": sha, "date": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"), "files": files}
    part = STATE_FILE.with_name(STATE_FILE.name + ".nuovo")
    part.write_text(json.dumps(state, indent=1), "utf-8")
    os.replace(part, STATE_FILE)
    return touched


def _install_apk(cfg, tok, asset):
    APK_FILE.parent.mkdir(parents=True, exist_ok=True)
    part = APK_FILE.with_name(APK_FILE.name + ".nuovo")
    try:
        _api(cfg, f"releases/assets/{asset['id']}", tok, "application/octet-stream",
             timeout=300, dest=part)
        with open(part, "rb") as f:
            head = f.read(2)
        if part.stat().st_size != asset.get("size") or head != b"PK":
            raise RuntimeError("app per la TV scaricata a metà")
        os.replace(part, APK_FILE)
    finally:
        part.unlink(missing_ok=True)


def _restart():
    # Docker riaccende il contenitore da solo (restart: unless-stopped) con i file nuovi
    time.sleep(2.5)
    os._exit(0)


def _install():
    try:
        _set(phase="installing", result="", error="")
        found = _check()
        if not found:
            if not _status["error"]:
                _set(error="Questo PC non ha l'accesso al repository degli aggiornamenti")
            return
        cfg, tok, sha = found
        touched = []
        if _status["code"]:
            touched = _install_files(cfg, tok, sha)
        if _asset:
            _install_apk(cfg, tok, _asset)
        _set(code=False, apk=False, checked_at=time.time())
        if any(t in NEEDS_HOST for t in touched):
            _set(phase="host", result="host")
            return
        if any(t.startswith("server\\") for t in touched):
            _set(phase="restarting", result="ok")
            threading.Thread(target=_restart, daemon=True).start()
            return
        _set(result="ok")
    except Exception as ex:
        print("Aggiornamento non riuscito:", repr(ex), flush=True)
        _set(error=f"{ex}" or "errore sconosciuto")
    finally:
        if _status["phase"] == "installing":
            _set(phase="")
        _op.release()


def start_install():
    """Installa in sottofondo cio' che c'e' di nuovo. False se e' gia' in corso."""
    if _status["phase"] in ("restarting", "host") or not _op.acquire(blocking=False):
        return False
    threading.Thread(target=_install, daemon=True).start()
    return True


def set_token(tok):
    """Prova un token di GitHub e, se da' accesso al repository, lo salva sul disco."""
    cfg = _config()
    tok = (tok or "").strip()
    if not cfg or not tok or len(tok) > 400 or any(c.isspace() for c in tok):
        return False
    try:
        _api(cfg, f"commits/{cfg['branch']}", tok, "application/vnd.github.sha", timeout=20)
    except Exception:
        return False
    TOKEN_FILE.write_text(tok + "\r\n", "utf-8")
    return True


def available():
    return bool(_status["code"] or _status["apk"])


def snapshot():
    """Lo stato da mostrare nell'interfaccia (mai il token)."""
    with _guard:
        out = dict(_status)
    cfg = _config()
    state = _state()
    out.update({
        "enabled": bool(cfg) and TOOLS.is_dir(),
        "repo": cfg["repo"] if cfg else "",
        "dev_copy": _dev_copy(),
        "installed": str(state.get("commit") or "")[:7],
        "installed_at": str(state.get("date") or ""),
        "remote": out["remote"][:7],
        "has_token": bool(token()),
        "available": bool(out["code"] or out["apk"]),
        "check_hours": CHECK_HOURS,
    })
    return out


def loop(auto):
    """Controllo periodico. 'auto' dice se installare da soli quando nessuno guarda."""
    time.sleep(90)
    while True:
        wait = CHECK_HOURS * 3600
        try:
            if _status["phase"] != "host":
                check()
                if available() and auto():
                    if busy():
                        wait = 15 * 60      # c'e' un film in corso: si riprova tra poco
                    else:
                        start_install()
        except Exception as ex:
            print("Controllo aggiornamenti non riuscito:", repr(ex), flush=True)
        time.sleep(wait)
