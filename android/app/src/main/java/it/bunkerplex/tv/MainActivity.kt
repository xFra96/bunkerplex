package it.bunkerplex.tv

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.app.UiModeManager
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.content.IntentCompat
import androidx.core.content.pm.PackageInfoCompat
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Mostra l'interfaccia di BunkerPlex (servita dal PC) e passa i video al
 * player nativo. Al primo avvio cerca da solo il server sulla rete di casa.
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val ACTION_INSTALL_RESULT = "it.bunkerplex.tv.INSTALL_RESULT"
    }

    private lateinit var web: WebView
    private val prefs by lazy { getSharedPreferences("bunkerplex", MODE_PRIVATE) }
    private var clearHistoryOnLoad = false
    private var cameFromPlayer = false
    private var onSetup = false

    private var server: String?
        get() = prefs.getString("server", null)
        set(value) {
            prefs.edit().putString("server", value).apply()
        }

    /** Gli altri indirizzi dello stesso PC (es. Tailscale), da provare fuori casa: li dice il server. */
    private var others: List<String>
        get() = (prefs.getString("server_others", "") ?: "").split(' ').filter { it.isNotBlank() }
        set(value) {
            prefs.edit().putString("server_others", value.distinct().joinToString(" ")).apply()
        }

    /** L'indirizzo che si sta usando adesso: quello di casa o, fuori casa, uno degli altri. */
    @Volatile
    private var active: String? = null
    private var lastOpen = 0L

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        web.setBackgroundColor(Color.parseColor("#060A07"))
        web.isFocusable = true
        web.isFocusableInTouchMode = true
        setContentView(web)

        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.mediaPlaybackRequiresUserGesture = false
        web.addJavascriptInterface(Bridge(), "BunkerPlexTV")

        Posters.init(this)
        web.webViewClient = object : WebViewClient() {
            // Locandine e sfondi dalla copia salvata sulla TV (vedi Posters)
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                if (request.method == "GET") Posters.serve(request.url) else null

            override fun onPageFinished(view: WebView, url: String) {
                if (clearHistoryOnLoad) {
                    clearHistoryOnLoad = false
                    view.clearHistory()
                }
                view.requestFocus()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame && !onSetup) lost()
            }

            @Deprecated("Usato solo dalle versioni vecchie di Android")
            override fun onReceivedError(view: WebView, errorCode: Int, description: String?, failingUrl: String?) {
                if (!onSetup) lost()
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // Prima chiede alla pagina (es. per chiudere una finestra di scelta)
                web.evaluateJavascript("(window.fpBack&&window.fpBack())?1:0") { handled ->
                    if (handled != "1") {
                        if (web.canGoBack()) web.goBack() else finish()
                    }
                }
            }
        })

        updateFile.delete()   // l'APK di un aggiornamento gia' fatto (o lasciato a meta')
        ContextCompat.registerReceiver(this, installResult, IntentFilter(ACTION_INSTALL_RESULT),
            ContextCompat.RECEIVER_NOT_EXPORTED)
        if (server == null) showSetup(false) else openServer()
    }

    private val isTelevision by lazy {
        (getSystemService(UI_MODE_SERVICE) as? UiModeManager)?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION ||
            packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK)
    }

    /** Apre BunkerPlex dal primo indirizzo che risponde: prima quello di casa, poi
     *  (fuori casa) gli altri del PC, per esempio quello di Tailscale. */
    private fun openServer() {
        val home = server ?: return showSetup(false)
        onSetup = false
        lastOpen = System.currentTimeMillis()
        thread {
            val found = (listOf(home) + others).distinct().firstOrNull { url ->
                val info = Net.info(url, if (url == home) 3000 else 6000) ?: return@firstOrNull false
                Remote.setCloud(this, info.optString("cloud"))
                val list = info.optJSONArray("addresses")
                if (list != null) others = (0 until list.length()).map { Net.normalize(list.getString(it)) }
                true
            }
            runOnUiThread {
                if (found == null) {
                    showRemote("ask")       // niente server in casa: si propongono amici e tuoi PC
                } else {
                    active = found
                    onSetup = false
                    clearHistoryOnLoad = true
                    web.loadUrl("$found/#/home")
                }
            }
        }
    }

    /** La pagina non si carica (es. si e' usciti di casa con l'app aperta): si riprova
     *  con tutti gli indirizzi, ma una volta sola, poi la schermata di configurazione. */
    private fun lost() {
        if (System.currentTimeMillis() - lastOpen > 15000) openServer() else showRemote("ask")
    }

    /** La pagina dell'app senza server di casa: amici e tuoi PC, raggiunti con Tailscale. */
    private fun showRemote(hash: String) {
        onSetup = true
        clearHistoryOnLoad = true
        web.loadUrl("file:///android_asset/remote.html#$hash")
    }

    private fun showSetup(unreachable: Boolean) {
        onSetup = true
        clearHistoryOnLoad = true
        web.loadUrl("file:///android_asset/setup.html" + if (unreachable) "#offline" else "")
    }

    private fun js(code: String) = runOnUiThread { web.evaluateJavascript(code, null) }

    // ---- Aggiornamento dell'app: l'APK nuovo arriva dal server sul PC

    private val updating = AtomicBoolean(false)
    private val updateFile by lazy { File(cacheDir, "BunkerPlex-update.apk") }

    /** Dopo il download, se la TV non permette ancora a BunkerPlex di installare
     *  app si apre la sua schermata del permesso: al ritorno l'installazione riparte da sola. */
    private var waitingPermission = false

    private fun canInstall() = Build.VERSION.SDK_INT < 26 || packageManager.canRequestPackageInstalls()

    private fun install() {
        if (!canInstall()) {
            try {
                startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName")))
                waitingPermission = true
                js("window.fpUpdate&&fpUpdate('permission',0)")
                return
            } catch (e: ActivityNotFoundException) {
                // TV senza quella schermata: ci pensa l'installatore, che chiede lui il permesso
                openInstaller()
                return
            }
        }
        thread {
            try {
                installWithSession()
            } catch (e: Exception) {
                // Installatore "a sessioni" non disponibile o rotto su questa TV: quello classico
                runOnUiThread { openInstaller() }
            }
        }
    }

    /** Installazione con il PackageInstaller di Android: la TV mostra la sua conferma
     *  e il risultato torna in installResult, cosi' la pagina sa com'e' andata. */
    private fun installWithSession() {
        val installer = packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(packageName)
        if (Build.VERSION.SDK_INT >= 31) {
            params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val id = installer.createSession(params)
        try {
            installer.openSession(id).use { session ->
                session.openWrite("BunkerPlex.apk", 0, updateFile.length()).use { out ->
                    updateFile.inputStream().use { it.copyTo(out) }
                    session.fsync(out)
                }
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                    (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
                val result = PendingIntent.getBroadcast(this, id,
                    Intent(ACTION_INSTALL_RESULT).setPackage(packageName), flags)
                session.commit(result.intentSender)
            }
        } catch (e: Exception) {
            try { installer.abandonSession(id) } catch (_: Exception) {}
            throw e
        }
    }

    private val installResult = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
                PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                    val confirm = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent::class.java)
                    if (confirm == null) { openInstaller(); return }
                    try {
                        startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                        js("window.fpUpdate&&fpUpdate('install',0)")
                    } catch (e: Exception) {
                        openInstaller()
                    }
                }
                PackageInstaller.STATUS_SUCCESS -> updateFile.delete()   // di solito l'app viene chiusa prima
                PackageInstaller.STATUS_FAILURE_ABORTED -> {
                    updateFile.delete()
                    js("window.fpUpdate&&fpUpdate('cancel',0)")
                }
                else -> updateFailed(IOException(
                    intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "installazione non riuscita"))
            }
        }
    }

    /** Installatore classico (le TV dove quello a sessioni non va): apre l'APK. */
    private fun openInstaller() {
        try {
            startActivity(installIntent())
            js("window.fpUpdate&&fpUpdate('install',0)")
        } catch (e: Exception) {
            updateFailed(e)
        }
    }

    private fun installIntent(): Intent {
        val uri = if (Build.VERSION.SDK_INT >= 24) {
            FileProvider.getUriForFile(this, "$packageName.files", updateFile)
        } else {
            // Le versioni vecchie di Android vogliono il file vero, leggibile dall'installatore
            updateFile.setReadable(true, false)
            Uri.fromFile(updateFile)
        }
        return Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    private fun updateFailed(e: Exception) {
        updateFile.delete()
        js("window.fpUpdate&&fpUpdate('error',${JSONObject.quote(e.message ?: e.javaClass.simpleName)})")
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        if (waitingPermission) {
            waitingPermission = false
            if (canInstall() && updateFile.isFile) install()
            else js("window.fpUpdate&&fpUpdate('denied',0)")
        }
        if (cameFromPlayer) {
            cameFromPlayer = false
            web.evaluateJavascript("window.fpRefresh&&window.fpRefresh()", null)
        }
    }

    override fun onPause() {
        web.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        try { unregisterReceiver(installResult) } catch (_: Exception) {}
        Remote.stopNet()     // il telefono esce dalla rete di BunkerPlex (e, temporaneo, sparisce)
        web.destroy()
        super.onDestroy()
    }

    /** Funzioni che la pagina puo' chiamare: window.BunkerPlexTV.xxx() */
    inner class Bridge {

        @JavascriptInterface
        fun play(json: String) {
            val base = active ?: server ?: return
            runOnUiThread {
                cameFromPlayer = true
                startActivity(
                    Intent(this@MainActivity, PlayerActivity::class.java)
                        .putExtra("server", base)
                        .putExtra("data", json)
                )
            }
        }

        /** Numero di versione di questa app: la pagina lo confronta con quello dell'APK sul PC. */
        @JavascriptInterface
        fun getVersion(): Int = PackageInfoCompat.getLongVersionCode(
            packageManager.getPackageInfo(packageName, 0)
        ).toInt()

        /** La pagina sa che l'installazione la segue l'app (permesso, conferma, esito). */
        @JavascriptInterface
        fun installsBySession(): Boolean = true

        @JavascriptInterface
        fun getVersionName(): String = packageManager.getPackageInfo(packageName, 0).versionName ?: ""

        /** Scarica l'APK dal server e apre la finestra di installazione della TV.
         *  La pagina segue l'andamento con window.fpUpdate(stato, valore). */
        @JavascriptInterface
        fun update() {
            val base = active ?: server ?: return
            if (!updating.compareAndSet(false, true)) return
            thread {
                try {
                    updateFile.delete()
                    Net.download("$base/BunkerPlex.apk", updateFile) { pct -> js("window.fpUpdate&&fpUpdate('progress',$pct)") }
                    val found = packageManager.getPackageArchiveInfo(updateFile.path, 0)
                    if (found?.packageName != packageName) throw IOException("il file scaricato non è l'app BunkerPlex")
                    runOnUiThread { install() }
                } catch (e: Exception) {
                    updateFailed(e)
                } finally {
                    updating.set(false)
                }
            }
        }

        /** Chiude l'app: la pagina lo chiede dopo la conferma di uscita dalla Home. */
        @JavascriptInterface
        fun exit() = runOnUiThread { finish() }

        /** true su Android TV / Google TV: sul telefono la pagina mostra tutte le funzioni del PC. */
        @JavascriptInterface
        fun isTv(): Boolean = isTelevision

        @JavascriptInterface
        fun getServer(): String = active ?: server ?: ""

        @JavascriptInterface
        fun resetServer() = runOnUiThread { showSetup(false) }

        @JavascriptInterface
        fun saveServer(input: String) {
            val url = Net.normalize(input)
            thread {
                if (Net.isBunkerPlex(url)) {
                    server = url
                    others = emptyList()
                    runOnUiThread { openServer() }
                } else {
                    js("setupError(${JSONObject.quote(url)})")
                }
            }
        }

        // ---- Fuori casa (remote.html): account, Tailscale dentro l'app, player

        /** Risposta a una richiesta lenta della pagina: remoteDone(n, ok, testo). */
        private fun done(cb: Int, ok: Boolean, text: String) =
            js("window.remoteDone&&remoteDone($cb,$ok,${JSONObject.quote(text)})")

        @JavascriptInterface
        fun remoteAccount(): String = if (Remote.token(this@MainActivity).isEmpty()) "" else Remote.account(this@MainActivity)

        @JavascriptInterface
        fun remoteLogin(user: String, password: String, cb: Int) {
            thread {
                try {
                    done(cb, true, Remote.login(this@MainActivity, user, password).toString())
                } catch (e: Exception) {
                    done(cb, false, e.message ?: "Accesso non riuscito")
                }
            }
        }

        @JavascriptInterface
        fun remoteLogout() = Remote.logout(this@MainActivity)

        @JavascriptInterface
        fun remoteGoogleStart(cb: Int) {
            thread {
                try {
                    done(cb, true, Remote.googleStart(this@MainActivity, isTelevision))
                } catch (e: Exception) {
                    done(cb, false, e.message ?: "Servizio account non raggiungibile")
                }
            }
        }

        @JavascriptInterface
        fun remoteGooglePoll(poll: String, cb: Int) {
            thread {
                try {
                    done(cb, true, Remote.googlePoll(this@MainActivity, poll))
                } catch (e: Remote.CloudError) {
                    done(cb, false, JSONObject().put("status", e.status).put("detail", e.message).toString())
                }
            }
        }

        /** Apre un indirizzo nel browser del dispositivo (Google non accetta l'accesso
         *  dentro le finestre delle app). */
        @JavascriptInterface
        fun openUrl(url: String) = runOnUiThread {
            if (!url.startsWith("https://")) return@runOnUiThread
            try {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (_: Exception) {
                js("window.toastFromApp&&toastFromApp('Nessun browser per aprire Google: usa il QR')")
            }
        }

        /** Una chiamata al servizio account con il gettone dell'account. */
        @JavascriptInterface
        fun remoteCloud(method: String, path: String, body: String, cb: Int) {
            thread {
                try {
                    done(cb, true, Remote.call(this@MainActivity, method, path, body.ifEmpty { null }))
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
            val label = (if (isTelevision) "TV " else "Telefono ") + (Build.MODEL ?: "Android")
            thread {
                try {
                    done(cb, true, Remote.startNet(this@MainActivity, replace, label))
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

        /** Avvia un video di un PC raggiunto da fuori: base = proxy verso quel PC. */
        @JavascriptInterface
        fun remotePlay(base: String, json: String) {
            runOnUiThread {
                cameFromPlayer = true
                startActivity(
                    Intent(this@MainActivity, PlayerActivity::class.java)
                        .putExtra("server", base).putExtra("remote", true).putExtra("data", json)
                )
            }
        }

        /** Dalla pagina degli amici: riprova il server di casa, o la sua configurazione. */
        @JavascriptInterface
        fun retryHome() = runOnUiThread { if (server == null) showSetup(false) else openServer() }

        @JavascriptInterface
        fun openSetup() = runOnUiThread {
            onSetup = true
            web.loadUrl("file:///android_asset/setup.html#manual")
        }

        @JavascriptInterface
        fun openRemote() = runOnUiThread { showRemote("friends") }

        @JavascriptInterface
        fun discover() {
            thread {
                val url = Net.discover()
                if (url != null) {
                    server = url
                    others = emptyList()
                    js("setupFound(${JSONObject.quote(url)})")
                    Thread.sleep(900)
                    runOnUiThread { if (onSetup) openServer() }
                } else {
                    js("setupNotFound()")
                }
            }
        }
    }
}
