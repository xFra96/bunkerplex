package it.bunkerplex.tv

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
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
import android.widget.LinearLayout
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
import androidx.media3.common.util.Util
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.SeekParameters
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
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
    private val prefs by lazy { getSharedPreferences("bunkerplex", MODE_PRIVATE) }

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
    private var serverTracks = listOf<JSONObject>()

    // La traccia audio scelta in un episodio vale per tutta la serie (per esempio
    // «Italiano 2.0» quando il 5.1 del file e' fatto male): si rimette da sola una
    // volta per episodio.
    private var audioRestored = false

    // In conversione: che audio chiedere al PC. "tv" = l'audio Dolby si copia, DTS e
    // TrueHD diventano AC3 5.1 (alla soundbar arrivano surround e bassi, non stereo);
    // "ac3" = l'audio originale questa TV non lo legge; "aac" = nemmeno l'AC3.
    private var audioOut = "tv"

    // «Audio pulito»: per le 5.1 col doppiaggio tutto nel centrale e voci estranee nei
    // laterali (es. Dragon Ball Z) si sente solo il canale centrale. Le riconosce il PC
    // (/api/audiocheck); la scelta vale per tutta la serie.
    private var centerOnly = CenterOnlyProcessor()
    private var cleanAudio = false
    private var cleanTracks = listOf<JSONObject>()   // le tracce 5.1 di questo tipo nel video
    private var cleanAsked = false
    private var pendingAudio = -1                    // traccia audio (0:a:N) da scegliere appena si puo'

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

    // Comandi a schermo (vedi "Comandi a schermo" piu' sotto)
    private enum class Zone { BAR, ROW, FLOAT }
    private var zone = Zone.BAR
    private var shown = false
    private var lastKeyAt = 0L
    private var rowAt = 0
    private var floatAt = 0
    private var holdSeekAt = 0L
    private var seekArrow = ""
    private lateinit var controls: LinearLayout
    private lateinit var shade: View
    private lateinit var bar: Bar
    private lateinit var stateIcon: TextView
    private lateinit var remainView: TextView
    private lateinit var scrubLabel: TextView
    private lateinit var episodeView: TextView
    private lateinit var row: LinearLayout
    private val rowActions = mutableListOf<() -> Unit>()
    private lateinit var floatWrap: LinearLayout
    private lateinit var nextInfo: TextView
    private lateinit var skipBtn: Pill
    private lateinit var creditsBtn: Pill
    private lateinit var nextBtn: Pill

    // Sigle dell'episodio (secondi; 0 = non c'e' o non si sa)
    private var introS = 0.0
    private var introE = 0.0
    private var creditsS = 0.0
    private var introDismissed = false
    private var card = 0                // scheda del prossimo episodio: 0 no, 1 titoli di coda, 2 fine video
    private var cardDismissed = false
    private var cardElapsed = 0L
    private var cardTickAt = 0L
    private var marksTries = 0

    private val handler = Handler(Looper.getMainLooper())
    private val uiTick = object : Runnable {
        override fun run() {
            handler.postDelayed(this, 250)
            refresh()
        }
    }
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
                showControls(Zone.BAR)
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
                showControls(Zone.BAR)
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
            override fun handleOnBackPressed() = onBack()
        })

        open(JSONObject(intent.getStringExtra("data") ?: "{}"), null, false)
        showControls(Zone.BAR)        // all'avvio titolo ed episodio, poi si nascondono da soli
    }

    private fun buildPlayer() {
        // Prima i decodificatori della TV (video 4K/HDR in hardware, audio che conosce);
        // per l'audio che la TV non conosce subentra quello interno all'app.
        // "Audio compatibile": l'audio lo decodifica sempre l'app, per le TV la cui
        // uscita audio si inceppa dopo una pausa o un salto.
        // Con l'audio pulito l'audio lo decodifica l'app: solo cosi' si puo' tenere il
        // centrale (all'impianto arriva gia' decodificato, come con l'audio compatibile).
        centerOnly = CenterOnlyProcessor().also { it.enabled = cleanAudio }
        val processor = centerOnly
        val renderers = object : DefaultRenderersFactory(this) {
            override fun buildAudioSink(
                context: Context, enableFloatOutput: Boolean, enableAudioTrackPlaybackParams: Boolean
            ): AudioSink = DefaultAudioSink.Builder(context)
                .setEnableFloatOutput(enableFloatOutput)
                .setEnableAudioTrackPlaybackParams(enableAudioTrackPlaybackParams)
                .setAudioProcessors(arrayOf(processor))
                .build()
        }
            .setEnableDecoderFallback(true)
            .setExtensionRendererMode(
                if (audioCompat || cleanAudio) DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER
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
            // Sottotitoli ASS degli anime: senza i disegni, che apparivano come "m 0 0 l..."
            .setSubtitleParserFactory(AssDrawingsFilter())
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
        // Se il file ha piu' lingue, parte con quella della TV. I sottotitoli partono
        // spenti, anche se il file ne segna una traccia come predefinita: si accendono
        // dal menu. Solo quelli forzati si accendono da soli (applyAutoSubs).
        p.trackSelectionParameters = p.trackSelectionParameters.buildUpon()
            .setPreferredAudioLanguage(Locale.getDefault().language)
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
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
        autoSubs = true      // il lettore nuovo parte coi sottotitoli spenti: si rimettono i forzati
        player?.setPlaybackSpeed(speed)
        open(data, at, transcoding)
    }

    private fun dp(value: Int): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).toInt()

    private fun buildLayout() {
        val root = FrameLayout(this)
        root.setBackgroundColor(Color.BLACK)

        // I comandi di Media3 non servono: quelli a schermo sono nostri (vedi "Comandi a schermo")
        playerView = PlayerView(this)
        playerView.useController = false
        playerView.keepScreenOn = true
        playerView.isFocusable = false
        root.addView(playerView, FrameLayout.LayoutParams(-1, -1))

        // Il fondo scuro sotto i comandi
        shade = View(this)
        shade.background = GradientDrawable(
            GradientDrawable.Orientation.BOTTOM_TOP,
            intArrayOf(Color.argb(235, 0, 0, 0), Color.argb(140, 0, 0, 0), Color.TRANSPARENT)
        )
        shade.alpha = 0f
        root.addView(shade, FrameLayout.LayoutParams(-1, dp(320), Gravity.BOTTOM))

        controls = LinearLayout(this)
        controls.orientation = LinearLayout.VERTICAL
        controls.setPadding(dp(48), 0, dp(48), dp(28))
        controls.alpha = 0f
        controls.visibility = View.INVISIBLE       // invisibile ma misurato: serve la sua altezza

        titleView = label(24f, true)
        controls.addView(titleView)
        episodeView = label(17f, false)
        episodeView.setTextColor(Color.rgb(205, 209, 218))
        controls.addView(episodeView)

        val barRow = LinearLayout(this)
        barRow.orientation = LinearLayout.HORIZONTAL
        barRow.gravity = Gravity.BOTTOM
        stateIcon = label(20f, true)
        stateIcon.gravity = Gravity.CENTER
        stateIcon.setPadding(0, 0, 0, dp(2))
        barRow.addView(stateIcon, LinearLayout.LayoutParams(dp(34), dp(26)))
        val barFrame = FrameLayout(this)
        bar = Bar()
        barFrame.addView(bar, FrameLayout.LayoutParams(-1, dp(26), Gravity.BOTTOM))
        scrubLabel = label(17f, true)
        scrubLabel.visibility = View.INVISIBLE
        barFrame.addView(scrubLabel, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.START))
        barRow.addView(barFrame, LinearLayout.LayoutParams(0, dp(54), 1f))
        remainView = label(17f, false)
        remainView.gravity = Gravity.CENTER_VERTICAL
        remainView.fontFeatureSettings = "tnum"
        remainView.setPadding(dp(14), 0, 0, 0)
        barRow.addView(remainView, LinearLayout.LayoutParams(-2, dp(26)))
        controls.addView(barRow, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(4) })

        row = LinearLayout(this)
        row.orientation = LinearLayout.HORIZONTAL
        controls.addView(row, LinearLayout.LayoutParams(-2, -2).apply { topMargin = dp(12); leftMargin = dp(34) })
        root.addView(controls, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM))

        // In basso a destra, sopra i comandi quando ci sono: «Salta intro» e la scheda
        // del prossimo episodio (titoli di coda o fine video)
        floatWrap = LinearLayout(this)
        floatWrap.orientation = LinearLayout.VERTICAL
        floatWrap.gravity = Gravity.END
        nextInfo = label(16f, false)
        nextInfo.setTextColor(Color.rgb(225, 228, 235))
        nextInfo.visibility = View.GONE
        floatWrap.addView(nextInfo, LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = dp(8) })
        val floatRow = LinearLayout(this)
        floatRow.orientation = LinearLayout.HORIZONTAL
        creditsBtn = Pill("Guarda i titoli di coda", 18f)
        nextBtn = Pill("Prossimo episodio", 18f)
        skipBtn = Pill("Salta intro", 18f)
        for (b in listOf(creditsBtn, nextBtn, skipBtn)) {
            b.visibility = View.GONE
            floatRow.addView(b, LinearLayout.LayoutParams(-2, -2).apply { leftMargin = dp(12) })
        }
        floatWrap.addView(floatRow)
        root.addView(floatWrap, FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM or Gravity.END).apply {
            rightMargin = dp(48)
            bottomMargin = dp(44)
        })

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
        setContentView(root)
    }

    private fun label(sp: Float, bold: Boolean): TextView {
        val t = TextView(this)
        t.setTextColor(Color.WHITE)
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
        if (bold) t.typeface = Typeface.DEFAULT_BOLD
        t.setShadowLayer(6f, 0f, 1f, Color.argb(160, 0, 0, 0))
        t.maxLines = 1
        t.ellipsize = android.text.TextUtils.TruncateAt.END
        return t
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
            serverTracks = listOf()
            audioRestored = false
            audioOut = "tv"
            endedAt = -1
            recoveries = 0
            softRetried = false
            introDismissed = false
            cardDismissed = false
            marksTries = 0
            hideCard()
            if (d.optBoolean("marks_pending")) fetchMarks(d.optInt("id"))
            cleanTracks = listOf()
            cleanAsked = false
            pendingAudio = -1
            checkCleanAudio(d)
        }
        data = d
        readMarks(d)
        d.optString("session").let { if (it.isNotEmpty() && it != Net.session) Net.session = it }
        finished = false
        transcoding = useTranscode
        handler.removeCallbacks(applySeek)
        pendingSeek = -1
        lastMoveAt = SystemClock.elapsedRealtime()
        val start = (startMs ?: (d.optDouble("start", 0.0) * 1000).toLong()).coerceAtLeast(0)

        val title = d.optString("title")
        val subtitle = d.optString("subtitle")
        titleView.text = title
        episodeView.text = subtitle
        episodeView.visibility = if (subtitle.isBlank()) View.GONE else View.VISIBLE
        buildRow()

        val uri: String
        if (useTranscode) {
            offsetMs = start
            uri = abs(d.optString("transcode")) + "?start=" + String.format(Locale.US, "%.1f", start / 1000.0) +
                (if (videoCopy) "&vcopy=1" else "") + (if (serverAudio > 0) "&audio=$serverAudio" else "") +
                "&aout=$audioOut"
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
                        .setSelectionFlags(if (s.optBoolean("forced")) C.SELECTION_FLAG_FORCED else 0)
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
                val found = (0 until list.length()).map { list.getJSONObject(it) }
                val labels = found.mapIndexed { i, t -> t.optString("label", "Traccia ${i + 1}") }
                runOnUiThread {
                    if (data.optInt("id") != id) return@runOnUiThread
                    serverAudios = labels
                    serverTracks = found
                    // La traccia scelta per la serie, se non e' gia' quella che arriva
                    val saved = savedAudio()
                    if (saved != null && serverAudio == 0 && transcoding) {
                        val k = found.indexOfFirst {
                            matchesAudio(saved, it.optString("title"), it.optString("lang"), it.optInt("channels"))
                        }
                        if (k > 0) {
                            serverAudio = k
                            open(data, realPosition(), true)
                        }
                    }
                }
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
                // In conversione l'uscita audio rifiuta l'AC3: si chiede l'AAC, che legge ogni TV
                transcoding && code in 5000..5999 && audioOut != "aac" -> {
                    audioOut = "aac"
                    open(data, at, true)
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
            applyAutoSubs(tracks)
            restoreAudio(tracks)
            applyPendingAudio(tracks)
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
                if (videoCopy && hasVideo && !videoOk) {
                    videoCopy = false
                    open(data, realPosition(), true)
                } else if (hasAudio && !audioOk && audioOut != "aac") {
                    // Nemmeno l'audio convertito va: si ripiega sull'AAC
                    audioOut = "aac"
                    open(data, realPosition(), true)
                }
                return
            }
            // Se la TV decodifica il video e le manca solo l'audio, il PC converte solo quello
            if ((hasVideo && !videoOk) || (hasAudio && !audioOk)) {
                if (hasAudio && !audioOk) audioOut = "ac3"      // l'originale qui non va: non copiarlo
                fallbackToTranscode(!hasVideo || videoOk)
            }
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
                .setTitle("Collezione ${saga.optString("name")} · film ${saga.optInt("number")} di ${saga.optInt("count")}")
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
        showCard(2)
    }

    // ---- Comandi a schermo, col telecomando come su Netflix
    //
    // Comandi nascosti: OK mette in pausa (e li mostra), ◀ ▶ saltano indietro e avanti
    // (tenendo premuto si scorre sempre piu' veloce), ▲ mostra i comandi, ▼ li mostra
    // con la fila dei bottoni gia' scelta, Indietro esce.
    // Comandi visibili: sulla barra ◀ ▶ scorrono e OK fa pausa/play; ▼ scende alla fila
    // dei bottoni (◀ ▶ per scegliere, OK per aprire, ▲ per tornare alla barra);
    // Indietro li nasconde.
    // «Salta intro» e la scheda del prossimo episodio stanno in basso a destra: quando
    // compaiono hanno loro il tasto OK (dalla barra ci si torna con ▲), Indietro li chiude.

    private val accent = Color.rgb(46, 178, 104)
    private val playGlyph = "▶︎"
    private val pauseGlyph = "❚❚"

    /** Bottone arrotondato: bianco quando e' quello scelto. 'fill' = riempimento del conto alla rovescia. */
    private inner class Pill(text: String, sp: Float) : TextView(this@PlayerActivity) {
        var lit = false
            set(v) {
                if (field == v) return
                field = v
                setTextColor(if (v) Color.BLACK else Color.WHITE)
                invalidate()
            }
        var fill = 0f
            set(v) {
                if (field == v) return
                field = v
                invalidate()
            }
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        private val box = RectF()

        init {
            this.text = text
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            setPadding(dp(22), dp(10), dp(22), dp(10))
            maxLines = 1
        }

        override fun onDraw(canvas: Canvas) {
            val r = dp(6).toFloat()
            box.set(0f, 0f, width.toFloat(), height.toFloat())
            paint.color = if (lit) Color.WHITE else Color.argb(165, 38, 42, 50)
            canvas.drawRoundRect(box, r, r, paint)
            if (fill > 0f) {
                canvas.save()
                canvas.clipRect(0f, 0f, width * fill, height.toFloat())
                paint.color = if (lit) Color.rgb(185, 188, 194) else Color.argb(120, 255, 255, 255)
                canvas.drawRoundRect(box, r, r, paint)
                canvas.restore()
            }
            super.onDraw(canvas)
        }
    }

    /** La barra del video: visto, gia' scaricato e il cursore (piu' grande quando e' scelta). */
    private inner class Bar : View(this@PlayerActivity) {
        var lit = false
            set(v) {
                if (field == v) return
                field = v
                invalidate()
            }
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        private val pad get() = dp(10).toFloat()

        fun thumbX(): Float {
            val d = durationMs().toFloat()
            val w = width - 2 * pad
            return pad + if (d > 0) (realPosition() / d).coerceIn(0f, 1f) * w else 0f
        }

        override fun onDraw(c: Canvas) {
            val d = durationMs().toFloat()
            val w = width - 2 * pad
            fun x(v: Float) = pad + if (d > 0) (v / d).coerceIn(0f, 1f) * w else 0f
            val h = dp(if (lit) 6 else 4).toFloat()
            val cy = height / 2f
            val top = cy - h / 2
            val bottom = cy + h / 2
            paint.color = Color.argb(80, 255, 255, 255)
            c.drawRoundRect(pad, top, pad + w, bottom, h / 2, h / 2, paint)
            val p = player
            if (p != null && pendingSeek < 0) {
                val buffered = (if (transcoding) offsetMs else 0L) + p.bufferedPosition
                paint.color = Color.argb(130, 255, 255, 255)
                c.drawRoundRect(pad, top, x(buffered.toFloat()), bottom, h / 2, h / 2, paint)
            }
            paint.color = accent
            val at = thumbX()
            c.drawRoundRect(pad, top, at, bottom, h / 2, h / 2, paint)
            c.drawCircle(at, cy, dp(if (lit) 10 else 6).toFloat(), paint)
        }
    }

    private fun showControls(z: Zone? = null) {
        if (z != null) zone = z
        if (zone == Zone.FLOAT && floats().isEmpty()) zone = Zone.BAR
        lastKeyAt = SystemClock.elapsedRealtime()
        if (!shown) {
            shown = true
            controls.visibility = View.VISIBLE
            controls.animate().alpha(1f).setDuration(160).start()
            shade.animate().alpha(1f).setDuration(160).start()
            osd.visibility = View.GONE
        }
        placeFloats()
        // Accende cio' che e' scelto (barra o bottone della fila): senza, il telecomando
        // spostava la scelta ma a schermo non si vedeva dove si era.
        paintFocus()
        refresh()
    }

    private fun hideControls() {
        if (!shown) return
        shown = false
        controls.animate().alpha(0f).setDuration(220).withEndAction {
            if (!shown) controls.visibility = View.INVISIBLE
        }.start()
        shade.animate().alpha(if (card > 0) 0.6f else 0f).setDuration(220).start()
        zone = if (floats().isNotEmpty()) Zone.FLOAT else Zone.BAR
        placeFloats()
        paintFocus()
    }

    /** Sopra i comandi quando si vedono, altrimenti nell'angolo. */
    private fun placeFloats() {
        val lift = if (shown) -(controls.height + dp(10) - dp(44)).toFloat().coerceAtLeast(0f) else 0f
        floatWrap.animate().translationY(lift).setDuration(160).start()
    }

    private fun floats(): List<Pill> = listOf(creditsBtn, nextBtn, skipBtn).filter { it.visibility == View.VISIBLE }

    private fun paintFocus() {
        bar.lit = shown && zone == Zone.BAR
        stateIcon.setTextColor(if (bar.lit) Color.WHITE else Color.rgb(200, 204, 212))
        rowButtons().forEachIndexed { i, b -> b.lit = shown && zone == Zone.ROW && i == rowAt }
        floats().forEachIndexed { i, b -> b.lit = zone == Zone.FLOAT && i == floatAt }
    }

    private fun rowButtons(): List<Pill> = (0 until row.childCount).map { row.getChildAt(it) as Pill }

    /** La fila dei bottoni sotto la barra (cambia se c'e' un episodio o un film dopo). */
    private fun buildRow() {
        row.removeAllViews()
        rowActions.clear()
        fun add(text: String, action: () -> Unit) {
            val b = Pill(text, 16f)
            b.setPadding(dp(18), dp(8), dp(18), dp(8))
            row.addView(b, LinearLayout.LayoutParams(-2, -2).apply { rightMargin = dp(12) })
            rowActions.add(action)
        }
        add("Audio e sottotitoli") { showAudioSubs() }
        add("Velocità") { showSpeed() }
        val next = data.optInt("next", 0)
        val saga = data.optJSONObject("saga")
        if (next > 0) add("Prossimo episodio") { goNext(next, false) }
        else if (saga != null) add("Film successivo") { goNext(saga.optInt("id"), false) }
        add("Ricomincia") { seekAbs(0, null) }
        add("Altre opzioni") { showOptions() }
        rowAt = rowAt.coerceIn(0, rowActions.size - 1)
        paintFocus()
    }

    /** Ogni 250 ms: barra, tempo che manca, «Salta intro» e la scheda dei titoli di coda. */
    private fun refresh() {
        val p = player ?: return
        val now = SystemClock.elapsedRealtime()
        val posMs = realPosition()
        val pos = posMs / 1000.0
        if (shown) {
            bar.invalidate()
            val d = durationMs()
            remainView.text = if (d > 0) format(posMs) + " / \u2212" + format((d - posMs).coerceAtLeast(0)) else format(posMs)
            stateIcon.text = if (p.playWhenReady && !finished) pauseGlyph else playGlyph
            if (pendingSeek >= 0) {
                scrubLabel.text = seekArrow + format(posMs)
                val half = scrubLabel.width / 2f
                scrubLabel.translationX = (bar.thumbX() - half).coerceIn(0f, (bar.width - scrubLabel.width).toFloat().coerceAtLeast(0f))
                scrubLabel.visibility = View.VISIBLE
            } else {
                scrubLabel.visibility = View.INVISIBLE
            }
            // Si nascondono da soli dopo 5 secondi senza tasti, se il video va
            if (p.playWhenReady && pendingSeek < 0 && !finished && now - lastKeyAt > 5000) hideControls()
        }

        // Titoli di coda: la scheda del prossimo episodio (quella di fine video resta fino alla scelta)
        val next = data.optInt("next", 0)
        if (card != 2) {
            val inCredits = next > 0 && creditsS > 0 && pos >= creditsS && !finished && pendingSeek < 0
            if (inCredits && card == 0 && !cardDismissed && !sleepAtEnd) showCard(1)
            else if (card == 1 && (pos < creditsS - 1 || next <= 0)) hideCard()
            if (pos < creditsS - 2) cardDismissed = false
        }
        if (card > 0 && autoplay()) {
            if (card == 2 || p.isPlaying) cardElapsed += now - cardTickAt
            cardTickAt = now
            nextBtn.fill = (cardElapsed / COUNTDOWN.toFloat()).coerceIn(0f, 1f)
            if (cardElapsed >= COUNTDOWN && next > 0) {
                goNext(next, true)
                return
            }
        } else {
            cardTickAt = now
        }

        // Sigla iniziale
        val inIntro = introE > introS && pos >= introS && pos < introE - 1.5 && !finished && card == 0
        if (!inIntro && (pos < introS - 1 || pos >= introE)) introDismissed = false
        setVisible(skipBtn, inIntro && !introDismissed)
    }

    private val COUNTDOWN = 10_000L

    private fun autoplay() = prefs.getBoolean("p_autoplay", true) && !sleepAtEnd

    private fun setVisible(b: Pill, on: Boolean) {
        val want = if (on) View.VISIBLE else View.GONE
        if (b.visibility == want) return
        val before = floats().isNotEmpty()
        b.visibility = want
        val list = floats()
        if (on && !before && !(shown && zone == Zone.ROW)) {
            zone = Zone.FLOAT
            floatAt = list.size - 1
        }
        if (list.isEmpty() && zone == Zone.FLOAT) zone = Zone.BAR
        floatAt = floatAt.coerceIn(0, (list.size - 1).coerceAtLeast(0))
        paintFocus()
    }

    /** kind 1: sono partiti i titoli di coda; kind 2: il video e' finito. */
    private fun showCard(kind: Int) {
        card = kind
        cardElapsed = 0
        cardTickAt = SystemClock.elapsedRealtime()
        nextBtn.fill = 0f
        creditsBtn.text = if (kind == 1) "Guarda i titoli di coda" else "Esci"
        val label = data.optString("next_label")
        nextInfo.text = if (label.isBlank()) "" else "Prossimo episodio · $label"
        nextInfo.visibility = if (label.isBlank()) View.GONE else View.VISIBLE
        setVisible(skipBtn, false)
        setVisible(creditsBtn, true)
        setVisible(nextBtn, true)
        if (!(shown && zone == Zone.ROW)) {
            zone = Zone.FLOAT
            floatAt = floats().indexOf(nextBtn)
        }
        if (kind == 2) hideControls()
        shade.animate().alpha(if (shown) 1f else 0.6f).setDuration(200).start()
        paintFocus()
    }

    private fun hideCard() {
        if (card == 0) return
        card = 0
        nextBtn.fill = 0f
        nextInfo.visibility = View.GONE
        setVisible(creditsBtn, false)
        setVisible(nextBtn, false)
        if (!shown) shade.animate().alpha(0f).setDuration(200).start()
    }

    private fun pressFloat() {
        val b = floats().getOrNull(floatAt) ?: return
        when (b) {
            skipBtn -> {
                introDismissed = true
                setVisible(skipBtn, false)
                jumpTo((introE * 1000).toLong())
            }
            creditsBtn -> if (card == 2) finish() else {
                cardDismissed = true
                hideCard()
            }
            nextBtn -> goNext(data.optInt("next", 0), true)
        }
    }

    /** Indietro: chiude i comandi, poi «Salta intro» o la scheda, poi esce. */
    private fun onBack() {
        val playing = player?.playWhenReady == true && !finished
        when {
            shown && playing -> hideControls()
            card == 2 -> finish()
            card == 1 -> {
                cardDismissed = true
                hideCard()
            }
            skipBtn.visibility == View.VISIBLE -> {
                introDismissed = true
                setVisible(skipBtn, false)
            }
            else -> finish()
        }
    }

    /** Al prossimo episodio (o film). fromCard: dalla scheda dei titoli di coda, quindi questo e' visto. */
    private fun goNext(next: Int, fromCard: Boolean) {
        if (next <= 0) return
        report(fromCard)
        finished = true
        hideCard()
        player?.pause()
        playNext(next)
    }

    /** Salto immediato (senza aspettare altri tasti): «Salta intro». */
    private fun jumpTo(ms: Long) {
        seekAbs(ms, null)
        handler.removeCallbacks(applySeek)
        handler.post(applySeek)
    }

    private fun togglePlay() {
        val p = player ?: return
        when {
            p.playbackState == Player.STATE_IDLE || p.playbackState == Player.STATE_ENDED ->
                if (!finished) open(data, realPosition(), transcoding)
            // Si guarda cosa e' stato chiesto (play o pausa), non se il video sta scorrendo
            // in questo istante: mentre caricava, OK non faceva nulla.
            p.playWhenReady -> p.pause()
            else -> {
                lastMoveAt = SystemClock.elapsedRealtime()
                p.play()
            }
        }
    }

    // ---- Sigle: le manda il server con il video; se non le aveva ancora pronte
    // (le sta cercando in quel momento) le si richiede poco dopo.

    private fun readMarks(d: JSONObject) {
        introS = d.optDouble("intro_start", 0.0).takeIf { it.isFinite() } ?: 0.0
        introE = d.optDouble("intro_end", 0.0).takeIf { it.isFinite() } ?: 0.0
        creditsS = d.optDouble("credits", 0.0).takeIf { it.isFinite() } ?: 0.0
    }

    private fun fetchMarks(id: Int) {
        if (marksTries >= 8 || id <= 0) return
        marksTries++
        handler.postDelayed({
            if (data.optInt("id") == id && !isFinishing) {
                thread {
                    val m = try {
                        JSONObject(Net.get("$server/api/marks/$id"))
                    } catch (_: Exception) {
                        null
                    }
                    runOnUiThread {
                        if (data.optInt("id") != id || isFinishing) return@runOnUiThread
                        if (m != null && !m.optBoolean("marks_pending")) {
                            for (k in listOf("intro_start", "intro_end", "credits")) data.put(k, m.optDouble(k, 0.0))
                            readMarks(data)
                        } else {
                            fetchMarks(id)
                        }
                    }
                }
            }
        }, if (marksTries == 1) 6_000L else 10_000L)
    }

    // ---- Finestre di scelta aperte dalla fila dei bottoni

    private fun showAudioSubs() {
        hideControls()
        val items = mutableListOf<Pair<String, () -> Unit>>()
        audioSubItems(items)
        if (items.isEmpty()) {
            showOsd("Nessuna altra lingua o sottotitolo per questo video", 3000)
            return
        }
        AlertDialog.Builder(this).setTitle("Audio e sottotitoli")
            .setItems(items.map { it.first }.toTypedArray()) { _, i -> items[i].second() }
            .show()
    }

    private fun showSpeed() {
        val p = player ?: return
        hideControls()
        val speed = p.playbackParameters.speed
        pick("Velocità", speeds.map { speedLabel(it) }, speeds.indexOf(speed)) { i -> player?.setPlaybackSpeed(speeds[i]) }
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
                        // Ogni nuovo episodio riparte come la prima volta: sottotitoli spenti,
                        // salvo quelli forzati
                        autoSubs = true
                        player?.let { p ->
                            p.trackSelectionParameters = p.trackSelectionParameters.buildUpon()
                                .clearOverridesOfType(C.TRACK_TYPE_TEXT)
                                .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
                                .build()
                        }
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
        // La freccia accanto all'ora sopra la barra: da che parte si sta andando
        seekArrow = when {
            arrow == null -> ""
            target < realPosition() -> "◀◀ "
            else -> "▶▶ "
        }
        pendingSeek = target
        handler.removeCallbacks(applySeek)
        handler.postDelayed(applySeek, if (transcoding) 600 else 300)
        if (arrow != null && !shown) {
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

    // ---- Sottotitoli forzati: quelli che traducono solo i cartelli o le frasi in
    // un'altra lingua. Si accendono da soli a ogni nuovo video, se sono nella lingua
    // dell'audio (o se una delle due lingue non e' indicata); gli altri restano spenti.
    private var autoSubs = true

    private fun isForced(f: Format): Boolean {
        val label = (f.label ?: "").lowercase(Locale.ROOT)
        return (f.selectionFlags and C.SELECTION_FLAG_FORCED) != 0 ||"forced" in label || "forzat" in label
    }

    private fun lang(code: String?): String =
        (code ?: "").lowercase(Locale.ROOT).let { if (it == "und") "" else Util.normalizeLanguageCode(it) ?: it }

    private fun applyAutoSubs(tracks: Tracks) {
        if (!autoSubs || pendingSubLabel != null || tracks.groups.isEmpty()) return
        val p = player ?: return
        autoSubs = false
        var audio = ""
        for (g in tracks.groups) {
            if (g.type != C.TRACK_TYPE_AUDIO) continue
            for (i in 0 until g.length) if (g.isTrackSelected(i)) audio = lang(g.getTrackFormat(i).language)
        }
        var best: Pair<Tracks.Group, Int>? = null
        var bestScore = 0
        for (g in tracks.groups) {
            if (g.type != C.TRACK_TYPE_TEXT) continue
            for (i in 0 until g.length) {
                val f = g.getTrackFormat(i)
                if (!g.isTrackSupported(i) || !isForced(f)) continue
                val l = lang(f.language)
                val score = when {
                    l.isNotEmpty() && l == audio -> 3
                    l.isEmpty() || audio.isEmpty() -> 2
                    else -> 0      // forzati per un'altra lingua dell'audio: non servono
                }
                if (score > bestScore) { best = g to i; bestScore = score }
            }
        }
        val (group, index) = best ?: return
        p.trackSelectionParameters = p.trackSelectionParameters.buildUpon()
            .clearOverridesOfType(C.TRACK_TYPE_TEXT)
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
            .setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, index))
            .build()
    }

    // ---- Traccia audio ricordata per la serie

    /** Chiave della serie (il nome: vale anche per le serie degli amici). Null per i film. */
    private fun seriesKey(): String? =
        if (data.optInt("show_id") > 0 && data.optString("title").isNotBlank()) "audio_show:" + data.optString("title") else null

    private fun rememberAudio(label: String?, language: String?, channels: Int) {
        val key = seriesKey() ?: return
        val v = JSONObject().put("label", label ?: "").put("lang", lang(language)).put("ch", channels)
        prefs.edit().putString(key, v.toString()).apply()
    }

    private fun savedAudio(): JSONObject? {
        val raw = seriesKey()?.let { prefs.getString(it, null) } ?: return null
        return try { JSONObject(raw) } catch (_: Exception) { null }
    }

    /** Stessa traccia: per nome («Italiano 2.0») se ce l'ha, se no per lingua e canali. */
    private fun matchesAudio(saved: JSONObject, label: String?, language: String?, channels: Int): Boolean {
        val name = saved.optString("label")
        if (name.isNotEmpty() && !label.isNullOrEmpty()) return name == label
        return lang(language) == saved.optString("lang") && channels == saved.optInt("ch")
    }

    private fun restoreAudio(tracks: Tracks) {
        if (audioRestored || transcoding || tracks.groups.none { it.type == C.TRACK_TYPE_AUDIO }) return
        audioRestored = true
        val saved = savedAudio() ?: return
        val p = player ?: return
        for (g in tracks.groups) {
            if (g.type != C.TRACK_TYPE_AUDIO) continue
            for (i in 0 until g.length) {
                val f = g.getTrackFormat(i)
                if (!g.isTrackSupported(i) || !matchesAudio(saved, f.label, f.language, f.channelCount)) continue
                if (!g.isTrackSelected(i)) {
                    p.trackSelectionParameters = p.trackSelectionParameters.buildUpon()
                        .clearOverridesOfType(C.TRACK_TYPE_AUDIO)
                        .setOverrideForType(TrackSelectionOverride(g.mediaTrackGroup, i))
                        .build()
                }
                return
            }
        }
    }

    // ---- Audio pulito (vedi CenterOnlyProcessor)

    private fun cleanKey(): String =
        seriesKey()?.let { "clean_show:" + data.optString("title") } ?: ("clean_item:" + data.optInt("id"))

    /** Chiede al PC se il video ha una 5.1 col doppiaggio tutto nel centrale. */
    private fun checkCleanAudio(d: JSONObject) {
        val id = d.optInt("id")
        thread {
            val found = try {
                val list = JSONObject(Net.get("$server/api/audiocheck/$id")).optJSONArray("center_only")
                if (list == null) listOf() else (0 until list.length()).map { list.getJSONObject(it) }
            } catch (_: Exception) {
                listOf()
            }
            runOnUiThread {
                if (isFinishing || data.optInt("id") != id) return@runOnUiThread
                cleanTracks = found
                val choice = prefs.getString(cleanKey(), null)
                val want = found.isNotEmpty() && choice == "yes"
                if (want != cleanAudio) {           // un altro video: l'audio pulito si accende o si spegne
                    cleanAudio = want
                    if (want) {                     // il lettore nuovo riparte dalla traccia predefinita
                        val index = found.first().optInt("index")
                        if (transcoding) serverAudio = index else pendingAudio = index
                    }
                    rebuildPlayer()
                }
                if (found.isNotEmpty() && choice == null) askCleanAudio()
            }
        }
    }

    private fun askCleanAudio() {
        if (cleanAsked) return
        cleanAsked = true
        AlertDialog.Builder(this).setTitle("Audio pulito")
            .setMessage(
                "Nella traccia 5.1 di questo video il doppiaggio è tutto nel canale centrale: " +
                    "negli altri canali a volte si sentono voci in un'altra lingua.\n\n" +
                    "Vuoi provare l'audio pulito? Si sente solo il canale centrale, quello con le voci. " +
                    "La scelta vale per tutta la serie e si cambia da Opzioni."
            )
            .setPositiveButton("Sì, provalo") { _, _ -> setCleanAudio(true) }
            .setNegativeButton("No") { _, _ -> prefs.edit().putString(cleanKey(), "no").apply() }
            .show()
    }

    /** Accende o spegne l'audio pulito; acceso, passa anche alla traccia 5.1 giusta. */
    private fun setCleanAudio(on: Boolean) {
        prefs.edit().putString(cleanKey(), if (on) "yes" else "no").apply()
        val track = cleanTracks.firstOrNull()
        if (on && track != null) {
            val index = track.optInt("index")
            rememberAudio(track.optString("title"), track.optString("lang"), track.optInt("channels"))
            if (transcoding) serverAudio = index else pendingAudio = index
        }
        cleanAudio = on
        showOsd(if (on) "Audio pulito: solo il canale centrale" else "Audio pulito disattivato", 3000)
        rebuildPlayer()
    }

    /** Sceglie la traccia audio numero 'pendingAudio' (nell'ordine del file). */
    private fun applyPendingAudio(tracks: Tracks) {
        if (pendingAudio < 0 || transcoding) return
        val groups = tracks.groups.filter { it.type == C.TRACK_TYPE_AUDIO }
        val g = groups.getOrNull(pendingAudio) ?: return
        pendingAudio = -1
        if (g.isSelected || !g.isTrackSupported(0)) return
        val p = player ?: return
        p.trackSelectionParameters = p.trackSelectionParameters.buildUpon()
            .clearOverridesOfType(C.TRACK_TYPE_AUDIO)
            .setOverrideForType(TrackSelectionOverride(g.mediaTrackGroup, 0))
            .build()
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

    /** Lingua audio e sottotitoli: nelle Opzioni e nel bottone «Audio e sottotitoli». */
    private fun audioSubItems(items: MutableList<Pair<String, () -> Unit>>) {
        if (transcoding) {
            if (serverAudios.size > 1) {
                items.add("Lingua audio:  " + serverAudios.getOrElse(serverAudio) { "" } to {
                    pick("Lingua audio", serverAudios, serverAudio) { i ->
                        serverTracks.getOrNull(i)?.let {
                            rememberAudio(it.optString("title"), it.optString("lang"), it.optInt("channels"))
                        }
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
                    pick("Lingua audio", audios.map { it.label }, current) { i ->
                        val f = audios[i].group.getTrackFormat(audios[i].index)
                        rememberAudio(f.label, f.language, f.channelCount)
                        selectTrack(C.TRACK_TYPE_AUDIO, audios[i])
                    }
                })
            }
        }

        if (cleanTracks.isNotEmpty()) {
            items.add("Audio pulito (solo canale centrale):  " + (if (cleanAudio) "Sì" else "No") to {
                setCleanAudio(!cleanAudio)
            })
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
    }

    private fun showOptions() {
        val p = player ?: return
        hideControls()
        val items = mutableListOf<Pair<String, () -> Unit>>()
        audioSubItems(items)

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
            items.add("Film successivo della collezione:  ${sagaLabel(saga)}" to {
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
        AlertDialog.Builder(this).setTitle(listOf(titleView.text, episodeView.text).filter { it.isNotBlank() }.joinToString(" — "))
            .setMessage(lines.joinToString("\n"))
            .setPositiveButton("Chiudi", null)
            .show()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val p = player
        if (p == null || event.action != KeyEvent.ACTION_DOWN) return super.dispatchKeyEvent(event)
        val now = SystemClock.elapsedRealtime()
        lastKeyAt = now
        val first = event.repeatCount == 0
        val floating = floats()
        when (event.keyCode) {
            KeyEvent.KEYCODE_MEDIA_REWIND -> scrub(-1, event, now)
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> scrub(1, event, now)
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> if (first) {
                togglePlay()
                showControls()
            }
            KeyEvent.KEYCODE_MEDIA_PLAY -> if (first) {
                if (!p.playWhenReady) togglePlay()
                showControls()
            }
            KeyEvent.KEYCODE_MEDIA_PAUSE -> if (first) {
                if (p.playWhenReady) p.pause()
                showControls()
            }
            KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_SETTINGS, KeyEvent.KEYCODE_INFO,
            KeyEvent.KEYCODE_CAPTIONS, KeyEvent.KEYCODE_MEDIA_AUDIO_TRACK -> if (first) showOptions()
            KeyEvent.KEYCODE_MEDIA_NEXT -> if (first && !finished) goNext(data.optInt("next", 0), false)
            KeyEvent.KEYCODE_DPAD_UP -> when {
                !shown -> showControls(Zone.BAR)
                zone == Zone.ROW -> showControls(Zone.BAR)
                zone == Zone.BAR && floating.isNotEmpty() -> {
                    floatAt = floating.size - 1
                    showControls(Zone.FLOAT)
                }
                else -> showControls()
            }
            KeyEvent.KEYCODE_DPAD_DOWN -> when {
                !shown -> showControls(Zone.ROW)
                zone == Zone.FLOAT -> showControls(Zone.BAR)
                else -> showControls(Zone.ROW)
            }
            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT -> {
                val dir = if (event.keyCode == KeyEvent.KEYCODE_DPAD_LEFT) -1 else 1
                when {
                    zone == Zone.FLOAT && floating.size > 1 -> {
                        if (first) floatAt = (floatAt + dir).coerceIn(0, floating.size - 1)
                        paintFocus()
                    }
                    zone == Zone.ROW && shown -> {
                        if (first) rowAt = (rowAt + dir).coerceIn(0, rowActions.size - 1)
                        showControls()
                    }
                    card == 2 -> Unit                 // video finito: non c'e' piu' niente da scorrere
                    else -> scrub(dir, event, now)
                }
            }
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> if (first) {
                when {
                    zone == Zone.FLOAT && floating.isNotEmpty() -> pressFloat()
                    zone == Zone.ROW && shown -> rowActions.getOrNull(rowAt)?.invoke()
                    else -> {
                        togglePlay()
                        showControls(Zone.BAR)
                    }
                }
            }
            else -> return super.dispatchKeyEvent(event)
        }
        return true
    }

    /** ◀ ▶ sulla barra. Una pressione: un salto; tenendo premuto si scorre, sempre piu' veloce
     *  (i salti si sommano e il video si sposta quando si lascia il tasto). */
    private fun scrub(dir: Int, event: KeyEvent, now: Long) {
        if (event.repeatCount == 0) {
            seekBy(if (dir < 0) -stepBack() else stepForward())
        } else {
            if (now - holdSeekAt < 120) return
            val held = now - event.downTime
            val step = when {
                held > 6000 -> 60_000L
                held > 3000 -> 30_000L
                else -> 10_000L
            }
            seekBy(dir * step)
        }
        holdSeekAt = now
        showControls(Zone.BAR)
    }

    override fun onStart() {
        super.onStart()
        visible = true
        handler.postDelayed(ticker, 10_000)
        lastMoveAt = SystemClock.elapsedRealtime()
        handler.postDelayed(watchdog, 1000)
        handler.post(uiTick)
        if (pendingSeek >= 0) handler.post(applySeek)
    }

    override fun onStop() {
        visible = false
        handler.removeCallbacks(ticker)
        handler.removeCallbacks(watchdog)
        handler.removeCallbacks(uiTick)
        if (card == 2) finish()        // TV spenta a fine episodio: niente partenze al buio
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
