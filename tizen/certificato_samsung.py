"""Certificati Samsung per le TV che rifiutano quello generico di Tizen.

Le TV Samsung piu' nuove installano un'app solo se l'autore e il distributore sono
firmati da Samsung, e il distributore elenca le TV (DUID) su cui vale. Questo script
li chiede ai server di Samsung, come fa il Certificate Manager di Tizen Studio
(riferimento: Samsung/tizen-agent-skills, lib/core/samsung-cert.js e samsung-api.js):

  - chiave RSA 2048 e richiesta (CSR) firmata SHA-512, con openssl;
  - autore:       POST https://svdca.samsungqbe.com/apis/v3/authors
  - distributore: POST .../apis/v1/distributors (registra le TV), poi .../apis/v3/distributors
    con le TV come subjectAltName URI:URN:tizen:deviceid=<DUID> (fino a 50);
  - Samsung risponde col solo certificato: nel .p12 va anche l'autorita' che l'ha
    emesso (tizen/samsung-ca), cifrato PBE-SHA1-3DES perche' gli strumenti Tizen
    (Java 8) non leggono l'AES di OpenSSL 3.

Serve il gettone di un accesso all'account Samsung (dura un po', poi va rifatto):
lo prende il telefono di chi amministra BunkerPlex e il servizio account lo passa
qui (vedi .github/workflows/app-samsung.yml). L'autore resta sempre lo stesso finche'
vale (un anno): le TV accettano un aggiornamento solo dallo stesso autore. Il
distributore si rifa' a ogni TV nuova, con tutte le TV.

  certificato_samsung.py issue   <job.json> <cartella>   chiede i certificati a Samsung
  certificato_samsung.py restore <job.json> <cartella>   riscrive i .p12 gia' avuti

La password dei .p12 arriva da P12_PW. In <cartella>: author.p12, distributor.p12 e
result.json ({listed, author_until, distributor_until} oppure {error, detail}).
Uscita 0 se fatto, 3 se il gettone Samsung non vale piu', 4 se Samsung rallenta, 5 altro.
"""
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SERVICE = "https://svdca.samsungqbe.com/apis"
CA_DIR = Path(__file__).parent / "samsung-ca"
AUTHOR_CA = ("vd_tizen_dev_author_ca.cer",
             "50:79:19:6A:1C:32:87:2A:8B:CE:74:52:3F:C1:2A:D3:55:7E:2D:87:C5:6F:AF:BA:7C:6D:09:DC:ED:13:B7:10")
PUBLIC_CA = ("vd_tizen_dev_public2.crt",
             "BF:18:85:9E:B0:24:CC:1D:63:F0:08:DC:DD:D6:43:07:7B:0D:E5:3E:95:8F:35:99:3F:F0:08:8D:1A:1D:31:AE")
AUTHOR_NAME = "BunkerPlex"
MAX_TVS = 50
DUID = re.compile(r"^[A-Za-z0-9]{10,64}$")
# Un autore che scade entro un mese si rifa' (le TV con l'app firmata dal vecchio
# vanno poi aggiornate disinstallando prima: succede una volta l'anno)
AUTHOR_MARGIN = 30 * 86400


class Fail(Exception):
    def __init__(self, code, kind, detail):
        super().__init__(detail)
        self.code, self.kind, self.detail = code, kind, detail


def openssl(*args, env=None, data=None):
    r = subprocess.run(["openssl", *args], input=data, capture_output=True,
                       env={**os.environ, **(env or {})})
    if r.returncode != 0:
        raise Fail(5, "openssl", f"openssl {args[0]}: {r.stderr.decode(errors='replace').strip()[:300]}")
    return r.stdout


def ca_file(item):
    name, want = item
    path = CA_DIR / name
    pem = path.read_bytes()
    der = openssl("x509", "-in", str(path), "-outform", "DER")
    got = ":".join(f"{b:02X}" for b in hashlib.sha256(der).digest())
    if got != want:
        raise Fail(5, "ca", f"{name}: impronta diversa da quella attesa")
    return path, pem


def until(pem_path):
    out = openssl("x509", "-in", str(pem_path), "-noout", "-enddate").decode()
    when = datetime.strptime(out.strip().split("=", 1)[1], "%b %d %H:%M:%S %Y %Z")
    return when.replace(tzinfo=timezone.utc).timestamp()


