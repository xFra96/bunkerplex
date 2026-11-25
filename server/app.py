"""BunkerPlex - media server casalingo.

Scansiona le cartelle di Film e Serie TV, cataloga tutto in SQLite
(locandine, trama, anno, regista, generi, cast, voto da TMDB) e manda
i video in streaming.
"""
import asyncio
import calendar
import collections
import difflib
import gzip
import hashlib
import hmac
import http.client
import io
import ipaddress
import base64
import json
import math
import mimetypes
import os
import platform
import re
import secrets
import shutil
import socket
import sqlite3
import ssl
import struct
import subprocess
import tarfile
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

import contextvars

import accounts
import cast
import sigle
import tvinstall
import updater
from accounts import CURRENT

# Entrato offline senza account (PC dove nessun account e' mai entrato): tutto come prima degli account

VERSION = "1.2"
# Livello delle API che le app usano (/api/info "api"). Le app si aggiornano da
# sole dalle loro release e sanno qual e' il livello minimo che serve a loro
# (Releases.MIN_SERVER_API in android/comune): se il server e' piu' vecchio
# avvisano di aggiornarlo. Va alzato solo quando le API cambiano in un modo che
# le app vecchie o nuove devono sapere; aggiungere campi o rotte non conta.
API_LEVEL = 1
DATA = Path(os.environ.get("DATA_DIR", "/data"))
TMDB_LANG = os.environ.get("TMDB_LANG", "it-IT")
SCAN_INTERVAL_MIN = int(os.environ.get("SCAN_INTERVAL_MIN", "30") or 30)
SERVER_NAME = os.environ.get("SERVER_NAME", "BunkerPlex")

IMG = DATA / "images"
# Il catalogo (questa cartella) viaggia sul disco insieme ai video: "Installa
# BunkerPlex" ci mette un segnaposto prima di accendere il server. Se il
# segnaposto manca, il disco non e' collegato a Docker: invece di creare un
# catalogo vuoto da un'altra parte, il server si ferma e lo dice.
MARKER = DATA / ".bunkerplex"
DB_PATH = DATA / "bunkerplex.db"


def rename_old_catalog():
    """Fino alla versione di novembre 2026 segnaposto e database avevano il nome
    vecchio del progetto: si rinominano una volta, prima di aprire il catalogo."""
    old = "francoplex"     # il nome di prima
    pairs = [(DATA / f".{old}", MARKER)] + [
        (DATA / f"{old}.db{x}", DB_PATH.with_name(DB_PATH.name + x)) for x in ("", "-wal", "-shm")]
    if DB_PATH.exists():
        pairs = pairs[:1]          # catalogo gia' rinominato: il database vecchio non si tocca
    for src, dst in pairs:
        try:
            if src.exists() and not dst.exists():
                os.replace(src, dst)
            elif src.exists() and src.name.startswith("."):
                src.unlink()
        except OSError as ex:
            print("Rinomina del catalogo non riuscita:", src.name, repr(ex), flush=True)


rename_old_catalog()


def data_problem():
    if os.environ.get("DATA_CHECK", "1") != "0" and not MARKER.is_file():
        return ("Il disco con il catalogo non è collegato al server. "
                "Collegalo: BunkerPlex riparte da solo. Se non succede, rilancia «Installa BunkerPlex».")
    try:
        IMG.mkdir(parents=True, exist_ok=True)
        test = DATA / ".scrittura"
        test.write_text("ok")
        test.unlink()
    except OSError:
        return ("Non riesco a scrivere nella cartella del catalogo. "
                "Rilancia «Installa BunkerPlex» sul computer.")
    return ""


DATA_PROBLEM = data_problem()
CONFIG_PATH = DATA / "config.json"
SUBS_DIR = DATA / "subs"            # sottotitoli scaricati da internet, uno per lingua e video
APK_PATH = Path(os.environ.get("APK_PATH", "/apk/BunkerPlex.apk"))
# L'app TV nativa (release tv-v*): accanto all'altra, si aggiorna da sola dal server
TV_APK_PATH = APK_PATH.with_name("BunkerPlexTV.apk")

VIDEO_EXT = {".mp4", ".mkv", ".avi", ".mov", ".m4v", ".webm", ".ts", ".wmv",
             ".flv", ".mpg", ".mpeg", ".m2ts"}
SUB_EXT = {".srt", ".vtt"}
ART_EXT = (".jpg", ".jpeg", ".png", ".webp")
MIME = {".mkv": "video/x-matroska", ".mp4": "video/mp4", ".m4v": "video/mp4",
        ".webm": "video/webm", ".avi": "video/x-msvideo", ".mov": "video/quicktime",
        ".ts": "video/mp2t", ".m2ts": "video/mp2t"}


def load_config():
    try:
        return json.loads(CONFIG_PATH.read_text("utf-8"))
    except Exception:
        return {}


config = load_config()


def tmdb_key():
    """La chiave TMDB: quella dell'account che fa la richiesta; per le letture in
    sottofondo (o se l'account non ne ha) quella del PC o di un altro account."""
    u = CURRENT.get()
    own = user_setting(u["id"], "tmdb_key") if u else ""
    return (own or config.get("tmdb_key") or os.environ.get("TMDB_API_KEY", "")
            or any_user_setting("tmdb_key") or "").strip()


# --------------------------------------------------------------------------
# Cartelle della libreria (scelte dall'app, quante se ne vogliono)
# --------------------------------------------------------------------------

# I dischi del computer si vedono in sola lettura sotto /host, collegati una volta
# per tutte da "Installa BunkerPlex":
#   - Windows: /host/c, /host/g, ... (tutti i dischi che Docker Desktop vede; quelli
#     collegati dopo li aggiunge al volo l'aiutante strumenti/Agente.ps1);
#   - Mac: /host/Volumes/<nome disco> e /host/Users.
# Da li' l'app puo' sfogliare e scegliere le cartelle.
HOST_ROOT = Path(os.environ.get("HOST_ROOT", "/host"))
HIDDEN_DIRS = {"system volume information", "config.msi", "recovery", "perflogs",
               "documents and settings", "msocache"}
# Cartelle di servizio di Docker Desktop che stanno accanto ai dischi di Windows
HOST_SKIP = {"wsl", "wslg"}
config_lock = threading.Lock()


def save_config():
    # Prima su un file a parte, poi lo scambio: se il disco viene staccato a
    # meta' scrittura non resta un config.json troncato.
    tmp = CONFIG_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(config, ensure_ascii=False, indent=1), "utf-8")
    os.replace(tmp, CONFIG_PATH)


def has_content(path):
    # Basta il primo elemento: sui dischi condivisi con Docker (Windows, Mac) leggere
    # tutta la cartella per sapere se e' vuota costa decine di millisecondi.
    try:
        with os.scandir(path) as it:
            return next(it, None) is not None
    except OSError:
        return False


def get_libraries():
    """Le raccolte: [{id, name, folders: [percorsi]}].
    Il nome lo sceglie l'utente; ogni raccolta puo' avere piu' cartelle e puo'
    contenere sia film sia serie (vengono riconosciuti da soli)."""
    with config_lock:
        if "libraries" not in config:
            # Passaggio dalla versione precedente (elenco semplice di cartelle)
            old = config.pop("folders", [])
            libs = []
            for kind, name in (("movies", "Film"), ("shows", "Serie TV")):
                paths = [f["path"] for f in old if f.get("kind") == kind]
                if paths:
                    libs.append({"id": len(libs) + 1, "name": name, "folders": paths})
            config["libraries"] = libs
            save_config()
        out = json.loads(json.dumps(config["libraries"]))
    # Con gli account ognuno vede le sue raccolte (e quelle che gli altri account
    # di questo PC hanno condiviso). Le letture in sottofondo vedono tutto.
    u = CURRENT.get()
    if u is not None and u.get("friend"):        # un amico: solo le raccolte di quel profilo
        out = [lib for lib in out if lib.get("owner") == u["id"]]
    elif u is not None and u.get("guest"):       # amico entrato qui: quelle del proprietario
        ids = set(u.get("libs") or [])
        out = [dict(lib, mine=False) for lib in out if lib["id"] in ids]
    elif u is not None:
        out = [lib for lib in out if lib.get("owner") == u["id"] or lib.get("shared")]
        for lib in out:
            lib["mine"] = lib.get("owner") == u["id"]
    return out


def guest_libs():
    """Cosa vede un amico entrato qui come ospite: le raccolte del proprietario,
    se il proprietario le condivide con gli amici."""
    owner = server_owner()
    if owner is None or not friends_shared(owner):
        return []
    with config_lock:
        return [lib["id"] for lib in config.get("libraries") or [] if lib.get("owner") == owner]


def visible_libs(uid):
    with config_lock:
        return [lib["id"] for lib in config.get("libraries") or []
                if lib.get("owner") == uid or lib.get("shared")]


def display_path(path):
    """/host/G/Video/Film -> G:\\Video\\Film"""
    s = str(path)
    root = str(HOST_ROOT)
    if s == root:
        return "Questo PC"
    if s.startswith(root + "/"):
        parts = s[len(root) + 1:].split("/")
        if len(parts[0]) == 1:
            return parts[0].upper() + ":\\" + "\\".join(parts[1:])
        return "/" + "/".join(parts)
    return s


def disk_of(path):
    """Il disco su cui sta un percorso: ('G:', /host/g) su Windows, ('Nome', /host/Volumes/Nome)
    sul Mac; ('', None) se non e' su un disco riconoscibile."""
    s, root = str(path), str(HOST_ROOT)
    if s.startswith(root + "/"):
        parts = s[len(root) + 1:].split("/")
        if len(parts[0]) == 1:
            return parts[0].upper() + ":", HOST_ROOT / parts[0]
        if parts[0] == "Volumes" and len(parts) > 1:
            return parts[1], HOST_ROOT / "Volumes" / parts[1]
    return "", None


_offline = {"at": 0.0, "roots": []}


def offline_roots():
    """Le cartelle delle raccolte che adesso non si raggiungono (di solito un disco
    esterno scollegato). I loro video restano in catalogo: servono a dire dove sono.
    Si ricontrolla al massimo ogni 10 secondi, cosi' gli elenchi lunghi non pesano."""
    now = time.time()
    if now - _offline["at"] > 10:
        with config_lock:
            folders = [p for lib in config.get("libraries") or [] for p in lib.get("folders") or []]
        _offline["roots"] = [f for f in folders if not has_content(Path(f))]
        _offline["at"] = now
    return _offline["roots"]


def is_offline(path):
    return any(path.startswith(root + "/") for root in offline_roots())


def missing_file(path):
    """None se il file c'e'; altrimenti dove dovrebbe trovarsi e perche' non si trova:
    {"where": 'G:\\Film\\Matrix.mkv', "disk": 'G:', "unplugged": True/False, "message": ...}"""
    if os.path.isfile(path):
        return None
    where = display_path(path)
    disk, root = disk_of(path)
    unplugged = bool(root) and not has_content(root)
    if unplugged:
        msg = f"Il disco {disk} non è collegato. Collegalo: il file dovrebbe trovarsi in {where}"
    else:
        msg = f"Il file non è al suo posto: dovrebbe trovarsi in {where}"
    return {"where": where, "disk": disk, "unplugged": unplugged, "message": msg}


def browse_path(raw):
    """Accetta solo percorsi dentro i dischi montati."""
    p = Path(os.path.normpath(raw)) if raw else HOST_ROOT
    if p != HOST_ROOT and HOST_ROOT not in p.parents:
        raise HTTPException(400, "Percorso non valido")
    return p


def drive_roots():
    """I dischi che il server vede adesso: le lettere di Windows (/host/c) e, sul
    Mac, i volumi (/host/Volumes/<nome>) e /host/Users."""
    out = []
    try:
        for d in sorted(HOST_ROOT.iterdir()):
            if d.name.lower() in HOST_SKIP or d.name.startswith(".") or not d.is_dir():
                continue
            if d.name == "Volumes":
                out += sorted(v for v in d.iterdir() if v.is_dir() and not v.name.startswith("."))
            else:
                out.append(d)
    except OSError:
        pass
    return out


def split_drive(path):
    """/host/g/Video/Film -> (/host/g, ("Video", "Film"))
    /host/Volumes/Disco/Film -> (/host/Volumes/Disco, ("Film",)). ValueError se fuori da /host."""
    parts = Path(path).relative_to(HOST_ROOT).parts
    n = 2 if parts and parts[0] == "Volumes" else 1
    if len(parts) < n:
        raise ValueError(path)
    return HOST_ROOT.joinpath(*parts[:n]), parts[n:]


def moved_folder(path):
    """Se la cartella non e' piu' dove era stata scelta, la cerca con lo stesso
    percorso dentro gli altri dischi collegati: su questo computer il disco puo'
    avere un'altra lettera (da G: a H:), un'altra maiuscola (G -> g) o essere un
    Mac (G:/Film -> /Volumes/Disco/Film). None se non la trova."""
    try:
        drive, rest = split_drive(path)
    except ValueError:
        return None
    if not rest:
        return None
    # Prima la stessa lettera scritta diversa, poi gli altri dischi
    for other in sorted(drive_roots(), key=lambda d: d.name.lower() != drive.name.lower()):
        if other == drive:
            continue
        candidate = other.joinpath(*rest)
        if has_content(candidate):
            return str(candidate)
    return None


def folder_state(path):
    """Dove sta adesso una cartella della libreria."""
    online = has_content(Path(path))
    moved = None if online else moved_folder(path)
    return {"path": path, "display": display_path(path), "online": online,
            "moved_to": moved, "moved_display": display_path(moved) if moved else None}


def folder_from_input(raw):
    """Accetta sia un percorso di Windows (G:\\Video\\Film, anche tra virgolette,
    come lo copia Esplora risorse) sia quello interno (/host/G/Video/Film)."""
    raw = (raw or "").strip().strip('"').strip()
    if raw.startswith("\\\\"):
        raise HTTPException(400, "Le cartelle di rete non sono supportate: usa una cartella su un disco del PC")
    m = re.match(r"^([A-Za-z]):(?:[\\/]+(.*))?$", raw)
    if m:
        letter = m.group(1)
        drive = next((d for d in (HOST_ROOT / letter.upper(), HOST_ROOT / letter.lower()) if d.is_dir()), None)
        if drive is None:
            raise HTTPException(400, f"Il disco {letter.upper()}: non è collegato al server. "
                                     "Collegalo e riprova tra qualche secondo")
        rest = (m.group(2) or "").replace("\\", "/").strip("/")
        path = browse_path(str(drive / rest) if rest else str(drive))
    else:
        # Percorso del Mac (/Volumes/Disco/Film, /Users/...): sta sotto /host
        if raw.startswith("/") and raw != str(HOST_ROOT) and not raw.startswith(str(HOST_ROOT) + "/"):
            raw = str(HOST_ROOT) + raw
        path = browse_path(raw)
    if path == HOST_ROOT:
        raise HTTPException(400, "Scegli una cartella")
    if not path.is_dir():
        raise HTTPException(404, f"La cartella {display_path(path)} non esiste")
    return str(path)


# --------------------------------------------------------------------------
# Database
# --------------------------------------------------------------------------

def db(raw=False):
    """Connessione al catalogo. Durante una richiesta di un account, 'items' e
    'shows' diventano viste che mostrano solo le sue raccolte e i suoi visti,
    punti di ripresa e lista (raw=True: le tabelle vere, per scrivere le schede)."""
    con = sqlite3.connect(DB_PATH, timeout=30)
    con.row_factory = sqlite3.Row
    try:
        con.execute("PRAGMA journal_mode=WAL")
    except sqlite3.OperationalError:
        # Alcuni dischi esterni non reggono la modalita' WAL: si usa quella classica
        con.execute("PRAGMA journal_mode=DELETE")
    u = None if raw else CURRENT.get()
    if u is not None:
        user_views(con, u)
    return con


STATE_COLS = {"items": ("position", "watched", "last_played", "fav"), "shows": ("fav",)}
_table_cols = {}


def user_views(con, u):
    """Viste temporanee con lo stesso nome delle tabelle: in SQLite quelle
    temporanee vincono, quindi tutte le letture del catalogo valgono per l'account."""
    uid = int(u.get("sid") or u["id"])
    libs = ",".join(str(int(x)) for x in u["libs"]) or "-1"
    cols = {}
    for table in ("items", "shows"):
        if table not in _table_cols:
            _table_cols[table] = [r[1] for r in con.execute(f"PRAGMA main.table_info({table})")]
        cols[table] = ", ".join(f"m.{c} AS {c}" for c in _table_cols[table] if c not in STATE_COLS[table])
    con.executescript(
        f"CREATE TEMP VIEW items AS SELECT {cols['items']}, COALESCE(u.position, 0) AS position, "
        f"COALESCE(u.watched, 0) AS watched, COALESCE(u.last_played, 0) AS last_played, "
        f"COALESCE(u.fav, 0) AS fav FROM main.items m LEFT JOIN main.user_items u "
        f"ON u.item_id = m.id AND u.user_id = {uid} WHERE m.library_id IN ({libs});"
        f"CREATE TEMP VIEW shows AS SELECT {cols['shows']}, COALESCE(u.fav, 0) AS fav "
        f"FROM main.shows m LEFT JOIN main.user_shows u ON u.show_id = m.id AND u.user_id = {uid} "
        f"WHERE m.library_id IN ({libs});")


def init_db():
    con = db()
    con.executescript("""
    CREATE TABLE IF NOT EXISTS shows(
        id INTEGER PRIMARY KEY, folder TEXT UNIQUE, title TEXT, original_title TEXT,
        year INT, overview TEXT, poster TEXT, backdrop TEXT, tmdb_id INT,
        genres TEXT, director TEXT, actors TEXT, rating REAL,
        meta_done INT DEFAULT 0, added_at REAL);
    CREATE TABLE IF NOT EXISTS items(
        id INTEGER PRIMARY KEY, kind TEXT, path TEXT UNIQUE, show_id INT,
        season INT, episode INT, title TEXT, original_title TEXT, year INT,
        overview TEXT, tagline TEXT, poster TEXT, backdrop TEXT, tmdb_id INT,
        genres TEXT, director TEXT, actors TEXT, rating REAL,
        duration REAL, size INT, vcodec TEXT, acodec TEXT, pix TEXT,
        width INT, height INT, added_at REAL, meta_done INT DEFAULT 0,
        position REAL DEFAULT 0, watched INT DEFAULT 0, last_played REAL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS items_show ON items(show_id, season, episode);
    CREATE TABLE IF NOT EXISTS aliases(key TEXT PRIMARY KEY, show_id INT);
    CREATE TABLE IF NOT EXISTS collections(
        id INTEGER PRIMARY KEY, name TEXT, overview TEXT, poster TEXT, backdrop TEXT,
        parts TEXT, updated REAL);
    -- Titoli degli amici: visto e punto di ripresa restano qui (sul server dell'amico non si scrive nulla)
    CREATE TABLE IF NOT EXISTS friend_state(
        friend INT, item INT, show INT, position REAL DEFAULT 0, watched INT DEFAULT 0,
        last_played REAL DEFAULT 0, PRIMARY KEY(friend, item));
    -- Amici registrati su questo server (chi puo' guardare le raccolte da fuori) e i loro gettoni
    CREATE TABLE IF NOT EXISTS accounts(
        id INTEGER PRIMARY KEY, name TEXT UNIQUE COLLATE NOCASE, salt BLOB, hash BLOB,
        approved INT DEFAULT 0, created REAL, last_seen REAL DEFAULT 0,
        back_url TEXT, back_token TEXT);
    CREATE TABLE IF NOT EXISTS share_sessions(token TEXT PRIMARY KEY, account INT, created REAL);
    -- Account di chi usa questo PC (copia locale di quelli del servizio account)
    CREATE TABLE IF NOT EXISTS users(
        id INTEGER PRIMARY KEY, cloud_id INT UNIQUE, name TEXT COLLATE NOCASE, admin INT DEFAULT 0,
        must_change INT DEFAULT 0, token TEXT, vsalt TEXT, vcheck TEXT, state_rev INT DEFAULT 0,
        tv_quick INT DEFAULT 1, created REAL, last_login REAL);
    CREATE TABLE IF NOT EXISTS user_sessions(
        token TEXT PRIMARY KEY, user_id INT, device TEXT, created REAL, last_seen REAL);
    -- Profili dentro un account («Chi guarda?» dopo il login): ognuno con i suoi visti,
    -- punti di ripresa e lista. In user_items / user_shows stanno con user_id = -id
    CREATE TABLE IF NOT EXISTS profiles(
        id INTEGER PRIMARY KEY, user_id INT, name TEXT COLLATE NOCASE, created REAL);
    -- Visti, punti di ripresa e lista di ogni account. dirty: da mandare al servizio
    CREATE TABLE IF NOT EXISTS user_items(
        user_id INT, item_id INT, position REAL DEFAULT 0, watched INT DEFAULT 0,
        last_played REAL DEFAULT 0, fav REAL DEFAULT 0, t REAL DEFAULT 0, dirty INT DEFAULT 0,
        PRIMARY KEY(user_id, item_id));
    CREATE TABLE IF NOT EXISTS user_shows(
        user_id INT, show_id INT, fav REAL DEFAULT 0, t REAL DEFAULT 0, dirty INT DEFAULT 0,
        PRIMARY KEY(user_id, show_id));
    CREATE TABLE IF NOT EXISTS user_settings(
        user_id INT, k TEXT, v TEXT, t REAL, dirty INT DEFAULT 0, PRIMARY KEY(user_id, k));
    -- Ultima copia dei visti dal servizio (per titolo TMDB): vale anche per i titoli
    -- che su questo PC arrivano dopo
    CREATE TABLE IF NOT EXISTS cloud_state(
        user_id INT, k TEXT, kind TEXT, a INT, b INT, c INT, pos REAL, w INT, fav REAL, lp REAL, t REAL,
        PRIMARY KEY(user_id, k));
    CREATE INDEX IF NOT EXISTS cloud_state_a ON cloud_state(user_id, kind, a);
    -- Avvisi da mandare al servizio account (notifiche su telefoni e tablet): partono
    -- alla prossima sincronizzazione, anche se intanto mancava Internet
    CREATE TABLE IF NOT EXISTS notice_out(
        id INTEGER PRIMARY KEY, user_id INT, body TEXT, t REAL);
    -- (la copia del catalogo nell'account non c'e' piu': il catalogo resta sui dischi)
    DROP TABLE IF EXISTS cloud_catalog;
    """)
    # library_id: la raccolta a cui appartiene il titolo (aggiunta in un secondo momento)
    # collection_id: la saga TMDB di cui il film fa parte (id della tabella collections);
    # coll_done: 1 quando si e' gia' controllato se il film appartiene a una saga.
    # fav: "La mia lista". 0 = no, altrimenti il momento in cui il titolo e' stato aggiunto.
    for table, column in (("items", "library_id INT"), ("shows", "library_id INT"),
                          ("items", "collection_id INT"), ("items", "coll_done INT DEFAULT 0"),
                          ("items", "fav REAL DEFAULT 0"), ("shows", "fav REAL DEFAULT 0"),
                          # people: il cast con ruolo e foto (JSON). NULL = ancora da scaricare.
                          ("items", "people TEXT"), ("shows", "people TEXT"),
                          # back_pin: impronta del certificato dell'amico che ha mandato la richiesta
                          ("accounts", "back_pin TEXT"),
                          # offline_since: modifiche fatte offline, da mandare o scartare al rientro
                          ("users", "offline_since REAL DEFAULT 0"), ("users", "last_sync REAL DEFAULT 0"),
                          # offline: entrato senza password perche' il servizio account non rispondeva
                          ("user_sessions", "offline INT DEFAULT 0"),
                          # Aggiornamento delle schede (vedi plan_refresh): meta_at = ultima volta
                          # che si e' chiesto a TMDB, meta_tries = tentativi andati a vuoto,
                          # released / status / next_air / last_air = date per decidere quando ricontrollare
                          ("items", "meta_at REAL"), ("items", "meta_tries INT DEFAULT 0"),
                          ("items", "released TEXT"),
                          ("shows", "meta_at REAL"), ("shows", "meta_tries INT DEFAULT 0"),
                          ("shows", "status TEXT"), ("shows", "next_air TEXT"), ("shows", "last_air TEXT"),
                          # Amici entrati con l'account (vedi share_ticket): cloud_from = il suo
                          # account, profile = il profilo di qui che lo ha come amico (vede solo
                          # le raccolte di quel profilo). NULL: vecchio collegamento con password
                          ("accounts", "cloud_from INT"), ("accounts", "profile INT"),
                          # manual = quando la scheda e' stata scelta a mano con «Correggi scheda»
                          # (0: trovata da sola). fp, catalog_rev, catalog_at: della vecchia copia
                          # del catalogo nell'account, non piu' usati
                          ("items", "fp TEXT"), ("items", "manual REAL DEFAULT 0"),
                          ("shows", "manual REAL DEFAULT 0"),
                          ("users", "catalog_rev INT DEFAULT 0"), ("users", "catalog_at REAL DEFAULT 0"),
                          # Sigle degli episodi (vedi sigle_loop), in secondi: intro_s / intro_e = sigla
                          # iniziale, credits_s = inizio della sigla finale; marks_v = versione del
                          # riconoscimento con cui l'episodio e' stato guardato (0: ancora da fare)
                          ("items", "intro_s REAL"), ("items", "intro_e REAL"), ("items", "credits_s REAL"),
                          ("items", "marks_v INT DEFAULT 0"),
                          # Fotogrammi al secondo del video: l'app TV porta lo schermo alla stessa
                          # frequenza (dall'MKV il player non li legge). NULL: ancora da misurare
                          ("items", "fps REAL"),
                          # Email dell'account Google collegato all'account («Entra con Google»)
                          ("users", "google TEXT"),
                          # Email con cui l'account entra (al posto del nome utente)
                          ("users", "email TEXT"),
                          # 1 = disattivato dall'amministratore (dalla plancia): qui non si entra
                          ("users", "disabled INT DEFAULT 0"),
                          # 1 = amico del proprietario: entra su questo server come ospite e vede
                          # le raccolte del proprietario (solo finche' restano amici)
                          ("users", "guest INT DEFAULT 0"),
                          # Il profilo scelto su questo dispositivo: NULL = ancora da scegliere,
                          # 0 = quello principale (l'account), altrimenti l'id in profiles
                          ("user_sessions", "profile INT"),
                          # Id IMDb della scheda (tt...), da TMDB o dai nomi / file .nfo
                          ("items", "imdb_id TEXT"), ("shows", "imdb_id TEXT"),
                          # Voto IMDb e numero di voti (vedi imdb_ratings), NULL = non ancora letto
                          ("items", "imdb_rating REAL"), ("items", "imdb_votes INT"),
                          ("shows", "imdb_rating REAL"), ("shows", "imdb_votes INT"),
                          # Locandina TMDB scelta a mano con «Cambia locandina» (percorso TMDB):
                          # gli aggiornamenti della scheda la tengono
                          ("items", "poster_pick TEXT"), ("shows", "poster_pick TEXT")):
        if column.split()[0] not in {r[1] for r in con.execute(f"PRAGMA table_info({table})")}:
            con.execute(f"ALTER TABLE {table} ADD COLUMN {column}")
    con.execute("CREATE INDEX IF NOT EXISTS items_collection ON items(collection_id)")
    con.execute("CREATE INDEX IF NOT EXISTS items_tmdb ON items(tmdb_id)")
    con.execute("CREATE INDEX IF NOT EXISTS items_fp ON items(fp)")
    con.execute("CREATE INDEX IF NOT EXISTS shows_tmdb ON shows(tmdb_id)")
    con.commit()
    con.close()


# --------------------------------------------------------------------------
# Lettura dei nomi dei file
# --------------------------------------------------------------------------

JUNK = re.compile(
    r"\b(2160p|1080p|1080i|720p|576p|480p|4k|uhd|hdr10|hdr|bluray|blu-ray|brrip|"
    r"bdrip|bdremux|remux|webrip|web-dl|webdl|hdtv|dvdrip|dvd|x264|x265|h264|h265|"
    r"hevc|avc|xvid|divx|aac|ac3|eac3|dts|ddp?5 ?1|10bit|ita|eng|multi|subs?|"
    r"extended|remastered|proper|repack|unrated)\b.*", re.I)
YEAR = re.compile(r"(?<!\d)((?:19|20)\d{2})(?!\d)")
EP_PATTERNS = [re.compile(r"[Ss](\d{1,2})[\s._-]*[Ee](\d{1,3})"),
               re.compile(r"(?<!\d)(\d{1,2})x(\d{2,3})(?!\d)"),
               # 'House of Cards - S01 - 01 - Capitolo 1': stagione ed episodio separati da un trattino
               re.compile(r"(?<![A-Za-z0-9])[Ss](\d{1,2})[\s._]*-[\s._]*(\d{1,3})(?!\d)")]
SEASON_DIR = re.compile(r"^(?:(?:season|stagione|staffel|serie|s)\s*(\d{1,2})|"
                        r"(\d{1,2})\s*(?:\^|a|°|ª|st|nd|rd|th)?\s*(?:season|stagione|staffel|serie)|"
                        r"specials?|speciali)$", re.I)
# Id IMDb nel nome di un file o di una cartella ('Film {imdb-tt0111161}', '[tt0111161]')
# o dentro un file .nfo (Kodi, Plex, Jellyfin): e' la chiave piu' sicura per abbinare la scheda
IMDB_ID = re.compile(r"(?<![a-z0-9])(tt\d{7,9})(?!\d)", re.I)
SEASON_TAIL = re.compile(r"\s+(?:s\d{1,2}|(?:season|stagione|staffel|serie)\s*\d{1,2}|complet[ae])\b.*$", re.I)
EP_WORD = re.compile(r"(?:^|[\s._\-\[(])(?:ep|episodio|episode|puntata)[\s._-]*(\d{1,3})(?!\d)", re.I)


def clean(s):
    s = re.sub(r"\[[^\]]*\]|\{[^}]*\}", " ", s)
    s = IMDB_ID.sub(" ", s)
    s = re.sub(r"[._]+", " ", s)
    return re.sub(r"\s+", " ", s).strip(" -")


JUNK_STRONG = re.compile(
    r"\b(2160p|1080p|1080i|720p|576p|480p|4k|uhd|hdr10|hdr|bluray|blu-ray|brrip|bdrip|"
    r"bdremux|remux|webrip|web-dl|webdl|hdtv|dvdrip|x264|x265|h264|h265|hevc|xvid|divx|"
    r"aac|ac3|eac3|dts|10bit)\b.*", re.I)


LEADING_YEAR = re.compile(r"^\s*[\[(]((?:19|20)\d{2})[\])]\s*[-.]?\s*")


def parse_title(name):
    """'Il.Padrino.1972.1080p.BluRay' -> ('Il Padrino', 1972)
    'Blade Runner 2049 (2017)'     -> ('Blade Runner 2049', 2017)
    '[1999] Eyes Wide Shut [1080p] (by.tizio)' -> ('Eyes Wide Shut', 1999)"""
    lead = LEADING_YEAR.match(name)
    name = re.sub(r"\(\s*by[\s.][^)]*\)?", " ", name[lead.end():] if lead else name, flags=re.I)
    s = clean(name)
    if lead and not YEAR.search(s):
        title = re.sub(r"[\s(\[\-]+$", "", JUNK.sub("", s)).strip()
        return (title or s), int(lead.group(1))
    tags = JUNK_STRONG.search(s)
    limit = time.localtime().tm_year + 1
    years = [m for m in YEAR.finditer(s) if m.start() > 0 and int(m.group(1)) <= limit]
    before_tags = [m for m in years if not tags or m.start() < tags.start()]
    years = before_tags or years
    # L'anno tra parentesi vince; altrimenti l'ultimo (il titolo puo' contenere un numero simile)
    in_brackets = [m for m in years if s[m.start() - 1] in "(["]
    m = in_brackets[-1] if in_brackets else (years[-1] if years else None)
    if m:
        title, year = JUNK_STRONG.sub("", s[:m.start()]), int(m.group(1))
    else:
        title, year = JUNK.sub("", s), None
    title = re.sub(r"[\s(\[\-]+$", "", title).strip()
    # 'High Noon (Zinnemann, Fred 1952' -> 'High Noon': la parentesi rimasta aperta conteneva l'anno
    title = re.sub(r"\s*\([^)]*$", "", title).strip(" -") or title
    return (title or s), year


def show_key(title):
    """Chiave che riunisce gli episodi della stessa serie anche se stanno in
    cartelle diverse: 'Breaking.Bad' e 'Breaking Bad' sono la stessa cosa."""
    plain = unicodedata.normalize("NFD", title.lower())
    return "show:" + re.sub(r"[^a-z0-9]+", "", plain)


def numbered_siblings(folder, cache):
    """Quanti video della cartella hanno 'Episodio N' / 'Ep N' nel nome."""
    key = str(folder)
    if key not in cache:
        try:
            cache[key] = sum(1 for f in os.scandir(folder)
                             if os.path.splitext(f.name)[1].lower() in VIDEO_EXT
                             and EP_WORD.search(os.path.splitext(f.name)[0]))
        except OSError:
            cache[key] = 0
    return cache[key]


SEQUENCE = re.compile(r"^(.*?)(?<!\d)(\d{1,4})(?!\d)")
SEQ_WORD = re.compile(r"(?:\b(?:ep|episodio|episode|puntata|parte|part|vol|n|nr)\.?)$", re.I)


SERIES_DIR = re.compile(r"\b(?:serie|series|tv|telefilm|shows?|anime|miniserie|miniseries|sceneggiati?)\b", re.I)


def numbered_series(folder, cache, max_minutes=55):
    """Riconosce le serie numerate senza S01E01: almeno tre file della stessa
    cartella con lo stesso nome seguito da un numero ('Dragon Ball 001 ...',
    'Dragon Ball 002 ...'). Per non scambiare una saga di film ('Rocky 1, 2, 3')
    per una serie, guarda anche la durata: gli episodi durano meno di 55 minuti
    ('max_minutes': di piu' se la cartella e' dichiaratamente di serie, perche'
    le miniserie come Band of Brothers hanno puntate di oltre un'ora).
    Restituisce {nome file: (serie, numero, resto del nome)}."""
    key = f"seq{max_minutes}:{folder}"
    if key in cache:
        return cache[key]
    groups = {}
    try:
        names = sorted(f.name for f in os.scandir(folder)
                       if os.path.splitext(f.name)[1].lower() in VIDEO_EXT)
    except OSError:
        names = []
    for name in names:
        text = clean(os.path.splitext(name)[0])
        m = SEQUENCE.match(text)
        if not m or EXTRA_FILE.search(text):
            continue
        number = int(m.group(2))
        if len(m.group(2)) == 4 and 1900 <= number <= 2100:    # e' un anno, non un numero di episodio
            continue
        prefix = SEQ_WORD.sub("", m.group(1).strip(" -#")).strip(" -#")
        groups.setdefault(show_key(prefix), []).append((name, prefix, number, text[m.end():]))
    result = {}
    for group in groups.values():
        if len(group) < 3 or len({g[2] for g in group}) < 3:
            continue
        lengths = [probe(os.path.join(str(folder), g[0]))["duration"] for g in group[:2]]
        if all(0 < d < max_minutes * 60 for d in lengths):
            for name, prefix, number, rest in group:
                result[name] = (prefix, number, rest)
    cache[key] = result
    return result


def classify(path, root, cache):
    """Capisce da solo se un file e' un film o un episodio.
    Film -> None.  Episodio -> (serie, anno, stagione, episodio, titolo episodio).

    E' un episodio se il nome contiene S01E02 o 1x02, se sta dentro una cartella
    'Stagione N' / 'Season N', oppure se si chiama 'Episodio N' insieme ad
    almeno altri due file della stessa cartella (e non ha un anno nel nome:
    'Star Wars Episodio 1 (1999)' resta un film)."""
    name = path.stem
    folders = path.relative_to(root).parts[:-1]
    season_dir = None
    for part in folders:
        m = SEASON_DIR.match(clean(part))
        if m:
            n = m.group(1) or m.group(2)
            season_dir = int(n) if n else 0

    title = year = ep_title = None
    for rx in EP_PATTERNS:
        m = rx.search(name)
        if m:
            season, episode = int(m.group(1)), int(m.group(2))
            ep_title = JUNK.sub("", clean(name[m.end():])).strip(" -") or None
            if clean(name[:m.start()]):
                title, year = parse_title(name[:m.start()])
            break
    else:
        m = EP_WORD.search(name)
        if m and (season_dir is not None or
                  (not YEAR.search(name) and numbered_siblings(path.parent, cache) >= 3)):
            season, episode = (season_dir if season_dir is not None else 1), int(m.group(1))
            if clean(name[:m.start()]):
                title, year = parse_title(name[:m.start()])
        elif season_dir is not None:
            season = season_dir
            m = re.search(r"(?<!\d)(\d{1,3})(?!\d)", name)
            episode = int(m.group(1)) if m else 0
        else:
            # In una cartella di serie ('Serie TV/...') le puntate possono durare di piu'
            in_series = any(SERIES_DIR.search(clean(p)) for p in (root.name,) + folders)
            numbered = numbered_series(path.parent, cache, 100 if in_series else 55).get(path.name)
            if not numbered:
                return None
            season, episode = 1, numbered[1]
            ep_title = JUNK.sub("", numbered[2]).strip(" -") or None
            if numbered[0]:
                title, year = parse_title(numbered[0])

    if not title:
        # Il nome della serie viene dalla cartella piu' vicina che non sia "Stagione N"
        for part in reversed(folders):
            if SEASON_DIR.match(clean(part)):
                continue
            title, year = parse_title(part)
            title = SEASON_TAIL.sub("", title).strip(" -") or title
            break
        else:
            title, year = parse_title(root.name)
    else:
        # Il nome del file non ha l'anno, ma la cartella della stessa serie si':
        # 'Dragon Ball (1986) 1080p/Dragon Ball 1x001.mkv' -> anno 1986.
        # Distingue serie omonime (Dragon Ball del 1986 da Dragon Ball Z del 1989).
        # Se il nome nel file ha un errore di battitura rispetto alla cartella
        # ('True Detective/True.Detectives.S02E01'), vale quello della cartella:
        # altrimenti la stagione finisce in una serie a parte, abbinata a un'altra.
        for t, y in folder_titles(folders):
            if show_key(t) == show_key(title):
                year = year or y
                break
            if typo_of(title, t):
                title, year = t, year or y
                break
    return (title.strip(" -") or title), year, season, episode, ep_title


def typo_of(a, b):
    """'True Detectives' e 'True Detective': stesso numero di parole e una sola
    parola appena diversa (non un numero). 'Dragon Ball Z' e 'Dragon Ball' no."""
    wa, wb = norm_title(a).split(), norm_title(b).split()
    if len(wa) != len(wb) or wa == wb:
        return False
    diff = [(x, y) for x, y in zip(wa, wb) if x != y]
    if len(diff) != 1:
        return False
    x, y = diff[0]
    return (min(len(x), len(y)) >= 4 and not re.search(r"\d", x + y)
            and difflib.SequenceMatcher(None, x, y).ratio() >= 0.8)


def folder_titles(folders):
    """(titolo, anno) delle cartelle che contengono un video, dalla piu' vicina,
    saltando quelle tipo 'Stagione 2'."""
    out = []
    for part in reversed(folders):
        if SEASON_DIR.match(clean(part)):
            continue
        t, y = parse_title(part)
        t = SEASON_TAIL.sub("", t).strip(" -") or t
        if t and (t, y) not in out:
            out.append((t, y))
    return out


# Contenuti speciali, trailer e spezzoni di prova: non vanno in catalogo
EXTRA_DIRS = {"extra", "extras", "featurette", "featurettes", "bonus", "bonus features",
              "trailer", "trailers", "behind the scenes", "deleted scenes", "interviews",
              "sample", "samples", "contenuti speciali", "contenuti extra", "dietro le quinte"}
EXTRA_FILE = re.compile(
    r"^(?:extras?|trailer|sample|featurette|bonus)\s*[-_.:]\s*\S"
    r"|[-_. ](?:trailer|sample|featurette)$|\bsample\b", re.I)


def walk_videos(root, exclude=()):
    """Tutti i video sotto 'root'. 'exclude': sottocartelle che appartengono a
    un'altra cartella della libreria (es. le Serie dentro la cartella Video)."""
    for base, dirs, files in os.walk(root, followlinks=True):
        dirs[:] = sorted(d for d in dirs if not d.startswith((".", "@", "$"))
                         and d.lower() not in EXTRA_DIRS
                         and os.path.join(base, d) not in exclude)
        for f in sorted(files):
            p = Path(base) / f
            if p.suffix.lower() in VIDEO_EXT and not f.startswith("."):
                if EXTRA_FILE.search(p.stem):
                    continue
                yield p


def local_art(video=None, folder=None):
    """Locandina salvata accanto al video (poster.jpg, folder.jpg, <nome>.jpg...)."""
    names = []
    if video is not None:
        names += [(video.parent, video.stem + suffix) for suffix in ("-poster", ".poster", "")]
    if folder is not None:
        names += [(folder, n) for n in ("poster", "folder", "cover", "locandina")]
    for base, stem in names:
        for ext in ART_EXT:
            f = base / (stem + ext)
            if f.is_file():
                return f
    return None


def store_local_art(src, prefix, row_id):
    name = f"local_{prefix}{row_id}{src.suffix.lower()}"
    try:
        shutil.copyfile(src, IMG / name)
        return name
    except OSError:
        return None


# --------------------------------------------------------------------------
# TMDB
# --------------------------------------------------------------------------

def tmdb(path, _key=None, **params):
    key = _key or tmdb_key()
    params.setdefault("language", TMDB_LANG)
    headers = {"accept": "application/json", "User-Agent": "media-server"}
    if len(key) > 40:
        headers["Authorization"] = "Bearer " + key
    else:
        params["api_key"] = key
    url = "https://api.themoviedb.org/3" + path + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


def fetch_image(tmdb_path, size):
    if not tmdb_path:
        return None
    name = size + "_" + tmdb_path.strip("/").replace("/", "_")
    target = IMG / name
    if not target.exists():
        try:
            req = urllib.request.Request(
                f"https://image.tmdb.org/t/p/{size}{tmdb_path}",
                headers={"User-Agent": "media-server"})
            with urllib.request.urlopen(req, timeout=20) as r:
                target.write_bytes(r.read())
        except Exception:
            return None
    return name


def cast_people(credits):
    """I primi interpreti di un film o di una serie, con ruolo e foto (scaricata
    una volta sola: lo stesso attore serve a tutti i suoi titoli)."""
    out = []
    for c in (credits or {}).get("cast", [])[:8]:
        if c.get("name"):
            out.append({"name": c["name"], "role": c.get("character") or "",
                        "photo": fetch_image(c.get("profile_path"), "w185")})
    return json.dumps(out, ensure_ascii=False)


def people_json(text):
    return [{"name": p.get("name") or "", "role": p.get("role") or "", "photo": img_url(p.get("photo"))}
            for p in jlist(text) if isinstance(p, dict)]


def _year(date, fallback):
    return int(date[:4]) if date and date[:4].isdigit() else fallback


SAGA_TAIL = re.compile(r"[\s\-\u2013:(]*\b(?:la\s+)?(?:collezione|collection|raccolta)\b\)?\s*$", re.I)
SAGA_REFRESH = 30 * 86400


def saga_name(name):
    """'Harry Potter - Collezione' -> 'Harry Potter'"""
    name = (name or "").strip()
    return SAGA_TAIL.sub("", name).strip() or name


def set_collection(con, item_id, movie):
    """Segna a quale saga appartiene un film ('movie' e' la scheda TMDB del film).
    La scheda della saga (trama, locandina, elenco completo dei film) si scarica
    la prima volta che la si incontra e poi una volta al mese, per i film nuovi."""
    c = movie.get("belongs_to_collection") or None
    if c:
        known = con.execute("SELECT updated FROM collections WHERE id=?", (c["id"],)).fetchone()
        if not known or time.time() - (known["updated"] or 0) > SAGA_REFRESH:
            try:
                full = tmdb(f"/collection/{c['id']}")
            except urllib.error.HTTPError:
                full = {}
            overview = full.get("overview") or ""
            if full and not overview:
                try:
                    overview = tmdb(f"/collection/{c['id']}", language="en-US").get("overview") or ""
                except Exception:
                    pass
            parts = sorted(({"id": p["id"], "title": p.get("title") or "", "date": p.get("release_date") or ""}
                            for p in full.get("parts", [])), key=lambda p: (p["date"] or "9999", p["title"]))
            con.execute(
                "INSERT OR REPLACE INTO collections(id, name, overview, poster, backdrop, parts, updated) "
                "VALUES(?,?,?,?,?,?,?)",
                (c["id"], full.get("name") or c.get("name") or "", overview,
                 fetch_image(full.get("poster_path") or c.get("poster_path"), "w500"),
                 fetch_image(full.get("backdrop_path") or c.get("backdrop_path"), "w1280"),
                 json.dumps(parts, ensure_ascii=False), time.time() if full else 0))
    con.execute("UPDATE items SET collection_id=?, coll_done=1 WHERE id=?",
                (c["id"] if c else None, item_id))


def apply_movie(con, item_id, tmdb_id):
    """Scarica la scheda completa di un film e la salva."""
    m = tmdb(f"/movie/{tmdb_id}", append_to_response="credits")
    overview = m.get("overview") or ""
    if not overview:
        try:
            overview = tmdb(f"/movie/{tmdb_id}", language="en-US").get("overview") or ""
        except Exception:
            pass
    credits = m.get("credits") or {}
    directors = [c["name"] for c in credits.get("crew", []) if c.get("job") == "Director"]
    actors = [c["name"] for c in credits.get("cast", [])[:8]]
    row = con.execute("SELECT poster, year, title, poster_pick, tmdb_id FROM items WHERE id=?", (item_id,)).fetchone()
    if row["tmdb_id"] != m["id"]:     # abbinato a un altro film: la scelta di prima non vale piu'
        con.execute("UPDATE items SET poster_pick=NULL WHERE id=?", (item_id,))
        row = dict(row, poster_pick=None)
    poster = row["poster"] if (row["poster"] or "").startswith("local_") \
        else fetch_image(row["poster_pick"] or m.get("poster_path"), "w500")
    con.execute(
        "UPDATE items SET title=?, original_title=?, year=?, overview=?, tagline=?, poster=?, "
        "backdrop=?, tmdb_id=?, genres=?, director=?, actors=?, rating=?, people=?, meta_done=1, "
        "meta_at=?, meta_tries=0, released=?, imdb_rating=CASE WHEN imdb_id IS ? THEN imdb_rating END, "
        "imdb_id=? WHERE id=?",
        (m.get("title") or row["title"], m.get("original_title"),
         _year(m.get("release_date"), row["year"]), overview, m.get("tagline") or "",
         poster, fetch_image(m.get("backdrop_path"), "w1280"), m["id"],
         json.dumps([g["name"] for g in m.get("genres", [])], ensure_ascii=False),
         ", ".join(directors), json.dumps(actors, ensure_ascii=False),
         round(m.get("vote_average") or 0, 1), cast_people(credits), time.time(),
         m.get("release_date") or None, m.get("imdb_id") or "", m.get("imdb_id") or "", item_id))
    con.commit()                  # la saga puo' voler scaricare: il database non resta bloccato intanto
    set_collection(con, item_id, m)


def show_poster(m):
    """La locandina di una serie. Quella 'principale' che TMDB indica per l'italiano
    a volte e' di una sola stagione (True Detective -> la stagione 4, Night Country),
    caricata da qualcuno e mai votata. Si prende l'italiana piu' votata, se ha voti;
    se no, quando la principale non ha voti ma ce n'e' una in inglese (o senza
    scritte) votata da piu' persone, quella."""
    posters = (m.get("images") or {}).get("posters") or []
    main = m.get("poster_path")
    lang = TMDB_LANG[:2]

    def rank(p):
        return (p.get("vote_average") or 0, p.get("vote_count") or 0)
    local = [p for p in posters if p.get("iso_639_1") == lang and (p.get("vote_count") or 0) > 0]
    if local:
        return max(local, key=rank)["file_path"]
    cur = next((p for p in posters if p.get("file_path") == main), None)
    other = [p for p in posters if p.get("iso_639_1") in ("en", None) and (p.get("vote_count") or 0) >= 2]
    if other and (cur is None or not cur.get("vote_count")) and (cur is None or cur.get("iso_639_1") == lang):
        return max(other, key=rank)["file_path"]
    return main


def apply_show(con, show_id, tmdb_id):
    m = tmdb(f"/tv/{tmdb_id}", append_to_response="credits,external_ids,images",
             include_image_language=TMDB_LANG[:2] + ",en,null")
    overview = m.get("overview") or ""
    if not overview:
        try:
            overview = tmdb(f"/tv/{tmdb_id}", language="en-US").get("overview") or ""
        except Exception:
            pass
    actors = [c["name"] for c in (m.get("credits") or {}).get("cast", [])[:8]]
    row = con.execute("SELECT poster, year, title, poster_pick, tmdb_id FROM shows WHERE id=?", (show_id,)).fetchone()
    if row["tmdb_id"] != m["id"]:     # abbinata a un'altra serie: la scelta di prima non vale piu'
        con.execute("UPDATE shows SET poster_pick=NULL WHERE id=?", (show_id,))
        row = dict(row, poster_pick=None)
    poster = row["poster"] if (row["poster"] or "").startswith("local_") \
        else fetch_image(row["poster_pick"] or show_poster(m), "w500")
    con.execute(
        "UPDATE shows SET title=?, original_title=?, year=?, overview=?, poster=?, backdrop=?, "
        "tmdb_id=?, genres=?, director=?, actors=?, rating=?, people=?, meta_done=1, "
        "meta_at=?, meta_tries=0, status=?, next_air=?, last_air=?, "
        "imdb_rating=CASE WHEN imdb_id IS ? THEN imdb_rating END, imdb_id=? WHERE id=?",
        (m.get("name") or row["title"], m.get("original_name"),
         _year(m.get("first_air_date"), row["year"]), overview, poster,
         fetch_image(m.get("backdrop_path"), "w1280"), m["id"],
         json.dumps([g["name"] for g in m.get("genres", [])], ensure_ascii=False),
         ", ".join(c["name"] for c in m.get("created_by", [])),
         json.dumps(actors, ensure_ascii=False),
         round(m.get("vote_average") or 0, 1), cast_people(m.get("credits")), time.time(),
         m.get("status") or None, (m.get("next_episode_to_air") or {}).get("air_date") or None,
         m.get("last_air_date") or None, (m.get("external_ids") or {}).get("imdb_id") or "",
         (m.get("external_ids") or {}).get("imdb_id") or "", show_id))
    con.execute("UPDATE items SET meta_done=0 WHERE show_id=?", (show_id,))


def search_tmdb(kind, title, year=None, both=False):
    """Risultati TMDB. Con 'both' unisce la ricerca con l'anno e quella senza:
    l'anno preso da una cartella puo' essere quello di una stagione, non della serie."""
    path = "/search/movie" if kind == "movie" else "/search/tv"
    year_param = "year" if kind == "movie" else "first_air_date_year"
    res = []
    if year:
        res = tmdb(path, query=title, **{year_param: year}).get("results", [])
    if not res or both:
        ids = {r["id"] for r in res}
        res += [r for r in tmdb(path, query=title).get("results", []) if r["id"] not in ids]
    return res


def norm_title(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", s.replace("&", " and ")).strip()


def name_score(query, r):
    """Somiglianza tra il nome cercato e quello (italiano o originale) del risultato."""
    q = norm_title(query)
    best = 0.0
    for k in ("title", "name", "original_title", "original_name"):
        n = norm_title(r.get(k))
        if not n or not q:
            continue
        if n.replace(" ", "") == q.replace(" ", ""):
            s = 1.1
        else:
            s = difflib.SequenceMatcher(None, q, n).ratio()
            if n.startswith(q + " "):     # 'Birdman' -> 'Birdman o (L'imprevedibile virtu'...)'
                s = max(s, 0.9)
        best = max(best, s)
    return best


def match_score(query, year, r, first=False):
    """Quanto un risultato TMDB e' quello giusto (circa 0-1.8).
    Serve a non prendere alla cieca il primo risultato: cercando 'Dragon Ball'
    TMDB mette prima 'Dragon Ball Z', che e' piu' popolare.
    Contano il nome, l'anno, quanto il titolo e' conosciuto (a parita' di nome
    vince quello famoso, non l'omonimo che nessuno ha visto) e, un po', il fatto
    di essere il primo risultato di TMDB ('first')."""
    score = name_score(query, r)
    ry = _year(r.get("release_date") or r.get("first_air_date"), None)
    if year and ry:
        d = abs(ry - year)
        if "title" in r:   # film: l'anno nel nome del file e' quello giusto ('Il Padrino 2 (1974)' non e' il primo)
            score += 0.3 if d == 0 else 0.15 if d == 1 else -0.3
        else:              # serie: l'anno puo' essere quello di una stagione
            score += 0.3 if d == 0 else 0.15 if d == 1 else -0.25 if d > 3 else 0
    score += min(math.log10((r.get("vote_count") or 0) + 1), 4) / 16
    return score + (0.1 if first else 0)


EDITION = re.compile(
    r"\b(?:imax|extended(?: (?:edition|cut|version))?|director'?s cut|final cut|theatrical(?: cut)?|"
    r"uncut|unrated|remastered|restored|open matte|criterion|special edition|collector'?s edition|"
    r"ultimate edition|\d+(?:th|st|nd|rd)? anniversary(?: edition)?|"
    r"versione (?:estesa|integrale|restaurata)|edizione (?:speciale|integrale|estesa)|"
    r"mircrew|by \w+)\b", re.I)


LEET = str.maketrans("4013579", "aoiestg")


def search_variants(title, weight=1.0):
    """Modi via via piu' larghi di cercare un titolo scritto in modo 'sporco':
    'Il Cavaliere Oscuro - The Dark Knight IMAX', 'Eyes Wide Shut (by tizio) GRUPPO',
    'L4 D0lc3 V1t4'... Ogni variante ha un peso: quelle che tagliano parole
    valgono meno, cosi' un titolo mozzato non vince su uno intero."""
    out = []

    def add(text, w):
        text = re.sub(r"\s+", " ", text).strip(" -,.")
        if len(text) >= 2 and text.lower() not in [x[0].lower() for x in out]:
            out.append((text, w * weight))

    add(title, 1)
    base = re.sub(r"\([^)]*\)?", " ", title)           # parentesi, anche lasciate aperte
    base = re.sub(r"\s+", " ", EDITION.sub(" ", base)).strip(" -,.")
    add(base, 1)
    parts = [base]
    if " - " in base:                                     # titolo italiano - titolo originale
        parts += [p for p in sorted({x.strip() for x in base.split(" - ")}, key=len, reverse=True)
                  if len(p) >= 3 and not p.isdigit()]
    for part in parts[1:]:
        add(part, 1)
    if "-" in base and " - " not in base:                 # 'Audition-Odishon'
        for part in base.split("-"):
            if len(part.strip()) >= 4:
                add(part, 0.95)
    for part in parts:                                    # 'Harry Potter 4 il calice...' senza il numero
        add(re.sub(r"(?<!\w)\d(?!\w)", " ", part), 0.95)
    if re.search(r"[a-z][0-9]|[0-9][a-z]", base, re.I):   # scritto 'in codice': L4 D0lc3 V1t4
        add(" ".join(w.translate(LEET) if re.search(r"[a-z]", w, re.I) else w
                     for w in base.split()), 1)
    words = base.split()
    if len(words) >= 3:                                   # sigla in fondo al nome
        add(" ".join(words[:-1]), 0.8)
    if len(words) >= 4:
        add(" ".join(words[:-2]), 0.75)
    return out


GOOD_MATCH = 0.9


def find_tmdb(kind, title, year=None, extra=()):
    """Cerca la scheda provando il titolo e le sue varianti, poi gli altri nomi
    possibili in 'extra' (es. le cartelle che lo contengono: [(titolo, anno, peso)]).
    Si ferma al primo risultato che somiglia davvero al nome cercato; se nessuno
    convince, restituisce i risultati della variante andata meglio.
    Il primo elemento della lista e' quello scelto."""
    queries = [(v, w, year) for v, w in search_variants(title)]
    for t, y, w in extra:
        queries += [(v, vw, y or year) for v, vw in search_variants(t, w)]
    # Prima le varianti intere (anche quelle delle cartelle), poi quelle mozzate
    queries.sort(key=lambda q: -q[1])
    best, best_score, done = [], -1.0, set()
    for variant, weight, y in queries:
        if (variant.lower(), y) in done:
            continue
        done.add((variant.lower(), y))
        res = search_tmdb(kind, variant, y, both=True)
        if not res:
            continue
        top = res[0]["id"]
        ranked = sorted(res, key=lambda r: -match_score(variant, y, r, r["id"] == top))
        score = match_score(variant, y, ranked[0], ranked[0]["id"] == top) * weight
        if score > best_score:
            best, best_score = ranked, score
        # Ci si ferma solo se anche il nome corrisponde: un primo risultato con
        # l'anno giusto ma un altro nome ('Madagascar 1' -> 'I pinguini di...') non basta
        if score >= GOOD_MATCH and name_score(variant, ranked[0]) >= 0.9:
            break
    return best


def library_root(path):
    for lib in get_libraries():
        for folder in lib["folders"]:
            if path.startswith(folder.rstrip("/") + "/"):
                return Path(folder)
    return None


def folder_candidates(path):
    """Le cartelle che contengono il video, come nomi alternativi da cercare:
    'Breaking Bad/Breaking Bed S01/...' -> 'Breaking Bad'. La piu' vicina conta di piu'."""
    p = Path(path)
    root = library_root(path)
    folders = p.relative_to(root).parts[:-1] if root else p.parts[-3:-1]
    return [(t, y, 1.0 if i == 0 else 0.9) for i, (t, y) in enumerate(folder_titles(folders))]


def imdb_in_path(path, kind):
    """Id IMDb scritto nel nome del video o delle sue cartelle, o in un file .nfo
    (Kodi, Plex, Jellyfin): 'Film.nfo' / 'movie.nfo' accanto al film, 'tvshow.nfo'
    nella cartella della serie o in quelle sopra, fino alla libreria."""
    p = Path(path)
    root = library_root(path)
    dirs = [p.parent]
    while root is not None and dirs[-1] != root and dirs[-1].parent != dirs[-1] and len(dirs) < 6:
        dirs.append(dirs[-1].parent)
    dirs = [d for d in dirs if d != root]
    # Film: il nome del file e la sua cartella. Serie: le cartelle (il file puo'
    # avere l'id del singolo episodio, che non e' quello della serie)
    names = [p.name] + [d.name for d in dirs[:1]] if kind == "movie" else [d.name for d in dirs]
    nfos = [p.with_suffix(".nfo"), p.parent / "movie.nfo"] if kind == "movie" \
        else [d / "tvshow.nfo" for d in dirs]
    for n in names:
        m = IMDB_ID.search(n)
        if m:
            return m.group(1).lower()
    for nfo in nfos:
        try:
            if nfo.is_file() and nfo.stat().st_size < 1_000_000:
                m = IMDB_ID.search(nfo.read_text("utf-8", "ignore"))
                if m:
                    return m.group(1).lower()
        except OSError:
            pass
    return None


def tmdb_by_imdb(kind, imdb_id):
    """La scheda TMDB che corrisponde a un id IMDb (lista vuota se TMDB non ce l'ha)."""
    if not imdb_id:
        return []
    try:
        res = tmdb(f"/find/{imdb_id}", external_source="imdb_id")
    except urllib.error.HTTPError:
        return []
    return res.get("movie_results" if kind == "movie" else "tv_results") or []


def find_show(con, show):
    row = con.execute("SELECT path FROM items WHERE show_id=? ORDER BY path LIMIT 1",
                      (show["id"],)).fetchone()
    found = tmdb_by_imdb("show", imdb_in_path(row["path"], "show")) if row else []
    if found:
        return found
    extra = [c for c in folder_candidates(row["path"]) if show_key(c[0]) != show_key(show["title"])] \
        if row else []
    return find_tmdb("show", show["title"], show["year"], extra)


def find_movie(r):
    return tmdb_by_imdb("movie", imdb_in_path(r["path"], "movie")) or find_tmdb("movie", r["title"], r["year"])


def merge_duplicate_show(con, show_id):
    """Se la stessa serie e' finita in catalogo due volte con nomi diversi
    ('Griffin' e 'I Griffin'), riunisce gli episodi sotto la prima."""
    s = con.execute("SELECT * FROM shows WHERE id=?", (show_id,)).fetchone()
    if not s or not s["tmdb_id"]:
        return show_id
    keep = con.execute(
        "SELECT id FROM shows WHERE tmdb_id=? AND id<>? AND library_id IS ? ORDER BY id LIMIT 1",
        (s["tmdb_id"], show_id, s["library_id"])).fetchone()
    if not keep:
        return show_id
    con.execute("UPDATE items SET show_id=?, meta_done=0 WHERE show_id=?", (keep["id"], show_id))
    con.execute("UPDATE aliases SET show_id=? WHERE show_id=?", (keep["id"], show_id))
    con.execute("INSERT OR REPLACE INTO aliases(key, show_id) VALUES(?,?)", (s["folder"], keep["id"]))
    con.execute("DELETE FROM shows WHERE id=?", (show_id,))
    return keep["id"]


GENERIC_EP = re.compile(r"^(?:episodio|episode|ep\.?|folge|épisode)\s*\d+$", re.I)


def map_absolute(con, show):
    """Anime numerati di fila ('Dragon Ball Z 001'...'291'): TMDB li divide in
    stagioni. Un 'episodio 45 della stagione 1' quando la stagione 1 ne ha 39
    diventa stagione 2, episodio 6."""
    rows = con.execute("SELECT id, episode FROM items WHERE show_id=? AND season=1 AND meta_done=0",
                       (show["id"],)).fetchall()
    if not rows:
        return
    counts = [(s["season_number"], s.get("episode_count") or 0)
              for s in tmdb(f"/tv/{show['tmdb_id']}").get("seasons", []) if s.get("season_number", 0) > 0]
    counts.sort()
    if not counts or counts[0][0] != 1 or max(r["episode"] for r in rows) <= counts[0][1]:
        return
    total = sum(c for _, c in counts)
    taken = {(r["season"], r["episode"]) for r in con.execute(
        "SELECT season, episode FROM items WHERE show_id=? AND season>1", (show["id"],))}
    for r in rows:
        n = r["episode"]
        if n <= counts[0][1] or n > total:
            continue
        for season, count in counts:
            if n <= count:
                if (season, n) in taken:
                    break     # c'e' gia' il file vero: 'Lost 1x25' non e' l'episodio 2x01
                con.execute("UPDATE items SET season=?, episode=? WHERE id=?", (season, n, r["id"]))
                break
            n -= count


def enrich_episodes(con, show):
    try:
        map_absolute(con, show)
    except urllib.error.HTTPError:
        pass
    todo = con.execute(
        "SELECT id, season, episode, title FROM items WHERE show_id=? AND meta_done=0",
        (show["id"],)).fetchall()
    for season in sorted({r["season"] for r in todo}):
        try:
            eps = {e["episode_number"]: e for e in
                   tmdb(f"/tv/{show['tmdb_id']}/season/{season}").get("episodes", [])}
        except urllib.error.HTTPError:
            eps = {}
        for r in todo:
            if r["season"] != season:
                continue
            e = eps.get(r["episode"])
            if e:
                name = e.get("name") or ""
                if (not name or GENERIC_EP.match(name.strip())) and r["title"]:
                    name = r["title"]   # TMDB non ha il titolo italiano: si tiene quello del file
                con.execute(
                    "UPDATE items SET title=?, overview=?, poster=?, tmdb_id=?, rating=?, meta_done=1, "
                    "meta_at=?, meta_tries=0, released=? WHERE id=?",
                    (name, e.get("overview"),
                     fetch_image(e.get("still_path"), "w300"), e.get("id"),
                     round(e.get("vote_average") or 0, 1), time.time(), e.get("air_date") or None, r["id"]))
            else:                   # TMDB non ha ancora questo episodio: si riprova piu' avanti
                not_found(con, "items", r["id"])
        con.commit()


# --------------------------------------------------------------------------
# Aggiornamento delle schede
# --------------------------------------------------------------------------
# Una scheda non si scarica una volta per sempre: TMDB corregge trame, aggiunge
# traduzioni, locandine e voti, e le serie in corso hanno episodi nuovi. A ogni
# giro della scansione (ogni SCAN_INTERVAL_MIN) si rimettono in coda, al massimo
# REFRESH_BUDGET alla volta e mai mentre qualcuno guarda, le schede che:
#  1. sono cambiate su TMDB (elenco «changes», chiesto una volta al giorno), ma
#     non piu' di una volta ogni CHANGES_GAP;
#  2. sono di serie in corso: il giorno dopo l'uscita di un episodio, altrimenti
#     ogni settimana;
#  3. sono «scadute» secondo l'eta' del titolo: uscito da meno di 6 mesi ogni
#     settimana, da meno di 2 anni ogni mese, piu' vecchio ogni 6 mesi;
#  4. non sono state riconosciute: si riprova dopo 1, 3, 7 giorni, poi ogni mese
#     (TMDB aggiunge titoli di continuo). Lo stesso per gli episodi che TMDB non
#     ha ancora.
# Se cambia la lingua delle schede (TMDB_LANG) tutte tornano in coda, piano piano.
# Un aggiornamento riusa lo stesso ID TMDB (le correzioni fatte con «Correggi
# scheda» restano), non tocca le locandine locali (poster.jpg) e riscarica
# un'immagine solo se su TMDB e' cambiata. Se TMDB non risponde resta tutto com'e'.

DAY = 86400
REFRESH_BUDGET = 40              # schede gia' riconosciute da ricontrollare per giro
RETRY_BUDGET = 10                # titoli non riconosciuti da ricercare per giro (costano piu' chiamate)
RETRY_DAYS = (1, 3, 7, 30)
CHANGES_GAP = 7 * DAY              # i titoli famosi cambiano su TMDB quasi ogni giorno
CHANGES_PAGES = 100              # pagine dell'elenco «changes» (100 titoli l'una) al giorno, per tipo
ONGOING = {"Returning Series", "In Production", "Planned", "Pilot"}
refresh_state = {"due": 0, "queued": 0, "at": 0.0}


def day_ts(text):
    try:
        return calendar.timegm(time.strptime(str(text)[:10], "%Y-%m-%d"))
    except (TypeError, ValueError):
        return None


def age_ttl(date, year, now):
    """Ogni quanto ricontrollare un titolo uscito il giorno 'date' (o nell'anno 'year')."""
    ts = day_ts(date) or (calendar.timegm((int(year), 1, 1, 0, 0, 0)) if year else None)
    if ts is None:
        return 90 * DAY
    age = now - ts
    if age < 183 * DAY:              # anche se non e' ancora uscito
        return 7 * DAY
    if age < 730 * DAY:
        return 30 * DAY
    return 180 * DAY


def retry_after(tries):
    return RETRY_DAYS[min(max(tries, 1), len(RETRY_DAYS)) - 1] * DAY


def show_due(r, now):
    """Quando ricontrollare una serie gia' riconosciuta (e i suoi episodi)."""
    at = r["meta_at"] or 0
    if r["status"] in ONGOING:
        nxt = day_ts(r["next_air"])
        if nxt and at < nxt + DAY:
            return nxt + DAY             # il giorno dopo l'uscita del prossimo episodio
        return at + 7 * DAY
    if not r["status"]:                  # scheda di prima che si salvasse lo stato
        return at + 30 * DAY
    return at + age_ttl(r["last_air"], r["year"], now)


def not_found(con, table, row_id):
    """Nessuna scheda (o episodio non ancora su TMDB): si riprova piu' avanti."""
    con.execute(f"UPDATE {table} SET meta_done=1, meta_at=?, meta_tries=COALESCE(meta_tries, 0)+1 WHERE id=?",
                (time.time(), row_id))


def kept_as_is(con, table, row_id):
    """TMDB non ha piu' questo titolo: resta la scheda che c'era, si riguarda al prossimo giro lungo."""
    con.execute(f"UPDATE {table} SET meta_done=1, meta_at=? WHERE id=?", (time.time(), row_id))


def spread(row_id):
    """Un numero tra 0 e 1 fisso per ogni titolo: serve a non riscaricare tutto lo stesso giorno."""
    return (row_id * 2654435761 % 1000) / 1000


def stamp_unknown(con, now):
    """Schede scaricate prima di questo sistema (meta_at vuoto): ricevono una data
    sparsa nel loro intervallo, cosi' tornano in coda un po' alla volta."""
    for r in con.execute("SELECT id, tmdb_id, year, released FROM items WHERE kind='movie' "
                         "AND meta_done=1 AND meta_at IS NULL").fetchall():
        if r["tmdb_id"]:
            con.execute("UPDATE items SET meta_at=? WHERE id=?",
                        (now - spread(r["id"]) * age_ttl(r["released"], r["year"], now), r["id"]))
        else:
            con.execute("UPDATE items SET meta_at=?, meta_tries=1 WHERE id=?", (now - spread(r["id"]) * DAY, r["id"]))
    for r in con.execute("SELECT id, tmdb_id FROM shows WHERE meta_done=1 AND meta_at IS NULL").fetchall():
        if r["tmdb_id"]:
            con.execute("UPDATE shows SET meta_at=? WHERE id=?", (now - spread(r["id"]) * 30 * DAY, r["id"]))
        else:
            con.execute("UPDATE shows SET meta_at=?, meta_tries=1 WHERE id=?", (now - spread(r["id"]) * DAY, r["id"]))
    con.execute("UPDATE items SET meta_at=?-((id*2654435761)%1000)/1000.0*86400, meta_tries=1 "
                "WHERE kind='episode' AND meta_done=1 AND meta_at IS NULL AND tmdb_id IS NULL", (now,))
    con.commit()


def lang_check(con):
    """Cambiata la lingua delle schede: tutte tornano in coda (un po' alla volta)."""
    with config_lock:
        old = config.get("meta_lang")
        if old == TMDB_LANG:
            return
        config["meta_lang"] = TMDB_LANG
        save_config()
    if old:
        print("Lingua delle schede cambiata:", old, "->", TMDB_LANG, flush=True)
        con.execute("UPDATE items SET meta_at=0 WHERE kind='movie' AND tmdb_id IS NOT NULL")
        con.execute("UPDATE shows SET meta_at=0 WHERE tmdb_id IS NOT NULL")
        con.commit()


def tmdb_changes(con, now):
    """Una volta al giorno: quali titoli del catalogo sono cambiati su TMDB.
    Quelli non ricontrollati da almeno CHANGES_GAP vanno in testa alla coda."""
    last = float(config.get("tmdb_changes_at") or 0)
    if now - last < DAY:
        return
    start = time.strftime("%Y-%m-%d", time.gmtime(max(last, now - 13 * DAY) if last else now - DAY))
    end = time.strftime("%Y-%m-%d", time.gmtime(now))
    found = 0
    for path, table, kind in (("/movie/changes", "items", "AND kind='movie'"), ("/tv/changes", "shows", "")):
        mine = {r[0] for r in con.execute(f"SELECT tmdb_id FROM {table} WHERE tmdb_id IS NOT NULL {kind}")}
        if not mine:
            continue
        changed, page, pages = set(), 1, 1
        while page <= min(pages, CHANGES_PAGES):
            res = tmdb(path, start_date=start, end_date=end, page=page)
            pages = int(res.get("total_pages") or 1)
            changed |= {r["id"] for r in res.get("results") or [] if r.get("id") in mine}
            page += 1
        for tid in changed:
            found += con.execute(f"UPDATE {table} SET meta_at=0 WHERE tmdb_id=? {kind} AND meta_done=1 "
                                 f"AND COALESCE(meta_at, 0) < ?", (tid, now - CHANGES_GAP)).rowcount
    con.commit()
    with config_lock:
        config["tmdb_changes_at"] = now
        save_config()
    if found:
        print(f"Schede cambiate su TMDB: {found}", flush=True)


def plan_refresh(con):
    """Rimette in coda (meta_done=0) le schede da ricontrollare: la scansione le scarica."""
    if updater.busy():               # qualcuno sta guardando: niente lavoro in piu'
        return
    now = time.time()
    lang_check(con)
    stamp_unknown(con, now)
    try:
        tmdb_changes(con, now)
    except Exception as ex:          # rete o TMDB giu': restano i controlli per eta'
        print("Novita' da TMDB non lette:", repr(ex), flush=True)
    fresh, retry, eps = [], [], []
    for r in con.execute("SELECT id, tmdb_id, year, released, meta_at, meta_tries FROM items "
                         "WHERE kind='movie' AND meta_done=1").fetchall():
        at = r["meta_at"] or 0
        if r["tmdb_id"]:
            due = at + age_ttl(r["released"], r["year"], now)
            if due <= now:
                fresh.append((1, due, "items", r["id"]))
        elif at + retry_after(r["meta_tries"]) <= now:
            retry.append((at, "items", r["id"]))
    for r in con.execute("SELECT id, tmdb_id, year, status, next_air, last_air, meta_at, meta_tries FROM shows "
                         "WHERE meta_done=1").fetchall():
        if r["tmdb_id"]:
            due = show_due(r, now)
            if due <= now:
                airing = r["status"] in ONGOING and (r["meta_at"] or 0) > 0
                fresh.append((0 if airing else 1, due, "shows", r["id"]))
        elif (r["meta_at"] or 0) + retry_after(r["meta_tries"]) <= now:
            retry.append((r["meta_at"] or 0, "shows", r["id"]))
    for r in con.execute("SELECT i.id, i.meta_at, i.meta_tries FROM items i JOIN shows s ON s.id=i.show_id "
                         "WHERE i.kind='episode' AND i.meta_done=1 AND i.tmdb_id IS NULL "
                         "AND s.tmdb_id IS NOT NULL").fetchall():
        if (r["meta_at"] or 0) + retry_after(r["meta_tries"]) <= now:
            eps.append(r["id"])
    fresh.sort()
    retry.sort()
    picked = [(t, i) for _, _, t, i in fresh[:REFRESH_BUDGET]] + [(t, i) for _, t, i in retry[:RETRY_BUDGET]]
    for table, row_id in picked:
        con.execute(f"UPDATE {table} SET meta_done=0 WHERE id=?", (row_id,))
    con.executemany("UPDATE items SET meta_done=0 WHERE id=?", [(i,) for i in eps[:300]])
    con.commit()
    refresh_state.update(due=len(fresh) + len(retry) - len(picked), queued=len(picked), at=now)
    if picked:
        print(f"Schede da ricontrollare: {len(picked)} (in attesa: {refresh_state['due']})", flush=True)


def catalog_status(con):
    """Per Impostazioni → Catalogo: come procede l'aggiornamento delle schede."""
    now = time.time()
    week = now - 7 * DAY
    retry = [(r["meta_at"] or 0) + retry_after(r["meta_tries"]) for r in con.execute(
        "SELECT meta_at, meta_tries FROM items WHERE kind='movie' AND tmdb_id IS NULL AND meta_done=1 "
        "UNION ALL SELECT meta_at, meta_tries FROM shows WHERE tmdb_id IS NULL AND meta_done=1")]
    today = time.strftime("%Y-%m-%d", time.gmtime(now))
    nxt = con.execute("SELECT title, next_air FROM shows WHERE status IN ({}) AND next_air >= ? "
                      "ORDER BY next_air LIMIT 1".format(",".join("?" * len(ONGOING))),
                      (*ONGOING, today)).fetchone()
    return {
        "changes_at": float(config.get("tmdb_changes_at") or 0),
        "refreshed": con.execute("SELECT (SELECT COUNT(*) FROM items WHERE kind='movie' AND tmdb_id IS NOT NULL "
                                 "AND meta_at > ?) + (SELECT COUNT(*) FROM shows WHERE tmdb_id IS NOT NULL "
                                 "AND meta_at > ?)", (week, week)).fetchone()[0],
        "waiting": refresh_state["due"],
        "unmatched_shows": con.execute("SELECT COUNT(*) FROM shows WHERE tmdb_id IS NULL").fetchone()[0],
        "next_retry": min(retry) if retry else 0,
        "ongoing": con.execute("SELECT COUNT(*) FROM shows WHERE status IN ({})".format(
            ",".join("?" * len(ONGOING))), tuple(ONGOING)).fetchone()[0],
        "next_episode": {"title": nxt["title"], "date": nxt["next_air"]} if nxt else None,
    }


# --------------------------------------------------------------------------
# Scansione libreria
# --------------------------------------------------------------------------

state = {"scanning": False, "last_scan": 0.0, "message": ""}
scan_lock = threading.Lock()


def frame_rate(stream):
    """Fotogrammi al secondo di un flusso video di ffprobe (24000/1001 -> 23.976); 0 se non si sa."""
    for key in ("avg_frame_rate", "r_frame_rate"):
        try:
            num, _, den = str(stream.get(key) or "").partition("/")
            fps = float(num) / float(den or 1)
        except (ValueError, ZeroDivisionError):
            continue
        if 10 <= fps <= 121:
            return round(fps, 3)
    return 0


def video_fps(con, r):
    """Fps del file, misurati la prima volta che serve (i file analizzati prima non li hanno)."""
    if r["fps"] is not None:
        return r["fps"] or 0
    fps = 0
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
             "stream=avg_frame_rate,r_frame_rate", "-of", "json", r["path"]],
            capture_output=True, text=True, timeout=15).stdout
        streams = json.loads(out).get("streams") or []
        fps = frame_rate(streams[0]) if streams else 0
    except Exception:
        return 0                     # disco lento o scollegato: si riprova la prossima volta
    con.execute("UPDATE main.items SET fps=? WHERE id=?", (fps, r["id"]))   # items qui e' la vista dell'account
    con.commit()
    return fps


def probe(path):
    """Durata, codec, risoluzione e fps del file."""
    info = {"duration": 0, "vcodec": "", "acodec": "", "pix": "", "width": 0, "height": 0, "fps": 0}
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries",
             "format=duration:stream=codec_type,codec_name,pix_fmt,width,height,avg_frame_rate,r_frame_rate",
             "-of", "json", path],
            capture_output=True, text=True, timeout=60).stdout
        data = json.loads(out)
        info["duration"] = float(data.get("format", {}).get("duration") or 0)
        for s in data.get("streams", []):
            if s.get("codec_type") == "video" and not info["vcodec"] \
                    and s.get("codec_name") not in ("mjpeg", "png"):
                info.update(vcodec=s.get("codec_name", ""), pix=s.get("pix_fmt", ""),
                            width=s.get("width") or 0, height=s.get("height") or 0,
                            fps=frame_rate(s))
            elif s.get("codec_type") == "audio" and not info["acodec"]:
                info["acodec"] = s.get("codec_name", "")
    except Exception:
        pass
    return info


def scan():
    if not scan_lock.acquire(blocking=False):
        return
    state["scanning"] = True
    con = db()
    new_ids, lib_before, gone_names = [], {}, set()
    try:
        now = time.time()
        seen = set()
        known = {r["path"]: r["library_id"] for r in con.execute("SELECT path, library_id FROM items")}
        libs = get_libraries()
        roots = [(Path(p), lib["id"]) for lib in libs for p in lib["folders"]]
        every_root = {str(r) for r, _ in roots}
        show_ids = {r["folder"]: r["id"] for r in con.execute("SELECT id, folder FROM shows")}
        # Nomi diversi della stessa serie ("Griffin" e "I Griffin") gia' riuniti in passato
        show_ids.update({r["key"]: r["show_id"] for r in con.execute(
            "SELECT key, show_id FROM aliases WHERE show_id IN (SELECT id FROM shows)")})
        sibling_cache = {}
        found = 0
        # Per le notifiche: i titoli nuovi di questo giro, e quanti ne aveva gia' ogni raccolta
        for lib_id in known.values():
            lib_before[lib_id] = lib_before.get(lib_id, 0) + 1

        for root, lib_id in roots:
            if not root.is_dir():
                continue
            state["message"] = f"Leggo {display_path(root)}..."
            for p in walk_videos(root, every_root - {str(root)}):
                sp = str(p)
                seen.add(sp)
                if sp in known:
                    if known[sp] != lib_id:   # la cartella e' passata a un'altra raccolta
                        con.execute("UPDATE items SET library_id=? WHERE path=?", (lib_id, sp))
                        con.execute("UPDATE shows SET library_id=? WHERE id=(SELECT show_id FROM items WHERE path=?)",
                                    (lib_id, sp))
                        known[sp] = lib_id
                    continue
                st = p.stat()
                added = min(st.st_mtime, now)
                episode = classify(p, root, sibling_cache)
                if episode is None:
                    # Film
                    title, year = parse_title(p.stem)
                    if year is None and p.parent != root:
                        t2, y2 = parse_title(p.parent.name)
                        if y2:
                            title, year = t2, y2
                    cur = con.execute(
                        "INSERT INTO items(kind, path, title, year, size, added_at, library_id) "
                        "VALUES('movie',?,?,?,?,?,?)", (sp, title, year, st.st_size, added, lib_id))
                    new_ids.append(cur.lastrowid)
                    art = local_art(video=p, folder=p.parent if p.parent != root else None)
                    if art:
                        con.execute("UPDATE items SET poster=? WHERE id=?",
                                    (store_local_art(art, "m", cur.lastrowid), cur.lastrowid))
                else:
                    # Episodio: la serie viene creata la prima volta che la si incontra
                    title, year, season, number, ep_title = episode
                    key = show_key(title)
                    if key not in show_ids:
                        cur = con.execute(
                            "INSERT INTO shows(folder, title, year, added_at, library_id) VALUES(?,?,?,?,?)",
                            (key, title, year, now, lib_id))
                        show_ids[key] = cur.lastrowid
                    new_ids.append(con.execute(
                        "INSERT INTO items(kind, path, show_id, season, episode, title, size, added_at, library_id) "
                        "VALUES('episode',?,?,?,?,?,?,?,?)",
                        (sp, show_ids[key], season, number, ep_title, st.st_size, added, lib_id)).lastrowid)
                known[sp] = lib_id
                found += 1
                if found % 25 == 0:   # i titoli compaiono nell'app man mano, non tutti alla fine
                    con.commit()
                    state["message"] = f"Leggo {display_path(root)}... {found} nuovi video"
            con.commit()

        # Toglie dalla libreria i file spariti. Se pero' la loro cartella non e'
        # raggiungibile (disco esterno scollegato) restano, per non perdere la libreria.
        # Se intanto le cartelle sono cambiate (aggiunte, tolte, percorso aggiornato)
        # questo giro non toglie niente: l'elenco letto all'inizio non vale piu',
        # e subito dopo parte un nuovo controllo.
        changed = get_libraries() != libs
        online = [(str(r), has_content(r)) for r, _ in roots]
        for r in con.execute("SELECT id, path, kind FROM items").fetchall():
            if r["path"] in seen or changed:
                continue
            owners = [ok for root, ok in online if r["path"].startswith(root + "/")]
            if not owners or any(owners):
                con.execute("DELETE FROM items WHERE id=?", (r["id"],))
                gone_names.add(os.path.basename(r["path"]).lower())
                (IMG / f"thumb_{r['id']}.jpg").unlink(missing_ok=True)
        con.execute("DELETE FROM shows WHERE id NOT IN "
                    "(SELECT DISTINCT show_id FROM items WHERE show_id IS NOT NULL)")
        con.execute("DELETE FROM aliases WHERE show_id NOT IN (SELECT id FROM shows)")
        con.commit()

        state["message"] = "Analizzo i file video..."
        for r in con.execute("SELECT id, path FROM items WHERE duration IS NULL").fetchall():
            i = probe(r["path"])
            con.execute(
                "UPDATE items SET duration=?, vcodec=?, acodec=?, pix=?, width=?, height=?, fps=? WHERE id=?",
                (i["duration"], i["vcodec"], i["acodec"], i["pix"], i["width"], i["height"], i["fps"], r["id"]))
            con.commit()

        con.commit()

        if tmdb_key():
            state["message"] = "Scarico locandine e schede..."
            try:
                plan_refresh(con)    # schede da ricontrollare: rimesse in coda (meta_done=0)
                todo = con.execute("SELECT * FROM items WHERE kind='movie' AND meta_done=0").fetchall()
                for n, r in enumerate(todo, 1):
                    state["message"] = f"Scarico locandine e schede dei film... {n} di {len(todo)}"
                    tmdb_id = r["tmdb_id"]   # gia' abbinato: si riscarica la stessa scheda
                    if not tmdb_id:
                        res = find_movie(r)
                        tmdb_id = res[0]["id"] if res else None
                    if tmdb_id:
                        try:
                            apply_movie(con, r["id"], tmdb_id)
                        except urllib.error.HTTPError as ex:
                            if ex.code != 404:
                                raise
                            kept_as_is(con, "items", r["id"])   # tolto da TMDB: resta la scheda che c'era
                    else:
                        not_found(con, "items", r["id"])
                    con.commit()
                # Saghe: i film che avevano gia' la scheda prima che esistessero le saghe
                todo = con.execute("SELECT id, tmdb_id FROM items WHERE kind='movie' "
                                   "AND tmdb_id IS NOT NULL AND coll_done=0").fetchall()
                for n, r in enumerate(todo, 1):
                    state["message"] = f"Riunisco i film in saghe... {n} di {len(todo)}"
                    try:
                        m = tmdb(f"/movie/{r['tmdb_id']}")
                    except urllib.error.HTTPError as ex:
                        if ex.code != 404:
                            raise
                        m = {}
                    set_collection(con, r["id"], m)
                    con.commit()
                state["message"] = "Scarico le schede delle serie..."
                for r in con.execute("SELECT * FROM shows WHERE meta_done=0").fetchall():
                    tmdb_id = r["tmdb_id"]
                    if not tmdb_id:
                        res = find_show(con, r)
                        tmdb_id = res[0]["id"] if res else None
                    if tmdb_id:
                        try:
                            apply_show(con, r["id"], tmdb_id)
                            merge_duplicate_show(con, r["id"])
                        except urllib.error.HTTPError as ex:
                            if ex.code != 404:
                                raise
                            kept_as_is(con, "shows", r["id"])
                    else:
                        not_found(con, "shows", r["id"])
                    con.commit()
                todo = con.execute("SELECT * FROM shows WHERE tmdb_id IS NOT NULL").fetchall()
                for n, r in enumerate(todo, 1):
                    state["message"] = f"Scarico i titoli degli episodi... serie {n} di {len(todo)}"
                    enrich_episodes(con, r)
                # Foto del cast: i titoli che avevano gia' la scheda prima che esistessero
                todo = [("items", "movie", r) for r in con.execute(
                    "SELECT id, tmdb_id FROM items WHERE kind='movie' AND tmdb_id IS NOT NULL "
                    "AND people IS NULL").fetchall()]
                todo += [("shows", "tv", r) for r in con.execute(
                    "SELECT id, tmdb_id FROM shows WHERE tmdb_id IS NOT NULL AND people IS NULL").fetchall()]
                for n, (table, kind, r) in enumerate(todo, 1):
                    state["message"] = f"Scarico le foto del cast... {n} di {len(todo)}"
                    try:
                        credits = tmdb(f"/{kind}/{r['tmdb_id']}/credits")
                    except urllib.error.HTTPError as ex:
                        if ex.code != 404:
                            raise
                        credits = {}
                    con.execute(f"UPDATE {table} SET people=? WHERE id=?", (cast_people(credits), r["id"]))
                    con.commit()
                # Id IMDb: i titoli che avevano gia' la scheda prima che si salvasse
                # ('' = TMDB non lo conosce, non si richiede piu')
                todo = [("items", "movie", r) for r in con.execute(
                    "SELECT id, tmdb_id FROM items WHERE kind='movie' AND tmdb_id IS NOT NULL "
                    "AND imdb_id IS NULL").fetchall()]
                todo += [("shows", "tv", r) for r in con.execute(
                    "SELECT id, tmdb_id FROM shows WHERE tmdb_id IS NOT NULL AND imdb_id IS NULL").fetchall()]
                for n, (table, kind, r) in enumerate(todo, 1):
                    state["message"] = f"Collego le schede a IMDb... {n} di {len(todo)}"
                    try:
                        ext = tmdb(f"/{kind}/{r['tmdb_id']}/external_ids")
                    except urllib.error.HTTPError as ex:
                        if ex.code != 404:
                            raise
                        ext = {}
                    con.execute(f"UPDATE {table} SET imdb_id=? WHERE id=?", (ext.get("imdb_id") or "", r["id"]))
                    con.commit()
            except Exception as ex:  # rete assente, chiave errata...
                state["message"] = f"TMDB non raggiungibile: {ex}"
                print("TMDB error:", repr(ex), flush=True)
                return
        state["message"] = ""
    except Exception as ex:
        state["message"] = f"Errore scansione: {ex}"
        print("Scan error:", repr(ex), flush=True)
    finally:
        con.close()
        try:
            if new_ids:
                announce_new(new_ids, lib_before, gone_names)
        except Exception as ex:
            print("Notifiche dei titoli nuovi non preparate:", repr(ex), flush=True)
        state["last_scan"] = time.time()
        again = state.pop("again", False)
        state["scanning"] = again
        scan_lock.release()
        if again:   # nel frattempo sono cambiate le cartelle: si ricontrolla subito
            threading.Thread(target=scan, daemon=True).start()


def scan_async():
    if state["scanning"]:
        state["again"] = True
    else:
        state["scanning"] = True
    threading.Thread(target=scan, daemon=True).start()


def split_merged_shows():
    """Una volta sola, dopo il miglioramento degli abbinamenti: le serie diverse
    finite insieme per errore (Dragon Ball e Dragon Ball Z, abbinate entrambe a
    DBZ e poi riunite) vengono separate. Si separa un gruppo di episodi solo se
    il nuovo abbinamento e' sicuro: le correzioni fatte a mano restano.
    Visti e punto di ripresa non si perdono: gli episodi cambiano solo serie."""
    if config.get("classifier", 1) >= 3 or not tmdb_key():
        return
    con = db()
    try:
        cache = {}
        for show in con.execute("SELECT * FROM shows WHERE tmdb_id IS NOT NULL").fetchall():
            groups = {}
            for it in con.execute("SELECT id, path FROM items WHERE show_id=?", (show["id"],)).fetchall():
                root = library_root(it["path"])
                ep = classify(Path(it["path"]), root, cache) if root else None
                if ep:
                    groups.setdefault(show_key(ep[0]), {"title": ep[0], "year": ep[1], "items": []}
                                      )["items"].append((it["id"], ep[4], it["path"]))
            if len(groups) < 2:
                continue
            # A quale scheda TMDB va ogni gruppo: una nuova solo se sicura, se no resta dov'e'
            for key, g in groups.items():
                first = sorted(g["items"], key=lambda x: x[2])[0][2]
                extra = [c for c in folder_candidates(first) if show_key(c[0]) != key]
                res = find_tmdb("show", g["title"], g["year"], extra)
                sure = res and max(name_score(t, res[0]) * w
                                   for t, y, w in [(g["title"], g["year"], 1)] + extra) >= GOOD_MATCH
                g["tmdb"] = res[0]["id"] if sure else show["tmdb_id"]
            if len({g["tmdb"] for g in groups.values()}) < 2:
                continue
            main = groups.get(show["folder"]) or next(iter(groups.values()))
            targets = {main["tmdb"]: show["id"]}
            if main["tmdb"] != show["tmdb_id"]:
                con.execute("UPDATE shows SET title=?, year=?, tmdb_id=?, poster=NULL, backdrop=NULL, "
                            "meta_done=0 WHERE id=?", (main["title"], main["year"], main["tmdb"], show["id"]))
            for key, g in groups.items():
                if g["tmdb"] not in targets:
                    con.execute("DELETE FROM aliases WHERE key=?", (key,))
                    targets[g["tmdb"]] = con.execute(
                        "INSERT INTO shows(folder, title, year, tmdb_id, added_at, library_id, meta_done) "
                        "VALUES(?,?,?,?,?,?,0)",
                        (key, g["title"], g["year"], g["tmdb"], show["added_at"], show["library_id"])).lastrowid
                elif g is not main:
                    con.execute("INSERT OR REPLACE INTO aliases(key, show_id) VALUES(?,?)",
                                (key, targets[g["tmdb"]]))
                print(f"«{g['title']}»: {len(g['items'])} episodi -> TMDB {g['tmdb']}", flush=True)
                for item_id, ep_title, _ in g["items"]:
                    con.execute("UPDATE items SET show_id=?, title=?, poster=NULL, tmdb_id=NULL, "
                                "overview=NULL, meta_done=0 WHERE id=?", (targets[g["tmdb"]], ep_title, item_id))
            con.commit()
        # Film con una scheda che non c'entra col nome del file ('Ran (Kurosawa 1985)'
        # abbinato a un documentario su Kurosawa): si correggono se ora il risultato e' sicuro.
        # Quelli il cui nome somiglia gia' alla scheda (o corretti a mano) non si toccano.
        for r in con.execute("SELECT * FROM items WHERE kind='movie' AND tmdb_id IS NOT NULL").fetchall():
            p, root = Path(r["path"]), library_root(r["path"])
            title, year = parse_title(p.stem)
            if year is None and root and p.parent != root:
                t2, y2 = parse_title(p.parent.name)
                if y2:
                    title, year = t2, y2
            if max(name_score(v, {"title": r["title"], "original_title": r["original_title"]})
                   for v, _ in search_variants(title)) >= 0.75:
                continue
            res = find_tmdb("movie", title, year)
            if res and res[0]["id"] != r["tmdb_id"] and name_score(title, res[0]) >= 0.9                     and (not year or abs(_year(res[0].get("release_date"), year) - year) <= 1):
                print(f"Correggo «{r['title']}» -> «{res[0].get('title')}» ({p.name})", flush=True)
                apply_movie(con, r["id"], res[0]["id"])
                con.commit()
    finally:
        con.close()
    with config_lock:
        config["classifier"] = 3
        save_config()


def reclassify_catalog():
    """Una volta sola, dopo il miglioramento del riconoscimento delle serie
    (miniserie con puntate lunghe come Band of Brothers, nomi di file con un
    errore di battitura come 'True.Detectives.S02E01', poi stagione ed episodio
    separati da un trattino come 'House of Cards - S01 - 01'): si rilegge ogni video gia'
    in catalogo e quelli che ora risultano altro cambiano posto. Gli id dei
    video restano gli stessi, quindi visti e punti di ripresa non si perdono."""
    if config.get("classifier", 1) not in (3, 4, 5):   # prima va fatta la separazione delle serie
        return
    con = db()
    missing = False
    try:
        show_ids = {r["folder"]: r["id"] for r in con.execute("SELECT id, folder FROM shows")}
        show_ids.update({r["key"]: r["show_id"] for r in con.execute(
            "SELECT key, show_id FROM aliases WHERE show_id IN (SELECT id FROM shows)")})
        cache, touched = {}, set()
        rows = con.execute("SELECT id, kind, path, show_id, season, episode, library_id FROM items").fetchall()
        # Quanti file ha ogni episodio salvato: due file sullo stesso episodio con nomi diversi
        # ('S01 - 02' letto 1x01 dalla vecchia versione) vanno riletti
        slots = collections.Counter((r["show_id"], r["season"], r["episode"]) for r in rows if r["kind"] == "episode")
        for it in rows:
            p, root = Path(it["path"]), library_root(it["path"])
            if root is None or not p.is_file():
                missing = missing or root is not None
                continue
            ep = classify(p, root, cache)
            if ep is None:
                continue          # da episodio a film non succede con queste modifiche
            title, year, season, number, ep_title = ep
            key = show_key(title)
            if it["kind"] == "episode" and show_ids.get(key) == it["show_id"]:
                if (it["season"], it["episode"]) != (season, number) and \
                        slots[(it["show_id"], it["season"], it["episode"])] > 1:
                    print(f"Correggo {p.name} -> {season}x{number:02d}", flush=True)
                    con.execute("UPDATE items SET season=?, episode=?, meta_done=0 WHERE id=?",
                                (season, number, it["id"]))
                continue
            if key not in show_ids:
                show_ids[key] = con.execute(
                    "INSERT INTO shows(folder, title, year, added_at, library_id) VALUES(?,?,?,?,?)",
                    (key, title, year, time.time(), it["library_id"])).lastrowid
            print(f"Riclassifico {p.name} -> «{title}» {season}x{number:02d}", flush=True)
            con.execute(
                "UPDATE items SET kind='episode', show_id=?, season=?, episode=?, title=?, "
                "original_title=NULL, year=NULL, overview=NULL, tagline=NULL, poster=NULL, backdrop=NULL, "
                "tmdb_id=NULL, imdb_id=NULL, imdb_rating=NULL, poster_pick=NULL, genres=NULL, director=NULL, actors=NULL, people=NULL, rating=NULL, "
                "collection_id=NULL, meta_done=0 WHERE id=?",
                (show_ids[key], season, number, ep_title, it["id"]))
            (IMG / f"thumb_{it['id']}.jpg").unlink(missing_ok=True)
            touched.add(it["show_id"])
        # Le serie rimaste senza episodi (es. 'True Detectives' del 1990) spariscono
        for show_id in touched - {None}:
            if not con.execute("SELECT 1 FROM items WHERE show_id=? LIMIT 1", (show_id,)).fetchone():
                con.execute("DELETE FROM aliases WHERE show_id=?", (show_id,))
                con.execute("DELETE FROM user_shows WHERE show_id=?", (show_id,))
                con.execute("DELETE FROM shows WHERE id=?", (show_id,))
        con.commit()
    finally:
        con.close()
    if not missing:           # un disco scollegato: si riprova al prossimo avvio
        with config_lock:
            config["classifier"] = 6
            save_config()


def auto_relocate():
    """Su un altro PC il disco puo' avere un'altra lettera: se una cartella della
    libreria non c'e' piu' ma la stessa cartella (stesso percorso, e dentro almeno
    uno dei video gia' in catalogo) sta su un altro disco, il percorso viene
    aggiornato da solo. Schede, visti e punti di ripresa restano."""
    get_libraries()
    with config_lock:
        con = db()
        try:
            changed = False
            for lib in config["libraries"]:
                for n, old in enumerate(list(lib["folders"])):
                    if has_content(Path(old)):
                        continue
                    new = moved_folder(old)
                    if not new or any(new in other["folders"] for other in config["libraries"]):
                        continue
                    sample = [r["path"] for r in con.execute(
                        "SELECT path FROM items WHERE substr(path, 1, ?) = ? LIMIT 8",
                        (len(old) + 1, old + "/"))]
                    if sample and not any(os.path.isfile(new + p[len(old):]) for p in sample):
                        continue
                    con.execute("UPDATE OR REPLACE items SET path = ? || substr(path, ?) "
                                "WHERE substr(path, 1, ?) = ?",
                                (new, len(old) + 1, len(old) + 1, old + "/"))
                    lib["folders"][n] = new
                    changed = True
                    print(f"Percorso aggiornato: {display_path(old)} -> {display_path(new)}", flush=True)
            if changed:
                con.commit()
                save_config()
        finally:
            con.close()


def drives_loop():
    """Segue i dischi del computer: quando se ne collega o stacca uno, le cartelle
    che si erano spostate (altra lettera, altro computer) si riallineano e le
    raccolte si rileggono subito, senza aspettare il controllo periodico."""
    seen = None
    while True:
        time.sleep(15)
        try:
            now = {str(d) for d in drive_roots() if has_content(d)}
            if seen is not None and now != seen:
                print("Dischi cambiati:", ", ".join(sorted(display_path(d) for d in now)) or "nessuno", flush=True)
                auto_relocate()
                scan_async()
            seen = now
        except Exception as ex:
            print("Controllo dischi non riuscito:", repr(ex), flush=True)


IMDB_RATINGS_URL = "https://datasets.imdbws.com/title.ratings.tsv.gz"


def imdb_ratings(force=False):
    """Voti IMDb dei titoli in catalogo. IMDb non ha un'API gratuita, ma pubblica
    ogni giorno un file con tutti i voti (title.ratings.tsv.gz, circa 8 MB, uso
    personale): si scarica al massimo una volta al giorno (prima, se ci sono titoli
    nuovi ancora senza voto, ogni 6 ore) e si tengono solo i titoli che ci sono qui."""
    con = db()
    try:
        want = {}
        for table in ("items", "shows"):
            for r in con.execute(f"SELECT id, imdb_id, imdb_rating FROM {table} WHERE imdb_id LIKE 'tt%'"):
                want.setdefault(r["imdb_id"], []).append((table, r["id"], r["imdb_rating"]))
        if not want:
            return
        last = float(config.get("imdb_ratings_at") or 0)
        fresh = any(v[2] is None for refs in want.values() for v in refs)
        if not force and time.time() - last < (6 if fresh else 24) * 3600:
            return
        found = {}
        req = urllib.request.Request(IMDB_RATINGS_URL, headers={"User-Agent": "media-server"})
        with urllib.request.urlopen(req, timeout=60) as r, gzip.GzipFile(fileobj=r) as gz:
            for line in io.TextIOWrapper(gz, "utf-8"):
                tconst, _, rest = line.partition("\t")
                if tconst in want:
                    rating, _, votes = rest.strip().partition("\t")
                    try:
                        found[tconst] = (float(rating), int(votes))
                    except ValueError:
                        pass
        for tconst, refs in want.items():
            rating, votes = found.get(tconst, (0, 0))   # 0: IMDb non ha ancora voti per questo titolo
            for table, row_id, _ in refs:
                con.execute(f"UPDATE {table} SET imdb_rating=?, imdb_votes=? WHERE id=?", (rating, votes, row_id))
        con.commit()
        print(f"Voti IMDb aggiornati: {len(found)} titoli su {len(want)}", flush=True)
    finally:
        con.close()
    with config_lock:
        config["imdb_ratings_at"] = time.time()
        save_config()


def scan_loop():
    try:
        split_merged_shows()
    except Exception as ex:   # rete assente: si riprova al prossimo avvio
        print("Separazione serie non riuscita:", repr(ex), flush=True)
    try:
        reclassify_catalog()
    except Exception as ex:
        print("Riclassificazione non riuscita:", repr(ex), flush=True)
    if config.get("show_posters", 0) < 1:
        # Una volta sola: le serie riprendono la scheda con la nuova scelta della
        # locandina (vedi show_poster), al prossimo giro della scansione
        con = db(raw=True)
        try:
            con.execute("UPDATE shows SET meta_done=0 WHERE tmdb_id IS NOT NULL")
            con.commit()
        finally:
            con.close()
        with config_lock:
            config["show_posters"] = 1
            save_config()
    while True:
        try:
            auto_relocate()
        except Exception as ex:
            print("Aggiornamento percorsi non riuscito:", repr(ex), flush=True)
        scan()
        try:
            imdb_ratings()
        except Exception as ex:   # IMDb non raggiungibile: si riprova al prossimo giro
            print("Voti IMDb non scaricati:", repr(ex), flush=True)
        time.sleep(max(1, SCAN_INTERVAL_MIN) * 60)


# --------------------------------------------------------------------------
# Serializzazione
# --------------------------------------------------------------------------

def img_url(name):
    return f"/api/image/{name}" if name else None


def jlist(text):
    try:
        return json.loads(text) if text else []
    except ValueError:
        return []


def quality(r):
    w, h = r["width"] or 0, r["height"] or 0
    if w >= 3800 or h >= 2000:
        return "4K"
    if w >= 1900 or h >= 1000:
        return "1080p"
    if w >= 1260 or h >= 700:
        return "720p"
    return "SD" if (w or h) else ""


def item_json(r, show=None):
    d = {k: r[k] for k in ("id", "kind", "title", "original_title", "year", "overview",
                           "tagline", "duration", "position", "watched", "season",
                           "episode", "show_id", "added_at", "director", "rating",
                           "library_id")}
    d["watched"] = bool(d["watched"])
    d["fav"] = bool(r["fav"])
    d["genres"] = jlist(r["genres"])
    d["actors"] = jlist(r["actors"])
    d["quality"] = quality(r)
    d["thumb"] = img_url(r["poster"]) if r["kind"] == "episode" and r["poster"] else f"/api/thumb/{r['id']}"
    d["poster"] = img_url(r["poster"]) if r["kind"] == "movie" else None
    d["backdrop"] = img_url(r["backdrop"])
    d["matched"] = bool(r["tmdb_id"])
    d["imdb"] = (r["imdb_id"] if "imdb_id" in r.keys() else None) or None
    d["imdb_rating"] = (r["imdb_rating"] if "imdb_rating" in r.keys() else None) or None
    # Su un disco scollegato: la scheda resta, con il posto dove dovrebbe trovarsi il file
    path = r["path"] if "path" in r.keys() else None
    if path and is_offline(path):
        d["offline"] = True
        d["where"] = display_path(path)
        d["disk"] = disk_of(path)[0]
    if r["kind"] == "episode":
        if not d["title"]:
            d["title"] = f"Episodio {r['episode']}"
        if show is not None:
            d["show_title"] = show["title"]
            d["poster"] = img_url(show["poster"])
            d["backdrop"] = img_url(show["backdrop"])
    return d


def show_json(con, r):
    d = {k: r[k] for k in ("id", "title", "original_title", "year", "overview",
                           "added_at", "director", "rating", "library_id")}
    d["kind"] = "show"
    d["imdb"] = (r["imdb_id"] if "imdb_id" in r.keys() else None) or None
    d["imdb_rating"] = (r["imdb_rating"] if "imdb_rating" in r.keys() else None) or None
    d["fav"] = bool(r["fav"])
    d["genres"] = jlist(r["genres"])
    d["actors"] = jlist(r["actors"])
    d["poster"] = img_url(r["poster"])
    d["backdrop"] = img_url(r["backdrop"])
    d["matched"] = bool(r["tmdb_id"])
    c = con.execute(
        "SELECT COUNT(*) n, SUM(watched) w, MIN(id) first, MAX(added_at) latest, "
        "COUNT(DISTINCT season) s, MAX(width) width, MAX(height) height "
        "FROM items WHERE show_id=?", (r["id"],)).fetchone()
    d["episodes"] = c["n"]
    d["seasons_count"] = c["s"]
    d["unwatched"] = c["n"] - (c["w"] or 0)
    d["watched"] = c["n"] > 0 and d["unwatched"] == 0
    d["latest"] = c["latest"]
    d["quality"] = quality(c)  # la migliore tra gli episodi
    d["thumb"] = f"/api/thumb/{c['first']}" if c["first"] else None
    return d


def collection_rows(con, only=0):
    """Le saghe di cui in catalogo ci sono almeno due film (una sola se 'only')."""
    return con.execute(
        "SELECT c.*, COUNT(DISTINCT i.tmdb_id) n, COUNT(DISTINCT CASE WHEN i.watched=0 THEN i.tmdb_id END) todo, "
        "MIN(i.year) y1, MAX(i.year) y2, MAX(i.added_at) latest, AVG(NULLIF(i.rating, 0)) rating, "
        "MIN(i.id) first FROM collections c JOIN items i ON i.collection_id=c.id AND i.kind='movie' "
        "WHERE (?=0 OR c.id=?) GROUP BY c.id HAVING COUNT(DISTINCT i.tmdb_id)>=2 "
        "ORDER BY c.name COLLATE NOCASE", (only, only)).fetchall()


def collection_json(con, r):
    poster = r["poster"]
    if not poster:   # la saga non ha una locandina sua: si usa quella del primo film
        first = con.execute("SELECT poster FROM items WHERE collection_id=? AND poster IS NOT NULL "
                            "ORDER BY year LIMIT 1", (r["id"],)).fetchone()
        poster = first["poster"] if first else None
    today = time.strftime("%Y-%m-%d")
    released = [p for p in jlist(r["parts"]) if p.get("date") and p["date"] <= today]
    return {"id": r["id"], "kind": "collection", "title": saga_name(r["name"]),
            "overview": r["overview"] or "", "poster": img_url(poster),
            "backdrop": img_url(r["backdrop"]), "thumb": f"/api/thumb/{r['first']}",
            "count": r["n"], "total": max(len(released), r["n"]), "unwatched": r["todo"],
            "watched": r["todo"] == 0, "year": r["y1"], "year_to": r["y2"],
            "rating": round(r["rating"], 1) if r["rating"] else 0, "latest": r["latest"],
            "genres": []}


def get_item(con, item_id):
    r = con.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
    if not r:
        raise HTTPException(404, "Elemento non trovato")
    return r


def get_show(con, show_id):
    return con.execute("SELECT * FROM shows WHERE id=?", (show_id,)).fetchone()


def next_episode(con, r):
    if r["kind"] != "episode":
        return None
    return con.execute(
        "SELECT * FROM items WHERE show_id=? AND (season>? OR (season=? AND episode>?)) "
        "ORDER BY season, episode LIMIT 1",
        (r["show_id"], r["season"], r["season"], r["episode"])).fetchone()


SUB_TAGS = {"forced", "forzati", "forzato", "sdh", "hi", "cc", "full", "default"}


def _sub_words(name):
    """Parole di un nome file, senza punteggiatura: 'Toro.Scatenato_1980' -> ['toro', 'scatenato', '1980']."""
    return [w for w in re.split(r"[^0-9a-z]+", name.lower()) if w]


def _sub_split(stem):
    """Separa il nome del film dalla coda di lingua e tipo:
    'Toro.Scatenato_ita_forced' -> ('Toro.Scatenato', 'ita_forced')."""
    parts = re.split(r"([._\- ]+)", stem)
    cut = len(parts)
    while cut >= 1 and (parts[cut - 1].lower() in LANGS or parts[cut - 1].lower() in SUB_TAGS):
        cut -= 2
    cut = max(cut, 0)
    base = "".join(parts[:cut])
    return base, "".join(parts[cut:]).strip(" .-_")


def subtitle_files(path, item_id=None):
    """I sottotitoli accanto al video e, dopo, quelli scaricati da internet
    (in data/subs/<id>/, perche' i dischi dei video sono in sola lettura).
    L'ordine conta: /api/subs/<id>/<n> li indica per posizione."""
    p = Path(path)
    out = []
    try:
        files = sorted(p.parent.iterdir())
    except OSError:
        files = []
    subs = [f for f in files if f.suffix.lower() in SUB_EXT]
    # Un solo video nella cartella: i sottotitoli sono suoi anche se hanno un altro nome
    alone = sum(1 for f in files if f.suffix.lower() in VIDEO_EXT) == 1
    video = _sub_words(p.stem)
    for f in subs:
        if f.stem.lower().startswith(p.stem.lower()):
            out.append((f, f.stem[len(p.stem):].strip(" .-_")))
            continue
        # Nome diverso (Toro.Scatenato_ita_forced.srt per Toro Scatenato (1980).mkv):
        # tolti lingua e "forced" in coda, il resto deve stare all'inizio del video
        # (o viceversa), ignorando punti, trattini, maiuscole e simili
        base, tag = _sub_split(f.stem)
        words = _sub_words(base)
        if alone or (words and video and (video[:len(words)] == words
                                          or words[:len(video)] == video)):
            out.append((f, tag))
    if item_id is not None:
        try:
            for f in sorted((SUBS_DIR / str(int(item_id))).iterdir()):
                if f.suffix.lower() in SUB_EXT:
                    out.append((f, f.stem + ".online"))
        except OSError:
            pass
    return out


LANGS = {"it": "Italiano", "ita": "Italiano", "en": "English", "eng": "English",
         "es": "Español", "spa": "Español", "fr": "Français", "fre": "Français",
         "de": "Deutsch", "ger": "Deutsch"}
BROWSER_VIDEO = {"h264", "vp8", "vp9", "av1"}
BROWSER_AUDIO = {"", "aac", "mp3", "opus", "vorbis", "flac"}
BROWSER_EXT = {".mp4", ".m4v", ".webm", ".mkv", ".mov"}


def play_info(con, r):
    show = get_show(con, r["show_id"]) if r["show_id"] else None
    title = r["title"] or ""
    subtitle = str(r["year"] or "")
    if r["kind"] == "episode":
        subtitle = f"S{r['season']} · E{r['episode']}  {r['title'] or ''}".strip()
        title = show["title"] if show else title
    subs = []
    for i, (_, tag) in enumerate(subtitle_files(r["path"], r["id"])):
        code = (re.split(r"[._\- ]", tag)[0] or "").lower()     # it.forced, ita_forced, ITA-sdh
        online = tag.endswith(".online")
        label = LANGS.get(code, code.upper() if online else (tag or "Sottotitoli"))
        # Forzati (Film.it.forced.srt): traducono solo cartelli e frasi in un'altra
        # lingua, e i player li accendono da soli
        forced = any(w in tag.lower() for w in ("forced", "forzat"))
        subs.append({"url": f"/api/subs/{r['id']}/{i}",
                     "label": label + (" · forzati" if forced and code in LANGS else "")
                              + (" · da internet" if online else ""),
                     "lang": code[:2] if code in LANGS else "", "online": online, "forced": forced})
    nxt = next_episode(con, r)
    saga = saga_next(con, r)
    vcodec, pix = r["vcodec"] or "", r["pix"] or ""
    direct = (Path(r["path"]).suffix.lower() in BROWSER_EXT
              and vcodec in BROWSER_VIDEO
              and (vcodec != "h264" or pix in ("yuv420p", "yuvj420p"))
              and (r["acodec"] or "") in BROWSER_AUDIO)
    return {"id": r["id"], "title": title, "subtitle": subtitle,
            # Qualita' del file (4K, 1080p...), nel player accanto all'anno
            "quality": quality(r),
            # Fps del video: l'app TV ci accorda la frequenza dello schermo
            "fps": video_fps(con, r),
            # Episodio di una serie: il player ricorda la traccia audio scelta per tutta la serie
            "show_id": r["show_id"] or 0,
            "url": f"/api/stream/{r['id']}", "transcode": f"/api/transcode/{r['id']}",
            "browser_direct": direct, "vcodec": vcodec, "bits": 10 if "10" in pix else 8,
            "start": 0 if r["watched"] else (r["position"] or 0),
            "duration": r["duration"] or 0, "subs": subs,
            # Si possono cercare sottotitoli su internet (chiave OpenSubtitles impostata)
            "subs_online": bool(os_conf()["key"]),
            "next": nxt["id"] if nxt else 0,
            # Cosa mostrare nel conto alla rovescia di fine episodio
            "next_label": (f"S{nxt['season']} · E{nxt['episode']}  {nxt['title'] or ''}".strip()
                           if nxt else ""),
            # Il film che viene dopo nella stessa saga: il player lo propone, non parte da solo
            "saga": saga,
            # Sigle: «Salta intro» e il prossimo episodio appena partono i titoli di coda
            **marks_info(r),
            # Il player della TV non ha i cookie della pagina: entra con questo gettone
            "session": (CURRENT.get() or {}).get("session") or ""}


def saga_next(con, r):
    """Per un film che fa parte di una saga: il film successivo in ordine di uscita
    tra quelli in catalogo. None se non c'e' una saga o questo e' l'ultimo."""
    if r["kind"] != "movie" or not r["collection_id"]:
        return None
    c = con.execute("SELECT * FROM collections WHERE id=?", (r["collection_id"],)).fetchone()
    if not c:
        return None
    order = {p["id"]: n for n, p in enumerate(jlist(c["parts"]))}
    items = con.execute("SELECT * FROM items WHERE collection_id=? AND kind='movie'",
                        (r["collection_id"],)).fetchall()
    items.sort(key=lambda x: (order.get(x["tmdb_id"], len(order)), x["year"] or 9999, x["title"] or ""))
    ids = [x["id"] for x in items]
    at = ids.index(r["id"]) if r["id"] in ids else -1
    if at < 0 or at + 1 >= len(items):
        return None
    n = items[at + 1]
    return {"id": n["id"], "title": n["title"] or "", "year": n["year"] or 0,
            "name": saga_name(c["name"]), "number": at + 2, "count": len(items)}


# ---- Sigle degli episodi -------------------------------------------------------
# Un thread guarda episodio per episodio dove sono la sigla iniziale e quella
# finale (vedi sigle.py): prima quello appena avviato, poi le stagioni che si
# stanno guardando, poi tutte le altre, ma solo quando nessuno sta guardando
# (legge dal disco dei video e impegna un po' il processore).

MARKS_V = 1                           # aumentarlo fa rifare il riconoscimento a tutti
SIGLE_DIR = DATA / "sigle"            # impronte dell'audio, per confrontare gli episodi aggiunti dopo
sigle_wake = threading.Event()
sigle_urgent = []                     # episodi appena avviati: hanno la precedenza
sigle_lock = threading.Lock()
sigle_skip = {}                       # (serie, stagione) con file non raggiungibili -> quando riprovare


def marks_missing(r):
    return r["kind"] == "episode" and (r["marks_v"] or 0) < MARKS_V


def marks_info(r):
    intro = r["intro_s"] is not None and r["intro_e"] and r["intro_e"] > r["intro_s"]
    return {"intro_start": round(r["intro_s"], 2) if intro else 0,
            "intro_end": round(r["intro_e"], 2) if intro else 0,
            "credits": round(r["credits_s"], 2) if r["credits_s"] else 0,
            # Ancora da guardare: il player le richiede tra poco a /api/marks
            "marks_pending": marks_missing(r)}


def sigle_now(r):
    """Un episodio appena avviato: lo si analizza subito (con il successivo)."""
    with sigle_lock:
        if r["id"] not in sigle_urgent:
            sigle_urgent.append(r["id"])
    sigle_wake.set()


def sigle_key(r, part):
    """Nome dell'impronta: cambia se cambia il file."""
    return f"{r['id']}-{int(r['size'] or 0)}-{int(r['duration'] or 0)}-{part}"


def sigle_points(r, part, nice):
    head, tail = sigle.windows(r["duration"] or 0)
    start, length = head if part == "h" else tail
    return sigle.cached(SIGLE_DIR, sigle_key(r, part), r["path"], start, length, nice)


def sigle_episode(con, r, season, nice):
    """Trova e salva le sigle dell'episodio r. 'season' = gli episodi della stessa
    stagione (righe del catalogo), in ordine. False se il file non si raggiunge."""
    if not Path(r["path"]).is_file():
        return False
    found = sigle.from_chapters(r["path"])
    intro, credits = found["intro"], found["credits"]
    dur = r["duration"] or 0
    if dur >= sigle.MIN_EPISODE and (intro is None or credits is None):
        tail = sigle.windows(dur)[1]
        # Con chi confrontarlo: i vicini (stessa sigla quasi di sicuro), mai un altro
        # file dello stesso episodio (sarebbe tutto "in comune")
        at = next((k for k, x in enumerate(season) if x["id"] == r["id"]), 0)
        others = [season[k] for k in (at + 1, at - 1, at + 2, at - 2, at + 3)
                  if 0 <= k < len(season) and season[k]["episode"] != r["episode"]
                  and (season[k]["duration"] or 0) >= sigle.MIN_EPISODE
                  and Path(season[k]["path"]).is_file()][:3]
        mine = {}
        for o in others:
            if intro is None:
                a = mine.setdefault("h", sigle_points(r, "h", nice))
                intro = sigle.find_intro(a, sigle_points(o, "h", nice))
            if credits is None:
                a = mine.setdefault("t", sigle_points(r, "t", nice))
                c = sigle.find_credits(a, sigle_points(o, "t", nice), tail[0])
                # Un tratto in comune fin dall'inizio della finestra: due copie dello stesso video
                credits = c if c is not None and c > tail[0] + 2 else None
            if intro is not None and credits is not None:
                break
    # Una sigla finale che parte a meta' episodio non e' una sigla finale
    if credits is not None and (credits < dur * 0.6 or credits > dur - 5):
        credits = None
    con.execute("UPDATE items SET intro_s=?, intro_e=?, credits_s=?, marks_v=? WHERE id=?",
                (intro[0] if intro else None, intro[1] if intro else None, credits, MARKS_V, r["id"]))
    con.commit()
    return True


def sigle_season(con, show_id, season_no, only=None, nice=True):
    """Analizza gli episodi ancora da fare di una stagione (o solo quelli in 'only').
    Si ferma se arriva un episodio con la precedenza o se qualcuno inizia a guardare."""
    season = con.execute("SELECT * FROM items WHERE show_id=? AND season IS ? AND kind='episode' "
                         "ORDER BY episode, id", (show_id, season_no)).fetchall()
    todo = [x for x in season if (x["id"] in only if only else marks_missing(x))]
    missing = False
    for r in todo:
        if only is None and (sigle_urgent or updater.busy()):
            return
        try:
            if not sigle_episode(con, r, season, nice):
                missing = True
        except Exception as ex:
            print("Sigle non riconosciute:", r["path"], repr(ex), flush=True)
            con.execute("UPDATE items SET marks_v=? WHERE id=?", (MARKS_V, r["id"]))
            con.commit()
    if missing:
        sigle_skip[(show_id, season_no)] = time.time() + 3600


def sigle_loop():
    time.sleep(30)                    # prima lascia partire il resto del server
    while True:
        try:
            with sigle_lock:
                urgent = sigle_urgent.pop(0) if sigle_urgent else None
            con = db(raw=True)
            try:
                if urgent is not None:
                    r = con.execute("SELECT * FROM items WHERE id=?", (urgent,)).fetchone()
                    if r and marks_missing(r):
                        sigle_season(con, r["show_id"], r["season"], only={r["id"]}, nice=False)
                        # Anche il prossimo episodio: sara' pronto quando parte
                        nxt = next_episode(con, r)
                        if nxt and marks_missing(nxt):
                            sigle_season(con, nxt["show_id"], nxt["season"], only={nxt["id"]}, nice=False)
                    continue
                if updater.busy():
                    sigle_wake.wait(120)
                    sigle_wake.clear()
                    continue
                now = time.time()
                # Prima le stagioni che qualcuno sta guardando, poi le aggiunte di recente
                rows = con.execute(
                    "SELECT i.show_id, i.season, MAX(COALESCE(u.lp, 0)) AS lp, MAX(i.id) AS last FROM items i "
                    "LEFT JOIN (SELECT item_id, MAX(last_played) AS lp FROM user_items GROUP BY item_id) u "
                    "ON u.item_id = i.id WHERE i.kind='episode' AND COALESCE(i.marks_v, 0) < ? "
                    "GROUP BY i.show_id, i.season ORDER BY lp DESC, last DESC", (MARKS_V,)).fetchall()
                pick = next((x for x in rows if sigle_skip.get((x["show_id"], x["season"]), 0) < now), None)
                if pick is None:
                    sigle_wake.wait(600)
                    sigle_wake.clear()
                    continue
                sigle_season(con, pick["show_id"], pick["season"])
            finally:
                con.close()
        except Exception as ex:
            print("Riconoscimento delle sigle non riuscito:", repr(ex), flush=True)
            time.sleep(60)


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------

app = FastAPI(title="BunkerPlex", docs_url=None, redoc_url=None, openapi_url=None)


class SmallAndFast:
    """Comprime elenchi e pagine (l'elenco di una raccolta pesa centinaia di KB:
    compresso arriva alla TV in un quinto del tempo). Video e immagini passano
    cosi' come sono: sono gia' compressi e devono restare 'saltabili'."""
    RAW = ("/api/stream", "/api/transcode", "/api/hls/", "/api/image", "/api/thumb", "/BunkerPlex.apk", "/BunkerPlexTV.apk",
           "/api/share/stream", "/api/share/transcode", "/api/share/hls/",
           "/api/share/image", "/api/share/thumb", "/api/friend/")
    PLAYING = ("/api/stream", "/api/transcode", "/api/hls/", "/api/progress", "/api/share/stream",
               "/api/share/transcode", "/api/share/hls/")

    def __init__(self, inner):
        self.inner = inner
        self.gzip = GZipMiddleware(inner, minimum_size=2048, compresslevel=5)

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and (scope.get("server") or ("", 0))[1] != SHARE_PORT:
            learn_lan(scope)
        if scope["type"] == "http" and scope["path"].startswith(self.PLAYING):
            updater.playing()     # qualcuno sta guardando: l'aggiornamento automatico aspetta
        if scope["type"] == "http" and not scope["path"].startswith(self.RAW):
            await self.gzip(scope, receive, send)
        else:
            await self.inner(scope, receive, send)


app.add_middleware(SmallAndFast)


async def read_json(request):
    """Il corpo della richiesta come dizionario (400 se non e' JSON valido)."""
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(400, "Richiesta non valida")
    if not isinstance(body, dict):
        raise HTTPException(400, "Richiesta non valida")
    return body


def migrate_catalog():
    """Dopo un miglioramento del riconoscimento, i titoli rimasti senza scheda
    vengono tolti dal catalogo e riletti da capo (i file non si toccano)."""
    if config.get("classifier", 1) >= 2:
        return
    con = db()
    try:
        for r in con.execute("SELECT id FROM items WHERE kind='movie' AND tmdb_id IS NULL").fetchall():
            (IMG / f"thumb_{r['id']}.jpg").unlink(missing_ok=True)
        con.execute("DELETE FROM items WHERE kind='movie' AND tmdb_id IS NULL")
        con.execute("UPDATE shows SET meta_done=0 WHERE tmdb_id IS NULL")
        con.commit()
    finally:
        con.close()
    with config_lock:
        config["classifier"] = 2
        save_config()


NO_DATA_PAGE = """<!doctype html><html lang="it"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>BunkerPlex</title>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#060a07;color:#f2f5f2;font-family:system-ui,sans-serif;text-align:center">
<div style="max-width:34rem;padding:2rem"><h1 style="color:#4cbf7f">Catalogo non raggiungibile</h1>
<p style="font-size:1.2rem;line-height:1.6">%s</p>
<p style="color:#9a9aa8">La tua libreria non è persa: è sul disco. Questa pagina si riaggiorna da sola.</p></div>
<script>setTimeout(function () { location.reload(); }, 8000);</script></body></html>"""


@app.middleware("http")
async def need_data(request: Request, call_next):
    """Senza il disco del catalogo il server resta acceso solo per dirlo."""
    if not DATA_PROBLEM:
        return await call_next(request)
    if request.url.path.startswith("/api/"):
        return Response(json.dumps({"detail": DATA_PROBLEM}), status_code=503,
                        media_type="application/json")
    return Response(NO_DATA_PAGE % DATA_PROBLEM, status_code=503,
                    media_type="text/html; charset=utf-8", headers={"Cache-Control": "no-store"})


@app.on_event("startup")
def startup():
    if DATA_PROBLEM:
        print("ATTENZIONE:", DATA_PROBLEM, flush=True)
        return
    init_db()
    migrate_catalog()
    ensure_identity()
    threading.Thread(target=note_update, daemon=True).start()
    threading.Thread(target=scan_loop, daemon=True).start()
    threading.Thread(target=drives_loop, daemon=True).start()
    threading.Thread(target=sigle_loop, daemon=True).start()
    updater.resume()      # l'aiutante sul PC stava aggiornando (e ha riacceso il server)?
    threading.Thread(target=updater.loop, args=(auto_update,), daemon=True).start()
    threading.Thread(target=updater.apps_loop, daemon=True).start()   # copie delle app per la prima installazione
    threading.Thread(target=friends_loop, daemon=True).start()
    cast.scan_later()     # la lista di «Guarda su» pronta quando serve
    threading.Thread(target=sync_loop, daemon=True).start()
    if SECURE_PORT:
        threading.Thread(target=secure_loop, daemon=True).start()
    if SHARE_PORT:
        threading.Thread(target=share_listener, daemon=True).start()
        threading.Thread(target=public_listener, daemon=True).start()
        threading.Thread(target=portmap_loop, daemon=True).start()
        threading.Thread(target=tailnet_loop, daemon=True).start()


# ---- Account ------------------------------------------------------------------
# Chi guarda entra con il suo ACCOUNT: visti, punti di ripresa, lista, raccolte e
# impostazioni sono suoi. Niente profili: un account, una collezione.
# Finche' su questo PC non e' entrato nessun account (o senza servizio account)
# c'e' solo l'utente di questo PC («Casa»), in cui si entra da soli: funziona
# sempre, anche senza Internet. Il primo account che entra lo prende con tutto
# quello che ha (vedi store_user).
# Con l'account impostazioni, chiavi, visti, lista e raccolte lo seguono su ogni
# PC, e si sblocca la condivisione con gli amici. Le modifiche fatte senza
# Internet si uniscono da sole al ritorno della rete, voce per voce: vince la
# piu' recente.
# Utente di questo PC: cloud_id NULL. Account: cloud_id dell'account
# (token NULL = va ridata la password per riprendere la sincronizzazione).

SESSION_COOKIE = "bp_session"
SETUP_FILE = DATA / "cloud-setup.json"       # chiave per creare il primo amministratore
# /api/cast/media/: il video che apre una TV con «Guarda su» (vale solo col biglietto, vedi cast.py)
OPEN_PATHS = ("/api/auth/", "/api/share/", "/api/info", "/api/cast/media/", "/api/hls/")
user_cache = {}                  # impronta del gettone -> (dati dell'account, quando letti)
settings_cache = {}              # (account, chiave) -> valore
settings_lock = threading.Lock()
sync_wake = threading.Event()
cloud_status = {"at": 0.0, "ready": None}


def auth_on():
    """C'e' un servizio account?"""
    return bool(accounts.cloud_url()) and not DATA_PROBLEM


DEFAULT_USER = "Casa"


def merge_user(con, src, dst):
    """Tutto quello che ha src (visti, ripresa, lista, impostazioni, raccolte,
    dispositivi entrati) passa a dst, senza perdere niente; poi src non c'e' piu'.
    Per ogni titolo vince la ripresa piu' recente; visto e lista restano se uno dei
    due li aveva."""
    con.execute("INSERT INTO user_items(user_id, item_id, position, watched, last_played, fav, t, dirty) "
                "SELECT ?, item_id, position, watched, last_played, fav, t, 1 FROM user_items WHERE user_id=? "
                "ON CONFLICT(user_id, item_id) DO UPDATE SET "
                "position=CASE WHEN excluded.t>user_items.t THEN excluded.position ELSE user_items.position END, "
                "watched=MAX(user_items.watched, excluded.watched), "
                "last_played=MAX(user_items.last_played, excluded.last_played), "
                "fav=MAX(user_items.fav, excluded.fav), t=MAX(user_items.t, excluded.t), dirty=1", (dst, src))
    con.execute("INSERT INTO user_shows(user_id, show_id, fav, t, dirty) "
                "SELECT ?, show_id, fav, t, 1 FROM user_shows WHERE user_id=? "
                "ON CONFLICT(user_id, show_id) DO UPDATE SET fav=MAX(user_shows.fav, excluded.fav), "
                "t=MAX(user_shows.t, excluded.t), dirty=1", (dst, src))
    # Le impostazioni che dst non ha ancora (chiavi API comprese)
    con.execute("INSERT OR IGNORE INTO user_settings(user_id, k, v, t, dirty) "
                "SELECT ?, k, v, t, 1 FROM user_settings WHERE user_id=? AND k<>'libraries'", (dst, src))
    con.execute("UPDATE user_sessions SET user_id=? WHERE user_id=?", (dst, src))
    con.execute("UPDATE accounts SET profile=? WHERE profile=?", (dst, src))
    for table in ("user_items", "user_shows", "user_settings", "cloud_state"):
        con.execute(f"DELETE FROM {table} WHERE user_id=?", (src,))
    con.execute("DELETE FROM users WHERE id=?", (src,))
    with config_lock:
        changed = False
        for lib in config.get("libraries") or []:
            if lib.get("owner") == src:
                lib.update(owner=dst, synced=False)   # se dst ha l'account, le raccolte ci vanno
                changed = True
        if config.get("accounts_adopted") == src:
            config["accounts_adopted"] = dst
            changed = True
        if changed:
            save_config()
    with settings_lock:
        settings_cache.clear()
    user_cache.clear()


def ensure_identity():
    """Al primo avvio nasce l'utente di questo PC («Casa»), che prende raccolte, visti,
    lista e chiavi che c'erano prima. Arrivando dalla versione con i profili, i
    profili senza account si uniscono all'account principale di questo PC
    (l'amministratore, o il primo entrato); se di account non ce ne sono, al primo
    profilo. Gli account restano ognuno con la sua collezione."""
    con = db(raw=True)
    try:
        con.execute("DELETE FROM user_sessions WHERE user_id=0")   # vecchi ingressi «senza account»
        if not config.get("login_per_device"):
            # Prima si entrava scegliendo il nome, senza password, da qualunque telefono
            # di casa: si chiudono tutti gli ingressi, ogni dispositivo rientra con la password
            con.execute("DELETE FROM user_sessions")
            con.execute("UPDATE users SET tv_quick=0")
            with config_lock:
                config["login_per_device"] = 1
                save_config()
            print("Ingressi chiusi: ogni dispositivo rientra con la password", flush=True)
        con.commit()
        rows = con.execute("SELECT id, cloud_id, admin FROM users ORDER BY created, id").fetchall()
        if rows:
            local = [r["id"] for r in rows if r["cloud_id"] is None]
            linked = [r for r in rows if r["cloud_id"] is not None]
            if linked:
                main = next((r["id"] for r in linked if r["admin"]), linked[0]["id"])
                rest = local
            else:
                main, rest = local[0], local[1:]
            for src in rest:
                merge_user(con, src, main)
                con.commit()
                print("Profilo", src, "unito all'account", main, flush=True)
            if rest:
                sync_soon()
            return
        uid = con.execute("INSERT INTO users(name, created, last_login, tv_quick) VALUES(?,?,?,1)",
                          (DEFAULT_USER, time.time(), time.time())).lastrowid
        con.commit()
    finally:
        con.close()
    print("Creato l'utente", DEFAULT_USER, flush=True)
    adopt_legacy(uid)


def sync_soon():
    sync_wake.set()


def user_setting(uid, k):
    key = (uid, k)
    with settings_lock:
        if key in settings_cache:
            return settings_cache[key]
    con = db(raw=True)
    try:
        r = con.execute("SELECT v FROM user_settings WHERE user_id=? AND k=?", (uid, k)).fetchone()
    finally:
        con.close()
    value = json.loads(r[0]) if r and r[0] else None
    with settings_lock:
        settings_cache[key] = value
    return value


def any_user_setting(k):
    """La chiave di un account qualsiasi di questo PC (per le letture in sottofondo)."""
    key = (0, k)
    with settings_lock:
        if key in settings_cache:
            return settings_cache[key]
    con = db(raw=True)
    try:
        r = con.execute("SELECT v FROM user_settings WHERE k=? AND v NOT IN ('null', '\"\"') "
                        "ORDER BY t DESC LIMIT 1", (k,)).fetchone()
    except sqlite3.OperationalError:     # tabella non ancora creata
        r = None
    finally:
        con.close()
    value = json.loads(r[0]) if r and r[0] else None
    with settings_lock:
        settings_cache[key] = value
    return value


def put_user_setting(uid, k, value):
    con = db(raw=True)
    try:
        con.execute("INSERT INTO user_settings(user_id, k, v, t, dirty) VALUES(?,?,?,?,1) "
                    "ON CONFLICT(user_id, k) DO UPDATE SET v=excluded.v, t=excluded.t, dirty=1",
                    (uid, k, json.dumps(value), time.time()))
        con.commit()
    finally:
        con.close()
    with settings_lock:
        settings_cache.clear()
    sync_soon()


def cookie_value(scope, name):
    for k, v in scope.get("headers") or ():
        if k == b"cookie":
            for part in v.decode("latin-1").split(";"):
                key, _, val = part.strip().partition("=")
                if key == name:
                    return val
    return ""


def session_token(scope):
    for k, v in scope.get("headers") or ():
        if k == b"x-bp-session":
            return v.decode("latin-1").strip()
    return cookie_value(scope, SESSION_COOKIE)


def session_user(token):
    """Il profilo di un gettone (None se non vale piu'). Un ingresso resta valido
    con o senza Internet: la rete serve solo a sincronizzare."""
    if not token or len(token) > 100:
        return None
    key = token_hash(token)
    known = user_cache.get(key)
    if not known or time.time() - known[1] > 30:
        con = db(raw=True)
        try:
            r = con.execute("SELECT s.user_id, s.last_seen, s.profile, p.id AS pid, p.name AS pname, "
                            "u.id, u.name, u.admin, u.must_change, u.cloud_id, COALESCE(u.guest, 0) AS guest "
                            "FROM user_sessions s JOIN users u ON u.id=s.user_id "
                            "LEFT JOIN profiles p ON p.id=s.profile AND p.user_id=u.id WHERE s.token=? "
                            "AND COALESCE(u.disabled, 0)=0 AND (u.id=COALESCE((" + OWNER_SQL + "), u.id) "
                            "OR COALESCE(u.guest, 0)=1)",
                            (key,)).fetchone()
            if r and time.time() - (r["last_seen"] or 0) > 3600:
                con.execute("UPDATE user_sessions SET last_seen=? WHERE token=?", (time.time(), key))
                con.commit()
        finally:
            con.close()
        if len(user_cache) > 500:
            user_cache.clear()
        known = user_cache[key] = (dict(r) if r else None, time.time())
    r = known[0]
    if not r:
        return None
    linked = r["cloud_id"] is not None
    guest = bool(r["guest"])
    # sid: di chi sono visti, ripresa e lista (l'account, o -id del profilo scelto)
    return {"id": r["id"], "name": r["name"], "admin": linked and bool(r["admin"]) and not guest, "linked": linked,
            "guest": guest, "must_change": linked and bool(r["must_change"]),
            "libs": guest_libs() if guest else visible_libs(r["id"]), "session": token,
            "sid": -r["pid"] if r["pid"] else r["id"],
            "profile": r["pid"] or (0 if r["profile"] is not None else None), "pname": r["pname"] or r["name"]}


def share_token_of(scope):
    for k, v in scope.get("headers") or ():
        if k == b"x-share-token":
            return v.decode("latin-1").strip()
    return ""


share_profiles = {}              # impronta del gettone di un amico -> (profilo o None, quando letto)


def share_viewer(token):
    """Chi e' l'amico che chiede: per uno entrato con l'account, un «utente» che vede
    solo le raccolte del profilo che lo ha come amico; None per i vecchi collegamenti."""
    if not token or len(token) > 100:
        return None
    key = token_hash(token)
    known = share_profiles.get(key)
    if not known or time.time() - known[1] > 30:
        con = db(raw=True)
        try:
            r = con.execute("SELECT a.profile FROM share_sessions s JOIN accounts a ON a.id=s.account "
                            "WHERE s.token=?", (key,)).fetchone()
        finally:
            con.close()
        if len(share_profiles) > 500:
            share_profiles.clear()
        known = share_profiles[key] = (r["profile"] if r else None, time.time())
    uid = known[0]
    if not uid:
        return None
    with config_lock:
        libs = [l["id"] for l in config.get("libraries") or [] if l.get("owner") == uid]
    return {"id": uid, "name": "", "admin": False, "linked": True, "must_change": False,
            "libs": libs, "session": "", "friend": True}


# ---- Senza Internet -------------------------------------------------------------
# Senza Internet (o con il servizio account fermo) ogni profilo va avanti con la
# sua copia su questo PC. Le modifiche restano segnate (dirty) e partono appena il
# servizio risponde; quelle arrivate intanto dagli altri PC si uniscono voce per
# voce (visto, punto di ripresa, lista, impostazione): vince la piu' recente.

cloud_link = {"online": None, "at": 0.0}     # il servizio account risponde? (None: non si sa ancora)


def mark_cloud(online):
    cloud_link.update(online=online, at=time.time())


def cloud_ping():
    try:
        info = accounts.call("GET", "/", timeout=6)
        cloud_status["google"] = bool(info.get("google"))   # «Entra con Google» attivo nel servizio?
        cloud_status["reset"] = bool(info.get("reset"))     # «Password dimenticata?» attivo?
        mark_cloud(True)
    except accounts.CloudError:
        mark_cloud(True)          # risponde, anche se con un errore
    except accounts.CloudOffline:
        mark_cloud(False)
    return cloud_link["online"]


def pending_changes(con, uid):
    """Modifiche fatte su questo PC e non ancora mandate all'account."""
    return (con.execute("SELECT COUNT(*) FROM user_items WHERE user_id=? AND dirty=1", (uid,)).fetchone()[0]
            + con.execute("SELECT COUNT(*) FROM user_shows WHERE user_id=? AND dirty=1", (uid,)).fetchone()[0]
            + con.execute("SELECT COUNT(*) FROM user_settings WHERE user_id=? AND dirty=1 "
                          "AND k NOT LIKE 'pending.%'", (uid,)).fetchone()[0])


class AuthGate:
    """Le API rispondono a chi e' entrato su questo PC (con o senza
    account, con o senza Internet). Restano aperte: «Chi guarda?» e
    l'accesso, la porta degli amici e /api/info (ridotta), che serve all'app
    della TV per riconoscere il server e aggiornarsi."""

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        port = (scope.get("server") or ("", 0))[1]
        if port and port in (PUBLIC_PORT, SECURE_PORT) and (scope["type"] != "http" or not auth_on()):
            # Da Internet solo con gli account (e i loro login): mai il PC aperto a tutti
            await self._reply(send, 403, "Non disponibile")
            return
        if scope["type"] != "http" or DATA_PROBLEM:
            await self.inner(scope, receive, send)
            return
        path = scope["path"]
        keyed = KEY_PATH.fullmatch(path)
        if keyed:
            # La PWA: video e immagini con la chiave nel percorso (vedi access_media).
            # Nel percorso, e non nella domanda, resta anche ai segmenti HLS relativi.
            scope = dict(scope, path=keyed.group(2), raw_path=keyed.group(2).encode())
            path = scope["path"]
        if path.startswith("/api/share/") or (scope.get("server") or ("", 0))[1] == SHARE_PORT:
            # Un amico: con l'account vede (in sola lettura) solo le raccolte del profilo
            # che lo ha come amico; con il vecchio collegamento a password, tutto il PC
            ctx = CURRENT.set(share_viewer(share_token_of(scope)))
            try:
                await self.inner(scope, receive, send)
            finally:
                CURRENT.reset(ctx)
            return
        # La porta interna dell'indirizzo pubblico (Funnel) arriva anche lei da 127.0.0.1
        from_funnel = (scope.get("server") or ("", 0))[1] == PUBLIC_PORT
        if tailnet_proc["p"] and not from_funnel and (scope.get("client") or ("",))[0] in ("127.0.0.1", "::1"):
            # Dentro il contenitore nessuno apre la 32500 da 127.0.0.1: chi arriva cosi'
            # viene dalla rete Tailscale, dove agli amici spetta solo la 32501
            await self._reply(send, 403, "Non disponibile")
            return
        user = session_user(session_token(scope))
        if user is None:
            bearer = bearer_of(scope)
            if bearer:                   # gettone d'accesso del servizio account (vedi access_user)
                user = await asyncio.to_thread(access_user, bearer)
            elif keyed and scope.get("method") in ("GET", "HEAD"):
                user = await asyncio.to_thread(media_user, keyed.group(1))
            elif media_key_of(scope):    # chiave dei video (vedi access_media)
                user = await asyncio.to_thread(media_user, media_key_of(scope))
        ctx = CURRENT.set(user)
        try:
            if path.startswith("/api/") and not path.startswith(OPEN_PATHS) and user is None:
                await self._reply(send, 401, "Scegli chi guarda per continuare")
                return
            await self.inner(scope, receive, send)
        finally:
            CURRENT.reset(ctx)

    @staticmethod
    async def _reply(send, status, detail):
        body = json.dumps({"detail": detail, "login": True}).encode()
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", b"application/json"),
                                (b"content-length", str(len(body)).encode()),
                                (b"cache-control", b"no-store")]})
        await send({"type": "http.response.body", "body": body})


app.add_middleware(AuthGate)


def cloud_ready():
    """Il servizio account ha gia' un amministratore? (None se non si raggiunge)"""
    if time.time() - cloud_status["at"] > 60 or cloud_status["ready"] is None:
        try:
            info = accounts.call("GET", "/", timeout=6)
            cloud_status["ready"] = bool(info.get("ready"))
            cloud_status["google"] = bool(info.get("google"))
            cloud_status["reset"] = bool(info.get("reset"))
        except Exception:
            cloud_status["ready"] = None
        cloud_status["at"] = time.time()
    return cloud_status["ready"]


async def cloud(method, path, body=None, token=None):
    """Chiamata al servizio account, con gli errori tradotti per la pagina."""
    try:
        return await asyncio.to_thread(accounts.call, method, path, body, token)
    except accounts.CloudOffline as ex:
        raise HTTPException(503, str(ex))
    except accounts.CloudError as ex:
        raise HTTPException(ex.status if ex.status in (400, 401, 403, 404, 409, 429) else 502, ex.detail)


def user_json(u):
    linked = u["cloud_id"] is not None
    admin = linked and bool(u["admin"])
    guest = bool(u["guest"]) if "guest" in u.keys() else False
    admin = admin and not guest
    return {"id": u["id"], "name": u["name"], "linked": linked, "admin": admin, "guest": guest,
            "role": "admin" if admin else "base", "must_change": linked and bool(u["must_change"]) and not guest}


def login_fields(body, key="password"):
    name = str(body.get("username") or "").strip()
    password = str(body.get(key) or "")
    if not name or not password:
        raise HTTPException(400, "Scrivi nome utente e password")
    return name, password


async def login_name(name):
    """Si entra con il nome utente o con l'email. L'impronta della password si calcola
    sul nome utente: per un'email lo chiede prima al servizio (senza Internet: l'email
    di un account gia' entrato su questo PC)."""
    if "@" not in name:
        return name
    try:
        return (await asyncio.to_thread(accounts.call, "POST", "/resolve", {"email": name}))["username"]
    except accounts.CloudError as ex:
        raise HTTPException(ex.status if ex.status in (400, 429) else 502, ex.detail)
    except accounts.CloudOffline:
        con = db(raw=True)
        try:
            r = con.execute("SELECT name FROM users WHERE cloud_id IS NOT NULL AND email=?",
                            (name.lower(),)).fetchone()
        finally:
            con.close()
        return r["name"] if r else name


def check_new_password(password):
    if len(password) < 8:
        raise HTTPException(400, "La password deve avere almeno 8 caratteri")
    if len(password) > 200:
        raise HTTPException(400, "Password troppo lunga")


def with_session(data, token):
    resp = JSONResponse(data)
    resp.set_cookie(SESSION_COOKIE, token, max_age=365 * 86400, httponly=True, samesite="lax", path="/")
    return resp


OWNER_SQL = "SELECT id FROM users WHERE cloud_id IS NOT NULL ORDER BY created, id LIMIT 1"


def owner_row(con):
    """Il proprietario di questo server: il primo account entrato (None se nessuno)."""
    return con.execute("SELECT id, name, cloud_id FROM users WHERE cloud_id IS NOT NULL "
                       "ORDER BY created, id LIMIT 1").fetchone()


def owner_only_error(owner):
    return HTTPException(403, "Su questo server entra solo il suo proprietario, " + owner["name"] +
                         ". Entra dal tuo server BunkerPlex: i video che ti condivide li vedi da lì, come amico.")


def open_session(con, uid, device):
    """Un ingresso nuovo per un dispositivo. Su un server con il proprietario entra
    lui e, come ospiti, i suoi amici (users.guest, vedi complete_login)."""
    owner = owner_row(con)
    if owner and owner["id"] != uid:
        g = con.execute("SELECT guest FROM users WHERE id=?", (uid,)).fetchone()
        if not g or not g["guest"]:
            raise owner_only_error(owner)
    token = secrets.token_urlsafe(32)
    con.execute("INSERT INTO user_sessions(token, user_id, device, created, last_seen) VALUES(?,?,?,?,?)",
                (token_hash(token), uid, str(device or "")[:60], time.time(), time.time()))
    return token


KEY_SETTINGS = ("tmdb_key", "opensubtitles")


def store_user(con, cloud_user, token, ver, guest=False):
    """Copia locale dell'account appena entrato (con l'impronta per entrare anche offline).
    Se l'account su questo PC non c'e' ancora e c'e' l'utente di questo PC (senza
    account), l'account prende quello con tutto quello che ha. Torna l'id.
    guest: un amico del proprietario. Non si sincronizza da qui (gettone NULL): le sue
    raccolte e impostazioni restano sul suo server."""
    owner = owner_row(con)
    if owner and owner["cloud_id"] != cloud_user["id"] and not guest:
        raise owner_only_error(owner)
    if guest:
        token = None
    row = con.execute("SELECT id, vsalt, vcheck FROM users WHERE cloud_id=?", (cloud_user["id"],)).fetchone()
    if ver:
        vsalt = secrets.token_hex(16)
        vcheck = hashlib.sha256((vsalt + ver).encode()).hexdigest()
    else:                        # entrato con Google: resta l'ultima password usata qui (per entrare offline)
        vsalt, vcheck = (row["vsalt"], row["vcheck"]) if row else (None, None)
    fields = (cloud_user["username"], int(cloud_user["admin"]), int(cloud_user["must_change"]),
              token, vsalt, vcheck, time.time(), cloud_user.get("google") or None,
              (cloud_user.get("email") or "").lower() or None)
    if not row and not guest:
        row = con.execute("SELECT id FROM users WHERE cloud_id IS NULL ORDER BY created, id LIMIT 1").fetchone()
        if row:
            link_local(con, row["id"], cloud_user["id"])
    if row:
        con.execute("UPDATE users SET name=?, admin=?, must_change=?, token=?, vsalt=?, vcheck=?, last_login=?, "
                    "google=?, email=?, disabled=0, guest=? WHERE id=?", (*fields, int(guest), row["id"]))
        uid = row["id"]
    else:
        uid = con.execute("INSERT INTO users(name, admin, must_change, token, vsalt, vcheck, last_login, "
                          "google, email, cloud_id, created, guest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                          (*fields, cloud_user["id"], time.time(), int(guest))).lastrowid
    con.commit()
    user_cache.clear()
    if not guest:
        adopt_legacy(uid)
    return uid


def link_local(con, uid, cloud_id):
    """L'utente di questo PC diventa un account. Visti, lista e raccolte di qui si
    uniranno a quelli dell'account (vince la modifica piu' recente); le chiavi API
    invece, se l'account ne ha gia' di diverse, si chiede quali tenere."""
    con.execute("UPDATE users SET cloud_id=?, state_rev=0 WHERE id=?", (cloud_id, uid))
    con.execute("DELETE FROM cloud_state WHERE user_id=?", (uid,))
    # L'elenco delle raccolte arriva dall'account; quelle di qui ci si aggiungono (sync_libraries)
    con.execute("DELETE FROM user_settings WHERE user_id=? AND k='libraries'", (uid,))
    con.execute("UPDATE user_items SET dirty=1 WHERE user_id=?", (uid,))
    con.execute("UPDATE user_shows SET dirty=1 WHERE user_id=?", (uid,))
    con.execute("UPDATE user_settings SET dirty=1 WHERE user_id=? AND k NOT LIKE 'pending.%'", (uid,))
    for k in KEY_SETTINGS:
        r = con.execute("SELECT v FROM user_settings WHERE user_id=? AND k=?", (uid, k)).fetchone()
        v = json.loads(r["v"]) if r and r["v"] else None
        con.execute("DELETE FROM user_settings WHERE user_id=? AND k=?", (uid, k))
        if v and not (isinstance(v, dict) and not v.get("key")):
            con.execute("INSERT OR REPLACE INTO user_settings(user_id, k, v, t, dirty) VALUES(?,?,?,?,0)",
                        (uid, "pending." + k, json.dumps(v), time.time()))
    with settings_lock:
        settings_cache.clear()


def adopt_legacy(uid):
    """Il primo account che entra su questo PC prende cio' che c'era prima degli
    account: raccolte, visti, punti di ripresa, lista e chiavi API."""
    with config_lock:
        if config.get("accounts_adopted"):
            return
        for lib in config.get("libraries") or []:
            lib.setdefault("owner", uid)
        config["accounts_adopted"] = uid
        save_config()
    con = db(raw=True)
    try:
        con.execute("INSERT OR IGNORE INTO user_items(user_id, item_id, position, watched, last_played, fav, t, dirty) "
                    "SELECT ?, id, position, watched, last_played, fav, MAX(last_played, fav, 1), 1 FROM items "
                    "WHERE position>0 OR watched=1 OR fav>0", (uid,))
        con.execute("INSERT OR IGNORE INTO user_shows(user_id, show_id, fav, t, dirty) "
                    "SELECT ?, id, fav, fav, 1 FROM shows WHERE fav>0", (uid,))
        con.commit()
    finally:
        con.close()
    # Le chiavi di questo PC non vanno subito nell'account: se l'account ne ha gia'
    # di diverse, al primo accesso si chiede quali tenere (vedi settings_conflicts)
    local = {}
    if config.get("tmdb_key"):
        local["tmdb_key"] = config["tmdb_key"]
    if (config.get("opensubtitles") or {}).get("key"):
        local["opensubtitles"] = config["opensubtitles"]
    if local:
        con = db(raw=True)
        try:
            con.executemany("INSERT OR REPLACE INTO user_settings(user_id, k, v, t, dirty) VALUES(?,?,?,?,0)",
                            [(uid, "pending." + k, json.dumps(v), time.time()) for k, v in local.items()])
            con.commit()
        finally:
            con.close()


SETTING_LABELS = {"tmdb_key": "Chiave TMDB (locandine e schede)",
                  "opensubtitles": "OpenSubtitles (sottotitoli da internet)"}


def setting_preview(k, v):
    """Come mostrare un'impostazione senza scrivere la chiave per intero."""
    if k == "tmdb_key":
        return "chiave …" + str(v)[-4:] if v else "nessuna"
    if k == "opensubtitles":
        v = v or {}
        if not v.get("key"):
            return "nessuna"
        return "chiave …" + str(v["key"])[-4:] + (" · account " + v["user"] if v.get("user") else "")
    return json.dumps(v, ensure_ascii=False)[:60]


def pending_settings(con, uid):
    return {r["k"][8:]: json.loads(r["v"]) for r in con.execute(
        "SELECT k, v FROM user_settings WHERE user_id=? AND k LIKE 'pending.%'", (uid,))}


def settings_conflicts(uid, token):
    """Primo accesso su questo PC: le impostazioni che c'erano qui e quelle
    dell'account. Se l'account non le ha, entrano nell'account; se sono uguali,
    niente; se sono diverse, si chiede (/api/auth/resolve)."""
    con = db(raw=True)
    try:
        pending = pending_settings(con, uid)
    finally:
        con.close()
    if not pending:
        return []
    pull_settings(uid, token)          # quelle dell'account, per confrontarle
    out, settled = [], []
    for k, local in pending.items():
        cloud = user_setting(uid, k)
        empty = not cloud or (isinstance(cloud, dict) and not cloud.get("key"))
        if empty:
            put_user_setting(uid, k, local)
            settled.append(k)
        elif cloud == local:
            settled.append(k)
        else:
            out.append({"key": k, "label": SETTING_LABELS.get(k, k),
                        "local": setting_preview(k, local), "cloud": setting_preview(k, cloud)})
    if settled:
        con = db(raw=True)
        try:
            con.executemany("DELETE FROM user_settings WHERE user_id=? AND k=?",
                            [(uid, "pending." + k) for k in settled])
            con.commit()
        finally:
            con.close()
    return out


async def first_login_conflicts(uid, token):
    try:
        return await asyncio.to_thread(settings_conflicts, uid, token)
    except Exception as ex:            # senza Internet si chiede al prossimo accesso
        print("Confronto impostazioni:", repr(ex), flush=True)
        return []


@app.post("/api/auth/resolve")
async def auth_resolve(request: Request):
    """Risposta alla domanda del primo accesso: tenere le impostazioni di questo PC
    (e scriverle nell'account) oppure quelle dell'account."""
    u = CURRENT.get()
    if u is None:
        raise HTTPException(401, "Accedi con il tuo account per continuare")
    body = await read_json(request)
    keep_local = body.get("keep") == "local"
    con = db(raw=True)
    try:
        pending = pending_settings(con, u["id"])
        con.execute("DELETE FROM user_settings WHERE user_id=? AND k LIKE 'pending.%'", (u["id"],))
        con.commit()
    finally:
        con.close()
    if keep_local:
        for k, v in pending.items():
            put_user_setting(u["id"], k, v)
    return {"ok": True}


# ---- Raccolte nell'account ------------------------------------------------------
# L'elenco delle raccolte (nome, cartelle, condivisa o no) segue l'account: su un
# altro PC le raccolte compaiono gia' create. Le cartelle che li' esistono con lo
# stesso percorso (anche su un disco con un'altra lettera) si collegano da sole;
# le altre restano «su un altro PC» finche' non si sceglie dove stanno qui.
# Ogni raccolta ha un sync_id che la riconosce su tutti i PC.

def lib_export(uid):
    out, changed = [], False
    with config_lock:
        for lib in config.get("libraries") or []:
            if lib.get("owner") != uid:
                continue
            if not lib.get("sync_id"):
                lib["sync_id"] = secrets.token_hex(8)
                changed = True
            folders = [{"path": p, "display": display_path(p)} for p in lib["folders"]]
            folders += [m for m in lib.get("missing") or [] if m not in folders]
            out.append({"id": lib["sync_id"], "name": lib["name"], "shared": bool(lib.get("shared")),
                        "folders": folders})
            if not lib.get("synced"):
                lib["synced"] = True
                changed = True
        if changed:
            save_config()
    return out


def push_libraries(uid):
    put_user_setting(uid, "libraries", lib_export(uid))


def lib_changed():
    """Una raccolta e' cambiata da questo PC: l'elenco va nell'account (se il profilo ne ha uno)."""
    u = CURRENT.get()
    if u is not None and u.get("linked"):
        push_libraries(u["id"])


def resolve_folder(entry, taken):
    """Dove sta su questo PC una cartella dell'account (None se qui non c'e')."""
    path = entry.get("path") or ""
    if path and path not in taken and has_content(Path(path)):
        return path
    try:
        found = folder_from_input(entry.get("display") or "")
        if found not in taken and has_content(Path(found)):
            return found
    except HTTPException:
        pass
    moved = moved_folder(path) if path else None
    if moved and moved not in taken:
        return moved
    return None


def reconcile_libraries(uid):
    """Allinea le raccolte di questo PC all'elenco dell'account. Le raccolte nate qui
    e mai sincronizzate restano (e poi vanno nell'account); quelle tolte su un altro PC
    spariscono anche qui."""
    cloud = user_setting(uid, "libraries")
    if not isinstance(cloud, list):
        return False
    changed = False
    with config_lock:
        libs = config.setdefault("libraries", [])
        by_sync = {l["sync_id"]: l for l in libs if l.get("owner") == uid and l.get("sync_id")}
        seen = set()
        for c in cloud:
            sid = str(c.get("id") or "")
            if not sid or not isinstance(c.get("folders"), list):
                continue
            seen.add(sid)
            lib = by_sync.get(sid)
            extra = []
            if lib is None:
                # Un profilo locale appena collegato: la sua raccolta con le stesse
                # cartelle di una dell'account diventa quella (niente doppioni)
                where = {f.get(k) for f in c["folders"] if isinstance(f, dict) for k in ("path", "display")}
                lib = next((l for l in libs if l.get("owner") == uid and not l.get("sync_id")
                            and any(p in where or display_path(p) in where for p in l["folders"])), None)
                if lib is not None:
                    extra = list(lib["folders"])      # le cartelle che l'account non ha restano
                    lib.update(sync_id=sid, synced=False)
                    by_sync[sid] = lib
                    changed = True
            if lib is None:
                lib = {"id": max([x["id"] for x in libs] + [0]) + 1, "name": "", "folders": [],
                       "owner": uid, "sync_id": sid, "synced": True}
                libs.append(lib)
                changed = True
            name = re.sub(r"\s+", " ", str(c.get("name") or "")).strip()[:40] or "Raccolta"
            if lib["name"] != name:
                lib["name"] = name
                changed = True
            if bool(lib.get("shared")) != bool(c.get("shared")):
                lib["shared"] = bool(c.get("shared"))
                changed = True
            taken = {p for other in libs if other is not lib for p in other["folders"]}
            folders, missing = [], []
            for f in c["folders"]:
                if not isinstance(f, dict):
                    continue
                here = next((p for p in lib["folders"]
                             if p == f.get("path") or display_path(p) == f.get("display")), None)
                if here is None:
                    here = resolve_folder(f, taken | set(folders))
                if here and here not in folders:
                    folders.append(here)
                elif not here:
                    missing.append({"path": f.get("path") or "", "display": f.get("display") or ""})
            folders += [p for p in extra if p not in folders]
            if folders != lib["folders"] or missing != (lib.get("missing") or []):
                lib["folders"], lib["missing"] = folders, missing
                changed = True
        for sid, lib in by_sync.items():
            if sid not in seen and lib.get("synced"):
                libs.remove(lib)        # tolta su un altro PC
                changed = True
        if changed:
            save_config()
    if changed:
        scan_async()
    return changed


def sync_libraries(uid):
    """Dopo aver ricevuto le impostazioni: raccolte dell'account qui, raccolte nuove di qui nell'account."""
    reconcile_libraries(uid)
    with config_lock:
        fresh = any(l.get("owner") == uid and not l.get("synced") for l in config.get("libraries") or [])
    if fresh:
        push_libraries(uid)


def drop_cloud_token(uid):
    """Il servizio non riconosce piu' questo PC per l'account (password cambiata
    altrove, password provvisoria nuova, account eliminato). La copia di qui resta e si
    usa come prima; per riprendere la sincronizzazione va ridata la password."""
    con = db(raw=True)
    try:
        con.execute("UPDATE users SET token=NULL WHERE id=?", (uid,))
        con.commit()
    finally:
        con.close()
    user_cache.clear()


async def finish_login(res, ver, device):
    u, token, conflicts = await complete_login(res, ver, device)
    return with_session({"ok": True, "user": user_json(u), "conflicts": conflicts}, token)


class NeedFriend(Exception):
    """Un account che non e' del proprietario e non e' (ancora) suo amico."""
    def __init__(self, data):
        self.data = data


@app.exception_handler(NeedFriend)
async def need_friend_reply(request, ex):
    return JSONResponse({"detail": "Questo server è di " + ex.data["owner"] +
                         ": per vederlo chiedigli l'amicizia.", "ask": ex.data}, status_code=403)


ASK_TTL = 1800
asks = {}                        # biglietto -> {"at", "res", "ver", "device", "owner", "owner_cloud"}
asks_lock = threading.Lock()


def friend_status_with(token, cloud_id):
    """Com'e' l'amicizia tra l'account del gettone e cloud_id: ok, sent, received o ''."""
    res = accounts.call("GET", "/friends", token=token)
    for f in res.get("friends") or []:
        if isinstance(f, dict) and f.get("id") == cloud_id:
            return str(f.get("status") or "")
    return ""


async def guest_check(res, ver, device):
    """Entra un account che non e' il proprietario: se e' suo amico entra come ospite,
    altrimenti si prepara la richiesta d'amicizia (NeedFriend)."""
    con = db(raw=True)
    try:
        owner = owner_row(con)
    finally:
        con.close()
    if not owner or owner["cloud_id"] == res["user"]["id"]:
        return False
    try:
        status = await asyncio.to_thread(friend_status_with, res["token"], owner["cloud_id"])
    except accounts.CloudError as ex:
        raise HTTPException(502, ex.detail)
    except accounts.CloudOffline:
        raise HTTPException(503, "Il server non raggiunge il servizio account: riprova tra poco")
    if status == "ok":
        return True
    ticket = secrets.token_urlsafe(18)
    with asks_lock:
        for k in [k for k, a in asks.items() if time.time() - a["at"] > ASK_TTL]:
            asks.pop(k, None)
        if len(asks) > 50:
            asks.pop(min(asks, key=lambda k: asks[k]["at"]), None)
        asks[ticket] = {"at": time.time(), "res": res, "ver": ver, "device": device,
                        "owner": owner["name"], "owner_cloud": owner["cloud_id"]}
    raise NeedFriend({"ticket": ticket, "owner": owner["name"], "server": pc_name(),
                      "user": res["user"].get("username") or "", "status": status})


async def complete_login(res, ver, device):
    """Account entrato: copia locale, ingresso, impostazioni da confrontare."""
    guest = await guest_check(res, ver, device)
    con = db(raw=True)
    try:
        uid = store_user(con, res["user"], res["token"], ver, guest=guest)
        token = open_session(con, uid, device)
        con.commit()
        u = con.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    finally:
        con.close()
    conflicts = []
    if guest:
        return u, token, conflicts
    if not u["must_change"]:
        try:                       # impostazioni e raccolte subito; visti in sottofondo
            await asyncio.to_thread(pull_settings, uid, res["token"])
            await asyncio.to_thread(sync_libraries, uid)
        except Exception:
            pass
        conflicts = await first_login_conflicts(uid, res["token"])
    mark_cloud(True)
    sync_soon()
    return u, token, conflicts


@app.get("/api/auth/state")
def auth_state():
    """Chi sta guardando, gli account entrati su questo PC (profiles, per «Chi guarda?»)
    e com'e' messo il collegamento con il servizio account."""
    u = CURRENT.get()
    cloud_on = auth_on()
    if cloud_on and (cloud_link["online"] is None or time.time() - cloud_link["at"] > 60):
        cloud_ping()
    offline = cloud_on and cloud_link["online"] is False
    con = db(raw=True)
    try:
        # Con il servizio account si entra sempre con la password, da ogni dispositivo;
        # in «Chi guarda?» c'e' solo il proprietario (gli altri non entrano qui)
        owner = owner_row(con)
        profiles = [{"id": r["id"], "name": r["name"], "linked": r["cloud_id"] is not None,
                     "quick": not cloud_on}
                    for r in con.execute("SELECT id, name, cloud_id FROM users "
                                         "WHERE COALESCE(disabled, 0)=0 ORDER BY created, id")
                    if not owner or r["id"] == owner["id"]]
        me = con.execute("SELECT * FROM users WHERE id=?", (u["id"],)).fetchone() if u else None
        user = None
        if me:
            linked = me["cloud_id"] is not None
            user = dict(user_json(me), tv_quick=bool(me["tv_quick"]), online=linked and bool(me["token"]),
                        manager=not me["guest"] and can_manage(me["id"], linked and bool(me["admin"])),
                        google=me["google"] or "", email=me["email"] or "",
                        last_sync=me["last_sync"] or 0,
                        pending=pending_changes(con, me["id"]) if linked else 0,
                        # «Chi guarda?» dopo il login: i profili dell'account e quello scelto qui
                        watchers=profiles_of(con, me), watcher=u.get("profile"))
    finally:
        con.close()
    return {"on": True, "cloud": cloud_on, "user": user, "offline": offline, "profiles": profiles,
            "setup": cloud_on and SETUP_FILE.is_file() and cloud_ready() is False,
            "google": cloud_on and bool(cloud_status.get("google")),
            "reset": cloud_on and bool(cloud_status.get("reset")),
            "server": SERVER_NAME, "pc": pc_name(), "owner": owner["name"] if owner else ""}


# ---- Profili dell'account («Chi guarda?» dopo il login) ---------------------------
# Un account puo' avere dei profili (famiglia): ognuno con i suoi visti, punti di
# ripresa e La mia lista; raccolte, chiavi e impostazioni restano dell'account.
# Si sceglie il profilo solo DOPO essere entrati con la password dell'account:
# non e' mai un modo per entrare senza password. Il profilo principale (id 0) e'
# l'account stesso e si sincronizza con lui; gli altri restano su questo server.

MAX_PROFILES = 5                 # oltre al principale


def profile_name(raw):
    name = re.sub(r"\s+", " ", str(raw or "")).strip()
    if not name:
        raise HTTPException(400, "Scrivi un nome")
    if len(name) > 24:
        raise HTTPException(400, "Nome troppo lungo (al massimo 24 caratteri)")
    return name


def profiles_of(con, me):
    """I profili dell'account: il principale (id 0, l'account) e quelli aggiunti."""
    return [{"id": 0, "name": me["name"], "main": True}] + [
        {"id": r["id"], "name": r["name"], "main": False}
        for r in con.execute("SELECT id, name FROM profiles WHERE user_id=? ORDER BY created, id", (me["id"],))]


def drop_profile_state(con, pid):
    for table in ("user_items", "user_shows"):
        con.execute(f"DELETE FROM {table} WHERE user_id=?", (-pid,))
    con.execute("UPDATE user_sessions SET profile=NULL WHERE profile=?", (pid,))


def profile_owner():
    """L'account che chiede (gia' entrato con la password su questo dispositivo)."""
    u = CURRENT.get()
    if u is None or u.get("friend") or not u.get("session"):
        raise HTTPException(401, "Entra con il tuo account per continuare")
    return u


def profile_name_free(con, uid, name, but=0):
    me = con.execute("SELECT name FROM users WHERE id=?", (uid,)).fetchone()
    if (me and me["name"].lower() == name.lower()) or con.execute(
            "SELECT 1 FROM profiles WHERE user_id=? AND name=? AND id<>?", (uid, name, but)).fetchone():
        raise HTTPException(409, "C'è già un profilo con questo nome")


def profiles_reply(con, u, current):
    me = con.execute("SELECT id, name FROM users WHERE id=?", (u["id"],)).fetchone()
    return {"ok": True, "profiles": profiles_of(con, me), "current": current}


@app.get("/api/profiles")
def profiles_list():
    u = profile_owner()
    con = db(raw=True)
    try:
        return profiles_reply(con, u, u.get("profile"))
    finally:
        con.close()


@app.post("/api/profiles")
async def profiles_add(request: Request):
    """Un profilo nuovo nell'account (visti, ripresa e lista partono da zero)."""
    u = profile_owner()
    name = profile_name((await read_json(request)).get("name"))
    con = db(raw=True)
    try:
        if con.execute("SELECT COUNT(*) FROM profiles WHERE user_id=?", (u["id"],)).fetchone()[0] >= MAX_PROFILES:
            raise HTTPException(400, f"Al massimo {MAX_PROFILES + 1} profili per account")
        profile_name_free(con, u["id"], name)
        con.execute("INSERT INTO profiles(user_id, name, created) VALUES(?,?,?)", (u["id"], name, time.time()))
        con.commit()
        return profiles_reply(con, u, u.get("profile"))
    finally:
        con.close()


@app.post("/api/profiles/select")
async def profiles_select(request: Request):
    """Chi guarda su questo dispositivo (resta finche' non si cambia o si esce)."""
    u = profile_owner()
    pid = int((await read_json(request)).get("id") or 0)
    con = db(raw=True)
    try:
        if pid and not con.execute("SELECT 1 FROM profiles WHERE id=? AND user_id=?", (pid, u["id"])).fetchone():
            raise HTTPException(404, "Questo profilo non c'è più")
        con.execute("UPDATE user_sessions SET profile=? WHERE token=? AND user_id=?",
                    (pid, token_hash(u["session"]), u["id"]))
        con.commit()
        user_cache.pop(token_hash(u["session"]), None)
        return profiles_reply(con, u, pid)
    finally:
        con.close()


@app.post("/api/profiles/{pid}/rename")
async def profiles_rename(pid: int, request: Request):
    u = profile_owner()
    name = profile_name((await read_json(request)).get("name"))
    con = db(raw=True)
    try:
        if not con.execute("SELECT 1 FROM profiles WHERE id=? AND user_id=?", (pid, u["id"])).fetchone():
            raise HTTPException(404, "Questo profilo non c'è più")
        profile_name_free(con, u["id"], name, pid)
        con.execute("UPDATE profiles SET name=? WHERE id=?", (name, pid))
        con.commit()
        user_cache.clear()
        return profiles_reply(con, u, u.get("profile"))
    finally:
        con.close()


@app.delete("/api/profiles/{pid}")
def profiles_delete(pid: int):
    """Toglie un profilo con i suoi visti, ripresa e lista (non tocca l'account)."""
    u = profile_owner()
    con = db(raw=True)
    try:
        if not con.execute("SELECT 1 FROM profiles WHERE id=? AND user_id=?", (pid, u["id"])).fetchone():
            raise HTTPException(404, "Questo profilo non c'è più")
        drop_profile_state(con, pid)
        con.execute("DELETE FROM profiles WHERE id=?", (pid,))
        con.commit()
        user_cache.clear()
        return profiles_reply(con, u, None if u.get("profile") == pid else u.get("profile"))
    finally:
        con.close()


@app.post("/api/auth/profile")
async def auth_profile(request: Request):
    """«Chi guarda?»: senza password solo quando non c'e' il servizio account (l'utente
    di questo PC). Con gli account ogni dispositivo entra con nome e password."""
    body = await read_json(request)
    con = db(raw=True)
    try:
        u = con.execute("SELECT * FROM users WHERE id=?", (int(body.get("id") or 0),)).fetchone()
        if not u:
            raise HTTPException(404, "Questo account non c'è più su questo PC")
        if u["disabled"]:
            raise HTTPException(403, "Questo account è disattivato: chiedi all'amministratore")
        if auth_on():
            raise HTTPException(403, "Questo account si apre con la sua password")
        token = open_session(con, u["id"], body.get("device") or "tv")
        con.execute("UPDATE users SET last_login=? WHERE id=?", (time.time(), u["id"]))
        con.commit()
    finally:
        con.close()
    return with_session({"ok": True, "user": user_json(u)}, token)


@app.delete("/api/auth/profile")
async def auth_profile_delete(request: Request):
    """Toglie da questo PC l'account in cui si e' entrati (l'account resta online).
    Le sue raccolte passano al primo degli altri account di qui: i video restano."""
    u = CURRENT.get()
    if u is None:
        raise HTTPException(401, "Scegli chi guarda per continuare")
    await remove_local_user(u["id"])
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(SESSION_COOKIE, path="/")
    return resp


async def remove_local_user(uid):
    """Toglie un account da questo PC (l'account resta online): le sue raccolte
    passano al primo degli altri account di qui, i video restano."""
    con = db(raw=True)
    try:
        row = con.execute("SELECT token FROM users WHERE id=?", (uid,)).fetchone()
        if not row:
            raise HTTPException(404, "Questo account non c'è più su questo PC")
        heir = con.execute("SELECT id FROM users WHERE id<>? ORDER BY created, id LIMIT 1", (uid,)).fetchone()
        if not heir:
            raise HTTPException(400, "È l'unico account di questo PC: non si può togliere")
        token = row["token"]
        for table in ("user_items", "user_shows", "user_settings", "cloud_state", "user_sessions"):
            con.execute(f"DELETE FROM {table} WHERE user_id=?", (uid,))
        for p in con.execute("SELECT id FROM profiles WHERE user_id=?", (uid,)).fetchall():
            drop_profile_state(con, p["id"])
        con.execute("DELETE FROM profiles WHERE user_id=?", (uid,))
        con.execute("DELETE FROM users WHERE id=?", (uid,))
        con.commit()
    finally:
        con.close()
    with config_lock:
        for lib in config.get("libraries") or []:
            if lib.get("owner") == uid:
                lib.update(owner=heir["id"], synced=False)
        save_config()
    user_cache.clear()
    await asyncio.to_thread(forget_account_friends, uid, token)
    if token:
        try:
            await asyncio.to_thread(accounts.call, "POST", "/logout", {}, token, 6)
        except Exception:
            pass


def forget_account_friends(uid, token):
    """L'account non c'e' piu' su questo PC: via i
    collegamenti ai suoi amici, gli ingressi dei suoi amici e il suo indirizzo nella rubrica."""
    for f in [f for f in get_friends() if f.get("via") == "account" and f.get("owner") == uid]:
        friend_drop(f["n"])
    con = db(raw=True)
    try:
        gone = [r["id"] for r in con.execute("SELECT id FROM accounts WHERE profile=?", (uid,))]
    finally:
        con.close()
    for a in gone:
        account_drop(a)
    with config_lock:
        had = (config.get("presence") or {}).pop(str(uid), None)
        if had:
            save_config()
    cred = server_cred()
    if cred:
        con = db(raw=True)
        try:
            others = con.execute("SELECT 1 FROM users WHERE cloud_id=? AND id<>?", (cred["owner"], uid)).fetchone()
        finally:
            con.close()
        if not others:               # era il proprietario: il server esce dall'account
            drop_server_cred()
    if had and token:
        try:
            accounts.call("DELETE", f"/servers/{pc_id()}", token=token, timeout=6)
        except Exception:
            pass
    friends_cloud.pop(uid, None)


@app.post("/api/auth/setup")
async def auth_setup(request: Request):
    """Il primo account (amministratore), solo sul PC che ha la chiave di installazione."""
    body = await read_json(request)
    name, password = login_fields(body)
    check_new_password(password)
    try:
        key = json.loads(SETUP_FILE.read_text("utf-8")).get("setup_key") or ""
    except (OSError, ValueError):
        raise HTTPException(400, "Su questo PC non c'è la chiave per creare l'amministratore")
    ver = await asyncio.to_thread(accounts.verifier, name, password)
    res = await cloud("POST", "/setup", {"setup_key": key, "username": name, "verifier": ver,
                                         "device": SERVER_NAME, "kind": "server"})
    SETUP_FILE.unlink(missing_ok=True)
    cloud_status["at"] = 0.0
    return await finish_login(res, ver, body.get("device") or "browser")


@app.post("/api/auth/login")
async def auth_login(request: Request):
    """Accesso con un account. La prima volta su questo PC prende l'utente di qui
    senza account, se c'e' (vedi store_user); altrimenti nasce la sua copia."""
    body = await read_json(request)
    name, password = login_fields(body)
    name = await login_name(name)
    ver = await asyncio.to_thread(accounts.verifier, name, password)
    try:
        res = await asyncio.to_thread(accounts.call, "POST", "/login",
                                      {"username": name, "verifier": ver, "device": SERVER_NAME, "kind": "server"})
    except accounts.CloudError as ex:
        raise HTTPException(ex.status if ex.status in (400, 401, 403, 429) else 502, ex.detail)
    except accounts.CloudOffline:
        # Senza Internet: vale l'ultima password usata su questo PC
        mark_cloud(False)
        con = db(raw=True)
        try:
            u = con.execute("SELECT * FROM users WHERE name=? AND cloud_id IS NOT NULL AND vcheck IS NOT NULL",
                            (name,)).fetchone()
            ok = u and hmac.compare_digest(hashlib.sha256((u["vsalt"] + ver).encode()).hexdigest(), u["vcheck"])
            if not ok:
                raise HTTPException(503, "Il servizio account non risponde e su questo PC non risulta "
                                         "questo accesso: controlla la connessione del PC")
            if u["disabled"]:
                raise HTTPException(403, "Questo account è disattivato: chiedi all'amministratore")
            token = open_session(con, u["id"], body.get("device"))
            con.commit()
        finally:
            con.close()
        return with_session({"ok": True, "user": user_json(u), "offline": True}, token)
    return await finish_login(res, ver, body.get("device") or "browser")


def reset_email(body):
    email = str(body.get("email") or "").strip().lower()
    if "@" not in email:
        raise HTTPException(400, "Scrivi l'email del tuo account")
    return email


@app.post("/api/auth/reset/start")
async def auth_reset_start(request: Request):
    """«Password dimenticata?»: il servizio account manda un codice all'email dell'account."""
    email = reset_email(await read_json(request))
    await cloud("POST", "/reset/start", {"email": email})
    return {"ok": True}


@app.post("/api/auth/reset/finish")
async def auth_reset_finish(request: Request):
    """Codice dell'email + password nuova: si entra subito con quella."""
    body = await read_json(request)
    email = reset_email(body)
    code = re.sub(r"\D", "", str(body.get("code") or ""))
    if len(code) != 6:
        raise HTTPException(400, "Il codice ha 6 cifre: lo trovi nell'email")
    password = str(body.get("password") or "")
    check_new_password(password)
    name = await login_name(email)
    ver = await asyncio.to_thread(accounts.verifier, name, password)
    res = await cloud("POST", "/reset/finish", {"email": email, "code": code, "verifier": ver,
                                                "device": SERVER_NAME, "kind": "server"})
    return await finish_login(res, ver, body.get("device") or "browser")


def pending_name(name):
    """Nome provvisorio di un account invitato dalla plancia: al primo accesso si sceglie il suo."""
    return bool(re.fullmatch(r"invito-[0-9a-f]{6}", str(name or ""), re.I))


@app.post("/api/auth/password")
async def auth_password(request: Request):
    u = CURRENT.get()
    if u is None or not u["linked"]:
        raise HTTPException(400, "Qui non sei entrato con un account")
    body = await read_json(request)
    old, new = str(body.get("old") or ""), str(body.get("new") or "")
    check_new_password(new)
    if old == new:
        raise HTTPException(400, "La password nuova deve essere diversa da quella di prima")
    con = db(raw=True)
    try:
        row = con.execute("SELECT * FROM users WHERE id=?", (u["id"],)).fetchone()
    finally:
        con.close()
    if not row["token"]:
        raise HTTPException(401, "Rientra con il tuo account per cambiare la password")
    # Primo accesso di un invitato: sceglie anche il suo nome (la verifica nuova si calcola su quello)
    name = row["name"]
    payload = {}
    if pending_name(row["name"]):
        name = str(body.get("name") or "").strip()
        if not name:
            raise HTTPException(400, "Al primo accesso scegli il tuo nome (dal browser o dal telefono)")
        if not re.fullmatch(r"[A-Za-z0-9._-]{2,32}", name) or name.lower().startswith("invito-"):
            raise HTTPException(400, "Nome: da 2 a 32 caratteri tra lettere, numeri, punto, trattino e trattino basso")
        payload["new_username"] = name
    v_old = await asyncio.to_thread(accounts.verifier, row["name"], old)
    v_new = await asyncio.to_thread(accounts.verifier, name, new)
    try:
        await cloud("POST", "/password", {"verifier": v_old, "new_verifier": v_new, **payload}, row["token"])
    except HTTPException as ex:
        if ex.status_code == 401 and "password" in str(ex.detail).lower():
            raise HTTPException(400, "La password provvisoria non è giusta" if row["must_change"]
                                else "La password attuale non è giusta")
        raise
    vsalt = secrets.token_hex(16)
    con = db(raw=True)
    try:
        con.execute("UPDATE users SET name=?, must_change=0, vsalt=?, vcheck=? WHERE id=?",
                    (name, vsalt, hashlib.sha256((vsalt + v_new).encode()).hexdigest(), u["id"]))
        con.commit()
    finally:
        con.close()
    user_cache.clear()
    # Primo accesso con la password provvisoria: ora si possono confrontare le impostazioni
    conflicts = []
    if row["must_change"]:
        try:
            await asyncio.to_thread(pull_settings, u["id"], row["token"])
            await asyncio.to_thread(sync_libraries, u["id"])
        except Exception:
            pass
        conflicts = await first_login_conflicts(u["id"], row["token"])
    sync_soon()
    return {"ok": True, "conflicts": conflicts}


@app.post("/api/auth/logout")
def auth_logout(request: Request):
    """«Esci»: si esce dall'account su questo dispositivo (l'account resta, anche su questo PC)."""
    token = request.headers.get("x-bp-session") or request.cookies.get(SESSION_COOKIE) or ""
    if token:
        con = db(raw=True)
        try:
            con.execute("DELETE FROM user_sessions WHERE token=?", (token_hash(token),))
            con.commit()
        finally:
            con.close()
        user_cache.pop(token_hash(token), None)
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(SESSION_COOKIE, path="/")
    return resp


@app.post("/api/auth/options")
async def auth_options(request: Request):
    u = CURRENT.get()
    if u is None:
        raise HTTPException(401, "Scegli chi guarda per continuare")
    body = await read_json(request)
    con = db(raw=True)
    try:
        if body.get("tv_quick"):
            # Entrare senza password non c'e' piu': ogni dispositivo entra con la sua password
            raise HTTPException(400, "Ogni dispositivo entra con la password dell'account")
        con.commit()
    finally:
        con.close()
    return {"ok": True}


# ---- Accesso dalla TV con il telefono ------------------------------------------
# Sulla TV scrivere nome e password col telecomando e' scomodo: la TV mostra un
# codice (e il suo QR), il telefono di casa apre l'indirizzo e scrive li' nome e
# password. Quando l'accesso riesce la TV entra da sola (chiede ogni 2 secondi).
# Serve per gli account che su questo PC non sono ancora entrati: quelli che
# ci sono gia' si scelgono in «Chi guarda?».

def ask_get(ticket):
    with asks_lock:
        a = asks.get(str(ticket or ""))
    if not a or time.time() - a["at"] > ASK_TTL:
        raise HTTPException(404, "Richiesta scaduta: rientra con il tuo account")
    return a


@app.post("/api/auth/ask/{ticket}")
async def auth_ask_send(ticket: str):
    """Dalla pagina «Questo server è di ...»: manda la richiesta d'amicizia al proprietario."""
    a = ask_get(ticket)
    try:
        r = await asyncio.to_thread(accounts.call, "POST", "/friends", {"username": a["owner"]}, a["res"]["token"])
    except accounts.CloudError as ex:
        raise HTTPException(ex.status if ex.status in (400, 404, 409, 429) else 502, ex.detail)
    except accounts.CloudOffline:
        raise HTTPException(503, "Il server non raggiunge il servizio account: riprova tra poco")
    status = str((r or {}).get("status") or "sent")
    if status == "ok":
        return await auth_ask_poll(ticket)
    return {"done": False, "status": status}


@app.get("/api/auth/ask/{ticket}")
async def auth_ask_poll(ticket: str):
    """Il proprietario ha accettato? Allora si entra come ospite (una volta sola)."""
    a = ask_get(ticket)
    try:
        status = await asyncio.to_thread(friend_status_with, a["res"]["token"], a["owner_cloud"])
    except (accounts.CloudError, accounts.CloudOffline):
        return {"done": False, "status": "", "retry": True}
    if status != "ok":
        return {"done": False, "status": status}
    with asks_lock:
        asks.pop(ticket, None)
    u, token, conflicts = await complete_login(a["res"], a["ver"], a["device"])
    return with_session({"done": True, "ok": True, "user": user_json(u), "conflicts": conflicts}, token)


PAIR_TTL = 600
PAIR_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
pairs = {}                       # codice -> {"at", "token", "user", "conflicts", "name"}
pairs_lock = threading.Lock()


def pair_get(code):
    code = re.sub(r"[^A-Z0-9]", "", str(code or "").upper())
    with pairs_lock:
        for k in [k for k, p in pairs.items() if time.time() - p["at"] > PAIR_TTL]:
            pairs.pop(k, None)
        p = pairs.get(code)
    if not p:
        raise HTTPException(404, "Codice scaduto o sbagliato: sulla TV ne compare uno nuovo")
    return code, p


def qr_svg(url):
    try:
        import io
        import segno
        buf = io.BytesIO()
        segno.make(url, error="m").save(buf, kind="svg", scale=1, border=2, dark="#060a07",
                                        light="#f2f5f2", xmldecl=False, omitsize=True, nl=False)
        return buf.getvalue().decode("utf-8")
    except Exception as ex:          # pacchetto non ancora installato (immagine vecchia)
        print("QR non disponibile:", repr(ex), flush=True)
        return ""


def qr_rows(url):
    """Lo stesso QR come righe di 0 e 1: l'app TV nativa lo disegna da se'."""
    try:
        import segno
        return ["".join("1" if c else "0" for c in row) for row in segno.make(url, error="m").matrix]
    except Exception:
        return []


@app.post("/api/auth/pair")
def auth_pair_start(request: Request):
    """La TV chiede un codice da mostrare."""
    if not auth_on():
        raise HTTPException(400, "Il servizio account non è configurato su questo PC")
    code = "".join(secrets.choice(PAIR_CHARS) for _ in range(6))
    with pairs_lock:
        if len(pairs) > 30:
            pairs.pop(min(pairs, key=lambda k: pairs[k]["at"]), None)
        pairs[code] = {"at": time.time(), "token": None}
    host = request.headers.get("host", "")
    port = host.rsplit(":", 1)[1] if ":" in host and not host.endswith("]") else "32500"
    ip = private_ip(host)
    url = f"http://{ip}:{port}/#/pair/{code}" if ip else ""
    return {"code": code, "url": url, "base": f"http://{ip}:{port}" if ip else "",
            "svg": qr_svg(url) if url else "", "qr": qr_rows(url) if url else [], "ttl": PAIR_TTL}


@app.get("/api/auth/pair/{code}")
def auth_pair_poll(code: str):
    """La TV chiede se il telefono ha finito. Quando si', entra (una volta sola)."""
    code, p = pair_get(code)
    if not p["token"]:
        return {"done": False}
    with pairs_lock:
        pairs.pop(code, None)
    return with_session({"done": True, "ok": True, "user": p["user"], "conflicts": p["conflicts"]}, p["token"])


@app.post("/api/auth/pair/{code}")
async def auth_pair_finish(code: str, request: Request):
    """Dal telefono: nome e password (e, se la password e' provvisoria, quella nuova) per la TV."""
    code, p = pair_get(code)
    if p["token"]:
        return {"ok": True, "name": p["name"]}
    body = await read_json(request)
    me = CURRENT.get()
    if me is not None and body.get("session") and not body.get("password"):
        # Dal telefono o dal PC gia' entrati: basta il codice, la TV entra con lo stesso account
        con = db(raw=True)
        try:
            token = open_session(con, me["id"], "tv")
            con.commit()
            u = con.execute("SELECT * FROM users WHERE id=?", (me["id"],)).fetchone()
        finally:
            con.close()
        with pairs_lock:
            p.update(token=token, user=user_json(u), conflicts=[], name=u["name"])
        return {"ok": True, "name": u["name"]}
    name, password = login_fields(body)
    name = await login_name(name)
    new = str(body.get("new") or "")
    ver = await asyncio.to_thread(accounts.verifier, name, password)
    try:
        res = await asyncio.to_thread(accounts.call, "POST", "/login",
                                      {"username": name, "verifier": ver, "device": SERVER_NAME, "kind": "server"})
        if res["user"].get("must_change"):
            if not new:
                raise HTTPException(409, "La password è provvisoria: scegline una tua")
            check_new_password(new)
            if new == password:
                raise HTTPException(400, "La password nuova deve essere diversa da quella provvisoria")
            v_new = await asyncio.to_thread(accounts.verifier, name, new)
            await asyncio.to_thread(accounts.call, "POST", "/password",
                                    {"verifier": ver, "new_verifier": v_new}, res["token"])
            res["user"]["must_change"] = False     # il gettone appena avuto resta valido
            ver = v_new
    except accounts.CloudError as ex:
        raise HTTPException(ex.status if ex.status in (400, 401, 403, 429) else 502, ex.detail)
    except accounts.CloudOffline:
        mark_cloud(False)
        raise HTTPException(503, "Il PC non raggiunge il servizio account: serve Internet per entrare con un account")
    u, token, conflicts = await complete_login(res, ver, "tv")
    with pairs_lock:
        p.update(token=token, user=user_json(u), conflicts=conflicts, name=u["name"])
    return {"ok": True, "name": u["name"]}


# «Entra con Google». Google parla solo con il servizio account (un indirizzo fisso
# registrato da Google): qui si chiede un codice, si mostra l'indirizzo (e il QR,
# per la TV) e intanto si domanda al servizio se Google ha risposto. Quando si',
# l'account entra come con la password. link: collega Google all'account di chi chiede.
gflows = {}                      # id -> {"at", "poll", "link", "uid", "kind"}
gflows_lock = threading.Lock()


def user_cloud_token(uid):
    con = db(raw=True)
    try:
        r = con.execute("SELECT token FROM users WHERE id=?", (uid,)).fetchone()
    finally:
        con.close()
    if not r or not r["token"]:
        raise HTTPException(401, "Rientra con la password del tuo account (serve Internet)")
    return r["token"]


@app.post("/api/auth/google")
async def auth_google_start(request: Request):
    if not auth_on():
        raise HTTPException(400, "Il servizio account non è configurato su questo PC")
    body = await read_json(request)
    kind = body.get("device") if body.get("device") in ("tv", "phone", "browser") else "browser"
    link, token = bool(body.get("link")), None
    u = CURRENT.get()
    if link:
        if u is None or not u["linked"]:
            raise HTTPException(400, "Prima entra con un account")
        token = user_cloud_token(u["id"])
    res = await cloud("POST", "/google/start", {"link": link, "device": SERVER_NAME, "kind": kind}, token)
    fid = secrets.token_urlsafe(16)
    with gflows_lock:
        for k in [k for k, f in gflows.items() if time.time() - f["at"] > 900]:
            gflows.pop(k, None)
        if len(gflows) > 50:
            gflows.pop(min(gflows, key=lambda k: gflows[k]["at"]), None)
        gflows[fid] = {"at": time.time(), "poll": res["poll"], "link": link, "uid": u["id"] if link else None,
                       "kind": kind}
    code = res["code"]
    return {"id": fid, "url": res["url"], "short": res["short"], "code": code[:4] + "-" + code[4:],
            "svg": qr_svg(res["url"]), "qr": qr_rows(res["url"]), "ttl": res.get("ttl", 600)}


@app.get("/api/auth/google/{fid}")
async def auth_google_poll(fid: str):
    with gflows_lock:
        f = gflows.get(fid)
    if not f:
        raise HTTPException(404, "Codice scaduto: ricomincia da «Entra con Google»")
    try:
        res = await asyncio.to_thread(accounts.call, "POST", "/google/poll", {"poll": f["poll"]}, None, 10)
    except accounts.CloudOffline:
        return {"done": False}               # si riprova al giro dopo
    except accounts.CloudError as ex:
        with gflows_lock:
            gflows.pop(fid, None)
        raise HTTPException(ex.status if ex.status in (400, 403, 404, 409, 429) else 502, ex.detail)
    if not res.get("done"):
        return {"done": False}
    with gflows_lock:
        gflows.pop(fid, None)
    if f["link"]:
        con = db(raw=True)
        try:
            con.execute("UPDATE users SET google=? WHERE id=?", (res["user"].get("google") or None, f["uid"]))
            con.commit()
        finally:
            con.close()
        return {"done": True, "linked": True, "google": res["user"].get("google") or ""}
    u, token, conflicts = await complete_login(res, None, f["kind"])
    return with_session({"done": True, "ok": True, "user": user_json(u), "conflicts": conflicts}, token)


@app.delete("/api/auth/google")
async def auth_google_unlink():
    u = CURRENT.get()
    if u is None or not u["linked"]:
        raise HTTPException(400, "Qui non sei entrato con un account")
    await cloud("DELETE", "/google", None, user_cloud_token(u["id"]))
    con = db(raw=True)
    try:
        con.execute("UPDATE users SET google=NULL WHERE id=?", (u["id"],))
        con.commit()
    finally:
        con.close()
    return {"ok": True}


@app.put("/api/auth/email")
async def auth_email(request: Request):
    """La propria email per entrare con email e password (vuota: la toglie)."""
    u = CURRENT.get()
    if u is None or not u["linked"]:
        raise HTTPException(400, "Qui non sei entrato con un account")
    body = await read_json(request)
    res = await cloud("PUT", "/email", {"email": str(body.get("email") or "").strip()}, user_cloud_token(u["id"]))
    email = (res.get("user") or {}).get("email") or ""
    con = db(raw=True)
    try:
        con.execute("UPDATE users SET email=? WHERE id=?", (email.lower() or None, u["id"]))
        con.commit()
    finally:
        con.close()
    return {"ok": True, "email": email}


# Preferenze di visione (animazioni, locandine, sottotitoli, velocita'...): nell'account
PREF_KEYS = ("device", "player")


@app.get("/api/me/prefs")
def me_prefs():
    u = CURRENT.get()
    if u is None:
        return {}
    return {k: user_setting(u["id"], k) or {} for k in PREF_KEYS}


@app.post("/api/me/prefs")
async def me_prefs_save(request: Request):
    u = CURRENT.get()
    body = await read_json(request)
    if u is None:
        return {"ok": False}
    for k in PREF_KEYS:
        if isinstance(body.get(k), dict) and len(json.dumps(body[k])) < 8000:
            put_user_setting(u["id"], k, body[k])
    return {"ok": True}


# ---- Gestione degli account (solo amministratori) ----------------------------

def admin_token():
    u = CURRENT.get()
    if u is None or not u["admin"]:
        raise HTTPException(403, "Solo l'amministratore può gestire gli account")
    con = db(raw=True)
    try:
        r = con.execute("SELECT token FROM users WHERE id=?", (u["id"],)).fetchone()
    finally:
        con.close()
    if not r or not r["token"]:
        raise HTTPException(401, "Rientra con il tuo account (serve Internet) per gestire gli account")
    return r["token"]


@app.get("/api/accounts")
async def accounts_list():
    return (await cloud("GET", "/admin/users", token=admin_token()))["users"]


@app.post("/api/accounts")
async def accounts_create(request: Request):
    """Invito: gli account li crea solo l'amministratore, con l'email. L'account nasce con un
    nome provvisorio; la password provvisoria parte per email e al primo accesso la persona
    sceglie il suo nome e la sua password."""
    token = admin_token()
    body = await read_json(request)
    email = str(body.get("email") or "").strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise HTTPException(400, "Scrivi l'email della persona da invitare")
    password = str(body.get("password") or "") or "-".join(secrets.token_hex(2) for _ in range(3))
    check_new_password(password)
    name = "invito-" + secrets.token_hex(3)
    ver = await asyncio.to_thread(accounts.verifier, name, password)
    res = await cloud("POST", "/admin/users", {"username": name, "verifier": ver, "email": email,
                                               "password": password, "admin": bool(body.get("admin"))}, token)
    return {"ok": True, "username": name, "email": email, "mailed": bool(res.get("mailed")),
            # Se l'email non e' partita la password la comunica l'amministratore
            "password": None if res.get("mailed") else password}


@app.put("/api/accounts/{cloud_id}/email")
async def accounts_email(cloud_id: int, request: Request):
    """L'email con cui l'account entra al posto del nome utente (vuota: la toglie)."""
    token = admin_token()
    body = await read_json(request)
    return await cloud("PUT", f"/admin/users/{cloud_id}/email", {"email": body.get("email") or ""}, token)


@app.put("/api/accounts/{cloud_id}/google")
async def accounts_google(cloud_id: int, request: Request):
    """L'email Google con cui l'account potra' entrare (vuota: la toglie)."""
    token = admin_token()
    body = await read_json(request)
    return await cloud("PUT", f"/admin/users/{cloud_id}/google", {"google": body.get("google") or ""}, token)


@app.post("/api/accounts/{cloud_id}/password")
async def accounts_reset(cloud_id: int, request: Request):
    token = admin_token()
    body = await read_json(request)
    name, password = login_fields(body)
    check_new_password(password)
    ver = await asyncio.to_thread(accounts.verifier, name, password)
    res = await cloud("POST", f"/admin/users/{cloud_id}/password", {"verifier": ver, "password": password}, token)
    return {"ok": True, "mailed": bool(res.get("mailed"))}


@app.post("/api/accounts/{cloud_id}/link")
async def accounts_link(cloud_id: int):
    """Il link di attivazione di un account invitato, da mandare a mano (vale 14 giorni)."""
    return await cloud("POST", f"/admin/users/{cloud_id}/link", {}, admin_token())


@app.delete("/api/accounts/{cloud_id}")
async def accounts_delete(cloud_id: int):
    return await cloud("DELETE", f"/admin/users/{cloud_id}", token=admin_token())


# ---- Plancia di amministrazione ------------------------------------------------
# Due ruoli per tutta BunkerPlex (li tiene il servizio account):
# - base: guarda, gestisce le sue raccolte, la sua lista, i suoi amici;
# - amministratore: in piu' gestisce gli account (ruoli, attivazioni, password),
#   gli accessi di ogni PC/TV/telefono, i server pubblicati e la rete.
# Su un singolo server le impostazioni comuni (condivisione, nome del PC, amici
# che entrano) le cambia chi lo gestisce: il proprietario (vedi server_owner) o un
# amministratore. L'aggiornamento resta del solo proprietario (update_owner_only).

def can_manage(uid, admin):
    owner = server_owner()
    return owner is None or bool(admin) or uid == owner


def manager_only():
    u = CURRENT.get()
    if u is None or u.get("friend") or u.get("guest") or not can_manage(u["id"], u.get("admin")):
        raise HTTPException(403, "Solo un amministratore o il proprietario di questo server può cambiarlo")
    return u


@app.put("/api/accounts/{cloud_id}/role")
async def accounts_role(cloud_id: int, request: Request):
    token = admin_token()
    role = "admin" if (await read_json(request)).get("role") == "admin" else "base"
    res = await cloud("PUT", f"/admin/users/{cloud_id}/role", {"role": role}, token)
    con = db(raw=True)
    try:
        con.execute("UPDATE users SET admin=? WHERE cloud_id=?", (int(role == "admin"), cloud_id))
        con.commit()
    finally:
        con.close()
    user_cache.clear()
    return res


@app.put("/api/accounts/{cloud_id}/active")
async def accounts_active(cloud_id: int, request: Request):
    token = admin_token()
    on = bool((await read_json(request)).get("active"))
    res = await cloud("PUT", f"/admin/users/{cloud_id}/active", {"active": on}, token)
    await asyncio.to_thread(set_disabled, cloud_id, None, not on)
    return res


@app.get("/api/admin/sessions")
async def admin_sessions(user: int = 0):
    return await cloud("GET", "/admin/sessions" + (f"?user={user}" if user else ""), token=admin_token())


@app.delete("/api/admin/sessions/{sid}")
async def admin_session_drop(sid: int):
    return await cloud("DELETE", f"/admin/sessions/{sid}", token=admin_token())


@app.delete("/api/admin/servers/{uid}/{sid}")
async def admin_server_drop(uid: int, sid: str):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", sid):
        raise HTTPException(400, "Richiesta non valida")
    return await cloud("DELETE", f"/admin/servers/{uid}/{sid}", token=admin_token())


@app.delete("/api/admin/friends/{a}/{b}")
async def admin_friend_drop(a: int, b: int):
    return await cloud("DELETE", f"/admin/friends/{a}/{b}", token=admin_token())


def local_overview():
    """Questo server: account entrati qui, accessi aperti (browser, TV, telefoni),
    amici che entrano da fuori."""
    owner = server_owner()
    con = db(raw=True)
    try:
        users = [{"id": r["id"], "name": r["name"], "linked": r["cloud_id"] is not None,
                  "cloud_id": r["cloud_id"], "admin": r["cloud_id"] is not None and bool(r["admin"]),
                  "owner": r["id"] == owner, "online": bool(r["token"]), "last_login": r["last_login"] or 0,
                  "disabled": bool(r["disabled"]),
                  "sessions": r["n"]}
                 for r in con.execute("SELECT u.*, (SELECT COUNT(*) FROM user_sessions s WHERE s.user_id=u.id) n "
                                      "FROM users u ORDER BY created, id")]
        sessions = [{"id": r["rowid"], "user_id": r["user_id"], "name": r["name"] or "", "device": r["device"] or "",
                     "created": r["created"] or 0, "last_seen": r["last_seen"] or 0}
                    for r in con.execute("SELECT s.rowid, s.user_id, s.device, s.created, s.last_seen, u.name "
                                         "FROM user_sessions s LEFT JOIN users u ON u.id=s.user_id "
                                         "ORDER BY s.last_seen DESC LIMIT 300")]
        guests = [{"id": r["id"], "name": r["name"], "approved": bool(r["approved"]), "last_seen": r["last_seen"] or 0}
                  for r in con.execute("SELECT id, name, approved, last_seen FROM accounts ORDER BY approved, name COLLATE NOCASE")]
    finally:
        con.close()
    with config_lock:
        nlibs = len(config.get("libraries") or [])
    upd = updater.snapshot()
    return {"name": pc_name(), "release": upd.get("release") or "", "update": bool(upd.get("enabled") and upd.get("available")),
            "auto_update": auto_update(), "share": share_on(), "libraries": nlibs,
            "users": users, "sessions": sessions, "guests": guests}


@app.get("/api/admin/overview")
async def admin_overview():
    u = CURRENT.get()
    if u is None or u.get("friend") or not u.get("admin"):
        raise HTTPException(403, "La plancia è solo per gli amministratori")
    out = {"server": await asyncio.to_thread(local_overview), "cloud": None, "cloud_error": ""}
    try:
        out["cloud"] = await cloud("GET", "/admin/overview", token=admin_token())
    except HTTPException as ex:
        out["cloud_error"] = ("Il servizio account va aggiornato per la plancia completa"
                              if ex.status_code == 404 else str(ex.detail))
    return out


@app.delete("/api/admin/local-sessions/{sid}")
def admin_local_session_drop(sid: int):
    """Chiude un accesso a questo server (un browser, una TV, un telefono)."""
    manager_only()
    u = CURRENT.get()
    con = db(raw=True)
    try:
        r = con.execute("SELECT token FROM user_sessions WHERE rowid=?", (sid,)).fetchone()
        if not r:
            raise HTTPException(404, "Accesso non trovato")
        if u and u.get("session") and r["token"] == token_hash(u["session"]):
            raise HTTPException(400, "È l'accesso che stai usando adesso")
        con.execute("DELETE FROM user_sessions WHERE rowid=?", (sid,))
        con.commit()
    finally:
        con.close()
    user_cache.clear()
    return {"ok": True}


@app.delete("/api/admin/local-users/{uid}")
async def admin_local_user_drop(uid: int):
    """Toglie un account da questo server (l'account resta: puo' rientrare)."""
    me = manager_only()
    if uid == me["id"]:
        raise HTTPException(400, "Per togliere il tuo account usa Impostazioni → Account")
    if uid == server_owner():
        raise HTTPException(400, "Il proprietario di questo server non si può togliere")
    await remove_local_user(uid)
    return {"ok": True}


# ---- Sincronizzazione con il servizio account --------------------------------

SYNC_ROWS = 40                   # righe per chiamata (limite del piano gratuito di Cloudflare)


def chunks(rows, n=SYNC_ROWS):
    for i in range(0, len(rows), n):
        yield rows[i:i + n]


# ---- Doppioni ------------------------------------------------------------------------
# Lo stesso film (stessa scheda TMDB) o lo stesso episodio (serie, stagione, episodio)
# in piu' file. La campanella lo segnala a chi gestisce il server; dalla pagina
# «Doppioni» si sceglie quale copia togliere. I dischi sono collegati a Docker in
# sola lettura: il file lo sposta nel Cestino di Windows l'aiutante sul PC
# (strumenti\Agente.ps1), cosi' si puo' sempre recuperare. Un gruppo si puo' anche
# ignorare (es. versione estesa e versione al cinema).

TRASH_REQUEST = updater.TOOLS / "richiesta-cestino.json"
TRASH_RESULT = updater.TOOLS / "esito-cestino.json"
trash_lock = threading.Lock()


def duplicate_groups(con):
    ignored = set(config.get("dup_ignore") or [])
    groups = {}
    for r in con.execute(
            "SELECT i.id, i.kind, i.path, i.title, i.year, i.tmdb_id, i.show_id, i.season, i.episode, i.size, "
            "i.width, i.height, i.vcodec, i.duration, i.library_id, s.title AS show FROM items i "
            "LEFT JOIN shows s ON s.id = i.show_id WHERE (i.kind='movie' AND i.tmdb_id IN "
            "(SELECT tmdb_id FROM items WHERE kind='movie' AND tmdb_id IS NOT NULL GROUP BY tmdb_id HAVING COUNT(*) > 1)) "
            "OR (i.kind='episode' AND i.season IS NOT NULL AND i.episode IS NOT NULL AND "
            "(i.show_id, i.season, i.episode) IN (SELECT show_id, season, episode FROM items WHERE kind='episode' "
            "AND season IS NOT NULL AND episode IS NOT NULL GROUP BY show_id, season, episode HAVING COUNT(*) > 1)) "
            "ORDER BY i.id"):
        key = f"m{r['tmdb_id']}" if r["kind"] == "movie" else f"e{r['show_id']}-{r['season']}-{r['episode']}"
        if key in ignored:
            continue
        if key not in groups:
            title = (r["title"] + (f" ({r['year']})" if r["year"] else "")) if r["kind"] == "movie" \
                else f"{r['show']} · stagione {r['season']}, episodio {r['episode']}"
            groups[key] = {"key": key, "title": title, "items": []}
        groups[key]["items"].append(r)
    return [g for g in groups.values() if len(g["items"]) > 1]


def duplicates_count():
    con = db(raw=True)
    try:
        return len(duplicate_groups(con))
    finally:
        con.close()


def windows_path(path):
    """/host/g/Video/x.mkv -> G:\\Video\\x.mkv (None se non e' su un disco di Windows)."""
    p = display_path(path)
    return p if re.fullmatch(r"[A-Z]:\\[^<>\"|?*\x00-\x1f]+", p) else None


@app.get("/api/duplicates")
async def duplicates_list():
    manager_only()

    def work():
        con = db(raw=True)
        try:
            groups = duplicate_groups(con)
        finally:
            con.close()
        with config_lock:
            names = {lib["id"]: lib.get("name") or "" for lib in config.get("libraries") or []}
        out = []
        for g in groups:
            out.append({"key": g["key"], "title": g["title"], "items": [{
                "id": r["id"], "path": display_path(r["path"]), "size": r["size"] or 0,
                "width": r["width"], "height": r["height"], "vcodec": r["vcodec"] or "",
                "duration": r["duration"] or 0, "library": names.get(r["library_id"], ""),
                "exists": os.path.isfile(r["path"]), "trash": bool(windows_path(r["path"]))} for r in g["items"]]})
        return {"groups": out, "agent": updater.agent()}

    return await in_thread(work)


@app.post("/api/duplicates/ignore")
async def duplicates_ignore(request: Request):
    manager_only()
    key = str((await read_json(request)).get("key") or "")
    if not re.fullmatch(r"m\d+|e\d+-\d+-\d+", key):
        raise HTTPException(400, "Richiesta non valida")
    with config_lock:
        lst = config.setdefault("dup_ignore", [])
        if key not in lst:
            lst.append(key)
            del lst[:-500]
        save_config()
    return {"ok": True}


@app.post("/api/duplicates/trash")
async def duplicates_trash(request: Request):
    """Sposta nel Cestino di Windows una copia di un doppione: solo se un'altra
    copia dello stesso titolo resta al suo posto."""
    manager_only()
    item = (await read_json(request)).get("id")
    if not isinstance(item, int) or isinstance(item, bool):
        raise HTTPException(400, "Richiesta non valida")
    if not updater.agent():
        raise HTTPException(409, "Sul PC non è acceso l'aiutante di BunkerPlex: rilancia «Installa BunkerPlex», "
                                 "oppure elimina il file a mano")

    def work():
        con = db(raw=True)
        try:
            group = next((g for g in duplicate_groups(con) if any(r["id"] == item for r in g["items"])), None)
        finally:
            con.close()
        if group is None:
            raise HTTPException(404, "Questo file non è più un doppione")
        target = next(r for r in group["items"] if r["id"] == item)
        others = [r for r in group["items"] if r["id"] != item and os.path.isfile(r["path"])]
        if not others:
            raise HTTPException(409, "L'altra copia non è raggiungibile adesso: non tolgo l'unica rimasta")
        win = windows_path(target["path"])
        if not win:
            raise HTTPException(409, "Questo file non sta su un disco di Windows: eliminalo a mano")
        if not trash_lock.acquire(blocking=False):
            raise HTTPException(409, "Sto già spostando un file nel Cestino: riprova tra poco")
        try:
            rid = secrets.token_hex(8)
            TRASH_RESULT.unlink(missing_ok=True)
            part = TRASH_REQUEST.with_name(TRASH_REQUEST.name + ".nuovo")
            part.write_text(json.dumps({"id": rid, "files": [win]}), encoding="utf-8")
            os.replace(part, TRASH_REQUEST)
            for _ in range(60):                  # l'aiutante guarda ogni 3 secondi
                time.sleep(0.5)
                try:
                    res = json.loads(TRASH_RESULT.read_text(encoding="utf-8-sig"))
                except (OSError, ValueError):
                    continue
                if res.get("id") == rid:
                    break
            else:
                TRASH_REQUEST.unlink(missing_ok=True)
                raise HTTPException(504, "L'aiutante sul PC non ha risposto: riprova tra poco")
        finally:
            trash_lock.release()
        if not res.get("ok"):
            raise HTTPException(409, str(res.get("message") or "Non sono riuscito a spostare il file nel Cestino"))
        print("Doppione spostato nel Cestino:", win, flush=True)
        scan_async()
        return {"ok": True, "path": win}

    return await in_thread(work)


# ---- Notifiche su telefoni e tablet ------------------------------------------------
# Gli avvisi (nuovi film ed episodi, aggiornamento disponibile) partono da qui verso
# il servizio account, che li gira ai telefoni e tablet dell'account: push web per
# iPhone/iPad (la pagina «BunkerPlex Avvisi» del servizio), controllo periodico
# per l'app Android. Le richieste di amicizia le avvisa direttamente il servizio.
# Senza Internet gli avvisi aspettano in notice_out e partono alla prossima
# sincronizzazione (al massimo dopo due giorni si buttano: non sono piu' novita').

NOTICE_MAX_AGE = 2 * DAY
NOTICE_SCAN_MAX = 5              # avvisi al massimo per ogni lettura delle raccolte
notices_cloud = {}               # account -> {"at": quando, "notices": ultimi avvisi}


def queue_notice(uid, body):
    if uid is None:
        return
    con = db(raw=True)
    try:
        con.execute("INSERT INTO notice_out(user_id, body, t) VALUES(?,?,?)",
                    (uid, json.dumps(body, ensure_ascii=False), time.time()))
        con.commit()
    finally:
        con.close()
    sync_soon()


def _names(names, n=3):
    out = ", ".join(names[:n])
    return out + (f" e altri {len(names) - n}" if len(names) > n else "")


def _episodes_text(rows):
    seasons = sorted({r["season"] or 0 for r in rows})
    if len(rows) == 1:
        r = rows[0]
        t = f"Stagione {r['season'] or 0}, episodio {r['episode'] or 0}"
        return t + (f" · {r['title']}" if r["title"] else "")
    if len(seasons) == 1:
        eps = sorted(r["episode"] or 0 for r in rows)
        return f"Stagione {seasons[0]}, episodi {eps[0]}–{eps[-1]}"
    return f"Stagioni {seasons[0]}–{seasons[-1]}"


def new_titles_notices(rows):
    """Gli avvisi per i titoli appena arrivati: un avviso per i film, uno per ogni
    serie (al massimo tre, le altre insieme)."""
    out = []
    movies = [r for r in rows if r["kind"] == "movie"]
    if movies:
        names = [r["title"] + (f" ({r['year']})" if r["year"] else "") for r in movies]
        if len(movies) == 1:
            out.append(("Nuovo film", names[0]))
        else:
            out.append((f"{len(movies)} nuovi film", _names(names)))
    shows = {}
    for r in rows:
        if r["kind"] == "episode" and r["show"]:
            shows.setdefault(r["show"], []).append(r)
    ordered = sorted(shows.items(), key=lambda kv: -len(kv[1]))
    for show, eps in ordered[:3]:
        out.append((f"{show}: " + ("nuovo episodio" if len(eps) == 1 else f"{len(eps)} nuovi episodi"),
                    _episodes_text(eps)))
    rest = ordered[3:]
    if rest:
        out.append((f"Episodi nuovi in altre {len(rest)} serie" if len(rest) > 1 else f"Episodi nuovi in {rest[0][0]}",
                    _names([s for s, _ in rest])))
    return out[:NOTICE_SCAN_MAX]


def announce_new(ids, lib_before, gone_names):
    """Fine della lettura delle raccolte: avvisa il padrone di ogni raccolta (e i suoi
    amici, se condivide) dei titoli nuovi. Niente avvisi per una raccolta appena
    creata (sarebbero tutti i suoi titoli) ne' per i file solo spostati di cartella."""
    con = db(raw=True)
    try:
        rows = []
        for part in chunks(ids, 400):
            rows += con.execute(
                "SELECT i.id, i.kind, i.path, i.title, i.year, i.season, i.episode, i.library_id, "
                "s.title AS show FROM items i LEFT JOIN shows s ON s.id = i.show_id "
                f"WHERE i.id IN ({','.join('?' * len(part))})", part).fetchall()
    finally:
        con.close()
    with config_lock:
        owners = {lib["id"]: lib.get("owner") for lib in config.get("libraries") or []}
    per_owner = {}
    for r in rows:
        if not lib_before.get(r["library_id"]) or os.path.basename(r["path"]).lower() in gone_names:
            continue
        uid = owners.get(r["library_id"])
        if uid is not None:
            per_owner.setdefault(uid, []).append(r)
    where = pc_name()
    for uid, items in per_owner.items():
        friends = bool(friends_shared(uid) and share_on())
        for title, text in new_titles_notices(items):
            body = {"kind": "titles", "title": title, "body": f"{text} · su {where}"}
            if friends:
                body.update(friends=True, friends_title=f"Novità su {where}", friends_body=f"{title}: {text}")
            queue_notice(uid, body)


def notice_update_available():
    """Aggiornamento trovato su GitHub e installazione automatica spenta: lo si dice
    al padrone del server, una volta per ogni versione nuova."""
    snap = updater.snapshot()
    remote = snap.get("remote") or ""
    if not snap.get("available") or auto_update() or not remote or config.get("notified_update") == remote:
        return
    owner = server_owner()
    if owner is None:
        return
    with config_lock:
        config["notified_update"] = remote
        save_config()
    queue_notice(owner, {"kind": "update", "title": "Aggiornamento di BunkerPlex disponibile",
                         "body": f"Su {pc_name()}: installalo da Impostazioni → Aggiornamenti."})


def sync_notices(uid, token):
    con = db(raw=True)
    try:
        con.execute("DELETE FROM notice_out WHERE t < ?", (time.time() - NOTICE_MAX_AGE,))
        con.commit()
        rows = con.execute("SELECT id, body FROM notice_out WHERE user_id=? ORDER BY id LIMIT 20", (uid,)).fetchall()
    finally:
        con.close()
    for r in rows:
        try:
            accounts.call("POST", "/notices", json.loads(r["body"]), token)
        except accounts.CloudError as ex:
            if ex.status in (429, 401) or ex.status >= 500:
                break                # si riprova al prossimo giro
            # 404: servizio account di prima, senza notifiche; 400: avviso non valido
        con = db(raw=True)
        try:
            con.execute("DELETE FROM notice_out WHERE id=?", (r["id"],))
            con.commit()
        finally:
            con.close()
    try:
        res = accounts.call("GET", "/notices", token=token)
        notices_cloud[uid] = {"at": time.time(), "notices": res.get("notices") or [], "supported": True}
    except accounts.CloudError as ex:
        if ex.status == 404:
            notices_cloud[uid] = {"at": time.time(), "notices": [], "supported": False}


def recent_notices(uid):
    """Gli avvisi dell'account (per la campanella, letti e non letti), dall'ultima sincronizzazione."""
    info = notices_cloud.get(uid) or {}
    return [n for n in info.get("notices") or [] if isinstance(n, dict)][:30]


@app.post("/api/notices/read")
async def notices_read(request: Request):
    """Segna letti alcuni avvisi ({"ids": [...]}) o tutti ({"all": true})."""
    uid, token = profile_token()
    body = await read_json(request)
    ids = [int(i) for i in body.get("ids") or [] if isinstance(i, int) and not isinstance(i, bool)][:100]
    every = body.get("all") is True
    res = await cloud("POST", "/notices/read", {"ids": ids, "all": every}, token)
    for n in (notices_cloud.get(uid) or {}).get("notices") or []:
        if every or n.get("id") in ids:
            n["read"] = True
    return res


@app.get("/api/notices")
async def notices_get():
    u = CURRENT.get()
    if u is None or u.get("friend") or not u["linked"]:
        return {"linked": False}
    uid, token = profile_token()
    prefs, devices = await asyncio.gather(cloud("GET", "/notices/prefs", None, token),
                                          cloud("GET", "/notices/devices", None, token))
    try:
        res = await cloud("GET", "/notices", None, token)
        notices_cloud[uid] = {"at": time.time(), "notices": res.get("notices") or [], "supported": True}
    except HTTPException:
        pass
    return {"linked": True, "prefs": prefs.get("prefs") or {}, "devices": devices.get("devices") or [],
            "notices": (notices_cloud.get(uid) or {}).get("notices") or [], "cloud": accounts.cloud_url()}


@app.put("/api/notices/prefs")
async def notices_prefs(request: Request):
    _, token = profile_token()
    body = await read_json(request)
    return await cloud("PUT", "/notices/prefs", {k: bool(v) for k, v in body.items()
                                                 if k in ("titles", "friends_titles", "friends", "update")}, token)


@app.post("/api/notices/devices")
async def notices_device_add(request: Request):
    """Un telefono o tablet si iscrive: il servizio account gli da' il suo gettone."""
    _, token = profile_token()
    body = await read_json(request)
    kind = body.get("kind") if body.get("kind") in ("ios", "android", "web") else "web"
    label = re.sub(r"\s+", " ", str(body.get("label") or "")).strip()[:60]
    opener = str(body.get("open") or "")
    if not re.fullmatch(r"https?://[^\s\"'<>]{3,200}", opener):
        opener = ""
    return await cloud("POST", "/notices/devices", {"kind": kind, "label": label, "open": opener}, token)


@app.delete("/api/notices/devices/{dev_id}")
async def notices_device_remove(dev_id: int):
    _, token = profile_token()
    return await cloud("DELETE", f"/notices/devices/{dev_id}", None, token)


def sync_loop():
    """Ogni pochi minuti, e subito dopo una modifica, manda e riceve impostazioni e visti."""
    first = True
    while True:
        if not first:             # offline si riprova ogni minuto, per accorgersi presto che e' tornata la rete
            sync_wake.wait(60 if cloud_link["online"] is False else 180)
        first = False
        time.sleep(3)             # raccoglie le modifiche fatte una dopo l'altra
        sync_wake.clear()
        if not auth_on() or not cloud_ping():
            continue
        try:
            notice_update_available()
        except Exception as ex:
            print("Avviso dell'aggiornamento non preparato:", repr(ex), flush=True)
        try:
            con = db(raw=True)
            try:
                users = con.execute("SELECT id, token FROM users WHERE cloud_id IS NOT NULL "
                                    "AND token IS NOT NULL AND must_change=0").fetchall()
            finally:
                con.close()
        except sqlite3.Error:
            continue
        for u in users:
            try:
                # Le modifiche fatte senza Internet partono ora e si uniscono a quelle
                # degli altri PC voce per voce (vince la piu' recente): niente da scegliere
                sync_user(u["id"], u["token"])
            except accounts.CloudOffline:
                mark_cloud(False)
                break             # niente Internet: si riprova al prossimo giro
            except accounts.CloudError as ex:
                if ex.status == 401:
                    drop_cloud_token(u["id"])
                elif ex.status == 403 and "disattivato" in str(ex.detail):
                    set_disabled(uid=u["id"])
                elif ex.status != 403:
                    print("Sincronizzazione account:", ex.detail, flush=True)
            except Exception as ex:
                print("Sincronizzazione account:", repr(ex), flush=True)


def refresh_role(uid, token):
    """Ruolo (base / amministratore) e password provvisoria come li vede adesso il
    servizio: un cambio fatto dalla plancia arriva qui senza dover rientrare."""
    me = (accounts.call("GET", "/me", token=token) or {}).get("user") or {}
    if "admin" not in me:
        return
    con = db(raw=True)
    try:
        done = con.execute("UPDATE users SET admin=?, must_change=?, disabled=0 WHERE id=? "
                           "AND (admin<>? OR must_change<>? OR COALESCE(disabled, 0)<>0)",
                           (int(bool(me["admin"])), int(bool(me.get("must_change"))), uid,
                            int(bool(me["admin"])), int(bool(me.get("must_change"))))).rowcount
        con.commit()
    finally:
        con.close()
    if done:
        user_cache.clear()


def set_disabled(cloud_id=None, uid=None, off=True):
    """Account disattivato (o riattivato) dalla plancia: su questo PC non si entra
    piu', e chi ci sta dentro torna a «Chi guarda?»."""
    con = db(raw=True)
    try:
        where, arg = ("cloud_id=?", cloud_id) if cloud_id is not None else ("id=?", uid)
        con.execute(f"UPDATE users SET disabled=? WHERE {where}", (int(off), arg))
        if off:
            con.execute(f"DELETE FROM user_sessions WHERE user_id IN (SELECT id FROM users WHERE {where})", (arg,))
        con.commit()
    finally:
        con.close()
    user_cache.clear()


def sync_user(uid, token):
    refresh_role(uid, token)
    push_settings(uid, token)
    pull_settings(uid, token)
    sync_libraries(uid)               # raccolte dell'account qui, e quelle nuove di qui nell'account
    push_settings(uid, token)
    push_state(uid, token)
    pull_state(uid, token)
    apply_cloud_state(uid)
    sync_friends(uid, token)          # amici dell'account (un servizio di prima risponde 404: niente)
    sync_notices(uid, token)          # avvisi per telefoni e tablet: partono quelli in coda, arrivano gli ultimi
    con = db(raw=True)
    try:
        con.execute("UPDATE users SET last_sync=? WHERE id=?", (time.time(), uid))
        con.commit()
    finally:
        con.close()
    mark_cloud(True)


def push_settings(uid, token):
    con = db(raw=True)
    try:
        rows = con.execute("SELECT k, v, t FROM user_settings WHERE user_id=? AND dirty=1", (uid,)).fetchall()
        for part in chunks(rows):
            accounts.call("PUT", "/settings", {"data": {r["k"]: {"v": json.loads(r["v"]) if r["v"] else None,
                                                                 "t": r["t"]} for r in part}}, token)
            con.executemany("UPDATE user_settings SET dirty=0 WHERE user_id=? AND k=? AND t=?",
                            [(uid, r["k"], r["t"]) for r in part])
            con.commit()
    finally:
        con.close()


def pull_settings(uid, token):
    data = accounts.call("GET", "/settings", token=token).get("data") or {}
    con = db(raw=True)
    try:
        con.executemany("INSERT INTO user_settings(user_id, k, v, t, dirty) VALUES(?,?,?,?,0) "
                        "ON CONFLICT(user_id, k) DO UPDATE SET v=excluded.v, t=excluded.t, dirty=0 "
                        "WHERE excluded.t > user_settings.t",
                        [(uid, k, json.dumps(e.get("v")), float(e.get("t") or 0)) for k, e in data.items()])
        con.commit()
    finally:
        con.close()
    with settings_lock:
        settings_cache.clear()


STATE_KEY = re.compile(r"^(m|s)(\d+)$|^e(\d+):(\d+):(\d+)$")


def parse_state_key(k):
    m = STATE_KEY.match(k or "")
    if not m:
        return None
    if m.group(1):
        return m.group(1), int(m.group(2)), None, None
    return "e", int(m.group(3)), int(m.group(4)), int(m.group(5))


def remember_cloud(con, uid, rows):
    """Quello che si e' mandato (o ricevuto) resta come copia del servizio."""
    out = []
    for r in rows:
        parsed = parse_state_key(r["k"])
        if parsed:
            out.append((uid, r["k"], *parsed, r.get("pos", 0), 1 if r.get("w") else 0,
                        r.get("fav", 0), r.get("lp", 0), r["t"]))
    con.executemany("INSERT INTO cloud_state(user_id, k, kind, a, b, c, pos, w, fav, lp, t) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id, k) DO UPDATE SET pos=excluded.pos, "
                    "w=excluded.w, fav=excluded.fav, lp=excluded.lp, t=excluded.t WHERE excluded.t > cloud_state.t",
                    out)


def push_state(uid, token):
    """Visti e lista cambiati su questo PC, per titolo TMDB (i titoli senza scheda restano qui)."""
    con = db(raw=True)
    try:
        con.execute("UPDATE user_items SET dirty=0 WHERE user_id=? AND dirty=1 "
                    "AND item_id NOT IN (SELECT id FROM items)", (uid,))
        rows, done_items, done_shows = [], [], []
        for r in con.execute(
                "SELECT u.item_id, u.position, u.watched, u.last_played, u.fav, u.t, i.kind, i.tmdb_id, "
                "i.season, i.episode, s.tmdb_id AS show_tmdb FROM user_items u JOIN items i ON i.id=u.item_id "
                "LEFT JOIN shows s ON s.id=i.show_id WHERE u.user_id=? AND u.dirty=1", (uid,)).fetchall():
            key = None
            if r["kind"] == "movie" and r["tmdb_id"]:
                key = f"m{r['tmdb_id']}"
            elif r["kind"] == "episode" and r["show_tmdb"] and r["season"] is not None and r["episode"] is not None:
                key = f"e{r['show_tmdb']}:{r['season']}:{r['episode']}"
            done_items.append((uid, r["item_id"], r["t"]))
            if key:
                rows.append({"k": key, "pos": r["position"] or 0, "w": 1 if r["watched"] else 0,
                             "fav": r["fav"] or 0 if r["kind"] == "movie" else 0,
                             "lp": r["last_played"] or 0, "t": r["t"] or time.time()})
        for r in con.execute("SELECT u.show_id, u.fav, u.t, s.tmdb_id FROM user_shows u JOIN shows s "
                             "ON s.id=u.show_id WHERE u.user_id=? AND u.dirty=1", (uid,)).fetchall():
            done_shows.append((uid, r["show_id"], r["t"]))
            if r["tmdb_id"]:
                rows.append({"k": f"s{r['tmdb_id']}", "pos": 0, "w": 0, "fav": r["fav"] or 0, "lp": 0,
                             "t": r["t"] or time.time()})
        for part in chunks(rows):
            accounts.call("POST", "/state", {"rows": part}, token)
            remember_cloud(con, uid, part)
            con.commit()
        con.executemany("UPDATE user_items SET dirty=0 WHERE user_id=? AND item_id=? AND t=?", done_items)
        con.executemany("UPDATE user_shows SET dirty=0 WHERE user_id=? AND show_id=? AND t=?", done_shows)
        con.commit()
    finally:
        con.close()


def pull_state(uid, token):
    con = db(raw=True)
    try:
        last = con.execute("SELECT state_rev FROM users WHERE id=?", (uid,)).fetchone()["state_rev"] or 0
        # Un po' di margine: due PC possono scrivere nello stesso istante
        since, top = max(0, last - 5000), last
        while True:
            res = accounts.call("GET", f"/state?since={since}", token=token)
            rows = res.get("rows") or []
            remember_cloud(con, uid, rows)
            con.commit()
            if rows:
                top = max(top, max(int(r["rev"]) for r in rows))
            if not res.get("more") or not rows:
                break
            since = max(int(r["rev"]) for r in rows)
        con.execute("UPDATE users SET state_rev=? WHERE id=?", (top, uid))
        con.commit()
    finally:
        con.close()


def apply_cloud_state(uid):
    """I visti arrivati dagli altri PC valgono per i titoli che ci sono anche qui
    (stesso film o stesso episodio secondo TMDB). Vince la modifica piu' recente."""
    con = db(raw=True)
    try:
        con.execute(
            "INSERT INTO user_items(user_id, item_id, position, watched, last_played, fav, t, dirty) "
            "SELECT ?, i.id, c.pos, c.w, c.lp, c.fav, c.t, 0 FROM cloud_state c JOIN items i "
            "ON i.tmdb_id=c.a AND i.kind='movie' WHERE c.user_id=? AND c.kind='m' "
            "ON CONFLICT(user_id, item_id) DO UPDATE SET position=excluded.position, watched=excluded.watched, "
            "last_played=excluded.last_played, fav=excluded.fav, t=excluded.t, dirty=0 "
            "WHERE excluded.t > user_items.t", (uid, uid))
        con.execute(
            "INSERT INTO user_items(user_id, item_id, position, watched, last_played, fav, t, dirty) "
            "SELECT ?, i.id, c.pos, c.w, c.lp, 0, c.t, 0 FROM cloud_state c JOIN shows s ON s.tmdb_id=c.a "
            "JOIN items i ON i.show_id=s.id AND i.season=c.b AND i.episode=c.c "
            "WHERE c.user_id=? AND c.kind='e' "
            "ON CONFLICT(user_id, item_id) DO UPDATE SET position=excluded.position, watched=excluded.watched, "
            "last_played=excluded.last_played, t=excluded.t, dirty=0 WHERE excluded.t > user_items.t",
            (uid, uid))
        con.execute(
            "INSERT INTO user_shows(user_id, show_id, fav, t, dirty) "
            "SELECT ?, s.id, c.fav, c.t, 0 FROM cloud_state c JOIN shows s ON s.tmdb_id=c.a "
            "WHERE c.user_id=? AND c.kind='s' "
            "ON CONFLICT(user_id, show_id) DO UPDATE SET fav=excluded.fav, t=excluded.t, dirty=0 "
            "WHERE excluded.t > user_shows.t", (uid, uid))
        con.commit()
    finally:
        con.close()


# ---- Questo PC ---------------------------------------------------------------

def pc_id():
    """Un nome breve e fisso per questa installazione (lo usano gli amici per riconoscerla)."""
    with config_lock:
        if not config.get("pc_id"):
            config["pc_id"] = secrets.token_hex(4)
            save_config()
        return config["pc_id"]


def pc_name():
    """Come si chiama questo PC per gli amici (si cambia da Impostazioni → Amici)."""
    if config.get("pc_name"):
        return config["pc_name"]
    return SERVER_NAME if SERVER_NAME != "BunkerPlex" else "PC " + pc_id()[:4].upper()



# ---- Aggiornamenti da GitHub ----------------------------------------------
# Il lavoro lo fa updater.py: controllo ogni 12 ore, installazione automatica
# quando nessuno sta guardando (si puo' spegnere) oppure a richiesta, da PC o TV.

def auto_update():
    return config.get("auto_update", True) is not False


# Dopo un aggiornamento: la notifica «BunkerPlex aggiornato», con le novita',
# resta nella campanella per una settimana (ogni dispositivo la vede una volta).
NOTICE_DAYS = 7


def note_update():
    """All'avvio: se il programma non e' piu' quello dell'ultima volta, e' stato
    aggiornato. Le novita' sono i messaggi dei commit nel mezzo (da GitHub)."""
    now = updater.current_commit()
    if not now:
        return
    with config_lock:
        before = config.get("seen_commit")
        if before == now:
            return
        config["seen_commit"] = now
        if before:
            config["update_notice"] = {"from": before, "to": now, "at": time.time(), "changes": None}
        save_config()
    if not before:
        return                     # prima installazione: niente da annunciare
    print("BunkerPlex aggiornato:", before[:7], "->", now[:7], flush=True)
    for wait in (0, 60, 600):      # la rete puo' non essere ancora pronta
        time.sleep(wait)
        try:
            found = updater.changes(before, now)
        except Exception as ex:
            print("Novita' dell'aggiornamento non lette:", repr(ex), flush=True)
            continue
        with config_lock:
            n = config.get("update_notice") or {}
            if n.get("to") == now:
                n["changes"] = found
                save_config()
        return


def update_notice():
    n = config.get("update_notice")
    if not n or time.time() - float(n.get("at") or 0) > NOTICE_DAYS * DAY:
        return None
    return {"to": str(n.get("to") or "")[:7], "at": n.get("at"), "changes": n.get("changes") or []}


# ---- Chi aggiorna il server ----------------------------------------------------
# Solo il padrone del server: il primo account entrato su questo PC (quello che ha
# preso il posto di «Casa»). Gli altri account di casa vedono lo stato ma non
# lanciano l'installazione; gli amici non arrivano mai qui. Senza account
# (solo «Casa») decide chi e' davanti al server, come prima.
# Fuori casa il padrone aggiorna dalle app passando dalla porta 32501 (vedi
# /api/share/update): vale solo il suo biglietto «da te a te», e solo se su
# questo PC e' lui il padrone. Un suo account entrato sul PC di un amico non
# basta per aggiornare il server dell'amico.

def server_owner():
    """L'id del padrone di questo server, o None se non c'e' ancora nessun account."""
    con = db(raw=True)
    try:
        r = con.execute("SELECT id FROM users WHERE cloud_id IS NOT NULL ORDER BY created, id LIMIT 1").fetchone()
    finally:
        con.close()
    return r["id"] if r else None


def can_update(uid):
    owner = server_owner()
    return owner is None or uid == owner


def update_json(uid=None):
    out = updater.snapshot()
    out["auto"] = auto_update()
    out["changelog"] = updater.changelog()
    if uid is None:
        u = CURRENT.get()
        uid = u["id"] if u is not None and not u.get("friend") else -1
    out["can_update"] = can_update(uid)
    return out


def update_owner_only():
    u = CURRENT.get()
    if u is None or u.get("friend") or not can_update(u["id"]):
        raise HTTPException(403, "Solo il proprietario di questo server può aggiornarlo")


@app.get("/api/update")
def update_status():
    return update_json()


@app.post("/api/update/check")
def update_check():
    updater.check()
    return update_json()


@app.post("/api/update/install")
def update_install():
    update_owner_only()
    if not updater.start_install():
        raise HTTPException(409, "C'è già un aggiornamento in corso")
    return update_json()


@app.post("/api/update/auto")
async def update_auto(request: Request):
    update_owner_only()
    body = await read_json(request)
    with config_lock:
        config["auto_update"] = bool(body.get("auto"))
        save_config()
    return update_json()


@app.post("/api/update/token")
async def update_token(request: Request):
    """Salva il token di sola lettura per il repository privato (dopo averlo provato)."""
    update_owner_only()
    body = await read_json(request)
    if not await asyncio.to_thread(updater.set_token, str(body.get("token") or "")):
        raise HTTPException(400, "Con questo token GitHub non dà accesso al repository degli aggiornamenti")
    await asyncio.to_thread(updater.check)
    return update_json()


_apk_seen = {}


def _axml_string(data, pool, index):
    """La stringa numero 'index' della tabella delle stringhe di un XML binario Android."""
    count, _, flags, strings_start = struct.unpack_from("<4I", data, pool + 8)
    if index < 0 or index >= count:
        return ""
    header_size = struct.unpack_from("<H", data, pool + 2)[0]
    pos = pool + strings_start + struct.unpack_from("<I", data, pool + header_size + 4 * index)[0]
    if flags & 0x100:   # UTF-8: lunghezza in caratteri, poi in byte
        for _ in range(2):
            n = data[pos]
            pos += 1
            if n & 0x80:
                n = ((n & 0x7F) << 8) | data[pos]
                pos += 1
        return data[pos:pos + n].decode("utf-8", "replace")
    n = struct.unpack_from("<H", data, pos)[0]
    pos += 2
    if n & 0x8000:
        n = ((n & 0x7FFF) << 16) | struct.unpack_from("<H", data, pos)[0]
        pos += 2
    return data[pos:pos + 2 * n].decode("utf-16-le", "replace")


def read_apk_version(path):
    """(numero di versione, nome della versione) scritti dentro un APK."""
    with zipfile.ZipFile(path) as z:
        data = z.read("AndroidManifest.xml")
    pool, res_map, pos = None, [], 8
    while pos + 8 <= len(data):
        kind, header_size, size = struct.unpack_from("<HHI", data, pos)
        if size < 8:
            break
        if kind == 0x0001:        # tabella delle stringhe
            pool = pos
        elif kind == 0x0180:      # a quale attributo Android corrisponde ogni nome
            res_map = struct.unpack_from(f"<{(size - header_size) // 4}I", data, pos + header_size)
        elif kind == 0x0102:      # il primo elemento e' <manifest>
            attr_start, attr_size, attr_count = struct.unpack_from("<3H", data, pos + header_size + 8)
            code, name = 0, ""
            for n in range(attr_count):
                at = pos + header_size + attr_start + n * attr_size
                name_idx = struct.unpack_from("<I", data, at + 4)[0]
                value_type, value = struct.unpack_from("<BI", data, at + 15)
                res_id = res_map[name_idx] if name_idx < len(res_map) else 0
                if res_id == 0x0101021B:      # android:versionCode
                    code = value
                elif res_id == 0x0101021C:    # android:versionName
                    name = _axml_string(data, pool, value) if value_type == 3 and pool is not None else str(value)
            return code, name
        pos += size
    return 0, ""


def apk_version(path=None):
    """Versione dell'APK che sta sul PC: l'app sulla TV la confronta con la
    propria per sapere se c'e' un aggiornamento. Riletta solo se il file cambia."""
    path = path or APK_PATH
    try:
        st = path.stat()
    except OSError:
        return 0, ""
    stamp = (st.st_mtime_ns, st.st_size)
    seen = _apk_seen.setdefault(str(path), {"stamp": None, "version": None})
    if seen["stamp"] != stamp:
        try:
            version = read_apk_version(path)
        except Exception as ex:   # file copiato a meta', APK rovinato...
            print("Versione APK non leggibile:", repr(ex), flush=True)
            return 0, ""
        seen.update(stamp=stamp, version=version)
    return seen["version"]


def other_addresses():
    """Gli altri indirizzi da cui l'app raggiunge questo PC fuori casa: quello del
    Tailscale installato sul computer (la tua rete Tailscale, solo i tuoi dispositivi)."""
    ts = tailscale_ip()
    return [f"http://{ts}:32500"] if ts else []


@app.get("/api/info")
def info():
    apk_code, apk_name = apk_version()
    tv_code, tv_name = apk_version(TV_APK_PATH)
    tv = {"tv_apk_version": tv_code, "tv_apk_version_name": tv_name}
    if CURRENT.get() is None:
        # Prima dell'accesso: quanto basta all'app della TV per riconoscere il server e aggiornarsi
        return {"app": "bunkerplex", "name": SERVER_NAME, "version": VERSION, "api": API_LEVEL, "login": True,
                "release": updater.release(), "commit": updater.current_commit()[:7],
                "apk": APK_PATH.is_file(), "apk_version": apk_code, "apk_version_name": apk_name,
                "addresses": other_addresses(), "cloud": accounts.cloud_url(), "sid": pc_id(), **tv}
    con = db()
    try:
        key = tmdb_key()
        return {
            "app": "bunkerplex", "name": SERVER_NAME, "version": VERSION, "api": API_LEVEL,
            # Numero di versione del programma (es. 2026.11.23.2) e commit installato
            "release": updater.release(), "commit": updater.current_commit()[:7],
            "addresses": other_addresses(), "cloud": accounts.cloud_url(), "sid": pc_id(),
            # Questo PC non entra nella rete di BunkerPlex: l'account ha gia' 4 dispositivi
            "devices_full": tailnet["limit"] is not None,
            "movies": con.execute("SELECT COUNT(*) FROM items WHERE kind='movie'").fetchone()[0],
            "shows": con.execute("SELECT COUNT(*) FROM shows").fetchone()[0],
            "episodes": con.execute("SELECT COUNT(*) FROM items WHERE kind='episode'").fetchone()[0],
            "unmatched": con.execute(
                "SELECT COUNT(*) FROM items WHERE kind='movie' AND tmdb_id IS NULL").fetchone()[0],
            "scanning": state["scanning"], "message": state["message"],
            "last_scan": state["last_scan"],
            "tmdb": bool(key), "tmdb_hint": ("…" + key[-4:]) if key else "",
            "subs_online": bool(os_conf()["key"]), "subs_user": os_conf()["user"],
            "libraries": len(get_libraries()), "apk": APK_PATH.is_file(),
            "apk_version": apk_code, "apk_version_name": apk_name, **tv,
            "update": updater.available(),
            # Richieste di amicizia arrivate all'account di chi guarda
            "friend_requests": sum(1 for f in (friends_cloud.get((CURRENT.get() or {}).get("id")) or {})
                                   .get("friends", []) if f.get("status") == "received"),
            "updated": update_notice(),      # appena aggiornato: le novita'
            # Doppioni da sistemare (solo per chi gestisce il server)
            "duplicates": duplicates_count() if (CURRENT.get() or {}).get("id") is not None
                and not (CURRENT.get() or {}).get("friend")
                and can_manage(CURRENT.get()["id"], CURRENT.get().get("admin")) else 0,
            # Gli ultimi avvisi dell'account (nuovi titoli, amici...), anche per la campanella
            "notices": [] if (CURRENT.get() or {}).get("friend") else recent_notices((CURRENT.get() or {}).get("id")),
            # Richieste di condivisione degli amici ancora da approvare
            "share_requests": con.execute(
                "SELECT COUNT(*) FROM accounts WHERE approved=0").fetchone()[0] if share_on() else 0,
            # Come procede l'aggiornamento delle schede (Impostazioni → Catalogo)
            "catalog": catalog_status(con),
        }
    finally:
        con.close()


# ---- Raccolte ------------------------------------------------------------

def _library(lib_id):
    """La raccolta dentro config (da usare tenendo config_lock)."""
    u = CURRENT.get()
    for lib in config["libraries"]:
        if lib["id"] == lib_id:
            if u is not None and lib.get("owner") != u["id"]:
                raise HTTPException(403, "Questa raccolta è di un altro account: può cambiarla solo lui")
            return lib
    raise HTTPException(404, "Raccolta non trovata")


def _clean_name(raw):
    name = re.sub(r"\s+", " ", str(raw or "")).strip()[:40]
    if not name:
        raise HTTPException(400, "Scrivi un nome per la raccolta")
    return name


def _add_folders(lib, raw_paths):
    """Aggiunge cartelle a una raccolta; restituisce quelle davvero aggiunte."""
    added = []
    if isinstance(raw_paths, str):
        raw_paths = [raw_paths]
    for raw in raw_paths:
        path = folder_from_input(raw)
        for other in config["libraries"]:
            if path in other["folders"]:
                if other is lib:
                    break
                u = CURRENT.get()
                if u is not None and other.get("owner") != u["id"]:
                    raise HTTPException(409, f"{display_path(path)} è già in una raccolta di un altro account "
                                             "di questo PC: chiedigli di condividerla")
                raise HTTPException(409, f"{display_path(path)} è già nella raccolta «{other['name']}»")
        else:
            lib["folders"].append(path)
            added.append(display_path(path))
    return added


@app.get("/api/libraries")
def libraries_list():
    con = db()
    try:
        files, movies = {}, {}
        for r in con.execute("SELECT library_id, path, kind FROM items"):
            files.setdefault(r["library_id"], []).append(r["path"])
            if r["kind"] == "movie":
                movies[r["library_id"]] = movies.get(r["library_id"], 0) + 1
        shows = {r[0]: r[1] for r in con.execute("SELECT library_id, COUNT(*) FROM shows GROUP BY library_id")}
    finally:
        con.close()
    out = []
    elsewhere = self_synced()
    states = {}

    def state(p):   # una volta sola per cartella: ogni controllo tocca il disco
        if p not in states:
            states[p] = folder_state(p)
        return states[p]

    for lib in get_libraries():
        paths = files.get(lib["id"], [])
        out.append({
            "id": lib["id"], "name": lib["name"], "sync": lib.get("sync_id") or "",
            # tutta su un altro tuo PC, che la fa vedere da lì: nel menu c'è già sotto quel PC
            "remote": bool(lib.get("sync_id")) and lib["sync_id"] in elsewhere
                      and not any(state(p).get("online") for p in lib["folders"]),
            "mine": lib.get("mine", True), "shared": bool(lib.get("shared")),
            "movies": movies.get(lib["id"], 0), "shows": shows.get(lib["id"], 0),
            "folders": [dict(state(p), count=sum(1 for x in paths if x.startswith(p + "/")))
                        for p in lib["folders"]],
            # cartelle della raccolta che stanno su un altro PC dell'account
            "missing": [m.get("display") or m.get("path") for m in lib.get("missing") or []],
        })
    return out


def slim(d):
    """Per le griglie e la ricerca: senza trama e frase di lancio, che si leggono solo
    nella scheda. L'elenco di una raccolta pesa quasi la meta' e la TV lo legge prima."""
    d.pop("overview", None)
    d.pop("tagline", None)
    return d


@app.get("/api/libraries/{lib_id}/items")
def library_items(lib_id: int):
    """Tutto il contenuto di una raccolta: film e serie insieme."""
    if lib_id >= FRIEND_BASE:
        return friend_library_items(lib_id)
    return [slim(x) for x in all_library_items(lib_id)]


def all_library_items(lib_id):
    """Con le trame: agli amici servono per la loro Home (l'anteprima in alto)."""
    con = db()
    try:
        out = [item_json(r) for r in con.execute(
            "SELECT * FROM items WHERE kind='movie' AND library_id=?", (lib_id,))]
        out += [show_json(con, r) for r in con.execute(
            "SELECT * FROM shows WHERE library_id=?", (lib_id,)).fetchall()]
        return out
    finally:
        con.close()


@app.post("/api/libraries")
async def libraries_create(request: Request):
    body = await read_json(request)
    name = _clean_name(body.get("name"))
    get_libraries()
    u = CURRENT.get()
    with config_lock:
        lib = {"id": max([x["id"] for x in config["libraries"]] + [0]) + 1,
               "name": name, "folders": []}
        if u is not None:
            lib["owner"] = u["id"]
            u["libs"].append(lib["id"])
        config["libraries"].append(lib)
        try:
            _add_folders(lib, body.get("folders") or [])
        except HTTPException:
            config["libraries"].remove(lib)
            raise
        save_config()
    lib_changed()
    scan_async()
    return {"ok": True, "id": lib["id"]}


@app.patch("/api/libraries/{lib_id}")
async def libraries_rename(lib_id: int, request: Request):
    body = await read_json(request)
    get_libraries()
    with config_lock:
        lib = _library(lib_id)
        if "name" in body:
            lib["name"] = _clean_name(body.get("name"))
        if "shared" in body:      # visibile anche agli altri account di questo PC
            lib["shared"] = bool(body.get("shared"))
        save_config()
    lib_changed()
    return {"ok": True}


@app.delete("/api/libraries/{lib_id}")
def libraries_delete(lib_id: int):
    get_libraries()
    with config_lock:
        config["libraries"].remove(_library(lib_id))
        save_config()
    lib_changed()
    scan_async()   # i suoi titoli escono dal catalogo; i file sul disco non si toccano
    return {"ok": True}


@app.post("/api/libraries/{lib_id}/folders")
async def libraries_add_folders(lib_id: int, request: Request):
    body = await read_json(request)
    raw = body.get("paths") or ([body["path"]] if body.get("path") else [])
    if not raw:
        raise HTTPException(400, "Nessuna cartella indicata")
    get_libraries()
    with config_lock:
        lib = _library(lib_id)
        added = _add_folders(lib, raw)
        if body.get("replace"):   # e' la cartella che sugli altri PC sta altrove: qui sta in questo posto
            lib["missing"] = [m for m in lib.get("missing") or [] if m.get("display") != body["replace"]]
        save_config()
    lib_changed()
    scan_async()
    return {"ok": True, "added": added}


@app.post("/api/libraries/{lib_id}/folders/remove")
async def libraries_remove_folder(lib_id: int, request: Request):
    body = await read_json(request)
    get_libraries()
    with config_lock:
        lib = _library(lib_id)
        if body.get("path") not in lib["folders"]:
            raise HTTPException(404, "Cartella non trovata")
        lib["folders"].remove(body["path"])
        save_config()
    lib_changed()
    scan_async()
    return {"ok": True}


@app.post("/api/libraries/push-local")
def libraries_push_local():
    """Le raccolte dell'account diventano quelle di questo PC: si tolgono dall'account le
    cartelle che qui non ci sono e le raccolte che qui non hanno nessuna cartella. Visti,
    punti di ripresa e lista non cambiano."""
    u = CURRENT.get()
    if u is None or not u.get("linked"):
        raise HTTPException(400, "Serve un account per sincronizzare le raccolte")
    removed_folders = removed_libs = 0
    with config_lock:
        libs = config.get("libraries") or []
        for lib in list(libs):
            if lib.get("owner") != u["id"]:
                continue
            gone = len(lib.get("missing") or [])
            if gone and not lib["folders"]:
                libs.remove(lib)        # c'era solo su altri PC
                removed_libs += 1
                continue
            removed_folders += gone
            lib["missing"] = []
        save_config()
    push_libraries(u["id"])           # con l'ora di adesso: vince su quello che c'e' online
    return {"ok": True, "removed_folders": removed_folders, "removed_libraries": removed_libs}


@app.post("/api/libraries/{lib_id}/missing/remove")
async def libraries_remove_missing(lib_id: int, request: Request):
    """Toglie dalla raccolta (su tutti i PC dell'account) una cartella che su questo PC non c'e'."""
    body = await read_json(request)
    get_libraries()
    with config_lock:
        lib = _library(lib_id)
        before = len(lib.get("missing") or [])
        lib["missing"] = [m for m in lib.get("missing") or [] if m.get("display") != body.get("display")]
        if len(lib["missing"]) == before:
            raise HTTPException(404, "Cartella non trovata")
        save_config()
    lib_changed()
    return {"ok": True}


@app.post("/api/libraries/{lib_id}/folders/relocate")
async def libraries_relocate_folder(lib_id: int, request: Request):
    """La cartella e' la stessa ma ha cambiato percorso (disco con un'altra
    lettera): si aggiorna il percorso senza perdere schede, visti e punti di ripresa."""
    body = await read_json(request)
    old = body.get("path")
    get_libraries()
    with config_lock:
        lib = _library(lib_id)
        if old not in lib["folders"]:
            raise HTTPException(404, "Cartella non trovata")
        new = folder_from_input(body.get("to"))
        if not has_content(Path(new)):
            raise HTTPException(400, f"La cartella {display_path(new)} è vuota o non raggiungibile")
        for other in config["libraries"]:
            if new in other["folders"]:
                raise HTTPException(409, f"{display_path(new)} è già nella raccolta «{other['name']}»")
        con = db(raw=True)
        try:
            # OR REPLACE: se nel frattempo una scansione ha gia' letto il file nel
            # nuovo posto, vince la riga vecchia (ha scheda e visti).
            con.execute("UPDATE OR REPLACE items SET path = ? || substr(path, ?) "
                        "WHERE substr(path, 1, ?) = ?",
                        (new, len(old) + 1, len(old) + 1, old + "/"))
            con.commit()
        finally:
            con.close()
        lib["folders"][lib["folders"].index(old)] = new
        save_config()
    lib_changed()
    scan_async()
    return {"ok": True, "display": display_path(new)}


@app.get("/api/browse")
def browse(path: str = ""):
    """Elenco delle sottocartelle, per scegliere una cartella dall'app."""
    p = browse_path(path)
    if not p.is_dir():
        raise HTTPException(404, "La cartella non esiste più")
    at_root = p == HOST_ROOT
    dirs, videos = [], 0
    try:
        entries = sorted(os.scandir(p), key=lambda e: e.name.lower())
    except OSError:
        raise HTTPException(403, "Non riesco a leggere questa cartella")
    for e in entries:
        try:
            if e.is_dir():
                if e.name.startswith((".", "$")) or e.name.lower() in HIDDEN_DIRS:
                    continue
                # In cima: niente cartelle di Docker Desktop e niente dischi staccati
                # (la loro lettera resta come cartella vuota finche' non tornano)
                if at_root and (e.name.lower() in HOST_SKIP or not has_content(Path(e.path))):
                    continue
                name = f"Disco {e.name.upper()}:" if at_root and len(e.name) == 1 else e.name
                dirs.append({"name": name, "path": e.path})
            elif os.path.splitext(e.name)[1].lower() in VIDEO_EXT:
                videos += 1
        except OSError:
            continue
    return {"path": str(p), "display": display_path(p), "root": at_root,
            "parent": None if at_root else str(p.parent), "dirs": dirs, "videos": videos}


@app.post("/api/scan")
def start_scan():
    scan_async()
    return {"ok": True}


@app.post("/api/settings")
async def save_settings(request: Request):
    """Salva la chiave TMDB (dopo averla provata) e ricataloga cio' che manca."""
    body = await read_json(request)
    key = (body.get("tmdb_key") or "").strip()
    if key:
        try:
            tmdb("/configuration", _key=key)
        except urllib.error.HTTPError as ex:
            raise HTTPException(400, "Chiave TMDB non valida" if ex.code == 401
                                else f"TMDB ha risposto con errore {ex.code}")
        except Exception:
            raise HTTPException(502, "Non riesco a contattare TMDB: controlla la connessione del PC")
    u = CURRENT.get()
    if u is not None:             # nell'account: arriva su tutti i PC dove entri
        put_user_setting(u["id"], "tmdb_key", key)
    else:
        with config_lock:
            config["tmdb_key"] = key
            save_config()
    con = db(raw=True)
    try:
        con.execute("UPDATE items SET meta_done=0 WHERE tmdb_id IS NULL")
        con.execute("UPDATE shows SET meta_done=0 WHERE tmdb_id IS NULL")
        con.commit()
    finally:
        con.close()
    scan_async()
    return {"ok": True}


@app.get("/api/tmdb/search")
def tmdb_search(kind: str, q: str, year: int = 0):
    """Risultati TMDB per correggere a mano un abbinamento sbagliato."""
    if not tmdb_key():
        raise HTTPException(400, "Chiave TMDB non impostata")
    try:
        kind = "movie" if kind == "movie" else "show"
        imdb = IMDB_ID.search(q)          # incollato un link o un id IMDb: si va a colpo sicuro
        res = tmdb_by_imdb(kind, imdb.group(1).lower()) if imdb else search_tmdb(kind, q, year or None)
    except Exception:
        raise HTTPException(502, "Non riesco a contattare TMDB")
    out = []
    for m in res[:12]:
        date = m.get("release_date") or m.get("first_air_date") or ""
        out.append({"tmdb_id": m["id"], "title": m.get("title") or m.get("name"),
                    "year": _year(date, None), "overview": m.get("overview") or "",
                    "poster": f"https://image.tmdb.org/t/p/w185{m['poster_path']}"
                    if m.get("poster_path") else None})
    return out


@app.post("/api/match")
async def match(request: Request):
    body = await read_json(request)
    check = db()                  # il titolo deve essere in una raccolta che vedi
    try:
        if body.get("kind") == "movie":
            get_item(check, int(body["id"]))
        elif not get_show(check, int(body["id"])):
            raise HTTPException(404, "Serie non trovata")
    finally:
        check.close()
    con = db(raw=True)
    try:
        # manual: scelta a mano, da riprendere su un'installazione nuova o sugli altri PC (copia del catalogo)
        if body.get("kind") == "movie":
            apply_movie(con, int(body["id"]), int(body["tmdb_id"]))
            con.execute("UPDATE items SET manual=? WHERE id=?", (time.time(), int(body["id"])))
        else:
            apply_show(con, int(body["id"]), int(body["tmdb_id"]))
            kept = merge_duplicate_show(con, int(body["id"]))
            con.execute("UPDATE shows SET manual=? WHERE id=?", (time.time(), kept))
            con.commit()
            enrich_episodes(con, get_show(con, kept))
        con.commit()
        return {"ok": True}
    except (urllib.error.URLError, TimeoutError):
        raise HTTPException(502, "Non riesco a contattare TMDB")
    finally:
        con.close()


@app.get("/api/posters")
def posters(kind: str, id: int):
    """Le locandine che TMDB ha per un film o una serie, per sceglierla a mano."""
    con = db()
    try:
        r = get_item(con, id) if kind == "movie" else get_show(con, id)
        if not r:
            raise HTTPException(404, "Titolo non trovato")
        if not r["tmdb_id"]:
            raise HTTPException(400, "Prima serve la scheda: usa «Correggi scheda»")
        tmdb_id = r["tmdb_id"]
    finally:
        con.close()
    try:
        res = tmdb(f"/{'movie' if kind == 'movie' else 'tv'}/{tmdb_id}/images",
                   include_image_language=TMDB_LANG[:2] + ",en,null")
    except Exception:
        raise HTTPException(502, "Non riesco a contattare TMDB")
    lang = TMDB_LANG[:2]
    out = sorted(res.get("posters") or [], key=lambda p: (
        p.get("iso_639_1") != lang, -(p.get("vote_average") or 0), -(p.get("vote_count") or 0)))
    return [{"path": p["file_path"], "url": f"https://image.tmdb.org/t/p/w342{p['file_path']}",
             "lang": p.get("iso_639_1") or "", "votes": p.get("vote_count") or 0} for p in out[:40]]


@app.post("/api/poster")
async def set_poster(request: Request):
    """Cambia locandina: la scelta resta anche quando la scheda si aggiorna."""
    body = await read_json(request)
    kind, row_id, path = body.get("kind"), int(body.get("id") or 0), str(body.get("path") or "")
    if not re.fullmatch(r"/[A-Za-z0-9_\-]+\.(?:jpg|png)", path):
        raise HTTPException(400, "Locandina non valida")
    check = db()
    try:
        if not (get_item(check, row_id) if kind == "movie" else get_show(check, row_id)):
            raise HTTPException(404, "Titolo non trovato")
    finally:
        check.close()
    name = fetch_image(path, "w500")
    if not name:
        raise HTTPException(502, "Non riesco a scaricare la locandina")
    con = db(raw=True)
    try:
        con.execute(f"UPDATE {'items' if kind == 'movie' else 'shows'} SET poster=?, poster_pick=? WHERE id=?",
                    (name, path, row_id))
        con.commit()
    finally:
        con.close()
    return {"ok": True}


@app.post("/api/refresh")
async def refresh(request: Request):
    """Riscarica locandine e schede. Di un solo titolo: subito.
    Di una raccolta o di tutto il catalogo: in sottofondo, insieme a una nuova lettura delle cartelle."""
    body = await read_json(request)
    if not tmdb_key():
        raise HTTPException(400, "Per le schede serve la chiave TMDB: inseriscila in Impostazioni")
    check = db()                  # il titolo deve essere in una raccolta che vedi
    try:
        if body.get("item"):
            get_item(check, int(body["item"]))
        elif body.get("show") and not get_show(check, int(body["show"])):
            raise HTTPException(404, "Serie non trovata")
    finally:
        check.close()
    con = db(raw=True)
    try:
        if body.get("item") or body.get("show"):
            try:
                if body.get("item"):
                    r = get_item(con, int(body["item"]))
                    tmdb_id = r["tmdb_id"]
                    if not tmdb_id:
                        res = find_movie(r)
                        tmdb_id = res[0]["id"] if res else None
                    if not tmdb_id:
                        raise HTTPException(404, "Nessuna scheda trovata: prova «Correggi scheda»")
                    apply_movie(con, r["id"], tmdb_id)
                else:
                    s = get_show(con, int(body["show"]))
                    if not s:
                        raise HTTPException(404, "Serie non trovata")
                    tmdb_id = s["tmdb_id"]
                    if not tmdb_id:
                        res = find_show(con, s)
                        tmdb_id = res[0]["id"] if res else None
                    if not tmdb_id:
                        raise HTTPException(404, "Nessuna scheda trovata: prova «Correggi scheda»")
                    apply_show(con, s["id"], tmdb_id)
                    kept = merge_duplicate_show(con, s["id"])
                    con.commit()
                    enrich_episodes(con, get_show(con, kept))
            except (urllib.error.URLError, TimeoutError):
                raise HTTPException(502, "Non riesco a contattare TMDB")
            con.commit()
            return {"ok": True}
        where, args = ("WHERE library_id=?", (int(body["library"]),)) if body.get("library") else ("", ())
        u = CURRENT.get()
        if u is not None:         # solo le raccolte che l'account vede
            libs = [x for x in u["libs"] if not body.get("library") or x == int(body["library"])] or [-1]
            where, args = f"WHERE library_id IN ({','.join('?' * len(libs))})", tuple(libs)
        con.execute(f"UPDATE items SET meta_done=0 {where}", args)
        con.execute(f"UPDATE shows SET meta_done=0 {where}", args)
        con.commit()
    finally:
        con.close()
    scan_async()
    return {"ok": True}


@app.post("/api/shows/{show_id}/watched")
async def show_watched(show_id: int, request: Request):
    """Segna tutta la serie (o, con 'season', una sola stagione) come vista / da vedere."""
    body = await read_json(request)
    season = body.get("season")
    season = season if isinstance(season, int) and not isinstance(season, bool) else None
    if show_id >= FRIEND_BASE:
        return await in_thread(friend_show_watched, show_id, bool(body.get("watched")), season)
    con = db()
    try:
        if season is None:
            ids = [r[0] for r in con.execute("SELECT id FROM items WHERE show_id=?", (show_id,))]
        else:
            ids = [r[0] for r in con.execute("SELECT id FROM items WHERE show_id=? AND season=?",
                                             (show_id, season))]
        set_state(con, ids, watched=1 if body.get("watched") else 0, position=0)
        con.commit()
        return {"ok": True}
    finally:
        con.close()


def set_state(con, item_ids, **fields):
    """Visto, punto di ripresa, lista: dell'account che fa la richiesta (e poi
    mandati al servizio account), oppure del catalogo se gli account sono spenti."""
    if not item_ids:
        return
    names = list(fields)
    sets = ", ".join(f"{k}=?" for k in names)
    values = [fields[k] for k in names]
    u = CURRENT.get()
    if u is None:
        con.executemany(f"UPDATE items SET {sets} WHERE id=?", [(*values, i) for i in item_ids])
        return
    # Un profilo (sid negativo) resta su questo server: niente da mandare all'account
    sid = u.get("sid") or u["id"]
    con.executemany("INSERT OR IGNORE INTO user_items(user_id, item_id) VALUES(?,?)",
                    [(sid, i) for i in item_ids])
    con.executemany(f"UPDATE user_items SET {sets}, t=?, dirty=? WHERE user_id=? AND item_id=?",
                    [(*values, time.time(), int(sid > 0), sid, i) for i in item_ids])
    if sid > 0:
        sync_soon()


def set_show_fav(con, show_id, fav):
    u = CURRENT.get()
    if u is None:
        return con.execute("UPDATE shows SET fav=? WHERE id=?", (fav, show_id)).rowcount
    if not get_show(con, show_id):
        return 0
    sid = u.get("sid") or u["id"]
    con.execute("INSERT INTO user_shows(user_id, show_id, fav, t, dirty) VALUES(?,?,?,?,?) "
                "ON CONFLICT(user_id, show_id) DO UPDATE SET fav=excluded.fav, t=excluded.t, dirty=excluded.dirty",
                (sid, show_id, fav, time.time(), int(sid > 0)))
    if sid > 0:
        sync_soon()
    return 1


@app.get("/api/home")
def home(src: str = ""):
    """src: il server scelto all'apertura. "here" = solo questo, "f<n>" = solo quello
    dell'amico (o il tuo altro PC) n; vuoto = tutto insieme."""
    if src.startswith("f") and src[1:].isdigit():
        return friend_home(int(src[1:]))
    con = db()
    try:
        shows = {r["id"]: r for r in con.execute("SELECT * FROM shows")}

        def j(r):
            return item_json(r, shows.get(r["show_id"]))

        cont = [dict(j(r), last_played=r["last_played"]) for r in con.execute(
            "SELECT * FROM items WHERE position>20 AND watched=0 ORDER BY last_played DESC LIMIT 20")]
        cont_ids = {c["id"] for c in cont}

        # Prossimo episodio delle serie che stai seguendo
        nextup = []
        for s in con.execute(
                "SELECT show_id, MAX(last_played) lp FROM items WHERE show_id IS NOT NULL "
                "AND last_played>0 GROUP BY show_id ORDER BY lp DESC LIMIT 20").fetchall():
            last = con.execute(
                "SELECT * FROM items WHERE show_id=? ORDER BY last_played DESC LIMIT 1",
                (s["show_id"],)).fetchone()
            if last["watched"]:
                n = next_episode(con, last)
                if n and not n["watched"] and n["id"] not in cont_ids:
                    nextup.append(j(n))

        top_movies = [j(r) for r in con.execute(
            "SELECT * FROM items WHERE kind='movie' AND rating>=7 AND watched=0 "
            "ORDER BY rating DESC LIMIT 24")]

        # Una fila "aggiunti di recente" per ogni raccolta, nell'ordine scelto dall'utente
        libs = get_libraries()
        rows = []
        for lib in libs:
            recent = [(r["added_at"], j(r)) for r in con.execute(
                "SELECT * FROM items WHERE kind='movie' AND library_id=? "
                "ORDER BY added_at DESC LIMIT 24", (lib["id"],))]
            recent += [(r["a"], show_json(con, shows[r["show_id"]])) for r in con.execute(
                "SELECT show_id, MAX(added_at) a FROM items WHERE show_id IS NOT NULL "
                "AND library_id=? GROUP BY show_id ORDER BY a DESC LIMIT 24",
                (lib["id"],)).fetchall() if r["show_id"] in shows]
            recent.sort(key=lambda pair: pair[0] or 0, reverse=True)
            if recent:
                rows.append({"id": lib["id"], "name": lib["name"],
                             "items": [x for _, x in recent[:24]]})
        sagas = sorted((collection_json(con, r) for r in collection_rows(con)),
                       key=lambda c: c["latest"] or 0, reverse=True)[:24]
        if src != "here":
            cont = friend_continue(con, cont)
            rows += friend_home_rows()
        return {"continue": cont, "nextup": nextup, "libraries": rows, "collections": sagas,
                "top_movies": top_movies, "mylist": my_list(con)[:24], "has_libraries": bool(libs)}
    finally:
        con.close()


def my_list(con):
    """"La mia lista": film e serie messi da parte, dall'ultimo aggiunto."""
    found = [(r["fav"], item_json(r)) for r in con.execute(
        "SELECT * FROM items WHERE kind='movie' AND fav>0")]
    found += [(r["fav"], show_json(con, r)) for r in con.execute(
        "SELECT * FROM shows WHERE fav>0").fetchall()]
    found.sort(key=lambda pair: pair[0], reverse=True)
    return [x for _, x in found]


@app.get("/api/mylist")
def mylist():
    con = db()
    try:
        return my_list(con)
    finally:
        con.close()


@app.post("/api/fav")
async def set_fav(request: Request):
    """Aggiunge o toglie un film o una serie dalla lista."""
    body = await read_json(request)
    table = {"movie": "items", "show": "shows"}.get(body.get("kind"))
    if not table:
        raise HTTPException(400, "Richiesta non valida")
    try:
        target = int(body.get("id"))
    except (TypeError, ValueError):
        raise HTTPException(400, "Richiesta non valida")
    if target >= FRIEND_BASE:
        raise HTTPException(400, "«La mia lista» vale solo per i titoli di questo server")
    con = db()
    try:
        fav = time.time() if body.get("fav") else 0
        if table == "items":
            found = con.execute("SELECT id FROM items WHERE id=? AND kind='movie'", (target,)).fetchone()
            if found:
                set_state(con, [target], fav=fav)
        else:
            found = set_show_fav(con, target, fav)
        con.commit()
        if not found:
            raise HTTPException(404, "Elemento non trovato")
        return {"ok": True}
    finally:
        con.close()


@app.get("/api/movies")
def movies(library: int = 0):
    con = db()
    try:
        return [slim(item_json(r)) for r in con.execute(
            "SELECT * FROM items WHERE kind='movie' AND (?=0 OR library_id=?) "
            "ORDER BY title COLLATE NOCASE", (library, library))]
    finally:
        con.close()


@app.get("/api/collections")
def collections_list():
    """Le saghe: film della stessa serie cinematografica, riuniti da soli."""
    con = db()
    try:
        return [collection_json(con, r) for r in collection_rows(con)]
    finally:
        con.close()


@app.get("/api/collections/{coll_id}")
def collection_detail(coll_id: int):
    if coll_id >= FRIEND_BASE:
        return friend_collection(coll_id)
    con = db()
    try:
        rows = collection_rows(con, coll_id)
        if not rows:
            raise HTTPException(404, "Collezione non trovata")
        d = collection_json(con, rows[0])
        parts = jlist(rows[0]["parts"])
        order = {p["id"]: n for n, p in enumerate(parts)}
        items = con.execute("SELECT * FROM items WHERE collection_id=? AND kind='movie'",
                            (coll_id,)).fetchall()
        # Nell'ordine di uscita al cinema
        items.sort(key=lambda r: (order.get(r["tmdb_id"], len(order)), r["year"] or 9999, r["title"] or ""))
        d["items"] = [item_json(r) for r in items]
        owned = {r["tmdb_id"] for r in items}
        today = time.strftime("%Y-%m-%d")
        d["missing"] = [{"title": p["title"], "year": _year(p["date"], None)} for p in parts
                        if p["id"] not in owned and p.get("date") and p["date"] <= today]
        started = [x for x in d["items"] if x["position"] > 20 and not x["watched"]]
        unwatched = [x for x in d["items"] if not x["watched"]]
        d["up_next"] = started[0] if started else (unwatched[0] if unwatched else d["items"][0])
        return d
    finally:
        con.close()


@app.get("/api/shows")
def shows_list(library: int = 0):
    con = db()
    try:
        return [slim(show_json(con, r)) for r in con.execute(
            "SELECT * FROM shows WHERE (?=0 OR library_id=?) ORDER BY title COLLATE NOCASE",
            (library, library)).fetchall()]
    finally:
        con.close()


@app.get("/api/shows/{show_id}")
def show_detail(show_id: int):
    if show_id >= FRIEND_BASE:
        return friend_show(show_id)
    con = db()
    try:
        s = get_show(con, show_id)
        if not s:
            raise HTTPException(404, "Serie non trovata")
        d = show_json(con, s)
        d["cast"] = people_json(s["people"])
        eps = [item_json(r, s) for r in con.execute(
            "SELECT * FROM items WHERE show_id=? ORDER BY season, episode, path", (show_id,))]
        seasons = {}
        for e in eps:
            seasons.setdefault(e["season"], []).append(e)
        d["seasons"] = [{"season": k, "episodes": v} for k, v in sorted(seasons.items())]
        # Episodio da proporre: quello in corso, altrimenti il primo non visto
        started = [e for e in eps if e["position"] > 20 and not e["watched"]]
        unwatched = [e for e in eps if not e["watched"]]
        up = started[0] if started else (unwatched[0] if unwatched else (eps[0] if eps else None))
        d["up_next"] = up
        return d
    finally:
        con.close()


@app.get("/api/items/{item_id}")
def item_detail(item_id: int):
    if item_id >= FRIEND_BASE:
        return friend_item(item_id)
    con = db()
    try:
        r = get_item(con, item_id)
        show = get_show(con, r["show_id"]) if r["show_id"] else None
        d = item_json(r, show)
        d["cast"] = people_json(r["people"])
        d["collection"] = None
        if r["collection_id"]:
            saga = collection_rows(con, r["collection_id"])
            if saga:
                d["collection"] = {"id": saga[0]["id"], "title": saga_name(saga[0]["name"]),
                                   "count": saga[0]["n"]}
        d["filename"] = Path(r["path"]).name
        d["size"] = r["size"]
        d["vcodec"] = r["vcodec"]
        d["acodec"] = r["acodec"]
        gone = missing_file(r["path"])   # qui si guarda il file vero, non solo la cartella
        d["offline"] = bool(gone)
        if gone:
            d.update(where=gone["where"], disk=gone["disk"], unplugged=gone["unplugged"])
        else:
            d.pop("where", None)
            d.pop("disk", None)
        return d
    finally:
        con.close()


@app.get("/api/play/{item_id}")
def play(item_id: int):
    if item_id >= FRIEND_BASE:
        return friend_play(item_id)
    con = db()
    try:
        r = get_item(con, item_id)
        gone = missing_file(r["path"])
        if gone:   # disco scollegato: si dice quale e dove dovrebbe stare il file
            return JSONResponse({"detail": gone["message"], "missing": gone}, status_code=404)
        if marks_missing(r):
            sigle_now(r)
        return play_info(con, r)
    finally:
        con.close()


@app.get("/api/marks/{item_id}")
def marks(item_id: int):
    """Le sigle di un episodio: il player le richiede se all'avvio non erano pronte."""
    if item_id >= FRIEND_BASE:
        return {"marks_pending": False}
    con = db()
    try:
        return marks_info(get_item(con, item_id))
    finally:
        con.close()


@app.post("/api/progress/{item_id}")
async def progress(item_id: int, request: Request):
    body = await read_json(request)
    pos = float(body.get("position") or 0)
    dur = float(body.get("duration") or 0)
    if item_id >= FRIEND_BASE:
        return await in_thread(friend_progress, item_id, pos, dur, bool(body.get("ended")))
    return save_progress(item_id, pos, dur, bool(body.get("ended")))


def save_progress(item_id, pos, dur, ended=False):
    """Punto di ripresa dell'account (CURRENT); a fine titolo lo segna come visto."""
    con = db()
    try:
        r = get_item(con, item_id)
        dur = dur or (r["duration"] or 0)
        finished = ended or (dur > 0 and pos / dur > 0.93)
        # Arrivati ai titoli di coda l'episodio e' finito (come su Netflix)
        if r["credits_s"] and dur and r["credits_s"] > dur * 0.6 and pos >= r["credits_s"] - 1:
            finished = True
        if finished:
            set_state(con, [item_id], watched=1, position=0, last_played=time.time())
        else:
            set_state(con, [item_id], position=pos, last_played=time.time())
        con.commit()
        return {"ok": True, "watched": finished}
    finally:
        con.close()


@app.post("/api/watched/{item_id}")
async def set_watched(item_id: int, request: Request):
    body = await read_json(request)
    if item_id >= FRIEND_BASE:
        return await in_thread(friend_set_watched, item_id, bool(body.get("watched")))
    con = db()
    try:
        get_item(con, item_id)
        set_state(con, [item_id], watched=1 if body.get("watched") else 0, position=0)
        con.commit()
        return {"ok": True}
    finally:
        con.close()


@app.get("/api/image/{name}")
def image(name: str, size: int = 0):
    f = IMG / Path(name).name
    if not f.is_file():
        raise HTTPException(404)
    if size in SMALL_SIZES:   # versione leggera per le griglie (vedi small_image)
        f = small_image(f, size) or f
    return FileResponse(f, headers={"Cache-Control": "public, max-age=31536000, immutable"})


# Le griglie mostrano le locandine a circa 200 pixel: quelle da 500 (e gli sfondi da 1280)
# costano a TV e chiavette il doppio (o di piu') di memoria e di tempo per essere
# decodificate, ed e' cio' che rallenta lo scorrimento veloce. La versione piccola si
# scarica da TMDB la prima volta che serve; senza internet si usa quella grande.
SMALL_SIZES = (342, 780)
small_slots = threading.Semaphore(4)
small_state = {"fail": set(), "down_until": 0.0}


def small_image(f, w):
    m = re.match(r"(w(\d+)|original)_(.+)$", f.name)
    if not m or (m.group(2) and int(m.group(2)) <= w):
        return None
    target = IMG / f"w{w}_{m.group(3)}"
    if target.is_file():
        return target
    if target.name in small_state["fail"] or time.time() < small_state["down_until"]:
        return None
    with small_slots:
        if target.is_file():
            return target
        try:
            req = urllib.request.Request(f"https://image.tmdb.org/t/p/w{w}/{m.group(3)}",
                                         headers={"User-Agent": "media-server"})
            with urllib.request.urlopen(req, timeout=5) as r:
                data = r.read()
            tmp = target.with_name(target.name + ".part")
            tmp.write_bytes(data)
            os.replace(tmp, target)
            return target
        except urllib.error.HTTPError:
            small_state["fail"].add(target.name)      # TMDB non ce l'ha: la grande va bene
        except Exception:
            small_state["down_until"] = time.time() + 600   # niente internet: riprova fra 10 minuti
        return None


thumb_slots = threading.Semaphore(2)


@app.get("/api/thumb/{item_id}")
def thumb(item_id: int):
    """Fotogramma del video, usato quando non c'e' una locandina."""
    if item_id >= FRIEND_BASE:
        return friend_thumb(item_id)
    target = IMG / f"thumb_{item_id}.jpg"
    if not target.exists():
        con = db()
        try:
            r = get_item(con, item_id)
        finally:
            con.close()
        # Aprendo una serie con centinaia di episodi partivano decine di ffmpeg insieme:
        # ora due alla volta, a bassa priorita', leggendo solo un fotogramma chiave.
        with thumb_slots:
            for seek in ((r["duration"] or 0) * 0.15, 0):
                if target.exists() and target.stat().st_size > 0:
                    break
                subprocess.run(
                    ["nice", "-n", "15", "ffmpeg", "-v", "error", "-nostdin", "-y", "-threads", "2",
                     "-skip_frame", "nokey", "-ss", f"{seek:.2f}", "-i", r["path"], "-an", "-sn",
                     "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", str(target)],
                    capture_output=True, timeout=120)
    if not target.exists() or target.stat().st_size == 0:
        raise HTTPException(404)
    return FileResponse(target, headers={"Cache-Control": "public, max-age=86400"})


def srt_to_vtt(text):
    text = text.replace("\r\n", "\n").replace("\r", "\n").lstrip("﻿")
    text = re.sub(r"(\d{2}:\d{2}:\d{2}),(\d{3})", r"\1.\2", text)
    return "WEBVTT\n\n" + text


TS = re.compile(r"(\d+):(\d{2}):(\d{2})[.,](\d{3})")


def shift_vtt(text, offset):
    """Anticipa i sottotitoli di 'offset' secondi (serve quando il video
    convertito riparte da meta' film e il suo orologio ricomincia da zero)."""
    def fmt(sec):
        ms = int(round(sec * 1000))
        return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d}.{ms % 1000:03d}"

    out = []
    for block in text.split("\n\n"):
        times = TS.findall(block)
        if len(times) < 2:
            out.append(block)
            continue
        a, b = (int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000 - offset
                for h, m, s, ms in times[:2])
        if b <= 0:
            continue
        values = iter((fmt(max(0, a)), fmt(b)))
        out.append(TS.sub(lambda _m: next(values, _m.group(0)), block, count=2))
    return "\n\n".join(out)


@app.get("/api/subs/{item_id}/{index}")
def subs(item_id: int, index: int, offset: float = 0):
    if item_id >= FRIEND_BASE:
        return friend_subs(item_id, index, offset)
    con = db()
    try:
        r = get_item(con, item_id)
    finally:
        con.close()
    files = subtitle_files(r["path"], item_id)
    if index < 0 or index >= len(files):
        raise HTTPException(404)
    f = files[index][0]
    raw = f.read_bytes()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("cp1252", errors="replace")
    if f.suffix.lower() == ".srt":
        text = srt_to_vtt(text)
    else:
        text = text.replace("\r\n", "\n")
    if offset > 0:
        text = shift_vtt(text, offset)
    return Response(text, media_type="text/vtt; charset=utf-8")


# --------------------------------------------------------------------------
# Sottotitoli da internet (OpenSubtitles.com)
# --------------------------------------------------------------------------
# Serve una chiave API gratuita (opensubtitles.com -> Profilo -> API consumers).
# Nome utente e password dell'account sono facoltativi ma alzano il limite di
# download giornaliero. Il sottotitolo scelto finisce in data/subs/<id>/<lingua>.srt
# e da li' lo vedono tutti i dispositivi (e gli amici).

OS_API = "https://api.opensubtitles.com/api/v1"
OS_UA = "BunkerPlex v1.0"
OS_LANGS = ["it", "en", "es", "fr", "de"]
os_sessions = {}                   # nome utente OpenSubtitles -> {token, base, at}
os_lock = threading.Lock()


class SubsError(Exception):
    pass


def os_conf():
    """Chiave e account OpenSubtitles: dell'account che fa la richiesta, se ne ha una."""
    u = CURRENT.get()
    c = (user_setting(u["id"], "opensubtitles") if u else None) or config.get("opensubtitles") or {}
    return {"key": (c.get("key") or os.environ.get("OPENSUBTITLES_API_KEY", "")).strip(),
            "user": (c.get("user") or "").strip(), "password": c.get("password") or ""}


def os_call(method, path, params=None, body=None, conf=None, token="", base=""):
    conf = conf or os_conf()
    if not conf["key"]:
        raise SubsError("Manca la chiave di OpenSubtitles: inseriscila in Impostazioni")
    url = (f"https://{base}/api/v1" if base else OS_API) + path
    if params:   # OpenSubtitles vuole i parametri in ordine alfabetico (se no reindirizza)
        url += "?" + urllib.parse.urlencode(sorted((k, str(v)) for k, v in params.items()))
    headers = {"Api-Key": conf["key"], "User-Agent": OS_UA, "Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r)
    except urllib.error.HTTPError as ex:
        try:
            detail = json.loads(ex.read().decode("utf-8", "replace"))
            msg = detail.get("message") or detail.get("error") or ""
        except Exception:
            msg = ""
        if ex.code in (401, 403):
            msg = "chiave API o account non validi (controllali in Impostazioni)"
        if ex.code in (406, 429) and not msg:
            msg = "limite di download di oggi raggiunto"
        raise SubsError(f"OpenSubtitles: {msg or 'errore ' + str(ex.code)}")
    except Exception:
        raise SubsError("Non riesco a contattare OpenSubtitles: controlla la connessione del PC")


def os_login(conf=None, force=False):
    """Token dell'account (se ci sono nome e password), ricordato per 12 ore."""
    conf = conf or os_conf()
    if not conf["user"] or not conf["password"]:
        return "", ""
    with os_lock:
        # Un accesso per ogni account OpenSubtitles (sullo stesso PC ce ne possono essere piu')
        sess = os_sessions.setdefault(conf["user"].lower(), {"token": "", "base": "", "at": 0.0})
        if not force and sess["token"] and time.time() - sess["at"] < 12 * 3600:
            return sess["token"], sess["base"]
        res = os_call("POST", "/login", body={"username": conf["user"], "password": conf["password"]}, conf=conf)
        base = (res.get("base_url") or "").strip().strip("/")
        base = re.sub(r"^https?://", "", base).split("/")[0]
        sess.update(token=res.get("token") or "", base=base, at=time.time())
        return sess["token"], sess["base"]


def os_hash(path):
    """Impronta di OpenSubtitles: dimensione + somma dei primi e ultimi 64 KB."""
    try:
        size = os.path.getsize(path)
        if size < 65536 * 2:
            return ""
        h = size
        with open(path, "rb") as f:
            for at in (0, size - 65536):
                f.seek(at)
                for (v,) in struct.iter_unpack("<Q", f.read(65536)):
                    h = (h + v) & 0xFFFFFFFFFFFFFFFF
        return f"{h:016x}"
    except OSError:
        return ""


def os_lang(code):
    code = (code or "").lower()
    return {"pt-pt": "pt", "pt-br": "pt", "ze": "zh", "zh-cn": "zh", "zh-tw": "zh"}.get(code, code)[:3]


@app.get("/api/subs-online/{item_id}")
def subs_online_search(item_id: int, langs: str = ""):
    """Sottotitoli disponibili su OpenSubtitles per questo video, i piu' adatti prima."""
    if item_id >= FRIEND_BASE:
        return {"ok": False, "error": "Si scaricano solo per i video di questo PC: chiedilo all'amico"}
    con = db()
    try:
        r = get_item(con, item_id)
        show = get_show(con, r["show_id"]) if r["show_id"] else None
    finally:
        con.close()
    want = [x for x in (langs or ",".join(OS_LANGS[:2])).lower().split(",") if x in OS_LANGS] or OS_LANGS[:2]
    params = {"languages": ",".join(sorted(want))}
    if r["kind"] == "episode":
        if show and show["tmdb_id"]:
            params["parent_tmdb_id"] = show["tmdb_id"]
        else:
            params["query"] = (show["title"] if show else r["title"]) or Path(r["path"]).stem
        params["season_number"] = r["season"] or 0
        params["episode_number"] = r["episode"] or 0
    elif r["tmdb_id"]:
        params["tmdb_id"] = r["tmdb_id"]
    else:
        params["query"] = r["title"] or Path(r["path"]).stem
        if r["year"]:
            params["year"] = r["year"]
    mh = os_hash(r["path"])
    try:
        found = os_call("GET", "/subtitles", dict(params, moviehash=mh) if mh else params).get("data") or []
        if not found and mh:
            found = os_call("GET", "/subtitles", params).get("data") or []
    except SubsError as ex:
        return {"ok": False, "error": str(ex)}
    out = []
    for s in found:
        a = s.get("attributes") or {}
        files = a.get("files") or []
        if not files or not files[0].get("file_id"):
            continue
        lang = os_lang(a.get("language"))
        out.append({
            "file_id": files[0]["file_id"], "lang": lang,
            "language": LANGS.get(lang, lang.upper()),
            "release": (a.get("release") or files[0].get("file_name") or "").strip()[:120],
            "downloads": a.get("download_count") or 0,
            "match": bool(a.get("moviehash_match")),
            "hi": bool(a.get("hearing_impaired")),
            "machine": bool(a.get("machine_translated") or a.get("ai_translated")),
            "trusted": bool(a.get("from_trusted"))})
    order = {l: i for i, l in enumerate(want)}
    out.sort(key=lambda x: (order.get(x["lang"], 99), not x["match"], x["machine"], -x["downloads"]))
    return {"ok": True, "results": out[:40], "langs": want}


@app.post("/api/subs-online/{item_id}")
async def subs_online_get(item_id: int, request: Request):
    """Scarica il sottotitolo scelto e lo mette tra quelli del video
    (sostituisce quello gia' scaricato nella stessa lingua)."""
    body = await read_json(request)
    try:
        file_id = int(body.get("file_id") or 0)
    except (TypeError, ValueError):
        file_id = 0
    lang = re.sub(r"[^a-z]", "", str(body.get("lang") or "").lower())[:3] or "xx"
    if item_id >= FRIEND_BASE or file_id <= 0:
        return {"ok": False, "error": "Richiesta non valida"}

    def work():
        conf = os_conf()
        token, base = os_login(conf)
        try:
            res = os_call("POST", "/download", body={"file_id": file_id}, conf=conf, token=token, base=base)
        except SubsError:
            if not token:
                raise
            token, base = os_login(conf, force=True)    # token scaduto: si rientra una volta
            res = os_call("POST", "/download", body={"file_id": file_id}, conf=conf, token=token, base=base)
        link = res.get("link")
        if not link or not link.startswith("https://"):
            raise SubsError("OpenSubtitles: " + (res.get("message") or "download non riuscito"))
        try:
            req = urllib.request.Request(link, headers={"User-Agent": OS_UA})
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read(5_000_000)
        except Exception:
            raise SubsError("Il file del sottotitolo non e' arrivato: riprova")
        if raw[:2] == b"\x1f\x8b":
            try:
                raw = gzip.decompress(raw)
            except Exception:
                raise SubsError("Il file scaricato e' rovinato: riprova")
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = raw.decode("cp1252", errors="replace")
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        if "-->" not in text:
            raise SubsError("Il file scaricato non sembra un sottotitolo")
        ext = ".vtt" if text.lstrip().startswith("WEBVTT") else ".srt"
        folder = SUBS_DIR / str(item_id)
        folder.mkdir(parents=True, exist_ok=True)
        for old in folder.glob(lang + ".*"):
            old.unlink()
        tmp = folder / (lang + ext + ".tmp")
        tmp.write_text(text, "utf-8")
        os.replace(tmp, folder / (lang + ext))
        return res.get("remaining")

    try:
        remaining = await asyncio.to_thread(work)
    except SubsError as ex:
        return {"ok": False, "error": str(ex)}
    except OSError:
        return {"ok": False, "error": "Non riesco a salvare il sottotitolo nella cartella del catalogo"}
    con = db()
    try:
        info = play_info(con, get_item(con, item_id))
    finally:
        con.close()
    index = next((i for i, s in enumerate(info["subs"]) if s["online"] and s["lang"] == lang[:2]),
                 len(info["subs"]) - 1)
    return {"ok": True, "subs": info["subs"], "index": index,
            "remaining": remaining if isinstance(remaining, int) else None}


@app.post("/api/settings/opensubtitles")
async def save_opensubtitles(request: Request):
    """Salva chiave (e, se ci sono, nome e password) dopo averle provate."""
    body = await read_json(request)
    old = os_conf()
    conf = {"key": (body.get("key") or "").strip() or old["key"],
            "user": (body.get("user") or "").strip(),
            "password": body.get("password") or ""}
    if body.get("remove"):
        conf = {"key": "", "user": "", "password": ""}
    elif not conf["key"]:
        raise HTTPException(400, "Incolla la chiave API di OpenSubtitles")
    elif conf["user"] and not conf["password"] and conf["user"] == old["user"]:
        conf["password"] = old["password"]      # nome invariato e password lasciata vuota: si tiene
    if conf["key"]:
        try:
            if conf["user"] and conf["password"]:
                await asyncio.to_thread(os_login, conf, True)
            else:
                await asyncio.to_thread(os_call, "GET", "/infos/formats", None, None, conf)
        except SubsError as ex:
            raise HTTPException(400, str(ex))
    u = CURRENT.get()
    if u is not None:             # nell'account: arriva su tutti i PC dove entri
        put_user_setting(u["id"], "opensubtitles", conf)
    else:
        with config_lock:
            config["opensubtitles"] = conf
            save_config()
    with os_lock:
        if conf["user"]:
            os_sessions.pop(conf["user"].lower(), None)
    return {"ok": True}


@app.api_route("/api/stream/{item_id}", methods=["GET", "HEAD"])
def stream(item_id: int, request: Request):
    """File originale, con supporto Range (serve per andare avanti/indietro)."""
    if item_id >= FRIEND_BASE:
        return friend_stream(item_id, request)
    con = db()
    try:
        path = get_item(con, item_id)["path"]
    finally:
        con.close()
    if not os.path.isfile(path):
        raise HTTPException(404, "File non trovato sul disco")
    size = os.path.getsize(path)
    ctype = MIME.get(Path(path).suffix.lower()) or mimetypes.guess_type(path)[0] \
        or "application/octet-stream"
    start, end, status = 0, size - 1, 200
    rng = request.headers.get("range")
    if rng:
        m = re.match(r"bytes=(\d*)-(\d*)", rng)
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                if m.group(2):
                    end = min(int(m.group(2)), size - 1)
            else:
                start = max(0, size - int(m.group(2)))
            if start > end or start >= size:
                return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
            status = 206
    length = end - start + 1
    headers = {"Accept-Ranges": "bytes", "Content-Length": str(length)}
    if status == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    if request.method == "HEAD":
        return Response(status_code=status, headers=headers, media_type=ctype)

    def body():
        remaining = length
        with open(path, "rb") as f:
            f.seek(start)
            while remaining > 0:
                chunk = f.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    return StreamingResponse(body(), status_code=status, headers=headers, media_type=ctype)


CHANNELS = {1: "mono", 2: "stereo", 6: "5.1", 7: "6.1", 8: "7.1"}
tracks_cache = {}


def audio_tracks(path):
    """Le tracce audio del file, nell'ordine in cui le conta ffmpeg (0:a:N)."""
    if path in tracks_cache:
        return tracks_cache[path]
    out = []
    try:
        raw = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries",
             "stream=codec_name,channels,channel_layout:stream_tags=language,title", "-of", "json", path],
            capture_output=True, text=True, timeout=30).stdout
        for i, s in enumerate(json.loads(raw).get("streams", [])):
            tags = s.get("tags") or {}
            code = (tags.get("language") or "").lower()
            name = LANGS.get(code) or (code.upper() if code and code != "und" else f"Traccia {i + 1}")
            detail = " ".join(x for x in ((s.get("codec_name") or "").upper(),
                                          CHANNELS.get(s.get("channels") or 0, "")) if x)
            out.append({"index": i, "lang": code, "codec": s.get("codec_name") or "",
                        "channels": s.get("channels") or 0, "layout": s.get("channel_layout") or "",
                        "label": name + (f" · {detail}" if detail else ""),
                        "title": tags.get("title") or ""})
    except Exception:
        return out          # non si ricorda un errore: il disco potrebbe tornare
    if len(tracks_cache) > 500:
        tracks_cache.clear()
    tracks_cache[path] = out
    return out


@app.get("/api/tracks/{item_id}")
def tracks(item_id: int):
    """Tracce audio tra cui scegliere nel player (lingua)."""
    if item_id >= FRIEND_BASE:
        return friend_tracks(item_id)
    con = db()
    try:
        r = get_item(con, item_id)
    finally:
        con.close()
    return {"audio": audio_tracks(r["path"]), "vcodec": r["vcodec"] or "", "acodec": r["acodec"] or "",
            "width": r["width"] or 0, "height": r["height"] or 0, "size": r["size"] or 0}


hdr_cache = {}


def is_hdr(path):
    """True se il video e' HDR (HDR10, HDR10+, Dolby Vision con base HDR10, HLG).
    Si controlla una volta sola per file: a ogni salto la conversione riparte
    e rileggere il file ogni volta allungava l'attesa."""
    if path not in hdr_cache:
        if len(hdr_cache) > 500:
            hdr_cache.clear()
        hdr_cache[path] = _is_hdr(path)
    return hdr_cache[path]


def _is_hdr(path):
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
             "stream=color_transfer", "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=30).stdout
        return any(t in out for t in ("smpte2084", "arib-std-b67"))
    except Exception:
        return False


# Un PC con pochi processori non regge la ricodifica a 1080p: si scende a 720p
# con il profilo piu' leggero che esiste.
CORES = os.cpu_count() or 4
SLOW_PC = CORES <= 4


def transcode_plan(r, vcopy=False):
    """Come convertire spendendo meno processore possibile.
    La parte pesante e' ricodificare il video: si evita ogni volta che si puo'.
    - Video H.264 normale: si copia sempre cosi' com'e'.
    - 'vcopy': il dispositivo ha detto di saper decodificare il video originale
      (es. H.265 4K HDR) e gli serve solo un altro contenitore o un altro audio:
      si copia, quindi la qualita' resta quella del file, HDR compreso.
    L'audio lo sceglie audio_plan.
    Restituisce (argomenti video, True se il video viene ricodificato)."""
    vcodec, pix = r["vcodec"] or "", r["pix"] or ""
    if vcodec == "h264" and pix in ("yuv420p", "yuvj420p"):
        vargs, heavy = ["-c:v", "copy"], False
    elif vcopy and vcodec == "hevc":
        vargs, heavy = ["-c:v", "copy", "-tag:v", "hvc1"], False
    elif vcopy and vcodec in ("h264", "av1", "vp9"):
        vargs, heavy = ["-c:v", "copy"], False
    else:
        hdr = "10" in pix and is_hdr(r["path"])
        # La conversione dei colori HDR raddoppia il lavoro: a 1080p solo sui PC potenti,
        # a 720p su quelli medi; su quelli lenti si rinuncia (colori spenti ma niente scatti).
        height = 720 if SLOW_PC or (hdr and CORES < 12) else 1080
        # Prima si rimpicciolisce (mai oltre 1080p), poi si lavora sul fotogramma piccolo.
        chain = f"scale=-2:min({height}\\,ih):flags=fast_bilinear"
        if hdr and not SLOW_PC:
            # HDR -> schermo normale: senza questa conversione i colori escono
            # grigi e slavati. Si fa dopo aver rimpicciolito, cosi' costa meno.
            chain += (",zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,"
                      "tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv")
        vargs, heavy = ["-c:v", "libx264", "-preset", "ultrafast" if SLOW_PC else "superfast",
                        "-crf", "23" if SLOW_PC else "21", "-vf", chain + ",format=yuv420p",
                        "-g", "96", "-sc_threshold", "0"], True
    return vargs, heavy


# Che audio vuole chi chiede la conversione ('aout'):
#   ""     browser e app TV vecchie: stereo AAC (l'AAC originale si copia).
#   "tv"   app TV: l'audio che la TV legge (AAC, AC3, E-AC3, Atmos compreso) si copia
#          cosi' com'e'; DTS, TrueHD e il resto diventano AC3 5.1, il Dolby che ogni
#          TV passa alla soundbar. Prima diventava stereo: niente surround e niente bassi.
#   "ac3"  app TV a cui l'audio originale non e' andato: si converte sempre (AC3 5.1).
#   "aac"  app TV che non legge neanche l'AC3: AAC, fino a 5.1.
AOUTS = ("", "tv", "ac3", "aac")
TV_COPY = {"aac", "ac3", "eac3"}


def stereo_args(track, kbps=192):
    """AAC stereo. Dal 5.1 e dal 7.1 con un mixaggio che tiene i bassi del canale
    LFE e i dialoghi del centrale: quello di serie di ffmpeg butta via il canale
    dei bassi e abbassa tutto di quasi 8 dB. Il limitatore evita che i picchi
    sommati gracchino (non alza ne' abbassa il volume normale)."""
    ch, layout = track.get("channels") or 0, track.get("layout") or ""
    mix = ""
    if ch == 6 and layout in ("", "5.1", "5.1(side)"):        # FL FR FC LFE SL SR
        mix = ("pan=stereo|c0=0.707*c0+0.5*c2+0.5*c3+0.707*c4"
               "|c1=0.707*c1+0.5*c2+0.5*c3+0.707*c5")
    elif ch == 8 and layout in ("", "7.1"):                    # FL FR FC LFE BL BR SL SR
        mix = ("pan=stereo|c0=0.707*c0+0.5*c2+0.5*c3+0.5*c4+0.5*c6"
               "|c1=0.707*c1+0.5*c2+0.5*c3+0.5*c5+0.5*c7")
    # aresample=async: riallinea l'audio ai tempi del video (buchi o sfasamenti nel file
    # originale non si accumulano in un desync audio/video).
    sync = "aresample=async=1:first_pts=0"
    args = ["-af", mix + ",alimiter=limit=0.95:level=0," + sync] if mix else ["-af", sync, "-ac", "2"]
    return args + ["-c:a", "aac", "-b:a", f"{kbps}k"]


def audio_plan(track, aout=""):
    """Argomenti ffmpeg per la traccia audio scelta (vedi AOUTS)."""
    codec, ch = track.get("codec") or "", track.get("channels") or 0
    if aout == "tv" and codec in TV_COPY:
        return ["-c:a", "copy"]
    if aout in ("tv", "ac3") and ch > 2:
        return ["-c:a", "ac3", "-b:a", "640k"] + (["-ac", "6"] if ch > 6 else [])
    sync = ["-af", "aresample=async=1:first_pts=0"]      # riallinea l'audio al video
    if aout == "aac" and ch > 2:
        return sync + ["-c:a", "aac", "-b:a", "384k"] + (["-ac", "6"] if ch > 6 else [])
    if not aout and codec == "aac" and ch > 2:
        # AAC surround per il browser: resta 5.1 (ricodificato, non copiato, per tenerlo in sincrono)
        return sync + ["-c:a", "aac", "-b:a", "384k"] + (["-ac", "6"] if ch > 6 else [])
    # Per il browser l'audio si ricodifica sempre (anche l'AAC): copiarlo lasciava
    # l'offset di partenza del file e l'audio slittava rispetto al video. Ricodificando,
    # aresample lo riallinea; costa pochissimo processore.
    return stereo_args(track)


HEIGHTS_OK = (480, 720, 1080, 2160)     # qualita' chiedibili dal player


def uplink_plan(r, height, vcopy=False):
    """Conversione per un amico che guarda da fuori casa: il collo di bottiglia
    e' la velocita' di caricamento di questa linea, quindi il video viene
    rimpicciolito a 'height' (720 o 1080) con un tetto ai dati al secondo.
    Se il file e' gia' H.264 leggero e non piu' grande, si copia senza lavoro."""
    cap = {480: 2500, 720: 6000, 1080: 16000, 2160: 40000}.get(height, 16000)          # kbit/s
    vcodec, pix = r["vcodec"] or "", r["pix"] or ""
    kbps = (r["size"] or 0) * 8 / 1000 / r["duration"] if r["duration"] else 0
    # Copia senza ricodificare se il video e' gia' leggero abbastanza per la qualita' chiesta
    # (H.265 e simili solo se il dispositivo ha detto di saperli decodificare).
    ok_codec = (vcodec == "h264" and pix in ("yuv420p", "yuvj420p")) or (vcopy and vcodec in ("hevc", "h264", "av1", "vp9"))
    if ok_codec and 0 < (r["height"] or 0) <= height + 8 and 0 < kbps <= cap * 1.25:
        vargs, heavy = ["-c:v", "copy"] + (["-tag:v", "hvc1"] if vcodec == "hevc" else []), False
    else:
        hdr = "10" in pix and is_hdr(r["path"])
        chain = f"scale=-2:min({height}\\,ih):flags=fast_bilinear"
        if hdr and not SLOW_PC:
            chain += (",zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,"
                      "tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv")
        vargs, heavy = ["-c:v", "libx264", "-preset", "ultrafast" if SLOW_PC else "superfast",
                        "-crf", "23", "-maxrate", f"{cap}k", "-bufsize", f"{cap * 2}k",
                        "-vf", chain + ",format=yuv420p", "-g", "96", "-sc_threshold", "0"], True
    return vargs, heavy


@app.get("/api/transcode/{item_id}")
def transcode(item_id: int, start: float = 0, vcopy: int = 0, audio: int = 0, aout: str = "", height: int = 0):
    """Conversione al volo in MP4 per i dispositivi che non leggono il file
    originale. Non si puo' saltare dentro il flusso: per spostarsi il player
    richiede di nuovo l'indirizzo con un altro 'start'.
    'vcopy=1': il dispositivo sa decodificare il video, va cambiato solo il resto.
    'aout': che audio vuole il dispositivo (vedi AOUTS).
    'height' HEIGHTS_OK: qualita' adattiva scelta dal player in base alla banda
    misurata: video rimpicciolito con tetto ai dati al secondo (0 = qualita' piena)."""
    aout = aout if aout in AOUTS else ""
    if item_id >= FRIEND_BASE:
        return friend_transcode(item_id, start, vcopy, audio, aout)
    return run_transcode(item_id, start, vcopy, audio, height if height in HEIGHTS_OK else 0, aout)


_BW_BLOB = os.urandom(1024 * 1024)      # casuale: la compressione gzip non lo accorcia


@app.get("/api/bwtest")
def bwtest(kb: int = 512):
    """Dati a vuoto per misurare la banda tra il dispositivo e il PC (qualita' adattiva)."""
    kb = max(16, min(kb, 1024))
    return Response(_BW_BLOB[:kb * 1024], media_type="application/octet-stream",
                    headers={"Cache-Control": "no-store"})


def run_transcode(item_id, start=0.0, vcopy=0, audio=0, height=0, aout=""):
    con = db()
    try:
        r = get_item(con, item_id)
    finally:
        con.close()
    path = r["path"]
    if not os.path.isfile(path):
        raise HTTPException(404, "File non trovato sul disco")
    vargs, heavy = uplink_plan(r, height, bool(vcopy)) if height else transcode_plan(r, bool(vcopy))
    audio = max(0, audio)
    # Formato e canali della lingua scelta (ogni traccia puo' essere diversa)
    found = audio_tracks(path)
    track = found[audio] if audio < len(found) else {"codec": "" if audio else (r["acodec"] or "")}
    # Per un amico fuori casa (height) conta la linea: stereo leggero
    aargs = stereo_args(track, 128) if height else audio_plan(track, aout)
    movflags = "frag_keyframe+empty_moov+default_base_moof"
    out_codec = aargs[aargs.index("-c:a") + 1]
    if (track.get("codec") if out_codec == "copy" else out_codec) in ("ac3", "eac3"):
        movflags += "+delay_moov"       # l'MP4 non sa scrivere l'intestazione AC3 prima del primo pezzo
    # nice: la conversione lascia sempre la precedenza al resto del PC.
    cmd = ["nice", "-n", "10", "ffmpeg", "-v", "error", "-nostdin"]
    if heavy:
        # Non corre piu' del necessario: converte i primi 30 secondi subito (partenza
        # rapida), poi tiene un passo poco sopra la velocita' di visione invece di
        # occupare tutti i processori per riempire in anticipo la memoria del player.
        cmd += ["-readrate", "1.5", "-readrate_initial_burst", "30"]
    # Con video copiato '-ss' parte dal keyframe precedente: i suoi tempi negativi in
    # un MP4 frammentato venivano tagliati e il video slittava rispetto all'audio.
    # make_zero sposta audio e video insieme, mantenendoli allineati.
    cmd += (["-fflags", "+genpts", "-ss", f"{max(0.0, start):.2f}", "-i", path,
             "-avoid_negative_ts", "make_zero",
             "-map", "0:v:0", "-map", f"0:a:{audio}?", "-sn", "-dn", "-map_chapters", "-1"] + vargs + aargs +
            ["-movflags", movflags, "-f", "mp4", "pipe:1"])
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

    async def body():
        # Generatore asincrono: quando il dispositivo chiude il video o salta in un
        # altro punto, il 'finally' parte subito e ferma ffmpeg. (Con quello normale
        # il processo restava appeso sul PC a ogni salto.)
        loop = asyncio.get_running_loop()
        try:
            while True:
                chunk = await loop.run_in_executor(None, proc.stdout.read1, 256 * 1024)
                if not chunk:
                    break
                yield chunk
        finally:
            proc.kill()
            proc.wait()

    return StreamingResponse(body(), media_type="video/mp4",
                             headers={"Cache-Control": "no-store"})


# ---- iPhone e iPad: la conversione arriva in HLS -----------------------------
# Safari su iPhone non riproduce un MP4 di cui non conosce la lunghezza (vuole
# poterlo chiedere a pezzi, con Range), quindi il flusso di /api/transcode non
# gli va. Per lui lo stesso flusso viene tagliato in pezzi da 4-10 secondi
# (HLS, il formato di Apple): un secondo ffmpeg copia senza ricodificare,
# quindi il lavoro per il PC e' lo stesso. Per spostarsi il player chiede una
# nuova sessione con un altro 'start', come per l'MP4.
# Indirizzi: /api/hls/<id>/<player>-<n>/index.m3u8?start=... e i pezzi accanto.
# <player> e' casuale per ogni finestra del player: una sessione nuova dello
# stesso player chiude la precedente (niente conversioni dimenticate accese).
HLS_DIR = Path(os.environ.get("HLS_DIR", "/tmp/bunkerplex-hls"))
HLS_TOK = re.compile(r"^([A-Za-z0-9]{8,32})-\d{1,6}$")
HLS_FILE = re.compile(r"^(index\.m3u8|init\.mp4|s(\d{5})\.m4s)$")
HLS_MAX = 4                      # sessioni insieme sul PC (la piu' vecchia lascia il posto)
HLS_IDLE_RUN = 300               # secondi senza richieste: conversione ferma e pezzi cancellati
HLS_IDLE_DONE = 1800             # ...quando ha gia' finito occupa solo disco
HLS_BEHIND = 90                  # pezzi gia' visti da tenere (dietro all'ultimo chiesto)
HLS_DISK = 3 * 1024 ** 3         # oltre questo per sessione si cancellano i pezzi vecchi
hls_sessions = {}                # (id, tok) -> sessione
hls_janitor = None


def hls_stop(key):
    s = hls_sessions.pop(key, None)
    if not s:
        return
    if s["task"]:
        s["task"].cancel()
    try:
        s["proc"].kill()
    except (ProcessLookupError, AttributeError):
        pass
    shutil.rmtree(s["dir"], ignore_errors=True)


def hls_prune(s):
    """Pezzi gia' visti da un pezzo: via, se la sessione occupa troppo disco."""
    try:
        files = sorted(s["dir"].glob("s*.m4s"))
        if sum(f.stat().st_size for f in files) < HLS_DISK:
            return
        for f in files:
            m = HLS_FILE.match(f.name)
            if m and int(m.group(2)) < s["last"] - HLS_BEHIND:
                f.unlink(missing_ok=True)
    except OSError:
        pass


async def hls_clean_loop():
    while True:
        await asyncio.sleep(20)
        now = time.monotonic()
        for key, s in list(hls_sessions.items()):
            done = s["proc"].returncode is not None
            if now - s["seen"] > (HLS_IDLE_DONE if done else HLS_IDLE_RUN):
                hls_stop(key)
            else:
                await asyncio.to_thread(hls_prune, s)


async def hls_start(item_id, tok, start, vcopy, audio, make_src=None, height=0):
    global hls_janitor
    if hls_janitor is None:
        shutil.rmtree(HLS_DIR, ignore_errors=True)        # avanzi di prima dell'avvio
        hls_janitor = asyncio.get_running_loop().create_task(hls_clean_loop())
    player = HLS_TOK.match(tok).group(1)
    for key, s in list(hls_sessions.items()):
        if s["player"] == player:
            hls_stop(key)
    while len(hls_sessions) >= HLS_MAX:
        hls_stop(min(hls_sessions, key=lambda k: hls_sessions[k]["seen"]))
    # Lo stesso flusso MP4 di sempre (anche dai PC degli amici), con audio AAC
    src = await asyncio.to_thread(make_src) if make_src else \
        await asyncio.to_thread(transcode, item_id, start, vcopy, audio, "aac", height)
    if not isinstance(src, StreamingResponse):
        raise HTTPException(502, "Il video non arriva")
    d = HLS_DIR / f"{item_id}-{tok}"
    shutil.rmtree(d, ignore_errors=True)
    d.mkdir(parents=True)
    # -readrate: si taglia poco piu' veloce di quanto si guarda, cosi' il disco non si
    # riempie con tutto il film (e il PC non lavora per pezzi che nessuno vedra').
    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-readrate", "1.5", "-readrate_initial_burst", "60",
           "-i", "pipe:0", "-map", "0", "-c", "copy",
           "-f", "hls", "-hls_time", "4", "-hls_list_size", "0", "-hls_playlist_type", "event",
           "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
           "-hls_segment_filename", str(d / "s%05d.m4s"),
           "-hls_flags", "independent_segments+temp_file", str(d / "index.m3u8")]
    proc = await asyncio.create_subprocess_exec(*cmd, stdin=subprocess.PIPE,
                                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    s = {"proc": proc, "dir": d, "player": player, "seen": time.monotonic(), "last": 0, "task": None}

    async def pump():
        it = src.body_iterator
        try:
            async for chunk in it:
                proc.stdin.write(chunk)
                await proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            try:
                proc.stdin.close()
            except Exception:
                pass
            if hasattr(it, "aclose"):
                await it.aclose()         # ferma la conversione (o il collegamento con l'amico)

    s["task"] = asyncio.get_running_loop().create_task(pump())
    hls_sessions[(item_id, tok)] = s
    return s


@app.get("/api/hls/{item_id}/{tok}/{name}")
async def hls(item_id: int, tok: str, name: str, start: float = 0, vcopy: int = 0, audio: int = 0,
              height: int = 0):
    return await hls_serve(item_id, tok, name, start, vcopy, audio, height=height)


async def hls_serve(item_id, tok, name, start=0, vcopy=0, audio=0, make_src=None, shared=False, height=0):
    """shared: la chiede un amico (o l'app iPhone fuori casa) da /api/share/hls:
    chi e' lo dice gia' il gettone, controllato da share_guard."""
    m = HLS_FILE.match(name)
    if not HLS_TOK.match(tok) or not m:
        raise HTTPException(404)
    key = (item_id, tok)
    s = hls_sessions.get(key)
    if s is None:
        if name != "index.m3u8":
            raise HTTPException(404, "Sessione finita")
        # Aprirne una vuole chi e' entrato; poi basta l'indirizzo, che e' casuale
        # (il player di Safari non sempre manda il cookie a ogni pezzo).
        if not shared and CURRENT.get() is None:
            raise HTTPException(401, "Scegli chi guarda per continuare")
        s = await hls_start(item_id, tok, start, vcopy, audio, make_src, height if height in HEIGHTS_OK else 0)
    s["seen"] = time.monotonic()
    path = s["dir"] / name
    if name == "index.m3u8":
        # La prima volta si aspetta il primo pezzo (la conversione parte da zero)
        for _ in range(600):
            try:
                text = path.read_text()
            except OSError:
                text = ""
            if "#EXTINF" in text:
                # Finche' la conversione va avanti la lista e' «in diretta»: senza
                # questa riga Safari partirebbe dagli ultimi pezzi invece che dall'inizio.
                if "#EXT-X-START" not in text:
                    text = text.replace("#EXTM3U\n", "#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n", 1)
                return Response(text, media_type="application/vnd.apple.mpegurl",
                                headers={"Cache-Control": "no-store"})
            if s["proc"].returncode is not None or hls_sessions.get(key) is not s:
                break
            await asyncio.sleep(0.1)
        hls_stop(key)
        raise HTTPException(502, "Conversione non riuscita")
    if m.group(2):
        s["last"] = max(s["last"], int(m.group(2)))
    if not path.is_file():
        raise HTTPException(404)
    return FileResponse(path, media_type="video/mp4", headers={"Cache-Control": "no-store"})


# --------------------------------------------------------------------------
# Amici: due BunkerPlex in case diverse si mostrano a vicenda le raccolte
# --------------------------------------------------------------------------
# Chi offre: accende la condivisione; gli amici si registrano (nome + password)
# dal loro BunkerPlex e aspettano che il padrone di casa li approvi. Da li' in
# poi le loro richieste portano un gettone e possono SOLO leggere il catalogo e
# guardare i video, e solo sotto /api/share/. Tutto il resto del server resta
# com'era (senza password, pensato per la rete di casa) e NON va esposto:
# per questo c'e' una seconda porta (SHARE_PORT) che risponde soltanto a
# /api/share/ ed e' l'unica da far raggiungere agli amici.
# Chi guarda: il suo server fa da tramite (catalogo, immagini, video), quindi
# TV e browser continuano a parlare solo con il server di casa propria.

SHARE_PORT = int(os.environ.get("SHARE_PORT", "32501") or 0)
FRIEND_BASE = 1_000_000_000      # da qui in su un id e' di un amico: base + posto dell'amico + id suo
FRIEND_SPAN = 50_000_000
FRIEND_MAX = 20                  # 20 amici: gli id restano dentro un intero a 32 bit (app TV)
FRIENDS_DIR = DATA / "friends"   # copia locale di catalogo e immagini: si sfoglia anche se l'amico e' spento
QUALITIES = ("720", "1080", "orig")


async def in_thread(fn, *args):
    return await asyncio.to_thread(fn, *args)     # to_thread porta con se' l'account della richiesta


# ---- Lato di chi offre: account degli amici --------------------------------

share_tokens = {}                # impronta del gettone -> (account, approvato, quando controllato)
login_fails = {}                 # nome -> [errori, fermo fino a]
register_times = []              # registrazioni recenti (freno contro chi ci prova a raffica)
ACCOUNT_NAME = re.compile(r"^[\w .\-]{2,30}$")


def share_on():
    return bool((config.get("share") or {}).get("on"))


# ---- I propri PC: da ogni server dove sei entrato con l'account si arriva agli
# altri tuoi server accesi (rete di casa se ci sei, altrimenti Tailscale), anche
# se non condividi con gli amici. Si spegne per account (self_reach = False).

def self_reach(uid):
    return user_setting(uid, "self_reach") is not False


def self_wanted():
    """C'e' qui almeno un account collegato che vuole raggiungere (ed essere
    raggiunto da) i suoi altri PC: serve la porta 32501 e Tailscale."""
    if not auth_on():
        return False
    con = db(raw=True)
    try:
        ids = [r[0] for r in con.execute("SELECT id FROM users WHERE cloud_id IS NOT NULL AND token IS NOT NULL")]
    finally:
        con.close()
    return any(self_reach(i) for i in ids)


def share_open():
    """La porta 32501 risponde: per gli amici (share_on) o per gli altri PC dell'account."""
    return share_on() or self_wanted()


def token_hash(token):
    return hashlib.sha256(token.encode("utf-8", "replace")).hexdigest()


def password_hash(password, salt):
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)


def new_session(con, account):
    """Un gettone nuovo per l'account (sul disco resta solo la sua impronta)."""
    token = secrets.token_urlsafe(32)
    con.execute("INSERT INTO share_sessions(token, account, created) VALUES(?,?,?)",
                (token_hash(token), account, time.time()))
    # Al massimo 10 dispositivi per account: i piu' vecchi decadono
    con.execute("DELETE FROM share_sessions WHERE account=? AND token NOT IN "
                "(SELECT token FROM share_sessions WHERE account=? ORDER BY created DESC LIMIT 10)",
                (account, account))
    return token


def share_guard(request: Request):
    """Chi puo' usare /api/share/...: solo un amico registrato e approvato (o un
    altro PC dello stesso account)."""
    if not share_open():
        raise HTTPException(403, "La condivisione è spenta su questo server")
    token = request.headers.get("x-share-token", "")
    if not token:
        raise HTTPException(401, "Accesso riservato agli amici registrati")
    key = token_hash(token)
    known = share_tokens.get(key)
    if not known or time.time() - known[2] > 30:
        con = db()
        try:
            r = con.execute("SELECT a.id, a.approved, a.last_seen, a.cloud_from, a.profile, u.cloud_id FROM share_sessions s "
                            "JOIN accounts a ON a.id=s.account LEFT JOIN users u ON u.id=a.profile "
                            "WHERE s.token=?", (key,)).fetchone()
            if r and r["approved"] and time.time() - (r["last_seen"] or 0) > 300:
                con.execute("UPDATE accounts SET last_seen=? WHERE id=?", (time.time(), r["id"]))
                con.commit()
        finally:
            con.close()
        if not r:
            raise HTTPException(401, "Accesso non valido: ripeti l'accesso")
        if len(share_tokens) > 500:
            share_tokens.clear()
        mine = bool(r["cloud_from"]) and r["cloud_from"] == r["cloud_id"]     # un altro PC dello stesso account
        known = share_tokens[key] = (r["id"], bool(r["approved"]), time.time(), mine, r["profile"] if mine else None)
        if r["approved"]:
            friend_nudge(r["id"])
    if not known[1]:
        raise HTTPException(403, "Registrazione in attesa di approvazione")
    if not known[3] and not share_on():
        raise HTTPException(403, "La condivisione è spenta su questo server")
    request.state.share_account = known[0]
    request.state.share_self = known[4]     # un altro PC (o l'app) dello stesso account: il suo profilo qui


def friend_nudge(account):
    """L'amico si e' appena fatto vivo qui: vuol dire che il suo PC e' acceso. Se da
    questa parte risultava spento (o in attesa), si riprova subito invece di aspettare."""
    for f in get_friends():
        if f.get("account") == account and (friend_status.get(f["n"]) or {}).get("online") is not True:
            threading.Thread(target=friend_sync, args=(f,), daemon=True).start()


def _credentials(body):
    name = re.sub(r"\s+", " ", str(body.get("name") or "")).strip()
    password = str(body.get("password") or "")
    if not ACCOUNT_NAME.match(name):
        raise HTTPException(400, "Nome non valido: da 2 a 30 lettere, numeri o spazi")
    if not 8 <= len(password) <= 200:
        raise HTTPException(400, "La password deve avere almeno 8 caratteri")
    return name, password


@app.post("/api/share/register")
async def share_register(request: Request):
    """Un amico chiede di entrare: l'account nasce spento, lo accende il padrone di casa."""
    if not share_on():
        raise HTTPException(403, "La condivisione è spenta su questo server")
    body = await read_json(request)
    name, password = _credentials(body)
    # 'back': chi chiede offre gia' le sue raccolte (indirizzo + gettone per entrare da lui).
    # Si usano solo se e quando il padrone di casa approva la richiesta.
    back = body.get("back") if isinstance(body.get("back"), dict) else {}
    back_url = back_token = back_pin = ""
    if isinstance(back.get("token"), str) and 20 <= len(back["token"]) <= 200:
        try:
            back_url, back_token = friend_address(back.get("url")), back["token"]
            if re.fullmatch(r"[0-9a-f]{64}", str(back.get("pin") or "")):
                back_pin = back["pin"]
        except HTTPException:
            pass
    now = time.time()
    register_times[:] = [t for t in register_times if now - t < 3600]
    if len(register_times) >= 10:
        raise HTTPException(429, "Troppe registrazioni: riprova più tardi")
    register_times.append(now)

    def work():
        con = db()
        try:
            if con.execute("SELECT 1 FROM accounts WHERE name=? COLLATE NOCASE", (name,)).fetchone():
                raise HTTPException(409, "Questo nome è già registrato: scegline un altro, oppure usa «Accedi»")
            if con.execute("SELECT COUNT(*) FROM accounts WHERE approved=0").fetchone()[0] >= 30:
                raise HTTPException(429, "Troppe richieste in attesa: riprova più tardi")
            salt = secrets.token_bytes(16)
            cur = con.execute("INSERT INTO accounts(name, salt, hash, approved, created, back_url, back_token, "
                              "back_pin) VALUES(?,?,?,0,?,?,?,?)",
                              (name, salt, password_hash(password, salt), now, back_url, back_token, back_pin))
            token = new_session(con, cur.lastrowid)
            con.commit()
            return {"ok": True, "token": token, "approved": False, "server": SERVER_NAME}
        finally:
            con.close()

    return await in_thread(work)


@app.post("/api/share/login")
async def share_login(request: Request):
    """Accesso con un account gia' registrato (per esempio da un altro PC)."""
    if not share_on():
        raise HTTPException(403, "La condivisione è spenta su questo server")
    name, password = _credentials(await read_json(request))
    fail = login_fails.get(name.lower())
    if fail and fail[0] >= 5 and time.time() < fail[1]:
        raise HTTPException(429, "Troppi tentativi: riprova tra qualche minuto")

    def work():
        con = db()
        try:
            r = con.execute("SELECT * FROM accounts WHERE name=? COLLATE NOCASE", (name,)).fetchone()
            # Il conto si fa anche se il nome non esiste: stessi tempi, stessa risposta
            good = hmac.compare_digest(password_hash(password, r["salt"] if r else b"0" * 16),
                                       r["hash"] if r else b"")
            if not r or not good:
                if len(login_fails) > 1000:
                    login_fails.clear()
                count = (fail[0] if fail else 0) + 1
                login_fails[name.lower()] = [count, time.time() + min(900, 30 * count)]
                raise HTTPException(401, "Nome o password sbagliati")
            login_fails.pop(name.lower(), None)
            token = new_session(con, r["id"])
            con.commit()
            return {"ok": True, "token": token, "approved": bool(r["approved"]), "server": SERVER_NAME}
        finally:
            con.close()

    return await in_thread(work)


@app.get("/api/share/update")
def share_update_status(request: Request):
    """Aggiornamento del server visto da fuori casa (app o un altro tuo PC):
    solo per il padrone di questo server, con il suo biglietto «da te a te»."""
    return update_json(share_update_owner(request))


@app.post("/api/share/update/check")
def share_update_check(request: Request):
    uid = share_update_owner(request)
    updater.check()
    return update_json(uid)


@app.post("/api/share/update/install")
def share_update_install(request: Request):
    uid = share_update_owner(request)
    if not updater.start_install():
        raise HTTPException(409, "C'è già un aggiornamento in corso")
    return update_json(uid)


def share_update_owner(request):
    share_guard(request)
    uid = getattr(request.state, "share_self", None)
    if uid is None or server_owner() != uid:
        raise HTTPException(403, "Solo il proprietario di questo server può aggiornarlo")
    return uid


@app.post("/api/share/ticket")
async def share_ticket(request: Request):
    """Un amico dell'account entra con un biglietto del servizio account: lo si fa
    controllare li' (vale una volta sola, solo tra amici, solo per questo server) e
    l'amico riceve un gettone come quelli dei vecchi collegamenti, ma vede solo le
    raccolte del profilo di cui e' amico. Lo stesso vale per un altro PC dello
    stesso account (biglietto da te a te)."""
    if not share_open():
        raise HTTPException(403, "La condivisione è spenta su questo server")
    body = await read_json(request)
    ticket, to = str(body.get("ticket") or ""), body.get("to")
    if not re.fullmatch(r"[0-9a-f]{64}", ticket) or not isinstance(to, int):
        raise HTTPException(400, "Richiesta non valida")
    con = db(raw=True)
    try:
        p = con.execute("SELECT id, token FROM users WHERE cloud_id=? AND token IS NOT NULL", (to,)).fetchone()
    finally:
        con.close()
    if not p or not ((friends_shared(p["id"]) and share_on()) or self_reach(p["id"])):
        raise HTTPException(404, "Su questo server quell'account non condivide")
    try:
        res = await asyncio.to_thread(accounts.call, "POST", "/tickets/check",
                                      {"ticket": ticket, "sid": pc_id()}, p["token"])
    except accounts.CloudOffline:
        raise HTTPException(503, "Il server dell'amico non raggiunge il servizio account")
    except accounts.CloudError as ex:
        raise HTTPException(403, ex.detail)
    who = res.get("from") or {}
    if not isinstance(who.get("id"), int):
        raise HTTPException(403, "Biglietto non valido")
    if who["id"] == to:
        if not self_reach(p["id"]):
            raise HTTPException(403, "Questo PC non si fa raggiungere dagli altri tuoi PC")
    elif not (friends_shared(p["id"]) and share_on()):
        raise HTTPException(404, "Su questo server quell'account non condivide")
    return await in_thread(lambda: share_account_token(who, p["id"]))


def share_account_token(who, profile):
    """Ingresso (gettone /api/share) per un account amico, o per un altro PC o app dello
    stesso account, dopo un biglietto o un gettone d'accesso del servizio account."""
    con = db(raw=True)
    try:
        r = con.execute("SELECT id FROM accounts WHERE cloud_from=? AND profile=?", (who["id"], profile)).fetchone()
        if r:
            account = r["id"]
            con.execute("UPDATE accounts SET approved=1 WHERE id=?", (account,))
        else:
            base = "@" + re.sub(r"[^\w.\-]", "", str(who.get("username") or ""))[:24]
            name, i = base, 1
            while con.execute("SELECT 1 FROM accounts WHERE name=? COLLATE NOCASE", (name,)).fetchone():
                i += 1
                name = f"{base} {i}"
            salt = secrets.token_bytes(16)   # nessuna password: si entra solo con i biglietti
            account = con.execute(
                "INSERT INTO accounts(name, salt, hash, approved, created, cloud_from, profile) "
                "VALUES(?,?,?,1,?,?,?)", (name, salt, password_hash(secrets.token_urlsafe(24), salt),
                                          time.time(), who["id"], profile)).lastrowid
        token = new_session(con, account)
        con.commit()
        return {"ok": True, "token": token, "approved": True, "server": pc_name()}
    finally:
        con.close()


@app.post("/api/share/access")
async def share_access(request: Request):
    """Come /api/share/ticket, ma con un gettone d'accesso del servizio account
    (POST /servers/<sid>/access): firmato, si controlla qui (vedi access_claims)."""
    if not share_open():
        raise HTTPException(403, "La condivisione è spenta su questo server")
    body = await read_json(request)
    c = await asyncio.to_thread(access_claims, str(body.get("token") or ""))
    if not c:
        raise HTTPException(403, "Gettone non valido o scaduto")
    con = db(raw=True)
    try:
        p = con.execute("SELECT id FROM users WHERE cloud_id=?", (c["own"],)).fetchone()
    finally:
        con.close()
    if not p:
        raise HTTPException(404, "Su questo server quell'account non c'è")
    who = {"id": int(c["sub"]), "username": str(c.get("name") or "")}
    if who["id"] == c["own"]:
        if not self_reach(p["id"]):
            raise HTTPException(403, "Questo PC non si fa raggiungere dagli altri tuoi PC")
    elif c["role"] != "friend" or not (friends_shared(p["id"]) and share_on()):
        raise HTTPException(404, "Su questo server quell'account non condivide")
    return await in_thread(lambda: share_account_token(who, p["id"]))


@app.post("/api/auth/access")
async def auth_access(request: Request):
    """La PWA centrale: un gettone d'accesso del servizio account (del proprietario)
    in cambio di una sessione di questo server, da mandare come X-BP-Session.
    Cosi' valgono come sempre «Chi guarda?», Esci e il resto."""
    body = await read_json(request)
    c = await asyncio.to_thread(access_claims, str(body.get("token") or ""))
    owner_tok = bool(c) and c["role"] == "owner" and str(c["own"]) == str(c["sub"])
    friend_tok = bool(c) and c["role"] == "friend" and str(c["own"]) != str(c["sub"])
    if not owner_tok and not friend_tok:
        raise HTTPException(403, "Gettone non valido o scaduto")

    def work():
        con = db(raw=True)
        try:
            if friend_tok:
                # Un amico del proprietario (il servizio ha gia' controllato l'amicizia):
                # entra come ospite e vede le raccolte che il proprietario condivide
                owner = owner_row(con)
                if not owner or not friends_shared(owner["id"]):
                    raise HTTPException(403, "Su questo server il proprietario non condivide con gli amici")
                friend = {"id": int(c["sub"]), "username": str(c.get("name") or "Amico")[:40],
                          "admin": False, "must_change": False}
                uid = store_user(con, friend, None, None, guest=True)
                u = con.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
            else:
                u = con.execute("SELECT * FROM users WHERE cloud_id=? AND COALESCE(disabled, 0)=0", (c["own"],)).fetchone()
            if not u:
                raise HTTPException(404, "Su questo server il tuo account non c'è: entra una volta dal server")
            token = open_session(con, u["id"], str(body.get("device") or "PWA"))
            con.execute("UPDATE users SET last_login=? WHERE id=?", (time.time(), u["id"]))
            con.commit()
            return {"ok": True, "session": token, "user": user_json(u)}
        finally:
            con.close()
    return await in_thread(work)


# ---- Gettoni d'accesso del servizio account ----------------------------------------
# Firmati ES256 dal servizio account (POST /servers/<sid>/access), validi poche ore,
# solo per questo server (sid). Si controllano qui con la chiave pubblica (GET /keys)
# se c'e' il pacchetto cryptography; nelle immagini Docker di prima lo fa il servizio
# account (POST /server/verify, con la credenziale del server).

try:
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
except ImportError:
    ec = None

access_keys = {"at": 0.0, "keys": {}}
access_seen = {}                 # impronta del gettone -> (dati, scadenza)


def b64url(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def access_key(kid):
    """La chiave pubblica del servizio account con quel kid (None se non c'e' o se
    manca cryptography). Una chiave nuova si va a prendere al massimo una volta al minuto."""
    if ec is None or not kid:
        return None
    if kid not in access_keys["keys"] and time.time() - access_keys["at"] > 60:
        access_keys["at"] = time.time()
        try:
            res = accounts.call("GET", "/keys", timeout=6)
            keys = {}
            for k in res.get("keys") or []:
                if isinstance(k, dict) and k.get("kty") == "EC" and k.get("crv") == "P-256" and k.get("kid"):
                    x, y = (int.from_bytes(b64url(k[c]), "big") for c in ("x", "y"))
                    keys[str(k["kid"])] = ec.EllipticCurvePublicNumbers(x, y, ec.SECP256R1()).public_key()
            access_keys["keys"] = keys
        except Exception:
            pass
    return access_keys["keys"].get(kid)


def access_claims(token):
    """I dati di un gettone d'accesso valido per questo server, o None."""
    if not token or len(token) > 2000 or token.count(".") != 2:
        return None
    key = token_hash(token)
    hit = access_seen.get(key)
    if hit and hit[1] > time.time():
        return hit[0]
    try:
        h, p, s = token.split(".")
        head, claims, sig = json.loads(b64url(h)), json.loads(b64url(p)), b64url(s)
    except Exception:
        return None
    if not isinstance(head, dict) or not isinstance(claims, dict) or head.get("alg") != "ES256":
        return None
    exp = claims.get("exp")
    if (claims.get("iss") != "bunkerplex" or claims.get("sid") != pc_id() or claims.get("role") not in ("owner", "friend")
            or not isinstance(exp, (int, float)) or exp < time.time() or not str(claims.get("sub") or "").isdigit()):
        return None
    cred = server_cred()
    owner = cred["owner"] if cred else cloud_id_of(server_owner())
    if owner is None or claims.get("own") != owner:
        return None
    pub = access_key(str(head.get("kid") or ""))
    if pub is not None:
        if len(sig) != 64:
            return None
        try:
            pub.verify(encode_dss_signature(int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big")),
                       (h + "." + p).encode(), ec.ECDSA(hashes.SHA256()))
        except InvalidSignature:
            return None
    else:
        if not cred:
            return None
        try:
            res = accounts.call("POST", "/server/verify", {"token": token}, cred["secret"], timeout=8)
        except Exception:
            return None
        if (res.get("claims") or {}).get("jti") != claims.get("jti"):
            return None
    if len(access_seen) > 500:
        access_seen.clear()
    access_seen[key] = (claims, exp)
    return claims


def bearer_of(scope):
    for k, v in scope.get("headers") or ():
        if k == b"authorization":
            m = re.fullmatch(r"Bearer\s+([\w-]+\.[\w-]+\.[\w-]+)", v.decode("latin-1").strip())
            return m.group(1) if m else ""
    return ""


def access_user(token):
    """Il proprietario di questo server entrato con un gettone d'accesso (come una
    sessione: stesse raccolte e permessi), o None."""
    c = access_claims(token)
    if not c or c["role"] != "owner" or str(c["own"]) != str(c["sub"]):
        return None
    return owner_user("cloud_id=?", c["own"])


def owner_user(where, value):
    """Il proprietario di questo server (account attivo) come «utente» della
    richiesta, senza sessione: per i gettoni d'accesso e le chiavi dei video."""
    con = db(raw=True)
    try:
        r = con.execute("SELECT id, name, admin, must_change FROM users WHERE " + where + " AND COALESCE(disabled, 0)=0 "
                        "AND cloud_id IS NOT NULL AND id=(" + OWNER_SQL + ")", (value,)).fetchone()
    finally:
        con.close()
    if not r:
        return None
    return {"id": r["id"], "name": r["name"], "admin": bool(r["admin"]), "linked": True, "guest": False,
            "must_change": bool(r["must_change"]), "libs": visible_libs(r["id"]), "session": "",
            "sid": r["id"], "profile": None, "pname": r["name"], "access": True}


# ---- Chiavi dei video ---------------------------------------------------------------
# <video> e <img> non mandano l'intestazione Authorization: la PWA chiede qui una
# chiave breve (6 ore, firmata con un segreto di questo PC) e la aggiunge agli
# indirizzi dei video e delle immagini come ?bpk=... (solo richieste GET).

MEDIA_TTL = 6 * 3600


def media_secret():
    with config_lock:
        if not config.get("media_secret"):
            config["media_secret"] = secrets.token_hex(32)
            save_config()
        return config["media_secret"]


def media_sign(msg):
    return hmac.new(media_secret().encode(), msg.encode(), hashlib.sha256).hexdigest()[:32]


@app.post("/api/access/media")
def access_media():
    u = CURRENT.get()
    if not u or u.get("friend") or not u.get("linked"):
        raise HTTPException(403, "Chiavi dei video solo per il proprietario e i suoi amici")
    exp = int(time.time()) + MEDIA_TTL
    msg = f"{u['id']}.{exp}"
    return {"key": f"{msg}.{media_sign(msg)}", "exp": exp, "param": "bpk"}


def media_user(key):
    m = re.fullmatch(r"(\d{1,12})\.(\d{10})\.([0-9a-f]{32})", key or "")
    if not m or int(m.group(2)) < time.time():
        return None
    if not hmac.compare_digest(m.group(3), media_sign(f"{m.group(1)}.{m.group(2)}")):
        return None
    return owner_user("id=?", int(m.group(1))) or guest_user(int(m.group(1)))


def guest_user(uid):
    """Un amico del proprietario entrato qui (ospite) come «utente» della richiesta,
    per le chiavi dei video: vede solo le raccolte condivise dal proprietario."""
    con = db(raw=True)
    try:
        r = con.execute("SELECT id, name FROM users WHERE id=? AND COALESCE(guest, 0)=1 "
                        "AND COALESCE(disabled, 0)=0 AND cloud_id IS NOT NULL", (uid,)).fetchone()
    finally:
        con.close()
    if not r:
        return None
    return {"id": r["id"], "name": r["name"], "admin": False, "linked": True, "guest": True,
            "must_change": False, "libs": guest_libs(), "session": "",
            "sid": r["id"], "profile": None, "pname": r["name"], "access": True}


KEY_PATH = re.compile(r"/k/(\d{1,12}\.\d{10}\.[0-9a-f]{32})(/api/.*)")


def media_key_of(scope):
    if scope.get("method") not in ("GET", "HEAD"):
        return ""
    for k, v in urllib.parse.parse_qsl((scope.get("query_string") or b"").decode("latin-1")):
        if k == "bpk":
            return v
    return ""


# ---- HTTPS valido nella rete di casa -------------------------------------------------
# Il servizio account da' a questo server un nome nella rete di casa
# (<ip-con-trattini>.<pc_id>.<dominio>) e un certificato vero *.<pc_id>.<dominio>:
# la chiave resta qui, al servizio va solo la richiesta (CSR). Con quello BunkerPlex
# risponde in https sulla porta SECURE_PORT (tutto BunkerPlex, come la 32500), e la
# PWA ci arriva da una pagina https. Serve il pacchetto cryptography e un servizio
# account con il dominio configurato (vedi cloud/worker.js, «Nomi e certificati»).
# La porta non si apre sul router: solo rete di casa (e Tailscale).

SECURE_PORT = int(os.environ.get("SECURE_PORT", "32443") or 0)
TLS_DIR = DATA / "tls"
secure = {"domain": "", "names": {}, "on": False, "exp": 0.0, "error": "", "ctx": None}
secure_wake = threading.Event()
SECURE_RENEW = 30 * 86400        # si rinnova a 30 giorni dalla scadenza


def secure_files():
    return TLS_DIR / "secure.key", TLS_DIR / "secure.crt"


def secure_name():
    return f"*.{pc_id()}.{secure['domain']}" if secure["domain"] else ""


def secure_cert_info():
    """(scadenza, nomi) del certificato salvato, o None."""
    kf, cf = secure_files()
    if ec is None or not kf.exists() or not cf.exists():
        return None
    from cryptography import x509
    try:
        cert = x509.load_pem_x509_certificate(cf.read_bytes())
        names = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value.get_values_for_type(x509.DNSName)
        return cert.not_valid_after_utc.timestamp(), names
    except Exception:
        return None


def secure_request(cred):
    """Chiede un certificato nuovo al servizio account (ci vuole al massimo qualche minuto)."""
    from cryptography import x509
    from cryptography.hazmat.primitives import serialization
    from cryptography.x509.oid import NameOID
    name = secure_name()
    key = ec.generate_private_key(ec.SECP256R1())
    csr = (x509.CertificateSigningRequestBuilder()
           .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)]))
           .add_extension(x509.SubjectAlternativeName([x509.DNSName(name)]), critical=False)
           .sign(key, hashes.SHA256()))
    der = base64.urlsafe_b64encode(csr.public_bytes(serialization.Encoding.DER)).rstrip(b"=").decode()
    res = accounts.call("POST", "/server/cert/start", {"csr": der}, cred["secret"])
    deadline = time.time() + 600
    while res.get("status") != "valid":
        if res.get("status") == "invalid":
            raise RuntimeError(res.get("error") or "certificato rifiutato")
        if time.time() > deadline:
            raise RuntimeError("il certificato non è arrivato in tempo")
        time.sleep(min(30, max(3, int(res.get("retry") or 10))))
        res = accounts.call("POST", "/server/cert/poll", {}, cred["secret"])
    pem = str(res.get("cert") or "")
    if "BEGIN CERTIFICATE" not in pem:
        raise RuntimeError("certificato non valido")
    TLS_DIR.mkdir(parents=True, exist_ok=True)
    kf, cf = secure_files()
    tmp = kf.with_suffix(".tmp")
    tmp.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                      serialization.NoEncryption()))
    os.replace(tmp, kf)
    tmp = cf.with_suffix(".tmp")
    tmp.write_text(pem, "ascii")
    os.replace(tmp, cf)


def secure_check():
    """Certificato presente, giusto e non in scadenza; poi la porta https accesa."""
    if not SECURE_PORT or ec is None:
        return
    cred = server_cred()
    if not cred or not secure["domain"]:
        return
    info = secure_cert_info()
    if not info or secure_name() not in info[1] or info[0] - time.time() < SECURE_RENEW:
        secure_request(cred)
        info = secure_cert_info()
        if not info:
            raise RuntimeError("certificato salvato ma illeggibile")
    kf, cf = secure_files()
    ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    ctx.load_cert_chain(str(cf), str(kf))
    secure.update(ctx=ctx, exp=info[0], error="")
    if not secure["on"]:
        secure["on"] = True
        threading.Thread(target=secure_listener, daemon=True).start()
        sync_soon()                  # la porta https va detta subito al servizio account


def secure_listener():
    try:
        import uvicorn
        kf, cf = secure_files()
        cfg = uvicorn.Config(app, host="0.0.0.0", port=SECURE_PORT, lifespan="off", log_level="warning",
                             ssl_certfile=str(cf), ssl_keyfile=str(kf))
        cfg.load()

        def sni(sslobj, server_name, ctx):
            if secure["ctx"] is not None:     # certificato rinnovato: si usa quello nuovo senza riaccendere
                sslobj.context = secure["ctx"]
        cfg.ssl.sni_callback = sni
        uvicorn.Server(cfg).run()
    except BaseException as ex:
        print("Porta https non disponibile:", SECURE_PORT, ex, flush=True)
    secure.update(on=False, error=f"porta {SECURE_PORT} non disponibile")


def secure_loop():
    while True:
        try:
            secure_check()
        except Exception as ex:
            secure["error"] = str(ex)[:200]
            print("Certificato https:", secure["error"], flush=True)
        secure_wake.wait(6 * 3600 if secure["on"] else 1800)
        secure_wake.clear()


# ---- Chiamate dalla PWA (CORS) ---------------------------------------------------
# La PWA sta su un altro indirizzo (quello del servizio account, o quelli in
# BUNKERPLEX_PWA_ORIGINS separati da virgole): il browser le lascia leggere le
# risposte di questo server solo con queste intestazioni. Niente cookie tra siti
# diversi: la PWA entra con il gettone (Authorization) e la chiave dei video.

cors_cache = {"at": 0.0, "origins": frozenset()}


def cors_origins():
    if time.time() - cors_cache["at"] > 60:
        out = set()
        base = accounts.cloud_url()
        if base:
            u = urllib.parse.urlsplit(base)
            out.add(f"{u.scheme}://{u.netloc}")
        for o in os.environ.get("BUNKERPLEX_PWA_ORIGINS", "").split(","):
            if o.strip():
                out.add(o.strip().rstrip("/"))
        cors_cache.update(at=time.time(), origins=frozenset(out))
    return cors_cache["origins"]


def header_of(scope, name):
    for k, v in scope.get("headers") or ():
        if k == name:
            return v.decode("latin-1").strip()
    return ""


class Cors:
    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        origin = header_of(scope, b"origin") if scope["type"] == "http" else ""
        if not origin or origin not in cors_origins():
            await self.inner(scope, receive, send)
            return
        extra = [(b"access-control-allow-origin", origin.encode("latin-1")), (b"vary", b"Origin")]
        if scope["method"] == "OPTIONS" and header_of(scope, b"access-control-request-method"):
            headers = extra + [(b"access-control-allow-methods", b"GET, POST, PUT, PATCH, DELETE, OPTIONS"),
                               (b"access-control-allow-headers",
                                b"Authorization, Content-Type, X-Share-Token, X-BP-Session, Range"),
                               (b"access-control-max-age", b"600"), (b"content-length", b"0")]
            if header_of(scope, b"access-control-request-private-network") == "true":
                headers.append((b"access-control-allow-private-network", b"true"))
            await send({"type": "http.response.start", "status": 204, "headers": headers})
            await send({"type": "http.response.body", "body": b""})
            return

        async def send_cors(m):
            if m["type"] == "http.response.start":
                m = dict(m)
                m["headers"] = list(m.get("headers") or []) + extra + [
                    (b"access-control-expose-headers", b"Content-Range, Content-Length, Accept-Ranges")]
            await send(m)
        await self.inner(scope, receive, send_cors)


app.add_middleware(Cors)


@app.get("/api/sharing")
def sharing_status():
    """Per Impostazioni (rete di casa): stato della condivisione e amici registrati."""
    manager_only()
    con = db()
    try:
        accounts = [{"id": r["id"], "name": r["name"], "approved": bool(r["approved"]),
                     "created": r["created"], "last_seen": r["last_seen"] or 0,
                     "back_url": r["back_url"] or "", "via": "account" if r["cloud_from"] else ""}
                    for r in con.execute("SELECT * FROM accounts ORDER BY approved, name COLLATE NOCASE")]
    finally:
        con.close()
    sh = config.get("share") or {}
    return {"on": share_on(), "port": SHARE_PORT, "accounts": accounts,
            "address": my_address(), "manual": bool(sh.get("manual") and sh.get("address")),
            "tls": share_tls["on"], "auto_port": sh.get("auto_port", True) is not False,
            "tailscale": tailscale_ip(), "lan": lan["ip"],
            "portmap": {k: portmap[k] for k in ("ok", "method", "ip", "port", "public", "error", "at")},
            "tailnet": {"on": tailnet_on(), "ip": tailnet["ip"], "error": tailnet["error"],
                        "running": bool(tailnet_proc["p"]), "supported": tailnet["supported"],
                        "limit": tailnet["limit"]}}


@app.post("/api/sharing")
async def sharing_set(request: Request):
    manager_only()
    body = await read_json(request)
    u = CURRENT.get()
    if body.get("on") and auth_on() and not (u and u["linked"]):
        raise HTTPException(403, "Per condividere con gli amici entra con un account (Impostazioni → Account)")
    address = friend_address(body["address"]) if body.get("address") else None
    with config_lock:
        sh = config.setdefault("share", {})
        if "on" in body:
            sh["on"] = bool(body["on"])
        if "auto_port" in body:
            sh["auto_port"] = bool(body["auto_port"])
        if address:
            sh.update(address=address, manual=True)
        elif "address" in body:          # campo svuotato: si torna all'indirizzo trovato da solo
            sh["manual"] = False
        save_config()
    portmap_wake.set()                   # apre o richiude subito la porta sul router
    tailnet_wake.set()
    return {"ok": True, "on": share_on()}


@app.post("/api/sharing/accounts/{account}")
async def sharing_approve(account: int, request: Request):
    """Accetta (o sospende) la richiesta di un amico. Accettando, lo scambio e'
    reciproco: se lui ha offerto le sue raccolte, compaiono qui da sole."""
    manager_only()
    body = await read_json(request)
    con = db()
    try:
        done = con.execute("UPDATE accounts SET approved=? WHERE id=?",
                           (1 if body.get("approved") else 0, account))
        con.commit()
        r = con.execute("SELECT * FROM accounts WHERE id=?", (account,)).fetchone()
    finally:
        con.close()
    share_tokens.clear()
    if not done.rowcount:
        raise HTTPException(404, "Account non trovato")
    linked = False
    if body.get("approved") and r["back_url"] and r["back_token"]:
        friends = get_friends()
        if not any(f["url"] == r["back_url"] for f in friends) and len(friends) < FRIEND_MAX:
            friend_store(r["name"], r["back_url"], "", r["back_token"], account, r["back_pin"])
            linked = True
    return {"ok": True, "linked": linked}


@app.delete("/api/sharing/accounts/{account}")
def sharing_remove(account: int):
    """Toglie un amico: non entra piu' qui, e le sue raccolte spariscono da questo server."""
    manager_only()
    con = db()
    try:
        r = con.execute("SELECT back_url FROM accounts WHERE id=?", (account,)).fetchone()
    finally:
        con.close()
    account_drop(account)
    for f in get_friends():
        if f.get("account") == account or (r and r["back_url"] and f["url"] == r["back_url"]):
            friend_drop(f["n"])
    return {"ok": True}


def account_drop(account):
    con = db()
    try:
        con.execute("DELETE FROM share_sessions WHERE account=?", (account,))
        con.execute("DELETE FROM accounts WHERE id=?", (account,))
        con.commit()
    finally:
        con.close()
    share_tokens.clear()


def account_for_friend(label):
    """L'account con cui l'amico a cui si manda una richiesta potra' entrare qui
    (gia' approvato: la richiesta parte da noi). Restituisce (id, gettone)."""
    con = db()
    try:
        base = re.sub(r"[^\w .\-]", " ", label).strip()[:24] or "Amico"
        name, i = base, 1
        while len(name) < 2 or con.execute("SELECT 1 FROM accounts WHERE name=? COLLATE NOCASE", (name,)).fetchone():
            i += 1
            name = f"{base} {i}"
        salt = secrets.token_bytes(16)       # password a caso: si entra solo con il gettone
        cur = con.execute("INSERT INTO accounts(name, salt, hash, approved, created) VALUES(?,?,?,1,?)",
                          (name, salt, password_hash(secrets.token_urlsafe(24), salt), time.time()))
        token = new_session(con, cur.lastrowid)
        con.commit()
        return cur.lastrowid, token
    finally:
        con.close()


# ---- Lato di chi offre: cosa puo' leggere un amico -------------------------
# Solo lettura del catalogo e video. Niente impostazioni, cartelle, scansioni,
# aggiornamenti, "visto", lista: quelle strade qui sotto non esistono.

share = APIRouter(prefix="/api/share", dependencies=[Depends(share_guard)])


def _own(i):
    """Un amico vede solo i titoli di questo server, non quelli degli amici di questo server."""
    if i < 0 or i >= FRIEND_BASE:
        raise HTTPException(404, "Elemento non trovato")
    return i


def scrub(x):
    """Toglie dal catalogo cio' che riguarda chi abita qui (visto, ripresa, lista)."""
    if isinstance(x, list):
        for v in x:
            scrub(v)
    elif isinstance(x, dict):
        for k in ("position", "start"):
            if k in x:
                x[k] = 0
        for k in ("watched", "fav"):
            if k in x:
                x[k] = False
        for k in ("where", "disk", "unplugged"):   # i percorsi dei dischi restano a casa
            x.pop(k, None)
        if x.get("kind") == "show" and "episodes" in x:
            x["unwatched"] = x["episodes"]
        elif x.get("kind") == "collection" and "count" in x:
            x["unwatched"] = x["count"]
        for v in x.values():
            scrub(v)
    return x


@share.get("/info")
def share_info():
    return {"app": "bunkerplex", "name": SERVER_NAME, "version": VERSION, "share": 1}


@share.get("/libraries")
def share_libraries():
    """Le raccolte, senza i percorsi delle cartelle."""
    return [{"id": l["id"], "name": l["name"], "movies": l["movies"], "shows": l["shows"], "sync": l["sync"]}
            for l in libraries_list()]


@share.get("/libraries/{lib_id}/items")
def share_library_items(lib_id: int):
    return scrub(all_library_items(_own(lib_id)))


@share.get("/shows/{show_id}")
def share_show(show_id: int):
    return scrub(show_detail(_own(show_id)))


@share.get("/items/{item_id}")
def share_item(item_id: int):
    return scrub(item_detail(_own(item_id)))


@share.get("/collections/{coll_id}")
def share_collection(coll_id: int):
    return scrub(collection_detail(_own(coll_id)))


@share.get("/play/{item_id}")
def share_play(item_id: int):
    p = play(_own(item_id))
    if isinstance(p, Response):   # file su un disco scollegato: agli amici niente percorsi
        raise HTTPException(404, "Questo titolo adesso non è disponibile: è su un disco non collegato")
    return scrub(p)


@share.get("/tracks/{item_id}")
def share_tracks(item_id: int):
    return tracks(_own(item_id))


@share.get("/image/{name}")
def share_image(name: str):
    return image(name)


@share.get("/thumb/{item_id}")
def share_thumb(item_id: int):
    return thumb(_own(item_id))


@share.get("/subs/{item_id}/{index}")
def share_subs(item_id: int, index: int, offset: float = 0):
    return subs(_own(item_id), index, offset)


@share.api_route("/stream/{item_id}", methods=["GET", "HEAD"])
def share_stream(item_id: int, request: Request):
    return stream(_own(item_id), request)


@share.get("/transcode/{item_id}")
def share_transcode(item_id: int, start: float = 0, vcopy: int = 0, audio: int = 0, height: int = 0,
                    aout: str = ""):
    """'height' (720 o 1080): conversione leggera, a misura della linea di casa."""
    return run_transcode(_own(item_id), start, vcopy, audio, height if height in HEIGHTS_OK else 0,
                         aout if aout in AOUTS else "")


@share.get("/hls/{item_id}/{tok}/{name}")
async def share_hls(item_id: int, tok: str, name: str, start: float = 0, vcopy: int = 0, audio: int = 0,
                    height: int = 0):
    """La conversione di /api/share/transcode in HLS, per il player dell'iPhone
    (AVPlayer vuole HLS o un file intero, non un MP4 a flusso)."""
    item_id = _own(item_id)
    height = height if height in HEIGHTS_OK else 0
    return await hls_serve(item_id, tok, name, start, vcopy, audio, shared=True,
                           make_src=lambda: run_transcode(item_id, start, vcopy, audio, height, "aac"))


@share.post("/hello")
async def share_hello(request: Request):
    """L'amico avvisa che il suo indirizzo e' cambiato (capita con le linee di
    casa). Vale solo per il collegamento di ritorno verso di lui: e' l'unica cosa
    che un amico puo' scrivere qui."""
    body = await read_json(request)
    url = friend_address(body.get("url"))
    account = request.state.share_account
    changed = None
    with config_lock:
        for f in config.get("friends") or []:
            if f.get("account") == account and f["url"] != url:
                f["url"] = url
                changed = f["n"]
                save_config()
    if changed:
        friend_status.pop(changed, None)
    return {"ok": True}


app.include_router(share)


class ShareOnly:
    """La porta per gli amici: lascia passare soltanto /api/share/..."""

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return
        if scope["path"].startswith("/api/share/"):
            await self.inner(scope, receive, send)
            return
        body = json.dumps({"detail": "Non disponibile"}).encode()
        await send({"type": "http.response.start", "status": 404,
                    "headers": [(b"content-type", b"application/json"),
                                (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})


def share_listener():
    try:
        import uvicorn
        cert = share_cert()
        tls = {"ssl_certfile": cert[0], "ssl_keyfile": cert[1]} if cert else {}
        uvicorn.run(ShareOnly(app), host="0.0.0.0", port=SHARE_PORT, lifespan="off",
                    log_level="warning", **tls)
    except BaseException as ex:      # porta occupata: il resto del server va avanti lo stesso
        print("Porta per gli amici non disponibile:", SHARE_PORT, ex, flush=True)


# ---- Da ovunque: BunkerPlex su un indirizzo https pubblico (Tailscale Funnel) ----
# Il proprietario lo accende in Impostazioni → App: il Tailscale del contenitore
# pubblica https://bunkerplex-<id>.<rete>.ts.net, e quell'indirizzo porta a una
# porta interna (PUBLIC_PORT, solo 127.0.0.1) con tutto BunkerPlex. Il login resta
# obbligatorio come in casa (AuthGate); serve per la web app di iPhone e iPad (e
# per qualsiasi browser) fuori casa, senza installare niente.
# La rete di BunkerPlex deve permetterlo: nella policy di Tailscale l'attributo
# "funnel" per tag:bunkerplex e i certificati HTTPS accesi (pagina DNS).
PUBLIC_PORT = int(os.environ.get("PUBLIC_PORT", "32502") or 0)
public = {"on": False, "url": "", "error": "", "at": 0.0}


def public_wanted():
    return bool(PUBLIC_PORT) and bool((config.get("public") or {}).get("on"))


def public_listener():
    if not PUBLIC_PORT:
        return
    try:
        import uvicorn
        uvicorn.run(app, host="127.0.0.1", port=PUBLIC_PORT, lifespan="off", log_level="warning",
                    proxy_headers=False)
    except BaseException as ex:
        print("Porta per l'indirizzo pubblico non disponibile:", PUBLIC_PORT, ex, flush=True)


def public_sync():
    """Accende o spegne il Funnel come chiesto (dentro tailnet_loop, Tailscale acceso)."""
    want = public_wanted()
    try:
        st = json.loads(tailnet_cli("funnel", "status", "--json", timeout=15).stdout or "{}")
    except (ValueError, OSError, subprocess.SubprocessError):
        st = {}
    active = any(st.get("AllowFunnel") or {})
    if want and not active:
        out = tailnet_cli("funnel", "--bg", "--yes", f"http://127.0.0.1:{PUBLIC_PORT}", timeout=60)
        if out.returncode:
            msg = (out.stderr or out.stdout or "").strip()
            if "funnel" in msg.lower() and ("not enabled" in msg.lower() or "nodeattr" in msg.lower()
                                             or "login.tailscale.com" in msg):
                msg = "La rete di BunkerPlex non permette ancora l'indirizzo pubblico (Funnel): va acceso nella policy di Tailscale"
            elif "https" in msg.lower() and "cert" in msg.lower():
                msg = "Nella rete di BunkerPlex mancano i certificati HTTPS (Tailscale → DNS → HTTPS Certificates)"
            public.update(on=False, url="", error=msg[:300], at=time.time())
            return
        active = True
    elif not want and active:
        tailnet_cli("serve", "reset", timeout=30)
        active = False
    url = ""
    if active:
        try:
            me = json.loads(tailnet_cli("status", "--json", "--peers=false", timeout=15).stdout or "{}")
            name = str((me.get("Self") or {}).get("DNSName") or "").rstrip(".")
            if re.fullmatch(r"[a-z0-9-]+(\.[a-z0-9-]+)+", name):
                url = "https://" + name
        except (ValueError, OSError, subprocess.SubprocessError):
            pass
    public.update(on=active, url=url, error="" if active or not want else public["error"], at=time.time())


@app.get("/api/public")
def public_state():
    url = public["url"] if public["on"] else ""
    return {"wanted": public_wanted(), "on": bool(url), "url": url, "error": public["error"],
            "svg": qr_svg(url) if url else "", "available": bool(PUBLIC_PORT) and auth_on(),
            "tailnet": tailnet_on()}


@app.post("/api/public")
async def public_set(request: Request):
    u = manager_only()
    body = await read_json(request)
    on = bool(body.get("on"))
    if on and not (u and u.get("linked")):
        raise HTTPException(403, "Per l'indirizzo pubblico entra con un account (Impostazioni → Account)")
    with config_lock:
        config.setdefault("public", {})["on"] = on
        save_config()
    public.update(error="")
    tailnet_wake.set()
    return {"ok": True, "wanted": on}


# ---- Lato di chi guarda: collegamento con il server dell'amico -------------

friend_status = {}               # posto dell'amico -> {online, tried, error, synced}
friend_locks = {}
fc_memory = {}                   # file della copia locale -> (data di modifica, contenuto)


class FriendDown(Exception):
    def __init__(self, message, code=0):
        super().__init__(message)
        self.code = code


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):     # il gettone non segue mai un reindirizzamento
        return None


friend_opener = urllib.request.build_opener(_NoRedirect)


# ---- Porta per gli amici: cifratura e apertura sul router ------------------
# Perche' un amico arrivi da Internet senza installare nulla servono due cose,
# e il server le fa da solo:
# 1. la porta per gli amici parla HTTPS con un certificato creato qui; ogni
#    amico ne ricorda l'impronta al primo collegamento e da li' in poi non
#    accetta altro (password, gettone e video non viaggiano in chiaro);
# 2. il server chiede al router di casa di aprire quella sola porta (NAT-PMP,
#    poi UPnP), come fanno Plex e le console. Se il router non lo permette o
#    l'operatore non da' un indirizzo pubblico, lo dice e resta la strada di
#    Tailscale. Niente servizi esterni: si parla solo con il proprio router.

SHARE_CERT = DATA / "share_cert.pem"
SHARE_KEY = DATA / "share_key.pem"
NATPMP_PORT = int(os.environ.get("NATPMP_PORT", "5351"))
SSDP_PORT = int(os.environ.get("SSDP_PORT", "1900"))
IN_DOCKER = Path("/.dockerenv").exists()
# Gli indirizzi che i router di casa usano quasi sempre
ROUTERS = ("192.168.1.1", "192.168.0.1", "192.168.1.254", "192.168.178.1", "192.168.100.1",
           "192.168.2.1", "192.168.8.1", "192.168.50.1", "192.168.68.1", "192.168.88.1",
           "192.168.10.1", "192.168.3.1", "192.168.0.254", "192.168.4.1", "192.168.5.1",
           "192.168.11.1", "192.168.31.1", "192.168.123.254", "10.0.0.1", "10.0.0.138",
           "10.0.1.1", "10.1.1.1", "172.16.0.1")
share_tls = {"on": False, "pin": ""}
lan = {"ip": ""}                 # l'indirizzo di questo PC in casa (lo si impara da chi apre l'app)
portmap = {"ok": False, "method": "", "router": "", "ip": "", "port": 0, "public": False,
           "error": "", "at": 0.0}
portmap_wake = threading.Event()
LAN_NET = re.compile(r"^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)\d")
# Gli indirizzi di Tailscale (100.64.0.0/10)
TS_NET = re.compile(r"^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$")
TLS_ANY = ssl.create_default_context()
TLS_ANY.check_hostname = False
TLS_ANY.verify_mode = ssl.CERT_NONE      # non ci si fida di un ente: si confronta l'impronta ricordata


def share_cert():
    """Il certificato della porta per gli amici (creato una volta, resta con il
    catalogo). None se non si riesce a crearlo: la porta resta in chiaro."""
    try:
        if not (SHARE_CERT.is_file() and SHARE_KEY.is_file()):
            subprocess.run(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt",
                            "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", str(SHARE_KEY),
                            "-out", str(SHARE_CERT), "-days", "7300", "-subj", "/CN=BunkerPlex"],
                           capture_output=True, timeout=60, check=True)
        der = ssl.PEM_cert_to_DER_cert(SHARE_CERT.read_text("ascii"))
        share_tls.update(on=True, pin=hashlib.sha256(der).hexdigest())
        return str(SHARE_CERT), str(SHARE_KEY)
    except Exception as ex:
        print("Certificato per gli amici non creato (la porta resta non cifrata):", repr(ex), flush=True)
        return None


def learn_lan(scope):
    """Chi apre BunkerPlex da casa scrive l'indirizzo di questo PC (es. 192.168.1.50):
    dentro Docker e' l'unico modo per conoscerlo, e serve per parlare con il router."""
    for k, v in scope.get("headers") or ():
        if k == b"host":
            host = v.decode("latin-1").rsplit(":", 1)[0]
            if LAN_NET.match(host) and re.fullmatch(r"[\d.]{7,15}", host) and host != lan["ip"]:
                lan["ip"] = host
                portmap_wake.set()
            elif TS_NET.match(host) and host not in (tailscale_ip(), tailnet["ip"]):
                learn_tailscale(host)
            return


def tailscale_ip():
    """L'indirizzo Tailscale di questo PC: lo passa "Installa BunkerPlex" oppure
    lo si impara da chi apre l'app passando da Tailscale. Vuoto = niente Tailscale."""
    env = os.environ.get("BUNKERPLEX_TAILSCALE_IP", "").strip()
    if TS_NET.match(env):
        return env
    return (config.get("share") or {}).get("tailscale", "")


def learn_tailscale(ip):
    with config_lock:
        config.setdefault("share", {})["tailscale"] = ip
        save_config()
    portmap_wake.set()                   # con Tailscale la porta sul router si richiude
    for f in get_friends():              # indirizzo nuovo: lo si dice subito agli amici
        threading.Thread(target=friend_sync, args=(f,), daemon=True).start()


def auto_port():
    """Si apre la porta sul router solo se non c'e' Tailscale: con Tailscale gli
    amici entrano da li' e l'indirizzo pubblico di casa non si da' a nessuno."""
    return (config.get("share") or {}).get("auto_port", True) is not False and not tailscale_ip()


def my_address():
    """L'indirizzo con cui un amico raggiunge questo server: quello scritto a
    mano, poi quello del Tailscale dentro BunkerPlex, poi quello di un Tailscale
    installato sul computer, poi quello pubblico trovato aprendo la porta sul router."""
    sh = config.get("share") or {}
    if sh.get("manual") and sh.get("address"):
        return sh["address"]
    if tailnet_on() and SHARE_PORT:
        return f"{'https' if share_tls['on'] else 'http'}://{tailnet['ip']}:{SHARE_PORT}"
    if tailscale_ip() and SHARE_PORT:
        return f"{'https' if share_tls['on'] else 'http'}://{tailscale_ip()}:{SHARE_PORT}"
    if portmap["ok"] and portmap["public"]:
        return f"{'https' if share_tls['on'] else 'http'}://{portmap['ip']}:{portmap['port']}"
    return sh.get("address") or ""


def router_candidates():
    fixed = os.environ.get("ROUTER_IP", "")
    if fixed:                    # router indicato a mano: non si cerca altrove
        return [fixed]
    out = [(config.get("share") or {}).get("router", "")]
    if lan["ip"]:
        net = lan["ip"].rsplit(".", 1)[0]
        out += [net + ".1", net + ".254"]
    out += ROUTERS
    seen = []
    for r in out:
        if r and r not in seen:
            seen.append(r)
    return seen


def natpmp_scan(routers):
    """Chi tra i possibili router risponde a NAT-PMP: [(router, indirizzo pubblico)]."""
    found = []
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.settimeout(0.3)
        for attempt in range(2):
            for r in routers:
                try:
                    s.sendto(b"\x00\x00", (r, NATPMP_PORT))
                except OSError:
                    pass
            end = time.time() + 0.7
            while time.time() < end:
                try:
                    data, addr = s.recvfrom(64)
                except socket.timeout:
                    continue
                except OSError:      # su Windows: "porta irraggiungibile" di un indirizzo vuoto
                    continue
                if len(data) >= 12 and data[1] == 128 and data[2:4] == b"\x00\x00" \
                        and addr[0] in routers and addr[0] not in [f[0] for f in found]:
                    found.append((addr[0], socket.inet_ntoa(data[8:12])))
            if found:
                break
    finally:
        s.close()
    return found


def natpmp_map(router, port, lifetime):
    """Chiede al router di girare la porta 'port' a questo PC. Restituisce la
    porta pubblica ottenuta, None se rifiuta. lifetime=0 la richiude."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.settimeout(0.8)
        ask = struct.pack("!BBHHHI", 0, 2, 0, port, port if lifetime else 0, lifetime)
        for attempt in range(3):
            try:
                s.sendto(ask, (router, NATPMP_PORT))
                data, _ = s.recvfrom(64)
            except OSError:
                continue
            if len(data) >= 16 and data[1] == 130:
                _, _, result, _, _, external, _ = struct.unpack("!BBHIHHI", data[:16])
                return (external or port) if result == 0 else None
    finally:
        s.close()
    return None


LOCAL_HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)
IGD_SERVICES = ("WANIPConnection", "WANPPPConnection")


def ssdp_find(routers):
    """Cerca il router che parla UPnP: prima con la ricerca normale (funziona
    quando il server gira direttamente sul PC), poi chiedendo uno per uno agli
    indirizzi probabili (dentro Docker la ricerca normale non esce).
    Restituisce gli indirizzi delle descrizioni trovate."""
    found = []
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.settimeout(0.3)
        for st in ("urn:schemas-upnp-org:device:InternetGatewayDevice:1",
                   "urn:schemas-upnp-org:device:InternetGatewayDevice:2", "upnp:rootdevice"):
            msg = ("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\n"
                   f"MX: 1\r\nST: {st}\r\n\r\n").encode()
            for target in ([] if os.environ.get("ROUTER_IP") else ["239.255.255.250"]) + list(routers):
                try:
                    s.sendto(msg, (target, 1900 if target.startswith("239.") else SSDP_PORT))
                except OSError:
                    pass
        end = time.time() + 1.6
        while time.time() < end:
            try:
                data, addr = s.recvfrom(2048)
            except OSError:
                continue
            m = re.search(rb"(?im)^location:\s*(http://\S+)", data)
            if m:
                loc = m.group(1).decode("latin-1")
                host = urllib.parse.urlsplit(loc).hostname or ""
                # La descrizione deve stare sul dispositivo che ha risposto, in casa
                if host == addr[0] and (LAN_NET.match(host) or host in routers) and loc not in found:
                    found.append(loc)
    finally:
        s.close()
    return found


def upnp_service(location):
    """Dalla descrizione del router: (indirizzo dei comandi, tipo di servizio)."""
    with LOCAL_HTTP.open(location, timeout=4) as r:
        xml = r.read(1 << 20)
    import xml.etree.ElementTree as ET
    root = ET.fromstring(xml)
    base = location
    for el in root.iter():
        tag = el.tag.rsplit("}", 1)[-1]
        if tag == "URLBase" and (el.text or "").strip().startswith("http://"):
            base = el.text.strip()
        if tag == "service":
            fields = {c.tag.rsplit("}", 1)[-1]: (c.text or "").strip() for c in el}
            if any(name in fields.get("serviceType", "") for name in IGD_SERVICES) and fields.get("controlURL"):
                control = urllib.parse.urljoin(base, fields["controlURL"])
                if urllib.parse.urlsplit(control).hostname == urllib.parse.urlsplit(location).hostname:
                    return control, fields["serviceType"]
    return None


def upnp_call(control, service, action, args):
    body = ('<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
            's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>'
            f'<u:{action} xmlns:u="{service}">' +
            "".join(f"<{k}>{v}</{k}>" for k, v in args) + f"</u:{action}></s:Body></s:Envelope>").encode()
    req = urllib.request.Request(control, data=body, method="POST", headers={
        "Content-Type": 'text/xml; charset="utf-8"', "SOAPAction": f'"{service}#{action}"'})
    try:
        with LOCAL_HTTP.open(req, timeout=5) as r:
            return r.read(1 << 16).decode("utf-8", "replace")
    except urllib.error.HTTPError as ex:
        text = ex.read(1 << 16).decode("utf-8", "replace")
        ex.close()
        m = re.search(r"<errorCode>(\d+)</errorCode>", text)
        raise OSError(f"UPnP {m.group(1) if m else ex.code}")


def upnp_map(location, port):
    """Apre la porta con UPnP. Restituisce (comandi, servizio, indirizzo pubblico)."""
    found = upnp_service(location)
    if not found:
        raise OSError("il router non offre l'apertura delle porte")
    control, service = found
    client = lan["ip"]
    if not client and not IN_DOCKER:     # server direttamente sul PC: l'indirizzo e' quello della scheda di rete
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect((urllib.parse.urlsplit(control).hostname, 9))
            client = s.getsockname()[0]
        finally:
            s.close()
    if not client:
        raise OSError("apri una volta BunkerPlex dalla TV o dal telefono: serve per conoscere l'indirizzo di questo PC")
    args = [("NewRemoteHost", ""), ("NewExternalPort", port), ("NewProtocol", "TCP"),
            ("NewInternalPort", port), ("NewInternalClient", client), ("NewEnabled", 1),
            ("NewPortMappingDescription", "BunkerPlex amici"), ("NewLeaseDuration", 7200)]
    try:
        upnp_call(control, service, "AddPortMapping", args)
    except OSError as ex:
        if "725" not in str(ex):         # 725: il router accetta solo aperture senza scadenza
            raise
        upnp_call(control, service, "AddPortMapping", args[:-1] + [("NewLeaseDuration", 0)])
    text = upnp_call(control, service, "GetExternalIPAddress", [])
    m = re.search(r"<NewExternalIPAddress>\s*([\d.]+)\s*</NewExternalIPAddress>", text)
    return control, service, m.group(1) if m else ""


def is_public(ip):
    try:
        return ipaddress.ip_address(ip).is_global
    except ValueError:
        return False


def portmap_open():
    """Apre (o rinnova) la porta per gli amici sul router di casa."""
    port = SHARE_PORT
    before = my_address()
    routers = router_candidates()
    done, error = None, "il router non risponde: attiva UPnP (o NAT-PMP) nelle sue impostazioni, oppure usa Tailscale"
    for router, ip in natpmp_scan(routers):
        external = natpmp_map(router, port, 7200)
        if external:
            done = {"method": "NAT-PMP", "router": router, "ip": ip, "port": external}
            break
    if not done:
        for location in ssdp_find(routers):
            try:
                control, service, ip = upnp_map(location, port)
                done = {"method": "UPnP", "router": urllib.parse.urlsplit(location).hostname, "ip": ip,
                        "port": port, "control": control, "service": service}
                break
            except Exception as ex:
                error = f"il router ha rifiutato ({ex})"
    if not done:
        portmap.update(ok=False, public=False, error=error, at=time.time())
        return
    public = is_public(done["ip"])
    portmap.update(done, ok=True, public=public, at=time.time(),
                   error="" if public else "il router ha aperto la porta, ma il tuo operatore non ti dà un "
                                           "indirizzo pubblico (o c'è un secondo router davanti): da fuori non ci si arriva. Usa Tailscale")
    with config_lock:
        sh = config.setdefault("share", {})
        if sh.get("router") != done["router"]:
            sh["router"] = done["router"]
            save_config()
    if my_address() != before:
        # Indirizzo nuovo (per esempio l'operatore l'ha cambiato): lo si dice subito agli amici
        for f in get_friends():
            threading.Thread(target=friend_sync, args=(f,), daemon=True).start()


def portmap_close():
    try:
        if portmap["method"] == "NAT-PMP":
            natpmp_map(portmap["router"], SHARE_PORT, 0)
        elif portmap["method"] == "UPnP":
            upnp_call(portmap["control"], portmap["service"], "DeletePortMapping",
                      [("NewRemoteHost", ""), ("NewExternalPort", portmap["port"]), ("NewProtocol", "TCP")])
    except Exception:
        pass
    portmap.update(ok=False, public=False, method="", error="", at=time.time())


def portmap_loop():
    """Tiene aperta la porta finche' la condivisione e' accesa: rinnovo ogni 25
    minuti, nuovo tentativo ogni 5 se il router non ha risposto."""
    while True:
        try:
            if SHARE_PORT and share_on() and auto_port() and not tailnet_on():
                portmap_open()
            elif portmap["ok"]:
                portmap_close()
            else:
                portmap.update(error="", at=time.time())
        except Exception as ex:
            portmap.update(ok=False, public=False, error="errore: " + str(ex)[:120], at=time.time())
        portmap_wake.wait(1500 if portmap["ok"] else 300)
        portmap_wake.clear()
        time.sleep(1)


# ---- Tailscale dentro BunkerPlex --------------------------------------------
# Per far arrivare un amico senza toccare router, firewall o porte, BunkerPlex
# porta con se' Tailscale: il server scarica da solo il programma ufficiale
# (pkgs.tailscale.com, impronta controllata), lo fa girare dentro Docker in modalita'
# "userspace" (niente driver, niente permessi speciali) ed entra nella rete
# Tailscale di BunkerPlex con una chiave monouso che gli da' il servizio account.
# Il collegamento parte da qui verso l'esterno: va bene anche dietro il firewall
# di Windows, il doppio router o l'operatore senza indirizzo pubblico. Tra due PC
# il traffico e' diretto quando si puo' (altrimenti passa dai relay di Tailscale),
# sempre cifrato; sopra resta la porta 32501 in HTTPS con l'impronta ricordata.
# Nella rete di BunkerPlex le regole lasciano passare solo la 32501.
# Gira solo se serve: quando questo PC condivide o ha amici dell'account.

TS_DIR = DATA / "tailscale"
TS_RUN = Path(os.environ.get("TS_RUN_DIR", "/tmp/bunkerplex-tailscale"))
TS_SOCK = TS_RUN / "tailscaled.sock"
TS_PROXY = int(os.environ.get("TS_PROXY_PORT", "32510"))
TS_PKGS = "https://pkgs.tailscale.com/stable/"
TS_ARCH = {"x86_64": "amd64", "amd64": "amd64", "aarch64": "arm64", "arm64": "arm64",
           "armv7l": "arm", "armv6l": "arm", "i686": "386", "i386": "386"}
tailnet = {"state": "", "ip": "", "error": "", "at": 0.0, "supported": None, "version": "",
           # Al limite dei dispositivi dell'account: l'elenco, per chiedere quale togliere
           "limit": None, "replace": ""}
tailnet_wake = threading.Event()
tailnet_proc = {"p": None}


def tailnet_on():
    """Tailscale e' acceso e questo PC ha il suo indirizzo 100.x."""
    return tailnet["state"] == "Running" and bool(tailnet["ip"])


def tailnet_wanted():
    if os.environ.get("BUNKERPLEX_TAILSCALE", "1") == "0" or not auth_on():
        return False
    if public_wanted():
        return True
    if tailnet["supported"] is False and time.time() - tailnet["at"] < 6 * 3600:
        return False                 # il servizio account non da' chiavi: si riprova piu' tardi
    sh = config.get("share") or {}
    if share_on() and not (sh.get("manual") and sh.get("address")):
        return True
    with config_lock:
        if any(f.get("via") == "account" for f in config.get("friends") or []):
            return True
    return self_wanted() and not (sh.get("manual") and sh.get("address"))


def tailnet_binaries():
    """tailscale e tailscaled nella cartella del catalogo: scaricati una volta e
    rinnovati ogni mese (Tailscale smette di accettare le versioni molto vecchie)."""
    arch = TS_ARCH.get(platform.machine().lower())
    if not arch:
        raise OSError("processore non supportato: " + platform.machine())
    bindir = TS_DIR / "bin"
    have = all((bindir / n).is_file() for n in ("tailscale", "tailscaled"))
    if have and time.time() - (bindir / "tailscaled").stat().st_mtime < 30 * 86400:
        return bindir
    try:
        with urllib.request.urlopen(TS_PKGS + "?mode=json", timeout=20) as r:
            name = str(json.load(r)["Tarballs"][arch])
        if not re.fullmatch(r"tailscale_[\d.]+_[\w]+\.tgz", name):
            raise OSError("risposta inattesa da pkgs.tailscale.com")
        with urllib.request.urlopen(TS_PKGS + name + ".sha256", timeout=20) as r:
            want = r.read(200).decode("ascii", "replace").split()[0].lower()
        with urllib.request.urlopen(TS_PKGS + name, timeout=600) as r:
            blob = r.read(300 << 20)
        if not re.fullmatch(r"[0-9a-f]{64}", want) or hashlib.sha256(blob).hexdigest() != want:
            raise OSError("il file scaricato non corrisponde all'impronta pubblicata")
        tmp = TS_DIR / "bin.nuovo"
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(parents=True)
        with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tar:
            for m in tar.getmembers():
                base = m.name.rsplit("/", 1)[-1]
                if m.isfile() and base in ("tailscale", "tailscaled"):
                    (tmp / base).write_bytes(tar.extractfile(m).read())
                    os.chmod(tmp / base, 0o755)
        if not all((tmp / n).is_file() for n in ("tailscale", "tailscaled")):
            raise OSError("pacchetto di Tailscale incompleto")
        shutil.rmtree(bindir, ignore_errors=True)
        tmp.rename(bindir)
        tailnet["version"] = name.split("_")[1]
        return bindir
    except Exception:
        if have:                     # niente Internet o sito fermo: va bene la copia di prima
            return bindir
        raise


def tailnet_cli(*args, timeout=30):
    exe = TS_RUN / "tailscale"
    return subprocess.run([str(exe), "--socket", str(TS_SOCK), *args],
                          capture_output=True, text=True, timeout=timeout)


def tailnet_start():
    """Accende tailscaled. I programmi girano da una copia dentro il contenitore
    (dalla cartella del catalogo, su un disco di Windows, non sempre si possono avviare)."""
    bindir = tailnet_binaries()
    TS_RUN.mkdir(parents=True, exist_ok=True)
    for n in ("tailscale", "tailscaled"):
        shutil.copy2(bindir / n, TS_RUN / n)
        os.chmod(TS_RUN / n, 0o755)
    (TS_DIR / "stato").mkdir(parents=True, exist_ok=True)
    log = open(TS_RUN / "tailscaled.log", "ab")
    tailnet_proc["p"] = subprocess.Popen(
        [str(TS_RUN / "tailscaled"), "--tun=userspace-networking", "--statedir", str(TS_DIR / "stato"),
         "--socket", str(TS_SOCK), "--port", "0", "--no-logs-no-support",
         "--outbound-http-proxy-listen", f"127.0.0.1:{TS_PROXY}"],
        stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
    log.close()
    for _ in range(40):
        if TS_SOCK.exists():
            break
        time.sleep(0.25)


def tailnet_stop():
    p = tailnet_proc["p"]
    if p and p.poll() is None:
        p.terminate()
        try:
            p.wait(10)
        except subprocess.TimeoutExpired:
            p.kill()
    tailnet_proc["p"] = None
    tailnet.update(state="", ip="")


def tailnet_key():
    """Una chiave monouso per entrare nella rete di BunkerPlex, dal servizio
    account (con il gettone di un profilo collegato di questo PC)."""
    con = db(raw=True)
    try:
        rows = con.execute("SELECT id, token FROM users WHERE cloud_id IS NOT NULL AND token IS NOT NULL "
                           "AND must_change=0").fetchall()
    finally:
        con.close()
    if not rows:
        raise FriendDown("serve essere entrati con un account")
    rows = sorted(rows, key=lambda r: not friends_shared(r["id"]))
    body = {"sid": pc_id(), "host": "bunkerplex-" + pc_id(), "kind": "pc", "label": pc_name()}
    if tailnet["replace"]:
        body["replace"] = tailnet["replace"]
    try:
        got = accounts.call("POST", "/tailscale/key", body, rows[0]["token"])
    except accounts.CloudError as ex:
        if ex.status == 404:
            tailnet.update(supported=False)
        if ex.status == 409 and isinstance(ex.data.get("devices"), list):
            # Troppi dispositivi nell'account: l'interfaccia chiede quale togliere
            tailnet.update(limit={"limit": ex.data.get("limit") or 4, "devices": ex.data["devices"]})
        tailnet["replace"] = ""
        raise FriendDown(ex.detail, ex.status)
    except accounts.CloudOffline:
        raise FriendDown("niente Internet")
    tailnet.update(limit=None, replace="")
    key = str(got.get("key") or "")
    if not key.startswith("tskey-"):
        raise FriendDown("risposta non valida dal servizio account")
    tailnet["supported"] = True
    return key


def tailnet_check():
    """Legge lo stato di tailscaled; se va fatto l'ingresso nella rete, lo fa."""
    out = tailnet_cli("status", "--json", "--peers=false", timeout=15)
    st = json.loads(out.stdout or "{}")
    state = str(st.get("BackendState") or "")
    if state in ("NeedsLogin", "Stopped", "NoState"):
        key = tailnet_key()
        up = tailnet_cli("up", "--authkey", key, "--hostname", "bunkerplex-" + pc_id(),
                         "--accept-dns=false", "--accept-routes=false", "--reset", timeout=90)
        if up.returncode:
            raise FriendDown((up.stderr or up.stdout or "ingresso non riuscito").strip()[:200])
        st = json.loads(tailnet_cli("status", "--json", "--peers=false", timeout=15).stdout or "{}")
        state = str(st.get("BackendState") or "")
    ips = [ip for ip in (st.get("Self") or {}).get("TailscaleIPs") or [] if TS_NET.match(str(ip))]
    return state, (ips[0] if ips else "")


def tailnet_loop():
    """Tiene acceso Tailscale finche' serve. Quando cambia l'indirizzo 100.x lo
    si pubblica subito nella rubrica degli amici."""
    wait = 20
    while True:
        before = my_address()
        try:
            if tailnet_wanted():
                p = tailnet_proc["p"]
                if p is None or p.poll() is not None:
                    tailnet_start()
                state, ip = tailnet_check()
                tailnet.update(state=state, ip=ip if state == "Running" else "", error="", at=time.time())
                wait = 60 if tailnet_on() else 20
                if tailnet_on():
                    public_sync()
            elif tailnet_proc["p"]:
                tailnet_stop()
                public.update(url="", on=False)
        except Exception as ex:
            msg = str(ex) if isinstance(ex, (FriendDown, OSError)) else repr(ex)
            tailnet.update(state="", ip="", error=msg[:200], at=time.time())
            print("Tailscale:", msg[:300], flush=True)
            wait = min(max(wait * 2, 60), 1800)
        if my_address() != before:
            portmap_wake.set()           # con Tailscale la porta sul router non serve piu'
            sync_soon()                  # indirizzo nuovo nella rubrica degli amici
            for f in get_friends():
                if f.get("via") != "account":
                    threading.Thread(target=friend_sync, args=(f,), daemon=True).start()
        tailnet_wake.wait(wait)
        tailnet_wake.clear()


def via_tailnet(url):
    """Un indirizzo della rete di BunkerPlex: ci si arriva solo passando da Tailscale."""
    try:
        return bool(TS_NET.match(urllib.parse.urlsplit(url).hostname or ""))
    except ValueError:
        return False


def tailnet_proxy():
    if not tailnet_on():
        raise FriendDown("collegamento con gli amici in preparazione")
    return urllib.request.ProxyHandler({"http": f"http://127.0.0.1:{TS_PROXY}",
                                        "https": f"http://127.0.0.1:{TS_PROXY}"})


def get_friends():
    """I collegamenti agli amici. Dentro la richiesta di un profilo, solo quelli che
    vede lui: i vecchi (del PC) e quelli degli amici del suo account."""
    with config_lock:
        out = json.loads(json.dumps(config.get("friends") or []))
    u = CURRENT.get()
    if u is not None and u.get("guest"):
        return []                    # gli amici del proprietario non sono suoi
    if u is not None and not u.get("friend"):
        out = [f for f in out if not f.get("owner") or f["owner"] == u["id"]]
    return out


def friend_by_n(n):
    for f in get_friends():
        if f["n"] == n:
            return f
    return None


def fvid(n, rid):
    return FRIEND_BASE + (n - 1) * FRIEND_SPAN + rid


def friend_of(vid):
    """Da un id 'di un amico' a (amico, id sul suo server)."""
    n, rid = divmod(vid - FRIEND_BASE, FRIEND_SPAN)
    f = friend_by_n(n + 1)
    if not f:
        raise HTTPException(404, "Questo amico non è più tra i tuoi collegamenti")
    return f, rid


def friend_quality():
    q = str(config.get("friend_quality") or "720")
    return q if q in QUALITIES else "720"


def friend_mark(n, online, error=""):
    if n:
        friend_status.setdefault(n, {}).update(online=online, tried=time.time(), error=error)


def friend_usable(n):
    """Un amico appena trovato spento non si riprova a ogni richiesta: per 30
    secondi si risponde subito con la copia locale (la Home non deve aspettare)."""
    s = friend_status.get(n) or {}
    return s.get("online") is not False or time.time() - s.get("tried", 0) > 30


lan_fails = {}                   # indirizzo di casa -> quando non ha risposto


def friend_open(f, path, timeout=5, headers=None, method="GET", data=None):
    """Un altro tuo PC si prova prima nella rete di casa (se ci sei e' piu' veloce
    e va anche senza Internet), poi da Tailscale. Per 2 minuti dopo un tentativo a
    vuoto l'indirizzo di casa si salta, cosi' fuori casa non si aspetta."""
    lan_ = f.get("lan") or ""
    if lan_ and lan_ != f["url"] and time.time() - lan_fails.get(lan_, 0) > 120:
        try:
            r = friend_open_at(f, lan_, path, min(timeout, 2), headers, method, data)
            if f.get("n"):
                friend_status.setdefault(f["n"], {})["route"] = "lan"
            return r
        except urllib.error.HTTPError:
            raise                        # il PC risponde: l'errore e' suo, non della strada
        except Exception:
            lan_fails[lan_] = time.time()
    r = friend_open_at(f, f["url"], path, timeout, headers, method, data)
    if f.get("n"):
        friend_status.setdefault(f["n"], {})["route"] = "tailscale" if via_tailnet(f["url"]) else "internet"
    return r


def friend_open_at(f, base, path, timeout=5, headers=None, method="GET", data=None):
    h = {"X-Share-Token": f.get("token") or "", "User-Agent": "BunkerPlex/" + VERSION}
    h.update(headers or {})
    req = urllib.request.Request(base + "/api/share" + path, data=data, headers=h, method=method)
    # Verso un 100.x si passa dal Tailscale dentro BunkerPlex, se e' acceso
    # (altrimenti, come prima, dal Tailscale eventualmente installato sul computer)
    extra = [tailnet_proxy()] if via_tailnet(base) and tailnet_on() else []
    if not base.startswith("https://"):
        if extra:
            return urllib.request.build_opener(_NoRedirect, *extra).open(req, timeout=timeout)
        return friend_opener.open(req, timeout=timeout)
    pin = f.get("pin")

    class Pinned(http.client.HTTPSConnection):
        """Collegamento cifrato che accetta solo il certificato ricordato per questo
        amico (al primo collegamento non c'e' ancora: lo si prende e lo si ricorda)."""

        def connect(self):
            super().connect()
            got = hashlib.sha256(self.sock.getpeercert(True)).hexdigest()
            if pin and not hmac.compare_digest(got, pin):
                self.close()
                raise ssl.SSLError("certificato cambiato")
            f["_pin"] = got

    class Handler(urllib.request.HTTPSHandler):
        def https_open(self, r):
            return self.do_open(Pinned, r, context=TLS_ANY)

    return urllib.request.build_opener(_NoRedirect, Handler, *extra).open(req, timeout=timeout)


def friend_set(n, **fields):
    with config_lock:
        for f in config.get("friends") or []:
            if f["n"] == n:
                f.update(fields)
                save_config()
                return


def http_detail(ex):
    try:
        return str(json.loads(ex.read(4096)).get("detail") or "")[:200]
    except Exception:
        return ""


def friend_json(f, path, timeout=5, body=None):
    """Una risposta JSON dal server dell'amico. FriendDown se non si arriva a lui
    o se rifiuta l'accesso; mai attese lunghe."""
    n = f.get("n")
    headers = {"Accept-Encoding": "gzip"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    try:
        with friend_open(f, path, timeout, headers, "POST" if data else "GET", data) as r:
            raw = r.read(64 << 20)
            if (r.headers.get("Content-Encoding") or "").lower() == "gzip":
                raw = gzip.decompress(raw)
            out = json.loads(raw)
    except urllib.error.HTTPError as ex:
        detail = http_detail(ex)
        ex.close()
        if ex.code == 404 and body is None:
            friend_mark(n, True)
            raise HTTPException(404, "Questo titolo non c'è più sul server dell'amico")
        friend_mark(n, False, detail or f"errore {ex.code}")
        raise FriendDown(detail or f"errore {ex.code}", ex.code)
    except Exception as ex:
        why = "non raggiungibile"
        if "certificato cambiato" in str(ex):
            why = ("il certificato del suo server è cambiato: se ha reinstallato BunkerPlex, "
                   "togli l'amico e rimanda la richiesta")
        friend_mark(n, False, why)
        raise FriendDown(why)
    friend_mark(n, True)
    if n and f.get("_pin") and not f.get("pin"):     # primo collegamento cifrato: da ora vale solo questo certificato
        f["pin"] = f["_pin"]
        friend_set(n, pin=f["pin"])
    return out


def friend_bytes(f, path, timeout=6, limit=8 << 20, mark=True):
    """Un file piccolo (immagine, sottotitoli) dall'amico; None se non arriva."""
    n = f["n"]
    if not friend_usable(n):
        return None
    try:
        with friend_open(f, path, timeout) as r:
            data = r.read(limit + 1)
    except urllib.error.HTTPError as ex:
        ex.close()
        return None
    except Exception:
        if mark:
            friend_mark(n, False, "non raggiungibile")
        return None
    return data if 0 < len(data) <= limit else None


# ---- Copia locale del catalogo dell'amico ----------------------------------

def fc_path(n, name):
    return FRIENDS_DIR / str(n) / name


def fc_load(n, name):
    """(contenuto, eta' in secondi) di un file della copia locale; (None, 0) se manca."""
    p = fc_path(n, name)
    try:
        mtime = p.stat().st_mtime
    except OSError:
        return None, 0
    known = fc_memory.get(str(p))
    if not known or known[0] != mtime:
        try:
            known = (mtime, json.loads(p.read_text("utf-8")))
        except (OSError, ValueError):
            return None, 0
        if len(fc_memory) > 300:
            fc_memory.clear()
        fc_memory[str(p)] = known
    return known[1], max(0, time.time() - mtime)


def fc_save(n, name, data):
    if not friend_by_n(n):           # tolto nel frattempo: non si ricrea la sua cartella
        return
    p = fc_path(n, name)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp%d" % threading.get_ident())
    tmp.write_text(json.dumps(data, ensure_ascii=False), "utf-8")
    os.replace(tmp, p)


def friend_data(f, name, path, max_age=600, timeout=5):
    """Catalogo dell'amico: la copia locale se e' fresca, altrimenti si chiede a
    lui (attesa breve); se non risponde va bene anche la copia vecchia."""
    n = f["n"]
    cached, age = fc_load(n, name)
    if cached is not None and age < max_age:
        return cached
    if friend_usable(n):
        try:
            data = friend_json(f, path, timeout)
            fc_save(n, name, data)
            return data
        except FriendDown:
            pass
    if cached is not None:
        return cached
    raise HTTPException(502, f"«{f['name']}» non è raggiungibile e questa pagina non è ancora in memoria")


def friend_sync(f):
    """Aggiorna la copia locale di raccolte ed elenchi (in sottofondo)."""
    n = f["n"]
    lock = friend_locks.setdefault(n, threading.Lock())
    if not lock.acquire(blocking=False):
        return
    try:
        if f.get("via") == "account" and not f.get("token"):
            friend_ticket_login(f)       # amico dell'account: si entra col biglietto
        try:
            libs = friend_json(f, "/libraries", timeout=6)
        except FriendDown as ex:
            if f.get("via") != "account" or ex.code != 401:
                raise
            friend_ticket_login(f)       # gettone non piu' valido: biglietto nuovo
            libs = friend_json(f, "/libraries", timeout=6)
        clean = []
        for l in libs if isinstance(libs, list) else []:
            if isinstance(l, dict) and _is_id(l.get("id")):
                clean.append({"id": l["id"], "name": str(l.get("name") or "Raccolta")[:40],
                              "movies": int(_num(l.get("movies"))), "shows": int(_num(l.get("shows"))),
                              "sync": l["sync"] if re.fullmatch(r"[0-9a-f]{16}", str(l.get("sync") or "")) else ""})
        fc_save(n, "libraries.json", clean)
        everything = []
        for l in clean:
            items = friend_json(f, f"/libraries/{l['id']}/items", timeout=20)
            if isinstance(items, list):
                fc_save(n, f"lib_{l['id']}.json", items)
                everything += items
        friend_status.setdefault(n, {})["synced"] = time.time()
        friend_hello(f)
        # Le locandine: scaricate una volta, poi si vedono anche con l'amico spento
        for x in everything:
            m = F_IMG.match(x.get("poster") or "") if isinstance(x, dict) else None
            if m and not fc_path(n, "img/" + m.group(1)).exists():
                if not friend_by_n(n) or not friend_image_file(f, m.group(1)):
                    break
                time.sleep(0.05)
    except FriendDown as ex:
        if f.get("via") == "account" and (friend_status.get(n) or {}).get("online") is not False:
            friend_mark(n, False, str(ex))
    except Exception as ex:
        print("Amico", f.get("name"), "- aggiornamento non riuscito:", ex, flush=True)
    finally:
        lock.release()


def friend_hello(f):
    """Dice all'amico a quale indirizzo trova questo server, se e' cambiato
    dall'ultima volta (cosi' il collegamento di ritorno non si perde)."""
    mine = my_address()
    if not mine or not f.get("account") or f.get("told") == mine:
        return
    try:
        with friend_open(f, "/hello", 6, {"Content-Type": "application/json"}, "POST",
                         json.dumps({"url": mine}).encode()) as r:
            r.read(4096)
        friend_set(f["n"], told=mine)
    except Exception:
        pass                     # si riprova al prossimo giro


def friends_loop():
    """Tiene aggiornata la copia locale: ogni 10 minuti se l'amico risponde,
    un tentativo al minuto se e' spento. Mai dentro una richiesta dell'utente."""
    while True:
        time.sleep(15)
        try:
            for f in get_friends():
                s = friend_status.get(f["n"]) or {}
                due = 600 if s.get("online") and s.get("synced") else 60
                if time.time() - max(s.get("tried", 0) if not s.get("online") else 0,
                                     s.get("synced", 0)) >= due:
                    friend_sync(f)
        except Exception as ex:
            print("Amici:", ex, flush=True)


# ---- Dal catalogo dell'amico a quello che l'interfaccia si aspetta ---------

F_IMG = re.compile(r"^/api/image/([\w.\-]{1,120}\.(?:jpg|jpeg|png|webp))$", re.I)
F_REF = re.compile(r"^/api/(thumb|stream|transcode)/(\d{1,8})$")
F_SUB = re.compile(r"^/api/subs/(\d{1,8})/(\d{1,3})$")
F_ID = {"id", "show_id", "library_id", "next"}
F_URL = {"poster", "backdrop", "thumb", "photo", "url", "transcode"}
F_NUM = {"year", "year_to", "season", "episode", "count", "total", "episodes", "seasons_count",
         "unwatched", "number", "bits", "size", "index", "duration", "position", "added_at",
         "latest", "rating", "start", "width", "height", "intro_start", "intro_end", "credits"}
F_CODE = {"vcodec", "acodec", "codec", "lang"}
F_KINDS = ("movie", "episode", "show", "collection")


def _is_id(v):
    return isinstance(v, int) and not isinstance(v, bool) and 0 < v < FRIEND_SPAN


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else 0


def f_url(n, v):
    """Gli indirizzi dentro il catalogo dell'amico diventano indirizzi di questo
    server (che fa da tramite). Qualsiasi altra cosa viene scartata."""
    if not isinstance(v, str):
        return None
    m = F_IMG.match(v)
    if m:
        return f"/api/friend/{n}/image/{m.group(1)}"
    m = F_REF.match(v)
    if m:
        return f"/api/{m.group(1)}/{fvid(n, int(m.group(2)))}"
    m = F_SUB.match(v)
    if m:
        return f"/api/subs/{fvid(n, int(m.group(1)))}/{m.group(2)}"
    return None


def friend_states(n):
    """Visto e punto di ripresa dei titoli di un amico (tenuti qui, in locale)."""
    con = db()
    try:
        rows = {r["item"]: r for r in con.execute("SELECT * FROM friend_state WHERE friend=?", (n,))}
    finally:
        con.close()
    seen = {}
    for r in rows.values():
        if r["watched"] and r["show"]:
            seen[r["show"]] = seen.get(r["show"], 0) + 1
    return rows, seen


def f_adapt(f, x, st=None):
    """Ricopia un pezzo di catalogo dell'amico: id e indirizzi tradotti, tipi
    controllati (non ci si fida alla cieca di un altro server), stato locale."""
    n = f["n"]
    if isinstance(x, list):
        return [f_adapt(f, v, st) for v in x]
    if not isinstance(x, dict):
        return x if isinstance(x, (str, bool)) or x is None else (_num(x) if _num(x) == x else None)
    out = {}
    for k, v in x.items():
        if k in F_ID:
            out[k] = fvid(n, v) if _is_id(v) else (0 if k == "next" else None)
        elif k in F_URL:
            out[k] = f_url(n, v)
        elif k in F_NUM and not isinstance(v, list):    # 'episodes' e' un numero nella serie, un elenco nella stagione
            out[k] = v if v is not None and _num(v) == v and not isinstance(v, bool) else None
        elif k in F_CODE:
            out[k] = re.sub(r"[^a-z0-9_]", "", str(v or "").lower())[:20]
        elif k == "quality":
            out[k] = v if v in ("4K", "1080p", "720p", "SD") else ""
        elif k == "kind":
            out[k] = v if v in F_KINDS else "movie"
        else:
            out[k] = f_adapt(f, v, st)
    kind = out.get("kind")
    if kind:
        out["friend"] = f["name"]
        out["friend_self"] = bool(f.get("self"))       # un altro tuo PC, non un amico
        out["fav"] = False
        for k in ("genres", "actors"):
            if not isinstance(out.get(k), list):
                out[k] = []
        rid = x.get("id")
        if kind in ("movie", "episode"):
            s = st[0].get(rid) if st else None
            out["watched"] = bool(s and s["watched"])
            out["position"] = s["position"] if s and not s["watched"] else 0
        elif kind == "show":
            eps = int(out.get("episodes") or 0)
            done = min(eps, st[1].get(rid, 0)) if st else 0
            out["unwatched"] = eps - done
            out["watched"] = eps > 0 and done == eps
        else:
            out["unwatched"] = int(out.get("count") or 0)
            out["watched"] = False
    return out


def _up_next(items):
    started = [e for e in items if (e.get("position") or 0) > 20 and not e.get("watched")]
    unwatched = [e for e in items if not e.get("watched")]
    return started[0] if started else (unwatched[0] if unwatched else (items[0] if items else None))


def friend_library_items(vid):
    f, rid = friend_of(vid)
    # Sempre dalla copia locale se c'e' (la rinfresca friends_loop): risposta immediata
    items = friend_data(f, f"lib_{rid}.json", f"/libraries/{rid}/items", max_age=10 ** 9, timeout=15)
    return f_adapt(f, [x for x in items if isinstance(x, dict)] if isinstance(items, list) else [],
                   friend_states(f["n"]))


def _detail(f, name, path):
    d = friend_data(f, name, path)
    if not isinstance(d, dict):
        raise HTTPException(502, f"Risposta non valida dal server di «{f['name']}»")
    return f_adapt(f, d, friend_states(f["n"]))


def friend_show(vid):
    f, rid = friend_of(vid)
    d = _detail(f, f"show_{rid}.json", f"/shows/{rid}")
    seasons = [s for s in d.get("seasons") or [] if isinstance(s, dict) and isinstance(s.get("episodes"), list)]
    d["seasons"] = seasons
    eps = [e for s in seasons for e in s["episodes"] if isinstance(e, dict)]
    d["episodes"] = len(eps)
    d["unwatched"] = sum(1 for e in eps if not e.get("watched"))
    d["watched"] = bool(eps) and d["unwatched"] == 0
    d["up_next"] = _up_next(eps)
    return d


def friend_item(vid):
    f, rid = friend_of(vid)
    return _detail(f, f"item_{rid}.json", f"/items/{rid}")


def friend_collection(vid):
    f, rid = friend_of(vid)
    d = _detail(f, f"coll_{rid}.json", f"/collections/{rid}")
    items = [x for x in d.get("items") or [] if isinstance(x, dict)]
    d["items"] = items
    d["missing"] = [m for m in d.get("missing") or [] if isinstance(m, dict)]
    d["unwatched"] = sum(1 for x in items if not x.get("watched"))
    d["watched"] = bool(items) and d["unwatched"] == 0
    d["up_next"] = _up_next(items)
    return d


def friend_item_meta(f, rid):
    """La scheda di un titolo dell'amico, cosi' com'e' arrivata (None se non si ha)."""
    try:
        d = friend_data(f, f"item_{rid}.json", f"/items/{rid}", max_age=7 * 86400, timeout=4)
    except HTTPException:
        return None
    return d if isinstance(d, dict) else None


def friend_put_state(n, rid, show, position, watched, played):
    con = db()
    try:
        con.execute(
            "INSERT INTO friend_state(friend, item, show, position, watched, last_played) VALUES(?,?,?,?,?,?) "
            "ON CONFLICT(friend, item) DO UPDATE SET show=COALESCE(excluded.show, show), "
            "position=excluded.position, watched=excluded.watched, "
            "last_played=CASE WHEN excluded.last_played>0 THEN excluded.last_played ELSE last_played END",
            (n, rid, show, position, 1 if watched else 0, played))
        con.commit()
    finally:
        con.close()


def _show_of(meta):
    return meta["show_id"] if meta and _is_id(meta.get("show_id")) else None


def friend_progress(vid, pos, dur, ended):
    """Punto di ripresa di un titolo dell'amico: resta su questo server."""
    f, rid = friend_of(vid)
    meta = friend_item_meta(f, rid)
    dur = dur or _num((meta or {}).get("duration"))
    finished = ended or (dur > 0 and pos / dur > 0.93)
    friend_put_state(f["n"], rid, _show_of(meta), 0 if finished else pos, finished, time.time())
    return {"ok": True, "watched": finished}


def friend_set_watched(vid, on):
    f, rid = friend_of(vid)
    friend_put_state(f["n"], rid, _show_of(friend_item_meta(f, rid)), 0, on, 0)
    return {"ok": True}


def friend_show_watched(vid, on, season=None):
    f, rid = friend_of(vid)
    d = friend_data(f, f"show_{rid}.json", f"/shows/{rid}")
    for s in (d.get("seasons") or []) if isinstance(d, dict) else []:
        if not isinstance(s, dict) or (season is not None and s.get("season") != season):
            continue
        for e in s.get("episodes") or []:
            if isinstance(e, dict) and _is_id(e.get("id")):
                friend_put_state(f["n"], e["id"], rid, 0, on, 0)
    return {"ok": True}


def friend_play(vid):
    """Avvio di un titolo dell'amico. Per non intasare la sua linea, di norma il
    video arriva convertito (720p o 1080p): lo decide 'friend_quality'."""
    f, rid = friend_of(vid)
    try:
        p = friend_json(f, f"/play/{rid}", timeout=6)
    except FriendDown as ex:
        raise HTTPException(502, f"«{f['name']}» non è raggiungibile ({ex}): riprova più tardi")
    if not isinstance(p, dict):
        raise HTTPException(502, f"Risposta non valida dal server di «{f['name']}»")
    friend_item_meta(f, rid)         # la scheda serve poi a «Continua a guardare»
    out = f_adapt(f, p)
    out["friend"] = f["name"]
    out["friend_self"] = bool(f.get("self"))
    out["subs_online"] = False      # i video dell'amico non si toccano: li scarica lui
    out["subs"] = [s for s in out.get("subs") or [] if isinstance(s, dict) and s.get("url")]
    s = friend_states(f["n"])[0].get(rid)
    out["start"] = s["position"] if s and not s["watched"] else 0
    quality = friend_quality()
    if f.get("self") and (friend_status.get(f["n"]) or {}).get("route") == "lan":
        quality = "orig"             # un altro tuo PC nella rete di casa: il file com'e'
    out["friend_quality"] = quality
    if quality != "orig":
        # Arriva convertito: nel player conta la qualita' che vedi, non quella del file
        rank = ["SD", "720p", "1080p", "4K"]
        q = out.get("quality") or ""
        if q in rank and rank.index(q) > rank.index(quality + "p"):
            out["quality"] = quality + "p"
        # Sempre convertito. Il browser lo capisce da 'browser_direct'; l'app TV prova
        # prima 'url': li' trova un file che non e' un video e passa da sola alla conversione.
        out.update(browser_direct=False, url="/api/friend/convert", vcodec="h264", bits=8)
    return out


def friend_tracks(vid):
    f, rid = friend_of(vid)
    try:
        t = friend_json(f, f"/tracks/{rid}", timeout=8)
    except FriendDown:
        t = None
    t = f_adapt(f, t) if isinstance(t, dict) else {}
    t["audio"] = [a for a in t.get("audio") or [] if isinstance(a, dict)]
    return t


def friend_image_file(f, name):
    """Un'immagine dell'amico, dalla copia locale (scaricata la prima volta)."""
    target = fc_path(f["n"], "img/" + name)
    if target.is_file():
        return target
    data = friend_bytes(f, "/image/" + name)
    if not data:
        return None
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".tmp%d" % threading.get_ident())
    tmp.write_bytes(data)
    os.replace(tmp, target)
    return target


@app.get("/api/friend/{n}/image/{name}")
def friend_image(n: int, name: str):
    f = friend_by_n(n)
    if not f or not F_IMG.match("/api/image/" + name):
        raise HTTPException(404)
    target = friend_image_file(f, name)
    if not target:
        raise HTTPException(404)
    return FileResponse(target, headers={"Cache-Control": "public, max-age=31536000, immutable",
                                         "X-Content-Type-Options": "nosniff"})


@app.get("/api/friend/convert")
def friend_convert():
    """Non e' un video, apposta: vedi friend_play."""
    return Response(b"BunkerPlex: questo titolo arriva convertito.\n" * 40,
                    media_type="application/octet-stream", headers={"Cache-Control": "no-store"})


def friend_thumb(vid):
    f, rid = friend_of(vid)
    target = fc_path(f["n"], f"img/thumb_{rid}.jpg")
    if not target.is_file():
        # Il fotogramma lo prepara il PC dell'amico: puo' volerci un po', e non dice nulla sul collegamento
        data = friend_bytes(f, f"/thumb/{rid}", timeout=20, mark=False)
        if not data or data[:2] != b"\xff\xd8":
            raise HTTPException(404)
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(".tmp%d" % threading.get_ident())
        tmp.write_bytes(data)
        os.replace(tmp, target)
    return FileResponse(target, headers={"Cache-Control": "public, max-age=86400",
                                         "X-Content-Type-Options": "nosniff"})


def friend_subs(vid, index, offset):
    f, rid = friend_of(vid)
    data = friend_bytes(f, f"/subs/{rid}/{int(index)}?offset={max(0.0, offset):.1f}", timeout=8)
    if not data:
        raise HTTPException(404)
    return Response(data, media_type="text/vtt; charset=utf-8",
                    headers={"X-Content-Type-Options": "nosniff"})


def friend_pipe(f, path, request=None):
    """Fa passare un video dall'amico al dispositivo, senza tenerne copia."""
    headers, method = {}, "GET"
    if request is not None:
        method = request.method
        if request.headers.get("range"):
            headers["Range"] = request.headers["range"]
    try:
        up = friend_open(f, path, 30, headers, method)
    except urllib.error.HTTPError as ex:
        code, total = ex.code, ex.headers.get("Content-Range") or ""
        ex.close()
        if code == 416:
            return Response(status_code=416, headers={"Content-Range": total})
        raise HTTPException(404 if code == 404 else 502,
                            "File non trovato sul disco dell'amico" if code == 404
                            else f"«{f['name']}» ha rifiutato la richiesta")
    except Exception:
        friend_mark(f["n"], False, "non raggiungibile")
        raise HTTPException(502, f"«{f['name']}» non è raggiungibile")
    keep = {k: up.headers[k] for k in ("Content-Length", "Content-Range", "Accept-Ranges")
            if up.headers.get(k)}
    keep["Cache-Control"] = "no-store"
    keep["X-Content-Type-Options"] = "nosniff"
    ctype = (up.headers.get("Content-Type") or "").split(";")[0].strip().lower()
    if not ctype.startswith(("video/", "audio/")):
        ctype = "application/octet-stream"
    if method == "HEAD":
        up.close()
        return Response(status_code=up.status, headers=keep, media_type=ctype)

    async def body():
        # Come per la conversione di casa: se il dispositivo chiude o salta, il
        # 'finally' chiude subito il collegamento e il PC dell'amico smette di lavorare.
        loop = asyncio.get_running_loop()
        try:
            while True:
                chunk = await loop.run_in_executor(None, up.read1, 256 * 1024)
                if not chunk:
                    break
                yield chunk
        finally:
            up.close()

    return StreamingResponse(body(), status_code=up.status, headers=keep, media_type=ctype)


def friend_stream(vid, request):
    f, rid = friend_of(vid)
    return friend_pipe(f, f"/stream/{rid}", request)


def friend_transcode(vid, start, vcopy, audio, aout=""):
    f, rid = friend_of(vid)
    q = {"start": f"{max(0.0, start):.2f}", "audio": max(0, audio)}
    quality = friend_quality()
    if quality == "orig":
        q["vcopy"] = 1 if vcopy else 0
        if aout:
            q["aout"] = aout
    else:
        q["height"] = quality
    return friend_pipe(f, f"/transcode/{rid}?" + urllib.parse.urlencode(q))


# ---- Home e menu: le raccolte degli amici ----------------------------------

def friend_home_rows():
    """Una fila per ogni raccolta di ogni amico. Solo dalla copia locale: la
    Home non aspetta mai la rete."""
    rows = []
    here = local_syncs()
    for f in get_friends():
        try:
            n = f["n"]
            libs, _ = fc_load(n, "libraries.json")
            st = None
            for l in libs or []:
                items, _ = fc_load(n, f"lib_{l['id']}.json")
                items = [x for x in items or [] if isinstance(x, dict)]
                if not items:
                    continue
                items.sort(key=lambda x: _num(x.get("latest")) or _num(x.get("added_at")), reverse=True)
                st = st or friend_states(n)
                if f.get("self") and l.get("sync") and l["sync"] in here:
                    continue             # c'e' anche qui: la fila e' quella della raccolta di qui
                rows.append({"id": fvid(n, l["id"]), "name": l["name"], "friend": f["name"],
                             "friend_self": bool(f.get("self")),
                             "offline": (friend_status.get(n) or {}).get("online") is False,
                             "items": f_adapt(f, items[:24], st)})
        except Exception as ex:
            print("Amici (Home):", ex, flush=True)
    return rows


def friend_n_of(vid):
    return (vid - FRIEND_BASE) // FRIEND_SPAN + 1 if isinstance(vid, int) and vid >= FRIEND_BASE else 0


def friend_home(n):
    """La Home di un solo server di un amico (o di un tuo altro PC)."""
    rows = [r for r in friend_home_rows() if friend_n_of(r["id"]) == n] if friend_by_n(n) else []
    con = db()
    try:
        cont = [c for c in friend_continue(con, []) if friend_n_of(c.get("id")) == n]
    finally:
        con.close()
    return {"continue": cont, "nextup": [], "libraries": rows, "collections": [], "top_movies": [],
            "mylist": [], "has_libraries": bool(rows), "friend": n}


def friend_continue(con, cont):
    """Aggiunge a «Continua a guardare» i titoli degli amici lasciati a meta'."""
    try:
        rows = con.execute("SELECT * FROM friend_state WHERE position>20 AND watched=0 "
                           "ORDER BY last_played DESC LIMIT 20").fetchall()
        states = {}
        for r in rows:
            f = friend_by_n(r["friend"])
            meta, _ = fc_load(r["friend"], f"item_{r['item']}.json") if f else (None, 0)
            if isinstance(meta, dict):
                if r["friend"] not in states:
                    states[r["friend"]] = friend_states(r["friend"])
                cont.append(dict(f_adapt(f, meta, states[r["friend"]]), last_played=r["last_played"]))
    except Exception as ex:
        print("Amici (Home):", ex, flush=True)
    cont.sort(key=lambda x: x.get("last_played") or 0, reverse=True)
    return cont[:20]


# ---- Impostazioni: aggiungere e togliere amici -----------------------------

def friend_address(raw):
    """Indirizzo scritto a mano -> https://host:porta (cifrato e sulla porta degli
    amici, se non e' scritto altro)."""
    raw = str(raw or "").strip()
    if not raw:
        raise HTTPException(400, "Scrivi l'indirizzo dell'amico")
    if "://" not in raw:
        raw = "https://" + raw
    try:
        u = urllib.parse.urlsplit(raw)
        port, host = u.port, u.hostname
    except ValueError:
        raise HTTPException(400, "Indirizzo non valido")
    if u.scheme not in ("http", "https") or not host:
        raise HTTPException(400, "Indirizzo non valido")
    if ":" in host:
        host = f"[{host}]"
    return f"{u.scheme}://{host}:{port or 32501}"


def local_syncs():
    """Le raccolte (sync_id) che qui hanno almeno una cartella raggiungibile: per
    quelle si usano i file di qui, non quelli di un altro tuo PC."""
    return {l["sync_id"] for l in get_libraries() if l.get("sync_id")
            and any(folder_state(p).get("online") for p in l["folders"])}


def self_synced():
    """Le raccolte (sync_id) che si vedono da un altro tuo PC."""
    out = set()
    if CURRENT.get() is None:
        return out
    for f in get_friends():
        if f.get("self"):
            libs, _ = fc_load(f["n"], "libraries.json")
            out.update(l.get("sync") for l in libs or [] if l.get("sync"))
    return out


@app.get("/api/friends")
def friends_list():
    out = []
    # Una raccolta che c'e' anche qui, con le sue cartelle: si usa quella di qui
    here = local_syncs()
    for f in get_friends():
        n = f["n"]
        s = friend_status.get(n) or {}
        libs, age = fc_load(n, "libraries.json")
        mine = bool(f.get("self"))
        out.append({"n": n, "name": f["name"], "url": f["url"], "user": f.get("user") or "", "via": f.get("via") or "",
                    "self": mine, "route": s.get("route") or "",
                    "online": s.get("online"), "error": s.get("error") or "",
                    "synced": time.time() - age if libs is not None else 0,
                    "libraries": [{"id": fvid(n, l["id"]), "name": l["name"],
                                   "movies": l["movies"], "shows": l["shows"]} for l in libs or []
                                  if not (mine and l.get("sync") and l["sync"] in here)]})
    return {"friends": out, "quality": friend_quality()}


@app.post("/api/friends")
async def friends_add(request: Request):
    """Collega il server di un amico: ci si registra da lui (o si accede con un
    account gia' fatto). La password non viene conservata: resta solo il gettone."""
    manager_only()
    body = await read_json(request)
    name = re.sub(r"\s+", " ", str(body.get("name") or "")).strip()[:30]
    url = friend_address(body.get("url"))
    user, password = _credentials({"name": body.get("user"), "password": body.get("password")})
    friends = get_friends()
    if any(f["url"] == url for f in friends):
        raise HTTPException(409, "Questo indirizzo è già tra i tuoi amici")
    if len(friends) >= FRIEND_MAX:
        raise HTTPException(400, f"Puoi collegare al massimo {FRIEND_MAX} amici")
    probe = {"url": url, "token": ""}
    ask = {"name": user, "password": password}
    account = None
    if body.get("register"):
        # Richiesta di condivisione reciproca: insieme alla richiesta si offre l'ingresso
        # qui. Serve sapere a quale indirizzo l'amico raggiunge questo server.
        typed = friend_address(body["my_url"]) if body.get("my_url") else ""
        if not share_on():
            # Prima richiesta: si accende la condivisione e si prova ad aprire la porta sul router
            with config_lock:
                config.setdefault("share", {})["on"] = True
                save_config()
            asked = time.time()
            portmap_wake.set()
            tailnet_wake.set()
            if not typed:
                for _ in range(40):
                    if portmap["at"] >= asked or tailnet_on():
                        break
                    await asyncio.sleep(0.25)
        if typed and typed != my_address():
            with config_lock:
                config.setdefault("share", {}).update(address=typed, manual=True)
                save_config()
        mine = typed or my_address()
        if not mine:
            raise HTTPException(400, "Non sono riuscito ad aprire la porta sul router ("
                                     + (portmap["error"] or "nessuna risposta") + "). Scrivi tu il tuo indirizzo, "
                                     "per esempio quello di Tailscale")
        account, token = await in_thread(account_for_friend, name or user)
        ask["back"] = {"url": mine, "token": token, "pin": share_tls["pin"]}
    path = "/register" if body.get("register") else "/login"
    try:
        try:
            got = await in_thread(friend_json, probe, path, 8, ask)
        except FriendDown as ex:
            # Indirizzo scritto senza http/https: se dall'altra parte la porta non e' cifrata si riprova in chiaro
            if ex.code or "://" in str(body.get("url")):
                raise
            probe = {"url": "http://" + url[len("https://"):], "token": ""}
            got = await in_thread(friend_json, probe, path, 8, ask)
            url = probe["url"]
    except FriendDown as ex:
        if account:
            account_drop(account)
        if ex.code:
            raise HTTPException(400, f"Il server dell'amico risponde: {ex}")
        raise HTTPException(502, "Non riesco a raggiungere questo indirizzo: controlla che sia giusto, "
                                 "che il PC dell'amico sia acceso e che la condivisione sia attiva")
    if not isinstance(got, dict) or not isinstance(got.get("token"), str) or not got["token"]:
        if account:
            account_drop(account)
        raise HTTPException(502, "A quell'indirizzo non risponde un BunkerPlex")
    n = friend_store(name or str(got.get("server") or "Amico")[:30], url, user, got["token"], account,
                     probe.get("_pin"))
    return {"ok": True, "n": n, "approved": bool(got.get("approved"))}


def friend_store(name, url, user, token, account=None, pin=None, extra=None):
    """Mette un amico tra i collegamenti e comincia subito a scaricarne gli elenchi."""
    with config_lock:
        current = config.setdefault("friends", [])
        used = {f["n"] for f in current}
        n = next(i for i in range(1, FRIEND_MAX + 2) if i not in used)
        f = {"n": n, "name": name, "url": url, "user": user, "token": token}
        if account:
            f["account"] = account       # l'account con cui lui entra qui: se ne va insieme a lui
        if pin:
            f["pin"] = pin               # impronta del suo certificato: si accetta solo quello
        f.update(extra or {})            # amico dell'account: via, owner, fid, sid
        current.append(f)
        save_config()
    shutil.rmtree(FRIENDS_DIR / str(n), ignore_errors=True)
    friend_status.pop(n, None)
    threading.Thread(target=friend_sync, args=(f,), daemon=True).start()
    return n


@app.delete("/api/friends/{n}")
def friends_remove(n: int):
    """Toglie un amico: spariscono le sue raccolte e lui non entra piu' qui."""
    manager_only()
    f = friend_by_n(n)
    if f and f.get("account"):
        account_drop(f["account"])
    return friend_drop(n)


def friend_drop(n):
    with config_lock:
        config["friends"] = [f for f in config.get("friends") or [] if f["n"] != n]
        save_config()
    con = db()
    try:
        con.execute("DELETE FROM friend_state WHERE friend=?", (n,))
        con.commit()
    finally:
        con.close()
    shutil.rmtree(FRIENDS_DIR / str(n), ignore_errors=True)
    friend_status.pop(n, None)
    fc_memory.clear()
    return {"ok": True}


@app.post("/api/friends/{n}/refresh")
def friends_refresh(n: int):
    """Riprova subito il collegamento e riscarica gli elenchi (in sottofondo)."""
    f = friend_by_n(n)
    if not f:
        raise HTTPException(404, "Amico non trovato")
    threading.Thread(target=friend_sync, args=(f,), daemon=True).start()
    return {"ok": True}


@app.post("/api/friends/quality")
async def friends_quality(request: Request):
    manager_only()
    body = await read_json(request)
    q = str(body.get("quality") or "")
    if q not in QUALITIES:
        raise HTTPException(400, "Richiesta non valida")
    with config_lock:
        config["friend_quality"] = q
        save_config()
    return {"ok": True}


# ---- Amici dell'account ------------------------------------------------------------
# Con un profilo collegato a un account gli amici sono quelli dell'account: si
# aggiungono col nome del loro account e accettano da qualsiasi loro PC. Il servizio
# account fa da rubrica: ogni server che condivide vi pubblica indirizzo e impronta
# del certificato, e gli amici li leggono da li' (anche quando l'indirizzo cambia).
# Per entrare si chiede al servizio un biglietto (vedi share_ticket). Ogni server
# di un amico diventa un collegamento come quelli di prima (config «friends», con
# via = "account" e owner = il profilo di qui), visibile solo a quel profilo.
# I vecchi collegamenti con indirizzo e password restano come sono.

friends_cloud = {}               # profilo -> {"at", "friends": [...], "supported"}


def friends_shared(uid):
    """Il profilo condivide le sue raccolte con i suoi amici (scelta dell'account)."""
    return user_setting(uid, "friends_share") is True


def presence_url():
    """L'indirizzo da pubblicare per gli amici: solo cifrato (con impronta da controllare)."""
    url = my_address()
    return url if url.startswith("https://") and share_tls["pin"] else ""


def lan_url():
    """L'indirizzo della porta 32501 nella rete di casa: gli altri tuoi PC lo provano
    per primo (piu' veloce, e funziona anche senza Internet)."""
    ip = os.environ.get("BUNKERPLEX_LAN_IP", "").strip() or lan["ip"]
    if not ip or not SHARE_PORT or not share_tls["on"] or not re.fullmatch(r"[\d.]{7,15}", ip):
        return ""
    return f"https://{ip}:{SHARE_PORT}"


# ---- Credenziale del server e presenza -------------------------------------------
# Il server ha una credenziale sua nel servizio account, presa una volta con il
# gettone del proprietario (POST /servers/<sid>/claim). Con quella manda presenza e
# indirizzi a ogni giro di sincronizzazione (POST /server/heartbeat) e fa verificare
# i gettoni d'accesso (vedi access_claims). Con il servizio account di prima (404)
# resta tutto come prima: PUT /servers con il gettone del proprietario.
# Vedi docs/architettura.md.

CRED_KEY = "server_cred"
cloud_v2 = {"on": None, "error": ""}      # on: None = non si sa ancora, False = servizio di prima


def server_cred():
    with config_lock:
        c = config.get(CRED_KEY)
    return dict(c) if isinstance(c, dict) and c.get("secret") else None


def set_server_cred(cred):
    with config_lock:
        if cred:
            config[CRED_KEY] = cred
        else:
            config.pop(CRED_KEY, None)
        save_config()


def cloud_id_of(uid):
    if uid is None:
        return None
    con = db(raw=True)
    try:
        r = con.execute("SELECT cloud_id FROM users WHERE id=?", (uid,)).fetchone()
    finally:
        con.close()
    return r["cloud_id"] if r else None


def claim_cred(token):
    res = accounts.call("POST", f"/servers/{pc_id()}/claim", {"name": pc_name()}, token)
    owner = res.get("owner") or {}
    secret = str(res.get("credential") or "")
    if not re.fullmatch(r"s_[0-9a-f]{8}_[0-9a-f]{64}", secret) or not isinstance(owner.get("id"), int):
        raise accounts.CloudError(502, "Risposta non valida dal servizio account")
    cred = {"secret": secret, "owner": owner["id"], "owner_name": str(owner.get("username") or "")}
    set_server_cred(cred)
    return cred


def drop_server_cred():
    """Il server esce dall'account (cambio di proprietario, account tolto dal PC)."""
    cred = server_cred()
    if cred:
        try:
            accounts.call("DELETE", "/server", token=cred["secret"], timeout=6)
        except Exception:
            pass
    set_server_cred(None)


def heartbeat_body(uid):
    friends = bool(friends_shared(uid) and share_on())
    pin = share_tls["pin"] if share_tls["on"] else ""
    return {"name": pc_name(), "url": presence_url() if (friends or self_reach(uid)) else "",
            "lan": lan_url() if pin else "", "pin": pin, "friends": friends, "version": VERSION,
            "secure_port": SECURE_PORT if secure["on"] else 0,
            # Da fuori casa: l'indirizzo pubblico (Funnel), se acceso. Lo usa la PWA.
            "public": public["url"] if public["on"] and public["url"].startswith("https://") else ""}


def heartbeat(body, cred):
    res = accounts.call("POST", "/server/heartbeat", body, cred["secret"])
    domain = str(res.get("domain") or "")
    if not re.fullmatch(r"[a-z0-9.-]{3,200}", domain):
        domain = ""
    new = domain != secure["domain"]
    secure.update(domain=domain, names=res.get("names") if isinstance(res.get("names"), dict) else {})
    if new and domain:
        secure_wake.set()           # dominio nuovo: si chiede il certificato


def presence_v2(uid, token):
    """Presenza con la credenziale del server. False = va fatta come prima (PUT /servers)."""
    if cloud_v2["on"] is False or uid != server_owner():
        return False
    me = cloud_id_of(uid)
    cred = server_cred()
    try:
        if cred and cred["owner"] != me:
            drop_server_cred()                       # il PC ha cambiato proprietario
            cred = None
        if not cred:
            cred = claim_cred(token)
        body = heartbeat_body(uid)
        try:
            heartbeat(body, cred)
        except accounts.CloudError as ex:
            if ex.status != 401:
                raise
            set_server_cred(None)                    # credenziale persa o ripresa: si riprende
            cred = claim_cred(token)
            heartbeat(body, cred)
    except accounts.CloudError as ex:
        if ex.status == 404:                         # servizio account di prima
            cloud_v2.update(on=False, error="")
            return False
        cloud_v2.update(on=True, error=ex.detail)
        print("Presenza nel servizio account:", ex.detail, flush=True)
        return True
    cloud_v2.update(on=True, error="")
    return True


def publish_presence(uid, token):
    if presence_v2(uid, token):
        return
    want = None
    friends = friends_shared(uid) and share_on()
    if (friends or self_reach(uid)) and presence_url():
        want = {"sid": pc_id(), "name": pc_name(), "url": presence_url(), "pin": share_tls["pin"],
                "lan": lan_url(), "friends": friends}
    key = str(uid)
    with config_lock:
        had = (config.get("presence") or {}).get(key)
    if want == had:
        return
    if want:
        accounts.call("PUT", "/servers", want, token)
    elif had:
        accounts.call("DELETE", f"/servers/{pc_id()}", token=token)
    with config_lock:
        pres = config.setdefault("presence", {})
        if want:
            pres[key] = want
        else:
            pres.pop(key, None)
        save_config()


def sync_friends(uid, token):
    """Dentro la sincronizzazione dell'account: amici, collegamenti ai loro server,
    chi puo' entrare qui, il proprio indirizzo nella rubrica."""
    try:
        res = accounts.call("GET", "/friends", token=token)
    except accounts.CloudError as ex:
        if ex.status != 404:
            raise
        friends_cloud[uid] = {"at": time.time(), "friends": [], "supported": False}
        return                   # servizio account di prima: niente amici dell'account
    lst = [f for f in res.get("friends") or [] if isinstance(f, dict) and isinstance(f.get("id"), int)]
    friends_cloud[uid] = {"at": time.time(), "friends": lst, "supported": True,
                          "mine": [{"sid": str(s.get("sid") or ""), "name": str(s.get("name") or "")}
                                   for s in res.get("mine") or [] if isinstance(s, dict)]}
    ok = [f for f in lst if f.get("status") == "ok"]
    # 1. I collegamenti ai server degli amici
    wanted = {}
    for fr in ok:
        servers = [s for s in fr.get("servers") or [] if isinstance(s, dict) and s.get("sid") != pc_id()]
        for s in servers:
            try:
                url = friend_address(s.get("url"))
            except HTTPException:
                continue
            if not re.fullmatch(r"[0-9a-f]{64}", str(s.get("pin") or "")):
                continue
            name = str(fr.get("username") or "Amico") + (" · " + str(s["name"]) if len(servers) > 1 and s.get("name") else "")
            wanted[(fr["id"], s["sid"])] = {"name": name[:30], "url": url, "pin": s["pin"], "lan": ""}
    # 1b. Gli altri PC del tuo account (accesi e raggiungibili): le tue raccolte da lì
    me = res.get("me")
    mine_ok = isinstance(me, int) and not isinstance(me, bool) and self_reach(uid)
    if mine_ok:
        for s in res.get("mine") or []:
            if not isinstance(s, dict) or not re.fullmatch(r"[0-9a-f]{8}", str(s.get("sid") or "")) \
                    or s["sid"] == pc_id() or not re.fullmatch(r"[0-9a-f]{64}", str(s.get("pin") or "")):
                continue
            try:
                url = friend_address(s.get("url"))
            except HTTPException:
                continue
            try:
                lan_ = friend_address(s.get("lan")) if str(s.get("lan") or "").startswith("https://") else ""
            except HTTPException:
                lan_ = ""
            wanted[(me, s["sid"])] = {"name": str(s.get("name") or "Il tuo altro PC")[:30], "url": url,
                                      "pin": s["pin"], "lan": lan_, "self": True}
    for f in get_friends():
        if f.get("via") != "account" or f.get("owner") != uid:
            continue
        w = wanted.pop((f.get("fid"), f.get("sid")), None)
        if w is None:
            friend_drop(f["n"])          # non piu' amici (o quel server non condivide piu')
        elif (w["url"], w["pin"], w["name"], w["lan"]) != (f["url"], f.get("pin"), f["name"], f.get("lan") or ""):
            fields = {"url": w["url"], "name": w["name"], "lan": w["lan"]}
            if w["pin"] != f.get("pin"):
                fields.update(pin=w["pin"], token="")
            friend_set(f["n"], **fields)
            friend_status.pop(f["n"], None)
    for (fid, sid), w in wanted.items():
        if len(get_friends()) >= FRIEND_MAX:
            break
        extra = {"via": "account", "owner": uid, "fid": fid, "sid": sid}
        if w.get("self"):
            extra.update(self=True, lan=w["lan"])
        friend_store(w["name"], w["url"], "", "", None, w["pin"], extra=extra)
        tailnet_wake.set()               # per arrivare da lui serve Tailscale anche qui
    # 2. Chi entra qui con l'account: solo gli amici di adesso
    ids = {f["id"] for f in ok}
    if mine_ok:
        ids.add(me)                      # i tuoi altri PC
    con = db(raw=True)
    try:
        gone = [r["id"] for r in con.execute("SELECT id, cloud_from FROM accounts WHERE profile=?", (uid,))
                if r["cloud_from"] not in ids]
    finally:
        con.close()
    for a in gone:
        account_drop(a)
    # 2b. Gli amici entrati qui come ospiti: se il proprietario non e' piu' loro amico, fuori
    if uid == server_owner():
        friends_ok = {f["id"] for f in ok}
        con = db(raw=True)
        try:
            out = [r["id"] for r in con.execute("SELECT id, cloud_id FROM users WHERE guest=1")
                   if r["cloud_id"] not in friends_ok]
            for gid in out:
                con.execute("UPDATE users SET guest=0 WHERE id=?", (gid,))
                con.execute("DELETE FROM user_sessions WHERE user_id=?", (gid,))
            con.commit()
        finally:
            con.close()
        if out:
            user_cache.clear()
    # 3. Il proprio indirizzo nella rubrica (se il profilo condivide)
    publish_presence(uid, token)


def friend_ticket_login(f):
    """Entra dal server di un amico dell'account con un biglietto del servizio account."""
    con = db(raw=True)
    try:
        p = con.execute("SELECT token FROM users WHERE id=? AND token IS NOT NULL", (f.get("owner"),)).fetchone()
    finally:
        con.close()
    if not p:
        raise FriendDown("ridai la password del tuo account per vedere gli amici")
    try:
        ticket = accounts.call("POST", "/tickets", {"to": f["fid"], "sid": f["sid"]}, p["token"]).get("ticket")
    except accounts.CloudOffline:
        raise FriendDown("niente Internet")
    except accounts.CloudError as ex:
        raise FriendDown(ex.detail, ex.status)
    got = friend_json({"url": f["url"], "lan": f.get("lan") or "", "pin": f.get("pin"), "token": ""}, "/ticket", 8,
                      {"ticket": ticket, "to": f["fid"]})
    if not isinstance(got, dict) or not isinstance(got.get("token"), str) or not got["token"]:
        raise FriendDown("risposta non valida")
    f["token"] = got["token"]
    friend_set(f["n"], token=got["token"])


def self_pc(n):
    """Un altro PC del tuo account (collegamento «I tuoi PC»), o 404."""
    f = friend_by_n(n)
    u = CURRENT.get()
    if not f or not f.get("self") or u is None or f.get("owner") != u["id"]:
        raise HTTPException(404, "PC non trovato")
    return f


def self_pc_json(f, path, body=None, timeout=8):
    if not f.get("token"):
        friend_ticket_login(f)
    try:
        return friend_json(f, path, timeout, body)
    except FriendDown as ex:
        if ex.code != 401:
            raise
        friend_ticket_login(f)           # gettone non piu' valido: biglietto nuovo
        return friend_json(f, path, timeout, body)


def self_pc_update(n, action=""):
    """Aggiornamento di un altro tuo PC, chiesto da qui: risponde lui, e solo se
    su quel PC sei tu il padrone (altrimenti can_update e' falso)."""
    f = self_pc(n)
    try:
        return self_pc_json(f, "/update" + ("/" + action if action else ""), {} if action else None,
                            timeout=20 if action == "check" else 8)
    except HTTPException as ex:
        if ex.status_code == 404:        # quel PC ha una versione di prima: da qui non si aggiorna
            return {"can_update": False, "enabled": False, "old": True}
        raise
    except FriendDown as ex:
        if ex.code == 403:
            return {"can_update": False, "enabled": False}
        if ex.code == 404:
            return {"can_update": False, "enabled": False, "old": True}
        raise HTTPException(409 if ex.code == 409 else 502, str(ex))


@app.get("/api/my-pcs/{n}/update")
async def my_pc_update(n: int):
    return await in_thread(self_pc_update, n)


@app.post("/api/my-pcs/{n}/update/{action}")
async def my_pc_update_action(n: int, action: str):
    if action not in ("check", "install"):
        raise HTTPException(404, "Azione sconosciuta")
    return await in_thread(self_pc_update, n, action)


def profile_token():
    u = CURRENT.get()
    if u is None or not u["linked"]:
        raise HTTPException(400, "Per gli amici dell'account entra con un account")
    con = db(raw=True)
    try:
        r = con.execute("SELECT token FROM users WHERE id=?", (u["id"],)).fetchone()
    finally:
        con.close()
    if not r or not r["token"]:
        raise HTTPException(401, "Ridai la password del tuo account (Impostazioni → Account)")
    return u["id"], r["token"]


async def friends_cloud_call(method, path, body=None):
    uid, token = profile_token()
    res = await cloud(method, path, body, token)
    try:
        await asyncio.to_thread(sync_friends, uid, token)
    except Exception as ex:
        print("Amici dell'account:", repr(ex), flush=True)
    return res


@app.get("/api/account-friends")
async def account_friends():
    u = CURRENT.get()
    if u is None or not u["linked"]:
        return {"linked": False}
    info = friends_cloud.get(u["id"])
    if info is None or time.time() - info["at"] > 60:
        try:                         # prima apertura: si chiede subito al servizio
            uid, token = profile_token()
            await asyncio.to_thread(sync_friends, uid, token)
        except Exception:
            pass
        info = friends_cloud.get(u["id"]) or {}
    local = {(f.get("fid"), f.get("sid")): f for f in get_friends() if f.get("via") == "account"}
    out = []
    for fr in info.get("friends") or []:
        servers = []
        for s in fr.get("servers") or []:
            lf = local.get((fr["id"], s.get("sid")))
            st = (friend_status.get(lf["n"]) if lf else None) or {}
            servers.append({"name": str(s.get("name") or ""), "online": st.get("online"), "sid": s.get("sid"),
                            "error": st.get("error") or "", "n": lf["n"] if lf else None})
        out.append({"id": fr["id"], "username": fr.get("username") or "", "status": fr.get("status"),
                    "servers": servers})
    mine = []
    for s in info.get("mine") or []:
        if s["sid"] == pc_id():
            continue
        lf = next((f for f in local.values() if f.get("self") and f.get("sid") == s["sid"]), None)
        st = (friend_status.get(lf["n"]) if lf else None) or {}
        mine.append({"name": s["name"], "online": st.get("online"), "error": st.get("error") or "",
                     "route": st.get("route") or "", "n": lf["n"] if lf else None})
    return {"linked": True, "supported": info.get("supported"), "loaded": bool(info), "friends": out,
            "mine": mine, "self_reach": self_reach(u["id"]), "reachable": bool((config.get("presence") or {}).get(str(u["id"]))),
            "sharing": friends_shared(u["id"]), "address": presence_url(), "pc": pc_name(),
            "published": bool((config.get("presence") or {}).get(str(u["id"]))),
            "share_on": share_on()}


# ---- I dispositivi dell'account nella rete di BunkerPlex (al massimo 4: lo decide
# il servizio account). Da qui si vedono e si tolgono; se questo PC non entra perche'
# sono gia' 4, l'interfaccia chiede quale togliere e il PC entra al suo posto.

@app.get("/api/devices")
async def devices_list():
    _, token = profile_token()
    res = await cloud("GET", "/tailscale/devices", None, token)
    me = "bunkerplex-" + pc_id()
    for d in res.get("devices") or []:
        d["this"] = d.get("host") == me
    res["waiting"] = tailnet["limit"] is not None      # questo PC aspetta un posto
    return res


@app.delete("/api/devices/{dev_id}")
async def devices_remove(dev_id: str):
    if not re.fullmatch(r"[A-Za-z0-9]{1,40}", dev_id):
        raise HTTPException(400, "Richiesta non valida")
    _, token = profile_token()
    res = await cloud("DELETE", f"/tailscale/devices/{dev_id}", None, token)
    if tailnet["limit"] is not None:     # si e' liberato un posto: questo PC riprova subito
        tailnet_wake.set()
    return res


@app.post("/api/devices/replace")
async def devices_replace(request: Request):
    """Questo PC entra nella rete al posto del dispositivo scelto (che viene tolto)."""
    dev_id = str((await read_json(request)).get("id") or "")
    if not re.fullmatch(r"[A-Za-z0-9]{1,40}", dev_id):
        raise HTTPException(400, "Richiesta non valida")
    profile_token()
    tailnet["replace"] = dev_id
    tailnet_wake.set()
    for _ in range(60):                  # si aspetta l'esito (al massimo mezzo minuto)
        await asyncio.sleep(0.5)
        if not tailnet["replace"]:
            break
    if tailnet["limit"] is not None:
        raise HTTPException(409, tailnet["error"] or "Il PC non è ancora entrato nella rete")
    return {"ok": True}


@app.post("/api/account-friends")
async def account_friends_add(request: Request):
    name = str((await read_json(request)).get("username") or "").strip()
    if not name:
        raise HTTPException(400, "Scrivi il nome dell'account del tuo amico")
    return await friends_cloud_call("POST", "/friends", {"username": name})


@app.post("/api/account-friends/{fid}/accept")
async def account_friends_accept(fid: int):
    return await friends_cloud_call("POST", f"/friends/{fid}/accept")


@app.delete("/api/account-friends/{fid}")
async def account_friends_remove(fid: int):
    return await friends_cloud_call("DELETE", f"/friends/{fid}")


@app.post("/api/account-friends/share")
async def account_friends_share(request: Request):
    """Condividi le tue raccolte con i tuoi amici: accende anche la porta degli amici."""
    uid, token = profile_token()
    on = bool((await read_json(request)).get("on"))
    put_user_setting(uid, "friends_share", on)
    if on and not share_on():
        with config_lock:
            config.setdefault("share", {})["on"] = True
            save_config()
        asked = time.time()
        portmap_wake.set()
        tailnet_wake.set()
        for _ in range(40):          # si aspetta un attimo il router o Tailscale: l'indirizzo va pubblicato
            if portmap["at"] >= asked or tailnet_on() or (config.get("share") or {}).get("manual"):
                break
            await asyncio.sleep(0.25)
    try:
        await asyncio.to_thread(sync_friends, uid, token)
    except Exception as ex:
        print("Amici dell'account:", repr(ex), flush=True)
    return {"ok": True, "address": presence_url()}


@app.post("/api/account-friends/self")
async def account_friends_self(request: Request):
    """I tuoi altri PC: da qui vedi le loro raccolte e loro vedono quelle di qui."""
    uid, token = profile_token()
    on = bool((await read_json(request)).get("on"))
    put_user_setting(uid, "self_reach", on)
    tailnet_wake.set()
    if on:
        for _ in range(40):          # si aspetta un attimo Tailscale: l'indirizzo va pubblicato
            if tailnet_on() or (config.get("share") or {}).get("manual"):
                break
            await asyncio.sleep(0.25)
    try:
        await asyncio.to_thread(sync_friends, uid, token)
    except Exception as ex:
        print("Amici dell'account:", repr(ex), flush=True)
    return {"ok": True}


@app.post("/api/pc-name")
async def set_pc_name(request: Request):
    """Il nome di questo PC per gli amici (quando un account ha piu' PC che condividono)."""
    manager_only()
    name = re.sub(r"\s+", " ", str((await read_json(request)).get("name") or "")).strip()[:30]
    with config_lock:
        config["pc_name"] = name
        save_config()
    sync_soon()                      # l'indirizzo nella rubrica si aggiorna col nome nuovo
    return {"ok": True, "pc": pc_name()}


@app.get("/BunkerPlex.apk")
def apk():
    """L'app Android, per installarla la prima volta da un telefono o una TV di casa
    (poi si aggiorna da sola dalle sue release su GitHub). Se il PC non ne ha
    ancora una copia la prende adesso."""
    if not APK_PATH.is_file() and not updater.refresh_apps(force=True):
        raise HTTPException(404, "App non ancora sul PC: riprova tra qualche minuto")
    return FileResponse(APK_PATH, media_type="application/vnd.android.package-archive",
                        filename="BunkerPlex.apk")


@app.get("/BunkerPlexTV.apk")
def tv_apk():
    """L'app TV nativa, per installarla la prima volta (poi si aggiorna da sola da GitHub)."""
    if not TV_APK_PATH.is_file():
        updater.refresh_apps(force=True)
    if not TV_APK_PATH.is_file():
        raise HTTPException(404, "App TV nativa non ancora sul PC")
    return FileResponse(TV_APK_PATH, media_type="application/vnd.android.package-archive",
                        filename="BunkerPlexTV.apk")


# ---- Indirizzi del PC e QR per scaricare l'app --------------------------------

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "[::1]"}
public_ip = {"ip": "", "source": "", "at": 0.0}


def private_ip(host_header=""):
    """L'indirizzo di questo PC nella rete di casa: quello con cui e' stata aperta
    la pagina (se non e' localhost), poi quello che passa «Avvia», poi quello
    imparato dai dispositivi di casa."""
    host = (host_header or "").rsplit(":", 1)[0].strip("[]")
    if host and host not in LOCAL_HOSTS and re.fullmatch(r"[\d.]{7,15}", host):
        return host
    env = os.environ.get("BUNKERPLEX_LAN_IP", "").strip()
    if re.fullmatch(r"[\d.]{7,15}", env):
        return env
    return lan["ip"]


def find_public_ip():
    """L'indirizzo con cui la casa esce su Internet: lo dice il router (se la porta
    per gli amici e' aperta), altrimenti il servizio account. Ricordato 10 minuti."""
    if portmap.get("ok") and portmap.get("ip"):
        public_ip.update(ip=portmap["ip"], source="router", at=time.time())
        return public_ip
    if time.time() - public_ip["at"] < 600 and public_ip["ip"]:
        return public_ip
    try:
        ip = str(accounts.call("GET", "/ip", timeout=6).get("ip") or "")
        if re.fullmatch(r"[\d.]{7,15}|[0-9a-fA-F:]{3,45}", ip):
            public_ip.update(ip=ip, source="servizio account", at=time.time())
    except Exception:
        pass
    return public_ip


@app.get("/api/network")
async def network(request: Request):
    pub = await asyncio.to_thread(find_public_ip)
    return {"private": private_ip(request.headers.get("host", "")), "port": 32500,
            "public": pub["ip"], "public_source": pub["source"],
            "friends_port": SHARE_PORT, "friends_open": bool(portmap.get("ok") and portmap.get("public")),
            "tailnet": tailnet["ip"] if tailnet_on() else "",
            # Il Tailscale installato sul computer: da li' i tuoi dispositivi entrano anche dal browser
            "tailscale": tailscale_ip()}


@app.get("/api/apk-link")
def apk_link(request: Request):
    """L'indirizzo per scaricare l'app da un telefono di casa, con il suo QR (SVG)."""
    host = request.headers.get("host", "")
    port = host.rsplit(":", 1)[1] if ":" in host and not host.endswith("]") else "32500"
    if not APK_PATH.is_file():       # la copia per la prima installazione arriva tra poco
        threading.Thread(target=updater.refresh_apps, kwargs={"force": True}, daemon=True).start()
    ip = private_ip(host)
    if not ip:
        return {"url": "", "svg": "", "apk": APK_PATH.is_file()}
    url = f"http://{ip}:{port}/BunkerPlex.apk"
    svg = ""
    try:
        import io
        import segno
        buf = io.BytesIO()
        segno.make(url, error="m").save(buf, kind="svg", scale=1, border=2, dark="#060a07",
                                        light="#f2f5f2", xmldecl=False, omitsize=True, nl=False)
        svg = buf.getvalue().decode("utf-8")
    except Exception as ex:          # pacchetto non ancora installato (immagine vecchia)
        print("QR non disponibile:", repr(ex), flush=True)
    return {"url": url, "svg": svg, "apk": APK_PATH.is_file()}


# Installare l'app sulle TV di casa dal PC, con il debug di rete (server/tvinstall.py)
tvinstall.setup(private_ip, apk_version, APK_PATH, VERSION)
app.include_router(tvinstall.router)


# ---- «Guarda su»: TV DLNA (Samsung, LG...) e Chromecast, senza app (server/cast.py) ----

cast_host = {"h": ""}                 # l'ultimo indirizzo di casa con cui e' stata aperta la pagina
CAST_NO_DTS = ("dts", "truehd", "mlp")   # audio che le TV di oggi non leggono piu' (Samsung dal 2018)


def tmdb_art(name, w=342):
    """Locandina presa da TMDB: la TV non ha l'accesso per /api/image."""
    m = re.match(r"(w\d+|original)_(.+)$", name or "")
    return f"https://image.tmdb.org/t/p/w{w}/{m.group(2)}" if m else ""


def cast_media(user, item_id, kind):
    if item_id >= FRIEND_BASE:
        raise cast.CastError("«Guarda su» per ora funziona con i tuoi titoli, non con quelli degli amici")
    tok = CURRENT.set(user)
    con = db()
    try:
        r = get_item(con, item_id)
        gone = missing_file(r["path"])
        if gone:
            raise cast.CastError(gone["message"])
        show = get_show(con, r["show_id"]) if r["show_id"] else None
        title, subtitle, poster = r["title"] or "", str(r["year"] or ""), r["poster"]
        if r["kind"] == "episode":
            title = show["title"] if show else title
            subtitle = f"S{r['season']} · E{r['episode']}  {r['title'] or ''}".strip()
            poster = show["poster"] if show else None
        ext = Path(r["path"]).suffix.lower()
        vc, ac, pix = r["vcodec"] or "", r["acodec"] or "", r["pix"] or ""
        h264 = vc == "h264" and pix in ("yuv420p", "yuvj420p")
        if kind == "app":
            plan = {"mode": "direct"}      # l'app sulla TV apre il titolo col suo player, come sempre
        elif kind == "dlna":
            # Le TV leggono da sole MKV, HEVC, HDR e quasi ogni audio: il file com'e'.
            # Solo DTS e TrueHD si convertono (in AC3), lasciando il video originale.
            plan = ({"mode": "transcode", "vcopy": 1, "aout": "ac3"} if ac in CAST_NO_DTS
                    else {"mode": "direct"})
        else:
            # Chromecast: MP4/WebM con H.264 o VP9 e audio AAC; il resto si converte
            ok = (ext in (".mp4", ".m4v", ".webm") and (h264 or vc in ("vp8", "vp9"))
                  and ac in ("aac", "mp3", "opus", "vorbis", ""))
            plan = {"mode": "direct"} if ok else {"mode": "transcode", "vcopy": 1 if h264 else 0, "aout": "aac"}
        direct = plan["mode"] == "direct"
        nxt = next_episode(con, r)
        return {
            "title": title, "subtitle": subtitle, "duration": r["duration"] or 0,
            "size": os.path.getsize(r["path"]) if direct else 0,
            "mime": (MIME.get(ext) or mimetypes.guess_type(r["path"])[0] or "video/mp4") if direct else "video/mp4",
            "ext": ext if direct else ".mp4", "seekable": direct, "plan": plan,
            "poster": tmdb_art(poster), "poster_path": img_url(poster) or "",
            "resume": 0 if r["watched"] else float(r["position"] or 0),
            "next_title": f"S{nxt['season']} · E{nxt['episode']}" if nxt else "",
        }
    finally:
        con.close()
        CURRENT.reset(tok)


def cast_save(user, item_id, pos, dur, ended):
    tok = CURRENT.set(user)
    try:
        return save_progress(item_id, pos, dur, ended)["watched"]
    finally:
        CURRENT.reset(tok)


def cast_next(user, item_id):
    tok = CURRENT.set(user)
    con = db()
    try:
        nxt = next_episode(con, get_item(con, item_id))
        return nxt["id"] if nxt else 0
    finally:
        con.close()
        CURRENT.reset(tok)


def cast_lan_ip():
    return private_ip(cast_host["h"])


def cast_note_host(request):
    host = (request.headers.get("host") or "").rsplit(":", 1)[0]
    try:
        if ipaddress.ip_address(host).is_private and not ipaddress.ip_address(host).is_loopback:
            cast_host["h"] = host
    except ValueError:
        pass


cast.setup(cast_lan_ip, cast_media, cast_save, cast_next)


def cast_user():
    u = CURRENT.get()
    if not u:
        raise HTTPException(401, "Scegli chi guarda per continuare")
    return u


@app.get("/api/cast/devices")
def cast_devices(request: Request, refresh: int = 0):
    cast_note_host(request)
    cast_user()
    found = cast.scan(force=bool(refresh))
    return {"devices": found, "error": cast._scan["error"]}


@app.post("/api/cast/start")
async def cast_start(request: Request):
    cast_note_host(request)
    u = cast_user()
    body = await read_json(request)
    at = body.get("at")
    try:
        return await in_thread(cast.start, u, str(body.get("device") or ""), int(body.get("item") or 0),
                               None if at is None else float(at))
    except cast.CastError as ex:
        raise HTTPException(400, str(ex))


@app.post("/api/cast/control")
async def cast_control(request: Request):
    u = cast_user()
    body = await read_json(request)
    try:
        return await in_thread(cast.control, u["id"], str(body.get("device") or ""),
                               str(body.get("action") or ""), body.get("to"))
    except cast.CastError as ex:
        raise HTTPException(400, str(ex))


@app.post("/api/cast/app/poll")
async def cast_app_poll(request: Request):
    """La TV con l'app BunkerPlex (pagine o player) si fa viva: stato e comandi."""
    cast_user()
    return {"commands": await cast.app_poll(await read_json(request))}


@app.get("/api/cast/status")
def cast_status():
    return {"sessions": cast.status(cast_user()["id"])}


@app.api_route("/api/cast/media/{ticket}/{rest:path}", methods=["GET", "HEAD"])
def cast_media_file(ticket: str, rest: str, request: Request):
    """Il video per la TV di «Guarda su»: aperto, ma solo con il biglietto giusto."""
    tk = cast.ticket(ticket)
    if not tk:
        raise HTTPException(404)
    plan = tk["plan"]
    direct = plan["mode"] == "direct"
    dlna = {"contentFeatures.dlna.org": cast.dlna_flags(direct), "transferMode.dlna.org": "Streaming"}
    if not direct and request.method == "HEAD":
        return Response(status_code=200, media_type="video/mp4", headers=dlna)
    tok = CURRENT.set(tk["user"])
    try:
        if direct:
            resp = stream(tk["item"], request)
        else:
            m = re.match(r"(\d+)/", rest)
            resp = run_transcode(tk["item"], float(m.group(1)) if m else 0.0,
                                 plan["vcopy"], 0, aout=plan["aout"])
    finally:
        CURRENT.reset(tok)
    resp.headers.update(dlna)
    return resp


class UIFiles(StaticFiles):
    """L'interfaccia va sempre ricontrollata: dopo un aggiornamento del server
    browser e TV non devono restare con la versione vecchia in memoria."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


app.mount("/", UIFiles(directory=Path(__file__).parent / "static", html=True), name="ui")
