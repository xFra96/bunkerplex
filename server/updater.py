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

Se sul PC gira l'aiutante (strumenti/Agente.ps1, lo accende "Installa
BunkerPlex") l'installazione la fa lui: il server gli lascia una
richiesta in strumenti/richiesta-aggiornamento.json e lui scarica le novita',
aggiorna anche la copia di sviluppo con git e, se servono, ricostruisce
l'immagine Docker (pacchetti nuovi, Dockerfile, docker-compose.yml) e riaccende
il contenitore. Senza aiutante il server si aggiorna da solo come sopra.

L'accesso al repository privato viene dal file strumenti/github-token.txt
(un token di sola lettura); senza token si passa dal servizio account
(server/cloud.json), che ha il suo. Solo libreria standard: niente dipendenze.
"""
import hashlib
import json
import os
import re
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
# Copie delle app per la prima installazione (vedi refresh_apps): app Android
# (release app-v1.0...) e app TV nativa (tv-v1.0...), ognuna con la sua linea
APK_FILE = PROGRAM / "apk" / "BunkerPlex.apk"
TV_APK_FILE = PROGRAM / "apk" / "BunkerPlexTV.apk"
AGENT_FILE = TOOLS / "agente.json"
REQUEST_FILE = TOOLS / "richiesta-aggiornamento.json"
RESULT_FILE = TOOLS / "esito-aggiornamento.json"
AGENT_FRESH = 120             # secondi: l'aiutante scrive "ci sono" ogni 30
AGENT_PICKUP = 60             # se in questo tempo non prende la richiesta, non c'e'
AGENT_TIMEOUT = 45 * 60       # una ricostruzione di Docker da zero ci mette un po'
try:
    CHECK_HOURS = max(1.0, float(os.environ.get("UPDATE_CHECK_HOURS", "12") or 12))
except ValueError:
    CHECK_HOURS = 12.0

# I percorsi in versione.json sono scritti alla Windows (li legge anche Aggiorna.ps1)
PROTECTED_DIRS = ("data", "apk", ".git", "android\\out", "android\\keystore")
PROTECTED_FILES = {".env", "docker-compose.override.yml",
                   "strumenti\\github-token.txt", "strumenti\\versione.json",
                   "strumenti\\agente.json", "strumenti\\richiesta-aggiornamento.json",
                   "strumenti\\esito-aggiornamento.json", "strumenti\\aggiornamento.log",
                   "strumenti\\richiesta-cestino.json", "strumenti\\esito-cestino.json"}
# Se cambiano questi non basta riavviare il server: va rilanciato "Installa BunkerPlex"
NEEDS_HOST = {"server\\Dockerfile", "server\\requirements.txt", "docker-compose.yml"}
BUSY_SECONDS = 10 * 60        # un film in corso: l'aggiornamento automatico aspetta

_op = threading.Lock()        # un'operazione alla volta (controllo o installazione)
_guard = threading.Lock()
_status = {"phase": "", "access": None, "checked_at": 0, "code": False,
           "docker": False, "error": "", "result": "", "remote": ""}
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


def _read_json(path):
    try:
        return json.loads(path.read_text("utf-8-sig"))
    except Exception:
        return None


def _write_json(path, value):
    part = path.with_name(path.name + ".nuovo")
    part.write_text(json.dumps(value), "utf-8")
    os.replace(part, path)


def fingerprint():
    """La stessa impronta di strumenti/Impronta.ps1: riassume i file che decidono
    come gira il contenitore (server/ e docker-compose.yml)."""
    lines = []
    paths = []
    server = PROGRAM / "server"
    for folder, dirs, names in os.walk(server):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for n in names:
            if n.endswith(".pyc") or n.endswith(".nuovo"):
                continue
            paths.append(Path(folder) / n)
    compose = PROGRAM / "docker-compose.yml"
    if compose.is_file():
        paths.append(compose)
    for p in paths:
        try:
            lines.append(p.relative_to(PROGRAM).as_posix() + ":" + _sha256(p).upper())
        except OSError:
            pass
    lines.sort()
    return hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()[:16]


def stale():
    """True se il contenitore e' stato acceso con file diversi da quelli di
    adesso (es. pacchetti o Dockerfile nuovi): va ricostruito dall'aiutante."""
    running = os.environ.get("BUNKERPLEX_BUILD", "").strip()
    if not running or not (PROGRAM / "server").is_dir():
        return False     # acceso senza l'installazione di Windows (es. Mac): non si sa
    try:
        return fingerprint() != running
    except Exception:
        return False


