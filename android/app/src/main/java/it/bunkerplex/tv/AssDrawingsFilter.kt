package it.bunkerplex.tv

import androidx.annotation.OptIn
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.Consumer
import androidx.media3.common.util.UnstableApi
import androidx.media3.extractor.text.CuesWithTiming
import androidx.media3.extractor.text.DefaultSubtitleParserFactory
import androidx.media3.extractor.text.SubtitleParser

/**
 * Sottotitoli ASS/SSA (tipici degli anime): oltre al testo possono contenere
 * disegni vettoriali (riquadri, maschere, cartelli del karaoke) scritti come
 * "{\p1}m 0 0 l 100 0 100 100 0 100{\p0}". Media3 non li sa disegnare e li
 * mostrava sullo schermo come testo ("m 0 0 l 0 1..."): qui si tolgono prima
 * che arrivino al lettore dei sottotitoli. Il resto (dialoghi, karaoke) resta.
 */
@OptIn(UnstableApi::class)
class AssDrawingsFilter(
    private val base: SubtitleParser.Factory = DefaultSubtitleParserFactory()
) : SubtitleParser.Factory {

    override fun supportsFormat(format: Format): Boolean = base.supportsFormat(format)

    override fun getCueReplacementBehavior(format: Format): Int = base.getCueReplacementBehavior(format)

    override fun create(format: Format): SubtitleParser {
        val parser = base.create(format)
        return if (format.sampleMimeType == MimeTypes.TEXT_SSA) NoDrawings(parser) else parser
    }

    private class NoDrawings(private val base: SubtitleParser) : SubtitleParser {
        override fun parse(
            data: ByteArray, offset: Int, length: Int,
            outputOptions: SubtitleParser.OutputOptions, output: Consumer<CuesWithTiming>
        ) {
            val text = String(data, offset, length, Charsets.UTF_8)
            if (!DRAWING_ON.containsMatchIn(text)) {      // il caso normale: nessun disegno
                base.parse(data, offset, length, outputOptions, output)
                return
            }
            val clean = text.lines().joinToString("\n") { stripDrawings(it) }.toByteArray(Charsets.UTF_8)
            base.parse(clean, 0, clean.size, outputOptions, output)
        }

        override fun getCueReplacementBehavior(): Int = base.getCueReplacementBehavior()

        override fun reset() = base.reset()
    }

    companion object {
        // \p seguito da un numero diverso da zero accende il disegno, \p0 lo spegne
        // (\pos, \pbo... non c'entrano: dopo la p non c'e' una cifra)
        private val DRAWING_ON = Regex("""\\p0*[1-9]""")
        private val P_TAG = Regex("""\\p(\d+)""")

        /** Toglie da una riga il testo scritto mentre il disegno e' acceso.
         *  I blocchi {...} restano: li toglie poi Media3, come sempre. */
        fun stripDrawings(line: String): String {
            if (line.indexOf('{') < 0) return line
            val out = StringBuilder(line.length)
            var drawing = false
            var i = 0
            while (i < line.length) {
                val c = line[i]
                if (c == '{') {
                    val end = line.indexOf('}', i)
                    if (end < 0) {                         // graffa mai chiusa: si lascia com'e'
                        if (!drawing) out.append(line, i, line.length)
                        break
                    }
                    P_TAG.findAll(line.substring(i, end + 1)).lastOrNull()?.let {
                        drawing = it.groupValues[1].trimStart('0').isNotEmpty()
                    }
                    out.append(line, i, end + 1)
                    i = end + 1
                } else {
                    if (!drawing) out.append(c)
                    i++
                }
            }
            return out.toString()
        }
    }
}
