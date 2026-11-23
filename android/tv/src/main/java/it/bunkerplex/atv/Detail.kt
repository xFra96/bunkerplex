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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
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
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

/** Scheda di un film, di una serie (stagioni ed episodi) o di una saga. */
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
        if (error != null) Centered(error!!) else Centered("Un momento…")
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

    val first = remember(s) { FocusRequester() }
    Box(Modifier.fillMaxSize()) {
        j.str("backdrop")?.let { bg ->
            Box(Modifier.align(Alignment.TopEnd).fillMaxWidth(0.7f).height(400.dp)) {
                Img(Api.image(bg, 780), Modifier.fillMaxSize(), 670.dp, 400.dp)
                Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(listOf(C.bg, Color(0x66060A07), Color.Transparent))))
                Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Color.Transparent, C.bg), startY = 450f)))
            }
        }
        LazyColumn(contentPadding = PaddingValues(top = 48.dp, bottom = 48.dp)) {
            item {
                Column(Modifier.padding(start = 56.dp).width(560.dp)) {
                    Txt(j.optString("title"), size = 32.sp, bold = true, lines = 2)
                    Txt(meta(j, s.kind), Modifier.padding(top = 8.dp), color = C.dim)
                    j.str("tagline")?.let { Txt(it, Modifier.padding(top = 10.dp), size = 15.sp, color = C.dim, lines = 2) }
                    Txt(j.optString("overview"), Modifier.padding(top = 12.dp), size = 15.sp, lines = 5)
                    if (j.optBoolean("offline")) {
                        Txt("Il file è su un disco scollegato" + (j.str("disk")?.let { " ($it)" } ?: ""),
                            Modifier.padding(top = 10.dp), color = C.accentLight, lines = 2)
                    }
                    Row(Modifier.padding(top = 22.dp, bottom = 22.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Buttons(act, j, s, first, toast, ::change)
                    }
                }
            }
            when (s.kind) {
                "show" -> item { Seasons(act, j, toast) }
                "collection" -> item {
                    val cards = j.optJSONArray("items").objects().map { Card.from(it) }
                    LazyRow(
                        contentPadding = PaddingValues(horizontal = 56.dp, vertical = 8.dp),
                        horizontalArrangement = Arrangement.spacedBy(16.dp),
                    ) {
                        items(cards, key = { it.id }) { c -> PosterCard(c) { act.go(Screen.Detail("movie", c.id)) } }
                    }
                }
                else -> {
                    val cast = j.optJSONArray("cast").objects()
                    if (cast.isNotEmpty()) item {
                        Txt("Cast: " + cast.take(8).joinToString(", ") { it.optString("name") },
                            Modifier.padding(start = 56.dp, end = 56.dp), size = 14.sp, color = C.dim, lines = 2)
                    }
                }
            }
        }
    }
    LaunchedEffect(s) { try { first.requestFocus() } catch (_: Exception) {} }
}

@Composable
private fun Buttons(
    act: MainActivity, j: JSONObject, s: Screen.Detail, first: FocusRequester,
    toast: (String) -> Unit, change: (String, JSONObject) -> Unit,
) {
    val fm = Modifier.focusRequester(first)
    when (s.kind) {
        "collection" -> {
            val up = j.optJSONObject("up_next")
            if (up != null) Btn("Guarda «${up.optString("title")}»", fm, primary = true) { act.play(up.optInt("id"), false, toast) }
        }
        "show" -> {
            val up = j.optJSONObject("up_next")
            if (up != null) {
                val ep = "S${up.optInt("season")} E${up.optInt("episode")}"
                val resume = up.optDouble("position") > 20 && !up.optBoolean("watched")
                Btn(if (resume) "Riprendi $ep" else "Guarda $ep", fm, primary = true) { act.play(up.optInt("id"), false, toast) }
            }
            FavBtn(j, "show", change)
        }
        else -> {
            val resume = j.optDouble("position") > 20 && !j.optBoolean("watched")
            Btn(if (resume) "Riprendi da ${clock(j.optDouble("position"))}" else "Riproduci", fm, primary = true) {
                act.play(s.id, false, toast)
            }
            if (resume) Btn("Dall'inizio") { act.play(s.id, true, toast) }
            FavBtn(j, "movie", change)
            val w = j.optBoolean("watched")
            Btn(if (w) "Segna da vedere" else "Segna come visto") {
                change("/api/watched/${s.id}", JSONObject().put("watched", !w))
            }
            j.optJSONObject("collection")?.let { c ->
                Btn("Saga") { act.go(Screen.Detail("collection", c.optInt("id"))) }
            }
        }
    }
}