def agent():
    """True se sul PC e' acceso l'aiutante che puo' ricostruire Docker."""
    a = _read_json(AGENT_FILE)
    try:
        return abs(time.time() - float(a.get("at") or 0)) < AGENT_FRESH
    except (AttributeError, TypeError, ValueError):
        return False


def _git_commits(branch):
    """Copia di sviluppo: i commit di HEAD e di origin/<branch>, letti dalla
    cartella .git senza bisogno di git (il server non ce l'ha)."""
    g = PROGRAM / ".git"

    def resolve(ref):
        try:
            return (g / ref).read_text("ascii").strip()
        except OSError:
            pass
        try:
            for line in (g / "packed-refs").read_text("ascii").splitlines():
                parts = line.split()
                if len(parts) == 2 and parts[1] == ref:
                    return parts[0]
        except OSError:
            pass
        return ""

    try:
        head = (g / "HEAD").read_text("ascii").strip()
    except OSError:
        return set()
    if head.startswith("ref: "):
        head = resolve(head[5:].strip())
    known = {c for c in (head, resolve(f"refs/remotes/origin/{branch}")) if c}
    # Anche i commit su cui questa copia e' gia' passata (storia di HEAD e di
    # origin): GitHub per un minuto dopo un push puo' rispondere col commit di
    # prima, che qui e' gia' vecchio e non e' un aggiornamento.
    for log in (g / "logs" / "HEAD", g / "logs" / "refs" / "remotes" / "origin" / branch):
        try:
            for line in log.read_text("utf-8", "replace").splitlines():
                parts = line.split(" ", 2)
                if len(parts) >= 2:
                    known.update(p for p in parts[:2] if len(p) == 40)
        except OSError:
            pass
    return known


def token():
    env = os.environ.get("BUNKERPLEX_GITHUB_TOKEN", "").strip()
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


def current_commit():
    """Il commit con cui sta girando il programma: quello della copia di sviluppo
    (git) oppure quello installato dall'ultimo aggiornamento."""
    g = PROGRAM / ".git"
    if g.is_dir():
        try:
            head = (g / "HEAD").read_text("ascii").strip()
            if not head.startswith("ref: "):
                return head
            ref = head[5:].strip()
            try:
                return (g / ref).read_text("ascii").strip()
            except OSError:
                for line in (g / "packed-refs").read_text("ascii").splitlines():
                    parts = line.split()
                    if len(parts) == 2 and parts[1] == ref:
                        return parts[0]
        except OSError:
            pass
        return ""
    return str(_state().get("commit") or "")


# Numero di versione del programma: il tag v1.2 (v1.2.3) che il giro su GitHub
# mette su ogni commit di main; fino a novembre 2026 era la data, vAAAA.MM.GG(.N).
# L'app ha numeri suoi (tag app-v1.2), qui non contano. Si cerca
# nello zip installato, poi nei tag della copia di sviluppo, poi su GitHub; se il
# tag non c'e' ancora (il giro di GitHub dura qualche minuto) si riprova dopo.
_release = {"commit": "", "version": "", "tried": 0.0}
RELEASE_RETRY = 15 * 60


