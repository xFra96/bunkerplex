"""BunkerPlex - media server casalingo.

Scansiona le cartelle di Film e Serie TV, cataloga tutto in SQLite
(locandine, trama, anno, regista, generi, cast, voto da TMDB) e manda
i video in streaming.
"""
import asyncio
import difflib
import gzip
import hashlib
import hmac
import http.client
import ipaddress
import json
import math
import mimetypes
import os
import re
import secrets
import shutil
import socket
import sqlite3
import ssl
import struct
import subprocess
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
import updater
from accounts import CURRENT

# Entrato offline senza account (PC dove nessun account e' mai entrato): tutto come prima degli account
GUEST = contextvars.ContextVar("bunkerplex_guest", default=False)

VERSION = "1.2"
DATA = Path(os.environ.get("DATA_DIR", "/data"))
TMDB_LANG = os.environ.get("TMDB_LANG", "it-IT")
SCAN_INTERVAL_MIN = int(os.environ.get("SCAN_INTERVAL_MIN", "30") or 30)
SERVER_NAME = os.environ.get("SERVER_NAME", "BunkerPlex")

IMG = DATA / "images"
# Il catalogo (questa cartella) viaggia sul disco insieme ai video: "Avvia
# BunkerPlex.bat" ci mette un segnaposto prima di accendere il server. Se il
# segnaposto manca, il disco non e' collegato a Docker: invece di creare un
# catalogo vuoto da un'altra parte, il server si ferma e lo dice.
MARKER = DATA / ".francoplex"


def data_problem():
    if os.environ.get("DATA_CHECK", "1") != "0" and not MARKER.is_file():
        return ("Il disco con il catalogo non è collegato al server. "
                "Collegalo e rilancia «Avvia BunkerPlex.bat» sul PC.")
    try:
        IMG.mkdir(parents=True, exist_ok=True)
        test = DATA / ".scrittura"
        test.write_text("ok")
        test.unlink()
    except OSError:
        return ("Non riesco a scrivere nella cartella del catalogo. "
                "Rilancia «Avvia BunkerPlex.bat» sul PC.")
    return ""


DATA_PROBLEM = data_problem()
DB_PATH = DATA / "francoplex.db"
CONFIG_PATH = DATA / "config.json"
SUBS_DIR = DATA / "subs"            # sottotitoli scaricati da internet, uno per lingua e video
APK_PATH = Path(os.environ.get("APK_PATH", "/apk/FrenkPlex.apk"))

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

# I dischi del PC sono montati in sola lettura sotto /host (es. /host/C, /host/G):
# lo fa "Avvia BunkerPlex.bat". Da li' l'app puo' sfogliare e scegliere le cartelle.
HOST_ROOT = Path(os.environ.get("HOST_ROOT", "/host"))
HIDDEN_DIRS = {"system volume information", "config.msi", "recovery", "perflogs",
               "documents and settings", "msocache"}
config_lock = threading.Lock()


def save_config():
    # Prima su un file a parte, poi lo scambio: se il disco viene staccato a
    # meta' scrittura non resta un config.json troncato.
    tmp = CONFIG_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(config, ensure_ascii=False, indent=1), "utf-8")
    os.replace(tmp, CONFIG_PATH)


def has_content(path):
    try:
        return path.is_dir() and any(path.iterdir())
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
    if u is not None:
        out = [lib for lib in out if lib.get("owner") == u["id"] or lib.get("shared")]
        for lib in out:
            lib["mine"] = lib.get("owner") == u["id"]
    return out


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


def browse_path(raw):
    """Accetta solo percorsi dentro i dischi montati."""
    p = Path(os.path.normpath(raw)) if raw else HOST_ROOT
    if p != HOST_ROOT and HOST_ROOT not in p.parents:
        raise HTTPException(400, "Percorso non valido")
    return p


def moved_folder(path):
    """Se la cartella non e' piu' dove era stata scelta, la cerca con lo stesso
    percorso sugli altri dischi collegati: su questo PC il disco puo' avere
    un'altra lettera (da G: a H:, stesso percorso). None se non la trova."""
    p = Path(path)
    try:
        parts = p.relative_to(HOST_ROOT).parts
        drives = sorted(d for d in HOST_ROOT.iterdir() if d.is_dir())
    except (ValueError, OSError):
        return None
    if len(parts) < 2:
        return None
    for drive in drives:
        candidate = drive.joinpath(*parts[1:])
        if drive.name.lower() != parts[0].lower() and has_content(candidate):
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
                                     "Chiudi e riavvia con «Avvia BunkerPlex.bat»")
        rest = (m.group(2) or "").replace("\\", "/").strip("/")
        path = browse_path(str(drive / rest) if rest else str(drive))
    else:
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
    uid = int(u["id"])
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
                          ("user_sessions", "offline INT DEFAULT 0")):
        if column.split()[0] not in {r[1] for r in con.execute(f"PRAGMA table_info({table})")}:
            con.execute(f"ALTER TABLE {table} ADD COLUMN {column}")
    con.execute("CREATE INDEX IF NOT EXISTS items_collection ON items(collection_id)")
    con.execute("CREATE INDEX IF NOT EXISTS items_tmdb ON items(tmdb_id)")
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
               re.compile(r"(?<!\d)(\d{1,2})x(\d{2,3})(?!\d)")]
SEASON_DIR = re.compile(r"^(?:(?:season|stagione|staffel|serie|s)\s*(\d{1,2})|specials?|speciali)$", re.I)
SEASON_TAIL = re.compile(r"\s+(?:s\d{1,2}|(?:season|stagione|staffel|serie)\s*\d{1,2}|complet[ae])\b.*$", re.I)
EP_WORD = re.compile(r"(?:^|[\s._\-\[(])(?:ep|episodio|episode|puntata)[\s._-]*(\d{1,3})(?!\d)", re.I)


def clean(s):
    s = re.sub(r"\[[^\]]*\]", " ", s)
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


def numbered_series(folder, cache):
    """Riconosce le serie numerate senza S01E01: almeno tre file della stessa
    cartella con lo stesso nome seguito da un numero ('Dragon Ball 001 ...',
    'Dragon Ball 002 ...'). Per non scambiare una saga di film ('Rocky 1, 2, 3')
    per una serie, guarda anche la durata: gli episodi durano meno di 55 minuti.
    Restituisce {nome file: (serie, numero, resto del nome)}."""
    key = "seq:" + str(folder)
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
        if all(0 < d < 55 * 60 for d in lengths):
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
            season_dir = int(m.group(1)) if m.group(1) else 0

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
            numbered = numbered_series(path.parent, cache).get(path.name)
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
    elif year is None:
        # Il nome del file non ha l'anno, ma la cartella della stessa serie si':
        # 'Dragon Ball (1986) 1080p/Dragon Ball 1x001.mkv' -> anno 1986.
        # Distingue serie omonime (Dragon Ball del 1986 da Dragon Ball Z del 1989).
        for t, y in folder_titles(folders):
            if y and show_key(t) == show_key(title):
                year = y
                break
    return (title.strip(" -") or title), year, season, episode, ep_title


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
    row = con.execute("SELECT poster, year, title FROM items WHERE id=?", (item_id,)).fetchone()
    poster = row["poster"] if (row["poster"] or "").startswith("local_") \
        else fetch_image(m.get("poster_path"), "w500")
    con.execute(
        "UPDATE items SET title=?, original_title=?, year=?, overview=?, tagline=?, poster=?, "
        "backdrop=?, tmdb_id=?, genres=?, director=?, actors=?, rating=?, people=?, meta_done=1 WHERE id=?",
        (m.get("title") or row["title"], m.get("original_title"),
         _year(m.get("release_date"), row["year"]), overview, m.get("tagline") or "",
         poster, fetch_image(m.get("backdrop_path"), "w1280"), m["id"],
         json.dumps([g["name"] for g in m.get("genres", [])], ensure_ascii=False),
         ", ".join(directors), json.dumps(actors, ensure_ascii=False),
         round(m.get("vote_average") or 0, 1), cast_people(credits), item_id))
    set_collection(con, item_id, m)


