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

        web.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                if (clearHistoryOnLoad) {
                    clearHistoryOnLoad = false
                    view.clearHistory()
                }
                view.requestFocus()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame && !onSetup) showSetup(true)
            }

            @Deprecated("Usato solo dalle versioni vecchie di Android")
            override fun onReceivedError(view: WebView, errorCode: Int, description: String?, failingUrl: String?) {
                if (!onSetup) showSetup(true)
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (onSetup) {
                    finish()
                    return
                }
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

    private fun openServer() {
        onSetup = false
        clearHistoryOnLoad = true
        web.loadUrl("$server/#/home")
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
        web.destroy()
        super.onDestroy()
    }

    /** Funzioni che la pagina puo' chiamare: window.BunkerPlexTV.xxx() */
    inner class Bridge {

        @JavascriptInterface
        fun play(json: String) {
            val base = server ?: return
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
            val base = server ?: return
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
        fun getServer(): String = server ?: ""

        @JavascriptInterface
        fun resetServer() = runOnUiThread { showSetup(false) }

        @JavascriptInterface
        fun saveServer(input: String) {
            val url = Net.normalize(input)
            thread {
                if (Net.isBunkerPlex(url)) {
                    server = url
                    runOnUiThread { openServer() }
                } else {
                    js("setupError(${JSONObject.quote(url)})")
                }
            }
        }

        @JavascriptInterface
        fun discover() {
            thread {
                val url = Net.discover()
                if (url != null) {
                    server = url
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
