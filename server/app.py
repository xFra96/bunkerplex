"""FrenkPlex - media server casalingo.

Scansiona le cartelle di Film e Serie TV, cataloga tutto in SQLite
(locandine, trama, anno, regista, generi, cast, voto da TMDB) e manda
i video in streaming.
"""
import asyncio
import difflib
import json
import math
import mimetypes
import os
import re
import shutil
import sqlite3
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

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

VERSION = "1.1"
DATA = Path(os.environ.get("DATA_DIR", "/data"))
TMDB_LANG = os.environ.get("TMDB_LANG", "it-IT")
SCAN_INTERVAL_MIN = int(os.environ.get("SCAN_INTERVAL_MIN", "30") or 30)
SERVER_NAME = os.environ.get("SERVER_NAME", "FrenkPlex")

IMG = DATA / "images"
# Il catalogo (questa cartella) viaggia sul disco insieme ai video: "Avvia
# FrenkPlex.bat" ci mette un segnaposto prima di accendere il server. Se il
# segnaposto manca, il disco non e' collegato a Docker: invece di creare un
# catalogo vuoto da un'altra parte, il server si ferma e lo dice.
MARKER = DATA / ".francoplex"


def data_problem():
    if os.environ.get("DATA_CHECK", "1") != "0" and not MARKER.is_file():
        return ("Il disco con il catalogo non è collegato al server. "
                "Collegalo e rilancia «Avvia FrenkPlex.bat» sul PC.")
    try:
        IMG.mkdir(parents=True, exist_ok=True)
        test = DATA / ".scrittura"
        test.write_text("ok")
        test.unlink()
    except OSError:
        return ("Non riesco a scrivere nella cartella del catalogo. "
                "Rilancia «Avvia FrenkPlex.bat» sul PC.")
    return ""


DATA_PROBLEM = data_problem()
DB_PATH = DATA / "francoplex.db"
CONFIG_PATH = DATA / "config.json"
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
    return (config.get("tmdb_key") or os.environ.get("TMDB_API_KEY", "")).strip()


# --------------------------------------------------------------------------
# Cartelle della libreria (scelte dall'app, quante se ne vogliono)
# --------------------------------------------------------------------------

# I dischi del PC sono montati in sola lettura sotto /host (es. /host/C, /host/G):
# lo fa "Avvia FrenkPlex.bat". Da li' l'app puo' sfogliare e scegliere le cartelle.
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
        return json.loads(json.dumps(config["libraries"]))


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
                                     "Chiudi e riavvia con «Avvia FrenkPlex.bat»")
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

