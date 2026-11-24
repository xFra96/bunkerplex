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
            up.read(i)
        } catch (e: ApiError) {
            if (e.status == 401) act.session401() else msg = e.message
        } catch (e: Exception) {
            msg = "Non riesco a raggiungere BunkerPlex."
        }
    }
    val user = state?.optJSONObject("user")
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
                    val name = user?.optString("name") ?: Api.user ?: ""
                    if (name.isNotEmpty()) Face(name, 56.dp)
                    Column(Modifier.padding(start = 18.dp)) {
                        Txt(name.ifEmpty { "…" }, size = 22.sp, weight = FontWeight.Bold)
                        val sub = when {
                            user == null -> ""
                            user.optString("google").isNotEmpty() -> "Account BunkerPlex con Google (${user.optString("google")})"
                            user.optBoolean("linked") -> "Account BunkerPlex"
                            else -> "Profilo di questo PC"
                        }
                        if (sub.isNotEmpty()) Txt(sub, Modifier.padding(top = 4.dp), color = C.ink2, lines = 2)
                    }
                }
                Row(Modifier.padding(top = 18.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    Btn("Cambia profilo", Modifier.focusRequester(first), Ic.restart) { act.switchProfile() }
                    Btn("Gestisci account") { act.web("#/settings/account") }
                }
            }

            // ---- Server
            Section("Server") {
                val i = info
                Line("Nome", i?.optString("name")?.ifEmpty { null } ?: "…")
                Line("Indirizzo", Api.base.removePrefix("http://") + if (Api.base != Api.home) "  (fuori casa)" else "")
                Line("Versione", i?.let { it.optString("release").ifEmpty { it.optString("version") } } ?: "…")
                Row(Modifier.padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    Btn("Cambia server") { act.reset(Screen.Connect) }
                    Btn("Amici e tuoi PC") { act.remote("friends") }
                }
            }

            // ---- App
            Section("App") {
                Line("BunkerPlex TV", "versione ${up.myName}")
                val status = up.status()
                when {
                    up.available -> {
                        Txt("È disponibile la versione ${up.serverName.ifEmpty { "nuova" }}.",
                            Modifier.padding(top = 10.dp), color = C.accentText, weight = FontWeight.SemiBold)
                        Row(Modifier.padding(top = 14.dp)) {
                            Btn("Aggiorna l'app", icon = Ic.restart, primary = true) { up.download() }
                        }
                    }
                    info != null -> Txt("L'app è aggiornata.", Modifier.padding(top = 10.dp), color = C.ink2)
                }
                status?.let { Txt(it, Modifier.padding(top = 12.dp), color = C.ink2, lines = 2) }
            }

            // ---- Il resto
            Section("Altro") {
                Txt("Raccolte, sottotitoli, amici e le altre impostazioni del server.", color = C.ink2, lines = 2)
                Row(Modifier.padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    Btn("Altre impostazioni", icon = Ic.gear) { act.web("#/settings") }
                    Btn("Esci dall'app") { act.finish() }
                }
            }
        }
    }
    LaunchedEffect(Unit) {
        repeat(5) { if (runCatching { first.requestFocus() }.isSuccess) return@LaunchedEffect; withFrameNanos { } }
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Column(
        Modifier.padding(top = 28.dp).width(760.dp).clip(RoundedCornerShape(10.dp)).background(C.surface)
            .padding(horizontal = 26.dp, vertical = 22.dp)
    ) {
        Txt(title.uppercase(), Modifier.padding(bottom = 14.dp), size = 13.sp, color = C.ink3, weight = FontWeight.Bold)
        content()
    }
}

@Composable
private fun Line(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Txt(label, Modifier.width(180.dp), color = C.ink2)
        Txt(value, weight = FontWeight.SemiBold)
    }
}

/**
 * Al primo ingresso, se il server ha una versione piu' nuova dell'app:
 * la propone (come l'app attuale), una volta sola per avvio.
 */
@Composable
fun NewVersionScreen(act: MainActivity) {
    val up = act.update
    val fr = remember { FocusRequester() }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(Modifier.width(620.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Logo(64.dp)
            Title("Nuova versione dell'app", Modifier.padding(top = 22.dp), size = 30.sp, lines = 1)
            Txt("BunkerPlex TV ${up.serverName.ifEmpty { "nuova" }} è pronta sul server (questa è la ${up.myName}).",
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
