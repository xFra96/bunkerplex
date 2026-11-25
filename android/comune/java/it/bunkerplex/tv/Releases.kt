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

    /** Chiede a GitHub l'ultima release della linea (es. "tv-v", "BunkerPlexTV.apk"). Fuori dal thread principale. */
    fun fetch(prefix: String, apk: String): Latest? {
        val list = JSONArray(Net.get("https://api.github.com/repos/$REPO/releases?per_page=50", 10000, auth = false))
        var best: JSONObject? = null
        var bestVer: List<Int>? = null
        for (i in 0 until list.length()) {
            val rel = list.getJSONObject(i)
            if (rel.optBoolean("draft") || rel.optBoolean("prerelease")) continue
            val ver = parse(rel.optString("tag_name"), prefix) ?: continue
            if (bestVer == null || newer(ver, bestVer)) { best = rel; bestVer = ver }
        }
        val rel = best ?: return null
        val assets = rel.optJSONArray("assets") ?: return null
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
        val name = meta.optString("version").ifEmpty { rel.optString("tag_name").removePrefix(prefix) }
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
     * Controlla su GitHub (al massimo ogni 6 ore, o subito con force) e ricorda
     * il risultato. Fuori dal thread principale. Se GitHub non risponde resta
     * quello di prima.
     */
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
