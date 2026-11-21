package it.bunkerplex.tv

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor.AudioFormat
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * «Audio pulito»: di una traccia 5.1 tiene solo il canale centrale, su sinistra e destra.
 * Serve per le 5.1 col doppiaggio tutto nel centrale e, nei laterali, un fondo preso da
 * un'altra edizione che a volte contiene voci in un'altra lingua (es. Dragon Ball Z).
 * Le altre tracce (stereo, 7.1...) passano cosi' come sono.
 * Funziona solo sull'audio decodificato dall'app: il player lo attiva insieme a quello.
 */
@UnstableApi
class CenterOnlyProcessor : BaseAudioProcessor() {
    @Volatile var enabled = false

    override fun onConfigure(inputAudioFormat: AudioFormat): AudioFormat {
        val pcm = inputAudioFormat.encoding == C.ENCODING_PCM_16BIT || inputAudioFormat.encoding == C.ENCODING_PCM_FLOAT
        if (!enabled || !pcm || inputAudioFormat.channelCount != 6) return AudioFormat.NOT_SET
        return AudioFormat(inputAudioFormat.sampleRate, 2, inputAudioFormat.encoding)
    }

    override fun queueInput(inputBuffer: ByteBuffer) {
        val float = inputAudioFormat.encoding == C.ENCODING_PCM_FLOAT
        val size = if (float) 4 else 2
        val frames = inputBuffer.remaining() / (6 * size)
        val out = replaceOutputBuffer(frames * 2 * size).order(ByteOrder.nativeOrder())
        val input = inputBuffer.order(ByteOrder.nativeOrder())
        // Ordine dei canali di una 5.1: FL FR FC LFE SL SR (il centrale e' il terzo)
        repeat(frames) {
            val base = input.position()
            if (float) {
                val c = input.getFloat(base + 2 * size)
                out.putFloat(c).putFloat(c)
            } else {
                val c = input.getShort(base + 2 * size)
                out.putShort(c).putShort(c)
            }
            input.position(base + 6 * size)
        }
        out.flip()
    }
}
