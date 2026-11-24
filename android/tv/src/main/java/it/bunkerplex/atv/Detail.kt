package it.bunkerplex.atv

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.animation.core.spring
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.ui.platform.LocalDensity
import kotlin.math.abs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

/** Margine sinistro della scheda: le file sotto partono dallo stesso punto del titolo. */
private val Edge = 56.dp

/**
 * Scheda di un film, di una serie (stagioni ed episodi) o di una saga.
 *
 * In alto lo sfondo a tutto schermo con locandina, titolo, dettagli e pulsanti; sotto
 * le sezioni (episodi, cast, film della saga). Lo scorrimento lo decide la scheda:
 * con il fuoco in alto si vede tutta l'intestazione, entrando in una sezione questa
 * sale in cima con il suo titolo. Un solo movimento, sempre uguale.
 */
@Composable
fun DetailScreen(act: MainActivity, s: Screen.Detail, refresh: Int) {
    var d by remember(s) { mutableStateOf<JSONObject?>(null) }
    var error by remember(s) { mutableStateOf<String?>(null) }
    var reload by remember(s) { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()
    val path = when (s.kind) {
        "show" -> "/api/shows/${s.id}"
        "collection" -> "/api/collections/${s.id}"
        else -> "/api/items/${s.id}"
    }
    LaunchedEffect(s, refresh, reload) {
        try {
            d = withContext(Dispatchers.IO) { Api.obj(path) }
        } catch (e: ApiError) {
            if (e.status == 401) act.session401() else error = e.message
        } catch (e: Exception) {
            error = "Non riesco a raggiungere BunkerPlex."
        }
    }
    val j = d
    if (j == null) {
        if (error != null) Centered(error!!) else DetailBones()
        return
    }
    val toast = { m: String -> Toast.makeText(act, m, Toast.LENGTH_LONG).show() }

    /** Una richiesta che cambia qualcosa (lista, visto), poi si ricarica la scheda. */
    fun change(post: String, body: JSONObject) {
        scope.launch {
            try {
                withContext(Dispatchers.IO) { Api.post(post, body) }
                reload++
            } catch (e: Exception) {
                toast(e.message ?: "Non riuscito")
            }
        }
    }

    val list = remember(s) { LazyListState() }
    val first = remember(s) { FocusRequester() }
    val peek = with(LocalDensity.current) { Peek.toPx() }
    val heroH = (LocalConfiguration.current.screenHeightDp * 0.8f).dp

    // Le sezioni sotto l'intestazione, nell'ordine in cui si vedono
    val cast = j.optJSONArray("cast").objects().filter { it.optString("name").isNotEmpty() }
    val sections = buildList {
        when (s.kind) {
            "show" -> if (j.optJSONArray("seasons").objects().isNotEmpty()) add("episodes")
            "collection" -> add("films")
        }
        if (cast.isNotEmpty()) add("cast")
    }

    Still {
        LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(bottom = 56.dp)) {
            item("head") {
                Hero(j, s.kind, heroH) {
                    Buttons(act, j, s, first, toast, ::change) { show(scope, list, 0, peek) }
                }
            }
            sections.forEachIndexed { n, key ->
                val at = n + 1
                item(key) {
                    val onFocus = { show(scope, list, at, peek) }
                    when (key) {
                        "episodes" -> Episodes(act, j, toast, onFocus)
                        "films" -> Section("Film della saga", "${j.optInt("count")} film") {
                            val cards = j.optJSONArray("items").objects().map { Card.from(it) }
                            Pivot(Edge) {
                                LazyRow(
                                    contentPadding = PaddingValues(start = Edge, end = 600.dp, top = 10.dp, bottom = 10.dp),
                                    horizontalArrangement = Arrangement.spacedBy(16.dp),
                                ) {
                                    items(cards, key = { it.id }) { c ->
                                        PosterCard(c, caption = true, onFocus = onFocus) { act.go(Screen.Detail("movie", c.id)) }
                                    }
                                }
                            }
                        }
                        "cast" -> Cast(cast, onFocus)
                    }
                }
            }
        }
    }
    LaunchedEffect(s) { try { first.requestFocus() } catch (_: Exception) {} }
}