def _local_tag(sha):
    g = PROGRAM / ".git"
    found = []
    try:
        for f in (g / "refs" / "tags").glob("v*"):
            if _is_release(f.name) and f.read_text("ascii").strip() == sha:
                found.append(f.name)
    except OSError:
        pass
    try:
        for line in (g / "packed-refs").read_text("ascii").splitlines():
            parts = line.split()
            if len(parts) == 2 and parts[0] == sha and parts[1].startswith("refs/tags/") \
                    and _is_release(parts[1][10:]):
                found.append(parts[1][10:])
    except OSError:
        pass
    return _newest(found)


def _is_release(tag):
    parts = tag[1:].split(".")
    return tag.startswith("v") and len(parts) >= 2 and all(p.isdigit() for p in parts)


def _newest(tags):
    # Le versioni a numero (1.2) vengono dopo quelle a data (2026.11.23),
    # anche se come numero sono piu' piccole
    def key(t):
        nums = [int(x) if x.isdigit() else 0 for x in t[1:].split(".")]
        return (nums[0] < 1000, nums)
    return max(tags, key=key) if tags else ""


def _remote_tag(sha):
    cfg = _config()
    if not cfg:
        return ""
    tok = token()
    for page in (1, 2, 3):
        data = json.loads(_api(cfg, f"tags?per_page=100&page={page}", tok, timeout=20))
        found = [t.get("name", "") for t in data
                 if (t.get("commit") or {}).get("sha") == sha and _is_release(str(t.get("name", "")))]
        if found:
            return _newest(found)
        if len(data) < 100:
            break
    return ""


def _resolve_release(sha):
    version = ""
    try:
        version = _local_tag(sha) or _remote_tag(sha)
    except Exception as ex:
        print("Numero di versione non letto da GitHub:", repr(ex), flush=True)
    with _guard:
        if _release["commit"] == sha and version:
            _release["version"] = version[1:]


def release():
    """Il numero di versione di questo server (es. 1.2), oppure "" se
    non e' ancora noto. Non aspetta mai la rete: la ricerca va in sottofondo."""
    sha = current_commit()
    if not sha:
        return ""
    with _guard:
        if _release["commit"] != sha:
            st = _state()
            known = str(st.get("version") or "") if st.get("commit") == sha else ""
            _release.update(commit=sha, version=known.lstrip("v"), tried=0.0)
        if _release["version"] or time.time() - _release["tried"] < RELEASE_RETRY:
            return _release["version"]
        _release["tried"] = time.time()
    threading.Thread(target=_resolve_release, args=(sha,), daemon=True).start()
    return ""


def changes(old, new, limit=20):
    """Le novita' tra due commit, come elenco di frasi (dai messaggi dei commit)."""
    cfg = _config()
    if not cfg or not old or not new:
        return []
    data = json.loads(_api(cfg, f"compare/{old}...{new}", token(), timeout=20))
    out = []
    for c in reversed(data.get("commits") or []):         # dalla piu' recente
        if len(c.get("parents") or []) > 1:
            continue
        line = str((c.get("commit") or {}).get("message") or "").split("\n", 1)[0].strip()
        if line and line not in out:
            out.append(line)
    return out[:limit]


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


def _cloud():
    try:
        from accounts import cloud_url
        return cloud_url()
    except Exception:
        return ""


def _api(cfg, path, tok, accept="application/vnd.github+json", **kw):
    # Senza un token proprio si passa dal servizio account, che ha l'accesso al
    # repository privato: cosi' i PC degli amici si aggiornano senza fare niente.
    base = _cloud() if not tok else ""
    if base:
        return _fetch(f"{base}/aggiornamenti/{path}", accept, "", **kw)
    return _fetch(f"https://api.github.com/repos/{cfg['repo']}/{path}", accept, tok, **kw)


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _newer(asset, path):
    """L'asset della release, se e' piu' nuovo del file sul disco."""
    if not asset:
        return None
    if path.is_file():
        st = path.stat()
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
            if _sha256(path).lower() == digest[7:].lower():
                return None
        elif st.st_size == asset.get("size"):
            return None
    return asset


