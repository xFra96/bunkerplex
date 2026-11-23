"""«Guarda su»: manda un video del catalogo a una TV di casa che non ha l'app
BunkerPlex: le TV con DLNA (Samsung, LG, Sony, Philips...) e i Chromecast /
Google TV. Sulla TV non si installa niente: il video lo apre il suo lettore.

Il server fa tutto: trova i dispositivi nella rete di casa, li comanda (avvia,
pausa, salta, ferma) e chiede a che punto sono, per salvare la ripresa come fa
il player e per far partire da solo l'episodio dopo.

Il server gira dentro Docker, da dove la ricerca "multicast" (SSDP, mDNS) non
esce: i dispositivi si cercano provando una per una le porte dove rispondono
(come fa tvinstall con le TV Android).

La TV prende il video da /api/cast/media/<biglietto>/...: un indirizzo aperto
(la TV non ha un accesso), ma con un biglietto casuale che vale solo per quel
video di quell'account e scade a fine visione.
"""

import html
import ipaddress
import json
import os
import re
import secrets
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from xml.etree import ElementTree as ET

KNOWN = Path(os.environ.get("DATA_DIR", "/data")) / "cast.json"

AVT = "urn:schemas-upnp-org:service:AVTransport:1"
# Porte dove le TV DLNA espongono la descrizione del "renderer" (9197, 7676: Samsung;
# 49152-49155: la libreria UPnP piu' diffusa) e dove risponde il Chromecast (8009)
DLNA_PORTS = (9197, 7676, 49152, 49153, 49154, 49155)
DLNA_PATHS = ("/dmr", "/description.xml", "/rootDesc.xml", "/DeviceDescription.xml",
              "/upnp/desc.xml", "/desc.xml", "/dd.xml", "/")
CAST_PORT = 8009
SCAN_EVERY = 600                     # la lista si ricontrolla da sola ogni 10 minuti

_hooks = {"lan_ip": lambda: "", "media": None, "save": None, "next": None}
_devices = {}                        # id -> Dlna / Chromecast
_scan = {"at": 0.0, "running": False, "error": ""}
_scan_lock = threading.Lock()
_sessions = {}                       # id del dispositivo -> Session
_tickets = {}                        # biglietto -> {"user", "item", "plan", "at"}
_lock = threading.Lock()


class CastError(Exception):
    """Errore da mostrare cosi' com'e' (in italiano)."""


def setup(lan_ip, media, save, next_item):
    """Lo chiama app.py.
    lan_ip(): indirizzo del PC nella rete di casa.
    media(user, item_id, kind): dati del video per quel tipo di dispositivo
      (titolo, durata, come mandarlo: file originale o conversione).
    save(user, item_id, pos, dur): salva la ripresa; True se il titolo e' finito.
    next_item(user, item_id): l'episodio dopo (0 se non c'e')."""
    _hooks.update(lan_ip=lan_ip, media=media, save=save, next=next_item)


def _xml_text(root, name):
    for el in root.iter():
        if el.tag.rsplit("}", 1)[-1] == name:
            return (el.text or "").strip()
    return ""