def key_and_csr(work, name, config):
    key, cnf, csr = work / f"{name}.key", work / f"{name}.cnf", work / f"{name}.csr"
    cnf.write_text(config)
    openssl("genrsa", "-out", str(key), "2048")
    openssl("req", "-new", "-config", str(cnf), "-key", str(key), "-out", str(csr), "-sha512")
    return key, csr.read_text()


def author_config():
    return "\n".join(["[req]", "prompt = no", "distinguished_name = dn", "",
                      "[dn]", f"CN = {AUTHOR_NAME}", ""])


def distributor_config(duids):
    names = ["URN:tizen:packageid="] + [f"URN:tizen:deviceid={d}" for d in duids]
    return "\n".join(["[req]", "prompt = no", "distinguished_name = dn", "req_extensions = v3_req", "",
                      "[dn]", "CN = TizenSDK", "",
                      "[v3_req]", "subjectAltName = @alt_names", "",
                      "[alt_names]", *[f"URI.{i + 1} = {n}" for i, n in enumerate(names)], ""])


def multipart(fields, csr_name, csr):
    boundary = f"----bunkerplex{int(time.time() * 1000)}"
    out = b""
    for k, v in fields:
        out += f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
    out += (f'--{boundary}\r\nContent-Disposition: form-data; name="csr"; filename="{csr_name}"\r\n'
            "Content-Type: application/octet-stream\r\n\r\n").encode() + csr.encode() + b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return out, f"multipart/form-data; boundary={boundary}"


