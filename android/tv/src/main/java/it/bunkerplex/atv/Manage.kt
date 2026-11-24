package it.bunkerplex.atv

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
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
import org.json.JSONArray
import org.json.JSONObject
import java.text.DateFormat
import java.util.Date
import java.util.Locale

/**
 * Le impostazioni del server, native: Raccolte (con la scelta delle cartelle del PC),
 * Schede e sottotitoli, Amici e dispositivi. Le stesse API e gli stessi testi del web.
 */

/** Un'operazione sul server: in sottofondo, poi un messaggio e le pagine si ricaricano. */
fun MainActivity.task(done: String? = null, then: (() -> Unit)? = null, work: () -> Unit) {
    Thread {
        try {
            work()
            runOnUiThread {
                done?.let { toast(it) }
                if (then != null) then() else refreshAll()
            }
        } catch (e: Exception) {
            toast(e.message ?: "Non riuscito")
        }
    }.start()
}

/** Carica qualcosa dal server per una pagina; 401 riporta a «Chi guarda?». */
@Composable
private fun <T> loadPage(act: MainActivity, refresh: Int, key: Any = Unit, fetch: () -> T): Pair<T?, String?> {
    var data by remember(key) { mutableStateOf<T?>(null) }
    var error by remember(key) { mutableStateOf<String?>(null) }
    LaunchedEffect(key, refresh) {
        try {
            data = withContext(Dispatchers.IO) { fetch() }
            error = null
        } catch (e: ApiError) {
            if (e.status == 401) act.session401() else error = e.message
        } catch (e: Exception) {
            error = "Non riesco a raggiungere BunkerPlex."
        }
    }
    return data to error
}

/** Pagina delle impostazioni con il menu a sinistra, titolo e testo sotto. */
@Composable
private fun SettingsPage(act: MainActivity, title: String, sub: String?, error: String?, content: @Composable ColumnScope.() -> Unit) {
    Page(act, "settings") {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                .padding(start = D.pad, end = D.pad, top = 36.dp, bottom = 60.dp)
        ) {
            Title(title, size = 34.sp, lines = 1)
            sub?.let { Txt(it, Modifier.padding(top = 8.dp).width(820.dp), color = C.ink2, lines = 4, lineHeight = 24.sp) }
            error?.let { Txt(it, Modifier.padding(top = 12.dp), color = C.warn, lines = 2) }
            content()
        }
    }
}

/** Una riga dentro un riquadro: nome, stato sotto, pulsanti a destra. */
@Composable
private fun Entry(title: String, sub: String, ok: Boolean? = null, buttons: @Composable () -> Unit = {}) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 6.dp).clip(RoundedCornerShape(8.dp)).background(C.surface2)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Txt(title, weight = FontWeight.SemiBold, lines = 2)
            Row(Modifier.padding(top = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                if (ok != null) Txt("● ", size = 13.sp, color = if (ok) C.accentText else C.warn)
                Txt(sub, size = 14.sp, color = C.ink2, lines = 3)
            }
        }
        Row(Modifier.padding(start = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) { buttons() }
    }
}

@Composable
private fun Note(text: String, color: androidx.compose.ui.graphics.Color = C.ink2) =
    Txt(text, Modifier.padding(top = 10.dp), color = color, lines = 5, lineHeight = 23.sp)

@Composable
private fun Buttons(content: @Composable () -> Unit) =
    Row(Modifier.padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) { content() }

private fun day(sec: Long) = if (sec <= 0) "" else
    DateFormat.getDateInstance(DateFormat.LONG, Locale.ITALIAN).format(Date(sec * 1000))

private fun JSONArray?.size() = this?.length() ?: 0

// ================================================================ Raccolte

