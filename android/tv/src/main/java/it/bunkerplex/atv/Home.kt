@file:OptIn(ExperimentalComposeUiApi::class)

package it.bunkerplex.atv

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.json.JSONObject

class HomeRow(val key: String, val title: String, val cards: List<Card>, val wide: Boolean)
class HomeData(val rows: List<HomeRow>, val libs: List<Pair<Int, String>>, val empty: Boolean)

/** Il titolo selezionato nella Home e la fila da cui viene (per la riga in grassetto dell'anteprima). */
class Pick(val card: Card, val row: String)

/**
 * Quello che la Home ricorda mentre si e' in una scheda o nel player: dati,
 * posizione delle file e titolo selezionato, cosi' al ritorno si riparte da li'.
 */
object HomeMemory {
    var data: HomeData? = null
    var column = LazyListState()
    val rows = HashMap<String, LazyListState>()
    var focusKey: String? = null
    var server = ""

    fun clearIfOtherServer() {
        if (server != Api.base) {
            data = null; column = LazyListState(); rows.clear(); focusKey = null; server = Api.base
        }
    }
}

private fun parseHome(j: JSONObject): HomeData {
    val rows = mutableListOf<HomeRow>()
    fun add(key: String, title: String, arr: org.json.JSONArray?, wide: Boolean) {
        val cards = arr.objects().map { Card.from(it) }
        if (cards.isNotEmpty()) rows.add(HomeRow(key, title, cards, wide))
    }
    add("continue", "Continua a guardare", j.optJSONArray("continue"), true)
    add("nextup", "Prossimi episodi", j.optJSONArray("nextup"), true)
    add("mylist", "La mia lista", j.optJSONArray("mylist"), false)
    val libs = mutableListOf<Pair<Int, String>>()
    j.optJSONArray("libraries").objects().forEach { l ->
        val name = l.optString("name")
        libs.add(l.optInt("id") to name)
        add("lib${l.optInt("id")}", "$name · aggiunti di recente", l.optJSONArray("items"), false)
    }
    add("sagas", "Saghe", j.optJSONArray("collections"), false)
    add("top", "I più votati da vedere", j.optJSONArray("top_movies"), false)
    return HomeData(rows, libs, !j.optBoolean("has_libraries"))
}

/** Altezza del titolo di una fila e spazio sopra le schede: la fila col fuoco si allinea qui. */
private val RowHead = 30.dp
private val RowGap = 10.dp

@Composable
fun HomeScreen(act: MainActivity, refresh: Int) {
    HomeMemory.clearIfOtherServer()
    var data by remember { mutableStateOf(HomeMemory.data) }
    var error by remember { mutableStateOf<String?>(null) }
    // Titolo selezionato. Lo legge solo l'anteprima: a ogni pressione si ridisegna lei,
    // non tutta la Home
    val pick = remember { mutableStateOf<Pick?>(null) }
    // Il fuoco torna sul titolo di prima una volta sola, entrando nella Home
    var restoring by remember { mutableStateOf(true) }
    LaunchedEffect(Unit) {
        delay(3000)          // titolo di prima non piu' in elenco: niente salti dopo
        restoring = false
    }

    LaunchedEffect(refresh) {
        try {
            val d = withContext(Dispatchers.IO) { parseHome(Api.obj("/api/home")) }
            HomeMemory.data = d
            data = d
            error = null
        } catch (e: ApiError) {
            if (e.status == 401) act.session401() else error = e.message
        } catch (e: Exception) {
            if (data == null) error = "Non riesco a raggiungere BunkerPlex."
        }
    }

    val d = data
    if (d == null) {
        if (error != null) ErrorBox(error!!, act) else HomeBones()
        return
    }

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().padding(start = D.rail)) {
            Stage(pick, Modifier.fillMaxWidth().fillMaxHeight(0.54f))
            if (d.empty) {
                Box(Modifier.fillMaxSize().padding(start = D.pad)) {
                    Column {
                        Title("Nessuna raccolta", size = 26.sp, lines = 1)
                        Txt("Aggiungi una cartella di video dalle Impostazioni.", Modifier.padding(top = 8.dp),
                            color = C.ink2, lines = 2)
                    }
                }
            } else {
                Rows(act, d, pick, restoring) { restoring = false }
            }
        }
        Rail(act, d.libs, "home")
    }
}

