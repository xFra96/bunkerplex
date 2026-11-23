"""Numeri di versione di BunkerPlex: 1.0, 1.1, 1.1.1, 2.0...

Due linee, ognuna con i suoi numeri:
  - server (tag v1.2): il programma sul PC, cioe' tutto tranne android/;
  - app (tag app-v1.2): l'app Android per telefoni e TV (android/ tranne
    android/tv/), sale solo quando l'APK viene ricompilato;
  - tv (tag tv-v1.2): l'app nativa per la TV (android/tv/ e android/comune/),
    con il suo giro di pubblicazione.

Lo usa il giro "Pubblica la release" (workflows/apk.yml) a ogni push su main.
Si parte dall'ultima versione pubblicata di quella linea e si sale in base a
quanto e' cambiato, per quella linea, dai commit arrivati da allora (si prende
il passo piu' grande):
  - maggiore (2.0): solo se lo si chiede (vedi sotto), e' un cambio grosso;
  - minore (1.1): novita' vere, cioe' file nuovi nel codice della linea
    (server/ e cloud/, o android/) o almeno 100 righe aggiunte li' (le righe
    tolte e i test non contano: togliere o verificare non e' una novita');
  - correzione (1.1.1): tutto il resto (correzioni, ritocchi, testi, README).
Il passo si puo' sempre decidere a mano, e allora vince:
  - un'etichetta sulla pull request: "major", "minor", "patch" per il server,
    "app-major", "app-minor", "app-patch" per l'app, "tv-major"... per la TV;
  - oppure una riga nel messaggio del commit: "Versione: maggiore" per il
    server, "Versione app: minore" per l'app, "Versione TV: ..." (maggiore, minore, correzione;
    vanno bene anche major, minor, patch).

Le versioni di prima avevano la data (v2026.11.23.6): non contano come
precedenti, la prima versione col numero nuovo e' la 1.0.

Uso: python3 .github/versione.py [server|app|tv]   (stampa il tag, es. v1.2 o app-v1.0)
     python3 .github/versione.py --test
"""
import json
import os
import re
import subprocess
import sys

BIG = 100
LEVELS = {"major": 3, "maggiore": 3, "minor": 2, "minore": 2, "patch": 1, "correzione": 1}
LINES = {
    # prefisso del tag, codice che conta, percorsi dei commit (None = tutti), etichette, riga nel messaggio
    "server": {"prefix": "v", "code": ("server/", "cloud/"), "paths": None, "label": "",
               "trailer": re.compile(r"^\s*versione\s*:\s*(\w+)\s*$", re.I | re.M)},
    "app": {"prefix": "app-v", "code": ("android/",), "skip": ("android/tv/",),
            "paths": ["android", ":(exclude)android/tv"], "label": "app-",
            "trailer": re.compile(r"^\s*versione\s+app\s*:\s*(\w+)\s*$", re.I | re.M)},
    "tv": {"prefix": "tv-v", "code": ("android/tv/", "android/comune/"),
           "paths": ["android/tv", "android/comune"], "label": "tv-",
           "trailer": re.compile(r"^\s*versione\s+tv\s*:\s*(\w+)\s*$", re.I | re.M)},
}
line = LINES["server"]


def git(*a):
    return subprocess.run(["git", *a], capture_output=True, text=True, check=True).stdout


def parse(tag):
    """v1.0 -> (1, 0, 0); None per le altre linee e per i vecchi tag a data (v2026.11.23)."""
    m = re.match(re.escape(line["prefix"]) + r"(\d{1,3})\.(\d+)(?:\.(\d+))?$", tag)
    return (int(m[1]), int(m[2]), int(m[3] or 0)) if m else None


def fmt(v):
    return f"{line['prefix']}{v[0]}.{v[1]}" + (f".{v[2]}" if v[2] else "")


def bump(v, level):
    if level >= 3:
        return (v[0] + 1, 0, 0)
    if level == 2:
        return (v[0], v[1] + 1, 0)
    return (v[0], v[1], v[2] + 1)


def latest(tags):
    vs = [parse(t) for t in tags if parse(t)]
    return max(vs) if vs else None


def guess(files):
    """Passo deciso dai file: [(stato, righe aggiunte, percorso)] di un commit."""
    code = [(s, n, p) for s, n, p in files if p.startswith(line["code"])
            and not p.startswith(line.get("skip", ())) and "/test" not in p]
    if any(s == "A" for s, _, _ in code) or sum(n for _, n, _ in code) >= BIG:
        return 2
    return 1


def asked(message, labels):
    """Passo chiesto a mano (etichetta della PR o riga nel messaggio), o 0."""
    pre = line["label"]
    found = [LEVELS[x.lower()[len(pre):]] for x in labels
             if x.lower().startswith(pre) and x.lower()[len(pre):] in LEVELS]
    found += [LEVELS[x.lower()] for x in line["trailer"].findall(message) if x.lower() in LEVELS]
    return max(found, default=0)


