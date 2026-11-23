package it.bunkerplex.atv

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import coil.request.ImageRequest

/** Colori di BunkerPlex (gli stessi dell'interfaccia web). */
object C {
    val bg = Color(0xFF060A07)
    val panel = Color(0xFF111813)
    val card = Color(0xFF18211B)
    val accent = Color(0xFF1A7F45)
    val accentLight = Color(0xFF3DDC84)
    val text = Color(0xFFF1F4F2)
    val dim = Color(0xFF9AA79F)
    val focus = Color.White
}

@Composable
fun Txt(
    text: String,
    modifier: Modifier = Modifier,
    size: TextUnit = 16.sp,
    color: Color = C.text,
    bold: Boolean = false,
    lines: Int = 1,
) = BasicText(
    text, modifier,
    style = TextStyle(color = color, fontSize = size, fontWeight = if (bold) FontWeight.SemiBold else FontWeight.Normal),
    maxLines = lines, overflow = TextOverflow.Ellipsis,
)

/** Immagine dal server, decodificata alla misura in cui si vede (meno memoria e meno lavoro). */
@Composable
fun Img(url: String?, modifier: Modifier, w: Dp, h: Dp) {
    if (url == null) return
    val ctx = LocalContext.current
    val density = androidx.compose.ui.platform.LocalDensity.current
    val pxW = with(density) { w.roundToPx() }
    val pxH = with(density) { h.roundToPx() }
    val req = remember(url) {
        ImageRequest.Builder(ctx).data(url).size(pxW, pxH).crossfade(false).build()
    }
    AsyncImage(model = req, contentDescription = null, modifier = modifier, contentScale = ContentScale.Crop)
}

/**
 * Riquadro che prende il fuoco col telecomando: bordo bianco e leggero ingrandimento,
 * senza animazioni (sulle chiavette lente ogni fotogramma conta).
 */
@Composable
fun Focusable(
    modifier: Modifier = Modifier,
    shape: RoundedCornerShape = RoundedCornerShape(6.dp),
    scale: Float = 1.06f,
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
            .graphicsLayer {
                val s = if (focused) scale else 1f
                scaleX = s; scaleY = s
            }
            .clip(shape)
            .then(if (focused) Modifier.border(3.dp, C.focus, shape) else Modifier)
            .clickable(interactionSource = source, indication = null, onClick = onClick)
    ) { content(focused) }
}

/** Pulsante della scheda (Riproduci, Dall'inizio, ...). */
@Composable
fun Btn(label: String, modifier: Modifier = Modifier, primary: Boolean = false, onClick: () -> Unit) {
    Focusable(modifier, RoundedCornerShape(50), scale = 1.04f, onClick = onClick) { f ->
        Box(
            Modifier
                .background(if (f) C.text else if (primary) C.accent else C.card)
                .padding(horizontal = 22.dp, vertical = 10.dp)
        ) { Txt(label, color = if (f) C.bg else C.text, bold = true) }
    }
}

/** Locandina verticale (film, serie, saghe). */
@Composable
fun PosterCard(c: Card, modifier: Modifier = Modifier, onFocus: (() -> Unit)? = null, onClick: () -> Unit) {
    Column(Modifier.width(128.dp)) {
        Focusable(modifier.size(128.dp, 192.dp), onFocus = onFocus, onClick = onClick) {
            Box(Modifier.fillMaxSize().background(C.card)) {
                if (c.poster != null) Img(Api.image(c.poster, 342), Modifier.fillMaxSize(), 128.dp, 192.dp)
                else Txt(c.title, Modifier.align(Alignment.Center).padding(8.dp), size = 14.sp, lines = 4)
                if (c.watched) Badge(Modifier.align(Alignment.TopEnd))
                if (c.progress > 0) Progress(c.progress, Modifier.align(Alignment.BottomStart))
            }
        }
        Txt(c.title, Modifier.padding(top = 6.dp), size = 13.sp, color = C.dim)
    }
}

/** Riquadro orizzontale (Continua a guardare, episodi). */
@Composable
fun WideCard(c: Card, modifier: Modifier = Modifier, onFocus: (() -> Unit)? = null, onClick: () -> Unit) {
    Column(Modifier.width(240.dp)) {
        Focusable(modifier.size(240.dp, 135.dp), onFocus = onFocus, onClick = onClick) {
            Box(Modifier.fillMaxSize().background(C.card)) {
                val img = c.wide ?: c.poster
                if (img != null) Img(Api.image(img, 780).takeIf { c.wide != null } ?: Api.image(img, 342), Modifier.fillMaxSize(), 240.dp, 135.dp)
                if (c.watched) Badge(Modifier.align(Alignment.TopEnd))
                if (c.progress > 0) Progress(c.progress, Modifier.align(Alignment.BottomStart))
            }
        }
        Txt(c.title, Modifier.padding(top = 6.dp), size = 14.sp)
        if (c.subtitle.isNotEmpty()) Txt(c.subtitle, size = 12.sp, color = C.dim)
    }
}

@Composable
fun Progress(p: Float, modifier: Modifier) {
    Box(modifier.fillMaxWidth().height(4.dp).background(Color(0x99000000))) {
        Box(Modifier.fillMaxWidth(p).fillMaxHeight().background(C.accentLight))
    }
}

@Composable
fun Badge(modifier: Modifier) {
    Box(
        modifier.padding(6.dp).clip(RoundedCornerShape(50)).background(C.accent)
            .padding(horizontal = 7.dp, vertical = 2.dp)
    ) { Txt("✓", size = 12.sp, bold = true) }
}

@Composable
fun Centered(text: String, sub: String? = null) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Txt(text, size = 22.sp, bold = true, lines = 3)
            if (sub != null) Txt(sub, Modifier.padding(top = 10.dp), color = C.dim, lines = 4)
        }
    }
}
