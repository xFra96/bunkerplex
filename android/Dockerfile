# Compila l'APK di FrenkPlex senza installare nulla sul PC.
# Uso:  docker build --output ../apk .   (lo fa "Compila APK.bat")
FROM eclipse-temurin:17-jdk AS build

ENV ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    GRADLE_VERSION=8.11.1

RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip wget ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Strumenti Android (dal sito di Google)
RUN mkdir -p $ANDROID_HOME/cmdline-tools \
 && wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -O /tmp/tools.zip \
 && unzip -q /tmp/tools.zip -d $ANDROID_HOME/cmdline-tools \
 && mv $ANDROID_HOME/cmdline-tools/cmdline-tools $ANDROID_HOME/cmdline-tools/latest \
 && rm /tmp/tools.zip \
 && yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses > /dev/null \
 && $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager "platforms;android-35" "build-tools;35.0.0" "platform-tools" > /dev/null

# Gradle
RUN wget -q https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip -O /tmp/gradle.zip \
 && unzip -q /tmp/gradle.zip -d /opt \
 && rm /tmp/gradle.zip
ENV PATH=/opt/gradle-${GRADLE_VERSION}/bin:$PATH

WORKDIR /src

# Prima solo i file di build: le librerie restano in cache tra una compilazione e l'altra
COPY settings.gradle.kts build.gradle.kts gradle.properties ./
COPY app/build.gradle.kts app/
RUN mkdir -p keystore app/src/main && echo '<manifest/>' > app/src/main/AndroidManifest.xml \
 && gradle --no-daemon -q dependencies > /dev/null 2>&1 || true

COPY . .

# Chiave di firma: creata la prima volta, poi riusata (cartella android/keystore)
RUN mkdir -p keystore \
 && if [ ! -f keystore/francoplex.jks ]; then \
      keytool -genkeypair -keystore keystore/francoplex.jks -alias francoplex \
        -keyalg RSA -keysize 2048 -validity 12000 \
        -storepass francoplex -keypass francoplex -dname "CN=FrenkPlex"; \
    fi

RUN gradle --no-daemon assembleRelease

FROM scratch
COPY --from=build /src/app/build/outputs/apk/release/app-release.apk /FrenkPlex.apk
COPY --from=build /src/keystore/francoplex.jks /keystore/francoplex.jks