/**
 * Porta la sezione [index] in cima (0 = l'intestazione intera), se non c'e' gia'.
 * Della sezione sopra restano [Peek] dentro lo schermo: cosi' resta composta e la
 * freccia su la trova sempre.
 */
private fun show(scope: CoroutineScope, list: LazyListState, index: Int, peekPx: Float) {
    if (index == 0) {
        if (list.firstVisibleItemIndex != 0 || list.firstVisibleItemScrollOffset != 0) scope.launch { list.animateScrollToItem(0) }
        return
    }
    val info = list.layoutInfo.visibleItemsInfo.firstOrNull { it.index == index }
    if (info == null) {
        scope.launch { list.animateScrollToItem(index) }
        return
    }
    val delta = info.offset - peekPx
    if (abs(delta) > 1f) scope.launch { list.animateScrollBy(delta, spring<Float>(stiffness = 650f)) }
}

private val Peek = 8.dp

/** Intestazione: sfondo a tutto schermo, locandina, titolo, dettagli, trama e pulsanti. */
@Composable
private fun Hero(j: JSONObject, kind: String, height: androidx.compose.ui.unit.Dp, buttons: @Composable () -> Unit) {
    Box(Modifier.fillMaxWidth().height(height)) {
        j.str("backdrop")?.let { bg ->
            Img(Api.image(bg, 780), Modifier.fillMaxSize(), 960.dp, height, alignment = UpperCenter)
            // Veli come sul web: pieno a sinistra, mai del tutto trasparente sotto il testo
            Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(
                0.04f to C.bg, 0.34f to C.bg.copy(alpha = 0.88f), 0.66f to C.bg.copy(alpha = 0.45f),
                1f to C.bg.copy(alpha = 0.2f))))
            Box(Modifier.fillMaxSize().background(Brush.verticalGradient(
                0.45f to Color.Transparent, 1f to C.bg)))
        }
        Column(Modifier.align(Alignment.BottomStart).padding(start = Edge, end = Edge, bottom = 8.dp)) {
            Row(verticalAlignment = Alignment.Bottom) {
                j.str("poster")?.let { p ->
                    Box(Modifier.padding(end = 32.dp).size(150.dp, 225.dp).clip(D.r).background(C.surface2)) {
                        Img(Api.image(p, 342), Modifier.fillMaxSize(), 150.dp, 225.dp)
                    }
                }
                Column {
                    val text = Modifier.widthIn(max = 600.dp)
                    Title(j.optString("title"), text, size = 40.sp)
                    MetaLine(detailMeta(j, kind), Modifier.padding(top = 12.dp))
                    val genres = j.optJSONArray("genres").strings().take(4)
                    if (genres.isNotEmpty()) Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        genres.forEach { Chip(it) }
                    }
                    j.str("tagline")?.let { Txt(it, text.padding(top = 12.dp), size = 16.sp, color = C.ink2, lines = 1) }
                    j.str("overview")?.let {
                        Txt(it, text.padding(top = 10.dp), size = 16.sp, lines = 4, lineHeight = 24.sp)
                    }
                    if (j.optBoolean("offline")) {
                        Txt("Il file è su un disco scollegato" + (j.str("disk")?.let { " ($it)" } ?: ""),
                            text.padding(top = 10.dp), color = C.warn, weight = FontWeight.SemiBold, lines = 2)
                    }
                }
            }
            // I pulsanti su una fila tutta loro, larga quanto lo schermo: ci stanno anche
            // quelli di un film iniziato e dentro una saga (se non bastasse, la fila scorre)
            Nearest {
                Row(
                    Modifier.padding(top = 24.dp, bottom = 10.dp).horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) { buttons() }
            }
        }
    }
}

