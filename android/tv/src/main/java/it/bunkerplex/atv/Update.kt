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
import it.bunkerplex.tv.Releases
import java.io.File
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Aggiornamento dell'app direttamente dalle sue release su GitHub (tv-v*),
 * senza passare dal server: qui si confronta la versione (BunkerPlexTV.json
 * accanto all'APK), si scarica e si installa con l'installatore di Android.
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

    /** Ultima versione pubblicata su GitHub (numero e nome). 0 = non si sa ancora. */
    var latestCode by mutableStateOf(0L)
        private set
    var latestName by mutableStateOf("")
        private set
    private var latest: Releases.Latest? = null

    val myCode: Long by lazy {
        PackageInfoCompat.getLongVersionCode(act.packageManager.getPackageInfo(act.packageName, 0))
    }
    val myName: String by lazy { act.packageManager.getPackageInfo(act.packageName, 0).versionName ?: "" }

    /** Su GitHub c'e' una versione piu' nuova di quella installata. */
    val available get() = latestCode > myCode

    /** Il server a cui e' collegata la TV e' piu' vecchio di quanto serve a questa app. */
    val serverTooOld get() = Api.info != null && Releases.serverApi(Api.info) < Releases.MIN_SERVER_API

    /** La versione nuova vuole un server piu' nuovo di quello collegato. */
    val needsServer get() = (latest?.minServerApi ?: 1) > Releases.serverApi(Api.info)

    private val busy = AtomicBoolean(false)
    private val file by lazy { File(act.cacheDir, "BunkerPlexTV-update.apk") }
    private var waitingPermission = false

    fun start() {
        file.delete()     // l'APK di un aggiornamento gia' fatto (o lasciato a meta')
        ContextCompat.registerReceiver(act, result, IntentFilter(ACTION), ContextCompat.RECEIVER_NOT_EXPORTED)
        show(Releases.cached(act, PREFIX))
        thread { refresh(force = true) }     // a ogni apertura si chiede subito a GitHub
    }

    fun stop() {
        try { act.unregisterReceiver(result) } catch (_: Exception) {}
    }

    /** Chiamata quando GitHub risponde con una versione piu' nuova (sul thread principale). */
    var onAvailable: (() -> Unit)? = null

    private fun show(l: Releases.Latest?) {
        if (l == null) return
        latest = l
        latestCode = l.code
        latestName = l.name
        if (available) onAvailable?.invoke()
    }

    /** Chiede a GitHub l'ultima versione (al massimo ogni 6 ore, o subito con force).
     *  Fuori dal thread principale; true se GitHub ha risposto. */
    fun refresh(force: Boolean = false): Boolean = try {
        val l = Releases.check(act, PREFIX, APK, force)
        act.runOnUiThread { show(l) }
        true
    } catch (_: Exception) {
        false
    }

    /** Scarica l'APK dalla release su GitHub e apre l'installazione. */
    fun download() {
        if (!busy.compareAndSet(false, true)) return
        phase = Phase.DOWNLOAD
        percent = 0
        thread {
            try {
                file.delete()
                val l = latest ?: Releases.check(act, PREFIX, APK, true)
                    ?: throw IOException("su GitHub non c'è ancora una versione dell'app")
                Net.download(l.url, file, auth = false) { p -> act.runOnUiThread { percent = p } }
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
        /** Linea delle release dell'app TV nativa su GitHub (tv-v1.0, tv-v1.1...) e il suo APK */
        private const val PREFIX = "tv-v"
        private const val APK = "BunkerPlexTV.apk"
    }
}
