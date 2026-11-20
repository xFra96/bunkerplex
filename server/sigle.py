"""Sigle degli episodi: dove inizia e finisce quella iniziale, dove inizia quella
finale (i titoli di coda). Servono al player per «Salta intro» e per proporre
il prossimo episodio appena parte la sigla di chiusura.

Due fonti, in quest'ordine:
  1. i capitoli del file, quando hanno un nome chiaro ("Opening", "Intro",
     "Ending", "Credits"...): sono esatti;
  2. l'audio: la sigla e' uguale in tutti gli episodi della stagione. Si prende
     l'"impronta" (chromaprint, dentro ffmpeg) dell'inizio e della fine di ogni
     episodio e si cerca il tratto che due episodi hanno in comune.

Le impronte restano in una cartella (si rifanno solo se il file cambia), cosi'
un episodio aggiunto dopo si confronta subito con quelli che c'erano.
Solo libreria standard: niente dipendenze.
"""
import gzip
import json
import os
import re
import struct
import subprocess
import tempfile
from collections import Counter
from pathlib import Path

POINT = 4096 / 3 / 11025        # secondi coperti da un punto dell'impronta (~0,124)
HEAD = 600                      # si guarda la sigla iniziale nei primi 10 minuti...
HEAD_SHARE = 0.4                # ...ma non oltre il 40% dell'episodio
TAIL = 420                      # la sigla finale negli ultimi 7 minuti
TAIL_SHARE = 0.35
MAX_BITS = 6                    # bit diversi (su 32) perche' due punti siano "uguali"
GAP = int(3.5 / POINT)          # buchi piu' corti di cosi' non spezzano un tratto in comune
INTRO_MIN, INTRO_MAX = 12, 150
CREDITS_MIN = 15
MIN_EPISODE = 8 * 60            # episodi piu' corti: niente ricerca nell'audio

INTRO_NAMES = re.compile(
    r"^\s*(op(ening)?(\s*\d+)?|intro(duction)?|sigla(\s+(iniziale|di\s+apertura))?|"
    r"title\s+sequence|opening\s+(credits|titles|song|theme)|main\s+titles?|generique(\s+debut)?)\s*$", re.I)
CREDITS_NAMES = re.compile(
    r"^\s*(ed(\s*\d+)?|ending(\s*\d+)?|end(ing)?\s+(credits|titles|song|theme)|credits|outro|"
    r"titoli\s+di\s+coda|sigla\s+(finale|di\s+chiusura)|closing(\s+credits)?|generique(\s+fin)?)\s*$", re.I)


# ---- Capitoli -----------------------------------------------------------------

def from_chapters(path):
    """{'intro': (inizio, fine) | None, 'credits': inizio | None} dai capitoli del file."""
    out = {"intro": None, "credits": None}
    try:
        res = subprocess.run(["ffprobe", "-v", "error", "-show_chapters", "-of", "json", str(path)],
                             capture_output=True, text=True, timeout=60)
        chapters = json.loads(res.stdout or "{}").get("chapters") or []
    except Exception:
        return out
    for c in chapters:
        name = str((c.get("tags") or {}).get("title") or "")
        try:
            start, end = float(c.get("start_time")), float(c.get("end_time"))
        except (TypeError, ValueError):
            continue
        if out["intro"] is None and INTRO_NAMES.match(name) and 5 <= end - start <= 240:
            out["intro"] = (start, end)
        elif out["credits"] is None and CREDITS_NAMES.match(name) and end - start >= 5:
            out["credits"] = start
    return out


# ---- Impronte dell'audio ------------------------------------------------------

def windows(duration):
    """I due tratti da confrontare: (inizio, durata) all'inizio e alla fine."""
    head = min(HEAD, duration * HEAD_SHARE)
    tail = min(TAIL, duration * TAIL_SHARE)
    return (0.0, head), (max(0.0, duration - tail), tail)


def fingerprint(path, start, length, nice=True):
    """L'impronta di un tratto di audio: un numero a 32 bit ogni ~0,124 s."""
    fd, tmp = tempfile.mkstemp(suffix=".fp")
    os.close(fd)
    try:
        cmd = ["ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-y"]
        if start > 0:
            cmd += ["-ss", f"{start:.2f}"]
        cmd += ["-t", f"{length:.2f}", "-i", str(path), "-map", "0:a:0", "-vn", "-sn", "-dn",
                "-ac", "1", "-f", "chromaprint", "-fp_format", "raw", tmp]
        if nice and hasattr(os, "nice"):
            cmd = ["nice", "-n", "15"] + cmd
        subprocess.run(cmd, capture_output=True, timeout=max(120, length))
        raw = Path(tmp).read_bytes()
        return list(struct.unpack(f"<{len(raw) // 4}I", raw[:len(raw) // 4 * 4]))
    except Exception:
        return []
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def cached(folder, key, path, start, length, nice=True):
    """Come fingerprint(), ma tenendo da parte il risultato (key cambia se cambia il file)."""
    f = Path(folder) / f"{key}.fp.gz"
    try:
        raw = gzip.decompress(f.read_bytes())
        return list(struct.unpack(f"<{len(raw) // 4}I", raw))
    except (OSError, EOFError, struct.error, gzip.BadGzipFile):
        pass
    points = fingerprint(path, start, length, nice)
    if points:
        try:
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_bytes(gzip.compress(struct.pack(f"<{len(points)}I", *points)))
        except OSError:
            pass
    return points


def common(a, b, min_len):
    """Il tratto piu' lungo che le due impronte hanno in comune, anche se in punti
    diversi dei due episodi (una scena prima della sigla, un riassunto...).
    Restituisce ((inizio_a, fine_a), (inizio_b, fine_b)) in secondi, oppure None."""
    if len(a) < 20 or len(b) < 20:
        return None
    where = {}
    for j, v in enumerate(b):
        where.setdefault(v, []).append(j)
    shifts = Counter()
    for i, v in enumerate(a):
        for j in where.get(v, ()):
            shifts[j - i] += 1
    best = None
    for shift, hits in shifts.most_common(40):
        if hits < 3:
            break
        lo, hi = max(0, -shift), min(len(a), len(b) - shift)
        run_start = last = -1
        for i in range(lo, hi):
            if (a[i] ^ b[i + shift]).bit_count() > MAX_BITS:
                continue
            if last < 0 or i - last > GAP:
                run_start = i
            last = i
            if best is None or last - run_start > best[1] - best[0]:
                best = (run_start, last, shift)
    if best is None or (best[1] - best[0]) * POINT < min_len:
        return None
    s, e, shift = best
    return (s * POINT, (e + 1) * POINT), ((s + shift) * POINT, (e + 1 + shift) * POINT)


def find_intro(a, b):
    """Sigla iniziale dell'episodio 'a' (impronta dei suoi primi minuti), confrontato con 'b'."""
    m = common(a, b, INTRO_MIN)
    if not m:
        return None
    (s, e), _ = m
    if e - s > INTRO_MAX:
        return None
    return s, e


def find_credits(a, b, a_start):
    """Inizio della sigla finale dell'episodio 'a' (impronta dei suoi ultimi minuti,
    che iniziano al secondo a_start), confrontato con 'b'."""
    m = common(a, b, CREDITS_MIN)
    if not m:
        return None
    (s, _), _ = m
    return a_start + s
