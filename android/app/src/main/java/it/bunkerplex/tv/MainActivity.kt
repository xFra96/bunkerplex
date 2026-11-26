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
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
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
 * Mostra l'interfaccia di BunkerPlex e passa i video al player nativo.
 * Sul telefono e sul tablet e' sempre BunkerPlex con l'account (la PWA centrale del
 * servizio account): accesso, server, amici, impostazioni dell'app, a casa e fuori.
 * Il collegamento diretto al server serve solo senza Internet (ricerca sulla rete di
 * casa, setup.html). Sulle TV con questa app resta il server scelto a mano e, fuori
 * casa, remote.html (amici e tuoi PC con Tailscale).
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val ACTION_INSTALL_RESULT = "it.bunkerplex.tv.INSTALL_RESULT"
        /** Linea delle release di questa app su GitHub (app-v1.0, app-v1.1...) */
        private const val RELEASES = "app-v"
        /** Le impostazioni dell'app quando il servizio account non risponde */
        private const val APP_SETTINGS = "file:///android_asset/appsettings.html"
        /** Richiesta del permesso delle notifiche (Android 13+) */
        private const val NOTICE_PERMISSION = 42
    }

    private lateinit var web: WebView
    private val prefs by lazy { getSharedPreferences("bunkerplex", MODE_PRIVATE) }

    /** La scelta di un file chiesta dalla pagina (<input type=file>, es. l'immagine di un
     *  server): senza WebChromeClient.onShowFileChooser il WebView non apre niente. */
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val fileChooser = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data))
        fileCallback = null
    }
    private var clearHistoryOnLoad = false
    private var cameFromPlayer = false
    private var onSetup = false
    private var onTvInstall = false

    /** Sulle impostazioni dell'app aperte da setup.html (senza Internet): Indietro torna li' (settingsReturn). */
    @Volatile
    private var onAppSettings = false
    private var settingsReturn = ""

    private var server: String?
        get() = prefs.getString("server", null)
        set(value) {
            prefs.edit().putString("server", value).apply()
        }

    /** L'ultimo server raggiunto nella rete di casa (anche con l'account): senza Internet
     *  si prova per primo e si scrive gia' nel campo dell'indirizzo (setup.html). */
    private var lastServer: String?
        get() = prefs.getString("last_server", null)?.ifEmpty { null }
        set(value) {
            val v = value?.let { lanForm(it) } ?: ""
            if (v.isNotEmpty()) prefs.edit().putString("last_server", v).apply()
        }

    /** Come si scrive nella rete di casa: http://IP:32500 (anche dal nome https
     *  <ip-con-trattini>.<sid>.<dominio>); "" per questo stesso dispositivo. */
    private fun lanForm(url: String): String {
        val host = android.net.Uri.parse(url).host ?: return ""
        Regex("^(\\d{1,3})-(\\d{1,3})-(\\d{1,3})-(\\d{1,3})\\.").find(host)?.let { m ->
            return "http://" + m.groupValues.drop(1).joinToString(".") + ":32500"
        }
        return if (host == "localhost" || host == "127.0.0.1") "" else url
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
        // BunkerPlex con l'account (pagina https del servizio) parla col server di casa in http
        web.settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        web.addJavascriptInterface(Bridge(), "BunkerPlexTV")

        Posters.init(this)
        web.webViewClient = object : WebViewClient() {
            // Locandine e sfondi dalla copia salvata sulla TV (vedi Posters)
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                if (request.method == "GET") Posters.serve(request.url) else null

            override fun onPageFinished(view: WebView, url: String) {
                if (onTvInstall && !url.startsWith("file:///android_asset/tvinstall.html")) {
                    onTvInstall = false
                    onSetup = false
                    TvInstaller.listener = null
                }
                // Uscito dalle impostazioni dell'app (per esempio verso la ricerca del server)
                if (onAppSettings && !url.startsWith(Remote.cloud(this@MainActivity)) && !url.startsWith(APP_SETTINGS)) {
                    onAppSettings = false
                }
                if (clearHistoryOnLoad) {
                    clearHistoryOnLoad = false
                    view.clearHistory()
                }
                view.requestFocus()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (!request.isForMainFrame) return
                if (onAppSettings) appSettingsOffline() else if (!onSetup) lost()
            }

            @Deprecated("Usato solo dalle versioni vecchie di Android")
            override fun onReceivedError(view: WebView, errorCode: Int, description: String?, failingUrl: String?) {
                if (onAppSettings) appSettingsOffline() else if (!onSetup) lost()
            }

            // Il servizio account risponde ma con un errore suo (es. 502): come se non rispondesse
            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                if (onAppSettings && request.isForMainFrame && response.statusCode >= 500) appSettingsOffline()
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>,
                                           params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(emptyArray())   // una scelta rimasta a meta'
                fileCallback = callback
                return try {
                    fileChooser.launch(params.createIntent())
                    true
                } catch (_: ActivityNotFoundException) {
                    fileCallback = null
                    Toast.makeText(this@MainActivity, "Nessuna app per scegliere un file", Toast.LENGTH_SHORT).show()
                    false
                }
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // Prima chiede alla pagina (es. per chiudere una finestra di scelta)
                web.evaluateJavascript("(window.fpBack&&window.fpBack())?1:0") { handled ->
                    if (handled != "1") {
                        if (onAppSettings) leaveAppSettings() else if (web.canGoBack()) web.goBack() else finish()
                    }
                }
            }
        })

        updateFile.delete()   // l'APK di un aggiornamento gia' fatto (o lasciato a meta')
        ContextCompat.registerReceiver(this, installResult, IntentFilter(ACTION_INSTALL_RESULT),
            ContextCompat.RECEIVER_NOT_EXPORTED)
        // Il server scritto a mano (app di prima) resta come primo da provare senza Internet
        if (!isTelevision && lastServer == null) server?.let { lastServer = it }
        showHome()
        // Gettone FCM arrivato al servizio account: la pagina mostra subito «istantanee»
        Notices.changed = { js("window.fpNoticePerm&&fpNoticePerm()") }
        Notices.ensure(this)
        // L'app si aggiorna da sola dalle sue release su GitHub (app-v*), senza il server:
        // a ogni apertura si chiede subito, e la pagina propone la versione nuova (checkUpdate)
        thread { try { Releases.check(this, RELEASES, "BunkerPlex.apk", true) } catch (_: Exception) {} }
        // Con l'app chiusa: ogni 6 ore circa una notifica se e' uscita una versione nuova (AppUpdates)
        if (!isTelevision) {
            AppUpdates.schedule(this)
            // Da Android 13 senza permesso la notifica non si vede: lo si chiede una volta sola
            // (chi dice di no lo puo' dare dopo con «Attiva le notifiche» o dalle impostazioni di Android)
            if (Build.VERSION.SDK_INT >= 33 && !Notices.allowed(this) && !prefs.getBoolean("notify_asked", false)) {
                prefs.edit().putBoolean("notify_asked", true).apply()
                requestPermissions(arrayOf("android.permission.POST_NOTIFICATIONS"), NOTICE_PERMISSION)
            }
        }
    }

    /** Notifica «Aggiornamento disponibile» toccata con l'app gia' aperta: la pagina lo
     *  propone subito, anche dopo un «Più tardi» (all'avvio lo propone gia' da sola). */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.getBooleanExtra(AppUpdates.EXTRA, false)) js("window.fpOfferUpdate&&fpOfferUpdate()")
    }

    private val isTelevision by lazy {
        (getSystemService(UI_MODE_SERVICE) as? UiModeManager)?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION ||
            packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK)
    }

    /** La pagina di partenza: sul telefono sempre BunkerPlex con l'account; sulla TV il
     *  server scelto a mano, se c'e'. */
    private fun showHome() {
        if (isTelevision && server != null) openServer() else showCentral()
    }

    /** Apre BunkerPlex dal primo indirizzo che risponde: prima quello di casa, poi
     *  (fuori casa) gli altri del PC, per esempio quello di Tailscale. */
    private fun openServer() {
        val home = server ?: return showSetup(false)
        onSetup = false
        lastOpen = System.currentTimeMillis()
        thread {
            var api = 1
            val found = (listOf(home) + others).distinct().firstOrNull { url ->
                val info = Net.info(url, if (url == home) 3000 else 6000) ?: return@firstOrNull false
                api = Releases.serverApi(info)
                Remote.setCloud(this, info.optString("cloud"))
                val list = info.optJSONArray("addresses")
                if (list != null) others = (0 until list.length()).map { Net.normalize(list.getString(it)) }
                true
            }
            runOnUiThread {
                if (found == null && isTelevision) {
                    showRemote("ask")       // niente server in casa: si propongono amici e tuoi PC
                } else if (found == null) {
                    // Telefono senza Internet (solo da setup.html): l'indirizzo da scrivere
                    onSetup = true
                    web.loadUrl("file:///android_asset/setup.html#manual")
                    Toast.makeText(this, "Il server non risponde: controlla che il PC sia acceso", Toast.LENGTH_LONG).show()
                } else {
                    active = found
                    lastServer = found
                    onSetup = false
                    clearHistoryOnLoad = true
                    web.loadUrl("$found/#/home")
                    // App piu' nuova del server: qualcosa potrebbe non andare finche' non si aggiorna il server
                    if (api < Releases.MIN_SERVER_API) Toast.makeText(this,
                        "Il server sul PC è più vecchio di questa app: aggiornalo da Impostazioni → Aggiornamenti",
                        Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    /** La pagina non si carica. Sul telefono: dal server diretto (es. si e' usciti di casa
     *  con l'app aperta) si torna a BunkerPlex con l'account; se non si carica neanche
     *  quello (niente Internet) si cerca il server sulla rete di casa. Sulla TV si riprova
     *  con tutti gli indirizzi, ma una volta sola, poi amici e tuoi PC. */
    private fun lost() {
        if (!isTelevision) {
            if (active != null) showCentral() else showSetup(false)
            return
        }
        if (System.currentTimeMillis() - lastOpen > 15000) openServer() else showRemote("ask")
    }

    /** La pagina dell'app senza server di casa: amici e tuoi PC, raggiunti con Tailscale.
     *  Solo sulla TV: sul telefono la scelta del server e' sempre quella della PWA
     *  (si apre il server per intero, con Home, ripresa e il resto), mai la vista ridotta. */
    private fun showRemote(hash: String) {
        if (!isTelevision) return showCentral()
        onSetup = true
        clearHistoryOnLoad = true
        web.loadUrl("file:///android_asset/remote.html#$hash")
    }

    /** BunkerPlex con l'account: la pagina del servizio account (accesso, scelta del
     *  server, poi collegamento diretto). Se non si carica (niente Internet), lost()
     *  porta alla ricerca del server sulla rete di casa. */
    private fun showCentral() {
        onSetup = false
        active = null
        clearHistoryOnLoad = true
        lastOpen = System.currentTimeMillis()
        web.loadUrl(Remote.cloud(this) + "/")
    }

    /** Le impostazioni dell'app (versione, aggiornamento, notifiche) da setup.html:
     *  non dipendono da nessun server. Arrivano dal servizio account (#/app
     *  della PWA centrale, come dall'accesso); se neanche lui risponde resta la pagina
     *  dentro l'app con versione e aggiornamento. Indietro torna dove si era. */
    private fun showAppSettings() {
        if (!onAppSettings) settingsReturn = web.url ?: ""
        onAppSettings = true
        onSetup = true
        web.loadUrl(Remote.cloud(this) + "/#/app")
    }

    /** Il servizio account non si carica: la pagina dentro l'app (versione e aggiornamento).
     *  E' un file dell'app, non puo' fallire a sua volta. */
    private fun appSettingsOffline() = web.loadUrl(APP_SETTINGS)

    private fun leaveAppSettings() {
        onAppSettings = false
        val back = settingsReturn.takeIf { it.startsWith("file:///android_asset/") } ?: return showHome()
        onSetup = true
        clearHistoryOnLoad = true
        web.loadUrl(back)
    }

    private fun showSetup(unreachable: Boolean) {
        onSetup = true
        clearHistoryOnLoad = true
        web.loadUrl("file:///android_asset/setup.html" + if (unreachable) "#offline" else "")
    }

    /** Dal telefono: la pagina che installa l'app sulla TV (TvInstaller). Indietro torna dove si era. */
    private fun showTvInstall() {
        onSetup = true
        onTvInstall = true
        TvInstaller.listener = { json -> js("window.tvUpdate&&tvUpdate($json)") }
        web.loadUrl("file:///android_asset/tvinstall.html")
    }

    private fun js(code: String) = runOnUiThread { web.evaluateJavascript(code, null) }

    // ---- Aggiornamento dell'app: l'APK nuovo arriva dalla release app-v* su GitHub

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
        AppUpdates.foreground = true
        AppUpdates.cancel(this)      // aperta l'app, l'aggiornamento lo propone la pagina
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

    /** Permesso delle notifiche dato o negato: la pagina si ridisegna con lo stato nuovo. */
    @Deprecated("Basta per un solo permesso, senza le API dei risultati")
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == NOTICE_PERMISSION) js("window.fpNoticePerm&&fpNoticePerm()")
    }

    override fun onPause() {
        AppUpdates.foreground = false
        web.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        try { unregisterReceiver(installResult) } catch (_: Exception) {}
        Notices.changed = null
        Remote.stopNet()     // il telefono esce dalla rete di BunkerPlex (e, temporaneo, sparisce)
        web.destroy()
        super.onDestroy()
    }

    /** Funzioni che la pagina puo' chiamare: window.BunkerPlexTV.xxx() */
    inner class Bridge : RemoteBridge(this@MainActivity, web, isTelevision) {

        override fun playerStarting() {
            cameFromPlayer = true
        }

        /** Fuori casa (remote.html, sulla TV), un server che risponde sulla rete in cui si trova
         *  il dispositivo: si apre come quello di casa, ma il server di casa scelto resta quello. */
        override fun openLocal(url: String) {
            active = url
            lastServer = url
            onSetup = false
            clearHistoryOnLoad = true
            lastOpen = System.currentTimeMillis()
            web.loadUrl("$url/#/home")
        }

        @JavascriptInterface
        fun play(json: String) {
            // Con l'account la pagina dice lei il server (server_base); altrimenti quello aperto
            val chosen = try { org.json.JSONObject(json).optString("server_base") } catch (_: Exception) { "" }
            val base = chosen.ifEmpty { null } ?: active ?: server ?: return
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

        /** Ultima versione dell'app su GitHub, come JSON {name, code, url, min_api}, o "" se non si sa ancora. */
        @JavascriptInterface
        fun latestApp(): String = Releases.cached(this@MainActivity, RELEASES)?.json() ?: ""

        /** Ricontrolla su GitHub (force = subito, altrimenti al massimo ogni 6 ore), poi
         *  chiama window.fpLatest(errore): "" se e' andata, se no il motivo. */
        @JavascriptInterface
        fun checkLatest(force: Boolean) {
            thread {
                val error = try {
                    Releases.check(this@MainActivity, RELEASES, "BunkerPlex.apk", force); ""
                } catch (e: Exception) {
                    "GitHub non raggiungibile"
                }
                js("window.fpLatest&&fpLatest(${JSONObject.quote(error)})")
            }
        }

        /** Livello minimo delle API del server che serve a questa app (il server lo dice in /api/info "api"). */
        @JavascriptInterface
        fun minServerApi(): Int = Releases.MIN_SERVER_API

        /** Scarica l'APK dalla release su GitHub e apre la finestra di installazione.
         *  La pagina segue l'andamento con window.fpUpdate(stato, valore). */
        @JavascriptInterface
        fun update() {
            if (!updating.compareAndSet(false, true)) return
            thread {
                try {
                    updateFile.delete()
                    val latest = Releases.cached(this@MainActivity, RELEASES)
                        ?: Releases.check(this@MainActivity, RELEASES, "BunkerPlex.apk", true)
                        ?: throw IOException("su GitHub non c'è ancora una versione dell'app")
                    Net.download(latest.url, updateFile, auth = false) { pct -> js("window.fpUpdate&&fpUpdate('progress',$pct)") }
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

        /** L'ultimo server raggiunto (per scriverlo gia' nel campo dell'indirizzo). */
        @JavascriptInterface
        fun lastServer(): String = lastServer ?: server ?: ""

        /** BunkerPlex con l'account: il server a cui la pagina si e' collegata. */
        @JavascriptInterface
        fun rememberServer(url: String) {
            if (url.startsWith("http://") || url.startsWith("https://")) lastServer = url
        }

        /** Notifiche su questo telefono/tablet: "push" (istantanee, Firebase), "on" (controllo
         *  ogni 15 minuti circa), "denied" (accese ma senza permesso), "off" o "tv". */
        @JavascriptInterface
        fun noticesState(): String = when {
            isTelevision -> "tv"
            Notices.url(this@MainActivity) == null -> "off"
            !Notices.allowed(this@MainActivity) -> "denied"
            Notices.push(this@MainActivity) -> "push"
            else -> "on"
        }

        /** true se questo APK ha Firebase (notifiche istantanee): senza, solo il controllo periodico. */
        @JavascriptInterface
        fun noticesPush(): Boolean = !isTelevision && Notices.firebase(this@MainActivity)

        /** Manda una notifica di prova; la pagina riceve l'esito in fpNoticeTest("" = partita, o l'errore). */
        @JavascriptInterface
        fun noticesTest() {
            thread {
                val err = try { Notices.test(this@MainActivity) } catch (e: Exception) { "Il servizio account non risponde" }
                js("window.fpNoticeTest&&fpNoticeTest(${JSONObject.quote(err)})")
            }
        }

        /** Accende le notifiche con l'indirizzo degli avvisi di questo dispositivo ("" = spegne). */
        @JavascriptInterface
        fun noticesSet(url: String) {
            if (url.isEmpty()) {
                Notices.disable(this@MainActivity)
                return
            }
            if (!url.startsWith("https://") || isTelevision) return
            Notices.enable(this@MainActivity, url)
            if (!Notices.allowed(this@MainActivity) && Build.VERSION.SDK_INT >= 33) {
                runOnUiThread { requestPermissions(arrayOf("android.permission.POST_NOTIFICATIONS"), NOTICE_PERMISSION) }
            }
        }

        /** Le impostazioni di Android per le notifiche dell'app (se il permesso e' stato negato). */
        @JavascriptInterface
        fun noticesSettings() = runOnUiThread {
            try {
                startActivity(
                    Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                        .putExtra("app_package", packageName).putExtra("app_uid", applicationInfo.uid)
                )
            } catch (e: ActivityNotFoundException) {
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
            }
        }

        // ---- Installa l'app sulla TV dal telefono (tvinstall.html, vedi TvInstaller)

        /** true sul telefono (Android 8+): la pagina mostra «Installa sulla TV». */
        @JavascriptInterface
        fun tvInstallSupported(): Boolean = !isTelevision && TvInstaller.supported()

        @JavascriptInterface
        fun openTvInstall() = runOnUiThread { if (!isTelevision) showTvInstall() }

        @JavascriptInterface
        fun tvState(): String = TvInstaller.state(this@MainActivity)

        @JavascriptInterface
        fun tvScan() = TvInstaller.scan(this@MainActivity)

        @JavascriptInterface
        fun tvInstall(addr: String, replace: Boolean) = TvInstaller.install(this@MainActivity, addr, replace)

        @JavascriptInterface
        fun tvCancel() = TvInstaller.cancel(this@MainActivity)

        @JavascriptInterface
        fun tvClose() = runOnUiThread { if (web.canGoBack()) web.goBack() else showHome() }

        @JavascriptInterface
        fun resetServer() = runOnUiThread { showSetup(false) }

        /** Dalla ricerca del server: BunkerPlex con l'account. */
        @JavascriptInterface
        fun openCentral() = runOnUiThread { server = null; showCentral() }

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

        /** Amici e tuoi PC con Tailscale (remote.html): solo sulle TV, sul telefono c'e' la PWA. */
        @JavascriptInterface
        fun remoteAllowed(): Boolean = isTelevision

        /** Da setup.html: le impostazioni dell'app, con qualunque server (o nessuno). */
        @JavascriptInterface
        fun openAppSettings() = runOnUiThread { showAppSettings() }

        /** «Indietro» delle impostazioni dell'app: true se erano state aperte da
         *  setup.html (e allora si torna li'), false se no (la pagina va avanti da sola). */
        @JavascriptInterface
        fun closeAppSettings(): Boolean {
            if (!onAppSettings) return false
            runOnUiThread { leaveAppSettings() }
            return true
        }

        @JavascriptInterface
        fun discover() {
            thread {
                // Prima l'ultimo server che ha risposto, poi la ricerca su tutta la rete di casa
                val url = lastServer?.takeIf { Net.isBunkerPlex(it, 2500) } ?: Net.discover()
                if (url != null) {
                    server = url
                    lastServer = url
                    others = emptyList()
                    js("setupFound(${JSONObject.quote(url)})")
                    Thread.sleep(900)
                    runOnUiThread { if (onSetup && !onAppSettings) openServer() }
                } else {
                    js("setupNotFound()")
                }
            }
        }
    }
}
