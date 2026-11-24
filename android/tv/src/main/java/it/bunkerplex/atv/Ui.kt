package it.bunkerplex.atv

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.BiasAlignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import coil.request.ImageRequest
import java.util.Locale

/** Colori di BunkerPlex (gli stessi dell'interfaccia web: un fondo, un inchiostro, un accento). */
object C {
    val bg = Color(0xFF060A07)
    val surface = Color(0xFF0E1510)
    val surface2 = Color(0xFF17211A)
    val ink = Color(0xFFF2F5F2)
    val ink2 = Color(0xFF9FADA3)
    val ink3 = Color(0xFF77857B)
    val accent = Color(0xFF1A7F45)
    val accentText = Color(0xFF4CBF7F)
    val warn = Color(0xFFE0A030)
    /** Velo scuro sotto i segni che stanno sopra le immagini (spunta, barra). */
    val veil = Color(0xD9060A07)
    /** Pulsanti secondari: bianco trasparente, come .btn sul web. */
    val btn = Color(0x24FFFFFF)
}

/** Misure comuni: menu a sinistra, margine del contenuto, locandine. */
object D {
    val rail = 76.dp
    val railOpen = 248.dp
    val pad = 32.dp
    val posterW = 124.dp
    val posterH = 186.dp
    val wideW = 256.dp
    val wideH = 144.dp
    val r = RoundedCornerShape(8.dp)
}

@Composable
fun Txt(
    text: String,
    modifier: Modifier = Modifier,
    size: TextUnit = 16.sp,
    color: Color = C.ink,
    weight: FontWeight = FontWeight.Normal,
    lines: Int = 1,
    lineHeight: TextUnit = TextUnit.Unspecified,
) = BasicText(
    text, modifier,
    style = TextStyle(color = color, fontSize = size, fontWeight = weight, lineHeight = lineHeight),
    maxLines = lines, overflow = TextOverflow.Ellipsis,
)

/** Titolo grande: pieno, stretto, poche righe. */
@Composable
fun Title(text: String, modifier: Modifier = Modifier, size: TextUnit = 36.sp, lines: Int = 2) = BasicText(
    text, modifier,
    style = TextStyle(
        color = C.ink, fontSize = size, fontWeight = FontWeight.ExtraBold,
        letterSpacing = (-0.02).em, lineHeight = 1.08.em,
    ),
    maxLines = lines, overflow = TextOverflow.Ellipsis,
)

/** Immagine dal server, decodificata alla misura in cui si vede (meno memoria e meno lavoro). */
@Composable
fun Img(
    url: String?, modifier: Modifier, w: Dp, h: Dp,
    fade: Int = 0, alignment: Alignment = Alignment.Center,
) {
    if (url == null) return
    val ctx = LocalContext.current
    val density = LocalDensity.current
    val pxW = with(density) { w.roundToPx() }
    val pxH = with(density) { h.roundToPx() }
    val req = remember(url, pxW, pxH) {
        ImageRequest.Builder(ctx).data(url).size(pxW, pxH).crossfade(fade).build()
    }
    AsyncImage(model = req, contentDescription = null, modifier = modifier,
        contentScale = ContentScale.Crop, alignment = alignment)
}

/** Gli sfondi si inquadrano un po' sopra il centro, dove di solito stanno i volti (come sul web). */
val UpperCenter = BiasAlignment(0f, -0.6f)

/**
 * Qualcosa che prende il fuoco col telecomando, senza aspetto suo: il contenuto
 * riceve se ha il fuoco e decide come mostrarlo.
 */
@Composable
fun FocusBox(
    modifier: Modifier = Modifier,
    onFocus: (() -> Unit)? = null,
    onClick: () -> Unit,
    content: @Composable (focused: Boolean) -> Unit,
) {
    var focused by remember { mutableStateOf(false) }
    val source = remember { MutableInteractionSource() }
    Box(
        modifier
            .onFocusChanged {
                focused = it.isFocused
                if (it.isFocused) onFocus?.invoke()
            }
            .clickable(interactionSource = source, indication = null, onClick = onClick)
    ) { content(focused) }
}

/** Anello chiaro attorno a cio' che ha il fuoco (locandine, volti, foto). */
fun Modifier.ring(on: Boolean, shape: Shape, width: Dp = 3.dp): Modifier =
    if (on) this.border(width, C.ink, shape) else this