def apply_show(con, show_id, tmdb_id):
    m = tmdb(f"/tv/{tmdb_id}", append_to_response="credits")
    overview = m.get("overview") or ""
    if not overview:
        try:
            overview = tmdb(f"/tv/{tmdb_id}", language="en-US").get("overview") or ""
        except Exception:
            pass
    actors = [c["name"] for c in (m.get("credits") or {}).get("cast", [])[:8]]
    row = con.execute("SELECT poster, year, title FROM shows WHERE id=?", (show_id,)).fetchone()
    poster = row["poster"] if (row["poster"] or "").startswith("local_") \
        else fetch_image(m.get("poster_path"), "w500")
    con.execute(
        "UPDATE shows SET title=?, original_title=?, year=?, overview=?, poster=?, backdrop=?, "
        "tmdb_id=?, genres=?, director=?, actors=?, rating=?, people=?, meta_done=1 WHERE id=?",
        (m.get("name") or row["title"], m.get("original_name"),
         _year(m.get("first_air_date"), row["year"]), overview, poster,
         fetch_image(m.get("backdrop_path"), "w1280"), m["id"],
         json.dumps([g["name"] for g in m.get("genres", [])], ensure_ascii=False),
         ", ".join(c["name"] for c in m.get("created_by", [])),
         json.dumps(actors, ensure_ascii=False),
         round(m.get("vote_average") or 0, 1), cast_people(m.get("credits")), show_id))
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


def find_show(con, show):
    row = con.execute("SELECT path FROM items WHERE show_id=? ORDER BY path LIMIT 1",
                      (show["id"],)).fetchone()
    extra = [c for c in folder_candidates(row["path"]) if show_key(c[0]) != show_key(show["title"])] \
        if row else []
    return find_tmdb("show", show["title"], show["year"], extra)


def find_movie(r):
    return find_tmdb("movie", r["title"], r["year"])


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
    for r in rows:
        n = r["episode"]
        if n <= counts[0][1] or n > total:
            continue
        for season, count in counts:
            if n <= count:
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
                    "UPDATE items SET title=?, overview=?, poster=?, tmdb_id=?, rating=?, meta_done=1 WHERE id=?",
                    (name, e.get("overview"),
                     fetch_image(e.get("still_path"), "w300"), e.get("id"),
                     round(e.get("vote_average") or 0, 1), r["id"]))
            else:
                con.execute("UPDATE items SET meta_done=1 WHERE id=?", (r["id"],))
        con.commit()


# --------------------------------------------------------------------------
# Scansione libreria
# --------------------------------------------------------------------------

state = {"scanning": False, "last_scan": 0.0, "message": ""}
scan_lock = threading.Lock()


def probe(path):
    """Durata, codec e risoluzione del file."""
    info = {"duration": 0, "vcodec": "", "acodec": "", "pix": "", "width": 0, "height": 0}
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries",
             "format=duration:stream=codec_type,codec_name,pix_fmt,width,height",
             "-of", "json", path],
            capture_output=True, text=True, timeout=60).stdout
        data = json.loads(out)
        info["duration"] = float(data.get("format", {}).get("duration") or 0)
        for s in data.get("streams", []):
            if s.get("codec_type") == "video" and not info["vcodec"] \
                    and s.get("codec_name") not in ("mjpeg", "png"):
                info.update(vcodec=s.get("codec_name", ""), pix=s.get("pix_fmt", ""),
                            width=s.get("width") or 0, height=s.get("height") or 0)
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
                    con.execute(
                        "INSERT INTO items(kind, path, show_id, season, episode, title, size, added_at, library_id) "
                        "VALUES('episode',?,?,?,?,?,?,?,?)",
                        (sp, show_ids[key], season, number, ep_title, st.st_size, added, lib_id))
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
                (IMG / f"thumb_{r['id']}.jpg").unlink(missing_ok=True)
        con.execute("DELETE FROM shows WHERE id NOT IN "
                    "(SELECT DISTINCT show_id FROM items WHERE show_id IS NOT NULL)")
        con.execute("DELETE FROM aliases WHERE show_id NOT IN (SELECT id FROM shows)")
        con.commit()

        state["message"] = "Analizzo i file video..."
        for r in con.execute("SELECT id, path FROM items WHERE duration IS NULL").fetchall():
            i = probe(r["path"])
            con.execute(
                "UPDATE items SET duration=?, vcodec=?, acodec=?, pix=?, width=?, height=? WHERE id=?",
                (i["duration"], i["vcodec"], i["acodec"], i["pix"], i["width"], i["height"], r["id"]))
            con.commit()

        if tmdb_key():
            state["message"] = "Scarico locandine e schede..."
            try:
                todo = con.execute("SELECT * FROM items WHERE kind='movie' AND meta_done=0").fetchall()
                for n, r in enumerate(todo, 1):
                    state["message"] = f"Scarico locandine e schede dei film... {n} di {len(todo)}"
                    tmdb_id = r["tmdb_id"]   # gia' abbinato: si riscarica la stessa scheda
                    if not tmdb_id:
                        res = find_movie(r)
                        tmdb_id = res[0]["id"] if res else None
                    if tmdb_id:
                        apply_movie(con, r["id"], tmdb_id)
                    else:
                        con.execute("UPDATE items SET meta_done=1 WHERE id=?", (r["id"],))
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
                        apply_show(con, r["id"], tmdb_id)
                        merge_duplicate_show(con, r["id"])
                    else:
                        con.execute("UPDATE shows SET meta_done=1 WHERE id=?", (r["id"],))
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


def scan_loop():
    try:
        split_merged_shows()
    except Exception as ex:   # rete assente: si riprova al prossimo avvio
        print("Separazione serie non riuscita:", repr(ex), flush=True)
    while True:
        try:
            auto_relocate()
        except Exception as ex:
            print("Aggiornamento percorsi non riuscito:", repr(ex), flush=True)
        scan()
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
    d["fav"] = bool(r["fav"])
    d["genres"] = jlist(r["genres"])
    d["actors"] = jlist(r["actors"])
    d["poster"] = img_url(r["poster"])
    d["backdrop"] = img_url(r["backdrop"])
    d["matched"] = bool(r["tmdb_id"])
    c = con.execute(
        "SELECT COUNT(*) n, SUM(watched) w, MIN(id) first, MAX(added_at) latest, "
        "COUNT(DISTINCT season) s FROM items WHERE show_id=?", (r["id"],)).fetchone()
    d["episodes"] = c["n"]
    d["seasons_count"] = c["s"]
    d["unwatched"] = c["n"] - (c["w"] or 0)
    d["watched"] = c["n"] > 0 and d["unwatched"] == 0
    d["latest"] = c["latest"]
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


