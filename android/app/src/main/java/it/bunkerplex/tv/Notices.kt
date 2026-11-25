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
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * Notifiche sul telefono e sul tablet («BunkerPlex Avvisi»).
 * Gli avvisi dell'account (nuovi film ed episodi, amicizie, aggiornamenti) stanno nel
 * servizio account, raggiungibile anche fuori casa. Ogni 15 minuti circa Android
 * sveglia NoticeJob, che chiede quelli nuovi con il gettone di questo dispositivo
 * e li mostra. Niente Firebase: basta Internet.
 */
object Notices {
    private const val JOB_ID = 7301
    private const val CHANNEL = "avvisi"
    private const val MAX_SHOWN = 5

    private fun prefs(c: Context) = c.getSharedPreferences("bunkerplex", Context.MODE_PRIVATE)

    /** L'indirizzo degli avvisi di questo dispositivo (…/avvisi/<gettone>), o null se spente. */
    fun url(c: Context): String? = prefs(c).getString("notices_url", null)

    fun allowed(c: Context): Boolean =
        Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(c, "android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED

    fun enable(c: Context, url: String) {
        prefs(c).edit().putString("notices_url", url).putLong("notices_since", -1).apply()
        schedule(c)
        thread { runCatching { check(c) } }     // segna da dove partire: gli avvisi vecchi non si mostrano
    }

    fun disable(c: Context) {
        prefs(c).edit().remove("notices_url").remove("notices_since").apply()
        (c.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler).cancel(JOB_ID)
    }

    /** All'avvio dell'app: se le notifiche sono accese, il controllo periodico e' in calendario. */
    fun ensure(c: Context) {
        if (url(c) != null) schedule(c)
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

    private fun get(url: String): Pair<Int, String> {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 15000
        c.readTimeout = 15000
        try {
            val code = c.responseCode
            val text = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
            return code to text
        } finally {
            c.disconnect()
        }
    }

    /** Chiede gli avvisi nuovi e li mostra. */
    fun check(c: Context) {
        val base = url(c) ?: return
        val since = prefs(c).getLong("notices_since", -1)
        val (code, text) = get("$base/list?since=${maxOf(since, 0)}")
        if (code == 401) {           // dispositivo tolto dall'account: niente piu' controlli
            disable(c)
            return
        }
        if (code != 200) return
        val list = JSONObject(text).optJSONArray("notices") ?: return
        var top = maxOf(since, 0)
        val fresh = mutableListOf<JSONObject>()
        for (i in 0 until list.length()) {
            val n = list.getJSONObject(i)
            val id = n.optLong("id")
            if (id > top) top = id
            if (since >= 0 && id > since) fresh.add(n)
        }
        if (url(c) != base) return   // spente intanto
        prefs(c).edit().putLong("notices_since", top).apply()
        if (fresh.isEmpty() || !allowed(c)) return
        channel(c)
        val open = PendingIntent.getActivity(
            c, 0, Intent(c, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0
        )
        val nm = NotificationManagerCompat.from(c)
        for (n in fresh.sortedBy { it.optLong("id") }.takeLast(MAX_SHOWN)) {
            val body = n.optString("body")
            val note = NotificationCompat.Builder(c, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_bp)
                .setColor(0xFF1A7F45.toInt())
                .setContentTitle(n.optString("title", "BunkerPlex"))
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setWhen((n.optDouble("t", 0.0) * 1000).toLong())
                .setShowWhen(true)
                .setAutoCancel(true)
                .setContentIntent(open)
                .build()
            try {
                nm.notify((n.optLong("id") % 100_000).toInt() + 1000, note)
            } catch (e: SecurityException) {
                return               // permesso tolto nel frattempo
            }
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
}

/** Il controllo periodico degli avvisi (lo pianifica Notices). */
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
