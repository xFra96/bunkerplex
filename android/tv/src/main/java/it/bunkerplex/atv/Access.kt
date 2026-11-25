package it.bunkerplex.atv

import android.content.Context
import android.net.Uri
import android.os.Build
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
import it.bunkerplex.tv.Net
import it.bunkerplex.tv.Remote
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

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
                user == null -> reset(if (CloudTv.on(this)) Screen.Servers else Screen.Who)
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

// ---------------------------------------------------------------- Con l'account, senza server principale
//
// La TV entra con l'account direttamente nel servizio account (Remote), prende da li'
// l'elenco dei server (i tuoi e quelli che gli amici condividono) e si collega al
// server scelto: prima il nome https nella rete di casa, poi l'indirizzo di casa che
// il server ha detto al servizio (porta 32500), poi l'ultimo che ha funzionato, e
// solo alla fine cerca sulla rete. Il server da' una sessione in cambio del gettone
// d'accesso del servizio (/api/auth/access): da li' la TV lavora come sempre
// (X-BP-Session). I server degli amici si aprono dal tuo server, come prima (src f<n>).
// Vedi docs/architettura.md.

object CloudTv {
    /** Ultimo tentativo di riaprire il server di prima, una volta per apertura dell'app. */
    @Volatile
    var resumed = false

    private fun prefs(ctx: Context) = ctx.getSharedPreferences("bunkerplex", Context.MODE_PRIVATE)

    /** La TV usa l'account del servizio (non un server scelto a mano). */
    fun on(ctx: Context) = Remote.token(ctx).isNotEmpty()

    fun lastSid(ctx: Context) = prefs(ctx).getString("cloud_sid", "") ?: ""

    /** I server (prima quello in casa, poi gli accesi, i tuoi prima di quelli degli amici) e gli amici. */
    fun servers(ctx: Context): Pair<List<JSONObject>, List<JSONObject>> {
        val r = JSONObject(Remote.call(ctx, "GET", "/servers", null))
        fun rank(s: JSONObject) = when {
            s.optBoolean("local") -> 0
            s.opt("online") == false -> 4
            s.opt("online") != true -> 3
            s.optString("role") == "owner" -> 1
            else -> 2
        }
        return r.optJSONArray("servers").objects().sortedBy { rank(it) } to r.optJSONArray("friends").objects()
    }

    /** Amicizie dal servizio account: aggiungi (nome), accetta, rifiuta. */
    fun addFriend(ctx: Context, name: String): JSONObject =
        JSONObject(Remote.call(ctx, "POST", "/friends", JSONObject().put("username", name.trim()).toString()))
    fun acceptFriend(ctx: Context, id: Int) { Remote.call(ctx, "POST", "/friends/$id/accept", "{}") }
    fun declineFriend(ctx: Context, id: Int) { Remote.call(ctx, "DELETE", "/friends/$id", null) }

    /** Nome utente o email (con l'email si chiede prima il nome, come fanno i server). */
    fun login(ctx: Context, name: String, password: String) {
        var user = name.trim()
        if ("@" in user) {
            user = JSONObject(Remote.call(ctx, "POST", "/resolve", JSONObject().put("email", user).toString())).getString("username")
        }
        Remote.login(ctx, user, password, "TV " + (Build.MODEL ?: "Android"), "tv")
    }

    fun logout(ctx: Context) {
        try { Remote.call(ctx, "POST", "/logout", "{}") } catch (_: Exception) {}
        Remote.logout(ctx)
        Api.saveSession(ctx, "")
        prefs(ctx).edit().remove("cloud_sid").apply()
        resumed = false
    }

