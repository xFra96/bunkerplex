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
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.pm.PackageInfoCompat
import com.google.firebase.messaging.FirebaseMessaging
import kotlin.concurrent.thread

/**
 * Notifica «Aggiornamento disponibile» sul telefono e sul tablet (mai sulle TV:
 * li' l'app propone l'aggiornamento all'apertura).
 *
 * - Subito, con Firebase: ogni app si iscrive al topic FCM "app-update". Quando esce
 *   una release app-v*, il servizio account (POST /app-update, chiamato dalla
 *   pubblicazione) manda a tutti un messaggio ad alta priorita' con il numero della
 *   versione: NoticePush lo passa a pushed(), che notifica se e' piu' nuova di quella
 *   installata. Non serve aver attivato gli avvisi dell'account.
 * - Di riserva (APK senza Firebase, telefono senza Google Play): AppUpdateJob chiede
 *   a GitHub ogni 6 ore circa, quando Android lo lascia girare (con l'app poco usata
 *   anche molto meno spesso).
 *
 * Una notifica per versione; toccandola si apre BunkerPlex, che propone subito di
 * aggiornare (checkUpdate nella pagina). Aprendo l'app la notifica rimasta si toglie.
 */
object AppUpdates {
    private const val JOB_ID = 7302
    private const val CHANNEL = "aggiornamenti"
    private const val NOTE_ID = 998
    private const val EVERY_MS = 6 * 3600_000L
    private const val TOPIC = "app-update"
    const val PREFIX = "app-v"
    const val APK = "BunkerPlex.apk"
    /** Nell'Intent della notifica: la pagina propone l'aggiornamento anche dopo un «Più tardi» */
    const val EXTRA = "it.bunkerplex.tv.UPDATE"

    private fun prefs(c: Context) = c.getSharedPreferences("bunkerplex", Context.MODE_PRIVATE)

    fun installed(c: Context): Long =
        PackageInfoCompat.getLongVersionCode(c.packageManager.getPackageInfo(c.packageName, 0))

    /** All'avvio dell'app sul telefono: iscrizione al topic FCM e controllo periodico di riserva. */
    fun start(c: Context) {
        schedule(c)
        if (!Notices.firebase(c)) return
        try {
            val fm = FirebaseMessaging.getInstance()
            fm.isAutoInitEnabled = true          // gettone sempre valido: il topic resta
            fm.subscribeToTopic(TOPIC)           // a ogni avvio: torna anche dopo «Disattiva» degli avvisi
        } catch (e: Exception) {
            // niente Google Play: resta il controllo periodico
        }
    }

    /** Mette in calendario il controllo periodico (una volta sola: poi Android lo ricorda, anche dopo un riavvio). */
    private fun schedule(c: Context) {
        val js = c.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler
        if (js.allPendingJobs.any { it.id == JOB_ID }) return
        val b = JobInfo.Builder(JOB_ID, ComponentName(c, AppUpdateJob::class.java))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPersisted(true)
        if (Build.VERSION.SDK_INT >= 24) b.setPeriodic(EVERY_MS, 3600_000L) else b.setPeriodic(EVERY_MS)
        js.schedule(b.build())
    }

    /** Il messaggio FCM del topic (dati: kind=app_update, code, name). */
    fun pushed(c: Context, data: Map<String, String>) {
        val code = data["code"]?.toLongOrNull() ?: return
        offer(c, code, data["name"].orEmpty())
    }

    /** Il controllo periodico: chiede a GitHub (il ritmo lo decide Android) e notifica se serve. */
    fun check(c: Context) {
        val latest = Releases.check(c, PREFIX, APK, true) ?: return
        offer(c, latest.code, latest.name)
    }

    private fun offer(c: Context, code: Long, name: String) {
        if (code <= installed(c)) {
            cancel(c)                        // gia' aggiornata: via la notifica rimasta
            return
        }
        if (prefs(c).getLong("update_notified", 0) >= code) return
        if (show(c, name)) prefs(c).edit().putLong("update_notified", code).apply()
    }

    fun cancel(c: Context) = NotificationManagerCompat.from(c).cancel(NOTE_ID)

    /** false se Android non lo permette (permesso delle notifiche non dato). */
    private fun show(c: Context, version: String): Boolean {
        if (!Notices.allowed(c)) return false
        channel(c)
        val open = PendingIntent.getActivity(
            c, NOTE_ID,
            Intent(c, MainActivity::class.java).putExtra(EXTRA, true)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
        )
        val name = if (version.isNotEmpty()) " $version" else ""
        val body = "È uscita la versione$name dell'app per telefono e tablet. Tocca per aggiornarla."
        val note = NotificationCompat.Builder(c, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_bp)
            .setColor(0xFF1A7F45.toInt())
            .setContentTitle("App Android BunkerPlex: aggiornamento disponibile")
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(open)
            .build()
        return try {
            NotificationManagerCompat.from(c).notify(NOTE_ID, note)
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
                NotificationChannel(CHANNEL, "Aggiornamenti dell'app", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "Quando esce una versione nuova di BunkerPlex"
                }
            )
        }
    }
}

/** Il controllo periodico degli aggiornamenti dell'app, di riserva a FCM (lo pianifica AppUpdates.start). */
class AppUpdateJob : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        thread {
            try {
                AppUpdates.check(applicationContext)
            } catch (e: Exception) {
                // GitHub non raggiungibile: si riprova al prossimo giro
            }
            jobFinished(params, false)
        }
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean = true
}