def db():
    con = sqlite3.connect(DB_PATH, timeout=30)
    con.row_factory = sqlite3.Row
    try:
        con.execute("PRAGMA journal_mode=WAL")
    except sqlite3.OperationalError:
        # Alcuni dischi esterni non reggono la modalita' WAL: si usa quella classica
        con.execute("PRAGMA journal_mode=DELETE")
    return con


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
    """)
    # library_id: la raccolta a cui appartiene il titolo (aggiunta in un secondo momento)
    # collection_id: la saga TMDB di cui il film fa parte (id della tabella collections);
    # coll_done: 1 quando si e' gia' controllato se il film appartiene a una saga.
    for table, column in (("items", "library_id INT"), ("shows", "library_id INT"),
                          ("items", "collection_id INT"), ("items", "coll_done INT DEFAULT 0")):
        if column.split()[0] not in {r[1] for r in con.execute(f"PRAGMA table_info({table})")}:
            con.execute(f"ALTER TABLE {table} ADD COLUMN {column}")
    con.execute("CREATE INDEX IF NOT EXISTS items_collection ON items(collection_id)")
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
        "backdrop=?, tmdb_id=?, genres=?, director=?, actors=?, rating=?, meta_done=1 WHERE id=?",
        (m.get("title") or row["title"], m.get("original_title"),
         _year(m.get("release_date"), row["year"]), overview, m.get("tagline") or "",
         poster, fetch_image(m.get("backdrop_path"), "w1280"), m["id"],
         json.dumps([g["name"] for g in m.get("genres", [])], ensure_ascii=False),
         ", ".join(directors), json.dumps(actors, ensure_ascii=False),
         round(m.get("vote_average") or 0, 1), item_id))
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
        "tmdb_id=?, genres=?, director=?, actors=?, rating=?, meta_done=1 WHERE id=?",
        (m.get("name") or row["title"], m.get("original_name"),
         _year(m.get("first_air_date"), row["year"]), overview, poster,
         fetch_image(m.get("backdrop_path"), "w1280"), m["id"],
         json.dumps([g["name"] for g in m.get("genres", [])], ensure_ascii=False),
         ", ".join(c["name"] for c in m.get("created_by", [])),
         json.dumps(actors, ensure_ascii=False),
         round(m.get("vote_average") or 0, 1), show_id))
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


def subtitle_files(path):
    p = Path(path)
    out = []
    try:
        for f in sorted(p.parent.iterdir()):
            if f.suffix.lower() in SUB_EXT and f.stem.lower().startswith(p.stem.lower()):
                out.append((f, f.stem[len(p.stem):].strip(" .-_")))
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
    for i, (_, tag) in enumerate(subtitle_files(r["path"])):
        code = (tag.split(".")[0] or "").lower()
        subs.append({"url": f"/api/subs/{r['id']}/{i}",
                     "label": LANGS.get(code, tag or "Sottotitoli"),
                     "lang": code[:2] if code in LANGS else ""})
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
            "next": nxt["id"] if nxt else 0,
            # Cosa mostrare nel conto alla rovescia di fine episodio
            "next_label": (f"S{nxt['season']} · E{nxt['episode']}  {nxt['title'] or ''}".strip()
                           if nxt else ""),
            # Il film che viene dopo nella stessa saga: il player lo propone, non parte da solo
            "saga": saga}


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

app = FastAPI(title="FrenkPlex", docs_url=None, redoc_url=None)


class SmallAndFast:
    """Comprime elenchi e pagine (l'elenco di una raccolta pesa centinaia di KB:
    compresso arriva alla TV in un quinto del tempo). Video e immagini passano
    cosi' come sono: sono gia' compressi e devono restare 'saltabili'."""
    RAW = ("/api/stream", "/api/transcode", "/api/image", "/api/thumb", "/FrenkPlex.apk", "/FrancoPlex.apk")

    def __init__(self, inner):
        self.inner = inner
        self.gzip = GZipMiddleware(inner, minimum_size=2048, compresslevel=5)

    async def __call__(self, scope, receive, send):
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
<meta name="viewport" content="width=device-width, initial-scale=1"><title>FrenkPlex</title>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#07080c;color:#f2f2f5;font-family:system-ui,sans-serif;text-align:center">
<div style="max-width:34rem;padding:2rem"><h1 style="color:#ff6b4a">Catalogo non raggiungibile</h1>
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
    con = db()
    try:
        key = tmdb_key()
        apk_code, apk_name = apk_version()
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
            "libraries": len(get_libraries()), "apk": APK_PATH.is_file(),
            "apk_version": apk_code, "apk_version_name": apk_name,
        }
    finally:
        con.close()


# ---- Raccolte ------------------------------------------------------------

def _library(lib_id):
    """La raccolta dentro config (da usare tenendo config_lock)."""
    for lib in config["libraries"]:
        if lib["id"] == lib_id:
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
            "movies": movies.get(lib["id"], 0), "shows": shows.get(lib["id"], 0),
            "folders": [dict(folder_state(p), count=sum(1 for x in paths if x.startswith(p + "/")))
                        for p in lib["folders"]],
        })
    return out


@app.get("/api/libraries/{lib_id}/items")
def library_items(lib_id: int):
    """Tutto il contenuto di una raccolta: film e serie insieme."""
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
    with config_lock:
        lib = {"id": max([x["id"] for x in config["libraries"]] + [0]) + 1,
               "name": name, "folders": []}
        config["libraries"].append(lib)
        try:
            _add_folders(lib, body.get("folders") or [])
        except HTTPException:
            config["libraries"].remove(lib)
            raise
        save_config()
    scan_async()
    return {"ok": True, "id": lib["id"]}


@app.patch("/api/libraries/{lib_id}")
async def libraries_rename(lib_id: int, request: Request):
    body = await read_json(request)
    name = _clean_name(body.get("name"))
    get_libraries()
    with config_lock:
        _library(lib_id)["name"] = name
        save_config()
    return {"ok": True}


@app.delete("/api/libraries/{lib_id}")
def libraries_delete(lib_id: int):
    get_libraries()
    with config_lock:
        config["libraries"].remove(_library(lib_id))
        save_config()
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
        added = _add_folders(_library(lib_id), raw)
        save_config()
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
    scan_async()
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
        con = db()
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
    with config_lock:
        config["tmdb_key"] = key
        save_config()
    con = db()
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
    con = db()
    try:
        if body.get("kind") == "movie":
            get_item(con, int(body["id"]))
            apply_movie(con, int(body["id"]), int(body["tmdb_id"]))
        else:
            if not get_show(con, int(body["id"])):
                raise HTTPException(404, "Serie non trovata")
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
    con = db()
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
        con.execute(f"UPDATE items SET meta_done=0 {where}", args)
        con.execute(f"UPDATE shows SET meta_done=0 {where}", args)
        con.commit()
    finally:
        con.close()
    scan_async()
    return {"ok": True}


@app.post("/api/shows/{show_id}/watched")
async def show_watched(show_id: int, request: Request):
    """Segna tutta la serie come vista / da vedere."""
    body = await read_json(request)
    con = db()
    try:
        con.execute("UPDATE items SET watched=?, position=0 WHERE show_id=?",
                    (1 if body.get("watched") else 0, show_id))
        con.commit()
        return {"ok": True}
    finally:
        con.close()


@app.get("/api/home")
def home():
    con = db()
    try:
        shows = {r["id"]: r for r in con.execute("SELECT * FROM shows")}

        def j(r):
            return item_json(r, shows.get(r["show_id"]))

        cont = [j(r) for r in con.execute(
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
        return {"continue": cont, "nextup": nextup, "libraries": rows, "collections": sagas,
                "top_movies": top_movies, "has_libraries": bool(libs)}
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
    con = db()
    try:
        s = get_show(con, show_id)
        if not s:
            raise HTTPException(404, "Serie non trovata")
        d = show_json(con, s)
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
    con = db()
    try:
        r = get_item(con, item_id)
        show = get_show(con, r["show_id"]) if r["show_id"] else None
        d = item_json(r, show)
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
    con = db()
    try:
        r = get_item(con, item_id)
        dur = dur or (r["duration"] or 0)
        finished = bool(body.get("ended")) or (dur > 0 and pos / dur > 0.93)
        if finished:
            con.execute("UPDATE items SET watched=1, position=0, last_played=? WHERE id=?",
                        (time.time(), item_id))
        else:
            con.execute("UPDATE items SET position=?, last_played=? WHERE id=?",
                        (pos, time.time(), item_id))
        con.commit()
        return {"ok": True, "watched": finished}
    finally:
        con.close()


@app.post("/api/watched/{item_id}")
async def set_watched(item_id: int, request: Request):
    body = await read_json(request)
    con = db()
    try:
        get_item(con, item_id)
        con.execute("UPDATE items SET watched=?, position=0 WHERE id=?",
                    (1 if body.get("watched") else 0, item_id))
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
    con = db()
    try:
        r = get_item(con, item_id)
    finally:
        con.close()
    files = subtitle_files(r["path"])
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


@app.api_route("/api/stream/{item_id}", methods=["GET", "HEAD"])
def stream(item_id: int, request: Request):
    """File originale, con supporto Range (serve per andare avanti/indietro)."""
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


@app.get("/api/transcode/{item_id}")
def transcode(item_id: int, start: float = 0, vcopy: int = 0, audio: int = 0):
    """Conversione al volo in MP4 per i dispositivi che non leggono il file
    originale. Non si puo' saltare dentro il flusso: per spostarsi il player
    richiede di nuovo l'indirizzo con un altro 'start'.
    'vcopy=1': il dispositivo sa decodificare il video, va cambiato solo il resto."""
    con = db()
    try:
        r = get_item(con, item_id)
    finally:
        con.close()
    path = r["path"]
    if not os.path.isfile(path):
        raise HTTPException(404, "File non trovato sul disco")
    vargs, aargs, heavy = transcode_plan(r, bool(vcopy))
    audio = max(0, audio)
    if audio:
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


@app.get("/FrancoPlex.apk")     # l'app installata prima del cambio di nome si aggiorna da qui
@app.get("/FrenkPlex.apk")
def apk():
    """L'app per la TV, scaricabile direttamente dal server."""
    if not APK_PATH.is_file():
        raise HTTPException(404, "APK non ancora compilato: avvia 'Compila APK.bat' sul PC")
    return FileResponse(APK_PATH, media_type="application/vnd.android.package-archive",
                        filename="FrenkPlex.apk")


class UIFiles(StaticFiles):
    """L'interfaccia va sempre ricontrollata: dopo un aggiornamento del server
    browser e TV non devono restare con la versione vecchia in memoria."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


app.mount("/", UIFiles(directory=Path(__file__).parent / "static", html=True), name="ui")
