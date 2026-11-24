@file:OptIn(ExperimentalFoundationApi::class)

package it.bunkerplex.atv

import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.gestures.BringIntoViewSpec
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp

/**
 * Scorrimento col telecomando.
 *
 * Chi ha il fuoco si porta sempre nello stesso punto (le schede allineate a sinistra,
 * le file della Home alla stessa altezza), come sul web: l'occhio sa dove guardare e
 * la pagina fa un solo movimento prevedibile, invece di inseguire il bordo dello schermo.
 *
 * Il movimento e' una molla senza rimbalzo: se arriva una nuova pressione a meta'
 * strada riparte dalla velocita' che ha, senza scatti. Con il tasto tenuto premuto la
 * molla e' piu' rigida, cosi' segue da vicino e si ferma subito al rilascio.
 */
object Keys {
    /** Freccia tenuta premuta (ripetizioni del telecomando): la scrive MainActivity. */
    @Volatile
    var held = false
}

private val Calm: AnimationSpec<Float> = spring(dampingRatio = Spring.DampingRatioNoBouncy, stiffness = 650f)
private val Quick: AnimationSpec<Float> = spring(dampingRatio = Spring.DampingRatioNoBouncy, stiffness = 2200f)

/** Porta l'elemento col fuoco a [pivotPx] dal bordo d'inizio (sinistro nelle file, alto nelle colonne). */
private class PivotSpec(private val pivotPx: Float) : BringIntoViewSpec {
    override val scrollAnimationSpec: AnimationSpec<Float>
        get() = if (Keys.held) Quick else Calm

    override fun calculateScrollDistance(offset: Float, size: Float, containerSize: Float): Float = offset - pivotPx
}

/** Non scorre da solo: lo scorrimento lo decide la schermata (vedi la scheda). */
private object StillSpec : BringIntoViewSpec {
    override val scrollAnimationSpec: AnimationSpec<Float> get() = Calm
    override fun calculateScrollDistance(offset: Float, size: Float, containerSize: Float): Float = 0f
}

/** Scorre il minimo per far vedere tutto l'elemento col fuoco (file corte, come i pulsanti). */
private object NearestSpec : BringIntoViewSpec {
    override val scrollAnimationSpec: AnimationSpec<Float> get() = Calm
    override fun calculateScrollDistance(offset: Float, size: Float, containerSize: Float): Float {
        val end = offset + size
        return when {
            offset >= 0 && end <= containerSize -> 0f
            offset < 0 && end > containerSize -> 0f
            offset < 0 -> offset
            else -> end - containerSize
        }
    }
}

@Composable
fun Nearest(content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalBringIntoViewSpec provides NearestSpec, content = content)
}

/** Le liste dentro [content] tengono l'elemento col fuoco a [pivot] dal loro bordo d'inizio. */
@Composable
fun Pivot(pivot: Dp, content: @Composable () -> Unit) {
    val px = with(LocalDensity.current) { pivot.toPx() }
    val spec = remember(px) { PivotSpec(px) }
    CompositionLocalProvider(LocalBringIntoViewSpec provides spec, content = content)
}

/** Le liste dentro [content] non scorrono da sole quando cambia il fuoco. */
@Composable
fun Still(content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalBringIntoViewSpec provides StillSpec, content = content)
}
