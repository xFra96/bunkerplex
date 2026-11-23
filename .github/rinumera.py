"""Rinumera le release vecchie (a data, v2026.11.23.6, e la prima v1.0) con i
numeri nuovi, come se le regole di .github/versione.py ci fossero state da
sempre. La tabella e' in .github/versioni-storiche.json: "server" (vecchio tag ->
nuovo tag della release) e "app" (vecchio tag della release -> tag app-v... da
mettere sullo stesso commit, solo dove l'APK era stato ricompilato).

Lo lancia il giro "Pubblica la release" prima di calcolare il numero nuovo; se i
vecchi tag non ci sono piu' non fa niente, quindi gira davvero una volta sola.
"""
import json
import os
import re
import subprocess

TABLE = json.load(open(os.path.join(os.path.dirname(__file__), "versioni-storiche.json"), encoding="utf-8"))
REPO = os.environ["GITHUB_REPOSITORY"]


def run(*a, check=True):
    return subprocess.run(a, capture_output=True, text=True, check=check).stdout


def api(path, *a):
    return json.loads(run("gh", "api", f"repos/{REPO}/{path}", *a) or "null")


def sha_of(tag):
    return run("git", "rev-parse", "-q", "--verify", f"refs/tags/{tag}^{{commit}}", check=False).strip()


server, app = TABLE["server"], TABLE["app"]
todo = [old for old in server if old != server[old] and sha_of(old)]
if not todo:
    print("Niente da rinumerare")
    raise SystemExit

# Testi: ogni vecchio numero diventa quello nuovo, in un solo passaggio (cosi'
# un numero appena messo non viene cambiato di nuovo). I numeri a data anche
# senza "v" (nei titoli), la vecchia v1.0 solo col suo tag.
names = {}
for old, new in server.items():
    names[old] = new
    if old.startswith("v20"):
        names[old[1:]] = new[1:]
if "v1.0" in app:
    names["nuova versione 1.0:"] = f"nuova versione {app['v1.0'][5:]}:"
RX = re.compile(r"(?<![\w-])(?<!\d\.)(" + "|".join(re.escape(k) for k in sorted(names, key=len, reverse=True))
                + r")(?!\w|\.\d)")


def fix(text):
    return RX.sub(lambda m: names[m[1]], text or "")


releases = {}
for page in range(1, 5):
    data = api(f"releases?per_page=100&page={page}")
    for r in data:
        releases[r["tag_name"]] = r
    if len(data) < 100:
        break

for old in todo:
    sha = sha_of(old)
    new = server[old]
    for tag in [new] + ([app[old]] if old in app else []):
        if not sha_of(tag):
            run("git", "tag", tag, sha)
            run("git", "push", "origin", f"refs/tags/{tag}")
    r = releases.get(old)
    if r:
        api(f"releases/{r['id']}", "-X", "PATCH", "-f", f"tag_name={new}",
            "-f", f"name=BunkerPlex {new[1:]}", "-f", f"body={fix(r['body'])}")
    run("git", "push", "origin", f":refs/tags/{old}")
    run("git", "tag", "-d", old)
    print(old, "->", new, app.get(old, ""))

# L'app 1.0 di prima diventa la sua versione vera (stesso commit)
if "v1.0" in app and app["v1.0"] != "app-v1.0" and sha_of("app-v1.0"):
    run("git", "push", "origin", ":refs/tags/app-v1.0")
    run("git", "tag", "-d", "app-v1.0")

# I link alle versioni vecchie nelle note delle altre release
for tag, r in releases.items():
    if tag in server or tag == "app-tv":
        continue
    body = fix(r["body"])
    if body != (r["body"] or ""):
        api(f"releases/{r['id']}", "-X", "PATCH", "-f", f"body={body}")