@Composable
fun LibrariesScreen(act: MainActivity, refresh: Int) {
    val (data, error) = loadPage(act, refresh) {
        Triple(Api.arr("/api/libraries").objects(), Api.obj("/api/auth/state"), Unit)
    }
    val first = remember { FocusRequester() }
    SettingsPage(act, "Raccolte",
        "Ogni raccolta è una voce del menu (per esempio Film o Serie TV), con una o più cartelle di questo PC. BunkerPlex legge soltanto: non modifica né cancella mai i tuoi file.",
        error) {
        val (libs, state) = data?.let { it.first to it.second } ?: return@SettingsPage
        val many = state.optJSONArray("profiles").size() > 1
        val linked = state.optJSONObject("user")?.optBoolean("linked") == true
        Buttons {
            Btn("+ Aggiungi raccolta", Modifier.focusRequester(first), primary = true) { act.go(Screen.LibName(null, "")) }
        }
        if (libs.isEmpty()) Note("Ancora nessuna raccolta su questo PC.")
        libs.forEach { l -> Library(act, l, many) }
        if (linked) Section("Raccolte nel tuo account") {
            val away = libs.filter { it.optBoolean("mine", true) }.sumOf { it.optJSONArray("missing").size() }
            Note("Nomi e cartelle delle tue raccolte seguono il tuo account: sugli altri PC le ritrovi già create, e le cartelle con lo stesso percorso si collegano da sole." +
                (if (away > 0) " Qui ${if (away == 1) "manca una cartella che sta" else "mancano $away cartelle che stanno"} su altri PC." else ""))
            Note("Se l'elenco online non ti torna, puoi rimetterlo uguale a quello di questo PC. Visti, punti di ripresa e La mia lista non cambiano.")
            Buttons {
                Btn("Sovrascrivi l'account con le raccolte di questo PC") {
                    act.go(Screen.Confirm("Le raccolte del tuo account diventano quelle di questo PC. Visti, punti di ripresa e La mia lista non cambiano.",
                        "Sì, sovrascrivi l'account") {
                        act.task("Fatto: l'account ha le raccolte di questo PC") { Api.post("/api/libraries/push-local", JSONObject()) }
                    })
                }
            }
        }
    }
    AutoFocus(first)
}

@Composable
private fun Library(act: MainActivity, l: JSONObject, many: Boolean) {
    val id = l.optInt("id")
    val name = l.optString("name")
    val what = listOfNotNull(
        l.optInt("movies").takeIf { it > 0 }?.let { "$it film" },
        l.optInt("shows").takeIf { it > 0 }?.let { "$it serie" },
    ).joinToString(" · ").ifEmpty { "ancora vuota" }
    if (!l.optBoolean("mine", true)) {
        Section(name) { Note("$what · condivisa da un altro account di questo PC") }
        return
    }
    Section(name) {
        Txt(what + if (many && l.optBoolean("shared")) " · la vedono anche gli altri account di questo PC" else "", color = C.ink2)
        Buttons {
            Btn("+ Cartella") { act.go(Screen.Browse(id, name, "", "")) }
            Btn("Aggiorna") {
                act.go(Screen.Choice("Aggiorna «$name»", listOf(
                    "Cerca file nuovi o tolti" to { act.task("Controllo le cartelle…") { Api.post("/api/scan", JSONObject()) } },
                    "Riscarica locandine e schede" to {
                        act.task("Riscarico le schede: ci vuole qualche minuto") { Api.post("/api/refresh", JSONObject().put("library", id)) }
                    },
                )))
            }
            Btn("Rinomina") { act.go(Screen.LibName(id, name)) }
            if (many) Btn(if (l.optBoolean("shared")) "Non condividere" else "Condividi") {
                val on = !l.optBoolean("shared")
                act.task(if (on) "Ora la vedono anche gli altri account di questo PC" else "Ora la vedi solo tu") {
                    Api.call("PATCH", "/api/libraries/$id", JSONObject().put("shared", on))
                }
            }
            Btn("Elimina") {
                act.go(Screen.Confirm("Eliminare la raccolta «$name»? I file restano sul PC.", "Sì, elimina") {
                    act.task("Raccolta eliminata") { Api.call("DELETE", "/api/libraries/$id") }
                })
            }
        }
        val folders = l.optJSONArray("folders").objects()
        val missing = l.optJSONArray("missing").strings()
        Column(Modifier.padding(top = 10.dp)) {
            folders.forEach { f ->
                val online = f.optBoolean("online")
                val moved = f.str("moved_to")
                Entry(
                    f.optString("display"),
                    if (online) "${f.optInt("count")} video"
                    else (if (moved != null) "il percorso è cambiato: ora la cartella è in ${f.optString("moved_display")}"
                    else "non raggiungibile (disco scollegato?)") + " · ${f.optInt("count")} video in catalogo",
                    online,
                ) {
                    if (moved != null) Btn("Usa il nuovo percorso", primary = true) {
                        act.task("Percorso aggiornato") {
                            Api.post("/api/libraries/$id/folders/relocate", JSONObject().put("path", f.optString("path")).put("to", moved))
                        }
                    }
                    Btn("Togli") {
                        act.go(Screen.Confirm("Togliere ${f.optString("display")} dalla raccolta? I file restano sul PC.", "Sì, toglila") {
                            act.task("Cartella tolta") {
                                Api.post("/api/libraries/$id/folders/remove", JSONObject().put("path", f.optString("path")))
                            }
                        })
                    }
                }
            }
            missing.forEach { m ->
                Entry(m, "Su un altro PC del tuo account: qui non la trovo", false) {
                    Btn("Scegli dove sta qui") { act.go(Screen.Browse(id, name, "", m)) }
                    Btn("Togli dall'account") {
                        act.go(Screen.Confirm("Togliere $m dalla raccolta «$name» su tutti i PC del tuo account? I file non si toccano.", "Sì, toglila dall'account") {
                            act.task("Cartella tolta dall'account") {
                                Api.post("/api/libraries/$id/missing/remove", JSONObject().put("display", m))
                            }
                        })
                    }
                }
            }
            if (folders.isEmpty() && missing.isEmpty()) Note("Nessuna cartella: premi «+ Cartella».")
        }
    }
}

