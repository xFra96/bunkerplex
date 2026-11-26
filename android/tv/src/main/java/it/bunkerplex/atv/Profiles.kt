package it.bunkerplex.atv

import android.content.Context
import android.view.KeyEvent
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import it.bunkerplex.tv.Remote
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.json.JSONObject

// ---------------------------------------------------------------- Profili dell'account
//
// «Chi guarda?» come Netflix: con l'account i profili stanno nel servizio account e
// sono gli stessi su ogni TV, telefono e server. Si sceglie dopo l'accesso, a ogni
// apertura dell'app, PRIMA del server. Aprendo un profilo (col PIN, se ne ha uno) il
// servizio da' un biglietto che vale 30 giorni: la TV lo tiene per profilo e lo passa
// al server (/api/auth/access, /api/profiles/select), cosi' la sessione nasce gia' sul
// profilo e il PIN si chiede solo qui. Senza account (o senza Internet) resta il
// «Chi guarda?» del server (WatchersScreen), come prima.

object CloudProfiles {
    private fun prefs(ctx: Context) = ctx.getSharedPreferences("bunkerplex", Context.MODE_PRIVATE)

    /** Gli avatar del servizio, disegnati con le emoji ('' = l'iniziale del nome). */
    val emoji = mapOf(
        "cat" to "🐱", "fox" to "🦊", "panda" to "🐼", "frog" to "🐸",
        "lion" to "🦁", "penguin" to "🐧", "octopus" to "🐙", "unicorn" to "🦄",
        "rocket" to "🚀", "ball" to "⚽", "game" to "🎮", "film" to "🎬",
    )

    /** I profili dell'account (il principale, id 0, per primo). */
    fun list(ctx: Context): List<JSONObject> =
        JSONObject(Remote.call(ctx, "GET", "/profiles", null)).optJSONArray("profiles").objects()

    /** Apre un profilo (pin se ne ha uno): {ticket, exp, profile}; CloudError 412/401/429 per il PIN. */
    fun open(ctx: Context, id: Int, pin: String?): JSONObject {
        val body = JSONObject()
        if (pin != null) body.put("pin", pin)
        return JSONObject(Remote.call(ctx, "POST", "/profiles/$id/open", body.toString()))
    }

    /** Il profilo scelto su questa TV (null = mai scelto, o account senza profili). */
    fun current(ctx: Context): JSONObject? =
        prefs(ctx).getString("cloud_profile", null)?.let { runCatching { JSONObject(it) }.getOrNull() }

    /** Il biglietto del profilo, se c'e' e non e' scaduto ("" altrimenti). */
    fun ticket(ctx: Context, id: Int): String {
        val p = prefs(ctx)
        val exp = p.getLong("cloud_ticket_exp_$id", 0L)
        if (exp > 0L && exp < System.currentTimeMillis() / 1000 + 60) return ""
        return p.getString("cloud_ticket_$id", "") ?: ""
    }

    /** Profilo aperto (r = risposta di open): resta scelto, con il suo biglietto. */
    fun save(ctx: Context, r: JSONObject, fallback: JSONObject) {
        val p = r.optJSONObject("profile") ?: fallback
        val id = p.optInt("id")
        prefs(ctx).edit().putString("cloud_profile", p.toString())
            .putString("cloud_ticket_$id", r.optString("ticket"))
            .putLong("cloud_ticket_exp_$id", r.optLong("exp")).apply()
    }

    /** Il profilo scelto e' per bambini. */
    fun kids(ctx: Context) = current(ctx)?.optBoolean("kids") == true

    /** Uscendo dall'account (o entrando con un altro): niente profilo ne' biglietti. */
    fun clear(ctx: Context) {
        val p = prefs(ctx)
        val e = p.edit().remove("cloud_profile")
        p.all.keys.filter { it.startsWith("cloud_ticket_") }.forEach { e.remove(it) }
        e.apply()
    }
}

/** Il colore scelto per il profilo ("#rrggbb"), o null per la tinta calcolata dal nome. */
private fun profileColor(hex: String): Color? =
    if (hex.length == 7 && hex.startsWith("#")) {
        try { Color(android.graphics.Color.parseColor(hex)) } catch (_: Exception) { null }
    } else null