    /** Gli indirizzi da provare per un tuo server, in ordine. */
    private fun candidates(ctx: Context, s: JSONObject): List<String> {
        val a = s.optJSONObject("addresses") ?: JSONObject()
        val out = mutableListOf<String>()
        a.optString("secure_lan").takeIf { it.startsWith("https://") }?.let { out.add(it) }
        // L'indirizzo di casa che il server ha detto (https://IP:32501, per gli amici): la TV usa la 32500
        a.optString("lan").takeIf { it.isNotEmpty() }?.let { lan ->
            val host = Uri.parse(lan).host
            if (!host.isNullOrEmpty()) out.add("http://$host:32500")
        }
        prefs(ctx).getString("cloud_base_" + s.optString("sid"), null)?.let { if (it.isNotEmpty()) out.add(it) }
        if (Api.home.isNotEmpty()) out.add(Api.home)
        return out.distinct()
    }

    /** Il primo indirizzo che risponde ed e' proprio quel server (sid), provandoli tutti insieme. */
    private fun reach(ctx: Context, s: JSONObject): String? {
        val sid = s.optString("sid")
        val list = candidates(ctx, s)
        val answers = LinkedBlockingQueue<String>()
        list.forEach { url ->
            Thread {
                val info = Net.info(url, 3500)
                answers.offer(if (info != null && info.optString("sid") == sid) url else "")
            }.start()
        }
        repeat(list.size) {
            val url = answers.poll(6, TimeUnit.SECONDS) ?: return@repeat
            if (url.isNotEmpty()) return url
        }
        // Ultima prova: BunkerPlex sulla rete di casa (se e' quello giusto)
        val found = Net.discover() ?: return null
        return found.takeIf { Net.info(it, 3500)?.optString("sid") == sid }
    }

    /** Il servizio account risponde? (false = niente Internet, o servizio fermo) */
    fun reachable(ctx: Context): Boolean =
        try { Remote.call(ctx, "GET", "/", null); true } catch (e: Remote.CloudError) { e.status != 0 }

    /**
     * Senza servizio account: l'ultimo server usato, con la sessione che la TV ha gia'
     * (il server la riconosce anche senza Internet). false = non risponde o va rifatto
     * l'accesso: allora la ricerca sulla rete di casa.
     */
    fun offline(ctx: Context): Boolean {
        val base = prefs(ctx).getString("cloud_base_" + lastSid(ctx), null)?.ifEmpty { null } ?: Api.home
        if (base.isEmpty() || Net.info(base, 3500) == null) return false
        Api.base = base
        return sessionOk(base)
    }

    /** La sessione salvata vale ancora su quel server? */
    private fun sessionOk(base: String): Boolean {
        if (Api.home != base || Net.session.isEmpty()) return false
        return try { Api.obj("/api/auth/state").optJSONObject("user") != null } catch (_: Exception) { false }
    }

    /**
     * Collega la TV al server scelto (da un thread, non da quello dell'interfaccia).
     * Torna il src di Access ("here" o "f<n>"); IOException col motivo se non riesce.
     */
    fun open(ctx: Context, s: JSONObject, all: List<JSONObject>): String {
        val mine = s.optString("role") == "owner"
        val hosts = all.filter { it.optString("role") == "owner" && it.opt("online") != false }
        val host = if (mine) s else hosts.firstOrNull { it.optBoolean("local") } ?: hosts.firstOrNull()
            ?: throw IOException("Per i server degli amici serve un tuo server acceso")
        val sid = host.optString("sid")
        val base = reach(ctx, host)
            ?: throw IOException("${host.optString("name").ifEmpty { "Il server" }} non risponde: la TV è nella stessa rete di casa?")
        if (!sessionOk(base)) {
            val token = JSONObject(Remote.call(ctx, "POST", "/servers/$sid/access", "{}")).getString("token")
            Api.saveServer(ctx, base)
            val (body, _) = Api.post("/api/auth/access",
                JSONObject().put("token", token).put("device", "TV " + (Build.MODEL ?: "Android")))
            Api.saveSession(ctx, JSONObject(body).getString("session"))
        }
        Api.base = base
        prefs(ctx).edit().putString("cloud_base_$sid", base).putString("cloud_sid", s.optString("sid")).apply()
        if (mine) return "here"
        val f = Api.obj("/api/account-friends")
        f.optJSONArray("friends").objects().forEach { fr ->
            fr.optJSONArray("servers").objects().forEach { x ->
                if (x.optString("sid") == s.optString("sid") && !x.isNull("n")) return "f" + x.optInt("n")
            }
        }
        throw IOException("Il tuo server non è ancora collegato a ${s.optJSONObject("owner")?.optString("username")}: riprova tra un minuto")
    }
}

