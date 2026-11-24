package it.bunkerplex.atv

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.json.JSONArray
import java.text.Normalizer

/**
 * Le pagine a griglia: una raccolta (con tipo, stato e ordine), la mia lista,
 * le collezioni e la ricerca. Come la Home, ricordano dove si era quando si
 * torna da una scheda o dal player.
 */

/** Un titolo della griglia, con quello che serve per ordinare e cercare. */
class Item(val card: Card, val added: Double, val hay: String, val fav: Boolean)

private fun norm(s: String): String =
    Normalizer.normalize(s.lowercase(), Normalizer.Form.NFD).replace(Regex("\\p{M}+"), "")

private fun toItems(arr: JSONArray): List<Item> = arr.objects().map { j ->
    val hay = listOf(
        j.optString("title"), j.optString("original_title"), j.optInt("year").takeIf { it > 0 }?.toString() ?: "",
        j.optString("director"), j.optJSONArray("actors").strings().joinToString(" "),
        j.optJSONArray("genres").strings().joinToString(" "),
    ).joinToString(" ")
    Item(Card.from(j), j.optDouble("added_at", 0.0).takeIf { !it.isNaN() } ?: 0.0, norm(hay), j.optBoolean("fav"))
}

/** Posizione e titolo col fuoco di ogni pagina, per il ritorno. */
private object GridMemory {
    val grids = HashMap<String, LazyGridState>()
    val focus = HashMap<String, String>()
    var server = ""
    fun state(key: String): LazyGridState {
        if (server != Api.base) { grids.clear(); focus.clear(); server = Api.base }
        return grids.getOrPut(key) { LazyGridState() }
    }
}

/** Filtri di una raccolta, ricordati finche' l'app resta aperta. */
private object LibFilters {
    val type = HashMap<Int, String>()      // "", movie, show
    val state = HashMap<Int, String>()     // "", unwatched, started, watched
    val sort = HashMap<Int, String>()      // title, added, year_desc, year_asc, rating
}

private val TYPES = listOf("" to "Tutto", "movie" to "Film", "show" to "Serie TV")
private val STATES = listOf("" to "Tutti", "unwatched" to "Da vedere", "started" to "Iniziati", "watched" to "Già visti")
private val SORTS = listOf(
    "title" to "Titolo (A–Z)", "added" to "Aggiunti di recente", "year_desc" to "Anno, dal più recente",
    "year_asc" to "Anno, dal più vecchio", "rating" to "Voto più alto",
)

/** Carica una lista dal server; 401 riporta a «Chi guarda?». */
@Composable
private fun load(act: MainActivity, key: Any, refresh: Int, fetch: () -> List<Item>): Pair<List<Item>?, String?> {
    var data by remember(key) { mutableStateOf<List<Item>?>(null) }
    var error by remember(key) { mutableStateOf<String?>(null) }
    LaunchedEffect(key, refresh) {
        try {
            data = withContext(Dispatchers.IO) { fetch() }
            error = null
        } catch (e: ApiError) {
            if (e.status == 401) act.session401() else error = e.message
        } catch (e: Exception) {
            if (data == null) error = "Non riesco a raggiungere BunkerPlex."
        }
    }
    return data to error
}