/** Ingrandimento leggero di cio' che ha il fuoco: solo il livello grafico, nessun ricalcolo. */
fun Modifier.lift(on: Boolean, scale: Float): Modifier = graphicsLayer {
    val s = if (on) scale else 1f
    scaleX = s; scaleY = s
}

/**
 * Riquadro che prende il fuoco col telecomando: anello chiaro e leggero ingrandimento,
 * senza animazioni (sulle chiavette lente ogni fotogramma conta).
 */
@Composable
fun Focusable(
    modifier: Modifier = Modifier,
    shape: Shape = D.r,
    scale: Float = 1.07f,
    onFocus: (() -> Unit)? = null,
    onClick: () -> Unit,
    content: @Composable (focused: Boolean) -> Unit,
) {
    var focused by remember { mutableStateOf(false) }
    val source = remember { MutableInteractionSource() }
    Box(
        modifier
            .onFocusChanged {
                focused = it.isFocused
                if (it.isFocused) onFocus?.invoke()
            }
            .lift(focused, scale)
            .clip(shape)
            .ring(focused, shape)
            .clickable(interactionSource = source, indication = null, onClick = onClick)
    ) { content(focused) }
}

@Composable
fun Icon(v: ImageVector, tint: Color, size: Dp, modifier: Modifier = Modifier) =
    Image(rememberVectorPainter(v), null, modifier.size(size), colorFilter = ColorFilter.tint(tint))

/** Pulsante (Riproduci, La mia lista, ...): pieno, angoli appena smussati, icona a sinistra. */
@Composable
fun Btn(
    label: String,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    primary: Boolean = false,
    onFocus: (() -> Unit)? = null,
    onClick: () -> Unit,
) {
    Focusable(modifier, RoundedCornerShape(6.dp), scale = 1.05f, onFocus = onFocus, onClick = onClick) { f ->
        val fg = if (f) C.bg else C.ink
        Row(
            Modifier
                .background(if (f) C.ink else if (primary) C.accent else C.btn)
                .padding(start = if (icon != null) 16.dp else 20.dp, end = 20.dp, top = 11.dp, bottom = 11.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (icon != null) {
                Icon(icon, fg, 20.dp)
                Spacer(Modifier.width(10.dp))
            }
            Txt(label, color = fg, size = 17.sp, weight = FontWeight.Bold)
        }
    }
}

/** Il segno di BunkerPlex: quadrato verde con il triangolo di play. */
@Composable
fun Logo(size: Dp, modifier: Modifier = Modifier) =
    Image(rememberVectorPainter(Ic.logo), null, modifier.size(size))

/** Logo e nome, come nel menu del web: «Bunker» pieno, «Plex» leggero. */
@Composable
fun Wordmark(size: Dp = 34.dp, text: TextUnit = 22.sp) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Logo(size)
        Spacer(Modifier.width(12.dp))
        Txt("Bunker", size = text, weight = FontWeight.ExtraBold)
        Txt("Plex", size = text)
    }
}

/** Tinta stabile per un nome: la stessa formula del web, cosi' ognuno ha lo stesso colore ovunque. */
fun hue(s: String): Int {
    var h = 0
    for (ch in s) h = (h * 31 + ch.code) % 360
    return h
}

/** Volto di una persona: l'iniziale su una tinta tenue tutta sua (come .uface sul web). */
@Composable
fun Face(name: String, size: Dp, modifier: Modifier = Modifier, focused: Boolean = false) {
    val h = hue(name).toFloat()
    val bg = if (focused) C.ink else Color.hsl(h, 0.26f, 0.21f)
    val fg = if (focused) C.bg else Color.hsl(h, 0.62f, 0.80f)
    Box(modifier.size(size).clip(CircleShape).background(bg), contentAlignment = Alignment.Center) {
        Txt(name.trim().take(1).uppercase().ifEmpty { "?" }, size = (size.value * 0.42f).sp, color = fg,
            weight = FontWeight.Bold)
    }
}

/** Iniziali di una raccolta, come nel menu del web («Serie TV» → ST, «Film» → FI). */
fun initials(name: String): String {
    val words = name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
    return (if (words.size > 1) "${words[0].first()}${words[1].first()}" else name.trim().take(2)).uppercase()
}