def ask(path, fields, csr_name, csr):
    body, ctype = multipart(fields, csr_name, csr)
    req = urllib.request.Request(SERVICE + path, data=body, method="POST",
                                 headers={"Content-Type": ctype, "User-Agent": "BunkerPlex"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            text = r.read().decode("utf-8", errors="replace").strip()
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", errors="replace").strip()[:500]
        if e.code == 403:
            raise Fail(4, "rate", "Samsung rallenta le richieste: si riprova piu' tardi")
        # Gettone scaduto o non valido: serve un nuovo accesso all'account Samsung
        if e.code in (400, 401) and re.search(r"token|auth|login|expire", text, re.I):
            raise Fail(3, "token", f"Samsung ({e.code}): {text}")
        if e.code == 401:
            raise Fail(3, "token", f"Samsung (401): {text}")
        raise Fail(5, "samsung", f"Samsung ({e.code}) su {path}: {text}")
    except urllib.error.URLError as e:
        raise Fail(5, "net", f"Samsung non risponde: {e.reason}")
    if not text:
        raise Fail(5, "samsung", f"Samsung non ha risposto niente su {path}")
    if text.startswith("{"):
        try:
            err = json.loads(text)
        except ValueError:
            err = {}
        if re.search(r"token|auth", json.dumps(err), re.I):
            raise Fail(3, "token", f"Samsung: {text[:300]}")
        raise Fail(5, "samsung", f"Samsung su {path}: {text[:300]}")
    return text


def leaf_for(work, name, pem, key):
    """Il certificato di Samsung, controllato contro la nostra chiave."""
    if "BEGIN CERTIFICATE" not in pem:
        raise Fail(5, "samsung", f"Samsung non ha risposto con un certificato ({name}): {pem[:200]}")
    crt = work / f"{name}.crt"
    crt.write_text(pem.strip() + "\n")
    a = openssl("x509", "-in", str(crt), "-noout", "-pubkey")
    b = openssl("pkey", "-in", str(key), "-pubout")
    if a.strip() != b.strip():
        raise Fail(5, "samsung", f"Samsung ha risposto con un certificato ({name}) per un'altra chiave")
    return crt


def p12(work, key, crt, ca_path, name, out, pw):
    openssl("pkcs12", "-export", "-in", str(crt), "-inkey", str(key), "-certfile", str(ca_path),
            "-name", name, "-certpbe", "PBE-SHA1-3DES", "-keypbe", "PBE-SHA1-3DES", "-macalg", "sha1",
            "-passout", "env:P12_PW", "-out", str(out), env={"P12_PW": pw})


def p12_until(path, pw):
    """Quando scade il certificato principale di un .p12 (0 se non si legge)."""
    try:
        pem = openssl("pkcs12", "-in", str(path), "-clcerts", "-nokeys", "-passin", "env:P12_PW",
                      env={"P12_PW": pw})
        with tempfile.NamedTemporaryFile("wb", suffix=".pem", delete=False) as f:
            f.write(pem)
        try:
            return until(f.name)
        finally:
            os.unlink(f.name)
    except Fail:
        return 0


def clean_duids(raw):
    out = []
    for d in raw or []:
        d = str(d).strip()
        if DUID.match(d) and d not in out:
            out.append(d)
    return out[:MAX_TVS]


def restore(job, dest, pw):
    keys = job.get("keys") or {}
    if not keys.get("author") or not keys.get("distributor"):
        raise Fail(5, "keys", "Nessun certificato Samsung ancora")
    (dest / "author.p12").write_bytes(base64.b64decode(keys["author"]))
    (dest / "distributor.p12").write_bytes(base64.b64decode(keys["distributor"]))
    return {"listed": clean_duids(job.get("listed")),
            "author_until": p12_until(dest / "author.p12", pw),
            "distributor_until": p12_until(dest / "distributor.p12", pw)}


def issue(job, dest, pw):
    tok = job.get("token") or {}
    if not tok.get("access_token") or not tok.get("user_id"):
        raise Fail(3, "token", "Manca l'accesso all'account Samsung")
    duids = clean_duids(job.get("duids"))
    if not duids:
        raise Fail(5, "duids", "Nessuna TV da mettere nel certificato")
    access = [("access_token", tok["access_token"]), ("user_id", tok["user_id"])]
    author_ca, _ = ca_file(AUTHOR_CA)
    public_ca, _ = ca_file(PUBLIC_CA)
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        # Autore: quello di prima finche' vale (le TV aggiornano solo dallo stesso autore)
        keys = job.get("keys") or {}
        author_new = True
        if keys.get("author"):
            (dest / "author.p12").write_bytes(base64.b64decode(keys["author"]))
            if p12_until(dest / "author.p12", pw) > time.time() + AUTHOR_MARGIN:
                author_new = False
        if author_new:
            key, csr = key_and_csr(work, "author", author_config())
            pem = ask("/v3/authors", access + [("platform", "VD")], "author.csr", csr)
            crt = leaf_for(work, "author", pem, key)
            p12(work, key, crt, author_ca, "author", dest / "author.p12", pw)
        # Distributore: sempre nuovo, con tutte le TV
        key, csr = key_and_csr(work, "distributor", distributor_config(duids))
        level = [("privilege_level", "Public"), ("developer_type", "Individual")]
        ask("/v1/distributors", access + level + [("platform", "VD")], "distributor.csr", csr)
        pem = ask("/v3/distributors", access + level, "distributor.csr", csr)
        crt = leaf_for(work, "distributor", pem, key)
        p12(work, key, crt, public_ca, "distributor", dest / "distributor.p12", pw)
    return {"listed": duids, "author_new": author_new,
            "author_until": p12_until(dest / "author.p12", pw),
            "distributor_until": p12_until(dest / "distributor.p12", pw)}


def main():
    if len(sys.argv) != 4 or sys.argv[1] not in ("issue", "restore"):
        print(__doc__)
        return 2
    mode, job_path, dest = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
    pw = os.environ.get("P12_PW", "")
    if not pw:
        print("Manca P12_PW")
        return 2
    dest.mkdir(parents=True, exist_ok=True)
    job = json.loads(job_path.read_text())
    try:
        res = (issue if mode == "issue" else restore)(job, dest, pw)
        res["keys"] = {"author": base64.b64encode((dest / "author.p12").read_bytes()).decode(),
                       "distributor": base64.b64encode((dest / "distributor.p12").read_bytes()).decode()}
        (dest / "result.json").write_text(json.dumps(res))
        print(f"Certificato Samsung per {len(res['listed'])} TV")
        return 0
    except Fail as e:
        (dest / "result.json").write_text(json.dumps({"error": e.kind, "detail": e.detail}))
        print(f"::warning::{e.detail}")
        return e.code


if __name__ == "__main__":
    sys.exit(main())
