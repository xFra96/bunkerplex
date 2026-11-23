package it.bunkerplex.atv

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import it.bunkerplex.tv.Net
import it.bunkerplex.tv.PlayerActivity

/**
 * Le parti non ancora native (ricerca, raccolte, impostazioni, account...): la
 * pagina web del server, con lo stesso ingresso dell'app. Indietro dalla prima
 * pagina torna all'interfaccia nativa.
 */
class WebActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private var cameFromPlayer = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Api.load(this)
        web = WebView(this)
        web.setBackgroundColor(Color.parseColor("#060A07"))
        setContentView(web)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.mediaPlaybackRequiresUserGesture = false
        web.addJavascriptInterface(Bridge(), "BunkerPlexTV")
        web.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                view.requestFocus()
            }
        }
        // La pagina entra con lo stesso gettone dell'app
        val cookies = CookieManager.getInstance()
        if (Net.session.isNotEmpty()) cookies.setCookie(Api.base, "bp_session=${Net.session}; path=/")
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("(window.fpBack&&window.fpBack())?1:0") { handled ->
                    if (handled != "1") {
                        if (web.canGoBack()) web.goBack() else finish()
                    }
                }
            }
        })
        web.loadUrl(Api.base + "/" + (intent.getStringExtra("hash") ?: "#/home"))
    }

    /** Se nella pagina si e' entrati con un altro account, l'app usa quello. */
    private fun keepSession() {
        val c = CookieManager.getInstance().getCookie(Api.base) ?: return
        val token = c.split(';').map { it.trim() }.firstOrNull { it.startsWith("bp_session=") }?.substringAfter('=')
        if (!token.isNullOrEmpty() && token != Net.session) Api.saveSession(this, token)
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
        keepSession()
        web.onPause()
        CookieManager.getInstance().flush()
        super.onPause()
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    inner class Bridge {
        @JavascriptInterface
        fun play(json: String) = runOnUiThread {
            cameFromPlayer = true
            startActivity(Intent(this@WebActivity, PlayerActivity::class.java)
                .putExtra("server", Api.base).putExtra("data", json))
        }

        /** Gli aggiornamenti di questa app non passano dalla pagina (che conosce solo l'app web). */
        @JavascriptInterface
        fun getVersion(): Int = Int.MAX_VALUE

        @JavascriptInterface
        fun getVersionName(): String = packageManager.getPackageInfo(packageName, 0).versionName ?: ""

        @JavascriptInterface
        fun isTv(): Boolean = true

        @JavascriptInterface
        fun getServer(): String = Api.base

        @JavascriptInterface
        fun exit() = runOnUiThread { finish() }

        @JavascriptInterface
        fun resetServer() = runOnUiThread {
            Api.saveServer(this@WebActivity, "")
            startActivity(Intent(this@WebActivity, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK))
            finish()
        }
    }
}