/** Nuova raccolta (id null) o nome nuovo di una raccolta. */
@Composable
fun LibNameScreen(act: MainActivity, s: Screen.LibName) {
    var name by remember { mutableStateOf(s.name) }
    var msg by remember { mutableStateOf<String?>(null) }
    val fr = remember { FocusRequester() }
    val creating = s.id == null
    fun save() {
        val n = name.trim()
        if (n.isEmpty()) { msg = "Scrivi un nome per la raccolta"; return }
        Thread {
            try {
                if (creating) {
                    val r = JSONObject(Api.post("/api/libraries", JSONObject().put("name", n)).first)
                    act.runOnUiThread {
                        act.toast("Raccolta creata: ora scegli le cartelle")
                        act.back()
                        act.go(Screen.Browse(r.optInt("id"), n, "", ""))
                    }
                } else {
                    Api.call("PATCH", "/api/libraries/${s.id}", JSONObject().put("name", n))
                    act.runOnUiThread { act.toast("Nome cambiato"); act.back(); act.refreshAll() }
                }
            } catch (e: Exception) {
                act.runOnUiThread { msg = e.message }
            }
        }.start()
    }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        Column(Modifier.width(640.dp).padding(top = 70.dp)) {
            Title(if (creating) "Nuova raccolta" else "Rinomina raccolta", size = 32.sp, lines = 1)
            Txt(if (creating) "Dai un nome alla raccolta: sarà la voce che vedi nel menu. Subito dopo scegli le cartelle da cui prendere i video."
                else "Il nuovo nome compare subito nel menu e nella Home.",
                Modifier.padding(top = 8.dp, bottom = 22.dp), color = C.ink2, lines = 3)
            Field(name, { name = it }, "Il nome che vuoi", Modifier.focusRequester(fr)) { save() }
            msg?.let { Txt(it, Modifier.padding(top = 12.dp), color = C.warn, lines = 2) }
            if (creating) {
                Txt("Oppure parti da un'idea:", Modifier.padding(top = 20.dp), color = C.ink2)
                Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    listOf("Film", "Serie TV", "Cartoni", "Documentari", "Anime").forEach { idea -> Btn(idea) { name = idea } }
                }
            }
            Buttons {
                Btn(if (creating) "Crea e scegli le cartelle" else "Salva", primary = true) { save() }
                Btn("Annulla") { act.back() }
            }
        }
    }
    AutoFocus(fr)
}