def _check():
    cfg = _config()
    if not cfg or not TOOLS.is_dir():
        _set(access=None, code=False, error="", checked_at=time.time())
        return None
    tok = token()
    try:
        sha = _api(cfg, f"commits/{cfg['branch']}", tok, "application/vnd.github.sha",
                   timeout=20).decode("ascii", "replace").strip()
    except urllib.error.HTTPError as ex:
        if ex.code in (401, 403, 404):
            _set(access=False, code=False, error="", checked_at=time.time())
        else:
            _set(error=f"GitHub ha risposto con errore {ex.code}", checked_at=time.time())
        return None
    except Exception:
        _set(error="GitHub non raggiungibile: il PC è collegato a Internet?", checked_at=time.time())
        return None
    if len(sha) != 40 or any(c not in "0123456789abcdef" for c in sha):
        _set(error="Risposta di GitHub non valida", checked_at=time.time())
        return None
    if _dev_copy():
        # La copia di sviluppo la aggiorna git, cioe' l'aiutante sul PC. Se il
        # commit di GitHub e' gia' qui (anche solo scaricato) non c'e' niente da fare:
        # un commit locale non ancora pubblicato non e' un aggiornamento.
        code = agent() and sha not in _git_commits(cfg["branch"])
    else:
        code = _state().get("commit") != sha
    # Docker da riallineare: conta solo se c'e' l'aiutante, l'unico che puo' farlo
    docker = agent() and stale()
    _set(access=True, code=code, docker=docker, error="", remote=sha,
         checked_at=time.time())
    return cfg, tok, sha


# ---- Avviso di release ----------------------------------------------------------
# Il giro su GitHub che pubblica la release lo annuncia al servizio account
# (POST /release); il server lo legge nella risposta alla presenza (ogni 3 minuti)
# e chiama notify(): se il commit e' nuovo, controlla e installa subito. Finche'
# gli avvisi arrivano non c'e' nessun controllo a intervalli; se smettono (niente
# account collegato, niente Internet) torna il controllo ogni CHECK_HOURS.
PUSH_FRESH = 3600             # secondi: oltre, gli avvisi non arrivano piu'
_push = {"at": 0.0, "commit": "", "version": ""}
_wake = threading.Event()


def notify(commit, version=""):
    """Il servizio account dice qual e' l'ultima release del server."""
    if not re.fullmatch(r"[0-9a-f]{40}", str(commit or "")):
        return
    _push["at"] = time.time()
    if commit == _push["commit"]:
        return
    _push.update(commit=commit, version=str(version or ""))
    if commit != current_commit() and commit != _status.get("remote"):
        print("Nuova release annunciata:", version or commit[:7], flush=True)
        _wake.set()


def wake():
    """Ricontrolla subito (es. aggiornamento automatico appena riacceso)."""
    _wake.set()


def pushed():
    """True se gli avvisi di release arrivano (non serve controllare a intervalli)."""
    return time.time() - _push["at"] < PUSH_FRESH


def _sleep(wait, always=False):
    """Aspetta un avviso di release, o 'wait' secondi. Con gli avvisi attivi il
    tempo conta solo se always (riprovare dopo un video in corso o un errore)."""
    end = time.time() + wait
    while not _wake.wait(min(60.0, max(1.0, end - time.time()))):
        if time.time() >= end and (always or not pushed()):
            return
    _wake.clear()


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


def _keep_exec(path, mode):
    """Rende eseguibile il file se lo e' nello zip (su Windows non cambia niente)."""
    if mode & 0o111:
        try:
            os.chmod(path, path.stat().st_mode | 0o755)
        except OSError:
            pass


