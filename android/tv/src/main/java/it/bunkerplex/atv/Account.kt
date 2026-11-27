package it.bunkerplex.atv

import android.widget.Toast
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.text.DateFormat
import java.util.Date
import java.util.Locale

/**
 * Account, nativo: entrare dal telefono (QR) o con Google (sempre dal telefono:
 * sulla TV non si scrive mai la password dell'account), la pagina dell'account,
 * la password nuova al primo accesso e la scelta fra impostazioni diverse.
 */

fun MainActivity.toast(text: String) = runOnUiThread { Toast.makeText(this, text, Toast.LENGTH_LONG).show() }

/** Prende il fuoco appena il campo o il pulsante e' disegnato. */
@Composable
fun AutoFocus(fr: FocusRequester) {
    LaunchedEffect(fr) {
        repeat(5) { if (runCatching { fr.requestFocus() }.isSuccess) return@LaunchedEffect; withFrameNanos { } }
    }
}

/** Pagina centrata, senza menu (come «Chi guarda?»). */
@Composable
private fun Center(width: Dp = 640.dp, content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), contentAlignment = Alignment.TopCenter) {
        Column(Modifier.width(width).padding(top = 60.dp, bottom = 60.dp)) { content() }
    }
}

// ---------------------------------------------------------------- QR

/** Un QR disegnato dalle righe di 0 e 1 che manda il server (campo "qr"). */
@Composable
fun Qr(rows: List<String>, size: Dp) {
    if (rows.isEmpty()) return
    val n = rows.size + 4            // bordo bianco di due moduli per lato
    Canvas(Modifier.size(size).clip(RoundedCornerShape(8.dp)).background(C.ink)) {
        val m = this.size.width / n
        rows.forEachIndexed { y, row ->
            row.forEachIndexed { x, c ->
                if (c == '1') drawRect(C.bg, Offset((x + 2) * m, (y + 2) * m), Size(m + 0.5f, m + 0.5f))
            }
        }
    }
}

/** Le righe di 0 e 1 del QR di un indirizzo, calcolate qui (zxing), senza bordo. */
fun qrRows(text: String): List<String> = try {
    val m = com.google.zxing.qrcode.QRCodeWriter().encode(text, com.google.zxing.BarcodeFormat.QR_CODE, 0, 0,
        mapOf(com.google.zxing.EncodeHintType.MARGIN to 0,
            com.google.zxing.EncodeHintType.ERROR_CORRECTION to com.google.zxing.qrcode.decoder.ErrorCorrectionLevel.M))
    (0 until m.height).map { y -> buildString { for (x in 0 until m.width) append(if (m[x, y]) '1' else '0') } }
} catch (_: Exception) {
    emptyList()
}

private fun JSONArray?.rows(): List<String> = strings()

/** Il codice si legge meglio a gruppi: «ABC DEF». */
private fun spaced(code: String) = if (code.length == 6) code.take(3) + " " + code.drop(3) else code

// ---------------------------------------------------------------- Dal telefono

@Composable
fun PairScreen(act: MainActivity) {
    var pair by remember { mutableStateOf<JSONObject?>(null) }
    var msg by remember { mutableStateOf<String?>(null) }
    var seen by remember { mutableStateOf(false) }
    var round by remember { mutableIntStateOf(0) }
    LaunchedEffect(round) { pairLoop(act, { pair = it; seen = false }, { seen = it }, { msg = it }, { round++ }) }
    val back = remember { FocusRequester() }
    Center(900.dp) {
        Title("Entra dal telefono", size = 32.sp, lines = 1)
        LiveStatus(
            when {
                msg != null -> msg!!
                seen -> "Codice aperto sul telefono: entra lì e la TV entra da sola"
                else -> "In attesa del telefono…"
            },
            if (msg != null) Live.Warn else if (seen) Live.Ok else Live.Wait,
            Modifier.padding(top = 12.dp),
        )
        val p = pair
        Row(Modifier.padding(top = 26.dp)) {
            if (p != null) Qr(p.optJSONArray("qr").rows(), 260.dp)
            Column(Modifier.padding(start = 34.dp)) {
                Txt("Inquadra il QR con la fotocamera del telefono (collegato alla rete di casa) e scrivi lì nome e password del tuo account: la TV entra da sola.",
                    color = C.ink2, lines = 4, lineHeight = 24.sp)
                p?.optString("url")?.takeIf { it.isNotEmpty() }?.let {
                    Txt("Oppure apri dal telefono:", Modifier.padding(top = 14.dp), color = C.ink2)
                    Txt(it, Modifier.padding(top = 4.dp), weight = FontWeight.SemiBold, lines = 2)
                }
                Txt("Codice della TV, lo ritrovi sul telefono:", Modifier.padding(top = 16.dp), size = 14.sp, color = C.ink3)
                Txt(spaced(p?.optString("code") ?: "…"), Modifier.padding(top = 4.dp), size = 40.sp, weight = FontWeight.Bold)
                Row(Modifier.padding(top = 22.dp)) { Btn("Indietro", Modifier.focusRequester(back)) { act.back() } }
            }
        }
    }
    AutoFocus(back)
}

