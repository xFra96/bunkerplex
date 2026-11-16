package it.francoplex.tv

import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.annotation.OptIn
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.SeekParameters
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import androidx.media3.ui.SubtitleView
import org.json.JSONObject
import java.util.Locale
import kotlin.concurrent.thread

/**
 * Player nativo (ExoPlayer): legge direttamente MKV/MP4 con audio e
 * sottotitoli interni. Se la TV non supporta il formato, chiede al server
 * la conversione al volo.
 */
@OptIn(UnstableApi::class)
class PlayerActivity : AppCompatActivity() {

    private lateinit var server: String
    private lateinit var playerView: PlayerView
    private lateinit var titleView: TextView
    private lateinit var osd: TextView
    private val prefs by lazy { getSharedPreferences("francoplex", MODE_PRIVATE) }

    private var player: ExoPlayer? = null
    private var data = JSONObject()

    // Letto anche dal thread che scarica il video (vedi 'loadPolicy')
    @Volatile
    private var transcoding = false

    // In conversione: true = il PC copia il video cosi' com'e' (la TV lo sa decodificare,
    // andava cambiato solo l'audio o il contenitore). Non impegna il processore del PC.
    private var videoCopy = false
    private var offsetMs = 0L          // in conversione: posizione reale = offset + orologio del player
    private var pendingSeek = -1L      // salto richiesto ma non ancora eseguito
    private var finished = false

    // In conversione la lingua la sceglie il PC: elenco delle tracce e quella in uso
    private var serverAudio = 0
    private var serverAudios = listOf<String>()

    // Controllo anti-blocco
    private var lastPos = -1L
    private var lastMoveAt = 0L
    private var recoveries = 0
    private var recoveredAt = 0L
    private var softRetried = false
    private var endedAt = -1L

    // Opzioni
    private var audioCompat = false     // audio decodificato dall'app invece che dalla TV
    private var sleepAt = 0L
    private var sleepAtEnd = false
    private var visible = false

    private val handler = Handler(Looper.getMainLooper())
    private val ticker = object : Runnable {
        override fun run() {
            report(false)
            handler.postDelayed(this, 10_000)
        }
    }
    private val hideOsd = Runnable { osd.visibility = View.GONE }
    private val applySeek = Runnable {
        val target = pendingSeek
        pendingSeek = -1
        val p = player
        if (target >= 0 && p != null) {
            lastMoveAt = SystemClock.elapsedRealtime()
            if (transcoding) open(data, target, true) else p.seekTo(target)
        }
    }

    /** Ogni secondo: spegnimento automatico e ripartenza se il video resta fermo. */
    private val watchdog = object : Runnable {
        override fun run() {
            handler.postDelayed(this, 1000)
            val p = player ?: return
            val now = SystemClock.elapsedRealtime()
            if (sleepAt in 1..now) {
                sleepAt = 0
                p.pause()
                playerView.showController()
                Toast.makeText(this@PlayerActivity, "Spegnimento automatico: video in pausa", Toast.LENGTH_LONG).show()
            }
            val pos = p.currentPosition
            val state = p.playbackState
            val waiting = !p.playWhenReady || state == Player.STATE_ENDED || state == Player.STATE_IDLE ||
                pendingSeek >= 0 || finished
            if (waiting || pos != lastPos) {
                if (pos != lastPos && recoveries > 0 && now - recoveredAt > 30_000) {
                    recoveries = 0
                    softRetried = false
                }
                lastPos = pos
                lastMoveAt = now
                return
            }
            // Dovrebbe andare ma e' fermo: in caricamento si aspetta di piu' (la conversione
            // su un PC lento ci mette a partire); se invece risulta "pronto" e non avanza,
            // di solito e' l'uscita audio della TV rimasta bloccata dopo una pausa o un salto.
            val stuckReady = state == Player.STATE_READY
            val limit = if (stuckReady) 6_000L else if (transcoding) 45_000L else 20_000L
            if (now - lastMoveAt < limit) return
            lastMoveAt = now
            if (recoveries >= 3) {
                p.pause()
                playerView.showController()
                showOsd("Il video non riparte: premi OK per riprovare", 6000)
                recoveries = 0
                return
            }
            recoveries++
            recoveredAt = now
            showOsd("Riprendo la riproduzione…", 2500)
            if (stuckReady && recoveries >= 2 && !audioCompat) {
                audioCompat = true          // solo per questa visione
                rebuildPlayer()
            } else {
                open(data, realPosition(), transcoding)
            }
        }
    }

    /** Il flusso convertito non si puo' riprendere "dal byte X": se cade si riapre
     *  dal punto giusto (lo fa onPlayerError), senza i tentativi automatici che
     *  farebbero rifare al PC tutta la conversione dall'inizio. */
    private val loadPolicy = object : DefaultLoadErrorHandlingPolicy() {
        override fun getRetryDelayMsFor(loadErrorInfo: LoadErrorHandlingPolicy.LoadErrorInfo): Long =
            if (transcoding) C.TIME_UNSET else super.getRetryDelayMsFor(loadErrorInfo)

        override fun getMinimumLoadableRetryCount(dataType: Int): Int =
            if (transcoding) 0 else super.getMinimumLoadableRetryCount(dataType)
    }