def _get(url, timeout=3.0):
    req = urllib.request.Request(url, headers={"User-Agent": "BunkerPlex"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(200_000)


# ---------------------------------------------------------------- DLNA

class Dlna:
    kind = "dlna"

    def __init__(self, ip, name, model, control):
        self.ip, self.name, self.model, self.control = ip, name, model, control
        self.id = f"dlna-{ip}"

    def label(self):
        return "TV · DLNA"

    def _soap(self, action, args=(), timeout=8.0):
        body = ('<?xml version="1.0" encoding="utf-8"?>'
                '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
                's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>'
                f'<u:{action} xmlns:u="{AVT}"><InstanceID>0</InstanceID>'
                + "".join(f"<{k}>{html.escape(str(v), quote=False)}</{k}>" for k, v in args)
                + f"</u:{action}></s:Body></s:Envelope>")
        req = urllib.request.Request(self.control, data=body.encode("utf-8"), headers={
            "Content-Type": 'text/xml; charset="utf-8"', "SOAPACTION": f'"{AVT}#{action}"',
            "User-Agent": "BunkerPlex"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return ET.fromstring(r.read())
        except urllib.error.HTTPError as ex:
            try:
                why = _xml_text(ET.fromstring(ex.read()), "errorDescription")
            except Exception:
                why = ""
            raise CastError(f"La TV ha rifiutato il comando ({action}{': ' + why if why else ''})")
        except (OSError, ET.ParseError):
            raise CastError(f"«{self.name}» non risponde: è accesa?")

    def load(self, url, media, start):
        try:
            self._soap("Stop", timeout=4)
        except CastError:
            pass                     # niente in riproduzione: va bene
        self._soap("SetAVTransportURI", [("CurrentURI", url), ("CurrentURIMetaData", didl(url, media))])
        self._soap("Play", [("Speed", "1")])
        if start > 5 and media["seekable"]:
            # Il salto funziona solo a video partito: si aspetta che la TV lo dica
            def later():
                for _ in range(40):
                    time.sleep(0.5)
                    try:
                        if self.status()[0] == "playing":
                            self.seek(start)
                            return
                    except CastError:
                        pass
            threading.Thread(target=later, daemon=True).start()

    def pause(self):
        self._soap("Pause")

    def play(self):
        self._soap("Play", [("Speed", "1")])

    def seek(self, pos):
        self._soap("Seek", [("Unit", "REL_TIME"), ("Target", hms(pos))])

    def stop(self):
        self._soap("Stop", timeout=4)

    def status(self):
        """(stato, posizione, durata): stato = playing / paused / loading / stopped."""
        t = _xml_text(self._soap("GetTransportInfo", timeout=4), "CurrentTransportState")
        p = self._soap("GetPositionInfo", timeout=4)
        state = {"PLAYING": "playing", "PAUSED_PLAYBACK": "paused", "TRANSITIONING": "loading",
                 "STOPPED": "stopped", "NO_MEDIA_PRESENT": "stopped"}.get(t, "loading")
        return state, secs(_xml_text(p, "RelTime")), secs(_xml_text(p, "TrackDuration"))

    def close(self):
        pass


def didl(url, media):
    """La descrizione del video che le TV DLNA vogliono insieme all'indirizzo."""
    flags = "DLNA.ORG_OP=01;DLNA.ORG_CI=0" if media["seekable"] else "DLNA.ORG_OP=00;DLNA.ORG_CI=1"
    info = f"http-get:*:{media['mime']}:{flags};DLNA.ORG_FLAGS=01700000000000000000000000000000"
    size = f' size="{int(media["size"])}"' if media.get("size") else ""
    dur = f' duration="{hms(media["duration"])}.000"' if media.get("duration") else ""
    poster = (f"<upnp:albumArtURI>{html.escape(media['poster'])}</upnp:albumArtURI>"
              if media.get("poster") else "")
    return ('<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/" '
            'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" '
            'xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">'
            '<item id="1" parentID="0" restricted="1">'
            f"<dc:title>{html.escape(media['title'])}</dc:title>"
            "<upnp:class>object.item.videoItem.movie</upnp:class>" + poster +
            f'<res protocolInfo="{info}"{size}{dur}>{html.escape(url)}</res>'
            "</item></DIDL-Lite>")


def dlna_flags(seekable):
    """Intestazione che le TV DLNA (Samsung in testa) vogliono nella risposta del video."""
    return ("DLNA.ORG_OP=01;DLNA.ORG_CI=0" if seekable else "DLNA.ORG_OP=00;DLNA.ORG_CI=1") + \
        ";DLNA.ORG_FLAGS=01700000000000000000000000000000"


def _dlna_at(ip, port):
    """Il renderer DLNA su ip:porta, se c'e' (None se e' altro)."""
    for path in DLNA_PATHS:
        base = f"http://{ip}:{port}"
        try:
            root = ET.fromstring(_get(base + path, 2.5))
        except Exception:
            continue
        if "MediaRenderer" not in _xml_text(root, "deviceType"):
            continue
        control = ""
        for svc in root.iter():
            if svc.tag.rsplit("}", 1)[-1] == "service" and _xml_text(svc, "serviceType").startswith(
                    "urn:schemas-upnp-org:service:AVTransport"):
                control = _xml_text(svc, "controlURL")
        if not control:
            continue
        maker = _xml_text(root, "manufacturer")
        if "sonos" in maker.lower():       # casse: niente video
            return None
        base_url = _xml_text(root, "URLBase") or base
        return Dlna(ip, _xml_text(root, "friendlyName") or f"TV {ip}",
                    " ".join(x for x in (maker.split()[0] if maker else "", _xml_text(root, "modelName")) if x),
                    urllib.parse.urljoin(base_url + "/", control.lstrip("/") if not control.startswith("/") else control))
    return None


# ---------------------------------------------------------------- Chromecast

class Chromecast:
    kind = "chromecast"

    def __init__(self, ip, name, model, udn):
        self.ip, self.name, self.model, self.udn = ip, name, model, udn
        self.id = f"cast-{ip}"
        self._cc = None

    def label(self):
        return "Chromecast"

    def _connect(self):
        if self._cc is not None:
            return self._cc
        try:
            import pychromecast
        except ImportError:
            raise CastError("Per il Chromecast serve l'ultimo aggiornamento di BunkerPlex (pacchetto mancante)")
        try:
            cc = pychromecast.get_chromecast_from_host(
                (self.ip, CAST_PORT, self.udn, self.model or None, self.name), tries=2, retry_wait=1, timeout=8)
            cc.wait(timeout=10)
        except Exception:
            raise CastError(f"«{self.name}» non risponde: è acceso?")
        self._cc = cc
        return cc

    def _media(self):
        return self._connect().media_controller

    def load(self, url, media, start):
        mc = self._media()
        mc.play_media(url, media["mime"], title=media["title"], thumb=media.get("poster") or None,
                      current_time=start if media["seekable"] and start > 5 else None,
                      stream_type="BUFFERED" if media["seekable"] else "LIVE",
                      metadata={"metadataType": 0, "title": media["title"],
                                "subtitle": media.get("subtitle") or ""})
        mc.block_until_active(timeout=20)

    def pause(self):
        self._media().pause()

    def play(self):
        self._media().play()

    def seek(self, pos):
        self._media().seek(pos)

    def stop(self):
        try:
            self._media().stop()
        finally:
            self.close()

    def status(self):
        if self._cc is None:
            return "stopped", 0.0, 0.0
        s = self._media().status
        state = {"PLAYING": "playing", "PAUSED": "paused", "BUFFERING": "loading"}.get(s.player_state, "stopped")
        if s.player_state == "IDLE" and s.idle_reason is None:
            state = "loading"            # appena caricato, non ancora partito
        return state, float(s.adjusted_current_time or 0), float(s.duration or 0)

    def close(self):
        if self._cc is not None:
            try:
                self._cc.disconnect(timeout=3)
            except Exception:
                pass
            self._cc = None


def _cast_at(ip):
    name, model, udn = "", "", None
    try:
        import json
        info = json.loads(_get(f"http://{ip}:8008/setup/eureka_info?params=name,device_info,ssdp_udn", 2.5))
        name = info.get("name") or ""
        model = (info.get("device_info") or {}).get("model_name") or ""
        if info.get("ssdp_udn"):
            udn = uuid.UUID(info["ssdp_udn"])
    except Exception:
        pass
    return Chromecast(ip, name or f"Chromecast {ip}", model, udn or uuid.uuid5(uuid.NAMESPACE_DNS, ip))


# ---------------------------------------------------------------- TV con l'app

class AppTv:
    """Una TV con l'app BunkerPlex: niente da cercare, si fa viva lei ogni paio di
    secondi (app_poll), dice cosa sta guardando e prende i comandi. Il video lo
    apre il player dell'app, con tutto (24 Hz, tracce, sottotitoli), e la ripresa
    la salva lui."""
    kind = "app"
    self_saving = True

    def __init__(self, cid, name):
        self.cid, self.name, self.model = cid, name, ""
        self.id = f"app-{cid}"
        self.queue = []
        self.state = {}
        self.seen = 0.0
        self.player_seen = 0.0

    @property
    def online(self):
        return time.time() - self.seen < 30

    def label(self):
        return "App BunkerPlex"

    def _push(self, cmd):
        if not self.online:
            raise CastError(f"«{self.name}» non risponde: apri BunkerPlex sulla TV")
        self.queue.append(cmd)

    def load(self, url, media, start):
        self.queue = []
        self._push({"cmd": "load", "item": media["item"], "at": start if start > 5 else 0})

    def pause(self):
        self._push({"cmd": "pause"})

    def play(self):
        self._push({"cmd": "play"})

    def seek(self, pos):
        self._push({"cmd": "seek", "to": pos})

    def stop(self):
        self._push({"cmd": "stop"})

    def status(self):
        if not self.online:
            raise CastError("TV non raggiungibile")
        st = self.state
        return (st.get("state") or "stopped", float(st.get("position") or 0), float(st.get("duration") or 0),
                int(st.get("item") or 0))

    def close(self):
        pass


async def app_poll(body, wait=2.0):
    """La TV con l'app si fa viva: aggiorna cosa sta guardando e prende i comandi
    (aspettandoli fino a 'wait' secondi, cosi' arrivano subito)."""
    import asyncio
    cid = re.sub(r"[^A-Za-z0-9_-]", "", str(body.get("id") or ""))[:40]
    if not cid:
        return []
    name = str(body.get("name") or "TV").strip()[:60] or "TV"
    with _lock:
        d = _devices.get(f"app-{cid}")
        if not isinstance(d, AppTv):
            d = AppTv(cid, name)
            _devices[d.id] = d
        d.name = name
        d.seen = time.time()
        player = body.get("source") == "player"
        if player:
            # Il player che si chiude lo dice: da li' i comandi tornano alle pagine
            d.player_seen = 0.0 if body.get("state") == "stopped" else time.time()
        # Le pagine dell'app restano vive dietro al player: conta quello che dice il player
        if player or time.time() - d.player_seen > 6:
            d.state = {"state": str(body.get("state") or "stopped"), "position": _num(body.get("position")),
                       "duration": _num(body.get("duration")), "item": int(_num(body.get("item")))}
    if body.get("wait") == 0:
        return []
    end = time.time() + wait
    while True:
        with _lock:
            # Col player aperto i comandi sono tutti suoi (anche «apri questo titolo»);
            # senza, le pagine prendono «apri questo titolo» e aprono il player
            player_open = time.time() - d.player_seen <= 6
            take = [c for c in d.queue if player or (not player_open and c["cmd"] == "load")]
            if take:
                d.queue = [c for c in d.queue if c not in take]
                return take
        if time.time() >= end:
            return []
        await asyncio.sleep(0.2)


def _num(v):
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


# ---------------------------------------------------------------- ricerca

def _open(ip, port):
    try:
        with socket.create_connection((ip, port), timeout=0.4):
            return True
    except OSError:
        return False


def scan(force=False):
    """Cerca i dispositivi nella rete del PC (qualche secondo). Ritorna la lista."""
    with _scan_lock:
        if not force and time.time() - _scan["at"] < SCAN_EVERY and _scan["at"]:
            return devices()
        _scan["running"] = True
        try:
            pc = _hooks["lan_ip"]()
            try:
                net = ipaddress.ip_network(f"{pc}/24", strict=False)
            except ValueError:
                _scan["error"] = ("Non conosco ancora l'indirizzo di questo PC nella rete di casa: "
                                  "apri BunkerPlex con l'indirizzo del PC invece di localhost")
                return devices()
            hosts = [str(h) for h in net.hosts() if str(h) != pc]
            probes = [(h, p) for h in hosts for p in DLNA_PORTS + (CAST_PORT,)]
            with ThreadPoolExecutor(128) as pool:
                hits = [hp for hp, ok in zip(probes, pool.map(lambda hp: _open(*hp), probes)) if ok]
            found = {}
            with ThreadPoolExecutor(16) as pool:
                jobs = []
                # Un indirizzo con piu' porte aperte: basta la prima che risponde da renderer
                ports = {}
                for ip, port in hits:
                    if port == CAST_PORT:
                        jobs.append(pool.submit(_cast_at, ip))
                    else:
                        ports.setdefault(ip, []).append(port)
                for ip, plist in ports.items():
                    jobs.append(pool.submit(lambda ip=ip, plist=plist: next(
                        (d for d in (_dlna_at(ip, p) for p in plist) if d), None)))
                for j in jobs:
                    try:
                        d = j.result(timeout=20)
                    except Exception:
                        d = None
                    if d and d.id not in found:
                        found[d.id] = d
            with _lock:
                # Chi non risponde resta in elenco come «spenta» (una TV in standby non si vede)
                for k, d in _devices.items():
                    if not isinstance(d, AppTv):    # le TV con l'app si fanno vive da sole
                        d.online = k in found or k in _sessions
                for k, d in found.items():
                    if k not in _sessions:      # chi sta trasmettendo resta com'e'
                        d.online = True
                        _devices[k] = d
                _remember()
            _scan.update(at=time.time(), error="")
            return devices()
        finally:
            _scan["running"] = False


def scan_later(delay=20):
    """Prima ricerca poco dopo l'avvio del server, cosi' la lista e' gia' pronta."""
    with _lock:
        _load_known()

    def run():
        time.sleep(delay)
        try:
            scan()
        except Exception as ex:
            print("Ricerca TV per «Guarda su» non riuscita:", repr(ex), flush=True)
    threading.Thread(target=run, daemon=True).start()


def devices():
    with _lock:
        return [{"id": d.id, "name": d.name, "kind": d.kind, "label": d.label(), "model": d.model,
                 "busy": d.id in _sessions, "online": getattr(d, "online", True)}
                for d in sorted(_devices.values(), key=lambda d: (not getattr(d, "online", True), d.name.lower()))
                if d.kind != "app" or d.online]       # TV con l'app spenta o chiusa: non c'e'


# I dispositivi trovati si ricordano (data/cast.json): anche spenti restano in elenco
def _remember():
    out = []
    for d in _devices.values():
        if d.kind == "app":
            continue
        if d.kind == "dlna":
            out.append({"kind": "dlna", "ip": d.ip, "name": d.name, "model": d.model, "control": d.control})
        else:
            out.append({"kind": "chromecast", "ip": d.ip, "name": d.name, "model": d.model, "udn": str(d.udn)})
    try:
        tmp = KNOWN.with_suffix(".tmp")
        tmp.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(KNOWN)
    except OSError:
        pass


def _load_known():
    try:
        saved = json.loads(KNOWN.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    for x in saved if isinstance(saved, list) else []:
        try:
            if x["kind"] == "dlna":
                d = Dlna(x["ip"], x["name"], x.get("model") or "", x["control"])
            else:
                d = Chromecast(x["ip"], x["name"], x.get("model") or "", uuid.UUID(x["udn"]))
        except (KeyError, ValueError, TypeError):
            continue
        d.online = False             # finche' la ricerca non lo ritrova
        _devices[d.id] = d


# ---------------------------------------------------------------- biglietti

def ticket(t):
    """Il video di un biglietto (None se non vale)."""
    with _lock:
        tk = _tickets.get(t)
    return tk


def _new_ticket(user, item_id, plan):
    t = secrets.token_urlsafe(24)
    with _lock:
        # Biglietti di visioni finite da piu' di 6 ore: via
        live = {s.ticket for s in _sessions.values()}
        for k, v in list(_tickets.items()):
            if k not in live and time.time() - v["at"] > 6 * 3600:
                del _tickets[k]
        _tickets[t] = {"user": user, "item": item_id, "plan": plan, "at": time.time()}
    return t


# ---------------------------------------------------------------- visioni

class Session:
    def __init__(self, device, user, item_id, media):
        self.device, self.user, self.item, self.media = device, user, item_id, media
        self.ticket = ""
        self.offset = 0.0            # in conversione: da che punto parte il flusso
        self.state, self.position, self.duration = "loading", 0.0, float(media.get("duration") or 0)
        self.started = time.time()
        self.seen_playing = False
        self.saved_at = 0.0
        self.error = ""
        self.ended = False
        self.wake = threading.Event()
        self.gen = 0                 # cambia a ogni nuovo video (salto in conversione, episodio dopo)

    def url(self, start):
        m = self.media
        if m["seekable"]:
            return f"http://{_hooks['lan_ip']()}:32500/api/cast/media/{self.ticket}/video{m['ext']}"
        return f"http://{_hooks['lan_ip']()}:32500/api/cast/media/{self.ticket}/{int(start)}/video{m['ext']}"

    def public(self):
        m = self.media
        return {"device": self.device.id, "device_name": self.device.name, "kind": self.device.kind,
                "item": self.item, "title": m["title"], "subtitle": m.get("subtitle") or "",
                "poster": m.get("poster_path") or "", "state": self.state,
                "position": round(self.position, 1), "duration": round(self.duration or 0, 1),
                "seekable": True, "error": self.error, "next": m.get("next_title") or ""}


def start(user, device_id, item_id, at=None):
    """Manda il titolo al dispositivo, dal punto di ripresa (o da 'at' secondi)."""
    with _lock:
        dev = _devices.get(device_id)
    if not dev:
        raise CastError("Dispositivo non trovato: premi «Cerca di nuovo»")
    media = _hooks["media"](user, item_id, dev.kind)
    media["item"] = item_id
    old = _sessions.get(device_id)
    if old:
        _finish(old, keep_device=True)
    s = Session(dev, user, item_id, media)
    s.ticket = _new_ticket(user, item_id, media["plan"])
    pos = media.get("resume", 0.0) if at is None else max(0.0, float(at))
    _load(s, pos)
    with _lock:
        _sessions[device_id] = s
    threading.Thread(target=_watch, args=(s,), daemon=True).start()
    return s.public()


def _load(s, pos):
    s.gen += 1
    s.seen_playing = False
    s.started = time.time()
    s.state = "loading"
    if s.media["seekable"]:
        s.offset = 0.0
        s.device.load(s.url(0), s.media, pos)
    else:
        s.offset = pos
        s.device.load(s.url(pos), s.media, 0)
    s.position = pos


def session_for(user_id, device_id=None):
    with _lock:
        mine = [s for s in _sessions.values() if s.user["id"] == user_id]
    if device_id:
        mine = [s for s in mine if s.device.id == device_id]
    return mine


def status(user_id):
    return [s.public() for s in session_for(user_id)]


def control(user_id, device_id, action, to=None):
    found = session_for(user_id, device_id)
    if not found:
        raise CastError("Questa TV non sta trasmettendo niente")
    s = found[0]
    if action == "pause":
        s.device.pause()
        s.state = "paused"
        _save(s)
    elif action == "play":
        s.device.play()
        s.state = "playing"
    elif action == "seek":
        target = max(0.0, min(float(to or 0), (s.duration or 1e9) - 5))
        if s.media["seekable"]:
            s.device.seek(target)
        else:
            _load(s, target)        # in conversione si riparte da quel punto
        s.position = target
        s.saved_at = 0
    elif action == "stop":
        _finish(s)
        return {"stopped": True}
    s.wake.set()
    return s.public()


def _save(s, ended=False):
    if getattr(s.device, "self_saving", False):
        return False                 # l'app sulla TV salva la ripresa da se'
    if not s.duration and not s.position:
        return False
    try:
        done = _hooks["save"](s.user, s.item, s.position, s.duration, ended)
    except Exception as ex:
        print("Ripresa non salvata (Guarda su):", repr(ex), flush=True)
        return False
    s.saved_at = time.time()
    return done


def _finish(s, keep_device=False):
    with _lock:
        if _sessions.get(s.device.id) is s:
            del _sessions[s.device.id]
    s.ended = True
    s.wake.set()
    _save(s)
    if not keep_device:
        try:
            s.device.stop()
        except CastError:
            pass
        s.device.close()


def _watch(s):
    """Chiede alla TV a che punto e' ogni 2 secondi, salva la ripresa ogni 10 e,
    a fine episodio, fa partire quello dopo."""
    fails = 0
    while not s.ended:
        s.wake.wait(2)
        s.wake.clear()
        if s.ended:
            return
        gen = s.gen
        try:
            res = s.device.status()
            state, pos, dur = res[:3]
            fails = 0
        except CastError:
            fails += 1
            if fails >= 8:
                s.error = f"«{s.device.name}» non risponde più"
                _finish(s)
                return
            continue
        if gen != s.gen:
            continue                 # nel frattempo e' partito un altro video
        if len(res) > 3 and res[3] and res[3] != s.item and state != "stopped":
            # L'app sulla TV e' passata a un altro titolo (episodio dopo, scelto li'): si segue
            try:
                media = _hooks["media"](s.user, res[3], s.device.kind)
                media["item"] = res[3]
                s.item, s.media, s.duration = res[3], media, float(media.get("duration") or 0)
            except Exception:
                pass
        if state in ("playing", "paused"):
            s.seen_playing = True
            s.state = state
            if dur > 0 and not s.media.get("duration"):
                s.duration = dur
            if s.media["seekable"] or pos > 0:
                s.position = pos + s.offset
            if state == "playing" and time.time() - s.saved_at > 10:
                _save(s)
        elif state == "loading":
            s.state = "loading"
            if time.time() - s.started > 45 and not s.seen_playing:
                s.error = "La TV non riesce ad aprire il video"
                _finish(s)
                return
        else:   # stopped
            if not s.seen_playing:
                if time.time() - s.started > 30:
                    s.error = "La TV non ha fatto partire il video"
                    _finish(s)
                    return
                continue
            near_end = s.duration and s.position >= s.duration * 0.9
            _finish(s, keep_device=True)
            if near_end and not isinstance(s.device, AppTv):    # l'app passa da se' al successivo
                _save(s, ended=True)
                nxt = 0
                try:
                    nxt = _hooks["next"](s.user, s.item)
                except Exception:
                    pass
                if nxt:
                    try:
                        start(s.user, s.device.id, nxt, at=None)
                        return           # stesso dispositivo, stessa connessione
                    except CastError as ex:
                        print("Episodio dopo non partito (Guarda su):", ex, flush=True)
            s.device.close()
            return


# ---------------------------------------------------------------- utilita'

def hms(sec):
    sec = int(max(0, sec))
    return f"{sec // 3600}:{sec % 3600 // 60:02d}:{sec % 60:02d}"


def secs(text):
    m = re.match(r"(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)", text or "")
    if not m:
        return 0.0
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
