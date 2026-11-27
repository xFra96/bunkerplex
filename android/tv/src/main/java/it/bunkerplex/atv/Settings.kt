package it.bunkerplex.atv

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import it.bunkerplex.tv.Releases
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * Impostazioni dell'app TV, native: chi guarda, il server, la versione dell'app
 * e il suo aggiornamento. Le impostazioni del server (raccolte, sottotitoli,
 * amici...) restano nella pagina web, con «Altre impostazioni».
 */
@Composable
fun SettingsScreen(act: MainActivity, refresh: Int) {
    var state by remember { mutableStateOf<JSONObject?>(null) }
    var info by remember { mutableStateOf<JSONObject?>(null) }
    var msg by remember { mutableStateOf<String?>(null) }
    val up = act.update
    LaunchedEffect(refresh) {
        try {
            val (s, i) = withContext(Dispatchers.IO) { Api.obj("/api/auth/state") to Api.obj("/api/info") }
            state = s
            info = i
            withContext(Dispatchers.IO) { up.refresh() }
        } catch (e: ApiError) {
            if (e.status == 401) act.session401() else msg = e.message
        } catch (e: Exception) {
            msg = "Non riesco a raggiungere BunkerPlex."
        }
    }
    val user = state?.optJSONObject("user")
    // Profilo bambini: niente impostazioni del server ne' gestione (restano cambia profilo e l'app)
    val kids = user?.optBoolean("kids") == true
    // Il profilo scelto qui (con l'account: avatar e colore come in «Chi guarda?»)
    val watcher = user?.takeIf { !it.isNull("watcher") }?.let { u ->
        u.optJSONArray("watchers").objects().firstOrNull { it.optInt("id") == u.optInt("watcher", -1) }
    }
    val first = remember { FocusRequester() }

    Page(act, "settings") {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                .padding(start = D.pad, end = D.pad, top = 36.dp, bottom = 60.dp)
        ) {
            Title("Impostazioni", size = 34.sp, lines = 1)
            msg?.let { Txt(it, Modifier.padding(top = 12.dp), color = C.warn, lines = 2) }

            // ---- Chi guarda
            Section("Chi guarda") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    val name = watcher?.optString("name") ?: user?.optString("name") ?: Api.user ?: ""
                    if (watcher != null) ProfileFace(watcher, 56.dp)
                    else if (name.isNotEmpty()) Face(name, 56.dp)
                    Column(Modifier.padding(start = 18.dp)) {
                        Txt(name.ifEmpty { "…" }, size = 22.sp, weight = FontWeight.Bold)
                        val sub = when {
                            user == null -> ""
                            kids -> "Profilo bambini"
                            user.optString("google").isNotEmpty() -> "Account BunkerPlex con Google (${user.optString("google")})"
                            user.optBoolean("linked") -> "Account BunkerPlex"
                            else -> "Profilo di questo PC"
                        }
                        if (sub.isNotEmpty()) Txt(sub, Modifier.padding(top = 4.dp), color = C.ink2, lines = 2)
                    }
                }
                Row(Modifier.padding(top = 18.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    Btn("Cambia profilo", Modifier.focusRequester(first), Ic.restart) { act.changeProfile() }
                    if (!kids) Btn("Account") { act.go(Screen.Account) }
                }
            }

            // ---- Server
            if (!kids) Section("Server") {
                val i = info
                Line("Nome", i?.optString("name")?.ifEmpty { null } ?: "…")
                Line("Indirizzo", Api.base.removePrefix("http://") + if (Api.base != Api.home) "  (fuori casa)" else "")
                Line("Versione", i?.let { it.optString("release").ifEmpty { it.optString("version") } } ?: "…")
                Row(Modifier.padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    Btn("Cambia server") { act.reset(Screen.Connect) }
                    Btn("Amici e tuoi PC") { act.remote("friends") }
                }
                if (info != null && Releases.serverApi(info) < Releases.MIN_SERVER_API) {
                    Txt("Questo server è più vecchio dell'app: aggiornalo per usare tutte le funzioni.",
                        Modifier.padding(top = 12.dp), color = C.accentText, lines = 2)
                }
                ServerUpdate(act)
            }

            // ---- App
            Section("App") {
                Line("BunkerPlex TV", "versione ${up.myName}")
                val status = up.status()
                when {
                    up.available -> {
                        Txt("È disponibile la versione ${up.latestName.ifEmpty { "nuova" }}." +
                            if (up.needsServer) " Richiede di aggiornare anche il server." else "",
                            Modifier.padding(top = 10.dp), color = C.accentText, weight = FontWeight.SemiBold, lines = 2)
                        Row(Modifier.padding(top = 14.dp)) {
                            Btn("Aggiorna l'app", icon = Ic.restart, primary = true) { up.download() }
                        }
                    }
                    info != null -> Txt("L'app è aggiornata.", Modifier.padding(top = 10.dp), color = C.ink2)
                }
                status?.let { Txt(it, Modifier.padding(top = 12.dp), color = C.ink2, lines = 2) }
            }

            // ---- Le impostazioni del server
            if (kids) Row(Modifier.padding(top = 28.dp)) { Btn("Esci dall'app") { act.finish() } }
            else Section("Server e raccolte") {
                Txt("Raccolte, schede, sottotitoli, amici e dispositivi di questo PC.", color = C.ink2, lines = 2)
                Row(Modifier.padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    Btn("Raccolte") { act.go(Screen.Libraries) }
                    Btn("Schede e sottotitoli") { act.go(Screen.Catalog) }
                    Btn("Amici e dispositivi") { act.go(Screen.Friends) }
                }
                Row(Modifier.padding(top = 14.dp)) { Btn("Esci dall'app") { act.finish() } }
            }
        }
    }
    LaunchedEffect(Unit) {
        repeat(5) { if (runCatching { first.requestFocus() }.isSuccess) return@LaunchedEffect; withFrameNanos { } }
    }
}

