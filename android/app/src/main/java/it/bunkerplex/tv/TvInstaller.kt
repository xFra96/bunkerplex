package it.bunkerplex.tv

import android.content.Context
import android.os.Build
import dadb.AdbKeyPair
import dadb.Dadb
import dadb.InstallResult
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.util.Collections
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Installa l'app BunkerPlex (la stessa del telefono: PWA con l'aspetto da TV e player
 * nativo) sulle TV Android di casa direttamente dal telefono, con il "debug di rete"
 * (adb sulla porta 5555), senza PC ne' server.
 *
 * Come tvinstall.py sul server, ma dentro l'app: cerca nella rete di casa le TV
 * con il debug acceso, si collega (la TV chiede una volta «Consentire il debug?»),
 * scarica l'APK dall'ultima release app-v su GitHub, lo installa e apre l'app.
 * Se sulla TV c'e' ancora la vecchia app TV nativa (BunkerPlex TV) la toglie.
 * Da li' in poi l'app sulla TV si aggiorna da sola.
 *
 * La chiave adb sta nei file dell'app: dopo «Consenti sempre» la TV non lo chiede piu'.
 * Serve Android 8 o piu' recente sul telefono (la libreria adb usa java.util.Base64).
 */
object TvInstaller {
    const val PACKAGE = "it.bunkerplex.tv"
    private const val RELEASES = "app-v"
    private const val APK = "BunkerPlex.apk"
    /** La vecchia app TV nativa (tolta): se c'e' ancora sulla TV si disinstalla */
    private const val OLD_PACKAGE = "it.bunkerplex.atv"
    private const val ADB_PORT = 5555

    fun supported() = Build.VERSION.SDK_INT >= 26

    /** Chi segue lo stato (la pagina tvinstall.html): riceve il JSON a ogni cambio. */
    @Volatile
    var listener: ((String) -> Unit)? = null

    private class Device(val ip: String, val port: Int) {
        var name = ""
        var state = "found"          // found, device (collegata), unauthorized
        var installed: Long? = null  // versione di BunkerPlex sulla TV, se c'e'
        val key get() = "$ip:$port"
    }

    private val devices = LinkedHashMap<String, Device>()
    private val log = ArrayList<JSONObject>()
    @Volatile private var phase = ""          // "", scan, install
    @Volatile private var step = "debug"      // debug, scan, choose, confirm, install, done
    @Volatile private var message = ""
    @Volatile private var error = ""
    @Volatile private var target = ""
    @Volatile private var scanned = false
    @Volatile private var worker: Thread? = null
    @Volatile private var open: Dadb? = null
    @Volatile private var cancelled = false

    @Synchronized
    fun state(ctx: Context): String {
        val latest = Releases.cached(ctx, RELEASES)
        return JSONObject()
            .put("phase", phase).put("step", step).put("message", message).put("error", error)
            .put("target", target).put("scanned", scanned).put("supported", supported())
            .put("latest", latest?.name ?: "").put("latest_code", latest?.code ?: 0)
            .put("devices", JSONArray(devices.values.map {
                JSONObject().put("ip", it.ip).put("port", it.port).put("key", it.key).put("name", it.name)
                    .put("state", it.state).put("installed", it.installed ?: 0)
            }))
            .put("log", JSONArray(log.takeLast(80)))
            .toString()
    }

    private fun push(ctx: Context) {
        val l = listener ?: return
        l(state(ctx))
    }

    @Synchronized
    private fun say(text: String, kind: String = "info") {
        log.add(JSONObject().put("at", System.currentTimeMillis() / 1000).put("kind", kind).put("text", text))
        if (log.size > 200) log.subList(0, log.size - 200).clear()
    }

    private fun busy() = worker?.isAlive == true