/** Entrare con l'account: nome (o email) e password, oppure Google dal telefono. */
@Composable
fun CloudLoginScreen(act: MainActivity) {
    var name by remember { mutableStateOf("") }
    var pass by remember { mutableStateOf("") }
    var msg by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val fr = remember { FocusRequester() }
    val passFr = remember { FocusRequester() }
    // Niente servizio account (niente Internet): si va dritti al server sulla rete di casa
    LaunchedEffect(Unit) {
        if (!withContext(Dispatchers.IO) { CloudTv.reachable(act) }) act.reset(Screen.Connect)
    }
    fun send() {
        if (name.isBlank() || pass.isEmpty()) { msg = "Scrivi nome utente (o email) e password"; return }
        if (busy) return
        busy = true
        msg = "Entro…"
        Thread {
            try {
                CloudTv.login(act, name, pass)
                act.runOnUiThread { Access.reset(); act.reset(Screen.Servers) }
            } catch (e: Remote.CloudError) {
                act.runOnUiThread { if (e.status == 0) act.reset(Screen.Connect) else { msg = e.message; busy = false } }
            } catch (e: Exception) {
                act.runOnUiThread { msg = e.message; busy = false }
            }
        }.start()
    }
    AuthPage {
        Title("Entra con il tuo account", size = 32.sp, lines = 1)
        Txt("Poi scegli il server: il tuo, o quelli dei tuoi amici.", Modifier.padding(top = 8.dp, bottom = 24.dp), size = 18.sp, color = C.ink2)
        Field(name, { name = it }, "Nome utente o email", Modifier.focusRequester(fr)) { runCatching { passFr.requestFocus() } }
        Box(Modifier.padding(top = 12.dp))
        Field(pass, { pass = it }, "Password", Modifier.focusRequester(passFr), secret = true) { send() }
        msg?.let { Txt(it, Modifier.padding(top = 12.dp), color = C.warn, lines = 2) }
        Row(Modifier.padding(top = 22.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Btn("Entra", primary = true) { send() }
            Btn("Entra con Google") { act.go(Screen.CloudGoogle) }
        }
    }
    AutoFocus(fr)
}

/** «Entra con Google» dalla TV: indirizzo e codice da aprire sul telefono. */
@Composable
fun CloudGoogleScreen(act: MainActivity) {
    var start by remember { mutableStateOf<JSONObject?>(null) }
    var msg by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        try {
            val s = JSONObject(withContext(Dispatchers.IO) { Remote.googleStart(act, true) })
            start = s
            val poll = s.optString("poll")
            val until = System.currentTimeMillis() + s.optLong("ttl", 600) * 1000
            while (System.currentTimeMillis() < until) {
                delay(2500)
                val r = JSONObject(withContext(Dispatchers.IO) { Remote.googlePoll(act, poll) })
                if (r.optString("token").isNotEmpty()) {
                    Access.reset()
                    act.reset(Screen.Servers)
                    return@LaunchedEffect
                }
            }
            msg = "Tempo scaduto: torna indietro e riprova"
        } catch (e: Exception) {
            msg = e.message
        }
    }
    val back = remember { FocusRequester() }
    AuthPage {
        Title("Entra con Google", size = 32.sp, lines = 1)
        val s = start
        if (s == null) Txt("…", Modifier.padding(top = 20.dp), color = C.ink3)
        else {
            Txt("Sul telefono o sul PC apri", Modifier.padding(top = 16.dp), size = 20.sp, color = C.ink2)
            Txt(s.optString("short").substringAfter("://"), Modifier.padding(top = 8.dp), size = 26.sp, weight = FontWeight.Bold, lines = 2)
            Txt("e scrivi il codice", Modifier.padding(top = 18.dp), size = 20.sp, color = C.ink2)
            Txt(s.optString("code"), Modifier.padding(top = 8.dp), size = 44.sp, weight = FontWeight.ExtraBold, lines = 1)
        }
        msg?.let { Txt(it, Modifier.padding(top = 16.dp), color = C.warn, lines = 2) }
        Row(Modifier.padding(top = 28.dp)) { Btn("Indietro", Modifier.focusRequester(back)) { act.reset(Screen.CloudLogin) } }
    }
    AutoFocus(back)
}