@Composable
fun Section(title: String, content: @Composable () -> Unit) {
    Column(
        Modifier.padding(top = 28.dp).width(760.dp).clip(RoundedCornerShape(10.dp)).background(C.surface)
            .padding(horizontal = 26.dp, vertical = 22.dp)
    ) {
        Txt(title.uppercase(), Modifier.padding(bottom = 14.dp), size = 13.sp, color = C.ink3, weight = FontWeight.Bold)
        content()
    }
}

@Composable
fun Line(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Txt(label, Modifier.width(180.dp), color = C.ink2)
        Txt(value, weight = FontWeight.SemiBold)
    }
}

/**
 * Al primo ingresso, se su GitHub c'e' una versione piu' nuova dell'app:
 * la propone (come l'app attuale), una volta sola per avvio.
 */
@Composable
fun NewVersionScreen(act: MainActivity) {
    val up = act.update
    val fr = remember { FocusRequester() }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(Modifier.width(620.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Logo(64.dp)
            Title("Nuova versione dell'app TV", Modifier.padding(top = 22.dp), size = 30.sp, lines = 1)
            Txt("È uscita BunkerPlex TV ${up.latestName.ifEmpty { "nuova" }} (questa è la ${up.myName})." +
                if (up.needsServer) " Richiede di aggiornare anche il server." else "",
                Modifier.padding(top = 10.dp), color = C.ink2, lines = 2)
            Row(Modifier.padding(top = 26.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                Btn("Aggiorna ora", Modifier.focusRequester(fr), Ic.restart, primary = true) { up.download() }
                Btn("Più tardi") { act.back() }
            }
            up.status()?.let { Txt(it, Modifier.padding(top = 16.dp), color = C.ink2, lines = 2) }
        }
    }
    LaunchedEffect(Unit) { runCatching { fr.requestFocus() } }
}

/**
 * Aggiornamenti del server (come Impostazioni → Aggiornamenti sul web): stato,
 * «Aggiorna ora», «Controlla adesso» e l'aggiornamento automatico. Durante
 * l'installazione segue il server finche' non torna su.
 */
@Composable
private fun ServerUpdate(act: MainActivity) {
    var u by remember { mutableStateOf<JSONObject?>(null) }
    var round by remember { mutableStateOf(0) }
    var working by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(round) {
        u = try { withContext(Dispatchers.IO) { Api.obj("/api/update") } } catch (_: Exception) { null }
    }
    // Installazione in corso: si chiede ogni 3 secondi; spento e poi riacceso = fatto
    LaunchedEffect(working) {
        if (working != "install") return@LaunchedEffect
        var down = false
        while (true) {
            kotlinx.coroutines.delay(3000)
            val now = try { withContext(Dispatchers.IO) { Api.obj("/api/update") } } catch (_: Exception) { null }
            if (now == null) { down = true; continue }
            val phase = now.optString("phase")
            if (!down && phase in listOf("installing", "checking", "pc", "restarting")) { if (phase == "restarting") down = true; continue }
            working = null
            u = now
            when {
                phase == "host" -> act.toast("Aggiornamento scaricato: per completarlo rilancia «Installa BunkerPlex» sul computer")
                now.optString("error").isNotEmpty() -> act.toast("Aggiornamento non riuscito: ${now.optString("error")}")
                else -> { act.toast("BunkerPlex è aggiornato"); act.refreshAll() }
            }
            return@LaunchedEffect
        }
    }
    val x = u ?: return
    if (!x.optBoolean("enabled")) {
        Txt("Gli aggiornamenti automatici del server non sono configurati su questo PC.", Modifier.padding(top = 18.dp), color = C.ink3, lines = 2)
        return
    }
    val phase = x.optString("phase")
    val state = when {
        working == "install" -> "Aggiorno BunkerPlex… di solito basta un minuto. Il server si riaccende da solo."
        working == "check" -> "Controllo…"
        x.optBoolean("access", true) == false && !x.isNull("access") -> "Questo PC non ha ancora l'accesso agli aggiornamenti: si dà dal PC, Impostazioni → Aggiornamenti."
        x.optString("error").isNotEmpty() -> x.optString("error")
        phase == "pc" -> "Aggiornamento in corso sul PC…"
        phase == "host" -> "Aggiornamento scaricato: per completarlo rilancia «Installa BunkerPlex» sul computer."
        !x.optBoolean("can_update", true) -> "Solo il proprietario di questo server può aggiornarlo."
        x.optBoolean("available") -> "È disponibile un aggiornamento del server BunkerPlex (sul PC, non dell'app TV)."
        x.optLong("checked_at") > 0 -> "Il server è aggiornato."
        else -> "Il primo controllo parte un paio di minuti dopo l'avvio."
    }
    Txt(state, Modifier.padding(top = 18.dp), color = if (x.optBoolean("available")) C.accentText else C.ink2, lines = 2)
    fun post(path: String, body: JSONObject = JSONObject(), then: () -> Unit) {
        Thread {
            try {
                Api.post(path, body)
                act.runOnUiThread(then)
            } catch (e: Exception) {
                act.runOnUiThread { working = null; act.toast(e.message ?: "Non riuscito") }
            }
        }.start()
    }
    if (working == null) Row(Modifier.padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        val mine = x.optBoolean("can_update", true)
        if (mine && x.optBoolean("available") && phase.isEmpty()) Btn("Aggiorna il server", primary = true) {
            working = "install"
            post("/api/update/install") {}
        }
        Btn("Controlla adesso") {
            working = "check"
            post("/api/update/check") { working = null; round++ }
        }
        val auto = x.optBoolean("auto")
        if (mine) Btn("Aggiornamento automatico: " + if (auto) "attivo" else "spento (manuale)") {
            post("/api/update/auto", JSONObject().put("auto", !auto)) { round++ }
        }
    }
    // Le novita' delle ultime 5 versioni del server, la piu' nuova prima
    val log = x.optJSONArray("changelog")
    if (log != null && log.length() > 0) {
        Txt("Novità delle ultime versioni", Modifier.padding(top = 26.dp), size = 18.sp, weight = FontWeight.Bold)
        val here = x.optString("release")
        for (i in 0 until log.length()) {
            val r = log.optJSONObject(i) ?: continue
            val v = r.optString("version")
            Txt("Versione $v" + (if (v == here) " · installata" else "") +
                    (r.optString("date").takeIf { it.length == 10 }?.let { " · " + it.substring(8) + "/" + it.substring(5, 7) + "/" + it.substring(0, 4) } ?: ""),
                Modifier.padding(top = 12.dp), color = C.ink, weight = FontWeight.Bold)
            val ch = r.optJSONArray("changes")
            if (ch != null) for (j in 0 until ch.length()) {
                Txt("• " + ch.optString(j), Modifier.padding(top = 4.dp, start = 12.dp), color = C.ink2, lines = 3)
            }
        }
    }
}
