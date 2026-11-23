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
import time

TABLE = json.load(open(os.path.join(os.path.dirname(__file__), "versioni-storiche.json"), encoding="utf-8"))
REPO = os.environ["GITHUB_REPOSITORY"]


def run(*a, check=True):
    # Un push di tag puo' essere rifiutato per un attimo (subito dopo aver tolto
    # lo stesso nome): si riprova qualche volta prima di arrendersi
    for attempt in range(4 if a[:2] == ("git", "push") else 1):
        p = subprocess.run(a, capture_output=True, text=True)
        if p.returncode == 0 or not check:
            return p.stdout
        print(" ".join(a), "->", p.stderr.strip(), flush=True)
        time.sleep(5 * (attempt + 1))
    raise SystemExit(f"Non riuscito: {' '.join(a)}")


def api(path, *a):
    return json.loads(run("gh", "api", f"repos/{REPO}/{path}", *a) or "null")


def sha_of(tag):
    return run("git", "rev-parse", "-q", "--verify", f"refs/tags/{tag}^{{commit}}", check=False).strip()


server, app = TABLE["server"], TABLE["app"]
# La v1.0 di ieri per prima: il suo numero (e app-v1.0) passa alla release piu' vecchia
# (la v1.0 si riconosce dal commit: dopo, v1.0 e' il nome della release piu' vecchia)
def old_tag(t):
    sha = sha_of(t)
    return sha and (t != "v1.0" or sha == TABLE["v1.0_commit"])


todo = sorted((old for old in server if old != server[old] and old_tag(old)), key=lambda t: t != "v1.0")
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


def body(old, r):
    text = fix(r["body"])
    if old in app:
        text = text.replace("**App per la TV:** ricompilata in questa versione",
                            f"**App per la TV:** nuova versione {app[old][5:]}")
    return text


releases = {}
for page in range(1, 5):
    data = api(f"releases?per_page=100&page={page}")
    for r in data:
        releases[r["tag_name"]] = r
    if len(data) < 100:
        break

def make_tag(tag, sha):
    """Tag creato da GitHub, non con git push: col token del giro un push su un
    commit vecchio viene rifiutato (ha un workflows/apk.yml diverso)."""
    out = run("gh", "api", f"repos/{REPO}/git/refs", "-f", f"ref=refs/tags/{tag}", "-f", f"sha={sha}", check=False)
    if '"ref"' not in out:
        # Ripiego: una release di passaggio crea il tag, poi si toglie (il tag resta)
        r = api("releases", "-f", f"tag_name={tag}", "-f", f"target_commitish={sha}",
                "-f", f"name={tag}", "-f", "make_latest=false")
        api(f"releases/{r['id']}", "-X", "DELETE")
    run("git", "tag", "-f", tag, sha)


for old in todo:
    sha = sha_of(old)
    new = server[old]
    r = releases.get(old)
    if r:
        # La release si sposta sul tag nuovo: se non c'e' lo crea GitHub sul commit giusto
        api(f"releases/{r['id']}", "-X", "PATCH", "-f", f"tag_name={new}", "-f", f"target_commitish={sha}",
            "-f", f"name=BunkerPlex {new[1:]}", "-f", f"body={body(old, r)}")
        run("git", "tag", "-f", new, sha)
    elif not sha_of(new):
        make_tag(new, sha)
    if old in app and not sha_of(app[old]):
        make_tag(app[old], sha)
    gone = [old] + (["app-v1.0"] if old == "v1.0" and app.get(old, "app-v1.0") != "app-v1.0" else [])
    for tag in gone:
        if sha_of(tag):
            run("git", "push", "origin", f":refs/tags/{tag}")
            run("git", "tag", "-d", tag)
    print(old, "->", new, app.get(old, ""))

# I link alle versioni vecchie nelle note delle altre release
for tag, r in releases.items():
    if tag in server or tag == "app-tv":
        continue
    body = fix(r["body"])
    if body != (r["body"] or ""):
        api(f"releases/{r['id']}", "-X", "PATCH", "-f", f"body={body}")