/** Scelta di una cartella del PC per una raccolta (come «+ Cartella» sul web). */
@Composable
fun BrowseScreen(act: MainActivity, s: Screen.Browse) {
    val (d, error) = loadPage(act, 0, s.path) {
        Api.obj("/api/browse?path=" + java.net.URLEncoder.encode(s.path, "UTF-8"))
    }
    val first = remember(s.path) { FocusRequester() }
    fun open(path: String) {
        act.back()
        act.go(s.copy(path = path))
    }
    SettingsPage(act, "Cartelle di «${s.libName}»",
        (if (s.replace.isNotEmpty()) "Sugli altri PC questa raccolta usa ${s.replace}. Scegli dove stanno qui gli stessi video. " else "") +
            "Entra nella cartella che contiene i video (vanno bene anche le sottocartelle) e premi «Usa questa cartella».",
        error) {
        val x = d ?: return@SettingsPage
        Txt("Sei in: " + x.optString("display") + (x.optInt("videos").takeIf { it > 0 }?.let { " · $it video qui dentro" } ?: ""),
            Modifier.padding(top = 16.dp), weight = FontWeight.SemiBold, lines = 2)
        Buttons {
            if (!x.optBoolean("root")) Btn("Usa questa cartella", Modifier.focusRequester(first), Ic.check, primary = true) {
                act.task(then = { act.back(); act.refreshAll() }) {
                    val r = JSONObject(Api.post("/api/libraries/${s.lib}/folders",
                        JSONObject().put("path", x.optString("path")).put("replace", s.replace)).first)
                    val added = r.optJSONArray("added")
                    act.toast(if (added.size() > 0) "Aggiunta ${added!!.optString(0)}: la sto leggendo" else "Questa cartella c'era già")
                }
            }
            x.str("parent")?.let { p -> Btn("Cartella superiore") { open(p) } }
            Btn("Fine") { act.back() }
        }
        val dirs = x.optJSONArray("dirs").objects()
        if (dirs.isEmpty()) Note(if (x.optBoolean("root"))
            "Non vedo i dischi del computer. Rilancia «Installa BunkerPlex»: è lui a collegarli a Docker, una volta per tutte."
            else "Qui dentro non ci sono altre cartelle.")
        Column(Modifier.padding(top = 14.dp).width(820.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            dirs.forEachIndexed { n, dir ->
                val m = if (n == 0 && x.optBoolean("root")) Modifier.focusRequester(first) else Modifier
                Btn(dir.optString("name"), m.fillMaxWidth()) { open(dir.optString("path")) }
            }
        }
    }
    AutoFocus(first)
}

// ================================================================ Schede e sottotitoli

@Composable
fun CatalogScreen(act: MainActivity, refresh: Int) {
    var tick by remember { mutableStateOf(0) }
    val (data, error) = loadPage(act, refresh + tick) { Api.obj("/api/info") to Api.obj("/api/auth/state") }
    // Durante la lettura dei titoli la pagina si aggiorna da sola
    LaunchedEffect(data?.first?.optBoolean("scanning")) {
        if (data?.first?.optBoolean("scanning") == true) { delay(3000); tick++ }
    }
    var tmdb by remember { mutableStateOf("") }
    var osKey by remember { mutableStateOf("") }
    var osUser by remember { mutableStateOf<String?>(null) }
    var osPass by remember { mutableStateOf("") }
    val first = remember { FocusRequester() }
    val i = data?.first
    SettingsPage(act, "Schede e sottotitoli",
        i?.let {
            if (it.optBoolean("tmdb")) "Locandine, trame, cast, generi e voti si scaricano da soli" + (it.str("tmdb_hint")?.let { h -> " (chiave $h)" } ?: "") + "."
            else "Schede non attive: i film compaiono con un fotogramma, senza trama né cast."
        }, error) {
        if (i == null) return@SettingsPage
        val inAccount = data!!.second.optJSONObject("user")?.optBoolean("linked") == true
        Section("Catalogo") {
            Row(horizontalArrangement = Arrangement.spacedBy(36.dp)) {
                Stat(i.optInt("movies"), "film")
                Stat(i.optInt("shows"), "serie TV")
                Stat(i.optInt("episodes"), "episodi")
                if (i.optBoolean("tmdb") && i.optInt("unmatched") > 0) Stat(i.optInt("unmatched"), "film senza scheda")
            }
            val status = when {
                i.optBoolean("scanning") -> i.optString("message").ifEmpty { "Leggo le cartelle" }.replace("...", "…")
                i.optString("message").isNotEmpty() -> i.optString("message")
                i.optLong("last_scan") > 0 -> "Ultimo controllo: " +
                    DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT, Locale.ITALIAN).format(Date(i.optLong("last_scan") * 1000))
                else -> ""
            }
            if (status.isNotEmpty()) Note(status, if (i.optBoolean("scanning")) C.accentText else C.ink2)
            Buttons {
                Btn("Cerca file nuovi", Modifier.focusRequester(first)) {
                    act.task("Controllo le cartelle…") { Api.post("/api/scan", JSONObject()) }
                }
                Btn("Riscarica tutte le schede") {
                    act.go(Screen.Confirm("Riscaricare locandine e schede di tutto il catalogo?", "Sì, riscarica tutto") {
                        act.task("Riscarico le schede: ci vuole qualche minuto") { Api.post("/api/refresh", JSONObject().put("all", true)) }
                    })
                }
            }
        }
        if (i.optBoolean("tmdb")) i.optJSONObject("catalog")?.let { c ->
            Section("Aggiornamento automatico") {
                Note("Le schede si ricontrollano da sole, poche alla volta e mai mentre qualcuno guarda. Le correzioni fatte con «Correggi scheda» e le tue locandine restano.")
                Column(Modifier.padding(top = 10.dp)) {
                    Line("Novità da TMDB", c.optLong("changes_at").let { if (it > 0) "controllate il ${day(it)}" else "non ancora controllate" })
                    Line("Schede aggiornate", "${c.optInt("refreshed")} negli ultimi 7 giorni" +
                        (c.optInt("waiting").takeIf { it > 0 }?.let { " · $it in attesa" } ?: ""))
                    Line("Serie in corso", c.optInt("ongoing").let { if (it > 0) "$it" else "nessuna" })
                    val nomatch = i.optInt("unmatched") + c.optInt("unmatched_shows")
                    Line("Senza scheda", if (nomatch > 0) "$nomatch · riprovo da solo" else "nessuno")
                }
            }
        }
        Section("Chiave TMDB") {
            Note("Serve una chiave gratuita di themoviedb.org: crea un account, poi Impostazioni → API → copia la «Chiave API» e scrivila qui." +
                (if (inAccount) " Resta nel tuo account: sugli altri PC dove entri non va rimessa." else ""))
            Box(Modifier.padding(top = 14.dp)) {
                Field(tmdb, { tmdb = it }, if (i.optBoolean("tmdb")) "Nuova chiave API (per cambiarla)" else "Chiave API TMDB") {}
            }
            Buttons {
                Btn("Salva la chiave") {
                    if (tmdb.isBlank()) act.toast("Scrivi prima la chiave")
                    else act.task("Chiave salvata: scarico le schede") {
                        Api.post("/api/settings", JSONObject().put("tmdb_key", tmdb.trim()))
                    }
                }
            }
        }
        Section("Sottotitoli da internet") {
            Note(if (i.optBoolean("subs_online"))
                "Attivi" + (i.str("subs_user")?.let { " con l'account $it" } ?: " senza account (pochi download al giorno)") + ": nel film apri le opzioni → «Cerca sottotitoli su internet»."
                else "Non attivi. Con una chiave gratuita di OpenSubtitles scarichi i sottotitoli dalle opzioni del film.")
            Note("Crea un account su opensubtitles.com, poi Profilo → «API consumers» → crea una chiave e scrivila qui. Nome utente e password sono facoltativi ma alzano il limite giornaliero." +
                if (inAccount) " Restano nel tuo account." else " Restano solo su questo PC.")
            val user = osUser ?: i.optString("subs_user")
            Column(Modifier.padding(top = 14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Field(osKey, { osKey = it }, if (i.optBoolean("subs_online")) "Chiave API (vuoto: tieni quella di adesso)" else "Chiave API OpenSubtitles") {}
                Field(user, { osUser = it }, "Nome utente (facoltativo)") {}
                Field(osPass, { osPass = it }, "Password (facoltativa)", secret = true) {}
            }
            Buttons {
                Btn("Salva", primary = true) {
                    act.task("Fatto: ora puoi cercare i sottotitoli dai film") {
                        Api.post("/api/settings/opensubtitles",
                            JSONObject().put("key", osKey.trim()).put("user", user.trim()).put("password", osPass))
                    }
                }
                if (i.optBoolean("subs_online")) Btn("Disattiva") {
                    act.task("Sottotitoli da internet disattivati") {
                        Api.post("/api/settings/opensubtitles", JSONObject().put("remove", true))
                    }
                }
            }
        }
    }
    AutoFocus(first)
}

@Composable
private fun Stat(n: Int, label: String) {
    Column {
        Txt("$n", size = 30.sp, weight = FontWeight.Bold)
        Txt(label, color = C.ink2)
    }
}

// ================================================================ Amici e dispositivi

private class FriendsData(
    val state: JSONObject, val sharing: JSONObject?, val af: JSONObject?,
    val devices: JSONObject?, val network: JSONObject?, val friends: JSONObject?,
)

private val QUALITIES = listOf("720" to "720p (consigliata)", "1080" to "1080p", "orig" to "Originale")

@Composable
fun FriendsScreen(act: MainActivity, refresh: Int) {
    val (data, error) = loadPage(act, refresh) {
        val state = Api.obj("/api/auth/state")
        val cloud = state.optBoolean("cloud")
        fun opt(path: String) = try { Api.obj(path) } catch (e: ApiError) { if (e.status == 401) throw e else null } catch (_: Exception) { null }
        FriendsData(state, opt("/api/sharing"), if (cloud) opt("/api/account-friends") else null,
            if (cloud) opt("/api/devices") else null, opt("/api/network"), opt("/api/friends"))
    }
    var friendName by remember { mutableStateOf("") }
    var pcName by remember { mutableStateOf<String?>(null) }
    val first = remember { FocusRequester() }
    SettingsPage(act, "Amici e dispositivi",
        "Le raccolte dei tuoi amici e dei tuoi altri PC, a casa e fuori. Si guarda soltanto: nessuno modifica la libreria dell'altro.",
        error) {
        val d = data ?: return@SettingsPage
        val af = d.af
        // ---- Amici dell'account
        if (af != null || d.state.optBoolean("cloud")) Section("I tuoi amici") {
            when {
                af == null || !af.optBoolean("linked") -> {
                    Note("Con un account aggiungi gli amici scrivendo il nome del loro account: niente indirizzi né password da scambiarsi.")
                    Buttons { Btn("Entra con un account", Modifier.focusRequester(first)) { act.go(Screen.Account) } }
                }
                af.has("supported") && !af.optBoolean("supported") ->
                    Note("Il servizio account va aggiornato per gli amici dell'account.", C.warn)
                else -> {
                    val list = af.optJSONArray("friends").objects()
                    val received = list.filter { it.optString("status") == "received" }
                    val ok = list.filter { it.optString("status") == "ok" }
                    val sent = list.filter { it.optString("status") == "sent" }
                    received.forEach { f ->
                        Entry(f.optString("username"), "vuole essere tuo amico") {
                            Btn("Accetta", primary = true) {
                                act.task("Ora siete amici: le sue raccolte compaiono tra poco") { Api.post("/api/account-friends/${f.optString("id")}/accept", JSONObject()) }
                            }
                            Btn("Rifiuta") { act.task { Api.call("DELETE", "/api/account-friends/${f.optString("id")}") } }
                        }
                    }
                    if (ok.isEmpty()) Note("Ancora nessun amico.")
                    ok.forEach { f ->
                        val servers = f.optJSONArray("servers").objects()
                        val s = if (servers.isEmpty()) "non condivide le sue raccolte" else servers.joinToString(" · ") { x ->
                            val where = x.optString("name").ifEmpty { "il suo PC" }
                            when {
                                x.has("online") && !x.isNull("online") && !x.optBoolean("online") -> "$where: ${x.optString("error").ifEmpty { "non raggiungibile" }}"
                                x.optBoolean("online") -> "$where: collegato"
                                else -> "$where: collegamento in corso…"
                            }
                        }
                        Entry(f.optString("username"), s) {
                            Btn("Togli") {
                                act.go(Screen.Confirm("Togliere ${f.optString("username")} dai tuoi amici? Non vedrete più le raccolte l'uno dell'altro.", "Sì, togli") {
                                    act.task { Api.call("DELETE", "/api/account-friends/${f.optString("id")}") }
                                })
                            }
                        }
                    }
                    sent.forEach { f ->
                        Entry(f.optString("username"), "richiesta mandata: aspetta che accetti") {
                            Btn("Annulla") { act.task { Api.call("DELETE", "/api/account-friends/${f.optString("id")}") } }
                        }
                    }
                    Txt("Aggiungi un amico: il nome del suo account BunkerPlex", Modifier.padding(top = 16.dp, bottom = 8.dp), color = C.ink2)
                    Field(friendName, { friendName = it }, "Nome dell'account", Modifier.focusRequester(first)) {}
                    Buttons {
                        Btn("Manda la richiesta", primary = true) {
                            if (friendName.isBlank()) act.toast("Scrivi il nome dell'account del tuo amico")
                            else act.task(then = { friendName = ""; act.refreshAll() }) {
                                val r = JSONObject(Api.post("/api/account-friends", JSONObject().put("username", friendName.trim())).first)
                                act.toast(if (r.optString("status") == "ok") "Ora tu e ${r.optString("username")} siete amici"
                                    else "Richiesta mandata a ${r.optString("username")}: aspetta che accetti")
                            }
                        }
                    }
                    val sharing = af.optBoolean("sharing")
                    Buttons {
                        Btn("Condividi le tue raccolte con i tuoi amici: " + if (sharing) "sì" else "no") {
                            act.task(if (sharing) "Condivisione spenta" else "Apro la porta per gli amici…") {
                                Api.post("/api/account-friends/share", JSONObject().put("on", !sharing))
                            }
                        }
                    }
                    Note(when {
                        !sharing -> "Spenta: i tuoi amici non vedono le tue raccolte (tu vedi le loro)."
                        af.optBoolean("published") -> "Attiva: i tuoi amici vedono le tue raccolte."
                        else -> "Attiva, ma gli amici non ti raggiungono ancora."
                    })
                    if (sharing) {
                        Txt("Nome di questo PC (gli amici lo vedono se condividi da più PC)", Modifier.padding(top = 16.dp, bottom = 8.dp), color = C.ink2)
                        val pc = pcName ?: af.optString("pc")
                        Field(pc, { pcName = it }, "Nome di questo PC") {}
                        Buttons {
                            Btn("Salva il nome") {
                                act.task(then = { pcName = null; act.refreshAll() }) {
                                    val r = JSONObject(Api.post("/api/pc-name", JSONObject().put("name", pc)).first)
                                    act.toast("Questo PC ora si chiama «${r.optString("pc")}»")
                                }
                            }
                        }
                    }
                    Note("Gli amici vedono solo le tue raccolte e possono soltanto guardare. Il collegamento è cifrato.", C.ink3)
                }
            }
        }
        // ---- I tuoi PC
        if (af != null && af.optBoolean("linked") && !(af.has("supported") && !af.optBoolean("supported")) && af.has("mine")) Section("I tuoi PC") {
            val self = af.optBoolean("self_reach")
            if (self) {
                val mine = af.optJSONArray("mine").objects()
                if (mine.isEmpty()) Note("Nessun altro PC acceso con il tuo account, per ora.")
                mine.forEach { m ->
                    val online = if (m.isNull("online")) null else m.optBoolean("online")
                    Entry(m.optString("name").ifEmpty { "Il tuo altro PC" }, when (online) {
                        false -> m.optString("error").ifEmpty { "spento o non raggiungibile" }
                        true -> "collegato" + when (m.optString("route")) { "lan" -> " dalla rete di casa"; "tailscale" -> " da Tailscale"; else -> "" }
                        null -> "collegamento in corso…"
                    }, online)
                }
            }
            Buttons {
                Btn("Raggiungi le tue raccolte dagli altri tuoi PC: " + if (self) "sì" else "no") {
                    act.task(if (self) "Scollego i tuoi PC…" else "Collego i tuoi PC…") {
                        Api.post("/api/account-friends/self", JSONObject().put("on", !self))
                    }
                }
            }
            Note("In casa si passa dalla rete di casa (più veloce, anche senza Internet); fuori casa da Tailscale, cifrato.", C.ink3)
        }
        // ---- Dispositivi
        d.devices?.takeIf { it.has("devices") }?.let { dv ->
            val limit = dv.optInt("limit", 4).takeIf { it > 0 } ?: 4
            val list = dv.optJSONArray("devices").objects()
            Section("I tuoi dispositivi · ${list.size} di $limit") {
                if (dv.optBoolean("waiting")) Note("Questo PC non è entrato nella rete di BunkerPlex: l'account ha già $limit dispositivi. Scegli quale togliere.", C.warn)
                if (list.isEmpty()) Note("Nessun dispositivo nella rete, per ora.")
                list.forEach { x ->
                    val id = x.optString("id")
                    Entry(x.optString("label") + if (x.optBoolean("this")) " · questo PC" else "",
                        (if (x.optString("kind") == "pc") "PC" else "App") + " · " + if (x.optBoolean("online")) "collegato" else "spento",
                        x.optBoolean("online")) {
                        if (!x.optBoolean("this")) {
                            if (dv.optBoolean("waiting")) Btn("Togli e fai entrare questo PC") {
                                act.task("Fatto: questo PC è nella rete di BunkerPlex") { Api.post("/api/devices/replace", JSONObject().put("id", id)) }
                            } else Btn("Togli") {
                                act.go(Screen.Confirm("Togli questo dispositivo dalla rete di BunkerPlex? Per rientrare dovrà avere un posto libero.", "Togli") {
                                    act.task("Dispositivo tolto") { Api.call("DELETE", "/api/devices/$id") }
                                })
                            }
                        }
                    }
                }
                Note("I PC e le app (telefono, tablet, TV fuori casa) con cui raggiungi amici e tuoi PC: al massimo $limit. Le app si tolgono da sole poco dopo che le chiudi.", C.ink3)
            }
        }
        // ---- Indirizzi
        d.network?.let { n ->
            Section("Indirizzi per fuori casa") {
                Line("Per gli amici", when {
                    n.optString("tailnet").isNotEmpty() -> n.optString("tailnet") + " (Tailscale integrato)"
                    n.optBoolean("friends_open") -> n.optString("public") + " (porta aperta sul router)"
                    else -> "nessun accesso da fuori"
                })
                Line("Tuoi dispositivi", n.optString("tailscale").ifEmpty { null }?.let { "$it, porta ${n.optInt("port")}" } ?: "Tailscale non installato sul computer")
                Note("L'app BunkerPlex fuori casa non ne ha bisogno: raggiunge amici e tuoi PC da sola.", C.ink3)
            }
        }
        // ---- Vecchi collegamenti con indirizzo e password
        val sh = d.sharing
        val old = d.friends?.optJSONArray("friends").objects().filter { it.optString("via") != "account" }
        val accounts = sh?.optJSONArray("accounts").objects()
        val pending = accounts.filter { !it.optBoolean("approved") }
        val guests = accounts.filter { it.optBoolean("approved") && it.optString("via") != "account" }
        if (old.isNotEmpty() || pending.isNotEmpty() || guests.isNotEmpty()) Section("Collegamenti con indirizzo e password") {
            pending.forEach { a ->
                Entry("${a.optString("name")} chiede di condividere le raccolte", if (a.optString("back_url").isNotEmpty()) "Se accetti vi vedete a vicenda." else "Se accetti vede le tue raccolte.") {
                    Btn("Accetta", primary = true) { act.task("Accettato") { Api.post("/api/sharing/accounts/${a.optString("id")}", JSONObject().put("approved", true)) } }
                    Btn("Rifiuta") { act.task { Api.call("DELETE", "/api/sharing/accounts/${a.optString("id")}") } }
                }
            }
            old.forEach { f ->
                val n = f.optInt("n")
                val online = if (f.isNull("online")) null else f.optBoolean("online")
                Entry(f.optString("name"), (when (online) { false -> f.optString("error").ifEmpty { "non raggiungibile" }; true -> "collegato"; null -> "collegamento in corso…" }) +
                    " · " + f.optString("url"), online) {
                    Btn("Riprova") { act.task("Riprovo il collegamento…") { Api.post("/api/friends/$n/refresh", JSONObject()) } }
                    Btn("Togli") {
                        act.go(Screen.Confirm("Togliere questo amico? Non vedrai più le sue raccolte e lui non vedrà più le tue.", "Sì, toglilo") {
                            act.task("Amico tolto") { Api.call("DELETE", "/api/friends/$n") }
                        })
                    }
                }
            }
            guests.forEach { a ->
                Entry(a.optString("name"), "può vedere le tue raccolte") {
                    Btn("Sospendi") { act.task("Sospeso: non può più entrare") { Api.post("/api/sharing/accounts/${a.optString("id")}", JSONObject().put("approved", false)) } }
                    Btn("Togli") {
                        act.go(Screen.Confirm("Togliere questo amico? Non potrà più vedere le tue raccolte, e le sue spariscono da qui.", "Sì, toglilo") {
                            act.task { Api.call("DELETE", "/api/sharing/accounts/${a.optString("id")}") }
                        })
                    }
                }
            }
        }
        // ---- Qualita' dei video degli amici
        d.friends?.let { fr ->
            Section("Video degli amici") {
                val q = fr.optString("quality").ifEmpty { "720" }
                val i = QUALITIES.indexOfFirst { it.first == q }.coerceAtLeast(0)
                Buttons {
                    Btn("Qualità: " + QUALITIES[i].second) {
                        act.task { Api.post("/api/friends/quality", JSONObject().put("quality", QUALITIES[(i + 1) % QUALITIES.size].first)) }
                    }
                }
                Note("Viaggiano sulla linea in caricamento di chi condivide: 720p va bene quasi sempre.", C.ink3)
            }
        }
    }
    AutoFocus(first)
}

// ================================================================ Scelta fra piu' cose

/** Una domanda con piu' risposte (per esempio «Aggiorna»): Indietro annulla. */
@Composable
fun ChoiceScreen(act: MainActivity, s: Screen.Choice) {
    val fr = remember { FocusRequester() }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(Modifier.width(560.dp)) {
            Title(s.title, size = 28.sp, lines = 2)
            Column(Modifier.padding(top = 22.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                s.options.forEachIndexed { n, (label, action) ->
                    Btn(label, (if (n == 0) Modifier.focusRequester(fr) else Modifier).fillMaxWidth()) { act.back(); action() }
                }
                Btn("Annulla", Modifier.fillMaxWidth()) { act.back() }
            }
        }
    }
    AutoFocus(fr)
}
