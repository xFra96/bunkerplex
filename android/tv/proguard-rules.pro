# Leggibili gli errori dalla TV
-dontobfuscate
# Decodificatore audio interno: caricato per nome e chiamato dal codice nativo
-keep class androidx.media3.decoder.ffmpeg.** { *; }
# Funzioni chiamate dalla pagina web (vista web di riserva)
-keepclassmembers class * { @android.webkit.JavascriptInterface <methods>; }
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