def _install_files(cfg, tok, sha):
    """Scarica il pacchetto del programma e copia i file cambiati. Restituisce
    l'elenco (alla Windows) dei file nuovi, cambiati o tolti."""
    old = _state()
    touched = []
    with tempfile.TemporaryDirectory(prefix="bunkerplex-") as tmp:
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
                # I permessi di esecuzione (es. "Installa BunkerPlex.command" sul
                # Mac) viaggiano nello zip: senza, il doppio clic non lo apre piu'
                mode = (z.getinfo(name).external_attr >> 16) & 0o777
                if dest.is_file() and _same(fresh, dest):
                    _keep_exec(dest, mode)
                    continue
                dest.parent.mkdir(parents=True, exist_ok=True)
                # Prima accanto, poi lo scambio: niente file a meta' se il disco si stacca
                part = dest.with_name(dest.name + ".nuovo")
                shutil.copyfile(fresh, part)
                _keep_exec(part, mode)
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


def _install_apk(cfg, tok, asset, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".nuovo")
    try:
        _api(cfg, f"releases/assets/{asset['id']}", tok, "application/octet-stream",
             timeout=300, dest=part)
        with open(part, "rb") as f:
            head = f.read(2)
        if part.stat().st_size != asset.get("size") or head != b"PK":
            raise RuntimeError("app per la TV scaricata a metà")
        os.replace(part, dest)
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
        _set(code=False, checked_at=time.time())
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


def _follow_agent(rid, started, asked):
    """Segue il lavoro dell'aiutante sul PC finche' non scrive l'esito. Se nel
    frattempo il contenitore viene ricostruito, questo server si spegne: quello
    nuovo riprende a seguirlo da resume()."""
    try:
        _set(phase="pc", result="", error="")
        seen = not asked
        lost = 0.0
        while time.time() - started < AGENT_TIMEOUT:
            r = _read_json(RESULT_FILE) or {}
            if str(r.get("id")) == rid:
                seen = True
                # L'aiutante "batte" anche mentre lavora: se tace, il PC e' stato
                # spento o il disco scollegato a meta'
                if r.get("phase") != "done" and not agent():
                    lost = lost or time.time()
                    if time.time() - lost > AGENT_FRESH:
                        _set(error="L'aiutante sul PC si è fermato a metà aggiornamento: "
                                   "rilancia «Installa BunkerPlex» sul computer")
                        return
                else:
                    lost = 0.0
                if r.get("phase") == "done":
                    if r.get("ok"):
                        _set(result="ok", code=False, docker=False)
                        try:
                            _check()
                        except Exception as ex:
                            print("Controllo dopo l'aiutante non riuscito:", repr(ex), flush=True)
                    else:
                        _set(error=str(r.get("message") or "Aggiornamento non riuscito sul PC"))
                    return
            elif asked and not seen and time.time() - started > AGENT_PICKUP and REQUEST_FILE.exists():
                REQUEST_FILE.unlink(missing_ok=True)
                _set(error="L'aiutante degli aggiornamenti sul PC non risponde: "
                           "rilancia «Installa BunkerPlex» sul computer")
                return
            time.sleep(2)
        _set(error="L'aggiornamento sul PC non ha finito in tempo: "
                   "guarda strumenti\\aggiornamento.log sul PC")
    except Exception as ex:
        print("Aggiornamento tramite l'aiutante non riuscito:", repr(ex), flush=True)
        _set(error=f"{ex}" or "errore sconosciuto")
    finally:
        if _status["phase"] == "pc":
            _set(phase="")
        _op.release()


def _ask_agent():
    rid = os.urandom(8).hex()
    try:
        _write_json(REQUEST_FILE, {"id": rid, "at": int(time.time())})
    except Exception as ex:
        _set(error=f"Non riesco a scrivere la richiesta per il PC: {ex}")
        _op.release()
        return
    _follow_agent(rid, time.time(), True)


def resume():
    """All'avvio del server: se l'aiutante sta ancora lavorando (ha appena
    riacceso questo contenitore) si continua a mostrare l'aggiornamento in corso."""
    r = _read_json(RESULT_FILE) or {}
    try:
        at = float(r.get("at") or 0)
    except (TypeError, ValueError):
        return
    if r.get("phase") != "running" or time.time() - at > AGENT_TIMEOUT or not r.get("id"):
        return
    if not _op.acquire(blocking=False):
        return
    threading.Thread(target=_follow_agent, args=(str(r["id"]), at, False), daemon=True).start()