/** Genere: un'etichetta piena e tenue, non si seleziona. */
@Composable
private fun Chip(text: String) {
    Box(Modifier.clip(RoundedCornerShape(6.dp)).background(C.surface2).padding(horizontal = 11.dp, vertical = 4.dp)) {
        Txt(text, size = 14.sp, color = C.ink2, weight = FontWeight.Medium)
    }
}

/** Un pulsante della scheda. [id] fisso: dopo «Segna come visto» o «La mia lista» la fila
 *  cambia (sparisce «Dall'inizio»), ma il fuoco resta sul pulsante appena premuto. */
private class B(val id: String, val label: String, val icon: ImageVector?, val primary: Boolean = false, val action: () -> Unit)

@Composable
private fun Buttons(
    act: MainActivity, j: JSONObject, s: Screen.Detail, first: FocusRequester,
    toast: (String) -> Unit, change: (String, JSONObject) -> Unit, onFocus: () -> Unit,
) {
    val all = mutableListOf<B>()
    fun fav(kind: String) {
        val fav = j.optBoolean("fav")
        all.add(B("fav", if (fav) "Nella mia lista" else "La mia lista", if (fav) Ic.check else Ic.plus) {
            change("/api/fav", JSONObject().put("kind", kind).put("id", j.optInt("id")).put("fav", !fav))
        })
    }
    when (s.kind) {
        "collection" -> {
            // Senza «up_next» (saga di un amico) si propone il primo film: la scheda ha
            // sempre un pulsante su cui entrare col fuoco
            val up = j.optJSONObject("up_next") ?: j.optJSONArray("items").objects().firstOrNull()
            if (up != null) all.add(B("play", "Guarda «${up.optString("title")}»", Ic.play, true) { act.play(up.optInt("id"), false, toast) })
        }
        "show" -> {
            val up = j.optJSONObject("up_next")
            if (up != null) {
                val ep = "S${up.optInt("season")} E${up.optInt("episode")}"
                val resume = up.optDouble("position") > 20 && !up.optBoolean("watched")
                all.add(B("play", if (resume) "Riprendi $ep" else "Guarda $ep", Ic.play, true) { act.play(up.optInt("id"), false, toast) })
            }
            fav("show")
        }
        else -> {
            val resume = j.optDouble("position") > 20 && !j.optBoolean("watched")
            all.add(B("play", if (resume) "Riprendi da ${clock(j.optDouble("position"))}" else "Riproduci", Ic.play, true) {
                act.play(s.id, false, toast)
            })
            if (resume) all.add(B("restart", "Dall'inizio", Ic.restart) { act.play(s.id, true, toast) })
            fav("movie")
            val w = j.optBoolean("watched")
            all.add(B("watched", if (w) "Visto" else "Segna come visto", if (w) Ic.check else Ic.eye) {
                change("/api/watched/${s.id}", JSONObject().put("watched", !w))
            })
            j.optJSONObject("collection")?.let { c ->
                all.add(B("saga", "Saga", Ic.sagas) { act.go(Screen.Detail("collection", c.optInt("id"))) })
            }
        }
    }
    all.forEachIndexed { n, b ->
        key(b.id) {
            Btn(b.label, if (n == 0) Modifier.focusRequester(first) else Modifier, b.icon, b.primary, onFocus, b.action)
        }
    }
}

/** Una sezione sotto l'intestazione: titolo, un riassunto accanto e il contenuto. */
@Composable
private fun Section(title: String, note: String?, content: @Composable () -> Unit) {
    Column(Modifier.padding(top = 30.dp)) {
        Row(Modifier.padding(start = Edge, bottom = 6.dp), verticalAlignment = Alignment.Bottom) {
            Title(title, size = 26.sp, lines = 1)
            if (!note.isNullOrEmpty()) Txt(note, Modifier.padding(start = 16.dp, bottom = 3.dp), color = C.ink2,
                weight = FontWeight.Medium)
        }
        content()
    }
}

