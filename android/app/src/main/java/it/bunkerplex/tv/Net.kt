package it.bunkerplex.tv

import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.net.URL
import java.util.Collections
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Piccole funzioni di rete: niente librerie esterne. */
object Net {
    const val PORT = 32500
    private val background = Executors.newSingleThreadExecutor()

    /** Gettone dell'account con cui la TV e' entrata (arriva dal server insieme al video). */
    @Volatile
    var session: String = ""

    private fun open(url: String): HttpURLConnection {
        val c = URL(url).openConnection() as HttpURLConnection
        if (session.isNotEmpty()) c.setRequestProperty("X-BP-Session", session)
        return c
    }

    fun get(url: String, timeoutMs: Int = 8000): String {
        val c = open(url)
        c.connectTimeout = timeoutMs
        c.readTimeout = timeoutMs
        try {
            return c.inputStream.bufferedReader().use { it.readText() }
        } finally {
            c.disconnect()
        }
    }

    /** Scarica un file; 'progress' riceve la percentuale (0-100) man mano. */
    fun download(url: String, target: File, progress: (Int) -> Unit) {
        val c = open(url)
        c.connectTimeout = 8000
        c.readTimeout = 20000
        try {
            if (c.responseCode != 200) throw IOException("HTTP ${c.responseCode}")
            val total = c.contentLength.toLong()
            var done = 0L
            var shown = -1
            c.inputStream.use { input ->
                target.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buffer)
                        if (n < 0) break
                        output.write(buffer, 0, n)
                        done += n
                        val pct = if (total > 0) (done * 100 / total).toInt() else 0
                        if (pct != shown) {
                            shown = pct
                            progress(pct)
                        }
                    }
                }
            }
            if (total > 0 && done != total) throw IOException("Scaricamento interrotto")
        } finally {
            c.disconnect()
        }
    }

    /** POST che aspetta la risposta (da chiamare fuori dal thread principale). */
    fun post(url: String, json: String, timeoutMs: Int = 30000): String {
        val c = open(url)
        c.connectTimeout = 5000
        c.readTimeout = timeoutMs
        c.requestMethod = "POST"
        c.doOutput = true
        c.setRequestProperty("Content-Type", "application/json")
        try {
            c.outputStream.use { it.write(json.toByteArray()) }
            return c.inputStream.bufferedReader().use { it.readText() }
        } finally {
            c.disconnect()
        }
    }

    fun postAsync(url: String, json: String) {
        background.execute {
            try {
                val c = open(url)
                c.connectTimeout = 5000
                c.readTimeout = 5000
                c.requestMethod = "POST"
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json")
                c.outputStream.use { it.write(json.toByteArray()) }
                c.responseCode
                c.disconnect()
            } catch (_: Exception) {
            }
        }
    }

    /** Le informazioni del server, o null se a quell'indirizzo non risponde BunkerPlex. */
    fun info(baseUrl: String, timeoutMs: Int): org.json.JSONObject? =
        try {
            org.json.JSONObject(get("$baseUrl/api/info", timeoutMs)).takeIf { it.optString("app") == "bunkerplex" }
        } catch (_: Exception) {
            null
        }

    fun isBunkerPlex(baseUrl: String, timeoutMs: Int = 4000): Boolean =
        try {
            get("$baseUrl/api/info", timeoutMs).contains("bunkerplex")
        } catch (_: Exception) {
            false
        }

    /** "192.168.1.20" -> "http://192.168.1.20:32500" */
    fun normalize(input: String): String {
        var s = input.trim().trimEnd('/')
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://$s"
        val host = s.substringAfter("://")
        if (!host.contains(':')) s = "$s:$PORT"
        return s
    }

    private fun localPrefixes(): List<String> {
        val out = mutableListOf<String>()
        try {
            for (ni in Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp || ni.isLoopback) continue
                for (a in Collections.list(ni.inetAddresses)) {
                    if (a is Inet4Address && a.isSiteLocalAddress) {
                        out.add(a.hostAddress!!.substringBeforeLast('.'))
                    }
                }
            }
        } catch (_: Exception) {
        }
        return out.distinct()
    }

    /** Cerca il server sulla rete di casa provando tutti gli indirizzi vicini. */
    fun discover(): String? {
        val prefixes = localPrefixes()
        if (prefixes.isEmpty()) return null
        val pool = Executors.newFixedThreadPool(48)
        val found = AtomicReference<String?>(null)
        for (prefix in prefixes) {
            for (i in 1..254) {
                pool.execute {
                    if (found.get() != null) return@execute
                    val host = "$prefix.$i"
                    try {
                        Socket().use { it.connect(InetSocketAddress(host, PORT), 400) }
                        val url = "http://$host:$PORT"
                        if (isBunkerPlex(url, 2500)) found.compareAndSet(null, url)
                    } catch (_: Exception) {
                    }
                }
            }
        }
        pool.shutdown()
        pool.awaitTermination(25, TimeUnit.SECONDS)
        return found.get()
    }
}