def start_install():
    """Installa in sottofondo cio' che c'e' di nuovo. False se e' gia' in corso.
    Con l'aiutante acceso sul PC lo fa lui (Docker compreso), altrimenti il server."""
    if _status["phase"] in ("restarting", "host", "pc") or not _op.acquire(blocking=False):
        return False
    target = _ask_agent if agent() and TOOLS.is_dir() else _install
    threading.Thread(target=target, daemon=True).start()
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
    return bool(_status["code"] or _status["docker"])


# Le novita' delle ultime release del server (tag v1.2...), lette dalle note che
# il giro su GitHub scrive in ogni release: si mostrano nella pagina degli
# aggiornamenti. Si rileggono ogni mezz'ora, mai piu' di una lettura alla volta.
CHANGELOG_COUNT = 5
CHANGELOG_EVERY = 30 * 60
_changelog = {"at": 0.0, "items": []}
_changelog_lock = threading.Lock()


def _release_lines(body):
    """Le righe di «Novita'» di una release, senza autore, aree e link al commit."""
    out = []
    for line in str(body or "").splitlines():
        line = line.strip()
        if not line.startswith("- "):
            continue
        line = line[2:].split(" — _", 1)[0]
        line = line.split(" ([", 1)[0].strip()
        while line.endswith(")") and " (#" in line:          # (#51): il numero della PR
            line = line[:line.rindex(" (#")].rstrip()
        if line and line not in out:
            out.append(line)
    return out[:12]


def _read_changelog():
    cfg = _config()
    if not cfg:
        return []
    data = json.loads(_api(cfg, "releases?per_page=40", token(), timeout=15))
    rels = {}
    for r in data if isinstance(data, list) else []:
        tag = str(r.get("tag_name") or "")
        if r.get("draft") or not _is_release(tag):
            continue
        rels[tag] = {"version": tag[1:], "date": str(r.get("published_at") or "")[:10],
                     "changes": _release_lines(r.get("body"))}
    tags = list(rels)
    out = []
    while tags and len(out) < CHANGELOG_COUNT:
        t = _newest(tags)
        tags.remove(t)
        out.append(rels[t])
    return out


def changelog():
    """Le ultime 5 release del server (la piu' nuova prima). Mai un errore: se
    GitHub non risponde resta l'elenco di prima."""
    if time.time() - _changelog["at"] < CHANGELOG_EVERY:
        return _changelog["items"]
    if not _changelog_lock.acquire(blocking=False):
        return _changelog["items"]
    try:
        _changelog["items"] = _read_changelog()
        _changelog["at"] = time.time()
    except Exception as ex:
        _changelog["at"] = time.time() - CHANGELOG_EVERY + 120     # si riprova tra 2 minuti
        print("Novita' delle release non lette:", repr(ex), flush=True)
    finally:
        _changelog_lock.release()
    return _changelog["items"]


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
        "release": release(),
        "commit": current_commit()[:7],
        "installed_at": str(state.get("date") or ""),
        "remote": out["remote"][:7],
        "has_token": bool(token()),
        "agent": agent(),
        "available": bool(out["code"] or out["docker"]),
        "check_hours": CHECK_HOURS,
        "push": pushed(),
    })
    return out


# ---- Le app sul PC, solo per installarle la prima volta
# Le app si aggiornano da sole dalle loro release su GitHub (app Android: app-v*,
# app TV nativa: tv-v*), senza passare dal server. Il server ne tiene comunque
# una copia in apk\ per la prima installazione (QR per il telefono, installazione
# sulla TV dal PC) e per le app di prima, che si aggiornavano da qui. La copia si
# rinnova per conto suo, ogni 6 ore: non fa parte dell'aggiornamento del server.
APPS = (("app-v", "BunkerPlex.apk", APK_FILE), ("tv-v", "BunkerPlexTV.apk", TV_APK_FILE))
APPS_EVERY = 6 * 3600
_apps = {"at": 0.0}
_apps_lock = threading.Lock()