def subtitle_files(path, item_id=None):
    """I sottotitoli accanto al video e, dopo, quelli scaricati da internet
    (in data/subs/<id>/, perche' i dischi dei video sono in sola lettura).
    L'ordine conta: /api/subs/<id>/<n> li indica per posizione."""
    p = Path(path)
    out = []
    try:
        for f in sorted(p.parent.iterdir()):
            if f.suffix.lower() in SUB_EXT and f.stem.lower().startswith(p.stem.lower()):
                out.append((f, f.stem[len(p.stem):].strip(" .-_")))
    except OSError:
        pass
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
        code = (tag.split(".")[0] or "").lower()
        online = tag.endswith(".online")
        label = LANGS.get(code, code.upper() if online else (tag or "Sottotitoli"))
        subs.append({"url": f"/api/subs/{r['id']}/{i}",
                     "label": label + (" · da internet" if online else ""),
                     "lang": code[:2] if code in LANGS else "", "online": online})
    nxt = next_episode(con, r)
    saga = saga_next(con, r)
    vcodec, pix = r["vcodec"] or "", r["pix"] or ""
    direct = (Path(r["path"]).suffix.lower() in BROWSER_EXT
              and vcodec in BROWSER_VIDEO
              and (vcodec != "h264" or pix in ("yuv420p", "yuvj420p"))
              and (r["acodec"] or "") in BROWSER_AUDIO)
    return {"id": r["id"], "title": title, "subtitle": subtitle,
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


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------

app = FastAPI(title="BunkerPlex", docs_url=None, redoc_url=None)


class SmallAndFast:
    """Comprime elenchi e pagine (l'elenco di una raccolta pesa centinaia di KB:
    compresso arriva alla TV in un quinto del tempo). Video e immagini passano
    cosi' come sono: sono gia' compressi e devono restare 'saltabili'."""
    RAW = ("/api/stream", "/api/transcode", "/api/image", "/api/thumb", "/BunkerPlex.apk",
           "/FrenkPlex.apk", "/FrancoPlex.apk", "/api/share/stream", "/api/share/transcode",
           "/api/share/image", "/api/share/thumb", "/api/friend/")
    PLAYING = ("/api/stream", "/api/transcode", "/api/progress", "/api/share/stream",
               "/api/share/transcode")

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
    threading.Thread(target=scan_loop, daemon=True).start()
    updater.resume()      # l'aiutante sul PC stava aggiornando (e ha riacceso il server)?
    threading.Thread(target=updater.loop, args=(auto_update,), daemon=True).start()
    threading.Thread(target=friends_loop, daemon=True).start()
    threading.Thread(target=sync_loop, daemon=True).start()
    if SHARE_PORT:
        threading.Thread(target=share_listener, daemon=True).start()
        threading.Thread(target=portmap_loop, daemon=True).start()


# ---- Account ----------------------------------------------------------------
# Chi usa BunkerPlex entra con il suo account (creato dall'amministratore con
# una password provvisoria, da cambiare al primo accesso). Gli account stanno
# nel servizio account su Cloudflare (vedi cloud/ e accounts.py): impostazioni,
# chiavi API, visti, punti di ripresa e lista seguono la persona su ogni PC.
# Le raccolte (cartelle) restano di questo PC. Senza Internet si entra lo
# stesso con l'ultima password usata qui, e le modifiche partono dopo.

SESSION_COOKIE = "bp_session"
SETUP_FILE = DATA / "cloud-setup.json"       # chiave per creare il primo amministratore
OPEN_PATHS = ("/api/auth/", "/api/share/", "/api/info")
user_cache = {}                  # impronta del gettone -> (dati dell'account, quando letti)
settings_cache = {}              # (account, chiave) -> valore
settings_lock = threading.Lock()
sync_wake = threading.Event()
cloud_status = {"at": 0.0, "ready": None}


def auth_on():
    return bool(accounts.cloud_url()) and not DATA_PROBLEM


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
    """L'account di un gettone (None se non vale piu'). {"guest": True} per chi
    e' entrato offline senza account (solo finche' su questo PC non ce n'e' nessuno)."""
    if not token or len(token) > 100:
        return None
    key = token_hash(token)
    known = user_cache.get(key)
    if not known or time.time() - known[1] > 30:
        con = db(raw=True)
        try:
            r = con.execute("SELECT s.user_id, s.offline, s.last_seen, u.id, u.name, u.admin, u.must_change "
                            "FROM user_sessions s LEFT JOIN users u ON u.id=s.user_id WHERE s.token=?",
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
    # Entrato offline senza password: appena il servizio risponde si deve rientrare
    if r["offline"] and cloud_link["online"] is True:
        return None
    if r["user_id"] == 0:
        return {"guest": True, "session": token}
    if r["id"] is None:
        return None
    return {"id": r["id"], "name": r["name"], "admin": bool(r["admin"]), "offline": bool(r["offline"]),
            "must_change": bool(r["must_change"]), "libs": visible_libs(r["id"]), "session": token}


def local_users_exist():
    con = db(raw=True)
    try:
        return con.execute("SELECT 1 FROM users LIMIT 1").fetchone() is not None
    finally:
        con.close()


# ---- Modalita' offline --------------------------------------------------------
# Senza Internet (o con il servizio account fermo) BunkerPlex va avanti con la
# copia dell'account salvata su questo PC: impostazioni, chiavi, visti e lista
# dell'ultima sincronizzazione. Dalla pagina di accesso si puo' anche continuare
# offline senza password. Le modifiche restano qui; quando l'account rientra con
# Internet sceglie se mandarle all'account o tenere quelle dell'account.

cloud_link = {"online": None, "at": 0.0}     # il servizio account risponde? (None: non si sa ancora)


def mark_cloud(online):
    cloud_link.update(online=online, at=time.time())


def cloud_ping():
    try:
        accounts.call("GET", "/", timeout=6)
        mark_cloud(True)
    except accounts.CloudError:
        mark_cloud(True)          # risponde, anche se con un errore
    except accounts.CloudOffline:
        mark_cloud(False)
    return cloud_link["online"]


def offline_changes(con, uid):
    """Modifiche fatte su questo PC e non ancora mandate all'account."""
    return (con.execute("SELECT COUNT(*) FROM user_items WHERE user_id=? AND dirty=1", (uid,)).fetchone()[0]
            + con.execute("SELECT COUNT(*) FROM user_shows WHERE user_id=? AND dirty=1", (uid,)).fetchone()[0]
            + con.execute("SELECT COUNT(*) FROM user_settings WHERE user_id=? AND dirty=1 "
                          "AND k NOT LIKE 'pending.%'", (uid,)).fetchone()[0])


def start_offline(con, uid):
    """Da qui in poi le modifiche di questo account restano sul PC finche' non sceglie."""
    con.execute("UPDATE users SET offline_since=? WHERE id=? AND COALESCE(offline_since, 0)=0",
                (time.time(), uid))


def offline_up(uid, token):
    """Le modifiche fatte offline vincono: vanno nell'account anche se li' c'e' qualcosa di piu' recente."""
    now = time.time()
    con = db(raw=True)
    try:
        con.execute("UPDATE user_items SET t=? WHERE user_id=? AND dirty=1", (now, uid))
        con.execute("UPDATE user_shows SET t=? WHERE user_id=? AND dirty=1", (now, uid))
        con.execute("UPDATE user_settings SET t=? WHERE user_id=? AND dirty=1 AND k NOT LIKE 'pending.%'", (now, uid))
        con.execute("UPDATE users SET offline_since=0 WHERE id=?", (uid,))
        con.commit()
    finally:
        con.close()
    sync_user(uid, token)


def offline_down(uid, token):
    """Vince l'account: le modifiche fatte offline si scartano e si riprende tutto dall'account."""
    con = db(raw=True)
    try:
        con.execute("UPDATE user_items SET position=0, watched=0, last_played=0, fav=0, t=0, dirty=0 "
                    "WHERE user_id=? AND dirty=1", (uid,))
        con.execute("UPDATE user_shows SET fav=0, t=0, dirty=0 WHERE user_id=? AND dirty=1", (uid,))
        con.execute("DELETE FROM user_settings WHERE user_id=? AND dirty=1 AND k NOT LIKE 'pending.%'", (uid,))
        con.execute("UPDATE users SET offline_since=0, state_rev=0 WHERE id=?", (uid,))
        con.commit()
    finally:
        con.close()
    with settings_lock:
        settings_cache.clear()
    sync_user(uid, token)


def settle_offline(uid, token):
    """Rientro con Internet: niente da decidere se offline non e' cambiato nulla,
    o se l'account e' ancora vuoto (allora le modifiche di qui vanno su da sole)."""
    con = db(raw=True)
    try:
        row = con.execute("SELECT offline_since FROM users WHERE id=?", (uid,)).fetchone()
        if not row or not row["offline_since"]:
            return
        changes = offline_changes(con, uid)
        if not changes:
            con.execute("UPDATE users SET offline_since=0 WHERE id=?", (uid,))
            con.commit()
            return
    finally:
        con.close()
    remote = accounts.call("GET", "/state?since=0", token=token)
    if not remote.get("rows"):
        offline_up(uid, token)


class AuthGate:
    """Con gli account accesi, le API rispondono solo a chi ha fatto l'accesso.
    Restano aperte: l'accesso stesso, la porta degli amici e /api/info (ridotta),
    che serve all'app della TV per riconoscere il server e aggiornarsi."""

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if (scope["type"] != "http" or not auth_on()
                or (scope.get("server") or ("", 0))[1] == SHARE_PORT):
            await self.inner(scope, receive, send)
            return
        path = scope["path"]
        user = session_user(session_token(scope))
        guest = bool(user and user.get("guest"))
        if guest and local_users_exist():      # ora ci sono account: si entra con quelli
            user, guest = None, False
        ctx = CURRENT.set(None if guest else user)
        gctx = GUEST.set(guest)
        try:
            if path.startswith("/api/") and not path.startswith(OPEN_PATHS) and not guest:
                if user is None:
                    await self._reply(send, 401, "Accedi con il tuo account per continuare")
                    return
                if user["must_change"]:
                    await self._reply(send, 403, "Prima cambia la password provvisoria")
                    return
            await self.inner(scope, receive, send)
        finally:
            GUEST.reset(gctx)
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
            cloud_status["ready"] = bool(accounts.call("GET", "/", timeout=6).get("ready"))
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
    return {"id": u["id"], "name": u["name"], "admin": bool(u["admin"]), "must_change": bool(u["must_change"])}


def login_fields(body, key="password"):
    name = str(body.get("username") or "").strip()
    password = str(body.get(key) or "")
    if not name or not password:
        raise HTTPException(400, "Scrivi nome utente e password")
    return name, password


def check_new_password(password):
    if len(password) < 8:
        raise HTTPException(400, "La password deve avere almeno 8 caratteri")
    if len(password) > 200:
        raise HTTPException(400, "Password troppo lunga")


def with_session(data, token):
    resp = JSONResponse(data)
    resp.set_cookie(SESSION_COOKIE, token, max_age=365 * 86400, httponly=True, samesite="lax", path="/")
    return resp


def open_session(con, uid, device, offline=False):
    token = secrets.token_urlsafe(32)
    con.execute("INSERT INTO user_sessions(token, user_id, device, created, last_seen, offline) VALUES(?,?,?,?,?,?)",
                (token_hash(token), uid, str(device or "")[:60], time.time(), time.time(), 1 if offline else 0))
    return token


def store_user(con, cloud_user, token, ver):
    """Copia locale dell'account appena entrato (con l'impronta per entrare anche offline)."""
    vsalt = secrets.token_hex(16)
    vcheck = hashlib.sha256((vsalt + ver).encode()).hexdigest()
    row = con.execute("SELECT id FROM users WHERE cloud_id=?", (cloud_user["id"],)).fetchone()
    fields = (cloud_user["username"], int(cloud_user["admin"]), int(cloud_user["must_change"]),
              token, vsalt, vcheck, time.time())
    if row:
        con.execute("UPDATE users SET name=?, admin=?, must_change=?, token=?, vsalt=?, vcheck=?, last_login=? "
                    "WHERE id=?", (*fields, row["id"]))
        uid = row["id"]
    else:
        uid = con.execute("INSERT INTO users(name, admin, must_change, token, vsalt, vcheck, last_login, "
                          "cloud_id, created) VALUES(?,?,?,?,?,?,?,?,?)",
                          (*fields, cloud_user["id"], time.time())).lastrowid
    # Chi era entrato offline senza account: da ora si entra con gli account
    con.execute("DELETE FROM user_sessions WHERE user_id=0")
    con.commit()
    user_cache.clear()
    adopt_legacy(uid)
    return uid


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
        # Visti e lista di questo PC sono come modifiche fatte offline: al primo accesso
        # si sceglie se mandarli all'account o tenere quelli dell'account
        if offline_changes(con, uid):
            start_offline(con, uid)
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
    """Una raccolta e' cambiata da questo PC: l'elenco va nell'account."""
    u = CURRENT.get()
    if u is not None:
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
    altrove, password provvisoria nuova, account eliminato): si deve rientrare."""
    con = db(raw=True)
    try:
        con.execute("UPDATE users SET token=NULL WHERE id=?", (uid,))
        con.execute("DELETE FROM user_sessions WHERE user_id=?", (uid,))
        con.commit()
    finally:
        con.close()
    user_cache.clear()


async def finish_login(res, ver, device):
    con = db(raw=True)
    try:
        uid = store_user(con, res["user"], res["token"], ver)
        token = open_session(con, uid, device)
        con.commit()
        u = con.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    finally:
        con.close()
    conflicts = []
    if not u["must_change"]:
        try:                       # impostazioni e raccolte subito; visti in sottofondo
            await asyncio.to_thread(pull_settings, uid, res["token"])
            await asyncio.to_thread(sync_libraries, uid)
        except Exception:
            pass
        conflicts = await first_login_conflicts(uid, res["token"])
        try:                       # modifiche fatte offline: se non c'e' niente da decidere, si sistemano da sole
            await asyncio.to_thread(settle_offline, uid, res["token"])
        except Exception:
            pass
    mark_cloud(True)
    sync_soon()
    return with_session({"ok": True, "user": user_json(u), "conflicts": conflicts}, token)


@app.get("/api/auth/state")
def auth_state():
    """Cosa deve mostrare la pagina: niente account, accesso, profili per la TV."""
    if not auth_on():
        return {"on": False}
    u = CURRENT.get()
    # Sulla pagina di accesso serve sapere subito se c'e' rete (per «Continua offline»)
    if cloud_link["online"] is None or (u is None and time.time() - cloud_link["at"] > 20):
        cloud_ping()
    offline = cloud_link["online"] is False
    con = db(raw=True)
    try:
        profiles = [{"id": r["id"], "name": r["name"]} for r in con.execute(
            "SELECT id, name FROM users WHERE token IS NOT NULL AND must_change=0 AND tv_quick=1 "
            "ORDER BY name COLLATE NOCASE")]
        # Offline si puo' continuare con la copia di un account gia' entrato qui
        local = [{"id": r["id"], "name": r["name"], "last_sync": r["last_sync"] or r["last_login"] or 0}
                 for r in con.execute("SELECT id, name, last_sync, last_login FROM users WHERE token IS NOT NULL "
                                      "AND vcheck IS NOT NULL ORDER BY last_login DESC")] if offline else []
        me = con.execute("SELECT * FROM users WHERE id=?", (u["id"],)).fetchone() if u else None
        user = None
        if me:
            pending = bool(me["offline_since"]) and offline_changes(con, me["id"]) > 0
            user = dict(user_json(me), tv_quick=bool(me["tv_quick"]), online=bool(me["token"]),
                        offline_session=bool(u.get("offline")), offline_pending=pending,
                        offline_since=me["offline_since"] or 0, last_sync=me["last_sync"] or 0)
    finally:
        con.close()
    return {"on": True, "user": user, "guest": GUEST.get(), "offline": offline, "local": local,
            "can_guest": offline and not local_users_exist(),
            "profiles": profiles, "setup": SETUP_FILE.is_file() and cloud_ready() is False,
            "server": SERVER_NAME}


@app.post("/api/auth/offline")
async def auth_offline(request: Request):
    """«Continua offline»: senza Internet si entra senza password con la copia di un
    account gia' usato su questo PC (o senza account, se qui non ne e' mai entrato nessuno)."""
    body = await read_json(request)
    if await asyncio.to_thread(cloud_ping):
        raise HTTPException(409, "Il servizio account risponde: entra con nome e password")
    con = db(raw=True)
    try:
        if body.get("id"):
            u = con.execute("SELECT * FROM users WHERE id=? AND token IS NOT NULL AND vcheck IS NOT NULL",
                            (int(body["id"]),)).fetchone()
            if not u:
                raise HTTPException(404, "Su questo PC non c'è una copia di questo account")
            token = open_session(con, u["id"], body.get("device"), offline=True)
            start_offline(con, u["id"])
        else:
            if con.execute("SELECT 1 FROM users LIMIT 1").fetchone():
                raise HTTPException(400, "Scegli con quale account continuare")
            token = open_session(con, 0, body.get("device"), offline=True)
        con.commit()
    finally:
        con.close()
    user_cache.clear()
    return with_session({"ok": True, "offline": True}, token)


@app.post("/api/auth/offline-sync")
async def auth_offline_sync(request: Request):
    """Rientro dopo l'uso offline: «up» manda all'account le modifiche fatte su questo PC,
    «down» le scarta e riprende tutto dall'account."""
    u = CURRENT.get()
    if u is None:
        raise HTTPException(401, "Accedi con il tuo account per continuare")
    body = await read_json(request)
    con = db(raw=True)
    try:
        row = con.execute("SELECT token FROM users WHERE id=?", (u["id"],)).fetchone()
    finally:
        con.close()
    if not row or not row["token"]:
        raise HTTPException(401, "Rientra con il tuo account")
    fn = offline_up if body.get("direction") == "up" else offline_down
    try:
        await asyncio.to_thread(fn, u["id"], row["token"])
    except accounts.CloudOffline as ex:
        mark_cloud(False)
        raise HTTPException(503, str(ex))
    except accounts.CloudError as ex:
        raise HTTPException(502, ex.detail)
    return {"ok": True}


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
                                         "device": SERVER_NAME})
    SETUP_FILE.unlink(missing_ok=True)
    cloud_status["at"] = 0.0
    return await finish_login(res, ver, body.get("device") or "browser")