/** Locandina verticale (film, serie, saghe). Nella Home senza didascalia: il titolo e' nell'anteprima. */
@Composable
fun PosterCard(
    c: Card,
    modifier: Modifier = Modifier,
    caption: Boolean = false,
    onFocus: (() -> Unit)? = null,
    onClick: () -> Unit,
) {
    if (!caption) {
        Focusable(modifier.size(D.posterW, D.posterH), onFocus = onFocus, onClick = onClick) { PosterArt(c) }
        return
    }
    FocusBox(modifier.width(D.posterW), onFocus = onFocus, onClick = onClick) { f ->
        Column {
            Box(Modifier.size(D.posterW, D.posterH).lift(f, 1.06f).clip(D.r).ring(f, D.r)) { PosterArt(c) }
            Txt(c.title, Modifier.padding(top = 10.dp), size = 14.sp, color = if (f) C.ink else C.ink2,
                weight = FontWeight.SemiBold)
            if (c.subtitle.isNotEmpty()) Txt(c.subtitle, Modifier.padding(top = 2.dp), size = 13.sp, color = C.ink3)
        }
    }
}

@Composable
private fun PosterArt(c: Card) {
    Box(Modifier.fillMaxSize().background(placeholder(c.hue))) {
        if (c.poster != null) Img(Api.image(c.poster, 342), Modifier.fillMaxSize(), D.posterW, D.posterH)
        else Txt(c.title, Modifier.align(Alignment.BottomStart).padding(12.dp), size = 15.sp,
            weight = FontWeight.Bold, lines = 4)
        if (c.watched) Seen(Modifier.align(Alignment.TopEnd))
        if (c.progress > 0) Progress(c.progress, Modifier.align(Alignment.BottomStart))
    }
}

/** Riquadro orizzontale (Continua a guardare, prossimi episodi). */
@Composable
fun WideCard(c: Card, modifier: Modifier = Modifier, onFocus: (() -> Unit)? = null, onClick: () -> Unit) {
    Focusable(modifier.size(D.wideW, D.wideH), onFocus = onFocus, onClick = onClick) {
        Box(Modifier.fillMaxSize().background(placeholder(c.hue))) {
            val img = c.wide ?: c.poster
            if (img != null) Img(if (c.wide != null) Api.image(img, 780) else Api.image(img, 342),
                Modifier.fillMaxSize(), D.wideW, D.wideH)
            else Txt(c.title, Modifier.align(Alignment.BottomStart).padding(12.dp), size = 15.sp,
                weight = FontWeight.Bold, lines = 2)
            if (c.watched) Seen(Modifier.align(Alignment.TopEnd))
            if (c.progress > 0) Progress(c.progress, Modifier.align(Alignment.BottomStart))
        }
    }
}

/** Fondo delle locandine senza immagine: una tinta scura per titolo, come sul web. */
fun placeholder(h: Int) = Color.hsl(h.toFloat(), 0.22f, 0.20f)

@Composable
fun Progress(p: Float, modifier: Modifier) {
    Box(modifier.fillMaxWidth().height(5.dp).background(C.veil)) {
        Box(Modifier.fillMaxWidth(p).fillMaxHeight().background(C.accentText))
    }
}

/** Gia' visto: spunta verde su un velo scuro, in alto a destra. */
@Composable
fun Seen(modifier: Modifier) {
    Box(
        modifier.padding(7.dp).size(26.dp).clip(RoundedCornerShape(5.dp)).background(C.veil),
        contentAlignment = Alignment.Center,
    ) { Icon(Ic.check, C.accentText, 18.dp) }
}

/** Etichetta piena e piccola (qualita' del video). */
@Composable
fun Tag(text: String) {
    Box(Modifier.clip(RoundedCornerShape(4.dp)).background(C.surface2).padding(horizontal = 7.dp, vertical = 2.dp)) {
        Txt(text, size = 13.sp, weight = FontWeight.Bold)
    }
}

/** Un pezzo della riga sotto il titolo: anno, durata, voto, qualita'... */
sealed class M {
    class Lead(val t: String) : M()
    class Plain(val t: String) : M()
    class Hot(val t: String) : M()
    class Rating(val v: Double) : M()
    class Quality(val t: String) : M()
}

@Composable
fun MetaLine(items: List<M>, modifier: Modifier = Modifier, size: TextUnit = 16.sp) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        items.forEach { m ->
            when (m) {
                is M.Lead -> Txt(m.t, size = size, weight = FontWeight.Bold)
                is M.Plain -> Txt(m.t, size = size, color = C.ink2, weight = FontWeight.Medium)
                is M.Hot -> Txt(m.t, size = size, color = C.accentText, weight = FontWeight.SemiBold)
                is M.Rating -> Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Ic.star, C.ink, (size.value + 1).dp)
                    Spacer(Modifier.width(5.dp))
                    Txt(rating(m.v), size = size, weight = FontWeight.Bold)
                }
                is M.Quality -> Tag(m.t)
            }
        }
    }
}

