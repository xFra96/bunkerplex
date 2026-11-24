package it.bunkerplex.atv

import android.app.Activity
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.content.IntentCompat
import androidx.core.content.pm.PackageInfoCompat
import it.bunkerplex.tv.Net
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Aggiornamento dell'app dal server sul PC: il server scarica l'ultima release
 * dell'app TV nativa (tv-v*) e la offre in /BunkerPlexTV.apk; qui si confronta
 * la versione, si scarica e si installa con l'installatore di Android.
 * Lo stato si legge dalle schermate (Compose) e si aggiorna da solo.
 */
class Update(private val act: Activity) {

    enum class Phase { IDLE, DOWNLOAD, PERMISSION, INSTALL, CANCELLED, DENIED, ERROR }

    var phase by mutableStateOf(Phase.IDLE)
        private set
    var percent by mutableIntStateOf(0)
        private set
    var error by mutableStateOf("")
        private set

    /** Versione sul server (numero e nome), letta da /api/info. 0 = nessuna. */
    var serverCode by mutableStateOf(0L)
        private set
    var serverName by mutableStateOf("")
        private set

    val myCode: Long by lazy {
        PackageInfoCompat.getLongVersionCode(act.packageManager.getPackageInfo(act.packageName, 0))
    }
    val myName: String by lazy { act.packageManager.getPackageInfo(act.packageName, 0).versionName ?: "" }

    /** Sul server c'e' una versione piu' nuova di quella installata. */
    val available get() = serverCode > myCode

    private val busy = AtomicBoolean(false)
    private val file by lazy { File(act.cacheDir, "BunkerPlexTV-update.apk") }
    private var waitingPermission = false

    fun start() {
        file.delete()     // l'APK di un aggiornamento gia' fatto (o lasciato a meta')
        ContextCompat.registerReceiver(act, result, IntentFilter(ACTION), ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    fun stop() {
        try { act.unregisterReceiver(result) } catch (_: Exception) {}
    }

    /** Dati di /api/info: la versione dell'app TV nativa che il server tiene pronta. */
    fun read(info: JSONObject) {
        serverCode = info.optLong("tv_apk_version", 0)
        serverName = info.optString("tv_apk_version_name")
    }

    /** Rilegge /api/info (dalla schermata Impostazioni). Da chiamare fuori dal thread principale. */
    fun refresh() {
        try { read(Api.obj("/api/info")) } catch (_: Exception) {}
    }

    /** Scarica l'APK dal server e apre l'installazione. */
    fun download() {
        val base = Api.base.ifEmpty { return }
        if (!busy.compareAndSet(false, true)) return
        phase = Phase.DOWNLOAD
        percent = 0
        thread {
            try {
                file.delete()
                Net.download("$base/BunkerPlexTV.apk", file) { p -> act.runOnUiThread { percent = p } }
                val found = act.packageManager.getPackageArchiveInfo(file.path, 0)
                if (found?.packageName != act.packageName) throw IOException("il file scaricato non è BunkerPlex TV")
                act.runOnUiThread { install() }
            } catch (e: Exception) {
                act.runOnUiThread { failed(e) }
            } finally {
                busy.set(false)
            }
        }
    }

    /** Al ritorno dalla schermata del permesso: si riprova da soli. */
    fun onResume() {
        if (!waitingPermission) return
        waitingPermission = false
        if (canInstall() && file.isFile) install() else phase = Phase.DENIED
    }

    private fun canInstall() = Build.VERSION.SDK_INT < 26 || act.packageManager.canRequestPackageInstalls()

    private fun install() {
        if (!canInstall()) {
            try {
                act.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${act.packageName}")))
                waitingPermission = true
                phase = Phase.PERMISSION
                return
            } catch (e: ActivityNotFoundException) {
                // TV senza quella schermata: ci pensa l'installatore, che chiede lui il permesso
                openInstaller()
                return
            }
        }
        thread {
            try {
                withSession()
            } catch (e: Exception) {
                // Installatore "a sessioni" non disponibile o rotto su questa TV: quello classico
                act.runOnUiThread { openInstaller() }
            }
        }
    }

    private fun withSession() {
        val installer = act.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(act.packageName)
        if (Build.VERSION.SDK_INT >= 31) {
            params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val id = installer.createSession(params)
        try {
            installer.openSession(id).use { session ->
                session.openWrite("BunkerPlexTV.apk", 0, file.length()).use { out ->
                    file.inputStream().use { it.copyTo(out) }
                    session.fsync(out)
                }
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                    (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
                val pi = PendingIntent.getBroadcast(act, id, Intent(ACTION).setPackage(act.packageName), flags)
                session.commit(pi.intentSender)
            }
        } catch (e: Exception) {
            try { installer.abandonSession(id) } catch (_: Exception) {}
            throw e
        }
    }

    private val result = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
                PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                    val confirm = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent::class.java)
                    if (confirm == null) { openInstaller(); return }
                    try {
                        act.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                        phase = Phase.INSTALL
                    } catch (e: Exception) {
                        openInstaller()
                    }
                }
                PackageInstaller.STATUS_SUCCESS -> file.delete()   // di solito l'app viene chiusa prima
                PackageInstaller.STATUS_FAILURE_ABORTED -> {
                    file.delete()
                    phase = Phase.CANCELLED
                }
                else -> failed(IOException(
                    intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "installazione non riuscita"))
            }
        }
    }

    /** Installatore classico (le TV dove quello a sessioni non va): apre l'APK. */
    private fun openInstaller() {
        try {
            val uri = if (Build.VERSION.SDK_INT >= 24) {
                FileProvider.getUriForFile(act, "${act.packageName}.files", file)
            } else {
                // Le versioni vecchie di Android vogliono il file vero, leggibile dall'installatore
                file.setReadable(true, false)
                Uri.fromFile(file)
            }
            act.startActivity(
                Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            )
            phase = Phase.INSTALL
        } catch (e: Exception) {
            failed(e)
        }
    }

    private fun failed(e: Exception) {
        file.delete()
        error = e.message ?: e.javaClass.simpleName
        phase = Phase.ERROR
    }

    /** Una riga sullo stato, per la schermata. null = niente da dire. */
    fun status(): String? = when (phase) {
        Phase.IDLE -> null
        Phase.DOWNLOAD -> "Scarico l'aggiornamento… $percent%"
        Phase.PERMISSION -> "Consenti a BunkerPlex TV di installare app, poi torna indietro."
        Phase.INSTALL -> "Conferma l'installazione sulla TV."
        Phase.CANCELLED -> "Installazione annullata."
        Phase.DENIED -> "Senza il permesso di installare app l'aggiornamento non può continuare."
        Phase.ERROR -> "Aggiornamento non riuscito: $error"
    }

    companion object {
        private const val ACTION = "it.bunkerplex.atv.INSTALL_RESULT"
    }
}