@app.post("/api/auth/login")
async def auth_login(request: Request):
    body = await read_json(request)
    name, password = login_fields(body)
    ver = await asyncio.to_thread(accounts.verifier, name, password)
    try:
        res = await asyncio.to_thread(accounts.call, "POST", "/login",
                                      {"username": name, "verifier": ver, "device": SERVER_NAME})
    except accounts.CloudError as ex:
        raise HTTPException(ex.status if ex.status in (400, 401, 403, 429) else 502, ex.detail)
    except accounts.CloudOffline:
        # Senza Internet: vale l'ultima password usata su questo PC
        mark_cloud(False)
        con = db(raw=True)
        try:
            u = con.execute("SELECT * FROM users WHERE name=? AND token IS NOT NULL", (name,)).fetchone()
            ok = u and u["vcheck"] and hmac.compare_digest(
                hashlib.sha256((u["vsalt"] + ver).encode()).hexdigest(), u["vcheck"])
            if not ok:
                raise HTTPException(503, "Il servizio account non risponde e su questo PC non risulta "
                                         "questo accesso: controlla la connessione del PC")
            token = open_session(con, u["id"], body.get("device"))
            start_offline(con, u["id"])
            con.commit()
        finally:
            con.close()
        return with_session({"ok": True, "user": user_json(u), "offline": True}, token)
    return await finish_login(res, ver, body.get("device") or "browser")


