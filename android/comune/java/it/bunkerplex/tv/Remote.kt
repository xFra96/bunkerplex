package it.bunkerplex.tv

import android.content.Context

/**
 * L'indirizzo del servizio account di BunkerPlex: da li' arriva la PWA centrale che
 * l'app mostra (accesso, scelta del server, tutto il resto).
 */
object Remote {
    /** Il servizio account di BunkerPlex (lo stesso di server/cloud.json); un server
     *  di casa puo' dirne un altro (lo si impara da /api/info). */
    const val DEFAULT_CLOUD = "https://bunkerplex-account.bunkerplex.workers.dev"

    private fun prefs(ctx: Context) = ctx.getSharedPreferences("bunkerplex", Context.MODE_PRIVATE)

    fun cloud(ctx: Context): String =
        prefs(ctx).getString("cloud", null)?.takeIf { it.startsWith("https://") } ?: DEFAULT_CLOUD

    fun setCloud(ctx: Context, url: String) {
        if (url.startsWith("https://")) prefs(ctx).edit().putString("cloud", url.trimEnd('/')).apply()
    }
}
