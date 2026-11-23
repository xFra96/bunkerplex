package it.bunkerplex.atv

import android.content.Context
import it.bunkerplex.tv.Net
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

    private const val PREFS = "bunkerplex"

    fun load(ctx: Context) {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        base = p.getString("server", "") ?: ""
        Net.session = p.getString("session", "") ?: ""
    }

    fun saveServer(ctx: Context, url: String) {
        base = url
        Net.session = ""
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("server", url).putString("session", "").apply()
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
    val title: String,
    val subtitle: String,
    val poster: String?,
    val wide: String?,         // immagine orizzontale (fotogramma o sfondo)
    val progress: Float,       // 0..1, punto di ripresa
    val watched: Boolean,
) {
    companion object {
        fun from(j: JSONObject): Card {
            val kind = j.optString("kind")
            val dur = j.optDouble("duration", 0.0)
            val pos = j.optDouble("position", 0.0)
            val title: String
            val sub: String
            when (kind) {
                "episode" -> {
                    title = j.optString("show_title").ifEmpty { j.optString("title") }
                    sub = "S${j.optInt("season")} · E${j.optInt("episode")}  ${j.optString("title")}".trim()
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
            return Card(
                id = j.optInt("id"), kind = kind, title = title, subtitle = sub,
                poster = j.str("poster"),
                wide = if (kind == "episode") j.str("thumb") ?: j.str("backdrop") else j.str("backdrop") ?: j.str("thumb"),
                progress = if (dur > 0 && pos > 20 && !j.optBoolean("watched")) (pos / dur).toFloat().coerceIn(0f, 1f) else 0f,
                watched = j.optBoolean("watched"),
            )
        }
    }
}

fun JSONObject.str(k: String): String? = if (isNull(k)) null else optString(k).ifEmpty { null }

fun JSONArray?.objects(): List<JSONObject> =
    if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }

fun JSONArray?.strings(): List<String> =
    if (this == null) emptyList() else (0 until length()).map { optString(it) }