def pr_labels(sha):
    repo = os.environ.get("GITHUB_REPOSITORY")
    if not repo:
        return []
    try:
        out = subprocess.run(["gh", "api", f"repos/{repo}/commits/{sha}/pulls"],
                             capture_output=True, text=True, timeout=30).stdout
        return [l.get("name", "") for pr in json.loads(out or "[]") for l in pr.get("labels") or []]
    except Exception:
        return []


def commit_files(sha):
    status = {}
    for line in git("diff-tree", "--no-commit-id", "-r", "--root", "--name-status", sha).splitlines():
        parts = line.split("\t")
        if len(parts) >= 2:
            status[parts[-1]] = parts[0][0]
    files = []
    for line in git("diff-tree", "--no-commit-id", "-r", "--root", "--numstat", sha).splitlines():
        parts = line.split("\t")
        if len(parts) == 3:
            n = int(parts[0]) if parts[0].isdigit() else 0
            files.append((status.get(parts[2], "M"), n, parts[2]))
    return files


def level_of(sha):
    msg = git("log", "-1", "--format=%B", sha)
    return asked(msg, pr_labels(sha)) or guess(commit_files(sha))


def main():
    # Un nuovo giro sullo stesso commit riusa il suo numero
    here = latest(git("tag", "--points-at", "HEAD").split())
    if here:
        return fmt(here)
    prev = latest(git("tag", "--merged", "HEAD").split())
    if not prev:
        return fmt((1, 0, 0))
    only = ["--", *line["paths"]] if line["paths"] else []
    shas = git("log", "--no-merges", "--format=%H", f"{fmt(prev)}..HEAD", *only).split()
    level = max((level_of(s) for s in shas), default=1)
    new = bump(prev, level)
    taken = {parse(t) for t in git("tag", "-l").split() if parse(t)}
    while new in taken:                    # mai riusare un numero gia' pubblicato
        new = bump(new, 1)
    return fmt(new)


def test():
    global line
    line = LINES["server"]
    assert parse("v2026.11.23.6") is None and parse("v2026.11.24") is None
    assert parse("app-v1.0") is None and parse("tv-v1.0") is None
    assert parse("v1.0") == (1, 0, 0) and parse("v1.2.3") == (1, 2, 3)
    assert latest(["v2026.11.24", "v1.9", "v1.10", "app-tv", "apk-build"]) == (1, 10, 0)
    assert fmt(bump((1, 2, 3), 1)) == "v1.2.4"
    assert fmt(bump((1, 2, 3), 2)) == "v1.3"
    assert fmt(bump((1, 2, 3), 3)) == "v2.0"
    assert guess([("M", 10, "server/app.py"), ("M", 900, "README.md")]) == 1
    assert guess([("A", 40, "server/nuovo.py")]) == 2
    assert guess([("M", 120, "server/static/app.js")]) == 2
    assert guess([("M", 99, "server/app.py"), ("A", 300, "server/test_x.py")]) == 1
    assert guess([("A", 300, ".github/versione.py")]) == 1
    assert asked("Titolo\n\nVersione: maggiore\n", []) == 3
    assert asked("Titolo\n\nversione: Patch", []) == 1
    assert asked("La versione: nuova grafica", ["minor"]) == 2
    assert asked("niente", ["bug"]) == 0
    assert asked("Versione app: maggiore", ["app-minor"]) == 0
    assert guess([("A", 300, "android/app/Nuovo.kt")]) == 1
    line = LINES["app"]
    assert parse("app-v1.2") == (1, 2, 0) and parse("v1.2") is None
    assert latest(["v3.0", "app-v1.1", "tv-v9.0", "app-v1.0.4"]) == (1, 1, 0)
    assert fmt((2, 0, 0)) == "app-v2.0"
    assert guess([("A", 300, "android/app/Nuovo.kt")]) == 2
    assert guess([("M", 500, "server/app.py")]) == 1
    assert asked("Titolo\n\nVersione app: maggiore", ["minor"]) == 3
    assert asked("Versione: maggiore", ["app-patch"]) == 1
    assert guess([("A", 300, "android/tv/Main.kt")]) == 1
    line = LINES["tv"]
    assert parse("tv-v1.0") == (1, 0, 0) and parse("app-v1.0") is None
    assert guess([("A", 300, "android/tv/Main.kt")]) == 2
    assert asked("Versione TV: minore", ["app-major"]) == 2
    print("ok")


if __name__ == "__main__":
    if "--test" in sys.argv:
        test()
    else:
        line = LINES[sys.argv[1] if len(sys.argv) > 1 else "server"]
        print(main())
