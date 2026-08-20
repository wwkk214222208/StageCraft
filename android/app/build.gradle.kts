plugins {
    id("com.android.application")
}

val rendererSource = layout.projectDirectory.dir("src/main/assets")
val generatedRenderer = layout.buildDirectory.dir("generated/remote-renderer")
val packageRemoteRenderer by tasks.registering(Sync::class) {
    from(rendererSource)
    into(generatedRenderer)
    include("index.html", "styles.css", "renderer.js")
    duplicatesStrategy = DuplicatesStrategy.FAIL
}

android {
    namespace = "ai.stagecraft.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "ai.stagecraft.android"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "android.app.InstrumentationTestRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    sourceSets.getByName("main").assets.setSrcDirs(listOf(generatedRenderer.get().asFile))
}

tasks.named("preBuild").configure { dependsOn(packageRemoteRenderer) }

dependencies {
    testImplementation("junit:junit:4.13.2")
}