@app.post("/api/auth/profile")
async def auth_profile(request: Request):
    """Dalla TV di casa: si sceglie un account gia' entrato su questo PC, senza password
    (se quell'account lo permette: Impostazioni → Account)."""
    body = await read_json(request)
    con = db(raw=True)
    try:
        u = con.execute("SELECT * FROM users WHERE id=? AND token IS NOT NULL AND must_change=0 AND tv_quick=1",
                        (int(body.get("id") or 0),)).fetchone()
        if not u:
            raise HTTPException(403, "Questo account va aperto con la password")
        token = open_session(con, u["id"], "tv")
        if cloud_link["online"] is False:    # senza Internet: le modifiche aspettano la scelta al rientro
            start_offline(con, u["id"])
        con.commit()
    finally:
        con.close()
    return with_session({"ok": True, "user": user_json(u)}, token)


@app.post("/api/auth/password")
async def auth_password(request: Request):
    u = CURRENT.get()
    if u is None:
        raise HTTPException(401, "Accedi con il tuo account per continuare")
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
    v_old = await asyncio.to_thread(accounts.verifier, row["name"], old)
    v_new = await asyncio.to_thread(accounts.verifier, row["name"], new)
    try:
        await cloud("POST", "/password", {"verifier": v_old, "new_verifier": v_new}, row["token"])
    except HTTPException as ex:
        if ex.status_code == 401 and "password" in str(ex.detail).lower():
            raise HTTPException(400, "La password attuale non è giusta")
        raise
    vsalt = secrets.token_hex(16)
    con = db(raw=True)
    try:
        con.execute("UPDATE users SET must_change=0, vsalt=?, vcheck=? WHERE id=?",
                    (vsalt, hashlib.sha256((vsalt + v_new).encode()).hexdigest(), u["id"]))
        con.commit()
    finally:
        con.close()
    user_cache.clear()
    # Primo accesso con la password provvisoria: ora si possono confrontare le impostazioni
    conflicts = await first_login_conflicts(u["id"], row["token"]) if row["must_change"] else []
    sync_soon()
    return {"ok": True, "conflicts": conflicts}


@app.post("/api/auth/logout")
def auth_logout(request: Request):
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
        raise HTTPException(401, "Accedi con il tuo account per continuare")
    body = await read_json(request)
    con = db(raw=True)
    try:
        if "tv_quick" in body:
            con.execute("UPDATE users SET tv_quick=? WHERE id=?", (1 if body["tv_quick"] else 0, u["id"]))
        con.commit()
    finally:
        con.close()
    return {"ok": True}


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
    token = admin_token()
    body = await read_json(request)
    name, password = login_fields(body)
    check_new_password(password)
    ver = await asyncio.to_thread(accounts.verifier, name, password)
    return await cloud("POST", "/admin/users", {"username": name, "verifier": ver,
                                                "admin": bool(body.get("admin"))}, token)


@app.post("/api/accounts/{cloud_id}/password")
async def accounts_reset(cloud_id: int, request: Request):
    token = admin_token()
    body = await read_json(request)
    name, password = login_fields(body)
    check_new_password(password)
    ver = await asyncio.to_thread(accounts.verifier, name, password)
    return await cloud("POST", f"/admin/users/{cloud_id}/password", {"verifier": ver}, token)


@app.delete("/api/accounts/{cloud_id}")
async def accounts_delete(cloud_id: int):
    return await cloud("DELETE", f"/admin/users/{cloud_id}", token=admin_token())


# ---- Sincronizzazione con il servizio account --------------------------------

