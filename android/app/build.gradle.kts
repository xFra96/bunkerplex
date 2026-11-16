plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "it.francoplex.tv"
    compileSdk = 35

    defaultConfig {
        applicationId = "it.francoplex.tv"
        minSdk = 21
        targetSdk = 35
        // Numero di versione automatico (i minuti dal 1970): ogni compilazione e'
        // "piu' nuova" della precedente, cosi' l'app sulla TV si accorge da sola
        // che sul PC c'e' un APK aggiornato e propone di installarlo.
        versionCode = (System.currentTimeMillis() / 60_000L).toInt()
        versionName = "1.3"
    }

    // Chiave di firma personale, creata alla prima compilazione e poi riusata:
    // cosi' gli aggiornamenti si installano sopra la versione precedente.
    signingConfigs {
        create("release") {
            storeFile = file("../keystore/francoplex.jks")
            storePassword = "francoplex"
            keyAlias = "francoplex"
            keyPassword = "francoplex"
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
    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.media3:media3-exoplayer:1.8.0")
    implementation("androidx.media3:media3-ui:1.8.0")
    // Decodificatore audio interno (AC3, E-AC3, DTS, TrueHD...): la TV legge da sola
    // anche l'audio che non conosce, cosi' il PC non deve mai convertire per l'audio.
    implementation("org.jellyfin.media3:media3-ffmpeg-decoder:1.8.0+1")
}