@Composable
private fun FavBtn(j: JSONObject, kind: String, change: (String, JSONObject) -> Unit) {
    val fav = j.optBoolean("fav")
    Btn(if (fav) "Togli dalla lista" else "La mia lista") {
        change("/api/fav", JSONObject().put("kind", kind).put("id", j.optInt("id")).put("fav", !fav))
    }
}

/** Stagioni in alto, episodi della stagione scelta sotto. */
@Composable
private fun Seasons(act: MainActivity, j: JSONObject, toast: (String) -> Unit) {
    val seasons = j.optJSONArray("seasons").objects()
    if (seasons.isEmpty()) return
    val upSeason = j.optJSONObject("up_next")?.optInt("season")
    var sel by remember(j.optInt("id")) {
        mutableIntStateOf(seasons.indexOfFirst { it.optInt("season") == upSeason }.coerceAtLeast(0))
    }
    Column {
        if (seasons.size > 1) LazyRow(
            contentPadding = PaddingValues(horizontal = 50.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            itemsIndexed(seasons) { i, se ->
                val n = se.optInt("season")
                Focusable(shape = RoundedCornerShape(50), scale = 1f, onFocus = { sel = i }, onClick = { sel = i }) { f ->
                    Box(Modifier.background(if (f) C.text else if (i == sel) C.card else Color.Transparent)
                        .padding(horizontal = 16.dp, vertical = 7.dp)) {
                        Txt(if (n == 0) "Speciali" else "Stagione $n", color = if (f) C.bg else C.text, bold = i == sel)
                    }
                }
            }
        }
        val eps = seasons[sel].optJSONArray("episodes").objects()
        val cards = eps.map { Card.from(it) }
        val start = eps.indexOfFirst { it.optDouble("position") > 20 && !it.optBoolean("watched") }
            .takeIf { it >= 0 } ?: eps.indexOfFirst { !it.optBoolean("watched") }.coerceAtLeast(0)
        val state = rememberLazyListState(start)
        LaunchedEffect(sel) { state.scrollToItem(start) }
        LazyRow(
            Modifier.padding(top = 14.dp),
            state = state,
            contentPadding = PaddingValues(horizontal = 56.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            items(cards, key = { it.id }) { c ->
                // Nella scheda della serie il titolo e' quello dell'episodio
                val ep = c.copy(title = c.subtitle, subtitle = "")
                WideCard(ep) { act.play(c.id, false, toast) }
            }
        }
    }
}

private fun meta(j: JSONObject, kind: String): String {
    val parts = mutableListOf<String>()
    j.optInt("year").takeIf { it > 0 }?.let { y ->
        val to = j.optInt("year_to")
        parts.add(if (to > y) "$y–$to" else "$y")
    }
    when (kind) {
        "show" -> parts.add(j.optInt("seasons_count").let { if (it == 1) "1 stagione" else "$it stagioni" })
        "collection" -> parts.add("${j.optInt("count")} film")
        else -> j.optDouble("duration").takeIf { it > 0 }?.let { parts.add(length(it)) }
    }
    j.optDouble("rating").takeIf { it > 0 }?.let { parts.add("★ " + String.format("%.1f", it)) }
    j.str("quality")?.let { parts.add(it) }
    j.optJSONArray("genres").strings().take(3).takeIf { it.isNotEmpty() }?.let { parts.add(it.joinToString(", ")) }
    return parts.joinToString("  ·  ")
}

private fun length(sec: Double): String {
    val m = (sec / 60).toInt()
    return if (m >= 60) "${m / 60} h ${m % 60} min" else "$m min"
}

private fun clock(sec: Double): String {
    val t = sec.toInt()
    return if (t >= 3600) String.format("%d:%02d:%02d", t / 3600, t / 60 % 60, t % 60)
    else String.format("%d:%02d", t / 60, t % 60)
}
