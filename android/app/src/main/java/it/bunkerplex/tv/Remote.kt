package it.bunkerplex.tv

import android.content.Context
import android.os.Build
import it.bunkerplex.bpnet.Bpnet as TsNet
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/**
 * L'app senza un server di casa: entra con l'account direttamente nel servizio
 * account (Cloudflare), da li' sa chi sono gli amici e i tuoi PC, e li raggiunge
 * con il Tailscale dentro l'app (libreria bpnet, vedi android/tsnet).
 * La pagina remote.html usa queste funzioni attraverso il ponte BunkerPlexTV.
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

    fun token(ctx: Context): String = prefs(ctx).getString("cloud_token", "") ?: ""

    fun account(ctx: Context): String = prefs(ctx).getString("cloud_user", "") ?: ""

    /** La password non lascia mai il telefono: come sul PC, al servizio va un'impronta
     *  lenta da calcolare (PBKDF2-SHA256, 200.000 giri, sale "bunkerplex:" + nome). */
    fun verifier(username: String, password: String): String {
        val salt = ("bunkerplex:" + username.trim().lowercase()).toByteArray(Charsets.UTF_8)
        val spec = PBEKeySpec(password.toCharArray(), salt, 200_000, 256)
        val algo = if (Build.VERSION.SDK_INT >= 26) "PBKDF2WithHmacSHA256" else "PBKDF2WithHmacSHA1"
        val key = SecretKeyFactory.getInstance(algo).generateSecret(spec).encoded
        return key.joinToString("") { "%02x".format(it) }
    }

    class CloudError(val status: Int, message: String) : IOException(message)

    /** Una chiamata al servizio account: la risposta JSON, o CloudError col motivo. */
    fun call(ctx: Context, method: String, path: String, body: String?): String {
        val c = URL(cloud(ctx) + path).openConnection() as HttpURLConnection
        c.connectTimeout = 10000
        c.readTimeout = 20000
        c.requestMethod = method
        c.setRequestProperty("Accept", "application/json")
        c.setRequestProperty("User-Agent", "BunkerPlex")
        val t = token(ctx)
        if (t.isNotEmpty()) c.setRequestProperty("Authorization", "Bearer $t")
        try {
            if (body != null) {
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json")
                c.outputStream.use { it.write(body.toByteArray()) }
            }
            val code = c.responseCode
            val text = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
            if (code >= 400) {
                val detail = try { JSONObject(text).optString("detail") } catch (_: Exception) { "" }
                if (code == 401 && path != "/login") logout(ctx)
                throw CloudError(code, detail.ifBlank { "Servizio account: errore $code" })
            }
            return text
        } catch (e: CloudError) {
            throw e
        } catch (e: Exception) {
            throw CloudError(0, "Non riesco a contattare il servizio account: controlla la connessione")
        } finally {
            c.disconnect()
        }
    }

    fun login(ctx: Context, username: String, password: String): JSONObject {
        val name = username.trim()
        val body = JSONObject().put("username", name).put("verifier", verifier(name, password))
            .put("device", "Telefono " + (Build.MODEL ?: "Android"))
        prefs(ctx).edit().remove("cloud_token").apply()
        val res = JSONObject(call(ctx, "POST", "/login", body.toString()))
        prefs(ctx).edit().putString("cloud_token", res.getString("token"))
            .putString("cloud_user", res.optJSONObject("user")?.optString("username") ?: name).apply()
        return res
    }

    fun logout(ctx: Context) {
        prefs(ctx).edit().remove("cloud_token").apply()
        stopNet()
    }

    // ---- Tailscale dentro l'app

    @Volatile
    private var starting = false

    /** Entra nella rete di BunkerPlex (se non c'e' gia'). Restituisce la base del
     *  proxy locale, oppure lancia IOException con il motivo. Lento: fuori dal thread principale. */
    @Synchronized
    fun startNet(ctx: Context): String {
        TsNet.base().let { if (it.isNotEmpty()) return it }
        starting = true
        try {
            val key = JSONObject(call(ctx, "POST", "/tailscale/key", JSONObject().put("ephemeral", true).toString()))
                .getString("key")
            val dir = File(ctx.filesDir, "tailscale").apply { mkdirs() }
            val host = "bunkerplex-tel-" + (Build.MODEL ?: "android").lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-').take(20)
            val err = TsNet.start(dir.absolutePath, key, host)
            if (err.isNotEmpty()) throw IOException(err)
            return TsNet.base()
        } catch (e: CloudError) {
            throw IOException(if (e.status == 404) "Il servizio account non ha Tailscale configurato" else e.message)
        } finally {
            starting = false
        }
    }

    fun stopNet() {
        try { TsNet.stop() } catch (_: Throwable) {}
    }

    fun setToken(hostport: String, token: String) = TsNet.setToken(hostport, token)
}
