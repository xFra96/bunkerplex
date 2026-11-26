package it.bunkerplex.tv

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Aggiornamenti delle app direttamente dalle loro release su GitHub, senza
 * passare dal server: ogni app ha la sua linea di versioni (app-v1.0 per
 * l'app Android, tv-v1.0 per l'app TV nativa) e allega l'APK e un piccolo
 * JSON con il numero di versione (code) e il server minimo che le serve.
 */
object Releases {
    private const val REPO = "xFra96/bunkerplex"
    private const val EVERY_MS = 6 * 3600_000L      // controllo automatico: ogni 6 ore

    /**
     * Livello delle API del server che queste app sanno usare: il server lo dice
     * in /api/info ("api"; se manca e' 1). Si alza solo quando un'app nuova ha
     * davvero bisogno di un server nuovo, e allora l'app avvisa di aggiornarlo.
     */
    const val MIN_SERVER_API = 1

    /** Ultima versione pubblicata: nome (1.2), numero (code), APK e server minimo. */
    data class Latest(val name: String, val code: Long, val url: String, val minServerApi: Int) {
        fun json(): String = JSONObject().put("name", name).put("code", code).put("url", url)
            .put("min_api", minServerApi).toString()
    }

    /** Livello API di un server, da /api/info (i server di prima non lo dicono: 1). */
    fun serverApi(info: JSONObject?): Int = info?.optInt("api", 1) ?: 1

    private fun parse(tag: String, prefix: String): List<Int>? {
        if (!tag.startsWith(prefix)) return null
        val parts = tag.removePrefix(prefix).split('.')
        if (parts.isEmpty() || parts.size > 3) return null
        return parts.map { it.toIntOrNull() ?: return null } + List(3 - parts.size) { 0 }
    }

    private fun newer(a: List<Int>, b: List<Int>): Boolean {
        for (i in 0 until 3) if (a[i] != b[i]) return a[i] > b[i]
        return false
    }

    /** Chiede a GitHub l'ultima release della linea (es. "tv-v", "BunkerPlexTV.apk"). Fuori dal thread principale.
     *  Si parte dai tag della linea, non dall'elenco delle release: quelle del server
     *  escono a ogni modifica e spingerebbero indietro quelle delle app. */
    fun fetch(prefix: String, apk: String): Latest? {
        val api = "https://api.github.com/repos/$REPO"
        val refs = JSONArray(Net.get("$api/git/matching-refs/tags/$prefix", 10000, auth = false))
        val tags = (0 until refs.length()).map { refs.getJSONObject(it).optString("ref").removePrefix("refs/tags/") }
            .mapNotNull { t -> parse(t, prefix)?.let { t to it } }
            .sortedWith { a, b -> if (newer(a.second, b.second)) -1 else if (newer(b.second, a.second)) 1 else 0 }
        // La piu' nuova con una release pubblicata (un tag appena creato puo' non averla ancora)
        var rel: JSONObject? = null
        for ((tag, _) in tags.take(3)) {
            rel = try { JSONObject(Net.get("$api/releases/tags/$tag", 10000, auth = false)) } catch (_: Exception) { null }
            if (rel != null && !rel.optBoolean("draft") && !rel.optBoolean("prerelease")) break
            rel = null
        }
        val found = rel ?: return null
        val assets = found.optJSONArray("assets") ?: return null
        fun asset(name: String): String? {
            for (i in 0 until assets.length()) {
                val a = assets.getJSONObject(i)
                if (a.optString("name") == name) return a.optString("browser_download_url").takeIf { it.startsWith("https://") }
            }
            return null
        }
        val url = asset(apk) ?: return null
        val meta = asset(apk.removeSuffix(".apk") + ".json")?.let {
            try { JSONObject(Net.get(it, 10000, auth = false)) } catch (_: Exception) { null }
        } ?: return null
        val code = meta.optLong("code", 0)
        if (code <= 0) return null
        val name = meta.optString("version").ifEmpty { found.optString("tag_name").removePrefix(prefix) }
        return Latest(name, code, url, meta.optInt("min_server_api", 1))
    }

    /** L'ultima versione ricordata (o null). */
    fun cached(ctx: Context, prefix: String): Latest? {
        val s = ctx.getSharedPreferences("releases", Context.MODE_PRIVATE).getString(prefix, null) ?: return null
        return try {
            val o = JSONObject(s)
            Latest(o.getString("name"), o.getLong("code"), o.getString("url"), o.optInt("min_api", 1))
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Controlla su GitHub (al massimo ogni 6 ore, o subito con force: le app lo
     * fanno a ogni apertura) e ricorda il risultato. Fuori dal thread principale.
     * Se GitHub non risponde resta quello di prima. Una chiamata alla volta: chi
     * arriva mentre un'altra chiede a GitHub ne aspetta la risposta.
     */
    @Synchronized
    fun check(ctx: Context, prefix: String, apk: String, force: Boolean): Latest? {
        val prefs = ctx.getSharedPreferences("releases", Context.MODE_PRIVATE)
        val at = prefs.getLong("$prefix:at", 0)
        if (!force && System.currentTimeMillis() - at < EVERY_MS) return cached(ctx, prefix)
        try {
            val found = fetch(prefix, apk)
            val edit = prefs.edit().putLong("$prefix:at", System.currentTimeMillis())
            if (found != null) edit.putString(prefix, found.json())
            edit.apply()
            return found ?: cached(ctx, prefix)
        } catch (e: Exception) {
            if (force) throw e
            return cached(ctx, prefix)
        }
    }
}
