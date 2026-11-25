plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "it.bunkerplex.atv"
    compileSdk = 35

    defaultConfig {
        applicationId = "it.bunkerplex.atv"
        minSdk = 21
        targetSdk = 35
        // Sempre crescente: la TV riconosce un APK piu' nuovo
        versionCode = System.getenv("BUNKERPLEX_CODE")?.toIntOrNull() ?: (System.currentTimeMillis() / 60_000L).toInt()
        // Versione sua, indipendente da server e app attuale: la calcola GitHub dai tag
        // tv-v1.0, tv-v1.1... (.github/versione.py) e la passa in BUNKERPLEX_TV_VERSION
        versionName = System.getenv("BUNKERPLEX_TV_VERSION")?.removePrefix("tv-v")?.takeIf { it.isNotBlank() } ?: "sviluppo"
    }

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
            // R8: Compose ottimizzato, fondamentale sulle chiavette lente
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("release")
        }
    }

    // Player e rete in comune con l'app attuale
    sourceSets["main"].java.srcDir("../comune/java")
    // remote.html: amici e tuoi PC fuori casa, la stessa pagina dell'app attuale
    sourceSets["main"].assets.srcDir("../comune/assets")

    buildFeatures { compose = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
}

dependencies {
    val bom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(bom)
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("io.coil-kt:coil-compose:2.7.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    // Tailscale dentro l'app, per amici e tuoi PC fuori casa: la compila tsnet/build.sh
    implementation(files("../app/libs/bpnet.aar"))
    implementation("androidx.media3:media3-exoplayer:1.8.0")
    implementation("androidx.media3:media3-ui:1.8.0")
    implementation("org.jellyfin.media3:media3-ffmpeg-decoder:1.8.0+1")
}