@Composable
fun LibraryScreen(act: MainActivity, s: Screen.Library, refresh: Int) {
    val (all, error) = load(act, s, refresh) { toItems(Api.arr("/api/libraries/${s.id}/items")) }
    var type by remember(s) { mutableStateOf(LibFilters.type[s.id] ?: "") }
    var state by remember(s) { mutableStateOf(LibFilters.state[s.id] ?: "") }
    var sort by remember(s) { mutableStateOf(LibFilters.sort[s.id] ?: "title") }
    val shown = remember(all, type, state, sort) {
        (all ?: emptyList()).filter { i ->
            val c = i.card
            (type.isEmpty() || c.kind == type) && when (state) {
                "unwatched" -> !c.watched
                "started" -> c.progress > 0
                "watched" -> c.watched
                else -> true
            }
        }.let { list ->
            when (sort) {
                "added" -> list.sortedByDescending { it.added }
                "year_desc" -> list.sortedByDescending { it.card.year }
                "year_asc" -> list.sortedBy { it.card.year.takeIf { y -> y > 0 } ?: 9999 }
                "rating" -> list.sortedByDescending { it.card.rating }
                else -> list.sortedBy { norm(it.card.title) }
            }
        }
    }
    Page(act, "lib${s.id}") {
        Grid(act, "lib${s.id}|$type|$state|$sort", shown.map { it.card }, all == null, error,
            empty = "Nessun titolo con questi filtri.") {
            Title(s.name, size = 34.sp, lines = 1)
            Row(Modifier.padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Cycle("Tipo", TYPES, type) { type = it; LibFilters.type[s.id] = it }
                Cycle("Stato", STATES, state) { state = it; LibFilters.state[s.id] = it }
                Cycle("Ordina", SORTS, sort) { sort = it; LibFilters.sort[s.id] = it }
                all?.let { Txt("${shown.size} titoli", Modifier.padding(start = 10.dp, top = 12.dp), color = C.ink3) }
            }
        }
    }
}

@Composable
fun MyListScreen(act: MainActivity, refresh: Int) {
    val (list, error) = load(act, "mylist", refresh) { toItems(Api.arr("/api/mylist")) }
    Page(act, "mylist") {
        Grid(act, "mylist", list?.map { it.card } ?: emptyList(), list == null, error,
            empty = "La tua lista è vuota. Aggiungi film e serie dalla loro scheda.") {
            Title("La mia lista", size = 34.sp, lines = 1)
        }
    }
}

@Composable
fun SagasScreen(act: MainActivity, refresh: Int) {
    val (list, error) = load(act, "sagas", refresh) { toItems(Api.arr("/api/collections")) }
    Page(act, "sagas") {
        Grid(act, "sagas", list?.sortedBy { norm(it.card.title) }?.map { it.card } ?: emptyList(), list == null, error,
            empty = "Nessuna collezione: compaiono quando hai almeno due film della stessa saga.") {
            Title("Collezioni", size = 34.sp, lines = 1)
        }
    }
}

/** Testo cercato, ricordato finche' l'app resta aperta (come sul web). */
private object SearchMemory {
    var query = ""
}

@Composable
fun SearchScreen(act: MainActivity, refresh: Int) {
    val (all, error) = load(act, "search", refresh) {
        toItems(Api.arr("/api/collections")) + toItems(Api.arr("/api/movies")) + toItems(Api.arr("/api/shows"))
    }
    var query by remember { mutableStateOf(SearchMemory.query) }
    var applied by remember { mutableStateOf(SearchMemory.query) }
    // Si cerca quando si smette di scrivere per un attimo, non a ogni lettera
    LaunchedEffect(query) {
        delay(200)
        applied = query
        SearchMemory.query = query
    }
    val terms = remember(applied) { norm(applied).split(Regex("\\s+")).filter { it.isNotEmpty() } }
    val found = remember(all, terms) {
        if (terms.isEmpty()) emptyList()
        else (all ?: emptyList()).filter { i -> terms.all { i.hay.contains(it) } }.map { it.card }
    }
    val genres = remember(all) {
        (all ?: emptyList()).flatMap { it.card.genres }.groupingBy { it }.eachCount()
            .entries.sortedByDescending { it.value }.take(14).map { it.key }
    }
    val field = remember { FocusRequester() }
    Page(act, "search") {
        Grid(act, "search|$applied", found, all == null, error,
            empty = if (terms.isEmpty()) "" else "Nessun risultato per «$applied».", restore = false) {
            Title("Cerca", size = 34.sp, lines = 1)
            Box(Modifier.padding(top = 14.dp)) {
                Field(query, { query = it }, "Titolo, regista, attore, genere o anno", Modifier.focusRequester(field)) {}
            }
            if (terms.isEmpty() && genres.isNotEmpty()) {
                Txt("Oppure sfoglia per genere", Modifier.padding(top = 22.dp, bottom = 10.dp), size = 17.sp,
                    weight = FontWeight.Bold, color = C.ink2)
                Nearest {
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(genres, key = { it }) { g -> Chip(g, false) { query = g } }
                    }
                }
            }
        }
    }
    LaunchedEffect(Unit) {
        // Si arriva nel campo, come sul web (OK apre la tastiera della TV)
        repeat(5) { if (runCatching { field.requestFocus() }.isSuccess) return@LaunchedEffect; withFrameNanos { } }
    }
}

