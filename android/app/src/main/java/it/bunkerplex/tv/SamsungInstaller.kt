package it.bunkerplex.tv

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URL
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Collections
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Installa l'app BunkerPlex sulle TV Samsung (Tizen) dal telefono, come
 * TvInstaller fa con le TV Android, ma col protocollo «sdb» di Samsung. Lo stesso
 * lavoro di server/samsunginstall.py (vedi li' per i dettagli del protocollo).
 *
 * Sulla TV si accende la Modalita' sviluppatore scrivendo come «IP del PC host»
 * l'indirizzo del telefono: la TV accetta collegamenti sdb (porta 26101) solo da
 * li'. Poi: BunkerPlex.wgt dalla release «samsung-tv», copia sulla TV («sync:»),
 * installazione («0 vd_appinstall») e apertura («0 was_execute»).
 */
object SamsungInstaller {
    private const val SDB_PORT = 26101
    private const val API_PORT = 8001
    private const val PACKAGE = "BnkrPlex01"
    private const val APP_ID = "$PACKAGE.BunkerPlex"
    private const val WGT_URL = "https://github.com/xFra96/bunkerplex/releases/download/samsung-tv/BunkerPlex.wgt"
    private const val TOOLPATH = "/home/owner/share/tmp/sdk_tools"

    @Volatile
    var listener: ((String) -> Unit)? = null

    private class Tv(val ip: String) {
        var name = ""
        var model = ""
        var dev = false
        var devIp = ""
        var installed = false
    }

    private val tvs = LinkedHashMap<String, Tv>()
    private val log = ArrayList<JSONObject>()
    @Volatile private var phase = ""
    @Volatile private var step = "dev"
    @Volatile private var message = ""
    @Volatile private var error = ""
    @Volatile private var target = ""
    @Volatile private var scanned = false
    @Volatile private var worker: Thread? = null
    @Volatile private var cancelled = false
    @Volatile private var open: Sdb? = null

    /** L'indirizzo del telefono nel Wi-Fi: va scritto sulla TV come «IP del PC host». */
    private fun phoneIp(): String {
        try {
            for (ni in Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp || ni.isLoopback) continue
                for (a in Collections.list(ni.inetAddresses)) {
                    if (a is Inet4Address && a.isSiteLocalAddress) return a.hostAddress ?: ""
                }
            }
        } catch (_: Exception) {
        }
        return ""
    }

    @Synchronized
    fun state(ctx: Context): String = JSONObject()
        .put("phase", phase).put("step", step).put("message", message).put("error", error)
        .put("target", target).put("scanned", scanned).put("pc", phoneIp())
        .put("tvs", JSONArray(tvs.values.map {
            JSONObject().put("ip", it.ip).put("name", it.name).put("model", it.model).put("dev", it.dev)
                .put("dev_ip", it.devIp).put("installed", it.installed)
        }))
        .put("log", JSONArray(log.takeLast(80)))
        .toString()

    private fun push(ctx: Context) {
        listener?.invoke(state(ctx))
    }

    @Synchronized
    private fun say(text: String, kind: String = "info") {
        log.add(JSONObject().put("at", System.currentTimeMillis() / 1000).put("kind", kind).put("text", text))
        if (log.size > 200) log.subList(0, log.size - 200).clear()
    }

    private fun job(ctx: Context, what: String, ip: String, body: () -> Unit) {
        if (worker?.isAlive == true) return
        cancelled = false
        phase = what
        target = ip
        error = ""
        say(if (what == "scan") "Cerco le TV Samsung" else "Installo su $ip", "sep")
        push(ctx)
        worker = thread(name = "samsung-$what") {
            try {
                body()
            } catch (e: Exception) {
                if (cancelled) {
                    say("Interrotto", "err")
                    error = ""
                } else {
                    error = e.message ?: e.javaClass.simpleName
                    say(error, "err")
                }
            } finally {
                try { open?.close() } catch (_: Exception) {}
                open = null
                phase = ""
                message = ""
                push(ctx)
            }
        }
    }

    fun cancel(ctx: Context) {
        cancelled = true
        try { open?.close() } catch (_: Exception) {}
        worker?.interrupt()
        push(ctx)
    }

    private fun check() {
        if (cancelled) throw InterruptedException()
    }

    // ---------------------------------------------------------------- ricerca

    private fun portOpen(ip: String, port: Int) = try {
        Socket().use { it.connect(InetSocketAddress(ip, port), 600) }
        true
    } catch (_: Exception) {
        false
    }

    /** Nome e Modalita' sviluppatore dall'API della TV (porta 8001), se risponde. */
    private fun info(ip: String): JSONObject? = try {
        val c = URL("http://$ip:$API_PORT/api/v2/").openConnection() as HttpURLConnection
        c.connectTimeout = 1500
        c.readTimeout = 1500
        c.inputStream.use { JSONObject(it.bufferedReader().readText()).optJSONObject("device") }
    } catch (_: Exception) {
        null
    }

    private fun apply(tv: Tv, d: JSONObject) {
        tv.name = d.optString("name").removePrefix("[TV] ").trim()
        tv.model = d.optString("modelName")
        tv.dev = d.optString("developerMode") == "1" || tv.dev
        tv.devIp = d.optString("developerIP")
    }

    fun scan(ctx: Context) = job(ctx, "scan", "") {
        step = "scan"
        message = "Cerco le TV Samsung nella rete di casa…"
        push(ctx)
        val me = phoneIp()
        if (me.isEmpty()) throw IOException("Il telefono non è collegato al Wi-Fi.")
        val prefix = me.substringBeforeLast('.')
        val found = Collections.synchronizedList(mutableListOf<Tv>())
        val pool = Executors.newFixedThreadPool(64)
        for (i in 1..254) {
            val ip = "$prefix.$i"
            if (ip == me) continue
            pool.execute {
                if (cancelled) return@execute
                val api = portOpen(ip, API_PORT)
                val sdb = portOpen(ip, SDB_PORT)
                if (!api && !sdb) return@execute
                val d = if (api) info(ip) else null
                if (d == null && !sdb) return@execute         // 8001 aperta ma non e' una Samsung
                found.add(Tv(ip).apply { dev = sdb; if (d != null) apply(this, d) })
            }
        }
        pool.shutdown()
        pool.awaitTermination(40, TimeUnit.SECONDS)
        check()
        synchronized(this) {
            val before = tvs.toMap()
            tvs.clear()
            for (tv in found.sortedBy { it.ip.substringAfterLast('.').toIntOrNull() ?: 0 }) {
                tv.installed = before[tv.ip]?.installed ?: false
                tvs[tv.ip] = tv
            }
        }
        scanned = true
        if (found.isEmpty()) {
            say("Nessuna TV Samsung trovata", "err")
            step = "dev"
            return@job
        }
        for (tv in found) {
            val what = if (tv.dev) "Modalità sviluppatore accesa" + (if (tv.devIp.isNotEmpty()) ", IP del PC host ${tv.devIp}" else "")
                else "Modalità sviluppatore spenta"
            say("${tv.name.ifEmpty { "TV Samsung" }} ${tv.model} (${tv.ip}): $what", "ok")
        }
        step = if (found.any { it.dev }) "install" else "dev"
    }

    // ---------------------------------------------------------------- installazione

    private fun installResult(out: String): String? {
        if (Regex("install completed|installing\\[100\\]").containsMatchIn(out)) return null
        if (Regex("118\\s*,\\s*-11|Author certificate not match", RegexOption.IGNORE_CASE).containsMatchIn(out))
            return "Sulla TV c'è già BunkerPlex firmata in un altro modo: disinstallala dalla TV (App → BunkerPlex → Elimina) e riprova."
        if (Regex("118\\s*,\\s*-12|118012|certificate", RegexOption.IGNORE_CASE).containsMatchIn(out))
            return "La TV non accetta il certificato dell'app: le TV più nuove (dal 2024 circa) vogliono un certificato Samsung fatto per loro. Intanto usa BunkerPlex dal browser della TV."
        if (out.contains("[116]")) return "Sulla TV non c'è spazio: togli qualche app e riprova."
        if (Regex("118\\s*,\\s*-4\\b").containsMatchIn(out)) return "Questa TV è troppo vecchia per l'app: usa BunkerPlex dal browser della TV."
        val m = Regex("failed\\[[^\\]]*\\][^\\n]*").find(out)
        return "La TV non ha installato l'app" + (m?.let { ": ${it.value.trim()}" } ?: ".")
    }

    fun install(ctx: Context, addr: String) {
        val ip = addr.trim()
        if (!Regex("^\\d{1,3}(\\.\\d{1,3}){3}$").matches(ip)) {
            error = "Indirizzo non valido: scrivi per esempio 192.168.1.180"
            push(ctx)
            return
        }
        job(ctx, "install", ip) {
            val me = phoneIp()
            val tv = synchronized(this) { tvs.getOrPut(ip) { Tv(ip) } }
            info(ip)?.let { d ->
                apply(tv, d)
                if (d.optString("developerMode").isNotEmpty() && d.optString("developerMode") != "1")
                    throw IOException("Sulla TV la Modalità sviluppatore è spenta: App → 1 2 3 4 5 → accendila, scrivi $me come IP del PC host, poi spegni e riaccendi la TV.")
                if (tv.devIp.isNotEmpty() && me.isNotEmpty() && tv.devIp != me)
                    throw IOException("Sulla TV come IP del PC host c'è ${tv.devIp}, ma questo telefono è $me: correggilo in Modalità sviluppatore, poi spegni e riaccendi la TV.")
            }

            step = "install"
            message = "Scarico l'app per Samsung da GitHub…"
            push(ctx)
            val file = File(ctx.cacheDir, "BunkerPlex.wgt")
            Net.download(WGT_URL, file, auth = false) { pct ->
                message = "Scarico l'app per Samsung da GitHub… $pct%"
                push(ctx)
            }
            val data = file.readBytes()
            file.delete()
            if (data.size < 2 || data[0] != 'P'.code.toByte() || data[1] != 'K'.code.toByte())
                throw IOException("Il file dell'app scaricato da GitHub non è valido")
            say("Scaricata BunkerPlex.wgt (${data.size / 1024} kB)", "ok")
            check()

            message = "Mi collego alla TV…"
            push(ctx)
            val sdb = Sdb.connect(ip, SDB_PORT) ?: throw IOException(
                "La TV non accetta il collegamento. Sulla TV, in Modalità sviluppatore, come IP del PC host deve esserci " +
                    "${me.ifEmpty { "l'IP di questo telefono" }}; poi la TV va spenta e riaccesa.")
            open = sdb
            say("Collegata: ${sdb.banner}", "dbg")
            val caps = try { sdb.capability() } catch (_: Exception) { emptyMap() }
            caps["platform_version"]?.let { say("Tizen $it", "dbg") }
            val path = (caps["sdk_toolpath"]?.trimEnd('/') ?: TOOLPATH) + "/BunkerPlex.wgt"
            check()

            message = "Copio l'app sulla TV…"
            push(ctx)
            sdb.push(data, path)
            say("Copiata in $path", "dbg")
            check()

            message = "Installo l'app sulla TV…"
            push(ctx)
            val out = sdb.shell("0 vd_appinstall $PACKAGE $path", 180_000) {
                it.contains("spend time") || it.contains("install completed") || it.contains("failed[")
            }
            say("vd_appinstall: " + out.trim().takeLast(1500).ifEmpty { "(nessuna risposta)" }, "dbg")
            installResult(out)?.let { throw IOException(it) }
            tv.installed = true
            say("App installata", "ok")
            try { sdb.shell("0 rmfile", 5000) } catch (_: Exception) {}
            try {
                val run = sdb.shell("0 was_execute $APP_ID", 15_000) { it.contains("launch") }
                say("was_execute: " + run.trim().ifEmpty { "(nessuna risposta)" }, "dbg")
            } catch (_: Exception) {
            }
            say("Fatto: BunkerPlex è tra le App della TV e si è aperta. Collegala dal telefono con il codice.", "ok")
            step = "done"
        }
    }

    // ---------------------------------------------------------------- sdb

    /** Client sdb minimo (il protocollo di adb, senza chiavi): un flusso alla volta. */
    private class Sdb private constructor(private val sock: Socket) {
        private val inp = DataInputStream(sock.getInputStream())
        private val out: OutputStream = sock.getOutputStream()
        private var max = MAX
        private var nextId = 0
        private val bufs = HashMap<Int, ByteArrayOutputStream>()
        private val closed = HashSet<Int>()
        var banner = ""

        companion object {
            const val CNXN = 0x4E584E43
            const val AUTH = 0x48545541
            const val OPEN = 0x4E45504F
            const val OKAY = 0x59414B4F
            const val CLSE = 0x45534C43
            const val WRTE = 0x45545257
            const val MAX = 4096

            fun connect(ip: String, port: Int): Sdb? {
                repeat(3) {
                    try {
                        val s = Socket()
                        s.connect(InetSocketAddress(ip, port), 5000)
                        s.soTimeout = 10_000
                        return Sdb(s).also { it.handshake() }
                    } catch (_: Exception) {
                        Thread.sleep(400)
                    }
                }
                return null
            }
        }

        private class Packet(val cmd: Int, val a0: Int, val a1: Int, val data: ByteArray)

        fun close() = try { sock.close() } catch (_: Exception) {}

        private fun send(cmd: Int, a0: Int, a1: Int, data: ByteArray = ByteArray(0)) {
            var sum = 0L
            for (b in data) sum += (b.toInt() and 0xFF)
            val head = ByteBuffer.allocate(24).order(ByteOrder.LITTLE_ENDIAN)
                .putInt(cmd).putInt(a0).putInt(a1).putInt(data.size).putInt(sum.toInt()).putInt(cmd xor -1)
            out.write(head.array())
            out.write(data)
            out.flush()
        }

        private fun read(): Packet {
            val head = ByteArray(24)
            inp.readFully(head)
            val b = ByteBuffer.wrap(head).order(ByteOrder.LITTLE_ENDIAN)
            val cmd = b.int; val a0 = b.int; val a1 = b.int; val n = b.int; b.int; val magic = b.int
            if (magic != (cmd xor -1)) throw IOException("Risposta della TV non valida")
            val data = ByteArray(n)
            if (n > 0) inp.readFully(data)
            return Packet(cmd, a0, a1, data)
        }

        /** Legge un pacchetto e lo smista: i dati nel buffer del flusso, con OKAY. */
        private fun pump(): Packet {
            val p = read()
            when (p.cmd) {
                WRTE -> {
                    bufs.getOrPut(p.a1) { ByteArrayOutputStream() }.write(p.data)
                    send(OKAY, p.a1, p.a0)
                }
                CLSE -> closed.add(p.a1)
            }
            return p
        }

        fun handshake() {
            send(CNXN, 0x01000000, MAX, "host::\u0000".toByteArray())
            while (true) {
                val p = read()
                if (p.cmd == CNXN) {
                    if (p.a1 in 1 until MAX) max = p.a1
                    banner = String(p.data).trimEnd('\u0000')
                    return
                }
                if (p.cmd == AUTH) throw IOException("La TV chiede una chiave (AUTH): questo modello non è supportato")
            }
        }

        fun open(service: String): Pair<Int, Int> {
            val local = ++nextId
            bufs[local] = ByteArrayOutputStream()
            send(OPEN, local, 0, (service + "\u0000").toByteArray())
            while (true) {
                val p = pump()
                if (p.a1 != local) continue
                if (p.cmd == OKAY) return local to p.a0
                if (p.cmd == CLSE) throw IOException("La TV ha rifiutato «${service.substringBefore(' ')}»")
            }
        }

        fun write(st: Pair<Int, Int>, data: ByteArray) {
            send(WRTE, st.first, st.second, data)
            while (true) {
                val p = pump()
                if (p.a1 != st.first) continue
                if (p.cmd == OKAY) return
                if (p.cmd == CLSE) throw IOException("La TV ha chiuso il flusso durante la scrittura")
            }
        }

        fun readUntil(st: Pair<Int, Int>, timeoutMs: Long, done: ((ByteArray) -> Boolean)? = null): ByteArray {
            val end = System.currentTimeMillis() + timeoutMs
            val local = st.first
            while (local !in closed && System.currentTimeMillis() < end) {
                if (done != null && done(bufs[local]!!.toByteArray())) break
                sock.soTimeout = (end - System.currentTimeMillis()).coerceIn(500, 5000).toInt()
                try {
                    pump()
                } catch (_: SocketTimeoutException) {
                } finally {
                    sock.soTimeout = 10_000
                }
            }
            return bufs[local]?.toByteArray() ?: ByteArray(0)
        }

        fun closeStream(st: Pair<Int, Int>) {
            if (st.first !in closed) try { send(CLSE, st.first, st.second) } catch (_: Exception) {}
        }

        fun shell(cmd: String, timeoutMs: Long, done: ((String) -> Boolean)? = null): String {
            val st = open("shell:$cmd")
            try {
                return String(readUntil(st, timeoutMs, done?.let { d -> { b: ByteArray -> d(String(b)) } }))
            } finally {
                closeStream(st)
            }
        }

        fun capability(): Map<String, String> {
            val st = open("capability:")
            val raw = readUntil(st, 10_000)
            closeStream(st)
            if (raw.size < 2) return emptyMap()
            return String(raw, 2, raw.size - 2).lines().filter { ':' in it }
                .associate { it.substringBefore(':') to it.substringAfter(':') }
        }

        private fun le(n: Int) = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(n).array()

        fun push(data: ByteArray, path: String) {
            val st = open("sync:")
            val spec = "$path,${"100644".toInt(8)}".toByteArray()
            write(st, "SEND".toByteArray() + le(spec.size) + spec)
            val step = max - 8
            var i = 0
            while (i < data.size) {
                val part = data.copyOfRange(i, minOf(data.size, i + step))
                write(st, "DATA".toByteArray() + le(part.size) + part)
                i += step
            }
            write(st, "DONE".toByteArray() + le((System.currentTimeMillis() / 1000).toInt()))
            val answer = readUntil(st, 60_000) { it.size >= 8 }
            if (answer.size < 4 || String(answer, 0, 4) != "OKAY") {
                val msg = if (answer.size > 8 && String(answer, 0, 4) == "FAIL") String(answer, 8, answer.size - 8) else "nessuna risposta"
                throw IOException("La TV non ha accettato il file: $msg")
            }
            try { send(WRTE, st.first, st.second, "QUIT".toByteArray() + le(0)) } catch (_: Exception) {}
            closeStream(st)
        }
    }
}
