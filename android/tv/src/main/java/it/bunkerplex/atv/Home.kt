package it.bunkerplex.atv

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.json.JSONObject

class HomeRow(val key: String, val title: String, val cards: List<Card>, val wide: Boolean)
class HomeData(val rows: List<HomeRow>, val libs: List<Pair<Int, String>>, val empty: Boolean)

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

@Composable
fun HomeScreen(act: MainActivity, refresh: Int) {
    HomeMemory.clearIfOtherServer()
    var data by remember { mutableStateOf(HomeMemory.data) }
    var error by remember { mutableStateOf<String?>(null) }
    // Titolo selezionato: in alto si vedono sfondo, nome e dettagli (lo sfondo con un
    // attimo di ritardo, per non scaricare immagini mentre si scorre veloce)
    var focused by remember { mutableStateOf<Card?>(null) }
    var hero by remember { mutableStateOf<Card?>(null) }
    // Il fuoco torna sul titolo di prima una volta sola, entrando nella Home
    var restoring by remember { mutableStateOf(true) }
    LaunchedEffect(Unit) {
        delay(3000)          // titolo di prima non piu' in elenco: niente salti dopo
        restoring = false
    }
    LaunchedEffect(focused) {
        delay(350)
        hero = focused
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
        if (error != null) ErrorBox(error!!, act) else Centered("Un momento…")
        return
    }

    Box(Modifier.fillMaxSize()) {
        // Sfondo del titolo selezionato, sfumato verso il nero
        hero?.wide?.takeIf { hero?.kind != "episode" }?.let { bg ->
            Box(Modifier.align(Alignment.TopEnd).fillMaxWidth(0.62f).height(330.dp)) {
                Img(Api.image(bg, 780), Modifier.fillMaxSize(), 600.dp, 330.dp)
                Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(listOf(C.bg, Color.Transparent), endX = 400f)))
                Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Color.Transparent, C.bg), startY = 300f)))
            }
        }
        Column(Modifier.fillMaxSize()) {
            TopBar(act, d.libs)
            Column(Modifier.padding(start = 48.dp, top = 8.dp).height(120.dp).width(520.dp)) {
                val h = focused
                if (h != null) {
                    Txt(h.title, size = 28.sp, bold = true)
                    if (h.subtitle.isNotEmpty()) Txt(h.subtitle, Modifier.padding(top = 6.dp), color = C.dim)
                }
            }
            if (d.empty) {
                Centered("Nessuna raccolta", "Aggiungi una cartella di video dalle Impostazioni.")
                return@Column
            }
            val restore = HomeMemory.focusKey ?: d.rows.firstOrNull()?.let { "${it.key}:${it.cards.first().kind}:${it.cards.first().id}" }
            LazyColumn(
                state = HomeMemory.column,
                contentPadding = PaddingValues(bottom = 60.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                items(d.rows, key = { it.key }) { row ->
                    Column {
                        Txt(row.title, Modifier.padding(start = 48.dp, bottom = 10.dp), size = 18.sp, bold = true)
                        val state = HomeMemory.rows.getOrPut(row.key) { LazyListState() }
                        LazyRow(
                            state = state,
                            contentPadding = PaddingValues(horizontal = 48.dp, vertical = 8.dp),
                            horizontalArrangement = Arrangement.spacedBy(16.dp),
                        ) {
                            items(row.cards, key = { "${it.kind}:${it.id}" }) { c ->
                                val k = "${row.key}:${c.kind}:${c.id}"
                                val fr = if (restoring && k == restore) remember { FocusRequester() } else null
                                val mod = if (fr != null) Modifier.focusRequester(fr) else Modifier
                                val onFocus = { HomeMemory.focusKey = k; focused = c }
                                val onClick = { open(act, c) }
                                if (row.wide) WideCard(c, mod, onFocus, onClick) else PosterCard(c, mod, onFocus, onClick)
                                if (fr != null) LaunchedEffect(Unit) {
                                    try { fr.requestFocus() } catch (_: Exception) {}
                                    restoring = false
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

private fun open(act: MainActivity, c: Card) {
    when (c.kind) {
        // Episodio in corso o prossimo: parte subito, come su Netflix
        "episode" -> act.play(c.id, false) { Toast.makeText(act, it, Toast.LENGTH_LONG).show() }
        else -> act.go(Screen.Detail(c.kind, c.id))
    }
}

/** Menu in alto. Le voci non ancora native aprono l'interfaccia web. */
@Composable
private fun TopBar(act: MainActivity, libs: List<Pair<Int, String>>) {
    LazyRow(
        Modifier.fillMaxWidth().padding(top = 22.dp),
        contentPadding = PaddingValues(horizontal = 40.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        item { Tab("Cerca") { act.web("#/search") } }
        items(libs, key = { it.first }) { (id, name) -> Tab(name) { act.web("#/lib/$id") } }
        item { Tab("La mia lista") { act.web("#/mylist") } }
        item { Tab("Impostazioni") { act.web("#/settings") } }
    }
}

@Composable
private fun Tab(label: String, onClick: () -> Unit) {
    Focusable(shape = RoundedCornerShape(50), scale = 1f, onClick = onClick) { f ->
        Box(Modifier.background(if (f) C.text else Color.Transparent).padding(horizontal = 16.dp, vertical = 7.dp)) {
            Txt(label, color = if (f) C.bg else C.dim, bold = f)
        }
    }
}

@Composable
fun ErrorBox(msg: String, act: MainActivity) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Txt(msg, size = 20.sp, lines = 3)
            val fr = remember { FocusRequester() }
            Row(Modifier.padding(top = 24.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                Btn("Riprova", Modifier.focusRequester(fr), primary = true) { act.reset(Screen.Who) }
                Btn("Cambia server") { act.reset(Screen.Connect) }
            }
            LaunchedEffect(Unit) { try { fr.requestFocus() } catch (_: Exception) {} }
        }
    }
}
