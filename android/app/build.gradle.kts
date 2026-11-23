import java.text.SimpleDateFormat
import java.util.Date
import java.util.TimeZone

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "it.bunkerplex.tv"
    compileSdk = 35

    defaultConfig {
        applicationId = "it.bunkerplex.tv"
        minSdk = 21
        targetSdk = 35
        // Numero di versione automatico (i minuti dal 1970): ogni compilazione e'
        // "piu' nuova" della precedente, cosi' l'app sulla TV si accorge da sola
        // che sul PC c'e' un APK aggiornato e propone di installarlo.
        val now = System.currentTimeMillis()
        versionCode = (now / 60_000L).toInt()
        // Nome mostrato sulla TV: la versione della release (es. 2026.11.20, la passa
        // GitHub in BUNKERPLEX_VERSION) o, compilando sul PC, data e ora in Italia.
        versionName = System.getenv("BUNKERPLEX_VERSION")?.removePrefix("v")?.takeIf { it.isNotBlank() }
            ?: SimpleDateFormat("yyyy.MM.dd HH:mm").apply {
                timeZone = TimeZone.getTimeZone("Europe/Rome")
            }.format(Date(now))
    }

    // Chiave di firma personale, creata alla prima compilazione e poi riusata:
    // cosi' gli aggiornamenti si installano sopra la versione precedente.
    signingConfigs {
        create("release") {
            storeFile = file("../keystore/bunkerplex.jks")
            storePassword = "bunkerplex"
            keyAlias = "bunkerplex"
            keyPassword = "bunkerplex"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    // Player e rete in comune con l'app nativa (android/tv): stanno in android/comune
    sourceSets["main"].java.srcDir("../comune/java")

    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    // Tailscale dentro l'app, per vedere gli amici da fuori casa: la compila tsnet/build.sh
    implementation(files("libs/bpnet.aar"))
    implementation("androidx.media3:media3-exoplayer:1.8.0")
    implementation("androidx.media3:media3-ui:1.8.0")
    // Decodificatore audio interno (AC3, E-AC3, DTS, TrueHD...): la TV legge da sola
    // anche l'audio che non conosce, cosi' il PC non deve mai convertire per l'audio.
    implementation("org.jellyfin.media3:media3-ffmpeg-decoder:1.8.0+1")
}
