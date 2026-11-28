package it.bunkerplex.tv

import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Il server di casa visto dalla pagina https dell'account.
 *
 * La pagina (PWA centrale) e' in https, il server di casa risponde in http: i WebView
 * recenti bloccano queste richieste come «contenuto misto» anche con
 * MIXED_CONTENT_ALWAYS_ALLOW (locandine vuote, «Failed to fetch»). Dentro l'app la
 * pagina chiede allora https://<servizio>/__lan/<ip>:<porta>/<percorso>: lo stesso sito
 * della pagina, quindi niente contenuto misto; l'app lo prende qui e lo gira in http
 * al server di casa. Le GET (immagini, elenchi, video in pagina) passano da
 * shouldInterceptRequest; le altre (POST, con il corpo) dal ponte lanFetch.
 * Solo indirizzi della rete di casa.
 */
object LanProxy {
    const val PREFIX = "/__lan/"
    private val TARGET = Regex("^((?:10|127|192\\.168|172\\.(?:1[6-9]|2\\d|3[01]))(?:\\.\\d{1,3}){2,3}:\\d{2,5})(/.*)?$")
    private val SKIP = setOf("host", "origin", "referer", "connection", "accept-encoding", "content-length")

    /** https://<servizio>/__lan/<ip:porta>/x -> http://<ip:porta>/x, o null se non e' per noi. */
    fun target(url: Uri, cloudHost: String): String? {
        if (url.scheme != "https" || url.host != cloudHost) return null
        val path = url.encodedPath ?: return null
        if (!path.startsWith(PREFIX)) return null
        val m = TARGET.matchEntire(path.substring(PREFIX.length)) ?: return null
        return "http://" + m.groupValues[1] + (m.groupValues[2].ifEmpty { "/" }) +
            (url.encodedQuery?.let { "?$it" } ?: "")
    }

    /** Tutti gli indirizzi «https://<servizio>/__lan/» di un testo tornano http (per il player). */
    fun unwrap(text: String, cloud: String): String =
        text.replace(cloud.trimEnd('/') + PREFIX, "http://")
            .replace(cloud.trimEnd('/').replace("/", "\\/") + PREFIX.replace("/", "\\/"), "http:\\/\\/")

    private fun open(target: String, method: String, headers: Map<String, String>, body: ByteArray?): HttpURLConnection {
        val c = URL(target).openConnection() as HttpURLConnection
        c.connectTimeout = 8000
        c.readTimeout = 60000
        c.instanceFollowRedirects = false
        c.requestMethod = method
        for ((k, v) in headers) if (k.lowercase() !in SKIP) c.setRequestProperty(k, v)
        if (body != null) {
            c.doOutput = true
            c.outputStream.use { it.write(body) }
        }
        return c
    }

    private fun headersOf(c: HttpURLConnection): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        for ((k, v) in c.headerFields) {
            if (k == null || k.lowercase() in setOf("content-encoding", "transfer-encoding", "connection")) continue
            out[k] = v.joinToString(", ")
        }
        return out
    }

    /** GET dalla pagina: la risposta del server di casa, o un 502 se non risponde. */
    fun serve(request: WebResourceRequest, target: String): WebResourceResponse {
        Posters.serve(Uri.parse(target))?.let { return it }   // locandine gia' salvate sulla TV
        return try {
            val c = open(target, request.method, request.requestHeaders ?: emptyMap(), null)
            val code = c.responseCode
            val stream: InputStream = (if (code >= 400) c.errorStream else c.inputStream)
                ?: ByteArrayInputStream(ByteArray(0))
            val type = c.contentType ?: "application/octet-stream"
            WebResourceResponse(type.substringBefore(';').trim(),
                Regex("charset=([\\w-]+)").find(type)?.groupValues?.get(1),
                code, c.responseMessage?.ifBlank { null } ?: "OK", headersOf(c), stream)
        } catch (e: IOException) {
            WebResourceResponse("text/plain", "utf-8", 502, "Bad Gateway", emptyMap(),
                ByteArrayInputStream(("server di casa: " + (e.message ?: "non raggiungibile")).toByteArray()))
        }
    }

    /** Le altre richieste (POST...) dal ponte: {status, headers, body} in JSON. */
    fun fetch(method: String, url: String, headersJson: String, body: String?, cloudHost: String): String {
        val out = JSONObject()
        val target = target(Uri.parse(url), cloudHost)
        if (target == null) return out.put("status", 0).put("error", "indirizzo non valido").toString()
        return try {
            val hj = if (headersJson.isBlank()) JSONObject() else JSONObject(headersJson)
            val headers = hj.keys().asSequence().associateWith { hj.optString(it) }
            val c = open(target, method.uppercase(), headers, body?.toByteArray())
            val code = c.responseCode
            val head = headersOf(c)
            val text = ((if (code >= 400) c.errorStream else c.inputStream)?.use { it.readBytes() } ?: ByteArray(0))
                .toString(Charsets.UTF_8)
            c.disconnect()
            out.put("status", code).put("headers", JSONObject(head as Map<*, *>)).put("body", text).toString()
        } catch (e: Exception) {
            out.put("status", 0).put("error", e.message ?: "non raggiungibile").toString()
        }
    }
}