@Composable
private fun Rows(act: MainActivity, d: HomeData, pick: MutableState<Pick?>, restoring: Boolean, restored: () -> Unit) {
    val restore = HomeMemory.focusKey ?: d.rows.firstOrNull()?.let { "${it.key}:${it.cards.first().kind}:${it.cards.first().id}" }
    // La fila col fuoco resta alla stessa altezza, sotto l'anteprima (come sul web).
    // Gli 8 dp in piu' tengono dentro lo schermo il fondo vuoto della fila sopra: resta
    // composta, e la freccia su la trova sempre (invece di saltare nel menu)
    Pivot(RowHead + RowGap + 8.dp) {
        LazyColumn(
            state = HomeMemory.column,
            // In fondo c'e' spazio perche' anche l'ultima fila salga al suo posto
            contentPadding = PaddingValues(bottom = 260.dp),
        ) {
            items(d.rows, key = { it.key }) { row ->
                Column {
                    Txt(row.title, Modifier.height(RowHead).padding(start = D.pad), size = 19.sp, weight = FontWeight.Bold)
                    val state = HomeMemory.rows.getOrPut(row.key) { LazyListState() }
                    // La scheda col fuoco resta allineata a sinistra, la fila scorre sotto
                    Pivot(D.pad) {
                        LazyRow(
                            Modifier.focusRestorer(),
                            state = state,
                            // A destra c'e' spazio perche' anche le ultime schede arrivino a sinistra
                            contentPadding = PaddingValues(start = D.pad, end = 600.dp, top = RowGap, bottom = RowGap),
                            horizontalArrangement = Arrangement.spacedBy(14.dp),
                        ) {
                            items(row.cards, key = { "${it.kind}:${it.id}" }) { c ->
                                val k = "${row.key}:${c.kind}:${c.id}"
                                val fr = if (restoring && k == restore) remember { FocusRequester() } else null
                                val mod = if (fr != null) Modifier.focusRequester(fr) else Modifier
                                val onFocus = { HomeMemory.focusKey = k; pick.value = Pick(c, row.key) }
                                val onClick = { open(act, c) }
                                if (row.wide) WideCard(c, mod, onFocus, onClick) else PosterCard(c, mod, onFocus = onFocus, onClick = onClick)
                                if (fr != null) LaunchedEffect(Unit) {
                                    // Se la scheda non e' ancora pronta a prendere il fuoco si
                                    // riprova per qualche fotogramma, poi si lascia stare
                                    repeat(5) {
                                        if (runCatching { fr.requestFocus() }.isSuccess) { restored(); return@LaunchedEffect }
                                        withFrameNanos { }
                                    }
                                    restored()
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * Anteprima in alto: lo sfondo del titolo selezionato a destra, sfumato nel nero,
 * e a sinistra nome, dettagli e trama. Lo sfondo arriva con un attimo di ritardo
 * (per non scaricare immagini mentre si scorre veloce); col tasto tenuto premuto
 * aspettano anche i testi.
 */
@Composable
private fun Stage(pick: MutableState<Pick?>, modifier: Modifier) {
    val now = pick.value
    var shown by remember { mutableStateOf(now) }
    var hero by remember { mutableStateOf(now?.card) }
    LaunchedEffect(now) {
        if (Keys.held) delay(160)
        shown = now
        delay(350)
        hero = now?.card
    }
    Box(modifier) {
        hero?.backdrop?.let { bg ->
            Box(Modifier.align(Alignment.TopEnd).fillMaxWidth(0.72f).fillMaxHeight()) {
                Img(Api.image(bg, 780), Modifier.fillMaxSize(), 640.dp, 300.dp, fade = 260, alignment = UpperCenter)
                Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(
                    0f to C.bg, 0.12f to C.bg.copy(alpha = 0.82f), 0.55f to Color.Transparent)))
                Box(Modifier.fillMaxSize().background(Brush.verticalGradient(
                    0.45f to Color.Transparent, 1f to C.bg)))
            }
        }
        val s = shown ?: return@Box
        val c = s.card
        Column(
            Modifier.align(Alignment.BottomStart).padding(start = D.pad, bottom = 12.dp).fillMaxWidth(0.52f)
        ) {
            val lead = when (s.row) {
                "continue" -> "Continua a guardare"
                "nextup" -> "Prossimo episodio"
                else -> null
            }
            if (c.kind == "episode" && c.episodeLine.isNotEmpty()) {
                Txt(c.episodeLine, Modifier.padding(bottom = 6.dp), size = 16.sp, color = C.ink2, weight = FontWeight.SemiBold)
            }
            Title(c.title, size = 36.sp)
            MetaLine(stageMeta(c, lead), Modifier.padding(top = 10.dp))
            if (c.overview.isNotBlank()) {
                Txt(c.overview, Modifier.padding(top = 10.dp).widthIn(max = 540.dp), size = 16.sp, lines = 2,
                    lineHeight = 23.sp)
            }
        }
    }
}

private fun stageMeta(c: Card, lead: String?): List<M> {
    val out = mutableListOf<M>()
    lead?.let { out.add(M.Lead(it)) }
    when (c.kind) {
        "show" -> {
            if (c.year > 0) out.add(M.Plain("${c.year}"))
            out.add(M.Plain(c.subtitle))
        }
        "collection" -> {
            out.add(M.Plain(c.subtitle))
            if (c.year > 0) out.add(M.Plain(if (c.yearTo > c.year) "${c.year}–${c.yearTo}" else "${c.year}"))
        }
        "episode" -> if (c.duration > 0) out.add(M.Plain(length(c.duration)))
        else -> {
            if (c.year > 0) out.add(M.Plain("${c.year}"))
            if (c.duration > 0) out.add(M.Plain(length(c.duration)))
        }
    }
    if (c.rating > 0) out.add(M.Rating(c.rating))
    if (c.quality.isNotEmpty()) out.add(M.Quality(c.quality))
    left(c.duration, c.position)?.let { out.add(M.Hot(it)) }
        ?: c.genres.take(2).takeIf { it.isNotEmpty() && lead == null }?.let { out.add(M.Plain(it.joinToString(", "))) }
    return out
}

private fun open(act: MainActivity, c: Card) {
    when (c.kind) {
        // Episodio in corso o prossimo: parte subito, come su Netflix
        "episode" -> act.play(c.id, false) { Toast.makeText(act, it, Toast.LENGTH_LONG).show() }
        else -> act.go(Screen.Detail(c.kind, c.id))
    }
}

/**
 * Menu a sinistra, come sul web: una colonna stretta di icone che si allarga con i
 * nomi quando prende il fuoco. Sta sopra il contenuto, che non si sposta.
 * Le voci non ancora native aprono l'interfaccia web.
 */
@Composable
fun Rail(act: MainActivity, libs: List<Pair<Int, String>>, current: String) {
    var open by remember { mutableStateOf(false) }
    val here = remember { FocusRequester() }
    Column(
        Modifier
            .fillMaxHeight()
            .width(if (open) D.railOpen else D.rail)
            .background(if (open) C.surface else C.bg)
            .onFocusChanged { open = it.hasFocus }
            // Entrando nel menu (da destra o da sopra) si arriva sulla voce in cui ci si trova
            .focusProperties { enter = { here } }
            .focusGroup()
            .padding(horizontal = 14.dp, vertical = 20.dp)
    ) {
        Row(Modifier.height(48.dp).padding(start = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Logo(36.dp)
            if (open) {
                Spacer(Modifier.width(14.dp))
                Txt("Bunker", size = 21.sp, weight = FontWeight.ExtraBold)
                Txt("Plex", size = 21.sp)
            }
        }
        Spacer(Modifier.height(18.dp))
        RailItem(Ic.home, null, null, "Home", open, current == "home", if (current == "home") here else null) {}
        RailItem(Ic.search, null, null, "Cerca", open) { act.web("#/search") }
        RailItem(Ic.list, null, null, "La mia lista", open) { act.web("#/mylist") }
        RailItem(Ic.sagas, null, null, "Collezioni", open) { act.web("#/sagas") }
        Spacer(Modifier.height(12.dp))
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            libs.forEach { (id, name) -> RailItem(null, initials(name), null, name, open) { act.web("#/lib/$id") } }
        }
        Api.user?.let { u -> RailItem(null, null, u, u, open) { act.web("#/settings/account") } }
        RailItem(Ic.gear, null, null, "Impostazioni", open) { act.web("#/settings") }
    }
}

@Composable
private fun RailItem(
    icon: androidx.compose.ui.graphics.vector.ImageVector?,
    abbr: String?,
    face: String?,
    label: String,
    open: Boolean,
    on: Boolean = false,
    fr: FocusRequester? = null,
    onClick: () -> Unit,
) {
    Focusable(
        (if (fr != null) Modifier.focusRequester(fr) else Modifier).fillMaxWidth().padding(vertical = 2.dp),
        RoundedCornerShape(8.dp), scale = 1f, onClick = onClick,
    ) { f ->
        Row(
            Modifier.fillMaxWidth().height(44.dp)
                .background(if (f) C.ink else if (on) C.surface2 else Color.Transparent)
                .padding(start = 8.dp, end = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val fg = if (f) C.bg else if (on) C.ink else C.ink2
            when {
                icon != null -> Icon(icon, if (f) C.bg else if (on) C.accentText else C.ink2, 28.dp)
                face != null -> Face(face, 28.dp, focused = f)
                else -> Box(
                    Modifier.size(28.dp).clip(RoundedCornerShape(6.dp)).background(if (f) C.bg else C.surface2),
                    contentAlignment = Alignment.Center,
                ) { Txt(abbr ?: "", size = 11.sp, color = C.ink, weight = FontWeight.Bold) }
            }
            if (open) {
                Spacer(Modifier.width(16.dp))
                Txt(label, color = fg, size = 17.sp, weight = FontWeight.SemiBold)
            }
        }
    }
}

/** Home in caricamento: menu, anteprima e una fila di sagome ferme. */
@Composable
private fun HomeBones() {
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().padding(start = D.rail)) {
            Box(Modifier.fillMaxWidth().fillMaxHeight(0.54f)) {
                Column(Modifier.align(Alignment.BottomStart).padding(start = D.pad, bottom = 12.dp)) {
                    Bone(300.dp, 36.dp)
                    Bone(220.dp, 18.dp, Modifier.padding(top = 14.dp))
                    Bone(420.dp, 16.dp, Modifier.padding(top = 14.dp))
                }
            }
            Bone(180.dp, 18.dp, Modifier.padding(start = D.pad, top = 6.dp))
            Row(Modifier.padding(start = D.pad, top = RowGap + 6.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                repeat(6) { Bone(D.posterW, D.posterH) }
            }
        }
        Column(Modifier.fillMaxHeight().width(D.rail).padding(horizontal = 14.dp, vertical = 20.dp)) {
            Logo(36.dp, Modifier.padding(start = 6.dp, top = 6.dp))
        }
    }
}

@Composable
fun ErrorBox(msg: String, act: MainActivity) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Logo(48.dp, Modifier.padding(bottom = 22.dp))
            Txt(msg, size = 20.sp, weight = FontWeight.SemiBold, lines = 3)
            val fr = remember { FocusRequester() }
            Row(Modifier.padding(top = 24.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                Btn("Riprova", Modifier.focusRequester(fr), Ic.restart, primary = true) { act.reset(Screen.Who) }
                Btn("Cambia server") { act.reset(Screen.Connect) }
            }
            LaunchedEffect(Unit) { try { fr.requestFocus() } catch (_: Exception) {} }
        }
    }
}
