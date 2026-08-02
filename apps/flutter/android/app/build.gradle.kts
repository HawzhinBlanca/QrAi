import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// ── Release signing ─────────────────────────────────────────────────────────────────────────────
// `android/key.properties` is never committed (.gitignore) and points at a keystore that lives
// outside the repo. Present -> the release build is signed for distribution. Absent -> it falls
// back to the debug key so `flutter run --release` and CI's compile check still work, and says so
// loudly, because a debug-signed artifact looks exactly like a real one until Play rejects it.
//
// Measured, not assumed: before this, `flutter build apk --release` produced an APK whose
// certificate was `C=US, O=Android, CN=Android Debug`.
val keystorePropertiesFile = rootProject.file("key.properties")
val hasReleaseKeystore = keystorePropertiesFile.exists()
val keystoreProperties = Properties().apply {
    if (hasReleaseKeystore) keystorePropertiesFile.inputStream().use { load(it) }
}

android {
    namespace = "com.qrai.qrai"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "com.qrai.qrai"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                // getProperty, not `as String`: a key.properties missing an entry would otherwise
                // throw a NullPointerException with no indication of which one.
                fun required(name: String): String = keystoreProperties.getProperty(name)
                    ?: throw GradleException("key.properties is missing `$name`")

                keyAlias = required("keyAlias")
                keyPassword = required("keyPassword")
                storePassword = required("storePassword")
                // Resolved relative to android/, so a path outside the repo stays outside it.
                storeFile = rootProject.file(required("storeFile"))
            }
        }
    }

    buildTypes {
        release {
            signingConfig = if (hasReleaseKeystore) {
                signingConfigs.getByName("release")
            } else {
                // warn, not lifecycle: neither level survives `flutter build apk` (measured — it
                // shows only under `-v` or a direct `./gradlew`), so this is a breadcrumb for
                // whoever reads a verbose log, NOT the control. The control is
                // `scripts/check-apk.mjs --require-release`, which reads the artifact itself.
                logger.warn(
                    "\n⚠️  No android/key.properties — signing the RELEASE build with the debug key." +
                        "\n    The resulting artifact is a compile check, NOT distributable:" +
                        "\n    Play Console rejects debug-signed uploads." +
                        "\n    See docs/RELEASE_SIGNING.md.\n",
                )
                signingConfigs.getByName("debug")
            }
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
