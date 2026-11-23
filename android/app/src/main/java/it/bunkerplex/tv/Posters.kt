package it.bunkerplex.tv

import android.content.Context
import android.net.Uri
import android.webkit.CookieManager
import android.webkit.WebResourceResponse
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Locandine e sfondi salvati sulla TV: la cache del WebView e' piccola e li butta
 * via presto, cosi' a ogni riapertura si riscaricavano e si aspettava. Qui restano
 * fino a 300 MB (le meno usate escono per prime). Solo le immagini di TMDB: hanno un
 * nome che non cambia mai, quindi una copia salvata non diventa mai vecchia.
 */
object Posters {
    private val NAME = Regex("^/api/image/((?:w\\d+|original)_[\\w.\\-]{1,120}\\.(jpg|jpeg|png|webp))$", RegexOption.IGNORE_CASE)
    private const val MAX_BYTES = 300L * 1024 * 1024
    private val trimming = AtomicBoolean(false)

    @Volatile
    private var dir: File? = null

    fun init(context: Context) {
        dir = File(context.cacheDir, "posters").apply { mkdirs() }
    }

    /** La risposta dalla copia salvata, o null per lasciar fare al WebView. */
    fun serve(url: Uri): WebResourceResponse? {
        val d = dir ?: return null
        val m = NAME.matchEntire(url.path ?: return null) ?: return null
        val size = url.getQueryParameter("size")?.toIntOrNull() ?: 0
        if (url.query != null && url.query != "size=$size") return null
        val file = File(d, if (size > 0) "s${size}_${m.groupValues[1]}" else m.groupValues[1])
        if (file.isFile && file.length() > 0) {
            file.setLastModified(System.currentTimeMillis())   // usata adesso: esce per ultima
        } else {
            if (!fetch(url.toString(), file)) return null
            trimSoon(d)
        }
        val mime = when (m.groupValues[2].lowercase()) {
            "png" -> "image/png"
            "webp" -> "image/webp"
            else -> "image/jpeg"
        }
        return try {
            WebResourceResponse(mime, null, 200, "OK",
                mapOf("Cache-Control" to "public, max-age=31536000, immutable"), FileInputStream(file))
        } catch (e: IOException) {
            null
        }
    }

    private fun fetch(url: String, target: File): Boolean {
        val tmp = File(target.parentFile, target.name + "." + Thread.currentThread().id + ".part")
        var c: HttpURLConnection? = null
        return try {
            c = URL(url).openConnection() as HttpURLConnection
            c.connectTimeout = 8000
            c.readTimeout = 15000
            CookieManager.getInstance().getCookie(url)?.let { c.setRequestProperty("Cookie", it) }
            if (Net.session.isNotEmpty()) c.setRequestProperty("X-BP-Session", Net.session)
            if (c.responseCode != 200) return false
            c.inputStream.use { input -> tmp.outputStream().use { input.copyTo(it, 64 * 1024) } }
            tmp.length() > 0 && tmp.renameTo(target)
        } catch (e: Exception) {
            false
        } finally {
            c?.disconnect()
            tmp.delete()
        }
    }

    /** Oltre il limite si tolgono le immagini usate meno di recente, fino all'80%. */
    private fun trimSoon(d: File) {
        if (!trimming.compareAndSet(false, true)) return
        thread(name = "posters-trim", priority = Thread.MIN_PRIORITY) {
            try {
                val files = d.listFiles()?.filter { it.isFile } ?: return@thread
                var total = files.sumOf { it.length() }
                if (total <= MAX_BYTES) return@thread
                for (f in files.sortedBy { it.lastModified() }) {
                    if (total <= MAX_BYTES * 8 / 10) break
                    total -= f.length()
                    f.delete()
                }
            } finally {
                trimming.set(false)
            }
        }
    }
}