    /** Quello che vedono i comandi a schermo: posizione e durata vere anche in
     *  conversione (dove il flusso riparte da zero a ogni salto) e salti raggruppati. */
    private inner class Front(p: ExoPlayer) : ForwardingPlayer(p) {
        private fun shown(inner: Long): Long =
            if (pendingSeek >= 0) pendingSeek else if (transcoding) offsetMs + inner else inner

        override fun getAvailableCommands(): Player.Commands {
            val commands = super.getAvailableCommands()
            if (!transcoding) return commands
            return commands.buildUpon()
                .remove(Player.COMMAND_GET_TIMELINE)
                .addAll(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM, Player.COMMAND_SEEK_BACK, Player.COMMAND_SEEK_FORWARD)
                .build()
        }

        override fun isCommandAvailable(command: Int): Boolean = availableCommands.contains(command)
        override fun isCurrentMediaItemSeekable(): Boolean = transcoding || super.isCurrentMediaItemSeekable()
        override fun getCurrentPosition(): Long = shown(super.getCurrentPosition())
        override fun getContentPosition(): Long = shown(super.getContentPosition())
        override fun getBufferedPosition(): Long =
            if (transcoding) offsetMs + super.getBufferedPosition() else super.getBufferedPosition()

        override fun getContentBufferedPosition(): Long =
            if (transcoding) offsetMs + super.getContentBufferedPosition() else super.getContentBufferedPosition()

        override fun getDuration(): Long = if (transcoding) knownDuration() else super.getDuration()
        override fun getContentDuration(): Long = if (transcoding) knownDuration() else super.getContentDuration()
        override fun seekTo(positionMs: Long) = seekAbs(positionMs, null)
        override fun seekTo(mediaItemIndex: Int, positionMs: Long) = seekAbs(positionMs, null)
        override fun seekBack() = seekBy(-stepBack())
        override fun seekForward() = seekBy(stepForward())

        private fun knownDuration(): Long = durationMs().let { if (it > 0) it else C.TIME_UNSET }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val base = intent.getStringExtra("server")
        if (base == null) {
            finish()
            return
        }
        server = base
        JSONObject(intent.getStringExtra("data") ?: "{}").optString("session").let { if (it.isNotEmpty()) Net.session = it }
        audioCompat = prefs.getBoolean("p_audio_compat", false)
        buildLayout()
        buildPlayer()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // Con i comandi a schermo: Indietro li nasconde. Altrimenti esce.
                val playing = player?.playWhenReady == true
                if (playerView.isControllerFullyVisible && playing) playerView.hideController() else finish()
            }
        })

        open(JSONObject(intent.getStringExtra("data") ?: "{}"), null, false)
        showOsd("OK: pausa   ◀ ▶: salta   ▲: opzioni", 4500)
    }

    private fun buildPlayer() {
        // Prima i decodificatori della TV (video 4K/HDR in hardware, audio che conosce);
        // per l'audio che la TV non conosce subentra quello interno all'app.
        // "Audio compatibile": l'audio lo decodifica sempre l'app, per le TV la cui
        // uscita audio si inceppa dopo una pausa o un salto.
        val renderers = DefaultRenderersFactory(this)
            .setEnableDecoderFallback(true)
            .setExtensionRendererMode(
                if (audioCompat) DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER
                else DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON
            )
        // Partenza e ripresa dopo un salto appena c'e' un secondo di video pronto,
        // poi fino a un minuto di scorta (utile con i 4K su Wi-Fi). La scorta non supera
        // mai un terzo della memoria dell'app: con i 4K molto pesanti la riempiva
        // tutta e la TV si piantava. Restano in memoria anche gli ultimi 20 secondi
        // gia' visti, cosi' tornare un po' indietro e' immediato.
        val budget = (Runtime.getRuntime().maxMemory() / 3).coerceIn(24L shl 20, 160L shl 20).toInt()
        val load = DefaultLoadControl.Builder()
            .setBufferDurationsMs(20_000, 60_000, 1_000, 2_500)
            .setTargetBufferBytes(budget)
            .setBackBuffer(20_000, true)
            .build()
        // La conversione su un PC lento puo' metterci un po' a mandare i primi dati
        val http = DefaultHttpDataSource.Factory()
            .setConnectTimeoutMs(10_000)
            .setReadTimeoutMs(30_000)
        // Il video arriva solo a chi e' entrato con un account: si usa il suo gettone
        if (Net.session.isNotEmpty()) http.setDefaultRequestProperties(mapOf("X-BP-Session" to Net.session))
        val sources = DefaultMediaSourceFactory(DefaultDataSource.Factory(this, http))
            .setLoadErrorHandlingPolicy(loadPolicy)
        val p = ExoPlayer.Builder(this, renderers)
            .setMediaSourceFactory(sources)
            .setLoadControl(load)
            .build()
        p.setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                .build(),
            true
        )
        // I salti partono dal fotogramma chiave precedente: niente attese a decodificare
        // secondi di video (pesante con i 4K) solo per arrivare al punto esatto.
        p.setSeekParameters(SeekParameters.PREVIOUS_SYNC)
        // Se il file ha piu' lingue, parte con quella della TV
        p.trackSelectionParameters = p.trackSelectionParameters.buildUpon()
            .setPreferredAudioLanguage(Locale.getDefault().language)
            .build()
        p.addListener(listener)
        playerView.player = Front(p)
        player = p
        applyLook()
    }

    /** Ricrea il player (serve per cambiare il modo dell'audio) e riparte dallo stesso punto. */
    private fun rebuildPlayer() {
        val old = player ?: return
        val at = realPosition()
        val speed = old.playbackParameters.speed
        handler.removeCallbacks(applySeek)
        pendingSeek = -1
        old.removeListener(listener)
        playerView.player = null
        old.release()
        player = null
        buildPlayer()
        player?.setPlaybackSpeed(speed)
        open(data, at, transcoding)
    }

    private fun dp(value: Int): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).toInt()

    private fun buildLayout() {
        val root = FrameLayout(this)
        root.setBackgroundColor(Color.BLACK)

        playerView = PlayerView(this)
        playerView.setShowSubtitleButton(true)
        playerView.setShowNextButton(false)
        playerView.setShowPreviousButton(false)
        playerView.controllerShowTimeoutMs = 4000
        playerView.keepScreenOn = true
        root.addView(playerView, FrameLayout.LayoutParams(-1, -1))
        // L'ingranaggio della barra apre le nostre Opzioni (audio, sottotitoli, velocita',
        // formato, spegnimento...) invece del menu ridotto di Media3.
        playerView.findViewById<View>(androidx.media3.ui.R.id.exo_settings)?.let { gear ->
            gear.setOnClickListener { showOptions() }
            gear.contentDescription = "Opzioni"
        }

        titleView = TextView(this)
        titleView.setTextColor(Color.WHITE)
        titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
        titleView.typeface = Typeface.DEFAULT_BOLD
        titleView.setShadowLayer(8f, 0f, 2f, Color.BLACK)
        titleView.setPadding(dp(40), dp(28), dp(40), 0)
        titleView.visibility = View.GONE
        root.addView(titleView, FrameLayout.LayoutParams(-1, -2, Gravity.TOP))

        osd = TextView(this)
        osd.setTextColor(Color.WHITE)
        osd.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
        osd.typeface = Typeface.DEFAULT_BOLD
        osd.setBackgroundColor(Color.argb(190, 11, 15, 26))
        osd.setPadding(dp(22), dp(10), dp(22), dp(10))
        osd.visibility = View.GONE
        val osdParams = FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL)
        osdParams.bottomMargin = dp(70)
        root.addView(osd, osdParams)

        playerView.setControllerVisibilityListener(PlayerView.ControllerVisibilityListener { visibility ->
            titleView.visibility = visibility
            if (visibility == View.VISIBLE) osd.visibility = View.GONE
        })
        setContentView(root)
        playerView.requestFocus()
    }

    private fun showOsd(text: String, ms: Long = 1800) {
        osd.text = text
        osd.visibility = View.VISIBLE
        handler.removeCallbacks(hideOsd)
        handler.postDelayed(hideOsd, ms)
    }

    private fun abs(path: String) = if (path.startsWith("http")) path else server + path

    /** Avvia un video. startMs = null usa il punto salvato sul server. */
    private fun open(d: JSONObject, startMs: Long?, useTranscode: Boolean) {
        val p = player ?: return
        if (d.optInt("id") != data.optInt("id")) {      // un altro video: si riparte puliti
            serverAudio = 0
            serverAudios = listOf()
            endedAt = -1
            recoveries = 0
            softRetried = false
        }
        data = d
        d.optString("session").let { if (it.isNotEmpty() && it != Net.session) Net.session = it }
        finished = false
        transcoding = useTranscode
        handler.removeCallbacks(applySeek)
        pendingSeek = -1
        lastMoveAt = SystemClock.elapsedRealtime()
        val start = (startMs ?: (d.optDouble("start", 0.0) * 1000).toLong()).coerceAtLeast(0)

        val title = d.optString("title")
        val subtitle = d.optString("subtitle")
        titleView.text = if (subtitle.isBlank()) title else "$title\n$subtitle"

        val uri: String
        if (useTranscode) {
            offsetMs = start
            uri = abs(d.optString("transcode")) + "?start=" + String.format(Locale.US, "%.1f", start / 1000.0) +
                (if (videoCopy) "&vcopy=1" else "") + (if (serverAudio > 0) "&audio=$serverAudio" else "")
            if (serverAudios.isEmpty()) loadServerAudios(d.optInt("id"))
        } else {
            offsetMs = 0
            uri = abs(d.optString("url"))
        }

        val subs = mutableListOf<MediaItem.SubtitleConfiguration>()
        val list = d.optJSONArray("subs")
        if (list != null) {
            for (i in 0 until list.length()) {
                val s = list.getJSONObject(i)
                var subUrl = abs(s.optString("url"))
                if (useTranscode) subUrl += "?offset=" + String.format(Locale.US, "%.1f", start / 1000.0)
                subs.add(
                    MediaItem.SubtitleConfiguration.Builder(Uri.parse(subUrl))
                        .setMimeType(MimeTypes.TEXT_VTT)
                        .setLabel(s.optString("label", "Sottotitoli"))
                        .setLanguage(s.optString("lang").ifBlank { null })
                        .build()
                )
            }
        }

        val item = MediaItem.Builder().setUri(uri).setSubtitleConfigurations(subs).build()
        p.setMediaItem(item, if (useTranscode) 0L else start)
        p.prepare()
        p.playWhenReady = true
    }

    /** In conversione le lingue non si leggono dal flusso (ne arriva una sola): le elenca il PC. */
    private fun loadServerAudios(id: Int) {
        thread {
            try {
                val list = JSONObject(Net.get("$server/api/tracks/$id")).optJSONArray("audio") ?: return@thread
                val labels = (0 until list.length()).map { list.getJSONObject(it).optString("label", "Traccia ${it + 1}") }
                runOnUiThread { if (data.optInt("id") == id) serverAudios = labels }
            } catch (_: Exception) {
            }
        }
    }

    private val listener = object : Player.Listener {
        override fun onPlaybackStateChanged(state: Int) {
            if (state == Player.STATE_ENDED) onEnded()
        }

        override fun onPlayerError(error: PlaybackException) {
            val at = realPosition()
            val code = error.errorCode
            val network = code == PlaybackException.ERROR_CODE_IO_UNSPECIFIED ||
                code == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED ||
                code == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT
            val missing = code == PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS ||
                code == PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND
            // Decodificatore o uscita audio inciampati a meta' video (capita dopo salti e pause)
            val hiccup = code in 4000..5999 && at - (if (transcoding) offsetMs else 0) > 3000
            when {
                // Collegamento caduto (per esempio dopo una pausa lunga): non e' un problema
                // di formato, si riprende dallo stesso punto senza passare alla conversione.
                network && recoveries < 4 -> {
                    recoveries++
                    recoveredAt = SystemClock.elapsedRealtime()
                    showOsd("Collegamento perso: riprovo…", 4000)
                    val id = data.optInt("id")
                    handler.postDelayed({
                        if (player != null && !isFinishing && data.optInt("id") == id) open(data, at, transcoding)
                    }, 1200L * recoveries)
                }
                network || missing -> {
                    val message = if (missing) "Il PC non trova il file: controlla che il disco sia collegato"
                    else "Il PC non risponde: controlla che sia acceso e riprova"
                    Toast.makeText(this@PlayerActivity, message, Toast.LENGTH_LONG).show()
                    finish()
                }
                hiccup && !softRetried -> {
                    softRetried = true
                    recoveredAt = SystemClock.elapsedRealtime()
                    recoveries = recoveries.coerceAtLeast(1)
                    if (code >= 5000 && !audioCompat) {
                        audioCompat = true      // solo per questa visione
                        rebuildPlayer()
                    } else {
                        open(data, at, transcoding)
                    }
                }
                !transcoding -> fallbackToTranscode(true)
                videoCopy -> {
                    // Nemmeno con il video copiato: conversione completa
                    videoCopy = false
                    open(data, at, true)
                }
                else -> {
                    Toast.makeText(this@PlayerActivity, "Impossibile riprodurre questo video", Toast.LENGTH_LONG).show()
                    finish()
                }
            }
        }

        override fun onTracksChanged(tracks: Tracks) {
            applyPendingSub()
            if (transcoding && !videoCopy) return
            var hasVideo = false
            var videoOk = false
            var hasAudio = false
            var audioOk = false
            for (group in tracks.groups) {
                when (group.type) {
                    C.TRACK_TYPE_VIDEO -> {
                        hasVideo = true
                        if (group.isSupported) videoOk = true
                    }
                    C.TRACK_TYPE_AUDIO -> {
                        hasAudio = true
                        if (group.isSupported) audioOk = true
                    }
                }
            }
            // Video o audio in un formato che questa TV non sa decodificare
            if (transcoding) {
                if (hasVideo && !videoOk) {
                    videoCopy = false
                    open(data, realPosition(), true)
                }
                return
            }
            // Se la TV decodifica il video e le manca solo l'audio, il PC converte solo quello
            if ((hasVideo && !videoOk) || (hasAudio && !audioOk)) fallbackToTranscode(!hasVideo || videoOk)
        }
    }

    private fun fallbackToTranscode(keepVideo: Boolean) {
        val position = realPosition()
        videoCopy = keepVideo
        val at = if (position < 1000) (data.optDouble("start", 0.0) * 1000).toLong() else position
        Toast.makeText(this, "Formato non supportato dalla TV: lo converto al volo…", Toast.LENGTH_LONG).show()
        open(data, at, true)
    }

    private fun realPosition(): Long {
        val p = player ?: return 0
        if (pendingSeek >= 0) return pendingSeek
        return if (transcoding) offsetMs + p.currentPosition else p.currentPosition
    }

    private fun durationMs(): Long {
        val fromServer = (data.optDouble("duration", 0.0) * 1000).toLong()
        if (fromServer > 0) return fromServer
        if (transcoding) return 0
        val d = player?.duration ?: C.TIME_UNSET
        return if (d == C.TIME_UNSET) 0 else d
    }

    private fun report(ended: Boolean) {
        if (player == null || finished) return
        val position = realPosition()
        if (!ended && position < 5000) return
        val body = JSONObject()
            .put("position", position / 1000.0)
            .put("duration", durationMs() / 1000.0)
            .put("ended", ended)
        Net.postAsync("$server/api/progress/${data.optInt("id")}", body.toString())
    }

    private fun onEnded() {
        val duration = durationMs()
        val position = realPosition()
        // Un flusso convertito che si interrompe prima della fine non e' la fine del film:
        // si riprende da li'. Se riprovando si ferma di nuovo nello stesso punto, si esce
        // salvando la posizione (senza segnarlo come "visto").
        if (transcoding && duration > 0 && position < duration * 0.9) {
            if (endedAt < 0 || kotlin.math.abs(endedAt - position) > 3000) {
                endedAt = position
                showOsd("Riprendo la riproduzione…", 2500)
                open(data, position, true)
            } else {
                report(false)
                finish()
            }
            return
        }
        report(true)
        finished = true
        val next = data.optInt("next", 0)
        val saga = data.optJSONObject("saga")
        if (next <= 0 && saga != null && !sleepAtEnd && !isFinishing) {
            // Fine di un film di una saga: il successivo si propone, non parte da solo
            AlertDialog.Builder(this)
                .setTitle("Saga ${saga.optString("name")} · film ${saga.optInt("number")} di ${saga.optInt("count")}")
                .setMessage("Vuoi guardare ${sagaLabel(saga)}?")
                .setPositiveButton("Guarda ora") { _, _ -> playNext(saga.optInt("id")) }
                .setNegativeButton("Esci") { _, _ -> finish() }
                .setOnCancelListener { finish() }
                .show()
            return
        }
        if (next <= 0 || sleepAtEnd || !prefs.getBoolean("p_autoplay", true)) {
            finish()
            return
        }
        countdownToNext(next)
    }

    /** Fine episodio: il successivo parte da solo dopo 10 secondi, ma si puo' fermare. */
    private fun countdownToNext(next: Int) {
        val label = data.optString("next_label")
        var left = 10
        var done = false
        fun text() = (if (label.isBlank()) "" else "$label\n\n") + "Parte tra $left secondi"
        val dialog = AlertDialog.Builder(this)
            .setTitle("Prossimo episodio")
            .setMessage(text())
            .setPositiveButton("Guarda subito", null)
            .setNegativeButton("Esci", null)
            .create()
        val tick = object : Runnable {
            override fun run() {
                if (done || isFinishing || player == null) return
                if (!visible) {          // TV spenta o app in secondo piano: niente partenze al buio
                    done = true
                    dialog.dismiss()
                    finish()
                    return
                }
                left--
                if (left <= 0) {
                    done = true
                    dialog.dismiss()
                    playNext(next)
                } else {
                    dialog.setMessage(text())
                    handler.postDelayed(this, 1000)
                }
            }
        }
        // Indietro (o Esci) ferma il conto e torna alla scheda
        dialog.setOnCancelListener {
            done = true
            finish()
        }
        dialog.show()
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            done = true
            dialog.dismiss()
            playNext(next)
        }
        dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setOnClickListener {
            done = true
            dialog.dismiss()
            finish()
        }
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).requestFocus()
        handler.postDelayed(tick, 1000)
    }

    private fun sagaLabel(saga: JSONObject): String =
        "«${saga.optString("title")}»" + (if (saga.optInt("year") > 0) " (${saga.optInt("year")})" else "")

    private fun playNext(next: Int) {
        thread {
            try {
                val info = JSONObject(Net.get("$server/api/play/$next"))
                runOnUiThread {
                    if (!isFinishing && player != null) {
                        Toast.makeText(this, "Avvio il successivo", Toast.LENGTH_SHORT).show()
                        open(info, 0L, false)
                    }
                }
            } catch (_: Exception) {
                runOnUiThread { finish() }
            }
        }
    }

    private fun format(ms: Long): String {
        val total = ms / 1000
        val h = total / 3600
        val m = total % 3600 / 60
        val s = total % 60
        return if (h > 0) String.format(Locale.US, "%d:%02d:%02d", h, m, s) else String.format(Locale.US, "%d:%02d", m, s)
    }

    // ---- Salti

    private val steps = mapOf("short" to (5_000L to 10_000L), "normal" to (10_000L to 30_000L), "long" to (30_000L to 60_000L))
    private fun step() = steps[prefs.getString("p_step", "normal")] ?: (10_000L to 30_000L)
    private fun stepBack() = step().first
    private fun stepForward() = step().second

    private fun seekBy(deltaMs: Long) {
        val from = if (pendingSeek >= 0) pendingSeek else realPosition()
        seekAbs(from + deltaMs, if (deltaMs < 0) "◀◀  " else "▶▶  ")
    }

    /** Tutti i salti passano di qui. Premendo piu' volte di fila si sommano e parte un
     *  salto solo quando ci si ferma: tanti salti uno dietro l'altro (ognuno apre un
     *  collegamento nuovo col PC, o fa ripartire la conversione) bloccavano il video. */
    private fun seekAbs(positionMs: Long, arrow: String?) {
        if (player == null) return
        val duration = durationMs()
        var target = positionMs.coerceAtLeast(0)
        if (duration > 0) target = target.coerceAtMost((duration - 3000).coerceAtLeast(0))
        pendingSeek = target
        handler.removeCallbacks(applySeek)
        handler.postDelayed(applySeek, if (transcoding) 600 else 300)
        if (arrow != null && !playerView.isControllerFullyVisible) {
            showOsd(arrow + format(target) + (if (duration > 0) " / " + format(duration) else ""))
        }
    }

    // ---- Opzioni

    private class TrackRef(val group: Tracks.Group, val index: Int, val label: String, val selected: Boolean)

    private fun languageName(code: String?): String? {
        if (code.isNullOrBlank() || code == "und") return null
        val name = Locale(code).getDisplayLanguage(Locale.ITALIAN)
        return if (name.isBlank() || name == code) code.uppercase(Locale.ROOT)
        else name.replaceFirstChar { it.titlecase(Locale.ITALIAN) }
    }

    private fun describe(f: Format, number: Int, audio: Boolean): String {
        val parts = mutableListOf(languageName(f.language) ?: f.label ?: "Traccia $number")
        if (languageName(f.language) != null && !f.label.isNullOrBlank()) parts.add(f.label!!)
        if (audio) {
            val codec = (f.sampleMimeType ?: "").substringAfter('/').removePrefix("x-").removePrefix("vnd.")
                .substringBefore(';').uppercase(Locale.ROOT)
            val channels = when (f.channelCount) {
                1 -> "mono"; 2 -> "stereo"; 6 -> "5.1"; 7 -> "6.1"; 8 -> "7.1"; else -> ""
            }
            val detail = listOf(codec, channels).filter { it.isNotBlank() }.joinToString(" ")
            if (detail.isNotBlank()) parts.add(detail)
        }
        return parts.joinToString(" · ")
    }

    private fun trackList(type: Int): List<TrackRef> {
        val p = player ?: return listOf()
        val out = mutableListOf<TrackRef>()
        for (group in p.currentTracks.groups) {
            if (group.type != type) continue
            for (i in 0 until group.length) {
                if (!group.isTrackSupported(i)) continue
                out.add(TrackRef(group, i, describe(group.getTrackFormat(i), out.size + 1, type == C.TRACK_TYPE_AUDIO),
                    group.isTrackSelected(i)))
            }
        }
        return out
    }

    private fun selectTrack(type: Int, track: TrackRef?) {
        val p = player ?: return
        val b = p.trackSelectionParameters.buildUpon().clearOverridesOfType(type)
        if (track == null) b.setTrackTypeDisabled(type, true)
        else b.setTrackTypeDisabled(type, false).setOverrideForType(TrackSelectionOverride(track.group.mediaTrackGroup, track.index))
        p.trackSelectionParameters = b.build()
    }

    private fun pick(title: String, labels: List<String>, checked: Int, onPick: (Int) -> Unit) {
        AlertDialog.Builder(this).setTitle(title)
            .setSingleChoiceItems(labels.toTypedArray(), checked) { dialog, i ->
                dialog.dismiss()
                onPick(i)
            }
            .show()
    }

    private val subSizes = listOf(0.7f to "Piccoli", 1f to "Normali", 1.35f to "Grandi", 1.75f to "Molto grandi")
    private val resizeModes = listOf(
        AspectRatioFrameLayout.RESIZE_MODE_FIT to "Adatta (tutto il video)",
        AspectRatioFrameLayout.RESIZE_MODE_ZOOM to "Riempi lo schermo (ritaglia i bordi)",
        AspectRatioFrameLayout.RESIZE_MODE_FILL to "Allarga (deforma)"
    )
    private val speeds = listOf(0.5f, 0.75f, 1f, 1.25f, 1.5f, 2f)

    /** Applica le preferenze salvate: dimensione dei sottotitoli e formato dell'immagine. */
    private fun applyLook() {
        val size = prefs.getFloat("p_subsize", 1f)
        playerView.subtitleView?.let {
            it.setApplyEmbeddedFontSizes(false)
            it.setFractionalTextSize(SubtitleView.DEFAULT_TEXT_SIZE_FRACTION * size)
        }
        playerView.resizeMode = prefs.getInt("p_resize", AspectRatioFrameLayout.RESIZE_MODE_FIT)
    }

    private fun speedLabel(s: Float) = if (s == 1f) "Normale" else s.toString().removeSuffix(".0") + "×"

    // ---- Sottotitoli da internet (li cerca e li scarica il server, da OpenSubtitles)

    private val onlineLangs = listOf("it" to "Italiano", "en" to "English", "es" to "Español", "fr" to "Français", "de" to "Deutsch")
    private var pendingSubLabel: String? = null    // da accendere appena il video ricaricato e' pronto

    private fun findSubs() {
        val at = onlineLangs.indexOfFirst { it.first == prefs.getString("p_oslang", "it") }.coerceAtLeast(0)
        pick("Cerca sottotitoli in…", onlineLangs.map { it.second }, at) { i ->
            val lang = onlineLangs[i].first
            prefs.edit().putString("p_oslang", lang).apply()
            val id = data.optInt("id")
            showOsd("Cerco i sottotitoli…", 20000)
            thread {
                val res = try {
                    JSONObject(Net.get("$server/api/subs-online/$id?langs=$lang", 30000))
                } catch (_: Exception) {
                    null
                }
                runOnUiThread {
                    if (isFinishing || data.optInt("id") != id) return@runOnUiThread
                    osd.visibility = View.GONE
                    val list = res?.optJSONArray("results")
                    when {
                        res == null -> showOsd("Il server non risponde", 3000)
                        !res.optBoolean("ok") -> showOsd(res.optString("error", "Ricerca non riuscita"), 5000)
                        list == null || list.length() == 0 -> showOsd("Nessun sottotitolo trovato in questa lingua", 3000)
                        else -> {
                            val rows = (0 until list.length()).map { list.getJSONObject(it) }
                            val labels = rows.map { s ->
                                val notes = listOfNotNull(
                                    if (s.optBoolean("match")) "✓ fatti per questo file" else null,
                                    if (s.optBoolean("hi")) "per non udenti" else null,
                                    if (s.optBoolean("machine")) "tradotti in automatico" else null,
                                    s.optInt("downloads").takeIf { it > 0 }?.let { String.format(Locale.ITALIAN, "%,d download", it) }
                                )
                                s.optString("release").ifBlank { s.optString("language") } +
                                    (if (notes.isEmpty()) "" else "\n" + notes.joinToString(" · "))
                            }
                            AlertDialog.Builder(this).setTitle("Scegli i sottotitoli")
                                .setItems(labels.toTypedArray()) { _, k -> getSubs(rows[k]) }
                                .show()
                        }
                    }
                }
            }
        }
    }

    private fun getSubs(s: JSONObject) {
        val id = data.optInt("id")
        val body = JSONObject().put("file_id", s.optLong("file_id")).put("lang", s.optString("lang"))
        showOsd("Scarico i sottotitoli…", 20000)
        thread {
            val res = try {
                JSONObject(Net.post("$server/api/subs-online/$id", body.toString(), 45000))
            } catch (_: Exception) {
                null
            }
            runOnUiThread {
                if (isFinishing || player == null || data.optInt("id") != id) return@runOnUiThread
                osd.visibility = View.GONE
                val subs = res?.optJSONArray("subs")
                when {
                    res == null -> showOsd("Il server non risponde", 3000)
                    !res.optBoolean("ok") || subs == null -> showOsd(res.optString("error", "Download non riuscito"), 5000)
                    else -> {
                        data.put("subs", subs)
                        pendingSubLabel = subs.optJSONObject(res.optInt("index"))?.optString("label")
                        // Si ricarica il video dallo stesso punto, con il sottotitolo nuovo tra quelli esterni
                        open(data, realPosition(), transcoding)
                        val left = if (res.isNull("remaining")) "" else " · ne puoi scaricare ancora ${res.optInt("remaining")} oggi"
                        Toast.makeText(this, "Sottotitoli scaricati$left", Toast.LENGTH_LONG).show()
                    }
                }
            }
        }
    }

    private fun applyPendingSub() {
        val want = pendingSubLabel ?: return
        val p = player ?: return
        for (group in p.currentTracks.groups) {
            if (group.type != C.TRACK_TYPE_TEXT) continue
            for (i in 0 until group.length) {
                if (group.getTrackFormat(i).label == want && group.isTrackSupported(i)) {
                    pendingSubLabel = null
                    p.trackSelectionParameters = p.trackSelectionParameters.buildUpon()
                        .clearOverridesOfType(C.TRACK_TYPE_TEXT)
                        .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                        .setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, i))
                        .build()
                    return
                }
            }
        }
    }

    private fun showOptions() {
        val p = player ?: return
        playerView.hideController()
        val items = mutableListOf<Pair<String, () -> Unit>>()

        if (transcoding) {
            if (serverAudios.size > 1) {
                items.add("Lingua audio:  " + serverAudios.getOrElse(serverAudio) { "" } to {
                    pick("Lingua audio", serverAudios, serverAudio) { i ->
                        if (i != serverAudio) {
                            serverAudio = i
                            open(data, realPosition(), true)
                        }
                    }
                })
            }
        } else {
            val audios = trackList(C.TRACK_TYPE_AUDIO)
            if (audios.size > 1) {
                val current = audios.indexOfFirst { it.selected }
                items.add("Lingua audio:  " + (audios.getOrNull(current)?.label ?: "") to {
                    pick("Lingua audio", audios.map { it.label }, current) { i -> selectTrack(C.TRACK_TYPE_AUDIO, audios[i]) }
                })
            }
        }

        val texts = trackList(C.TRACK_TYPE_TEXT)
        if (texts.isNotEmpty()) {
            val current = texts.indexOfFirst { it.selected }
            items.add("Sottotitoli:  " + (texts.getOrNull(current)?.label ?: "No") to {
                pick("Sottotitoli", listOf("Nessuno") + texts.map { it.label }, current + 1) { i ->
                    selectTrack(C.TRACK_TYPE_TEXT, if (i == 0) null else texts[i - 1])
                }
            })
            val size = prefs.getFloat("p_subsize", 1f)
            val sizeAt = subSizes.indexOfFirst { it.first == size }.coerceAtLeast(0)
            items.add("Dimensione dei sottotitoli:  " + subSizes[sizeAt].second to {
                pick("Dimensione dei sottotitoli", subSizes.map { it.second }, sizeAt) { i ->
                    prefs.edit().putFloat("p_subsize", subSizes[i].first).apply()
                    applyLook()
                }
            })
        }
        if (data.optBoolean("subs_online") && data.optString("friend").isBlank()) {
            items.add("Cerca sottotitoli su internet" to { findSubs() })
        }

        val speed = p.playbackParameters.speed
        items.add("Velocità:  " + speedLabel(speed) to {
            pick("Velocità", speeds.map { speedLabel(it) }, speeds.indexOf(speed)) { i -> player?.setPlaybackSpeed(speeds[i]) }
        })

        val modeAt = resizeModes.indexOfFirst { it.first == playerView.resizeMode }.coerceAtLeast(0)
        items.add("Formato immagine:  " + resizeModes[modeAt].second.substringBefore(" (") to {
            pick("Formato immagine", resizeModes.map { it.second }, modeAt) { i ->
                prefs.edit().putInt("p_resize", resizeModes[i].first).apply()
                applyLook()
            }
        })

        val keys = steps.keys.toList()
        val stepAt = keys.indexOf(prefs.getString("p_step", "normal")).coerceAtLeast(0)
        fun stepLabel(k: String) = "Indietro ${steps.getValue(k).first / 1000} s · avanti ${steps.getValue(k).second / 1000} s"
        items.add("Durata dei salti:  −${stepBack() / 1000} s / +${stepForward() / 1000} s" to {
            pick("Durata dei salti (tasti ◀ ▶)", keys.map { stepLabel(it) }, stepAt) { i ->
                prefs.edit().putString("p_step", keys[i]).apply()
            }
        })

        val next = data.optInt("next", 0)
        if (next > 0) {
            val auto = prefs.getBoolean("p_autoplay", true)
            items.add("Episodio successivo da solo:  " + (if (auto) "Sì" else "No") to {
                prefs.edit().putBoolean("p_autoplay", !auto).apply()
                showOsd(if (!auto) "A fine episodio parte il successivo" else "A fine episodio si torna alla scheda", 3000)
            })
        }

        val now = SystemClock.elapsedRealtime()
        val sleepLabel = when {
            sleepAt > 0 -> "tra ${((sleepAt - now) / 60_000 + 1).coerceAtLeast(1)} min"
            sleepAtEnd -> "a fine video"
            else -> "No"
        }
        val minutes = listOf(0, 15, 30, 45, 60, 90, -1)
        items.add("Spegnimento automatico:  $sleepLabel" to {
            pick("Metti in pausa da solo dopo…", minutes.map {
                when (it) {
                    0 -> "Mai"; -1 -> "Alla fine di questo video"; else -> "$it minuti"
                }
            }, if (sleepAtEnd) minutes.size - 1 else if (sleepAt > 0) -1 else 0) { i ->
                val m = minutes[i]
                sleepAtEnd = m == -1
                sleepAt = if (m > 0) SystemClock.elapsedRealtime() + m * 60_000L else 0
                showOsd(
                    when {
                        m > 0 -> "Pausa automatica tra $m minuti"
                        m == -1 -> "Mi fermo alla fine di questo video"
                        else -> "Spegnimento automatico disattivato"
                    }, 3000
                )
            }
        })

        val savedCompat = prefs.getBoolean("p_audio_compat", false)
        items.add("Audio compatibile:  " + (if (audioCompat) "Sì" else "No") to {
            AlertDialog.Builder(this).setTitle("Audio compatibile")
                .setMessage(
                    "Attivalo se dopo una pausa o un salto il video resta fermo o l'audio sparisce: " +
                        "l'audio viene decodificato dall'app invece che dalla TV o dall'impianto. " +
                        "Funziona con tutte le TV, ma all'impianto audio arriva già decodificato."
                )
                .setPositiveButton(if (savedCompat) "Disattiva" else "Attiva") { _, _ ->
                    prefs.edit().putBoolean("p_audio_compat", !savedCompat).apply()
                    audioCompat = !savedCompat
                    rebuildPlayer()
                }
                .setNegativeButton("Annulla", null)
                .show()
        })

        items.add("Ricomincia dall'inizio" to { seekAbs(0, null) })
        if (next > 0) {
            items.add("Vai all'episodio successivo" to {
                report(false)
                finished = true
                player?.pause()
                playNext(next)
            })
        }
        val saga = data.optJSONObject("saga")
        if (next <= 0 && saga != null) {
            items.add("Film successivo della saga:  ${sagaLabel(saga)}" to {
                report(false)
                finished = true
                player?.pause()
                playNext(saga.optInt("id"))
            })
        }
        items.add("Informazioni sul video" to { showInfo() })

        AlertDialog.Builder(this).setTitle("Opzioni")
            .setItems(items.map { it.first }.toTypedArray()) { _, i -> items[i].second() }
            .show()
    }

    private fun showInfo() {
        val p = player ?: return
        val lines = mutableListOf<String>()
        p.videoFormat?.let { f ->
            val codec = (f.sampleMimeType ?: "").substringAfter('/').uppercase(Locale.ROOT)
            val fps = if (f.frameRate > 0) String.format(Locale.US, " · %.0f fps", f.frameRate) else ""
            lines.add("Video: ${f.width}×${f.height} · $codec$fps")
        }
        p.audioFormat?.let { lines.add("Audio: " + describe(it, 1, true)) }
        lines.add(
            when {
                !transcoding -> "Riproduzione diretta del file"
                videoCopy -> "Conversione leggera sul PC (video originale)"
                else -> "Conversione completa sul PC"
            }
        )
        lines.add("Posizione: ${format(realPosition())} / ${format(durationMs())}")
        AlertDialog.Builder(this).setTitle(titleView.text.toString().replace("\n", " — "))
            .setMessage(lines.joinToString("\n"))
            .setPositiveButton("Chiudi", null)
            .show()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val p = player
        if (p != null && event.action == KeyEvent.ACTION_DOWN) {
            val hidden = !playerView.isControllerFullyVisible
            when (event.keyCode) {
                KeyEvent.KEYCODE_MEDIA_REWIND -> {
                    seekBy(-stepBack())
                    return true
                }
                KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> {
                    seekBy(stepForward())
                    return true
                }
                KeyEvent.KEYCODE_DPAD_LEFT -> if (hidden) {
                    seekBy(-stepBack())
                    return true
                }
                KeyEvent.KEYCODE_DPAD_RIGHT -> if (hidden) {
                    seekBy(stepForward())
                    return true
                }
                // Su e giu' non hanno scorciatoie: mostrano i comandi (lo fa PlayerView),
                // e le Opzioni si aprono dall'ingranaggio nella barra.
                KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_SETTINGS, KeyEvent.KEYCODE_INFO,
                KeyEvent.KEYCODE_CAPTIONS, KeyEvent.KEYCODE_MEDIA_AUDIO_TRACK -> {
                    if (event.repeatCount == 0) showOptions()
                    return true
                }
                KeyEvent.KEYCODE_MEDIA_NEXT -> {
                    val next = data.optInt("next", 0)
                    if (next > 0 && event.repeatCount == 0 && !finished) {
                        report(false)
                        finished = true
                        p.pause()
                        playNext(next)
                    }
                    return true
                }
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> if (hidden) {
                    if (event.repeatCount == 0) {
                        // Si guarda cosa e' stato chiesto (play o pausa), non se il video sta
                        // scorrendo in questo istante: mentre caricava, OK non faceva nulla.
                        when {
                            p.playbackState == Player.STATE_IDLE || p.playbackState == Player.STATE_ENDED ->
                                open(data, realPosition(), transcoding)
                            p.playWhenReady -> p.pause()
                            else -> {
                                lastMoveAt = SystemClock.elapsedRealtime()
                                p.play()
                            }
                        }
                        playerView.showController()
                    }
                    return true
                }
            }
        }
        return super.dispatchKeyEvent(event)
    }

    override fun onStart() {
        super.onStart()
        visible = true
        handler.postDelayed(ticker, 10_000)
        lastMoveAt = SystemClock.elapsedRealtime()
        handler.postDelayed(watchdog, 1000)
        if (pendingSeek >= 0) handler.post(applySeek)
    }

    override fun onStop() {
        visible = false
        handler.removeCallbacks(ticker)
        handler.removeCallbacks(watchdog)
        report(false)
        handler.removeCallbacks(applySeek)   // un salto ancora in attesa riparte in onStart
        player?.pause()
        super.onStop()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        player?.removeListener(listener)
        player?.release()
        player = null
        super.onDestroy()
    }
}
