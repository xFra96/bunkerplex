package it.bunkerplex.atv

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * Ogni volta che si apre l'app: 1) l'accesso (se e' ancora valido si salta; la prima
 * volta QR e codice da confermare dal telefono o dal PC), 2) quale server guardare,
 * 3) «Chi guarda?» se l'account ha piu' profili. Come sul web.
 */
object Access {
    /** Il server scelto a questa apertura: null = da scegliere, "here" o "f<n>". */
    @Volatile
    var src: String? = null

    /** «Chi guarda?» gia' scelto a questa apertura. */
    @Volatile
    var whoDone = false

    fun reset() {
        src = null
        whoDone = false
    }

    fun homePath() = "/api/home" + (src?.let { "?src=$it" } ?: "")
}

/** Dopo l'accesso: server, poi profilo, poi la Home. */
fun MainActivity.proceed() {
    Thread {
        val user = try { Api.obj("/api/auth/state").optJSONObject("user") } catch (_: Exception) { null }
        runOnUiThread {
            when {
                user == null -> reset(Screen.Who)
                Access.src == null -> reset(Screen.Servers)
                !Access.whoDone && (user.optJSONArray("watchers")?.length() ?: 0) > 1 -> reset(Screen.Watchers)
                else -> reset(Screen.Home)
            }
        }
    }.start()
}

/** Pagina d'accesso: logo in alto, contenuto al centro. */
@Composable
private fun AuthPage(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().background(C.bg).verticalScroll(rememberScrollState()), contentAlignment = Alignment.TopCenter) {
        Column(Modifier.fillMaxWidth().padding(top = 44.dp, bottom = 40.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Wordmark(40.dp, 26.sp)
            Spacer(Modifier.height(30.dp))
            content()
        }
    }
}

// ---------------------------------------------------------------- Prima configurazione