/** Stagioni (schede in alto) ed episodi della stagione scelta, come miniature con trama. */
@Composable
private fun Episodes(act: MainActivity, j: JSONObject, toast: (String) -> Unit, onFocus: () -> Unit) {
    val seasons = j.optJSONArray("seasons").objects()
    val upSeason = j.optJSONObject("up_next")?.optInt("season")
    var sel by remember(j.optInt("id")) {
        mutableIntStateOf(seasons.indexOfFirst { it.optInt("season") == upSeason }.coerceAtLeast(0))
    }
    val todo = j.optInt("unwatched")
    val note = "${j.optInt("episodes")} episodi" + if (todo > 0 && todo < j.optInt("episodes")) " · $todo da vedere" else ""
    Section("Episodi", note) {
        if (seasons.size > 1) Pivot(Edge) {
            LazyRow(
                contentPadding = PaddingValues(start = Edge - 6.dp, end = 300.dp, top = 6.dp, bottom = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                itemsIndexed(seasons) { i, se ->
                    val n = se.optInt("season")
                    Focusable(shape = RoundedCornerShape(6.dp), scale = 1f, onFocus = { sel = i; onFocus() }, onClick = { sel = i }) { f ->
                        Box(Modifier.background(if (f) C.ink else if (i == sel) C.surface2 else Color.Transparent)
                            .padding(horizontal = 16.dp, vertical = 8.dp)) {
                            Txt(if (n == 0) "Speciali" else "Stagione $n", size = 16.sp,
                                color = if (f) C.bg else if (i == sel) C.ink else C.ink2,
                                weight = if (i == sel || f) FontWeight.Bold else FontWeight.Medium)
                        }
                    }
                }
            }
        }
        val eps = seasons[sel].optJSONArray("episodes").objects()
        val start = eps.indexOfFirst { it.optDouble("position") > 20 && !it.optBoolean("watched") }
            .takeIf { it >= 0 } ?: eps.indexOfFirst { !it.optBoolean("watched") }.coerceAtLeast(0)
        val state = rememberLazyListState(start)
        LaunchedEffect(sel) { state.scrollToItem(start) }
        Pivot(Edge) {
            LazyRow(
                Modifier.padding(top = 6.dp),
                state = state,
                contentPadding = PaddingValues(start = Edge, end = 600.dp, top = 10.dp, bottom = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                items(eps, key = { it.optInt("id") }) { e ->
                    EpisodeCard(e, onFocus) { act.play(e.optInt("id"), false, toast) }
                }
            }
        }
    }
}

private val EpW = 264.dp
private val EpH = 148.dp

@Composable
private fun EpisodeCard(e: JSONObject, onFocus: () -> Unit, onClick: () -> Unit) {
    val watched = e.optBoolean("watched")
    val dur = e.optDouble("duration", 0.0)
    val pos = e.optDouble("position", 0.0)
    val progress = if (dur > 0 && pos > 20 && !watched) (pos / dur).toFloat().coerceIn(0f, 1f) else 0f
    FocusBox(Modifier.width(EpW), onFocus = onFocus, onClick = onClick) { f ->
        Column {
            Box(Modifier.size(EpW, EpH).lift(f, 1.05f).clip(D.r).ring(f, D.r).background(C.surface2)) {
                Img(Api.image(e.str("thumb"), 780), Modifier.fillMaxSize(), EpW, EpH)
                if (watched) Seen(Modifier.align(Alignment.TopEnd))
                if (progress > 0) Progress(progress, Modifier.align(Alignment.BottomStart))
            }
            val n = e.optInt("episode")
            Txt((if (n > 0) "$n. " else "") + e.optString("title"), Modifier.padding(top = 12.dp), size = 16.sp,
                weight = FontWeight.SemiBold)
            val leftTxt = if (watched) null else left(dur, pos)
            Txt(leftTxt ?: (if (watched) "Visto" else if (dur > 0) length(dur) else ""), Modifier.padding(top = 2.dp),
                size = 14.sp, color = if (leftTxt != null) C.accentText else C.ink3, weight = FontWeight.Medium)
            e.str("overview")?.let {
                Txt(it, Modifier.padding(top = 6.dp), size = 14.sp, color = C.ink2, lines = 2, lineHeight = 20.sp)
            }
        }
    }
}

/** Interpreti: foto rotonde (o il volto con l'iniziale), nome e ruolo. */
@Composable
private fun Cast(people: List<JSONObject>, onFocus: () -> Unit) {
    Section("Cast", null) {
        Pivot(Edge) {
            LazyRow(
                contentPadding = PaddingValues(start = Edge, end = 600.dp, top = 10.dp, bottom = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(20.dp),
            ) {
                items(people) { p ->
                    val name = p.optString("name")
                    FocusBox(Modifier.width(116.dp), onFocus = onFocus, onClick = {}) { f ->
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Box(Modifier.size(104.dp).lift(f, 1.06f).clip(CircleShape).ring(f, CircleShape)) {
                                val photo = p.str("photo")
                                if (photo != null) {
                                    Box(Modifier.fillMaxSize().background(C.surface2))
                                    Img(Api.image(photo, 185), Modifier.fillMaxSize(), 104.dp, 104.dp, alignment = Alignment.TopCenter)
                                } else Face(name, 104.dp)
                            }
                            Txt(name, Modifier.padding(top = 12.dp), size = 15.sp, weight = FontWeight.SemiBold,
                                color = if (f) C.ink else C.ink, lines = 2, lineHeight = 19.sp)
                            p.str("role")?.let {
                                Txt(it, Modifier.padding(top = 2.dp), size = 13.sp, color = C.ink2, lines = 1)
                            }
                        }
                    }
                }
            }
        }
    }
}

/** Scheda in caricamento: le sagome di locandina, titolo e righe, ferme. */
@Composable
private fun DetailBones() {
    val h = (LocalConfiguration.current.screenHeightDp * 0.8f).dp
    Box(Modifier.fillMaxWidth().height(h)) {
        Column(Modifier.align(Alignment.BottomStart).padding(start = Edge, bottom = 8.dp)) {
            Row(verticalAlignment = Alignment.Bottom) {
                Bone(150.dp, 225.dp, Modifier.padding(end = 32.dp))
                Column {
                    Bone(360.dp, 40.dp)
                    Bone(240.dp, 18.dp, Modifier.padding(top = 14.dp))
                    Bone(520.dp, 16.dp, Modifier.padding(top = 18.dp))
                    Bone(500.dp, 16.dp, Modifier.padding(top = 8.dp))
                    Bone(440.dp, 16.dp, Modifier.padding(top = 8.dp))
                }
            }
            Row(Modifier.padding(top = 24.dp, bottom = 10.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Bone(170.dp, 44.dp); Bone(140.dp, 44.dp); Bone(150.dp, 44.dp)
            }
        }
    }
}

private fun detailMeta(j: JSONObject, kind: String): List<M> {
    val out = mutableListOf<M>()
    j.optInt("year").takeIf { it > 0 }?.let { y ->
        val to = j.optInt("year_to")
        out.add(M.Plain(if (to > y) "$y–$to" else "$y"))
    }
    when (kind) {
        "show" -> out.add(M.Plain(j.optInt("seasons_count").let { if (it == 1) "1 stagione" else "$it stagioni" }))
        "collection" -> out.add(M.Plain("${j.optInt("count")} film"))
        else -> j.optDouble("duration").takeIf { it > 0 }?.let { out.add(M.Plain(length(it))) }
    }
    j.optDouble("rating").takeIf { it > 0 }?.let { out.add(M.Rating(it)) }
    j.str("quality")?.let { out.add(M.Quality(it)) }
    if (kind == "movie" && !j.optBoolean("watched")) left(j.optDouble("duration", 0.0), j.optDouble("position", 0.0))?.let { out.add(M.Hot(it)) }
    return out
}

private fun clock(sec: Double): String {
    val t = sec.toInt()
    return if (t >= 3600) String.format("%d:%02d:%02d", t / 3600, t / 60 % 60, t % 60)
    else String.format("%d:%02d", t / 60, t % 60)
}
