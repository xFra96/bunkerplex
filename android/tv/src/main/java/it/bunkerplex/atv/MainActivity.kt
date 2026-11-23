package it.bunkerplex.atv

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.Coil
import coil.ImageLoader
import coil.disk.DiskCache
import coil.memory.MemoryCache
import it.bunkerplex.tv.Net
import it.bunkerplex.tv.PlayerActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import org.json.JSONObject

/** Le schermate dell'app: una pila, il tasto Indietro torna alla precedente. */
sealed class Screen {
    data object Connect : Screen()
    data object Who : Screen()
    data class Password(val id: Int, val name: String) : Screen()
    data object Home : Screen()
    data class Detail(val kind: String, val id: Int) : Screen()
}

/**
 * BunkerPlex con interfaccia nativa per la TV: Home, schede e player senza
 * pagine web, per andare veloce anche sulle chiavette economiche. Le parti non
 * ancora native si aprono nell'interfaccia web del server (WebActivity).
 */
class MainActivity : ComponentActivity() {

    private val stack = mutableStateListOf<Screen>()
    /** Cresce al ritorno dal player o dalla vista web: le schermate ricaricano i dati. */
    private var refresh by mutableIntStateOf(0)
    private var leftApp = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Api.load(this)
        setupImages()
        stack.add(if (Api.base.isEmpty()) Screen.Connect else Screen.Who)
        setContent {
            Box(Modifier.fillMaxSize().background(C.bg)) {
                val top = stack.last()
                BackHandler(stack.size > 1) { stack.removeAt(stack.lastIndex) }
                when (top) {
                    Screen.Connect -> ConnectScreen()
                    Screen.Who -> key(refresh) { WhoScreen() }
                    is Screen.Password -> PasswordScreen(top)
                    Screen.Home -> HomeScreen(this@MainActivity, refresh)
                    is Screen.Detail -> DetailScreen(this@MainActivity, top, refresh)
                }
            }
        }
    }

    /** Immagini: cache in memoria contenuta (le chiavette hanno poca RAM) e su disco. */
    private fun setupImages() {
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            val r = chain.request()
            val s = Net.session
            chain.proceed(if (s.isEmpty()) r else r.newBuilder().header("X-BP-Session", s).build())
        }.build()
        Coil.setImageLoader(
            ImageLoader.Builder(this)
                .okHttpClient(http)
                .memoryCache { MemoryCache.Builder(this).maxSizePercent(0.15).build() }
                .diskCache { DiskCache.Builder().directory(cacheDir.resolve("img")).maxSizeBytes(150L shl 20).build() }
                .allowRgb565(true)          // meta' memoria per le locandine
                .crossfade(false)
                .build()
        )
    }

    override fun onResume() {
        super.onResume()
        if (leftApp) {
            leftApp = false
            refresh++
        }
    }

    fun go(s: Screen) {
        stack.add(s)
    }

    fun reset(s: Screen) {
        stack.clear()
        stack.add(s)
    }

    /** Avvia il player nativo con i dati di /api/play. */
    fun play(id: Int, fromStart: Boolean, onError: (String) -> Unit) {
        Thread {
            try {
                val p = Api.obj("/api/play/$id")
                if (fromStart) p.put("start", 0)
                runOnUiThread {
                    leftApp = true
                    startActivity(
                        Intent(this, PlayerActivity::class.java)
                            .putExtra("server", Api.base).putExtra("data", p.toString())
                    )
                }
            } catch (e: Exception) {
                val missing = (e as? ApiError)?.body?.optJSONObject("missing")
                runOnUiThread { onError(missing?.optString("message")?.ifEmpty { null } ?: e.message ?: "Non parte") }
            }
        }.start()
    }

    /** Una parte non ancora nativa: l'interfaccia web del server, a quella pagina. */
    fun web(hash: String) {
        leftApp = true
        startActivity(Intent(this, WebActivity::class.java).putExtra("hash", hash))
    }

    fun session401() = reset(Screen.Who)

    // ---------------------------------------------------------------- Collegamento

    @Composable
    private fun ConnectScreen() {
        var status by remember { mutableStateOf("Cerco BunkerPlex sulla rete di casa…") }
        var searching by remember { mutableStateOf(true) }
        var manual by remember { mutableStateOf(false) }
        var address by remember { mutableStateOf(Api.base.substringAfter("://").substringBefore(":")) }
        var attempt by remember { mutableIntStateOf(0) }

        LaunchedEffect(attempt) {
            if (manual) return@LaunchedEffect
            searching = true
            status = "Cerco BunkerPlex sulla rete di casa…"
            val found = withContext(Dispatchers.IO) { Net.discover() }
            searching = false
            if (found != null) {
                Api.saveServer(this@MainActivity, found)
                reset(Screen.Who)
            } else {
                status = "Non ho trovato BunkerPlex. Il computer è acceso e sulla stessa rete?"
            }
        }

        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.width(560.dp)) {
                Txt("BunkerPlex", size = 34.sp, bold = true, color = C.accentLight)
                Txt(status, Modifier.padding(top = 16.dp, bottom = 24.dp), color = C.dim, lines = 3)
                if (manual) {
                    var error by remember { mutableStateOf<String?>(null) }
                    val fr = remember { FocusRequester() }
                    Field(address, { address = it }, "Indirizzo del computer (es. 192.168.1.20)", Modifier.focusRequester(fr),
                        keyboard = KeyboardType.Uri) {
                        val url = Net.normalize(address)
                        Thread {
                            if (Net.isBunkerPlex(url)) runOnUiThread { Api.saveServer(this@MainActivity, url); reset(Screen.Who) }
                            else runOnUiThread { error = "A $url non risponde BunkerPlex" }
                        }.start()
                    }
                    error?.let { Txt(it, Modifier.padding(top = 10.dp), color = C.dim) }
                    LaunchedEffect(Unit) { fr.requestFocus() }
                } else if (!searching) {
                    val fr = remember { FocusRequester() }
                    Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        Btn("Cerca di nuovo", Modifier.focusRequester(fr), primary = true) { attempt++ }
                        Btn("Scrivi l'indirizzo") { manual = true }
                    }
                    LaunchedEffect(Unit) { fr.requestFocus() }
                }
            }
        }
    }

    // ---------------------------------------------------------------- Chi guarda?

    @Composable
    private fun WhoScreen() {
        var state by remember { mutableStateOf<JSONObject?>(null) }
        var error by remember { mutableStateOf<String?>(null) }
        var attempt by remember { mutableIntStateOf(0) }
        LaunchedEffect(attempt) {
            error = null
            try {
                val s = withContext(Dispatchers.IO) { Api.obj("/api/auth/state") }
                if (s.optJSONObject("user") != null) reset(Screen.Home) else state = s
            } catch (e: Exception) {
                error = "Non riesco a raggiungere BunkerPlex (${Api.base})."
            }
        }
        val s = state
        when {
            error != null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Txt(error!!, size = 20.sp, lines = 3)
                    val fr = remember { FocusRequester() }
                    Row(Modifier.padding(top = 24.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        Btn("Riprova", Modifier.focusRequester(fr), primary = true) { attempt++ }
                        Btn("Cambia server") { reset(Screen.Connect) }
                    }
                    LaunchedEffect(Unit) { fr.requestFocus() }
                }
            }
            s == null -> Centered("Un momento…")
            else -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Txt("Chi guarda?", size = 30.sp, bold = true)
                    var msg by remember { mutableStateOf<String?>(null) }
                    val profiles = s.optJSONArray("profiles").objects()
                    val fr = remember { FocusRequester() }
                    LazyRow(Modifier.padding(top = 30.dp), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                        items(profiles, key = { it.optInt("id") }) { p ->
                            val first = p === profiles.first()
                            Focusable(if (first) Modifier.focusRequester(fr) else Modifier, onClick = {
                                val id = p.optInt("id")
                                if (!p.optBoolean("quick")) go(Screen.Password(id, p.optString("name")))
                                else Thread {
                                    try {
                                        val (_, token) = Api.post("/api/auth/profile", JSONObject().put("id", id).put("device", "tv"))
                                        if (token != null) Api.saveSession(this@MainActivity, token)
                                        runOnUiThread { reset(Screen.Home) }
                                    } catch (e: Exception) {
                                        runOnUiThread { msg = e.message }
                                    }
                                }.start()
                            }) { f ->
                                Column(
                                    Modifier.background(if (f) C.accent else C.card).padding(24.dp).width(140.dp),
                                    horizontalAlignment = Alignment.CenterHorizontally
                                ) {
                                    Box(Modifier.clip(RoundedCornerShape(50)).background(C.panel).padding(20.dp)) {
                                        Txt(p.optString("name").take(1).uppercase(), size = 34.sp, bold = true)
                                    }
                                    Txt(p.optString("name"), Modifier.padding(top = 12.dp), size = 18.sp)
                                }
                            }
                        }
                    }
                    msg?.let { Txt(it, Modifier.padding(top = 16.dp), color = C.dim) }
                    Row(Modifier.padding(top = 30.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        Btn("Entra con un account") { web("#/login") }
                        Btn("Cambia server") { reset(Screen.Connect) }
                    }
                    LaunchedEffect(profiles.size) { if (profiles.isNotEmpty()) fr.requestFocus() }
                }
            }
        }
    }

    @Composable
    private fun PasswordScreen(p: Screen.Password) {
        var password by remember { mutableStateOf("") }
        var msg by remember { mutableStateOf<String?>(null) }
        val fr = remember { FocusRequester() }
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Column(Modifier.width(520.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Txt("Password di ${p.name}", size = 26.sp, bold = true)
                Box(Modifier.padding(top = 24.dp)) {
                    Field(password, { password = it }, "Password", Modifier.focusRequester(fr), secret = true) {
                        Thread {
                            try {
                                val (_, token) = Api.post("/api/auth/login",
                                    JSONObject().put("username", p.name).put("password", password).put("device", "tv"))
                                if (token != null) Api.saveSession(this@MainActivity, token)
                                runOnUiThread { reset(Screen.Home) }
                            } catch (e: Exception) {
                                runOnUiThread { msg = e.message }
                            }
                        }.start()
                    }
                }
                msg?.let { Txt(it, Modifier.padding(top = 12.dp), color = C.dim, lines = 2) }
            }
        }
        LaunchedEffect(Unit) { fr.requestFocus() }
    }
}

/** Campo di testo: OK sul telecomando apre la tastiera della TV, Invio conferma. */
@Composable
fun Field(
    value: String,
    onChange: (String) -> Unit,
    hint: String,
    modifier: Modifier = Modifier,
    secret: Boolean = false,
    keyboard: KeyboardType = KeyboardType.Text,
    onDone: () -> Unit,
) {
    Box(
        Modifier.width(480.dp).clip(RoundedCornerShape(8.dp)).background(C.card).padding(14.dp)
    ) {
        if (value.isEmpty()) Txt(hint, color = C.dim)
        BasicTextField(
            value, onChange, modifier.width(452.dp),
            singleLine = true,
            textStyle = TextStyle(color = C.text, fontSize = 18.sp),
            cursorBrush = SolidColor(C.accentLight),
            visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
            keyboardOptions = KeyboardOptions(
                keyboardType = if (secret) KeyboardType.Password else keyboard, imeAction = ImeAction.Done
            ),
            keyboardActions = KeyboardActions(onDone = { onDone() }),
        )
    }
}
