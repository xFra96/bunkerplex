"""Account di BunkerPlex: dialogo con il servizio account (Cloudflare Worker).

Il servizio tiene gli account, le impostazioni e i visti di ognuno, cosi' sono
uguali su tutti i PC dove si entra con lo stesso account. Le cartelle dei video
restano su ogni PC. Senza Internet il server va avanti con la copia locale.

L'indirizzo del servizio sta in server/cloud.json (arriva con gli aggiornamenti)
oppure nella variabile BUNKERPLEX_CLOUD. Se manca, BunkerPlex funziona come
prima: senza login.
"""
import contextvars
import hashlib
import json
import os
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Chi sta facendo la richiesta: {id, name, admin, must_change, libs, session} oppure None
CURRENT = contextvars.ContextVar("bunkerplex_user", default=None)


def cloud_url():
    env = os.environ.get("BUNKERPLEX_CLOUD", "").strip()
    if env:
        return env.rstrip("/")
    try:
        return str(json.loads((HERE / "cloud.json").read_text("utf-8")).get("url") or "").strip().rstrip("/")
    except (OSError, ValueError):
        return ""


def verifier(username, password):
    """La password non lascia mai il PC: al servizio va questa impronta lenta da calcolare."""
    salt = ("bunkerplex:" + str(username).strip().lower()).encode("utf-8")
    return hashlib.pbkdf2_hmac("sha256", str(password).encode("utf-8"), salt, 200_000).hex()


class CloudError(Exception):
    """Il servizio ha risposto con un errore (password sbagliata, gettone scaduto...)."""

    def __init__(self, status, detail, data=None):
        super().__init__(detail)
        self.status = status
        self.detail = detail
        self.data = data or {}       # tutta la risposta (es. l'elenco dei dispositivi al limite)


class CloudOffline(Exception):
    """Il servizio non si raggiunge (niente Internet, servizio non configurato)."""


def call(method, path, body=None, token=None, timeout=12):
    base = cloud_url()
    if not base:
        raise CloudOffline("Servizio account non configurato")
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Accept": "application/json", "User-Agent": "BunkerPlex"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as ex:
        try:
            data = json.loads(ex.read().decode("utf-8", "replace"))
            data = data if isinstance(data, dict) else {}
        except Exception:
            data = {}
        raise CloudError(ex.code, data.get("detail") or f"Servizio account: errore {ex.code}", data)
    except Exception:
        raise CloudOffline("Non riesco a contattare il servizio account: controlla la connessione del PC")
