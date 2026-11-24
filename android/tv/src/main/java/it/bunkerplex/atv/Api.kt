package it.bunkerplex.atv

import android.content.Context
import it.bunkerplex.tv.Net
import it.bunkerplex.tv.Remote
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** Errore del server con il suo messaggio (il campo "detail" delle API). */
class ApiError(val status: Int, message: String, val body: JSONObject? = null) : IOException(message)

/**
 * Le API del server BunkerPlex. L'ingresso («Chi guarda?») e' un gettone che
 * viaggia nell'intestazione X-BP-Session (lo stesso che usa il player, Net.session).
 */
object Api {
    @Volatile
    var base = ""

    /** Chi sta guardando (il nome nel menu a sinistra). */
    @Volatile
    var user: String? = null

    private const val PREFS = "bunkerplex"

    /** Il server di casa scelto; base e' quello in uso (fuori casa, per esempio, l'indirizzo Tailscale dello stesso PC). */
    @Volatile
    var home = ""

    fun load(ctx: Context) {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        home = p.getString("server", "") ?: ""
        if (base.isEmpty()) base = home
        Net.session = p.getString("session", "") ?: ""
    }

    fun saveServer(ctx: Context, url: String) {
        home = url
        base = url
        Net.session = ""
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("server", url).putString("session", "").putString("server_others", "").apply()
    }

    /**
     * Il primo indirizzo del server che risponde: prima quello di casa, poi (fuori casa)
     * gli altri dello stesso PC che il server stesso ha detto, come quello di Tailscale.
     * null = nessuno: si propongono amici e tuoi PC (Tailscale dentro l'app).
     */
    fun reach(ctx: Context): String? {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (home.isEmpty()) return null
        val others = (p.getString("server_others", "") ?: "").split(' ').filter { it.isNotBlank() }
        for (url in (listOf(home) + others).distinct()) {
            val info = Net.info(url, if (url == home) 3000 else 6000) ?: continue
            Remote.setCloud(ctx, info.optString("cloud"))
            info.optJSONArray("addresses")?.let { list ->
                val all = (0 until list.length()).map { Net.normalize(list.getString(it)) }.distinct()
                p.edit().putString("server_others", all.joinToString(" ")).apply()
            }
            base = url
            return url
        }
        return null
    }

    fun saveSession(ctx: Context, token: String) {
        Net.session = token
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("session", token).apply()
    }

    fun url(path: String?): String? =
        if (path.isNullOrEmpty()) null else if (path.startsWith("http")) path else base + path

    /** Immagine in versione leggera (le chiavette decodificano meno pixel). */
    fun image(path: String?, size: Int): String? {
        val u = url(path) ?: return null
        return if (path!!.startsWith("/api/image/")) "$u?size=$size" else u
    }

    fun get(path: String, timeoutMs: Int = 10000): String = request("GET", path, null, timeoutMs).first

    fun obj(path: String) = JSONObject(get(path))
    fun arr(path: String) = JSONArray(get(path))

    fun post(path: String, body: JSONObject): Pair<String, String?> = request("POST", path, body.toString(), 30000)

    private fun request(method: String, path: String, body: String?, timeoutMs: Int): Pair<String, String?> {
        val c = URL(base + path).openConnection() as HttpURLConnection
        c.connectTimeout = 5000
        c.readTimeout = timeoutMs
        c.requestMethod = method
        if (Net.session.isNotEmpty()) c.setRequestProperty("X-BP-Session", Net.session)
        try {
            if (body != null) {
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json")
                c.outputStream.use { it.write(body.toByteArray()) }
            }
            val code = c.responseCode
            val stream = if (code >= 400) c.errorStream else c.inputStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
            if (code >= 400) {
                val j = try { JSONObject(text) } catch (_: Exception) { null }
                val detail = j?.opt("detail")
                throw ApiError(code, (detail as? String) ?: "Errore del server ($code)", j)
            }
            // Gettone dell'ingresso: arriva come cookie bp_session
            val token = c.headerFields.entries.firstOrNull { it.key.equals("Set-Cookie", true) }?.value
                ?.firstNotNullOfOrNull { v ->
                    v.split(';').first().trim().takeIf { it.startsWith("bp_session=") }?.substringAfter('=')
                }
            return text to token
        } finally {
            c.disconnect()
        }
    }
}

/** Un titolo da mostrare in una fila: film, serie, episodio o saga. */
data class Card(
    val id: Int,
    val kind: String,          // movie, show, episode, collection
    val title: String,         // per gli episodi: il nome della serie
    val subtitle: String,
    val poster: String?,
    val wide: String?,         // immagine orizzontale (fotogramma o sfondo)
    val backdrop: String?,     // sfondo dell'anteprima (per gli episodi quello della serie)
    val progress: Float,       // 0..1, punto di ripresa
    val watched: Boolean,
    val overview: String,
    val year: Int,
    val yearTo: Int,
    val duration: Double,
    val position: Double,
    val rating: Double,
    val quality: String,
    val genres: List<String>,
    val episodeLine: String,   // «S8 · E3 · Titolo» per gli episodi
    val hue: Int,              // tinta del riquadro finche' non c'e' l'immagine
) {
    companion object {
        fun from(j: JSONObject): Card {
            val kind = j.optString("kind")
            val dur = j.optDouble("duration", 0.0)
            val pos = j.optDouble("position", 0.0)
            val title: String
            val sub: String
            var epLine = ""
            when (kind) {
                "episode" -> {
                    title = j.optString("show_title").ifEmpty { j.optString("title") }
                    epLine = listOf("S${j.optInt("season")} · E${j.optInt("episode")}", j.optString("title"))
                        .filter { it.isNotBlank() }.joinToString(" · ")
                    sub = epLine
                }
                "show" -> {
                    title = j.optString("title")
                    val n = j.optInt("seasons_count")
                    sub = if (n > 1) "$n stagioni" else "${j.optInt("episodes")} episodi"
                }
                "collection" -> {
                    title = j.optString("title")
                    sub = "${j.optInt("count")} film"
                }
                else -> {
                    title = j.optString("title")
                    sub = j.optInt("year").takeIf { it > 0 }?.toString() ?: ""
                }
            }
            val watched = j.optBoolean("watched")
            return Card(
                id = j.optInt("id"), kind = kind, title = title, subtitle = sub,
                poster = j.str("poster"),
                wide = if (kind == "episode") j.str("thumb") ?: j.str("backdrop") else j.str("backdrop") ?: j.str("thumb"),
                backdrop = j.str("backdrop") ?: j.str("thumb"),
                progress = if (dur > 0 && pos > 20 && !watched) (pos / dur).toFloat().coerceIn(0f, 1f) else 0f,
                watched = watched,
                overview = j.optString("overview"),
                year = j.optInt("year"),
                yearTo = j.optInt("year_to"),
                duration = dur,
                position = if (watched) 0.0 else pos,
                rating = j.optDouble("rating", 0.0).takeIf { !it.isNaN() } ?: 0.0,
                quality = j.optString("quality"),
                genres = j.optJSONArray("genres").strings(),
                episodeLine = epLine,
                hue = hue(title),
            )
        }
    }
}

fun JSONObject.str(k: String): String? = if (isNull(k)) null else optString(k).ifEmpty { null }

fun JSONArray?.objects(): List<JSONObject> =
    if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }

fun JSONArray?.strings(): List<String> =
    if (this == null) emptyList() else (0 until length()).map { optString(it) }