    private fun job(ctx: Context, what: String, body: () -> Unit) {
        if (busy()) return
        cancelled = false
        phase = what
        error = ""
        push(ctx)
        worker = thread(name = "tvinstall") {
            try {
                body()
            } catch (e: Exception) {
                if (cancelled) {
                    say("Interrotto", "sep")
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

    // ---------------------------------------------------------------- ricerca

    private fun localAddresses(): List<Inet4Address> {
        val out = mutableListOf<Inet4Address>()
        try {
            for (ni in Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp || ni.isLoopback) continue
                for (a in Collections.list(ni.inetAddresses)) {
                    if (a is Inet4Address && a.isSiteLocalAddress) out.add(a)
                }
            }
        } catch (_: Exception) {
        }
        return out
    }

    /** Tutti gli indirizzi vicini (stessa rete /24 del telefono) con la porta 5555 aperta. */
    fun scan(ctx: Context) = job(ctx, "scan") {
        step = "scan"
        message = "Cerco le TV con il debug acceso nella rete di casa…"
        say("Cerco le TV", "sep")
        push(ctx)
        val mine = localAddresses()
        if (mine.isEmpty()) throw IOException("Il telefono non è collegato al Wi-Fi di casa.")
        val own = mine.map { it.hostAddress }.toSet()
        val prefixes = mine.map { it.hostAddress!!.substringBeforeLast('.') }.distinct()
        say("Rete del telefono: " + prefixes.joinToString(", ") { "$it.x" }, "dbg")
        val found = Collections.synchronizedList(mutableListOf<String>())
        val pool = Executors.newFixedThreadPool(64)
        for (prefix in prefixes) for (i in 1..254) {
            val host = "$prefix.$i"
            if (host in own) continue
            pool.execute {
                if (cancelled) return@execute
                try {
                    Socket().use { it.connect(InetSocketAddress(host, ADB_PORT), 500) }
                    found.add(host)
                } catch (_: Exception) {
                }
            }
        }
        pool.shutdown()
        pool.awaitTermination(30, TimeUnit.SECONDS)
        if (cancelled) throw InterruptedException()
        synchronized(this) {
            // Restano quelle gia' collegate, si aggiungono le nuove, spariscono quelle spente
            val keep = devices.filterValues { it.ip in found }
            devices.clear()
            devices.putAll(keep)
            for (ip in found.sortedBy { ip -> ip.substringAfterLast('.').toIntOrNull() ?: 0 }) {
                devices.getOrPut("$ip:$ADB_PORT") { Device(ip, ADB_PORT) }
            }
        }
        scanned = true
        if (found.isEmpty()) {
            say("Nessuna TV con il debug acceso", "err")
            step = "debug"
        } else {
            say("Trovate: " + found.joinToString(", "), "ok")
            step = if (found.size > 1) "choose" else "install"
            target = if (found.size == 1) "${found[0]}:$ADB_PORT" else ""
        }
    }

    // ---------------------------------------------------------------- installazione

    private fun keyPair(ctx: Context): AdbKeyPair {
        val dir = File(ctx.filesDir, "adb").apply { mkdirs() }
        val priv = File(dir, "adbkey")
        val pub = File(dir, "adbkey.pub")
        if (!priv.isFile || !pub.isFile) {
            say("Preparo la chiave del telefono (una volta sola)", "dbg")
            AdbKeyPair.generate(priv, pub)
        }
        return AdbKeyPair.read(priv, pub)
    }

    private fun parseAddr(addr: String): Pair<String, Int> {
        val s = addr.trim().removePrefix("http://").removePrefix("https://").trimEnd('/')
        val host = s.substringBefore(':')
        val port = s.substringAfter(':', "").toIntOrNull() ?: ADB_PORT
        if (!Regex("^\\d{1,3}(\\.\\d{1,3}){3}$").matches(host)) throw IOException("Indirizzo non valido: scrivi per esempio 192.168.1.180")
        return host to port
    }

    private fun versionOf(adb: Dadb): Long? {
        val out = adb.shell("dumpsys package $PACKAGE | grep versionCode").allOutput
        return Regex("versionCode=(\\d+)").find(out)?.groupValues?.get(1)?.toLongOrNull()
    }

    /** Si collega alla TV (addr = ip o ip:porta), scarica l'APK da GitHub e lo installa.
     *  replace = prima toglie l'app che c'e' (firma diversa). */
    fun install(ctx: Context, addr: String, replace: Boolean) = job(ctx, "install") {
        val (ip, port) = parseAddr(addr)
        val dev = synchronized(this) { devices.getOrPut("$ip:$port") { Device(ip, port) } }
        target = dev.key
        say("Installo su $ip", "sep")

        // 1. L'APK dall'ultima release app-v (prima, cosi' la TV non aspetta)
        step = "install"
        message = "Scarico l'app BunkerPlex da GitHub…"
        push(ctx)
        val latest = Releases.check(ctx, RELEASES, APK, true)
            ?: throw IOException("Su GitHub non c'è ancora una versione dell'app BunkerPlex.")
        val apk = File(ctx.cacheDir, APK)
        Net.download(latest.url, apk, auth = false) { pct ->
            message = "Scarico l'app BunkerPlex da GitHub… $pct%"
            push(ctx)
        }
        say("Scaricata BunkerPlex ${latest.name} (${apk.length() / 1048576} MB)", "ok")
        if (cancelled) throw InterruptedException()

        // 2. Collegamento: se la TV non conosce ancora il telefono mostra «Consentire il debug?»
        step = "confirm"
        message = "Mi collego alla TV…"
        dev.state = "unauthorized"
        push(ctx)
        try {
            Socket().use { it.connect(InetSocketAddress(ip, port), 3000) }
        } catch (e: Exception) {
            dev.state = "found"
            throw IOException("La TV $ip non risponde sulla porta $port: controlla che sia accesa e che il debug sia attivo.")
        }
        val adb = Dadb.create(ip, port, keyPair(ctx), 5000, 120_000)
        open = adb
        val name = try {
            adb.shell("getprop ro.product.model").output.trim()
        } catch (e: Exception) {
            dev.state = "found"
            if (cancelled) throw InterruptedException()
            say("adb: ${e.message ?: e.javaClass.simpleName}", "dbg")
            throw IOException("La TV non ha dato il permesso. Riprova e, quando compare «Consentire il debug?», scegli «Consenti sempre» e OK.")
        }
        dev.state = "device"
        dev.name = name
        dev.installed = try { versionOf(adb) } catch (_: Exception) { null }
        say("Collegata: ${name.ifEmpty { ip }}" + (dev.installed?.let { " · BunkerPlex già presente" } ?: ""), "ok")

        // 3. Installazione
        step = "install"
        message = "Installo l'app sulla TV…"
        push(ctx)
        if (replace) {
            say("Tolgo l'app di prima", "info")
            adb.uninstall(PACKAGE)
        }
        val result = adb.install(apk, "-r")
        if (result is InstallResult.Failure) {
            say("adb install: ${result.reason}", "dbg")
            if (result.reason.contains("UPDATE_INCOMPATIBLE") || result.reason.contains("SIGNATURES")) {
                throw IOException("INCOMPATIBILE")
            }
            if (result.reason.contains("VERSION_DOWNGRADE")) {
                throw IOException("Sulla TV c'è già una versione più nuova dell'app.")
            }
            throw IOException("La TV non ha installato l'app: ${result.reason.trim()}")
        }
        apk.delete()
        dev.installed = try { versionOf(adb) } catch (_: Exception) { latest.code }
        say("App installata", "ok")
        // La vecchia app TV nativa non serve piu': una sola BunkerPlex sulla TV
        try {
            if (adb.shell("pm list packages $OLD_PACKAGE").output.contains(OLD_PACKAGE)) {
                adb.uninstall(OLD_PACKAGE)
                say("Tolta la vecchia app BunkerPlex TV", "ok")
            }
        } catch (_: Exception) {
        }

        // 4. Si apre sulla TV
        try {
            adb.shell("monkey -p $PACKAGE -c android.intent.category.LEANBACK_LAUNCHER 1")
            say("Aperta sulla TV", "ok")
        } catch (_: Exception) {
        }
        step = "done"
    }
}
