package it.bunkerplex.tv

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * Notifiche sul telefono e sul tablet.
 * Gli avvisi dell'account (nuovi film ed episodi, amicizie, aggiornamenti) stanno nel
 * servizio account, raggiungibile anche fuori casa. Ogni dispositivo ha il suo
 * indirizzo degli avvisi (…/avvisi/<gettone>), creato dalla pagina con «Attiva le notifiche».
 *
 * - Con Firebase (APK compilato con google-services.json): l'app manda il suo gettone
 *   FCM a …/fcm e il servizio account spedisce ogni avviso subito, ad alta priorita'
 *   (NoticePush lo mostra). Basta il permesso delle notifiche: niente altro da installare.
 * - Senza Firebase (APK senza configurazione, telefono senza Google Play, servizio
 *   account senza il segreto FCM_SERVICE_ACCOUNT): ogni 15 minuti circa Android sveglia
 *   NoticeJob, che chiede gli avvisi nuovi e li mostra (spesso in ritardo).
 */
object Notices {
    private const val JOB_ID = 7301
    private const val CHANNEL = "avvisi"
    private const val MAX_SHOWN = 5

    private fun prefs(c: Context) = c.getSharedPreferences("bunkerplex", Context.MODE_PRIVATE)

    /** Chiamata quando cambia lo stato (es. FCM confermato): l'app aperta ridisegna la pagina. */
    @Volatile var changed: (() -> Unit)? = null

    /** L'indirizzo degli avvisi di questo dispositivo (…/avvisi/<gettone>), o null se spente. */
    fun url(c: Context): String? = prefs(c).getString("notices_url", null)

    /** true quando il servizio account manda gli avvisi a questo telefono con FCM (istantanee). */
    fun push(c: Context): Boolean = url(c) != null && prefs(c).getBoolean("notices_fcm", false)