SYNC_ROWS = 40                   # righe per chiamata (limite del piano gratuito di Cloudflare)


def chunks(rows, n=SYNC_ROWS):
    for i in range(0, len(rows), n):
        yield rows[i:i + n]


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
            con = db(raw=True)
            try:
                users = con.execute("SELECT id, token FROM users WHERE token IS NOT NULL AND must_change=0").fetchall()
            finally:
                con.close()
        except sqlite3.Error:
            continue
        for u in users:
            try:
                settle_offline(u["id"], u["token"])
                con = db(raw=True)
                try:
                    waiting = con.execute("SELECT offline_since FROM users WHERE id=?", (u["id"],)).fetchone()[0]
                finally:
                    con.close()
                if waiting:       # modifiche fatte offline: aspettano la scelta dell'account
                    continue
                sync_user(u["id"], u["token"])
            except accounts.CloudOffline:
                mark_cloud(False)
                break             # niente Internet: si riprova al prossimo giro
            except accounts.CloudError as ex:
                if ex.status == 401:
                    drop_cloud_token(u["id"])
                elif ex.status != 403:
                    print("Sincronizzazione account:", ex.detail, flush=True)
            except Exception as ex:
                print("Sincronizzazione account:", repr(ex), flush=True)


def sync_user(uid, token):
    push_settings(uid, token)
    pull_settings(uid, token)
    sync_libraries(uid)               # raccolte dell'account qui, e quelle nuove di qui nell'account
    push_settings(uid, token)
    push_state(uid, token)
    pull_state(uid, token)
    apply_cloud_state(uid)
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


# ---- Aggiornamenti da GitHub ----------------------------------------------
# Il lavoro lo fa updater.py: controllo ogni 12 ore, installazione automatica
# quando nessuno sta guardando (si puo' spegnere) oppure a richiesta, da PC o TV.

def auto_update():
    return config.get("auto_update", True) is not False


def update_json():
    out = updater.snapshot()
    out["auto"] = auto_update()
    return out


@app.get("/api/update")
def update_status():
    return update_json()


@app.post("/api/update/check")
def update_check():
    updater.check()
    return update_json()


@app.post("/api/update/install")
def update_install():
    if not updater.start_install():
        raise HTTPException(409, "C'è già un aggiornamento in corso")
    return update_json()


@app.post("/api/update/auto")
async def update_auto(request: Request):
    body = await read_json(request)
    with config_lock:
        config["auto_update"] = bool(body.get("auto"))
        save_config()
    return update_json()


@app.post("/api/update/token")
async def update_token(request: Request):
    """Salva il token di sola lettura per il repository privato (dopo averlo provato)."""
    body = await read_json(request)
    if not await asyncio.to_thread(updater.set_token, str(body.get("token") or "")):
        raise HTTPException(400, "Con questo token GitHub non dà accesso al repository degli aggiornamenti")
    await asyncio.to_thread(updater.check)
    return update_json()


_apk_seen = {"stamp": None, "version": None}


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


def apk_version():
    """Versione dell'APK che sta sul PC: l'app sulla TV la confronta con la
    propria per sapere se c'e' un aggiornamento. Riletta solo se il file cambia."""
    try:
        st = APK_PATH.stat()
    except OSError:
        return 0, ""
    stamp = (st.st_mtime_ns, st.st_size)
    if _apk_seen["stamp"] != stamp:
        try:
            version = read_apk_version(APK_PATH)
        except Exception as ex:   # file copiato a meta', APK rovinato...
            print("Versione APK non leggibile:", repr(ex), flush=True)
            return 0, ""
        _apk_seen.update(stamp=stamp, version=version)
    return _apk_seen["version"]