def _line_version(tag, prefix):
    """app-v1.2 -> (1, 2, 0) per la linea app-v; None per le altre."""
    m = re.match(re.escape(prefix) + r"(\d+)\.(\d+)(?:\.(\d+))?$", str(tag or ""))
    return (int(m[1]), int(m[2]), int(m[3] or 0)) if m else None


def latest_app_asset(cfg, tok, prefix, name):
    """L'APK dell'ultima release della linea (es. tv-v1.7), o None. Si parte dai
    tag della linea: le release del server escono a ogni modifica e
    spingerebbero quelle delle app fuori dall'elenco."""
    refs = json.loads(_api(cfg, f"git/matching-refs/tags/{prefix}", tok, timeout=20))
    tags = [str(r.get("ref") or "").removeprefix("refs/tags/") for r in refs if isinstance(r, dict)]
    tags = sorted((t for t in tags if _line_version(t, prefix)), key=lambda t: _line_version(t, prefix), reverse=True)
    for tag in tags[:3]:              # un tag appena creato puo' non avere ancora la release
        try:
            rel = json.loads(_api(cfg, f"releases/tags/{tag}", tok, timeout=20))
        except urllib.error.HTTPError:
            continue
        if rel.get("draft") or rel.get("prerelease"):
            continue
        asset = next((a for a in rel.get("assets") or [] if a.get("name") == name), None)
        if asset:
            return asset
    return None


def refresh_apps(force=False):
    """Rinnova le copie delle app nella cartella apk se su GitHub ce n'e' una piu' nuova.
    True se ora la copia dell'app Android c'e'."""
    if not force and time.time() - _apps["at"] < APPS_EVERY:
        return APK_FILE.is_file()
    if not _apps_lock.acquire(blocking=False):
        return APK_FILE.is_file()
    try:
        cfg = _config()
        if not cfg or not PROGRAM.is_dir():
            return APK_FILE.is_file()
        tok = token()
        for prefix, name, dest in APPS:
            asset = latest_app_asset(cfg, tok, prefix, name)
            if not asset and prefix == "app-v":
                # Prima delle release app-v l'app stava nella release fissa del server
                try:
                    rel = json.loads(_api(cfg, f"releases/tags/{cfg['apk_release']}", tok, timeout=20))
                except urllib.error.HTTPError:
                    rel = {}
                asset = next((a for a in rel.get("assets") or [] if a.get("name") == name), None)
            asset = _newer(asset, dest)
            if asset:
                _install_apk(cfg, tok, asset, dest)
        _apps["at"] = time.time()
    except Exception as ex:
        _apps["at"] = time.time() - APPS_EVERY + 600         # si riprova tra 10 minuti
        print("Copie delle app non rinnovate:", repr(ex), flush=True)
    finally:
        _apps_lock.release()
    return APK_FILE.is_file()


def apps_loop():
    time.sleep(120)
    while True:
        refresh_apps()
        time.sleep(600)


def loop(auto):
    """Controllo all'avvio, poi a ogni avviso di release (o ogni CHECK_HOURS se gli
    avvisi non arrivano). 'auto' dice se installare da soli quando nessuno guarda."""
    _sleep(90, always=True)
    while True:
        wait, always = CHECK_HOURS * 3600, False
        try:
            if _status["phase"] != "host":
                check()
                if available() and auto():
                    # c'e' un film in corso, o l'installazione non e' riuscita: si riprova tra poco
                    wait, always = 15 * 60, True
                    if not busy():
                        start_install()
        except Exception as ex:
            print("Controllo aggiornamenti non riuscito:", repr(ex), flush=True)
        _sleep(wait, always)