/** «Cosa guardi oggi?» con l'elenco del servizio account; collegamento diretto al server scelto. */
@Composable
fun CloudServersScreen(act: MainActivity, refresh: Int) {
    var list by remember { mutableStateOf<List<JSONObject>?>(null) }
    var friends by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var msg by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf<String?>(null) }
    var round by remember { mutableIntStateOf(0) }
    var adding by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    fun friendTask(done: String?, job: () -> Unit) {
        Thread {
            try { job(); act.runOnUiThread { done?.let { act.toast(it) }; round++ } }
            catch (e: Exception) { act.runOnUiThread { msg = e.message } }
        }.start()
    }
    fun send() {
        if (name.isBlank()) { msg = "Scrivi il nome dell'account del tuo amico"; return }
        Thread {
            try {
                val r = CloudTv.addFriend(act, name)
                act.toast(if (r.optString("status") == "ok") "Ora tu e ${r.optString("username")} siete amici"
                    else "Richiesta mandata a ${r.optString("username")}: quando accetta, i suoi server compaiono qui")
                act.runOnUiThread { adding = false; name = ""; msg = null; round++ }
            } catch (e: Exception) { act.runOnUiThread { msg = e.message } }
        }.start()
    }
    fun pick(s: JSONObject, all: List<JSONObject>) {
        if (busy != null) return
        busy = "Mi collego a ${s.optString("name").ifEmpty { "PC" }}…"
        msg = null
        Thread {
            try {
                val src = CloudTv.open(act, s, all)
                act.runOnUiThread { busy = null; Access.src = src; act.proceed() }
            } catch (e: Exception) {
                act.runOnUiThread { busy = null; msg = e.message }
            }
        }.start()
    }
    LaunchedEffect(refresh, round) {
        try {
            val (l, fr) = withContext(Dispatchers.IO) { CloudTv.servers(act) }
            list = l
            friends = fr
            // All'apertura si torna da soli sul server di prima (una volta)
            val last = CloudTv.lastSid(act)
            if (!CloudTv.resumed && last.isNotEmpty()) {
                CloudTv.resumed = true
                l.firstOrNull { it.optString("sid") == last }?.let { pick(it, l) }
            }
        } catch (e: Exception) {
            if (e is Remote.CloudError && e.status == 0) {
                // Niente Internet: l'ultimo server con la sessione di prima, altrimenti la ricerca
                if (withContext(Dispatchers.IO) { CloudTv.offline(act) }) { Access.src = "here"; act.proceed() }
                else act.reset(Screen.Connect)
                return@LaunchedEffect
            }
            msg = e.message
            list = list ?: emptyList()
            if (!CloudTv.on(act)) act.reset(Screen.CloudLogin)      // accesso scaduto
        }
    }
    val first = remember { FocusRequester() }
    AuthPage {
        Title("Cosa guardi oggi?", size = 34.sp, lines = 1)
        Txt("Scegli il server: i tuoi e quelli dei tuoi amici", Modifier.padding(top = 8.dp, bottom = 24.dp), size = 18.sp, color = C.ink2)
        friends.filter { it.optString("status") == "received" }.forEach { fr ->
            Row(Modifier.width(620.dp).padding(bottom = 14.dp).clip(RoundedCornerShape(14.dp)).background(C.accent.copy(alpha = 0.16f))
                .padding(horizontal = 18.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Txt("${fr.optString("username")} vuole essere tuo amico", Modifier.weight(1f), size = 17.sp)
                Btn("Rifiuta") { friendTask(null) { CloudTv.declineFriend(act, fr.optInt("id")) } }
                Spacer(Modifier.width(10.dp))
                Btn("Accetta", primary = true) { friendTask("Ora siete amici: i suoi server compaiono qui") { CloudTv.acceptFriend(act, fr.optInt("id")) } }
            }
        }
        val l = list
        if (l == null) Txt("…", color = C.ink3)
        else Nearest {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (l.isEmpty()) Txt("Nessun server nel tuo account: installa BunkerPlex su un PC ed entra lì con il tuo account.",
                    Modifier.width(620.dp), color = C.ink2, lines = 3)
                l.forEachIndexed { i, s ->
                    val friend = s.optString("role") == "friend"
                    val off = s.opt("online") == false
                    val sub = (if (friend) "di " + (s.optJSONObject("owner")?.optString("username") ?: "") else "Il tuo server") +
                        (if (off) " · spento o non raggiungibile" else if (s.optBoolean("local")) " · in casa" else if (s.opt("online") == true) " · acceso" else "")
                    SrvCard(if (i == 0) Modifier.focusRequester(first) else Modifier,
                        if (friend) Ic.friends else Ic.screen, s.optString("name").ifEmpty { "PC" }, sub, !off) { pick(s, l) }
                }
                // Gli amici senza server nell'elenco: non condividono, o sono spenti
                friends.filter { fr -> fr.optString("status") == "ok" &&
                    l.none { it.optString("role") == "friend" && it.optJSONObject("owner")?.optInt("id") == fr.optInt("id") } }.forEach { fr ->
                    SrvCard(Modifier, Ic.friends, fr.optString("username"), "Amico · nessun server condiviso acceso", false) {
                        act.toast("${fr.optString("username")} deve accendere la condivisione con gli amici sul suo server")
                    }
                }
                if (adding) {
                    Row(Modifier.width(620.dp), verticalAlignment = Alignment.CenterVertically) {
                        Field(name, { name = it }, "Nome dell'account del tuo amico") { send() }
                        Spacer(Modifier.width(12.dp))
                        Btn("Invia", primary = true) { send() }
                    }
                } else SrvCard(if (l.isEmpty()) Modifier.focusRequester(first) else Modifier, Ic.plus, "Aggiungi un amico",
                    "Con il nome del suo account: vedrai i suoi server accesi", true, add = true) { adding = true }
                val sent = friends.filter { it.optString("status") == "sent" }.map { it.optString("username") }
                if (sent.isNotEmpty()) Txt("In attesa di risposta: " + sent.joinToString(", "), color = C.ink3, size = 15.sp)
            }
        }
        busy?.let { Txt(it, Modifier.padding(top = 14.dp), color = C.ink2, lines = 2) }
        msg?.let { Txt(it, Modifier.padding(top = 14.dp), color = C.warn, lines = 3) }
        Row(Modifier.padding(top = 24.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Btn("Aggiorna", icon = Ic.restart) { round++ }
            Btn("Amici e tuoi PC fuori casa") { act.remote("friends") }
            Btn("Esci dall'account") {
                Thread { CloudTv.logout(act); act.runOnUiThread { Access.reset(); act.reset(Screen.CloudLogin) } }.start()
            }
        }
    }
    LaunchedEffect(list != null) { if (list != null) repeat(5) { if (runCatching { first.requestFocus() }.isSuccess) return@LaunchedEffect; delay(16) } }
}
