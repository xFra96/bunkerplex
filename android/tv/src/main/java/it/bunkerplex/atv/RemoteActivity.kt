package it.bunkerplex.atv

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import it.bunkerplex.tv.Remote
import it.bunkerplex.tv.RemoteBridge

/**
 * Senza un server di casa (fuori casa, da un amico): la stessa pagina dell'app
 * attuale (remote.html), con account, Tailscale dentro l'app, amici e tuoi PC.
 * I video partono nel player nativo.
 */
class RemoteActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private var cameFromPlayer = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
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
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("(window.fpBack&&window.fpBack())?1:0") { handled ->
                    if (handled != "1") {
                        if (web.canGoBack()) web.goBack() else finish()
                    }
                }
            }
        })
        web.loadUrl("file:///android_asset/remote.html#" + (intent.getStringExtra("hash") ?: "ask"))
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
        if (isFinishing) Remote.stopNet()     // la TV esce dalla rete di BunkerPlex
        web.destroy()
        super.onDestroy()
    }

    /** Torna all'interfaccia nativa, a casa o alla scelta del server. */
    private fun back(go: String) = runOnUiThread {
        startActivity(Intent(this, MainActivity::class.java).putExtra("go", go)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        finish()
    }

    inner class Bridge : RemoteBridge(this@RemoteActivity, web, true) {
        override fun playerStarting() {
            cameFromPlayer = true
        }

        /** Un server su questa rete: lo apre la scelta del server dell'app TV, che lo trova in casa. */
        override fun openLocal(url: String) = back("home")

        @JavascriptInterface
        fun isTv(): Boolean = true

        @JavascriptInterface
        fun retryHome() = back("home")

        @JavascriptInterface
        fun openSetup() = back("setup")

        @JavascriptInterface
        fun openRemote() = runOnUiThread { web.loadUrl("file:///android_asset/remote.html#friends") }

        @JavascriptInterface
        fun exit() = runOnUiThread { finishAffinity() }

        @JavascriptInterface
        fun getVersionName(): String = packageManager.getPackageInfo(packageName, 0).versionName ?: ""
    }
}