/** Volto di un profilo: l'avatar (emoji) o l'iniziale, sul colore del profilo o sulla sua tinta. */
@Composable
fun ProfileFace(p: JSONObject, size: Dp, modifier: Modifier = Modifier) {
    val name = p.optString("name")
    val h = hue(name).toFloat()
    val custom = profileColor(p.optString("color"))
    val emoji = CloudProfiles.emoji[p.optString("avatar")]
    Box(modifier.size(size).clip(CircleShape).background(custom ?: Color.hsl(h, 0.26f, 0.21f)), contentAlignment = Alignment.Center) {
        if (emoji != null) Txt(emoji, size = (size.value * 0.5f).sp)
        else Txt(name.trim().take(1).uppercase().ifEmpty { "?" }, size = (size.value * 0.42f).sp,
            color = if (custom != null) Color.White else Color.hsl(h, 0.62f, 0.80f), weight = FontWeight.Bold)
    }
}

/** Un profilo di «Chi guarda?»: volto grande, nome, lucchetto se ha il PIN, «Bambini». */
@Composable
fun ProfileTile(p: JSONObject, modifier: Modifier, onClick: () -> Unit) {
    val name = p.optString("name")
    FocusBox(modifier, onClick = onClick) { f ->
        Column(Modifier.width(150.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Box(Modifier.size(132.dp).lift(f, 1.08f).ring(f, CircleShape, 4.dp).padding(8.dp)) {
                ProfileFace(p, 116.dp)
                if (p.optBoolean("pin")) Box(
                    Modifier.align(Alignment.BottomEnd).size(36.dp).clip(CircleShape).background(C.bg),
                    contentAlignment = Alignment.Center,
                ) { Icon(Ic.lock, if (f) C.ink else C.ink2, 20.dp) }
            }
            Txt(name, Modifier.padding(top = 14.dp), size = 19.sp,
                color = if (f) C.ink else C.ink2, weight = if (f) FontWeight.Bold else FontWeight.SemiBold)
            if (p.optBoolean("kids")) Txt("Bambini", Modifier.padding(top = 4.dp), size = 14.sp,
                color = C.accentText, weight = FontWeight.Bold)
        }
    }
}

/**
 * Profilo aperto nel servizio (r = {ticket, exp, profile}). All'apertura dell'app si va
 * alla scelta del server; da «Cambia profilo» si sceglie sul server di adesso, senza
 * ricollegarsi. Dal thread dell'interfaccia.
 */
fun MainActivity.profileChosen(r: JSONObject, p: JSONObject, change: Boolean, fromPin: Boolean, onError: (String) -> Unit) {
    CloudProfiles.save(this, r, p)
    val prof = r.optJSONObject("profile") ?: p
    if (!change) {
        if (fromPin) back()                 // Indietro dall'elenco dei server torna a «Chi guarda?»
        go(Screen.Servers)
        return
    }
    Thread {
        try {
            Api.post("/api/profiles/select", JSONObject().put("id", prof.optInt("id")).put("ticket", r.optString("ticket")))
            Api.user = prof.optString("name").ifEmpty { null }
            Access.whoDone = true
            HomeMemory.server = ""          // la Home in memoria era di un altro profilo
            runOnUiThread { reset(Screen.Home) }
        } catch (e: Exception) {
            runOnUiThread { onError(e.message ?: "Non riuscito") }
        }
    }.start()
}

/**
 * «Cambia profilo» (Impostazioni): con l'account e un server che conosce i profili
 * dell'account, «Chi guarda?» dell'account; altrimenti come prima (si esce e si sceglie
 * sul server).
 */
fun MainActivity.changeProfile() {
    if (!CloudTv.on(this)) { switchProfile(); return }
    Thread {
        val u = try { Api.obj("/api/auth/state").optJSONObject("user") } catch (_: Exception) { null }
        runOnUiThread {
            if (u != null && u.optBoolean("profiles_cloud")) go(Screen.Profiles(change = true, auto = false))
            else switchProfile()
        }
    }.start()
}

// ---------------------------------------------------------------- Chi guarda? (account)

@Composable
fun ProfilesScreen(act: MainActivity, s: Screen.Profiles) {
    var list by remember { mutableStateOf<List<JSONObject>?>(null) }
    var msg by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var round by remember { mutableIntStateOf(0) }
    fun pick(p: JSONObject) {
        if (busy) return
        if (p.optBoolean("pin")) { act.go(Screen.Pin(p.toString(), s.change)); return }
        busy = true
        msg = null
        Thread {
            try {
                val r = CloudProfiles.open(act, p.optInt("id"), null)
                act.runOnUiThread { busy = false; act.profileChosen(r, p, s.change, false) { e -> msg = e } }
            } catch (e: Remote.CloudError) {
                act.runOnUiThread {
                    busy = false
                    if (e.status == 412) act.go(Screen.Pin(p.toString(), s.change)) else msg = e.message
                }
            } catch (e: Exception) {
                act.runOnUiThread { busy = false; msg = e.message }
            }
        }.start()
    }
    LaunchedEffect(round) {
        try {
            val l = withContext(Dispatchers.IO) { CloudProfiles.list(act) }
            // Un solo profilo senza PIN: si salta, come Netflix
            if (s.auto && !s.change && l.size == 1 && !l[0].optBoolean("pin")) {
                val r = try { withContext(Dispatchers.IO) { CloudProfiles.open(act, l[0].optInt("id"), null) } } catch (_: Exception) { null }
                if (r != null) {
                    CloudProfiles.save(act, r, l[0])
                    act.reset(Screen.Servers)
                    return@LaunchedEffect
                }
            }
            msg = null
            list = l
        } catch (e: Remote.CloudError) {
            when {
                // Niente Internet: come prima, il server di prima col suo «Chi guarda?»
                e.status == 0 && s.change -> { Access.whoDone = false; act.reset(Screen.Watchers) }
                e.status == 0 -> {
                    if (withContext(Dispatchers.IO) { CloudTv.offline(act) }) { Access.src = "here"; act.proceed() }
                    else act.reset(Screen.Connect)
                }
                !CloudTv.on(act) -> act.reset(Screen.CloudLogin)                 // accesso scaduto
                e.status == 404 && !s.change -> act.reset(Screen.Servers)        // servizio senza profili
                else -> { msg = e.message; list = list ?: emptyList() }
            }
        } catch (e: Exception) {
            msg = e.message
            list = list ?: emptyList()
        }
    }
    val first = remember { FocusRequester() }
    val btn = remember { FocusRequester() }
    AuthPage {
        Title("Chi guarda?", size = 40.sp, lines = 1)
        Txt("Ognuno ha i suoi visti, la sua ripresa e la sua lista, su ogni TV e server",
            Modifier.padding(top = 8.dp), size = 18.sp, color = C.ink2)
        val l = list
        if (l == null) Txt("…", Modifier.padding(top = 40.dp), color = C.ink3)
        else if (l.isNotEmpty()) {
            val cur = CloudProfiles.current(act)?.optInt("id", -1) ?: -1
            val target = if (l.any { it.optInt("id") == cur }) cur else l.first().optInt("id")
            Nearest {
                Row(
                    Modifier.padding(top = 40.dp).horizontalScroll(rememberScrollState()).padding(horizontal = 40.dp, vertical = 10.dp),
                    horizontalArrangement = Arrangement.spacedBy(36.dp),
                ) {
                    l.forEach { p ->
                        ProfileTile(p, if (p.optInt("id") == target) Modifier.focusRequester(first) else Modifier) { pick(p) }
                    }
                }
            }
            LaunchedEffect(l.size) { repeat(5) { if (runCatching { first.requestFocus() }.isSuccess) return@LaunchedEffect; delay(16) } }
        }
        if (busy) Txt("Apro il profilo…", Modifier.padding(top = 14.dp), color = C.ink2)
        msg?.let { Txt(it, Modifier.padding(top = 14.dp), color = C.warn, lines = 2) }
        Txt("I profili si aggiungono e si cambiano dal telefono o dal PC", Modifier.padding(top = 26.dp), size = 15.sp, color = C.ink3)
        Row(Modifier.padding(top = 18.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            if (l != null && l.isEmpty()) Btn("Riprova", Modifier.focusRequester(btn), Ic.restart, primary = true) { round++ }
            if (s.change) Btn("Indietro") { act.back() }
            else Btn("Esci dall'account") {
                Thread { CloudTv.logout(act); act.runOnUiThread { Access.reset(); act.reset(Screen.CloudLogin) } }.start()
            }
        }
    }
    if (list?.isEmpty() == true) AutoFocus(btn)
}

// ---------------------------------------------------------------- PIN

/** Il PIN del profilo: 4 cifre col tastierino sullo schermo o con i tasti numerici del telecomando. */
@Composable
fun PinScreen(act: MainActivity, s: Screen.Pin) {
    val p = remember(s) { runCatching { JSONObject(s.json) }.getOrDefault(JSONObject()) }
    var pin by remember { mutableStateOf("") }
    var msg by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    fun send(code: String) {
        busy = true
        msg = null
        Thread {
            try {
                val r = CloudProfiles.open(act, p.optInt("id"), code)
                act.runOnUiThread { busy = false; act.profileChosen(r, p, s.change, true) { e -> msg = e; pin = "" } }
            } catch (e: Exception) {
                // 401 PIN sbagliato, 429 troppi errori (5 minuti), 412 manca il PIN
                act.runOnUiThread { busy = false; pin = ""; msg = e.message ?: "Non riuscito" }
            }
        }.start()
    }
    fun digit(d: Char) {
        if (busy || pin.length >= 4) return
        pin += d
        if (pin.length == 4) send(pin)
    }
    fun erase() {
        if (!busy && pin.isNotEmpty()) pin = pin.dropLast(1)
    }
    val first = remember { FocusRequester() }
    Box(
        Modifier.fillMaxSize().background(C.bg).onPreviewKeyEvent { ev ->
            if (ev.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
            val k = ev.nativeKeyEvent.keyCode
            when (k) {
                in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> { digit('0' + (k - KeyEvent.KEYCODE_0)); true }
                in KeyEvent.KEYCODE_NUMPAD_0..KeyEvent.KEYCODE_NUMPAD_9 -> { digit('0' + (k - KeyEvent.KEYCODE_NUMPAD_0)); true }
                KeyEvent.KEYCODE_DEL -> { erase(); true }
                else -> false
            }
        },
        contentAlignment = Alignment.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.width(400.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                ProfileFace(p, 104.dp)
                Title(p.optString("name"), Modifier.padding(top = 16.dp), size = 30.sp, lines = 1)
                Txt("Scrivi il PIN del profilo", Modifier.padding(top = 6.dp), size = 18.sp, color = C.ink2)
                Row(Modifier.padding(top = 26.dp), horizontalArrangement = Arrangement.spacedBy(18.dp)) {
                    repeat(4) { i ->
                        Box(Modifier.size(22.dp).clip(CircleShape).background(if (i < pin.length) C.ink else C.surface2))
                    }
                }
                if (busy) Txt("Controllo…", Modifier.padding(top = 18.dp), color = C.ink2)
                msg?.let { Txt(it, Modifier.padding(top = 18.dp), color = C.warn, lines = 2) }
            }
            Column(Modifier.padding(start = 40.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                listOf("123", "456", "789").forEach { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        row.forEach { d ->
                            PadKey(d.toString(), if (d == '1') Modifier.focusRequester(first) else Modifier) { digit(d) }
                        }
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    PadKey("Annulla") { act.back() }
                    PadKey("0") { digit('0') }
                    PadKey("Cancella") { erase() }
                }
            }
        }
    }
    AutoFocus(first)
}

@Composable
private fun PadKey(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Focusable(modifier.size(96.dp, 66.dp), RoundedCornerShape(12.dp), scale = 1.06f, onClick = onClick) { f ->
        Box(Modifier.fillMaxSize().background(if (f) C.ink else C.surface), contentAlignment = Alignment.Center) {
            Txt(label, size = if (label.length == 1) 28.sp else 15.sp, color = if (f) C.bg else C.ink, weight = FontWeight.Bold)
        }
    }
}