// ---------------------------------------------------------------- Password nuova

/** Primo accesso con una password provvisoria: se ne sceglie una. */
@Composable
fun NewPasswordScreen(act: MainActivity) {
    var old by remember { mutableStateOf("") }
    var new1 by remember { mutableStateOf("") }
    var new2 by remember { mutableStateOf("") }
    var msg by remember { mutableStateOf<String?>(null) }
    val f1 = remember { FocusRequester() }
    val f2 = remember { FocusRequester() }
    val f3 = remember { FocusRequester() }
    fun send() {
        when {
            old.isEmpty() || new1.isEmpty() -> { msg = "Scrivi la password attuale e quella nuova"; return }
            new1 != new2 -> { msg = "Le due password nuove non sono uguali"; return }
        }
        msg = "Salvo…"
        Thread {
            try {
                val (body, _) = Api.post("/api/auth/password", JSONObject().put("old", old).put("new", new1))
                act.runOnUiThread { act.toast("Password cambiata"); act.afterLogin(JSONObject(body)) }
            } catch (e: Exception) {
                act.runOnUiThread { msg = e.message }
            }
        }.start()
    }
    Center {
        Title("Scegli la tua password", size = 32.sp, lines = 1)
        Txt("Sei entrato con una password provvisoria: scegline una tua (almeno 8 caratteri).",
            Modifier.padding(top = 8.dp, bottom = 24.dp), color = C.ink2, lines = 2)
        Field(old, { old = it }, "Password provvisoria", Modifier.focusRequester(f1), secret = true) { runCatching { f2.requestFocus() } }
        Box(Modifier.padding(top = 12.dp))
        Field(new1, { new1 = it }, "Password nuova", Modifier.focusRequester(f2), secret = true) { runCatching { f3.requestFocus() } }
        Box(Modifier.padding(top = 12.dp))
        Field(new2, { new2 = it }, "Ripeti la password nuova", Modifier.focusRequester(f3), secret = true) { send() }
        msg?.let { Txt(it, Modifier.padding(top = 12.dp), color = C.warn, lines = 2) }
        Row(Modifier.padding(top = 22.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Btn("Salva", primary = true) { send() }
            Btn("Esci") { act.switchProfile() }
        }
    }
    AutoFocus(f1)
}

// ---------------------------------------------------------------- Impostazioni diverse

@Composable
fun ConflictsScreen(act: MainActivity, s: Screen.Conflicts) {
    val list = remember(s) { runCatching { JSONArray(s.json).objects() }.getOrDefault(emptyList()) }
    var msg by remember { mutableStateOf<String?>(null) }
    val fr = remember { FocusRequester() }
    fun keep(which: String) {
        Thread {
            try {
                Api.post("/api/auth/resolve", JSONObject().put("keep", which))
                act.runOnUiThread {
                    act.toast(if (which == "local") "Fatto: l'account ora ha le impostazioni di qui" else "Fatto: usi le impostazioni dell'account")
                    act.proceed()
                }
            } catch (e: Exception) {
                act.runOnUiThread { msg = e.message }
            }
        }.start()
    }
    Center(760.dp) {
        Title("Impostazioni diverse", size = 32.sp, lines = 1)
        Txt("Qui ci sono impostazioni diverse da quelle salvate nel tuo account. Quali vuoi tenere?",
            Modifier.padding(top = 8.dp, bottom = 18.dp), color = C.ink2, lines = 2)
        list.forEach { c ->
            Column(Modifier.padding(bottom = 10.dp).clip(RoundedCornerShape(8.dp)).background(C.surface).padding(16.dp)) {
                Txt(c.optString("label"), weight = FontWeight.SemiBold)
                Txt("Questo PC: " + c.optString("local"), Modifier.padding(top = 4.dp), color = C.ink2, lines = 2)
                Txt("Account: " + c.optString("cloud"), color = C.ink2, lines = 2)
            }
        }
        msg?.let { Txt(it, Modifier.padding(top = 12.dp), color = C.warn, lines = 2) }
        Row(Modifier.padding(top = 18.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Btn("Usa quelle dell'account", Modifier.focusRequester(fr), primary = true) { keep("cloud") }
            Btn("Tieni quelle di qui") { keep("local") }
        }
        Txt("Le impostazioni che non scegli vengono sostituite.", Modifier.padding(top = 16.dp), color = C.ink3)
    }
    AutoFocus(fr)
}

// ---------------------------------------------------------------- Conferma

/** «Sei sicuro?»: Indietro o «Annulla» tornano alla pagina di prima. */
@Composable
fun ConfirmScreen(act: MainActivity, s: Screen.Confirm) {
    val fr = remember { FocusRequester() }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(Modifier.width(640.dp)) {
            Txt(s.text, size = 20.sp, weight = FontWeight.SemiBold, lines = 6, lineHeight = 28.sp)
            Row(Modifier.padding(top = 26.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                Btn("Annulla", Modifier.focusRequester(fr)) { act.back() }
                Btn(s.yes, primary = true) { act.back(); s.action() }
            }
        }
    }
    AutoFocus(fr)
}

// ---------------------------------------------------------------- Account

private fun ago(sec: Long): String {
    if (sec <= 0) return "mai"
    val s = System.currentTimeMillis() / 1000 - sec
    return when {
        s < 60 -> "adesso"
        s < 3600 -> (s / 60.0).let { Math.round(it) }.let { if (it == 1L) "1 minuto fa" else "$it minuti fa" }
        s < 86400 -> (s / 3600.0).let { Math.round(it) }.let { if (it == 1L) "1 ora fa" else "$it ore fa" }
        s < 2 * 86400 -> "ieri"
        s < 7 * 86400 -> "${s / 86400} giorni fa"
        else -> DateFormat.getDateInstance(DateFormat.LONG, Locale.ITALIAN).format(Date(sec * 1000))
    }
}

/** Com'e' messa la sincronizzazione (come syncState sul web): testo e se va guardata. */
fun syncState(state: JSONObject, u: JSONObject): Pair<String, Boolean> = when {
    !u.optBoolean("linked") -> "Solo su questo PC" to false
    u.optBoolean("must_change") -> "Scegli la tua password per sincronizzare" to true
    !u.optBoolean("online") -> "Ridai la password per sincronizzare" to true
    state.optBoolean("offline") -> "Offline · si sincronizza quando torna la rete" to true
    u.optInt("pending") > 0 -> "Sincronizzazione in corso" to false
    else -> (u.optLong("last_sync").let { if (it > 0) "Sincronizzato ${ago(it)}" else "Sincronizzazione in corso" }) to false
}

@Composable
fun AccountScreen(act: MainActivity, refresh: Int) {
    var state by remember { mutableStateOf<JSONObject?>(null) }
    var msg by remember { mutableStateOf<String?>(null) }
    var round by remember { mutableIntStateOf(0) }
    LaunchedEffect(refresh, round) {
        try {
            state = withContext(Dispatchers.IO) { Api.obj("/api/auth/state") }
        } catch (e: ApiError) {
            if (e.status == 401) act.session401() else msg = e.message
        } catch (e: Exception) {
            msg = "Non riesco a raggiungere BunkerPlex."
        }
    }
    fun run(work: () -> Unit, done: String? = null) {
        Thread {
            try {
                work()
                act.runOnUiThread { done?.let { act.toast(it) }; round++ }
            } catch (e: Exception) {
                act.runOnUiThread { act.toast(e.message ?: "Non riuscito") }
            }
        }.start()
    }
    val first = remember { FocusRequester() }
    Page(act, "settings") {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                .padding(start = D.pad, end = D.pad, top = 36.dp, bottom = 60.dp)
        ) {
            Title("Account", size = 34.sp, lines = 1)
            msg?.let { Txt(it, Modifier.padding(top = 12.dp), color = C.warn, lines = 2) }
            val s = state ?: return@Column
            val u = s.optJSONObject("user") ?: return@Column
            val name = u.optString("name")
            val linked = u.optBoolean("linked")
            val cloud = s.optBoolean("cloud")
            val many = (s.optJSONArray("profiles")?.length() ?: 0) > 1
            val online = u.optBoolean("online")
            // Dove arriva il fuoco: la cosa da fare, se c'e'
            val target = when {
                !linked && cloud && !s.optBoolean("offline") -> "pair"
                linked && !online && !u.optBoolean("home") -> "relogin"
                linked && u.optBoolean("manager") && !u.optBoolean("home") -> "quick"
                else -> "leave"
            }
            fun at(k: String) = if (k == target) Modifier.focusRequester(first) else Modifier

            Section("Chi sei") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Face(name, 72.dp)
                    Column(Modifier.padding(start = 20.dp)) {
                        Txt(name, size = 24.sp, weight = FontWeight.Bold)
                        Txt((if (linked) (if (u.optBoolean("admin")) "Account amministratore" else "Account") else "Su questo PC, senza account") +
                            " · " + s.optString("server").ifEmpty { "BunkerPlex" }, Modifier.padding(top = 4.dp), color = C.ink2)
                        val (text, warn) = syncState(s, u)
                        Txt(text, Modifier.padding(top = 4.dp), color = if (warn) C.warn else C.accentText, weight = FontWeight.SemiBold)
                    }
                }
            }

            if (!linked && cloud) Section("Entra con un account") {
                Txt("Funziona tutto anche senza: il login è facoltativo. Con un account visti, lista, raccolte e impostazioni ti seguono su ogni PC e TV, e quello che hai già qui si unisce all'account.",
                    color = C.ink2, lines = 4, lineHeight = 24.sp)
                if (s.optBoolean("offline")) {
                    Txt("Ora il PC non raggiunge il servizio account: per entrare serve Internet.", Modifier.padding(top = 12.dp), color = C.warn, lines = 2)
                } else Row(Modifier.padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    Btn("Entra dal telefono", at("pair"), primary = true) { act.go(Screen.Phone) }
                }
            }

            if (linked && !online && !u.optBoolean("home")) Section("Rientra dal telefono") {
                Txt("L'account è stato aperto con una password diversa (cambiata su un altro PC, o nuova provvisoria). Qui funziona tutto lo stesso; per riprendere la sincronizzazione rientra dal telefono.",
                    color = C.ink2, lines = 4, lineHeight = 24.sp)
                Row(Modifier.padding(top = 16.dp)) {
                    Btn("Entra dal telefono", at("relogin"), primary = true) { act.go(Screen.Phone) }
                }
            }

            if (linked) Section("Accesso") {
                // Senza Internet: chi e' in casa entra senza password (solo chi gestisce il server)
                if (u.optBoolean("manager") && !u.optBoolean("home")) {
                    val home = s.optBoolean("home_offline", true)
                    Btn("Senza Internet, chi è in casa entra senza password: " + if (home) "sì" else "no", at("quick")) {
                        run({ Api.post("/api/auth/home-offline", JSONObject().put("on", !home)) })
                    }
                    Txt("Solo quando il PC non raggiunge Internet, solo dalla rete di casa, e senza cambiare le impostazioni.",
                        Modifier.padding(top = 8.dp), size = 15.sp, color = C.ink3, lines = 2)
                }
                val email = u.optString("email")
                if (email.isNotEmpty()) Txt("Puoi entrare anche con $email e la tua password.", Modifier.padding(top = 18.dp), color = C.ink2)
                val google = u.optString("google")
                if (google.isNotEmpty()) {
                    Txt("Puoi entrare con $google, senza password.", Modifier.padding(top = 18.dp), color = C.ink2)
                    Row(Modifier.padding(top = 12.dp)) {
                        Btn("Scollega Google") {
                            act.go(Screen.Confirm("Scollegare Google dal tuo account? Per entrare servirà di nuovo la password.", "Sì, scollega") {
                                run({ Api.call("DELETE", "/api/auth/google") }, "Google scollegato")
                            })
                        }
                    }
                }
            }

            if (cloud) Section("Su questa TV") {
                Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    Btn(if (many) "Cambia account" else "Esci", at("leave")) { act.switchProfile() }
                    if (many) Btn("Togli l'account da questo PC") {
                        act.go(Screen.Confirm("Togliere l'account «$name» da questo PC? L'account resta online con visti, ripresa e lista già sincronizzati. Le sue raccolte di qui passano a un altro account: i video non si toccano.",
                            "Sì, togli l'account") {
                            Thread {
                                try {
                                    Api.call("DELETE", "/api/auth/profile")
                                    act.runOnUiThread {
                                        act.toast("Account tolto da questo PC")
                                        Api.saveSession(act, "")
                                        Api.user = null
                                        act.reset(Screen.Who)
                                    }
                                } catch (e: Exception) {
                                    act.toast(e.message ?: "Non riuscito")
                                }
                            }.start()
                        })
                    }
                }
            }
            AutoFocus(first)
        }
    }
}
