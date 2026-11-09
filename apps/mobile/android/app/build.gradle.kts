import java.util.Base64
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// The edition of this build. `flutter build ... --dart-define=MACHVON_EDITION=enterprise` hands the defines to Gradle (base64 of `NAME=value`, comma
// separated); an enterprise build puts src/enterprise/res (the icon, the splash logo, the name under the icon) over the main resources.
val dartDefines: Map<String, String> =
    (project.findProperty("dart-defines") as String?)
        ?.split(",")
        ?.filter { it.isNotEmpty() }
        ?.map { String(Base64.getDecoder().decode(it), Charsets.UTF_8) }
        ?.filter { it.contains("=") }
        ?.associate { it.substringBefore("=") to it.substringAfter("=") }
        ?: emptyMap()
val enterpriseBuild = dartDefines["MACHVON_EDITION"] == "enterprise"

android {
    namespace = "vn.machvon.machvon_mobile"
    // permission_handler_android needs the Android APIs of 37; the Flutter default is lower.
    compileSdk = maxOf(flutter.compileSdkVersion, 37)
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "vn.machvon.app"
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    // A release is signed only with the key of the release train (android/key.properties, never committed);
    // without that file the release build stays unsigned and cannot be installed, so it can never ship with a debug key.
    val keyProperties = Properties()
    val keyFile = rootProject.file("key.properties")
    if (keyFile.exists()) keyFile.inputStream().use { keyProperties.load(it) }

    signingConfigs {
        if (keyFile.exists()) {
            create("release") {
                keyAlias = keyProperties.getProperty("keyAlias")
                keyPassword = keyProperties.getProperty("keyPassword")
                storeFile = file(keyProperties.getProperty("storeFile"))
                storePassword = keyProperties.getProperty("storePassword")
            }
        }
    }

    // The resources of a build type win over the main ones, so the enterprise files replace the public ones without a duplicate-resource error.
    if (enterpriseBuild) {
        for (buildType in listOf("debug", "profile", "release")) {
            sourceSets.maybeCreate(buildType).res.srcDir("src/enterprise/res")
        }
    }

    buildTypes {
        release {
            if (keyFile.exists()) signingConfig = signingConfigs.getByName("release")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

dependencies {
    // The biometric prompt of local_auth shows its dialog with AppCompat styles on Android 8 and below: LaunchTheme and NormalTheme
    // (res/values, res/values-night) descend from Theme.AppCompat, so the library is a direct dependency and not only a transitive one.
    implementation("androidx.appcompat:appcompat:1.7.0")
}

flutter {
    source = "../.."
}