fun rating(v: Double) = String.format(Locale.ITALIAN, "%.1f", v)

fun length(sec: Double): String {
    val m = (sec / 60).toInt()
    return if (m >= 60) "${m / 60} h ${m % 60} min" else "$m min"
}

/** Quanto manca alla fine, per i titoli iniziati. */
fun left(duration: Double, position: Double): String? {
    if (duration <= 0 || position <= 20) return null
    val m = ((duration - position) / 60).toInt().coerceAtLeast(1)
    return if (m >= 60) "mancano ${m / 60} h ${m % 60} min" else "mancano $m min"
}

/** Sagome di caricamento: blocchi fermi nel colore delle superfici, nessuna animazione. */
@Composable
fun Bone(w: Dp, h: Dp, modifier: Modifier = Modifier) =
    Box(modifier.size(w, h).clip(RoundedCornerShape(6.dp)).background(C.surface))

@Composable
fun Centered(text: String, sub: String? = null) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Logo(48.dp, Modifier.padding(bottom = 22.dp))
            Txt(text, size = 22.sp, weight = FontWeight.Bold, lines = 3)
            if (sub != null) Txt(sub, Modifier.padding(top = 10.dp), color = C.ink2, lines = 4)
        }
    }
}

/** Icone disegnate a mano (le stesse del web), senza librerie in piu'. */
object Ic {
    private fun line(vararg d: String, w: Float = 1.8f) = ImageVector.Builder(
        defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f,
    ).apply {
        d.forEach {
            addPath(addPathNodes(it), fill = null, stroke = SolidColor(Color.White), strokeLineWidth = w,
                strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round)
        }
    }.build()

    private fun solid(d: String) = ImageVector.Builder(
        defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f,
    ).apply { addPath(addPathNodes(d), fill = SolidColor(Color.White)) }.build()

    val home by lazy { line("M3 11.5 12 4l9 7.5M5.5 10v9.5h4.8v-5.6h3.4v5.6h4.8V10") }
    val search by lazy { line("M17.5 11a6.5 6.5 0 1 1-13 0a6.5 6.5 0 1 1 13 0z", "m16 16 4.5 4.5") }
    val list by lazy { line("M6.5 4h11v16.5L12 16.6l-5.5 3.9z") }
    val sagas by lazy {
        line("M10.1 3.5h7.8a1.6 1.6 0 0 1 1.6 1.6v10.8a1.6 1.6 0 0 1-1.6 1.6h-7.8a1.6 1.6 0 0 1-1.6-1.6V5.1a1.6 1.6 0 0 1 1.6-1.6z",
            "M4.5 7.5v11.4c0 .9.7 1.6 1.6 1.6h9.4")
    }
    val gear by lazy {
        line("M15 12a3 3 0 1 1-6 0a3 3 0 1 1 6 0z",
            "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z")
    }
    val play by lazy { solid("M7.5 4.8v14.4a.8.8 0 0 0 1.2.7l11.6-7.2a.8.8 0 0 0 0-1.4L8.7 4.1a.8.8 0 0 0-1.2.7z") }
    val restart by lazy { line("M4.5 12a7.5 7.5 0 1 0 2.2-5.3", "M4.5 4v4.5H9", w = 2.2f) }
    val plus by lazy { line("M12 5v14M5 12h14", w = 2.4f) }
    val check by lazy { line("m5 12.5 4.5 4.5L19 7.5", w = 2.6f) }
    val eye by lazy { line("M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z", "M14.5 12a2.5 2.5 0 1 1-5 0a2.5 2.5 0 1 1 5 0z") }
    val lock by lazy { line("M6.5 11h11v9h-11z", "M8.5 11V8a3.5 3.5 0 0 1 7 0v3", w = 2f) }
    val star by lazy { solid("M12 3.2l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z") }
    val logo by lazy {
        ImageVector.Builder(defaultWidth = 64.dp, defaultHeight = 64.dp, viewportWidth = 64f, viewportHeight = 64f).apply {
            addPath(addPathNodes("M14 0h36a14 14 0 0 1 14 14v36a14 14 0 0 1-14 14H14A14 14 0 0 1 0 50V14A14 14 0 0 1 14 0z"),
                fill = SolidColor(C.accent))
            addPath(addPathNodes("M25 18l22 14-22 14z"), fill = SolidColor(Color.White))
        }.build()
    }
}
