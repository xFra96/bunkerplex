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

    /** data: tutta la risposta del servizio (es. l'elenco dei dispositivi al limite). */
    class CloudError(val status: Int, message: String, val data: String = "") : IOException(message)

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
                // 401 = accesso scaduto; non il PIN sbagliato di un profilo (/profiles/<id>/open)
                if (code == 401 && path != "/login" && !path.endsWith("/open")) logout(ctx)
                throw CloudError(code, detail.ifBlank { "Servizio account: errore $code" }, text)
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

    fun login(ctx: Context, username: String, password: String,
              device: String = "Telefono " + (Build.MODEL ?: "Android"), kind: String = "app"): JSONObject {
        val name = username.trim()
        // trust: «Ricorda questo dispositivo» della verifica in due passaggi, per account
        val body = JSONObject().put("username", name).put("verifier", verifier(name, password))
            .put("device", device).put("kind", kind)
            .put("trust", prefs(ctx).getString("cloud_trust_" + name.lowercase(), "") ?: "")
        prefs(ctx).edit().remove("cloud_token").apply()
        val res = JSONObject(call(ctx, "POST", "/login", body.toString()))
        // Verifica in due passaggi: niente gettone finche' non arriva il codice (login2fa)
        if (res.optBoolean("need_2fa")) return res.put("typed", name)
        prefs(ctx).edit().putString("cloud_token", res.getString("token"))
            .putString("cloud_user", res.optJSONObject("user")?.optString("username") ?: name).apply()
        return res
    }

    /** Il codice dell'app di autenticazione (o uno di recupero) dopo la password. */
    fun login2fa(ctx: Context, ticket: String, code: String, remember: Boolean, typed: String,
                 device: String = "Telefono " + (Build.MODEL ?: "Android")): JSONObject {
        val body = JSONObject().put("ticket", ticket).put("code", code).put("remember", remember)
            .put("device", device).put("kind", "app")
        val res = JSONObject(call(ctx, "POST", "/login/2fa", body.toString()))
        val user = res.optJSONObject("user")?.optString("username") ?: typed
        val ed = prefs(ctx).edit().putString("cloud_token", res.getString("token")).putString("cloud_user", user)
        res.optString("trust").takeIf { it.isNotEmpty() }?.let { t ->
            for (n in listOf(user, typed)) if (n.isNotBlank()) ed.putString("cloud_trust_" + n.trim().lowercase(), t)
        }
        ed.apply()
        return res
    }

    /** «Entra con Google»: un codice da aprire nel browser (o col QR, sulla TV). */
    fun googleStart(ctx: Context, tv: Boolean): String {
        val body = JSONObject().put("device", (if (tv) "TV " else "Telefono ") + (Build.MODEL ?: "Android"))
            .put("kind", if (tv) "tv" else "phone")
        prefs(ctx).edit().remove("cloud_token").apply()
        val res = JSONObject(call(ctx, "POST", "/google/start", body.toString()))
        // Sulla TV il QR da inquadrare col telefono: righe di 0 e 1 (la pagina lo disegna)
        if (tv) res.put("qr", org.json.JSONArray(qrRows(res.optString("url"))))
        return res.toString()
    }

    /** Le righe di 0 e 1 del QR di un indirizzo (zxing), senza bordo. */
    private fun qrRows(text: String): List<String> = try {
        val m = com.google.zxing.qrcode.QRCodeWriter().encode(text, com.google.zxing.BarcodeFormat.QR_CODE, 0, 0,
            mapOf(com.google.zxing.EncodeHintType.MARGIN to 0,
                com.google.zxing.EncodeHintType.ERROR_CORRECTION to com.google.zxing.qrcode.decoder.ErrorCorrectionLevel.M))
        (0 until m.height).map { y -> buildString { for (x in 0 until m.width) append(if (m[x, y]) '1' else '0') } }
    } catch (_: Exception) {
        emptyList()
    }

    /** Google ha risposto? Quando si', il gettone dell'account resta all'app. */
    fun googlePoll(ctx: Context, poll: String): String {
        val text = call(ctx, "POST", "/google/poll", JSONObject().put("poll", poll).toString())
        val res = JSONObject(text)
        val token = res.optString("token")
        if (token.isNotEmpty()) {
            prefs(ctx).edit().putString("cloud_token", token)
                .putString("cloud_user", res.optJSONObject("user")?.optString("username") ?: "").apply()
        }
        return text
    }

    /** La TV entra dal telefono: un codice (e l'indirizzo per il QR) da confermare nella PWA. */
    fun tvStart(ctx: Context): JSONObject {
        prefs(ctx).edit().remove("cloud_token").apply()
        return JSONObject(call(ctx, "POST", "/tv/start",
            JSONObject().put("device", "TV " + (Build.MODEL ?: "Android")).toString()))
    }

    /**
     * Confermato dal telefono? Allora il gettone dell'account resta alla TV ("done").
     * Intanto "seen": il telefono ha aperto il QR o il codice.
     */
    fun tvPoll(ctx: Context, poll: String): JSONObject {
        val res = JSONObject(call(ctx, "POST", "/tv/poll", JSONObject().put("poll", poll).toString()))
        val token = res.optString("token")
        if (token.isNotEmpty()) {
            prefs(ctx).edit().putString("cloud_token", token)
                .putString("cloud_user", res.optJSONObject("user")?.optString("username") ?: "").apply()
        }
        return res
    }

    fun logout(ctx: Context) {
        prefs(ctx).edit().remove("cloud_token").apply()
        stopNet()
    }

    // ---- Tailscale dentro l'app

    /** L'account ha gia' tutti i dispositivi che puo' avere nella rete: 'devices' e'
     *  la risposta del servizio con l'elenco, per chiedere quale togliere. */
    class DeviceLimit(val devices: String, message: String) : IOException(message)

    /** Il nome di questo dispositivo nella rete: sempre lo stesso per questa app
     *  installata (cosi' rientrando non conta come un dispositivo in piu'). */
    private fun host(ctx: Context): String {
        val p = prefs(ctx)
        var id = p.getString("net_id", "") ?: ""
        if (!Regex("[0-9a-f]{6}").matches(id)) {
            id = (1..6).map { "0123456789abcdef".random() }.joinToString("")
            p.edit().putString("net_id", id).apply()
        }
        val model = (Build.MODEL ?: "android").lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-').take(24)
        return "bunkerplex-app-$model-$id".replace("--", "-")
    }

    /** Entra nella rete di BunkerPlex (se non c'e' gia'). Restituisce la base del
     *  proxy locale, oppure lancia IOException con il motivo (DeviceLimit se l'account
     *  e' al limite: replace = il dispositivo da togliere per far posto a questo).
     *  Lento: fuori dal thread principale. */
    @Synchronized
    fun startNet(ctx: Context, replace: String = "", label: String = ""): String {
        TsNet.base().let { if (it.isNotEmpty()) return it }
        try {
            val body = JSONObject().put("ephemeral", true).put("kind", "app").put("host", host(ctx))
                .put("label", label.ifBlank { Build.MODEL ?: "Android" })
            if (replace.isNotEmpty()) body.put("replace", replace)
            val key = JSONObject(call(ctx, "POST", "/tailscale/key", body.toString())).getString("key")
            val dir = File(ctx.filesDir, "tailscale").apply { mkdirs() }
            val err = TsNet.start(dir.absolutePath, key, host(ctx))
            if (err.isNotEmpty()) throw IOException(err)
            return TsNet.base()
        } catch (e: CloudError) {
            if (e.status == 409) throw DeviceLimit(e.data, e.message ?: "Troppi dispositivi")
            throw IOException(if (e.status == 404) "Il servizio account non ha Tailscale configurato" else e.message)
        }
    }

    fun stopNet() {
        try { TsNet.stop() } catch (_: Throwable) {}
    }

    fun setToken(hostport: String, token: String) = TsNet.setToken(hostport, token)
}