    fun allowed(c: Context): Boolean =
        Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(c, "android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED

    @Volatile private var hasFirebase: Boolean? = null

    /** Firebase c'e' in questo APK (compilato con google-services.json)? */
    fun firebase(c: Context): Boolean {
        hasFirebase?.let { return it }
        val ok = try {
            FirebaseApp.getApps(c).isNotEmpty() || FirebaseApp.initializeApp(c) != null
        } catch (e: Throwable) {
            false
        }
        hasFirebase = ok
        return ok
    }

    fun enable(c: Context, url: String) {
        prefs(c).edit().putString("notices_url", url).putLong("notices_since", -1).putBoolean("notices_fcm", false).apply()
        schedule(c)                              // finche' FCM non risponde, si controlla da soli
        thread { runCatching { check(c) } }     // segna da dove partire: gli avvisi vecchi non si mostrano
        registerPush(c)
    }

    fun disable(c: Context) {
        val base = url(c)
        val fcm = prefs(c).getBoolean("notices_fcm", false)
        prefs(c).edit().remove("notices_url").remove("notices_since").remove("notices_fcm").apply()
        (c.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler).cancel(JOB_ID)
        if (firebase(c)) {
            if (base != null && fcm) thread { runCatching { call("DELETE", "$base/fcm", null) } }
            runCatching {
                FirebaseMessaging.getInstance().isAutoInitEnabled = false
                FirebaseMessaging.getInstance().deleteToken()
            }
        }
    }

    /** All'avvio dell'app: se le notifiche sono accese, il gettone FCM e' aggiornato nel
     *  servizio account (o, senza FCM, il controllo periodico e' in calendario). */
    fun ensure(c: Context) {
        if (url(c) == null) return
        if (!push(c)) schedule(c)
        registerPush(c)
    }

    /** Chiede a Firebase il gettone di questo telefono e lo manda al servizio account. */
    private fun registerPush(c: Context) {
        if (!firebase(c)) return
        try {
            val fm = FirebaseMessaging.getInstance()
            fm.isAutoInitEnabled = true          // da qui Firebase rinnova il gettone da solo (onNewToken)
            fm.token.addOnCompleteListener { t ->
                val token = if (t.isSuccessful) t.result else null
                if (!token.isNullOrEmpty()) thread { runCatching { sendToken(c.applicationContext, token) } }
            }
        } catch (e: Exception) {
            // niente Google Play sul telefono: resta il controllo periodico
        }
    }

    /** Manda il gettone FCM (anche quello nuovo, da NoticePush.onNewToken). */
    fun sendToken(c: Context, token: String) {
        val base = url(c) ?: return
        val (code, text) = call("POST", "$base/fcm", JSONObject().put("token", token).toString())
        if (code == 401) {                       // dispositivo tolto dall'account
            disable(c)
            return
        }
        if (code != 200 || url(c) != base) return
        val fcm = runCatching { JSONObject(text).optBoolean("fcm") }.getOrDefault(false)
        val before = prefs(c).getBoolean("notices_fcm", false)
        prefs(c).edit().putBoolean("notices_fcm", fcm).apply()
        val js = c.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler
        if (fcm) js.cancel(JOB_ID) else schedule(c)
        if (fcm != before) changed?.invoke()
    }

    private fun schedule(c: Context) {
        val js = c.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler
        if (js.allPendingJobs.any { it.id == JOB_ID }) return
        val b = JobInfo.Builder(JOB_ID, ComponentName(c, NoticeJob::class.java))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPersisted(true)
        if (Build.VERSION.SDK_INT >= 24) b.setPeriodic(15 * 60_000L, 5 * 60_000L) else b.setPeriodic(15 * 60_000L)
        js.schedule(b.build())
    }

    private fun call(method: String, url: String, body: String?): Pair<Int, String> {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 15000
        c.readTimeout = 15000
        c.requestMethod = method
        try {
            if (body != null) {
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json")
                c.outputStream.use { it.write(body.toByteArray()) }
            }
            val code = c.responseCode
            val text = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
            return code to text
        } finally {
            c.disconnect()
        }
    }

    /** Il controllo periodico: chiede gli avvisi nuovi e li mostra. */
    fun check(c: Context) {
        val base = url(c) ?: return
        val since = prefs(c).getLong("notices_since", -1)
        val (code, text) = call("GET", "$base/list?since=${maxOf(since, 0)}", null)
        if (code == 401) {           // dispositivo tolto dall'account: niente piu' controlli
            disable(c)
            return
        }
        if (code != 200) return
        val res = JSONObject(text)
        val list = res.optJSONArray("notices") ?: return
        var top = maxOf(since, 0)
        val fresh = mutableListOf<JSONObject>()
        for (i in 0 until list.length()) {
            val n = list.getJSONObject(i)
            val id = n.optLong("id")
            if (id > top) top = id
            if (since >= 0 && id > since) fresh.add(n)
        }
        if (url(c) != base) return   // spente intanto
        prefs(c).edit().putLong("notices_since", maxOf(top, prefs(c).getLong("notices_since", -1))).apply()
        // Il servizio account ora manda gli avvisi con FCM: il controllo non serve piu'
        if (res.optBoolean("fcm") && firebase(c) && !push(c)) {
            prefs(c).edit().putBoolean("notices_fcm", true).apply()
            (c.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler).cancel(JOB_ID)
            changed?.invoke()
        }
        for (n in fresh.sortedBy { it.optLong("id") }.takeLast(MAX_SHOWN)) {
            if (!show(c, n.optLong("id"), n.optString("title"), n.optString("body"), n.optDouble("t", 0.0))) return
        }
    }

    /** Un avviso arrivato con FCM (dati del messaggio: id, title, body, t). */
    fun received(c: Context, data: Map<String, String>) {
        if (url(c) == null) return               // spente su questo telefono
        val id = data["id"]?.toLongOrNull() ?: 0L
        if (id > 0 && id > prefs(c).getLong("notices_since", -1)) {
            prefs(c).edit().putLong("notices_since", id).apply()   // il controllo periodico non la ripete
        }
        show(c, id, data["title"].orEmpty(), data["body"].orEmpty(), data["t"]?.toDoubleOrNull() ?: 0.0)
    }

    /** Mostra un avviso; false se Android non lo permette (permesso tolto). */
    private fun show(c: Context, id: Long, title: String, body: String, t: Double): Boolean {
        if (!allowed(c)) return false
        channel(c)
        val open = PendingIntent.getActivity(
            c, 0, Intent(c, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0
        )
        val note = NotificationCompat.Builder(c, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_bp)
            .setColor(0xFF1A7F45.toInt())
            .setContentTitle(title.ifEmpty { "BunkerPlex" })
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setWhen(if (t > 0) (t * 1000).toLong() else System.currentTimeMillis())
            .setShowWhen(true)
            .setAutoCancel(true)
            .setContentIntent(open)
            .build()
        return try {
            // Stesso numero per lo stesso avviso: se arriva due volte (FCM e controllo) si vede una volta
            NotificationManagerCompat.from(c).notify(if (id > 0) (id % 100_000).toInt() + 1000 else 999, note)
            true
        } catch (e: SecurityException) {
            false
        }
    }

    private fun channel(c: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = c.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "Avvisi di BunkerPlex", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "Nuovi film ed episodi, amici e aggiornamenti"
                }
            )
        }
    }

    /** Manda una notifica di prova a questo telefono (dal servizio account). */
    fun test(c: Context): String {
        val base = url(c) ?: return "Prima attiva le notifiche"
        val (code, text) = call("POST", "$base/test", null)
        if (code == 200) return ""
        return runCatching { JSONObject(text).optString("detail") }.getOrNull()?.ifEmpty { null } ?: "Errore $code"
    }
}

/** Gli avvisi istantanei da Firebase Cloud Messaging (messaggi "data" ad alta priorita'). */
class NoticePush : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        // Versione nuova dell'app (topic "app-update", per tutti i telefoni): vedi AppUpdates
        if (message.data["kind"] == "app_update") AppUpdates.pushed(applicationContext, message.data)
        else Notices.received(applicationContext, message.data)
    }

    /** Firebase ha cambiato il gettone di questo telefono: lo sa subito anche il servizio account. */
    override fun onNewToken(token: String) {
        try {
            Notices.sendToken(applicationContext, token)
        } catch (e: Exception) {
            // senza rete: lo rimanda l'app al prossimo avvio (Notices.ensure)
        }
    }
}

/** Il controllo periodico degli avvisi (lo pianifica Notices quando FCM non c'e'). */
class NoticeJob : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        thread {
            try {
                Notices.check(applicationContext)
            } catch (e: Exception) {
                // rete assente o servizio fermo: si riprova al prossimo giro
            }
            jobFinished(params, false)
        }
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean = true
}