@app.get("/api/info")
def info():
    apk_code, apk_name = apk_version()
    if auth_on() and CURRENT.get() is None and not GUEST.get():
        # Prima dell'accesso: quanto basta all'app della TV per riconoscere il server e aggiornarsi
        return {"app": "francoplex", "name": SERVER_NAME, "version": VERSION, "login": True,
                "apk": APK_PATH.is_file(), "apk_version": apk_code, "apk_version_name": apk_name}
    con = db()
    try:
        key = tmdb_key()
        return {
            "app": "francoplex", "name": SERVER_NAME, "version": VERSION,
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
            "apk_version": apk_code, "apk_version_name": apk_name,
            "update": updater.available(),
            # Richieste di condivisione degli amici ancora da approvare
            "share_requests": con.execute(
                "SELECT COUNT(*) FROM accounts WHERE approved=0").fetchone()[0] if share_on() else 0,
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
    for lib in get_libraries():
        paths = files.get(lib["id"], [])
        out.append({
            "id": lib["id"], "name": lib["name"],
            "mine": lib.get("mine", True), "shared": bool(lib.get("shared")),
            "movies": movies.get(lib["id"], 0), "shows": shows.get(lib["id"], 0),
            "folders": [dict(folder_state(p), count=sum(1 for x in paths if x.startswith(p + "/")))
                        for p in lib["folders"]],
            # cartelle della raccolta che stanno su un altro PC dell'account
            "missing": [m.get("display") or m.get("path") for m in lib.get("missing") or []],
        })
    return out


@app.get("/api/libraries/{lib_id}/items")
def library_items(lib_id: int):
    """Tutto il contenuto di una raccolta: film e serie insieme."""
    if lib_id >= FRIEND_BASE:
        return friend_library_items(lib_id)
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
    if u is None:
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
        res = search_tmdb("movie" if kind == "movie" else "show", q, year or None)
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
        if body.get("kind") == "movie":
            apply_movie(con, int(body["id"]), int(body["tmdb_id"]))
        else:
            apply_show(con, int(body["id"]), int(body["tmdb_id"]))
            kept = merge_duplicate_show(con, int(body["id"]))
            con.commit()
            enrich_episodes(con, get_show(con, kept))
        con.commit()
        return {"ok": True}
    except (urllib.error.URLError, TimeoutError):
        raise HTTPException(502, "Non riesco a contattare TMDB")
    finally:
        con.close()


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
    if show_id >= FRIEND_BASE:
        body = await read_json(request)
        return await in_thread(friend_show_watched, show_id, bool(body.get("watched")))
    """Segna tutta la serie come vista / da vedere."""
    body = await read_json(request)
    con = db()
    try:
        ids = [r[0] for r in con.execute("SELECT id FROM items WHERE show_id=?", (show_id,))]
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
    con.executemany("INSERT OR IGNORE INTO user_items(user_id, item_id) VALUES(?,?)",
                    [(u["id"], i) for i in item_ids])
    con.executemany(f"UPDATE user_items SET {sets}, t=?, dirty=1 WHERE user_id=? AND item_id=?",
                    [(*values, time.time(), u["id"], i) for i in item_ids])
    sync_soon()


def set_show_fav(con, show_id, fav):
    u = CURRENT.get()
    if u is None:
        return con.execute("UPDATE shows SET fav=? WHERE id=?", (fav, show_id)).rowcount
    if not get_show(con, show_id):
        return 0
    con.execute("INSERT INTO user_shows(user_id, show_id, fav, t, dirty) VALUES(?,?,?,?,1) "
                "ON CONFLICT(user_id, show_id) DO UPDATE SET fav=excluded.fav, t=excluded.t, dirty=1",
                (u["id"], show_id, fav, time.time()))
    sync_soon()
    return 1


@app.get("/api/home")
def home():
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
        return [item_json(r) for r in con.execute(
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
            raise HTTPException(404, "Saga non trovata")
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
        return [show_json(con, r) for r in con.execute(
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
        return d
    finally:
        con.close()


@app.get("/api/play/{item_id}")
def play(item_id: int):
    if item_id >= FRIEND_BASE:
        return friend_play(item_id)
    con = db()
    try:
        return play_info(con, get_item(con, item_id))
    finally:
        con.close()


@app.post("/api/progress/{item_id}")
async def progress(item_id: int, request: Request):
    body = await read_json(request)
    pos = float(body.get("position") or 0)
    dur = float(body.get("duration") or 0)
    if item_id >= FRIEND_BASE:
        return await in_thread(friend_progress, item_id, pos, dur, bool(body.get("ended")))
    con = db()
    try:
        r = get_item(con, item_id)
        dur = dur or (r["duration"] or 0)
        finished = bool(body.get("ended")) or (dur > 0 and pos / dur > 0.93)
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
def image(name: str):
    f = IMG / Path(name).name
    if not f.is_file():
        raise HTTPException(404)
    return FileResponse(f, headers={"Cache-Control": "public, max-age=31536000, immutable"})


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
             "stream=codec_name,channels:stream_tags=language,title", "-of", "json", path],
            capture_output=True, text=True, timeout=30).stdout
        for i, s in enumerate(json.loads(raw).get("streams", [])):
            tags = s.get("tags") or {}
            code = (tags.get("language") or "").lower()
            name = LANGS.get(code) or (code.upper() if code and code != "und" else f"Traccia {i + 1}")
            detail = " ".join(x for x in ((s.get("codec_name") or "").upper(),
                                          CHANNELS.get(s.get("channels") or 0, "")) if x)
            out.append({"index": i, "lang": code, "codec": s.get("codec_name") or "",
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
    - Audio gia' AAC: si copia. Altrimenti AAC stereo (costa pochissimo).
    Restituisce (argomenti video, argomenti audio, True se il video viene ricodificato)."""
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
    if (r["acodec"] or "") == "aac":
        aargs = ["-c:a", "copy"]
    else:
        aargs = ["-c:a", "aac", "-ac", "2", "-b:a", "192k"]
    return vargs, aargs, heavy


def uplink_plan(r, height):
    """Conversione per un amico che guarda da fuori casa: il collo di bottiglia
    e' la velocita' di caricamento di questa linea, quindi il video viene
    rimpicciolito a 'height' (720 o 1080) con un tetto ai dati al secondo.
    Se il file e' gia' H.264 leggero e non piu' grande, si copia senza lavoro."""
    cap = 3500 if height == 720 else 8000          # kbit/s
    vcodec, pix = r["vcodec"] or "", r["pix"] or ""
    kbps = (r["size"] or 0) * 8 / 1000 / r["duration"] if r["duration"] else 0
    if (vcodec == "h264" and pix in ("yuv420p", "yuvj420p") and 0 < (r["height"] or 0) <= height + 8
            and 0 < kbps <= cap * 1.25):
        vargs, heavy = ["-c:v", "copy"], False
    else:
        hdr = "10" in pix and is_hdr(r["path"])
        chain = f"scale=-2:min({height}\\,ih):flags=fast_bilinear"
        if hdr and not SLOW_PC:
            chain += (",zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,"
                      "tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv")
        vargs, heavy = ["-c:v", "libx264", "-preset", "ultrafast" if SLOW_PC else "superfast",
                        "-crf", "23", "-maxrate", f"{cap}k", "-bufsize", f"{cap * 2}k",
                        "-vf", chain + ",format=yuv420p", "-g", "96", "-sc_threshold", "0"], True
    return vargs, ["-c:a", "aac", "-ac", "2", "-b:a", "128k"], heavy


@app.get("/api/transcode/{item_id}")
def transcode(item_id: int, start: float = 0, vcopy: int = 0, audio: int = 0):
    """Conversione al volo in MP4 per i dispositivi che non leggono il file
    originale. Non si puo' saltare dentro il flusso: per spostarsi il player
    richiede di nuovo l'indirizzo con un altro 'start'.
    'vcopy=1': il dispositivo sa decodificare il video, va cambiato solo il resto."""
    if item_id >= FRIEND_BASE:
        return friend_transcode(item_id, start, vcopy, audio)
    return run_transcode(item_id, start, vcopy, audio)


def run_transcode(item_id, start=0.0, vcopy=0, audio=0, height=0):
    con = db()
    try:
        r = get_item(con, item_id)
    finally:
        con.close()
    path = r["path"]
    if not os.path.isfile(path):
        raise HTTPException(404, "File non trovato sul disco")
    vargs, aargs, heavy = uplink_plan(r, height) if height else transcode_plan(r, bool(vcopy))
    audio = max(0, audio)
    if audio and not height:
        # Un'altra lingua: il suo formato puo' essere diverso da quello della prima traccia
        aargs = ["-c:a", "aac", "-ac", "2", "-b:a", "192k"]
    # nice: la conversione lascia sempre la precedenza al resto del PC.
    cmd = ["nice", "-n", "10", "ffmpeg", "-v", "error", "-nostdin"]
    if heavy:
        # Non corre piu' del necessario: converte i primi 30 secondi subito (partenza
        # rapida), poi tiene un passo poco sopra la velocita' di visione invece di
        # occupare tutti i processori per riempire in anticipo la memoria del player.
        cmd += ["-readrate", "1.5", "-readrate_initial_burst", "30"]
    cmd += (["-ss", f"{max(0.0, start):.2f}", "-i", path,
             "-map", "0:v:0", "-map", f"0:a:{audio}?", "-sn", "-dn", "-map_chapters", "-1"] + vargs + aargs +
            ["-movflags", "frag_keyframe+empty_moov+default_base_moof",
             "-f", "mp4", "pipe:1"])
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
    """Chi puo' usare /api/share/...: solo un amico registrato e approvato."""
    if not share_on():
        raise HTTPException(403, "La condivisione è spenta su questo server")
    token = request.headers.get("x-share-token", "")
    if not token:
        raise HTTPException(401, "Accesso riservato agli amici registrati")
    key = token_hash(token)
    known = share_tokens.get(key)
    if not known or time.time() - known[2] > 30:
        con = db()
        try:
            r = con.execute("SELECT a.id, a.approved, a.last_seen FROM share_sessions s JOIN accounts a "
                            "ON a.id=s.account WHERE s.token=?", (key,)).fetchone()
            if r and r["approved"] and time.time() - (r["last_seen"] or 0) > 300:
                con.execute("UPDATE accounts SET last_seen=? WHERE id=?", (time.time(), r["id"]))
                con.commit()
        finally:
            con.close()
        if not r:
            raise HTTPException(401, "Accesso non valido: ripeti l'accesso")
        if len(share_tokens) > 500:
            share_tokens.clear()
        known = share_tokens[key] = (r["id"], bool(r["approved"]), time.time())
        if r["approved"]:
            friend_nudge(r["id"])
    if not known[1]:
        raise HTTPException(403, "Registrazione in attesa di approvazione")
    request.state.share_account = known[0]


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


@app.get("/api/sharing")
def sharing_status():
    """Per Impostazioni (rete di casa): stato della condivisione e amici registrati."""
    con = db()
    try:
        accounts = [{"id": r["id"], "name": r["name"], "approved": bool(r["approved"]),
                     "created": r["created"], "last_seen": r["last_seen"] or 0,
                     "back_url": r["back_url"] or ""}
                    for r in con.execute("SELECT * FROM accounts ORDER BY approved, name COLLATE NOCASE")]
    finally:
        con.close()
    sh = config.get("share") or {}
    return {"on": share_on(), "port": SHARE_PORT, "accounts": accounts,
            "address": my_address(), "manual": bool(sh.get("manual") and sh.get("address")),
            "tls": share_tls["on"], "auto_port": auto_port(), "lan": lan["ip"],
            "portmap": {k: portmap[k] for k in ("ok", "method", "ip", "port", "public", "error", "at")}}


@app.post("/api/sharing")
async def sharing_set(request: Request):
    body = await read_json(request)
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
    return {"ok": True, "on": share_on()}


@app.post("/api/sharing/accounts/{account}")
async def sharing_approve(account: int, request: Request):
    """Accetta (o sospende) la richiesta di un amico. Accettando, lo scambio e'
    reciproco: se lui ha offerto le sue raccolte, compaiono qui da sole."""
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
        if x.get("kind") == "show" and "episodes" in x:
            x["unwatched"] = x["episodes"]
        elif x.get("kind") == "collection" and "count" in x:
            x["unwatched"] = x["count"]
        for v in x.values():
            scrub(v)
    return x


@share.get("/info")
def share_info():
    return {"app": "francoplex", "name": SERVER_NAME, "version": VERSION, "share": 1}


@share.get("/libraries")
def share_libraries():
    """Le raccolte, senza i percorsi delle cartelle."""
    return [{"id": l["id"], "name": l["name"], "movies": l["movies"], "shows": l["shows"]}
            for l in libraries_list()]


@share.get("/libraries/{lib_id}/items")
def share_library_items(lib_id: int):
    return scrub(library_items(_own(lib_id)))


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
    return scrub(play(_own(item_id)))


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
def share_transcode(item_id: int, start: float = 0, vcopy: int = 0, audio: int = 0, height: int = 0):
    """'height' (720 o 1080): conversione leggera, a misura della linea di casa."""
    return run_transcode(_own(item_id), start, vcopy, audio, height if height in (720, 1080) else 0)


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
            return


def auto_port():
    return (config.get("share") or {}).get("auto_port", True) is not False


def my_address():
    """L'indirizzo con cui un amico raggiunge questo server: quello scritto a
    mano (Tailscale) oppure quello pubblico trovato aprendo la porta sul router."""
    sh = config.get("share") or {}
    if sh.get("manual") and sh.get("address"):
        return sh["address"]
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
            if SHARE_PORT and share_on() and auto_port():
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


def get_friends():
    with config_lock:
        return json.loads(json.dumps(config.get("friends") or []))


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


def friend_open(f, path, timeout=5, headers=None, method="GET", data=None):
    h = {"X-Share-Token": f.get("token") or "", "User-Agent": "BunkerPlex/" + VERSION}
    h.update(headers or {})
    req = urllib.request.Request(f["url"] + "/api/share" + path, data=data, headers=h, method=method)
    if not f["url"].startswith("https://"):
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

    return urllib.request.build_opener(_NoRedirect, Handler).open(req, timeout=timeout)


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
        libs = friend_json(f, "/libraries", timeout=6)
        clean = []
        for l in libs if isinstance(libs, list) else []:
            if isinstance(l, dict) and _is_id(l.get("id")):
                clean.append({"id": l["id"], "name": str(l.get("name") or "Raccolta")[:40],
                              "movies": int(_num(l.get("movies"))), "shows": int(_num(l.get("shows")))})
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
    except FriendDown:
        pass
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
         "latest", "rating", "start", "width", "height"}
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


def friend_show_watched(vid, on):
    f, rid = friend_of(vid)
    d = friend_data(f, f"show_{rid}.json", f"/shows/{rid}")
    for s in (d.get("seasons") or []) if isinstance(d, dict) else []:
        for e in (s.get("episodes") or []) if isinstance(s, dict) else []:
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
    out["subs_online"] = False      # i video dell'amico non si toccano: li scarica lui
    out["subs"] = [s for s in out.get("subs") or [] if isinstance(s, dict) and s.get("url")]
    s = friend_states(f["n"])[0].get(rid)
    out["start"] = s["position"] if s and not s["watched"] else 0
    quality = friend_quality()
    out["friend_quality"] = quality
    if quality != "orig":
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


def friend_transcode(vid, start, vcopy, audio):
    f, rid = friend_of(vid)
    q = {"start": f"{max(0.0, start):.2f}", "audio": max(0, audio)}
    quality = friend_quality()
    if quality == "orig":
        q["vcopy"] = 1 if vcopy else 0
    else:
        q["height"] = quality
    return friend_pipe(f, f"/transcode/{rid}?" + urllib.parse.urlencode(q))


# ---- Home e menu: le raccolte degli amici ----------------------------------

def friend_home_rows():
    """Una fila per ogni raccolta di ogni amico. Solo dalla copia locale: la
    Home non aspetta mai la rete."""
    rows = []
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
                rows.append({"id": fvid(n, l["id"]), "name": l["name"], "friend": f["name"],
                             "offline": (friend_status.get(n) or {}).get("online") is False,
                             "items": f_adapt(f, items[:24], st)})
        except Exception as ex:
            print("Amici (Home):", ex, flush=True)
    return rows


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


@app.get("/api/friends")
def friends_list():
    out = []
    for f in get_friends():
        n = f["n"]
        s = friend_status.get(n) or {}
        libs, age = fc_load(n, "libraries.json")
        out.append({"n": n, "name": f["name"], "url": f["url"], "user": f.get("user") or "",
                    "online": s.get("online"), "error": s.get("error") or "",
                    "synced": time.time() - age if libs is not None else 0,
                    "libraries": [{"id": fvid(n, l["id"]), "name": l["name"],
                                   "movies": l["movies"], "shows": l["shows"]} for l in libs or []]})
    return {"friends": out, "quality": friend_quality()}


@app.post("/api/friends")
async def friends_add(request: Request):
    """Collega il server di un amico: ci si registra da lui (o si accede con un
    account gia' fatto). La password non viene conservata: resta solo il gettone."""
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
            if not typed:
                for _ in range(40):
                    if portmap["at"] >= asked:
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


def friend_store(name, url, user, token, account=None, pin=None):
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
        current.append(f)
        save_config()
    shutil.rmtree(FRIENDS_DIR / str(n), ignore_errors=True)
    friend_status.pop(n, None)
    threading.Thread(target=friend_sync, args=(f,), daemon=True).start()
    return n


@app.delete("/api/friends/{n}")
def friends_remove(n: int):
    """Toglie un amico: spariscono le sue raccolte e lui non entra piu' qui."""
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
    body = await read_json(request)
    q = str(body.get("quality") or "")
    if q not in QUALITIES:
        raise HTTPException(400, "Richiesta non valida")
    with config_lock:
        config["friend_quality"] = q
        save_config()
    return {"ok": True}


@app.get("/FrancoPlex.apk")     # le app installate con i nomi precedenti si aggiornano da qui
@app.get("/FrenkPlex.apk")
@app.get("/BunkerPlex.apk")
def apk():
    """L'app per la TV, scaricabile direttamente dal server."""
    if not APK_PATH.is_file():
        raise HTTPException(404, "APK non ancora compilato: avvia 'Compila APK.bat' sul PC")
    return FileResponse(APK_PATH, media_type="application/vnd.android.package-archive",
                        filename="BunkerPlex.apk")


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
            "friends_port": SHARE_PORT, "friends_open": bool(portmap.get("ok") and portmap.get("public"))}


@app.get("/api/apk-link")
def apk_link(request: Request):
    """L'indirizzo per scaricare l'app da un telefono di casa, con il suo QR (SVG)."""
    host = request.headers.get("host", "")
    port = host.rsplit(":", 1)[1] if ":" in host and not host.endswith("]") else "32500"
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


class UIFiles(StaticFiles):
    """L'interfaccia va sempre ricontrollata: dopo un aggiornamento del server
    browser e TV non devono restare con la versione vecchia in memoria."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


app.mount("/", UIFiles(directory=Path(__file__).parent / "static", html=True), name="ui")