/** Pagina con il menu a sinistra; il menu indica dove si e'. */
@Composable
fun Page(act: MainActivity, current: String, content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxSize().padding(start = D.rail)) { content() }
        Rail(act, HomeMemory.data?.libs ?: emptyList(), current)
    }
}

/**
 * Griglia di locandine con un'intestazione sopra (titolo, filtri, campo di ricerca),
 * che scorre insieme alla griglia.
 */
@Composable
private fun Grid(
    act: MainActivity,
    key: String,
    cards: List<Card>,
    loading: Boolean,
    error: String?,
    empty: String,
    restore: Boolean = true,
    header: @Composable () -> Unit,
) {
    val state = GridMemory.state(key)
    var restoring by remember(key) { mutableStateOf(restore) }
    val target = GridMemory.focus[key]
    Nearest {
        LazyVerticalGrid(
            columns = GridCells.Adaptive(D.posterW + 14.dp),
            state = state,
            contentPadding = PaddingValues(start = D.pad, end = D.pad, top = 36.dp, bottom = 60.dp),
            horizontalArrangement = Arrangement.spacedBy(14.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            item(key = "header", span = { androidx.compose.foundation.lazy.grid.GridItemSpan(maxLineSpan) }) {
                Column(Modifier.padding(bottom = 10.dp)) {
                    header()
                    when {
                        error != null -> Txt(error, Modifier.padding(top = 20.dp), color = C.warn, lines = 2)
                        loading -> Row(Modifier.padding(top = 24.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                            repeat(6) { Bone(D.posterW, D.posterH) }
                        }
                        cards.isEmpty() && empty.isNotEmpty() ->
                            Txt(empty, Modifier.padding(top = 20.dp), color = C.ink2, lines = 3)
                    }
                }
            }
            items(cards, key = { "${it.kind}:${it.id}" }) { c ->
                val k = "${c.kind}:${c.id}"
                val first = target == null && c === cards.first()
                val fr = if (restoring && (k == target || first)) remember { FocusRequester() } else null
                PosterCard(
                    c, if (fr != null) Modifier.focusRequester(fr) else Modifier, caption = true,
                    onFocus = { GridMemory.focus[key] = k },
                ) { openCard(act, c) }
                if (fr != null) LaunchedEffect(Unit) {
                    repeat(5) {
                        if (runCatching { fr.requestFocus() }.isSuccess) { restoring = false; return@LaunchedEffect }
                        withFrameNanos { }
                    }
                    restoring = false
                }
            }
        }
    }
}

/** Apre un titolo della griglia: la sua scheda. */
fun openCard(act: MainActivity, c: Card) {
    act.go(Screen.Detail(if (c.kind == "episode") "movie" else c.kind, c.id))
}

/** Un filtro che a ogni pressione passa al valore successivo (Tipo: Tutto → Film → Serie TV). */
@Composable
private fun Cycle(label: String, values: List<Pair<String, String>>, value: String, onChange: (String) -> Unit) {
    val i = values.indexOfFirst { it.first == value }.coerceAtLeast(0)
    Chip("$label: ${values[i].second}", i != 0) { onChange(values[(i + 1) % values.size].first) }
}

@Composable
private fun Chip(label: String, on: Boolean, onClick: () -> Unit) {
    Focusable(shape = RoundedCornerShape(50), scale = 1.04f, onClick = onClick) { f ->
        Box(
            Modifier.background(if (f) C.ink else if (on) C.accent else C.btn)
                .padding(horizontal = 16.dp, vertical = 9.dp)
        ) { Txt(label, color = if (f) C.bg else C.ink, size = 15.sp, weight = FontWeight.SemiBold) }
    }
}
