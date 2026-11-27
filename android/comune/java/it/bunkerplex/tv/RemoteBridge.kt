package it.bunkerplex.tv

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import kotlin.concurrent.thread

/**
 * Le funzioni di remote.html (fuori casa: account, Tailscale dentro l'app, player),
 * in comune tra l'app attuale e l'app TV nativa. Ognuna aggiunge le sue al ponte
 * BunkerPlexTV estendendo questa classe.
 */
abstract class RemoteBridge(private val act: Activity, private val web: WebView, private val tv: Boolean) {

    /** Sta per partire il player: al ritorno la pagina si aggiorna. */
    protected abstract fun playerStarting()

    /** Un server che risponde sulla rete di questo dispositivo: lo apre l'app (url senza / finale). */
    protected abstract fun openLocal(url: String)

    private fun js(code: String) = act.runOnUiThread { web.evaluateJavascript(code, null) }

    /** Risposta a una richiesta lenta della pagina: remoteDone(n, ok, testo). */
    private fun done(cb: Int, ok: Boolean, text: String) =
        js("window.remoteDone&&remoteDone($cb,$ok,${JSONObject.quote(text)})")

    @JavascriptInterface
    fun remoteAccount(): String = if (Remote.token(act).isEmpty()) "" else Remote.account(act)

    @JavascriptInterface
    fun remoteLogin(user: String, password: String, cb: Int) {
        thread {
            try {
                done(cb, true, Remote.login(act, user, password).toString())
            } catch (e: Exception) {
                done(cb, false, e.message ?: "Accesso non riuscito")
            }
        }
    }

    /** Verifica in due passaggi: il codice dopo la password (remember: ricorda il dispositivo). */
    @JavascriptInterface
    fun remoteLogin2fa(ticket: String, code: String, remember: Boolean, typed: String, cb: Int) {
        thread {
            try {
                done(cb, true, Remote.login2fa(act, ticket, code, remember, typed).toString())
            } catch (e: Exception) {
                done(cb, false, e.message ?: "Codice non accettato")
            }
        }
    }

    @JavascriptInterface
    fun remoteLogout() = Remote.logout(act)

    @JavascriptInterface
    fun remoteGoogleStart(cb: Int) {
        thread {
            try {
                done(cb, true, Remote.googleStart(act, tv))
            } catch (e: Exception) {
                done(cb, false, e.message ?: "Servizio account non raggiungibile")
            }
        }
    }

    @JavascriptInterface
    fun remoteGooglePoll(poll: String, cb: Int) {
        thread {
            try {
                done(cb, true, Remote.googlePoll(act, poll))
            } catch (e: Remote.CloudError) {
                done(cb, false, JSONObject().put("status", e.status).put("detail", e.message).toString())
            }
        }
    }

    /** Apre un indirizzo nel browser del dispositivo (Google non accetta l'accesso
     *  dentro le finestre delle app). */
    @JavascriptInterface
    fun openUrl(url: String) = act.runOnUiThread {
        if (!url.startsWith("https://")) return@runOnUiThread
        try {
            act.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Exception) {
            js("window.toastFromApp&&toastFromApp('Nessun browser per aprire Google: usa il QR')")
        }
    }

    /** Una chiamata al servizio account con il gettone dell'account. */
    @JavascriptInterface
    fun remoteCloud(method: String, path: String, body: String, cb: Int) {
        thread {
            try {
                done(cb, true, Remote.call(act, method, path, body.ifEmpty { null }))
            } catch (e: Remote.CloudError) {
                done(cb, false, JSONObject().put("status", e.status).put("detail", e.message).toString())
            }
        }
    }

    /** Entra nella rete di BunkerPlex: risponde con la base del proxy locale. */
    @JavascriptInterface
    fun remoteNet(replace: String, cb: Int) {
        // Al limite dei dispositivi dell'account risponde {"limit": ...}: la pagina
        // chiede quale togliere e richiama con replace = quello scelto
        val label = (if (tv) "TV " else "Telefono ") + (Build.MODEL ?: "Android")
        thread {
            try {
                done(cb, true, Remote.startNet(act, replace, label))
            } catch (e: Remote.DeviceLimit) {
                val lim = try { JSONObject(e.devices) } catch (_: Exception) { JSONObject() }
                done(cb, false, JSONObject().put("limit", lim).put("detail", e.message).toString())
            } catch (e: Throwable) {
                done(cb, false, JSONObject().put("detail", e.message ?: "Tailscale non parte").toString())
            }
        }
    }

    @JavascriptInterface
    fun remoteToken(hostport: String, token: String) = Remote.setToken(hostport, token)

    /** Questo server risponde da qui, sulla rete in cui si trova il dispositivo? Risponde con
     *  il suo /api/info (dice anche chi e': sid). Senza gettoni: puo' essere il server di un amico. */
    @JavascriptInterface
    fun remoteProbe(url: String, cb: Int) {
        val base = url.trim().trimEnd('/')
        if (!base.startsWith("http://") && !base.startsWith("https://")) {
            done(cb, false, "")
            return
        }
        thread {
            val info = try {
                JSONObject(Net.get("$base/api/info", 2500, auth = false)).takeIf { it.optString("app") == "bunkerplex" }
            } catch (_: Exception) {
                null
            }
            done(cb, info != null, info?.toString() ?: "")
        }
    }

    /** Apre per intero un server raggiunto sulla rete di questo dispositivo. */
    @JavascriptInterface
    fun remoteOpen(url: String) {
        val base = url.trim().trimEnd('/')
        if (base.startsWith("http://") || base.startsWith("https://")) act.runOnUiThread { openLocal(base) }
    }

    /** Avvia un video di un PC raggiunto da fuori: base = proxy verso quel PC. */
    @JavascriptInterface
    fun remotePlay(base: String, json: String) {
        act.runOnUiThread {
            playerStarting()
            act.startActivity(
                Intent(act, PlayerActivity::class.java)
                    .putExtra("server", base).putExtra("remote", true).putExtra("data", json)
            )
        }
    }
}