/** QR da una parte, codice dall'altra: si conferma da BunkerPlex sul telefono o sul PC. */
@Composable
fun LinkScreen(act: MainActivity, google: Boolean) {
    var pair by remember { mutableStateOf<JSONObject?>(null) }
    var msg by remember { mutableStateOf<String?>(null) }
    var round by remember { mutableIntStateOf(0) }
    LaunchedEffect(round) {
        try {
            val p = withContext(Dispatchers.IO) { JSONObject(Api.post("/api/auth/pair", JSONObject()).first) }
            pair = p
            msg = null
            val until = System.currentTimeMillis() + (p.optLong("ttl", 600) - 60) * 1000
            while (System.currentTimeMillis() < until) {
                delay(2000)
                val (body, token) = withContext(Dispatchers.IO) { Api.call("GET", "/api/auth/pair/${p.optString("code")}") }
                if (JSONObject(body).optBoolean("done")) {
                    act.entered(body, token)
                    return@LaunchedEffect
                }
            }
            round++                           // scaduto: codice nuovo
        } catch (e: ApiError) {
            if (e.status == 404) round++ else msg = e.message
        } catch (e: Exception) {
            msg = "Non riesco a raggiungere BunkerPlex."
        }
    }
    val first = remember { FocusRequester() }
    val p = pair
    val code = p?.optString("code") ?: ""
    val site = p?.optString("base")?.removePrefix("http://")?.takeIf { it.isNotEmpty() }?.let { "$it/#/tv" }
    AuthPage {
        Title("Collega questa TV", size = 34.sp, lines = 1)
        Txt("Accedi una volta dal telefono: la TV entra da sola.", Modifier.padding(top = 8.dp), size = 18.sp, color = C.ink2)
        msg?.let { Txt(it, Modifier.padding(top = 12.dp), color = C.warn, lines = 2) }
        Row(Modifier.padding(top = 30.dp).height(330.dp), verticalAlignment = Alignment.CenterVertically) {
            Panel {
                if (p != null) Qr(p.optJSONArray("qr").strings(), 210.dp)
                Txt("Inquadra il QR", Modifier.padding(top = 18.dp), size = 21.sp, weight = FontWeight.Bold)
                Txt("con la fotocamera del telefono, sulla rete di casa", Modifier.padding(top = 6.dp), size = 15.sp, color = C.ink2, lines = 2)
            }
            Column(Modifier.width(110.dp).fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                Box(Modifier.width(1.dp).weight(1f).background(C.surface2))
                Txt("OPPURE", Modifier.padding(vertical = 10.dp), size = 13.sp, color = C.ink3, weight = FontWeight.SemiBold)
                Box(Modifier.width(1.dp).weight(1f).background(C.surface2))
            }
            Panel {
                Txt("Apri BunkerPlex sul telefono o sul PC, vai in «Collega una TV» e scrivi",
                    size = 16.sp, color = C.ink2, lines = 3, lineHeight = 23.sp)
                Box(
                    Modifier.padding(top = 22.dp).clip(RoundedCornerShape(14.dp)).background(C.bg)
                        .border(2.dp, C.surface2, RoundedCornerShape(14.dp)).padding(horizontal = 26.dp, vertical = 16.dp)
                ) {
                    Txt(if (code.length == 6) code.take(3) + "  " + code.drop(3) else "…", size = 52.sp, weight = FontWeight.ExtraBold)
                }
                site?.let { Txt(it, Modifier.padding(top = 14.dp), size = 14.sp, color = C.ink3) }
            }
        }
        Row(Modifier.padding(top = 30.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Btn("Usa il telecomando", Modifier.focusRequester(first)) { act.go(Screen.Login(null, google)) }
            if (google) Btn("Entra con Google") { act.go(Screen.Google(false)) }
            Btn("Cambia server") { act.reset(Screen.Connect) }
        }
    }
    AutoFocus(first)
}

@Composable
private fun Panel(content: @Composable () -> Unit) {
    Column(
        Modifier.width(400.dp).fillMaxSize().clip(RoundedCornerShape(18.dp)).background(C.surface).padding(26.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
    ) { content() }
}

// ---------------------------------------------------------------- Quale server

private class Srv(val arg: String, val name: String, val sub: String, val on: Boolean, val friend: Boolean)

@Composable
fun ServersScreen(act: MainActivity, refresh: Int) {
    var list by remember { mutableStateOf<List<Srv>?>(null) }
    var waiting by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var adding by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    var msg by remember { mutableStateOf<String?>(null) }
    var round by remember { mutableIntStateOf(0) }
    LaunchedEffect(refresh, round) {
        try {
            val st = withContext(Dispatchers.IO) { Api.obj("/api/auth/state") }
            val u = st.optJSONObject("user")
            if (u == null) { act.reset(Screen.Who); return@LaunchedEffect }
            val guest = u.optBoolean("guest")
            val out = mutableListOf(Srv("here", st.optString("pc").ifEmpty { "Questo server" },
                if (guest) "di ${st.optString("owner")} · sei suo ospite" else "Il tuo server · questo PC", true, false))
            val req = mutableListOf<JSONObject>()
            if (u.optBoolean("linked") && !guest) {
                val f = try { withContext(Dispatchers.IO) { Api.obj("/api/account-friends") } } catch (_: Exception) { JSONObject() }
                f.optJSONArray("mine").objects().forEach { m ->
                    if (!m.isNull("n")) out.add(Srv("f" + m.optInt("n"), m.optString("name").ifEmpty { "Il tuo altro PC" },
                        if (m.opt("online") == false) "Il tuo PC · non raggiungibile" else "Il tuo PC", m.opt("online") != false, false))
                }
                f.optJSONArray("friends").objects().forEach { fr ->
                    when (fr.optString("status")) {
                        "received" -> req.add(fr)
                        "ok" -> {
                            val servers = fr.optJSONArray("servers").objects().filter { !it.isNull("n") }
                            if (servers.isEmpty()) out.add(Srv("none", fr.optString("username"), "nessun server acceso", false, true))
                            servers.forEach { s ->
                                val off = s.opt("online") == false
                                out.add(Srv("f" + s.optInt("n"), fr.optString("username") + (if (servers.size > 1) " · " + s.optString("name") else ""),
                                    if (off) "Amico · non raggiungibile ora" else "Amico", !off, true))
                            }
                        }
                    }
                }
            }
            waiting = req
            list = out
        } catch (e: Exception) {
            msg = e.message
            list = list ?: emptyList()
        }
    }
    fun pick(s: Srv) {
        if (!s.on) { act.toast("Questo server ora non è raggiungibile"); return }
        Access.src = s.arg
        act.proceed()
    }
    fun send() {
        if (name.isBlank()) { msg = "Scrivi il nome dell'account del tuo amico"; return }
        Thread {
            try {
                val (body, _) = Api.post("/api/account-friends", JSONObject().put("username", name.trim()))
                val r = JSONObject(body)
                act.toast(if (r.optString("status") == "ok") "Ora siete amici" else "Richiesta mandata a ${r.optString("username")}")
                act.runOnUiThread { adding = false; name = ""; round++ }
            } catch (e: Exception) { act.runOnUiThread { msg = e.message } }
        }.start()
    }
    val first = remember { FocusRequester() }
    AuthPage {
        Title("Cosa guardi oggi?", size = 34.sp, lines = 1)
        Txt("Scegli il server: il tuo e quelli dei tuoi amici", Modifier.padding(top = 8.dp, bottom = 24.dp), size = 18.sp, color = C.ink2)
        waiting.forEach { fr ->
            Row(Modifier.width(620.dp).padding(bottom = 14.dp).clip(RoundedCornerShape(14.dp)).background(C.accent.copy(alpha = 0.16f))
                .padding(horizontal = 18.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Txt("${fr.optString("username")} vuole essere tuo amico", Modifier.weight(1f), size = 17.sp)
                Btn("Accetta", primary = true) {
                    Thread {
                        try { Api.post("/api/account-friends/${fr.optInt("id")}/accept", JSONObject()); act.runOnUiThread { round++ } }
                        catch (e: Exception) { act.runOnUiThread { msg = e.message } }
                    }.start()
                }
            }
        }
        val l = list
        if (l == null) Txt("…", color = C.ink3)
        else Nearest {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                l.forEachIndexed { i, s ->
                    SrvCard(if (i == 0) Modifier.focusRequester(first) else Modifier,
                        if (s.friend) Ic.friends else Ic.screen, s.name, s.sub, s.on) { pick(s) }
                }
                if (adding) {
                    Row(Modifier.width(620.dp), verticalAlignment = Alignment.CenterVertically) {
                        Field(name, { name = it }, "Nome dell'account del tuo amico") { send() }
                        Spacer(Modifier.width(12.dp))
                        Btn("Invia", primary = true) { send() }
                    }
                } else SrvCard(Modifier, Ic.plus, "Aggiungi un amico", "Con il nome del suo account: vedrai i suoi server accesi", true, add = true) { adding = true }
            }
        }
        msg?.let { Txt(it, Modifier.padding(top = 14.dp), color = C.warn, lines = 2) }
        Row(Modifier.padding(top = 24.dp)) { Btn("Esci") { act.switchProfile() } }
    }
    LaunchedEffect(list != null) { if (list != null) repeat(5) { if (runCatching { first.requestFocus() }.isSuccess) return@LaunchedEffect; delay(16) } }
}

@Composable
private fun SrvCard(modifier: Modifier, icon: androidx.compose.ui.graphics.vector.ImageVector, name: String, sub: String,
                    on: Boolean, add: Boolean = false, onClick: () -> Unit) {
    val shape = RoundedCornerShape(16.dp)
    Focusable(modifier.width(620.dp), shape, scale = 1.03f, onClick = onClick) { f ->
        Row(
            Modifier.fillMaxWidth().background(if (f) C.ink else if (add) C.bg else C.surface)
                .border(2.dp, if (add && !f) C.surface2 else androidx.compose.ui.graphics.Color.Transparent, shape)
                .padding(horizontal = 18.dp, vertical = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(54.dp).clip(RoundedCornerShape(12.dp)).background(if (f) C.bg else C.surface2), contentAlignment = Alignment.Center) {
                Icon(icon, if (add) C.accentText else if (f) C.ink else C.ink, 28.dp)
            }
            Column(Modifier.weight(1f).padding(start = 18.dp)) {
                Txt(name, size = 20.sp, weight = FontWeight.Bold, color = if (f) C.bg else if (on) C.ink else C.ink3)
                Txt(sub, Modifier.padding(top = 3.dp), size = 15.sp, color = if (f) C.bg.copy(alpha = 0.7f) else C.ink2)
            }
            if (!add) Box(Modifier.size(12.dp).clip(CircleShape).background(if (on) C.accentText else C.ink3))
        }
    }
}

// ---------------------------------------------------------------- Chi guarda

@Composable
fun WatchersScreen(act: MainActivity) {
    var user by remember { mutableStateOf<JSONObject?>(null) }
    var msg by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        try {
            user = withContext(Dispatchers.IO) { Api.obj("/api/auth/state") }.optJSONObject("user")
            if (user == null) act.reset(Screen.Who)
        } catch (e: Exception) { msg = e.message }
    }
    val first = remember { FocusRequester() }
    val u = user
    AuthPage {
        Title("Chi guarda?", size = 40.sp, lines = 1)
        Txt("Ognuno ha i suoi visti, la sua ripresa e la sua lista", Modifier.padding(top = 8.dp), size = 18.sp, color = C.ink2)
        if (u != null) {
            val list = u.optJSONArray("watchers").objects()
            val cur = if (u.isNull("watcher")) -1 else u.optInt("watcher", -1)
            Nearest {
                LazyRow(
                    Modifier.padding(top = 40.dp),
                    contentPadding = PaddingValues(horizontal = 40.dp, vertical = 10.dp),
                    horizontalArrangement = Arrangement.spacedBy(40.dp),
                ) {
                    items(list, key = { it.optInt("id") }) { p ->
                        val id = p.optInt("id")
                        val isFirst = if (cur >= 0) id == cur else p === list.first()
                        FocusBox(if (isFirst) Modifier.focusRequester(first) else Modifier, onClick = {
                            Thread {
                                try {
                                    Api.post("/api/profiles/select", JSONObject().put("id", id))
                                    Api.user = p.optString("name")
                                    Access.whoDone = true
                                    act.runOnUiThread { act.proceed() }
                                } catch (e: Exception) { act.runOnUiThread { msg = e.message } }
                            }.start()
                        }) { f ->
                            Column(Modifier.width(150.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                                Box(Modifier.size(132.dp).lift(f, 1.08f).ring(f, CircleShape, 4.dp).padding(8.dp)) {
                                    Face(p.optString("name"), 116.dp)
                                }
                                Txt(p.optString("name"), Modifier.padding(top = 14.dp), size = 19.sp,
                                    color = if (f) C.ink else C.ink2, weight = if (f) FontWeight.Bold else FontWeight.SemiBold)
                            }
                        }
                    }
                }
            }
            LaunchedEffect(list.size) { repeat(5) { if (runCatching { first.requestFocus() }.isSuccess) return@LaunchedEffect; delay(16) } }
        }
        msg?.let { Txt(it, Modifier.padding(top = 14.dp), color = C.warn, lines = 2) }
        Row(Modifier.padding(top = 30.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Btn("Cambia server") { Access.src = null; act.reset(Screen.Servers) }
            Btn("Esci") { act.switchProfile() }
        }
    }
}
