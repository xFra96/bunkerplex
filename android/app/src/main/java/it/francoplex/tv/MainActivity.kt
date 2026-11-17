package it.francoplex.tv

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
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

    private lateinit var web: WebView
    private val prefs by lazy { getSharedPreferences("francoplex", MODE_PRIVATE) }
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
        web.addJavascriptInterface(Bridge(), "FrancoPlexTV")

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
        if (server == null) showSetup(false) else openServer()
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
    private val updateFile by lazy { File(cacheDir, "FrenkPlex-update.apk") }

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
        web.destroy()
        super.onDestroy()
    }

    /** Funzioni che la pagina puo' chiamare: window.FrancoPlexTV.xxx() */
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
                    Net.download("$base/FrenkPlex.apk", updateFile) { pct -> js("window.fpUpdate&&fpUpdate('progress',$pct)") }
                    val found = packageManager.getPackageArchiveInfo(updateFile.path, 0)
                    if (found?.packageName != packageName) throw IOException("il file scaricato non è l'app BunkerPlex")
                    runOnUiThread {
                        try {
                            startActivity(installIntent())
                            js("window.fpUpdate&&fpUpdate('install',0)")
                        } catch (e: Exception) {
                            updateFailed(e)
                        }
                    }
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
