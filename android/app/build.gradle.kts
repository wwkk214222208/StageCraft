import java.security.MessageDigest

plugins {
    id("com.android.application")
}

val rendererSource = layout.projectDirectory.dir("src/main/assets")
val generatedRenderer = layout.buildDirectory.dir("generated/android-assets")
val generatedRendererSource = layout.buildDirectory.dir("generated/android-renderer")
val generatedCore = layout.buildDirectory.dir("generated/embedded-core")
val coreSourceRoot = rootProject.projectDir.parentFile.resolve("src")
val coreBuildScript = rootProject.projectDir.parentFile.resolve("scripts/build-android-core.mjs")
val packageRemoteRenderer by tasks.registering(Copy::class) {
    from(rendererSource)
    into(generatedRendererSource)
    include("index.html", "styles.css", "renderer.js")
    duplicatesStrategy = DuplicatesStrategy.FAIL
}
val buildEmbeddedCore by tasks.registering(Exec::class) {
    workingDir(rootProject.projectDir.parentFile)
    val node = System.getenv("NODE_BINARY") ?: "node"
    commandLine(node, "scripts/build-android-core.mjs", "--output-dir", generatedCore.get().asFile.absolutePath)
    inputs.file(coreBuildScript)
    inputs.dir(coreSourceRoot)
    outputs.file(generatedCore.map { it.file("embedded-core.js") })
    outputs.file(generatedCore.map { it.file("embedded-core.json") })
}
val packageEmbeddedCore by tasks.registering(Sync::class) {
    dependsOn(buildEmbeddedCore)
    from(generatedCore)
    into(generatedRendererSource)
    include("embedded-core.js", "embedded-core.json")
    duplicatesStrategy = DuplicatesStrategy.FAIL
}
val packageAndroidAssets by tasks.registering(Sync::class) {
    dependsOn(packageRemoteRenderer, packageEmbeddedCore)
    from(generatedRendererSource)
    into(generatedRenderer)
    include("index.html", "styles.css", "renderer.js", "embedded-core.js", "embedded-core.json")
    duplicatesStrategy = DuplicatesStrategy.FAIL
}
val verifyEmbeddedCoreAssets by tasks.registering {
    dependsOn(packageAndroidAssets)
    doLast {
        val js = generatedRenderer.get().asFile.resolve("embedded-core.js")
        val manifestFile = generatedRenderer.get().asFile.resolve("embedded-core.json")
        check(js.isFile && js.length() > 0) { "Missing packaged embedded-core.js" }
        check(manifestFile.isFile) { "Missing packaged embedded-core.json" }
        val manifest = groovy.json.JsonSlurper().parse(manifestFile) as Map<*, *>
        check(manifest["artifact"].toString() == "stagecraft-embedded-core") { "Invalid embedded Core artifact" }
        check(manifest["bundleVersion"].toString() == "1.1.0") { "Invalid embedded Core bundle version" }
        check(manifest["protocolVersion"].toString() == "1.0") { "Invalid embedded Core protocol version" }
        check(manifest["bridgeVersion"].toString() == "1") { "Invalid embedded Core bridge version" }
        check(manifest["bytes"].toString().toLong() == js.length()) { "Embedded Core byte count does not match" }
        val digest = MessageDigest.getInstance("SHA-256").digest(js.readBytes()).joinToString("") { "%02x".format(it) }
        check(manifest["sha256"].toString() == digest) { "Embedded Core SHA-256 does not match" }
    }
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

tasks.named("preBuild").configure { dependsOn(verifyEmbeddedCoreAssets) }
tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") }.configureEach { dependsOn(verifyEmbeddedCoreAssets) }

dependencies {
    testImplementation("junit:junit:4.13.2")
}
