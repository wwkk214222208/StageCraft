import java.security.MessageDigest
import java.time.Instant

plugins {
    id("com.android.application")
}

// ── 构建期版本信息：commit + tag + versionName/versionCode 对齐发布（更新比对依赖）──
fun gitOutput(vararg args: String): String {
    return try {
        providers.exec { commandLine(listOf("git") + args) }.standardOutput.asText.get().trim()
    } catch (e: Exception) { "" }
}
val gitCommit = gitOutput("rev-parse", "HEAD")
val gitDescribe = gitOutput("describe", "--tags", "--always")
val releaseVersion = providers.gradleProperty("version").orNull?.takeIf { it.isNotBlank() } ?: gitDescribe.removePrefix("v").ifBlank { "0.0.0-dev" }
val gitCount = gitOutput("rev-list", "--count", "HEAD")
val generatedVersion = layout.buildDirectory.dir("generated/local-version")
val generateVersionInfo by tasks.registering {
    inputs.property("version", releaseVersion)
    inputs.property("commit", gitCommit)
    outputs.file(generatedVersion.map { it.file("version.json") })
    doLast {
        val file = generatedVersion.get().asFile.resolve("version.json")
        file.parentFile.mkdirs()
        val json = """{"version":"${releaseVersion.replace("\"", "\\\"")}","commit":"${gitCommit.replace("\"", "\\\"")}","tag":"${gitDescribe.replace("\"", "\\\"")}","buildTime":"${Instant.now()}","platform":"android"}"""
        file.writeText(json + "\n")
    }
}

val rendererSource = layout.projectDirectory.dir("src/main/assets")
val generatedRenderer = layout.buildDirectory.dir("generated/android-assets")
val generatedRendererSource = layout.buildDirectory.dir("generated/android-renderer")
val generatedCore = layout.buildDirectory.dir("generated/embedded-core")
val coreSourceRoot = rootProject.projectDir.parentFile.resolve("src")
val coreBuildScript = rootProject.projectDir.parentFile.resolve("scripts/build-android-core.mjs")
val webUiSource = rootProject.projectDir.parentFile.resolve("public")
val generatedWebUi = layout.buildDirectory.dir("generated/android-web")
val packageRemoteRenderer by tasks.registering(Copy::class) {
    from(rendererSource)
    // The APK ships only curated built-in stories. User/private stories remain on their owner device.
    from(rootProject.projectDir.parentFile.resolve("stories/default")) { into("stories/default") }
    into(generatedRendererSource)
    doFirst {
        delete(generatedRendererSource.get().asFile.resolve("stories"))
    }
    include("index.html", "styles.css", "renderer.js", "web/local-runtime-web-entry.js", "core-host.html", "web/core-host-bridge.js")
    include("*.json", "stories/*.json", "default/*.json", "stories/default/*.json", "*.assets/**", "default/*.assets/**", "stories/default/*.assets/**")
    // 打包布局契约：stories/default/*.json(+ .assets) 是 Android 侧只读内置资源；
    // 玩家私有剧本与提示词预设存入应用私有数据库，不进入 APK。
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
val packageEmbeddedCore by tasks.registering(Copy::class) {
    dependsOn(buildEmbeddedCore)
    from(generatedCore)
    into(generatedRendererSource)
    include("embedded-core.js", "embedded-core.json")
    duplicatesStrategy = DuplicatesStrategy.FAIL
}
/** 完整 Web UI（public/）打包为 assets/web：本地模式复用同一套前端。 */
val packageWebUi by tasks.registering(Copy::class) {
    from(webUiSource) { into("") }
    // gameplay 玩法场景提示词（每 scope 一个文件）随 Web UI 打包，供本地运行时按 userEditable 过滤下发
    from(rootProject.projectDir.parentFile.resolve("prompts/gameplay")) { into("gameplay") }
    into(generatedWebUi)
    include("**/*")
}
/** 生成本地入口 local.html：public/index.html + __MODE_FLAG__=true + 本地核心/适配脚本注入。 */
val generateLocalEntry by tasks.registering {
    dependsOn(packageWebUi)
    inputs.file(generatedWebUi.map { it.file("index.html") })
    outputs.file(generatedWebUi.map { it.file("local.html") })
    doLast {
        val target = generatedWebUi.get().asFile
        val html = target.resolve("index.html").readText()
            .replace("__MODE_FLAG__", "true")
            .replace("__APP_HASH__", "")
            .replace("__STYLE_HASH__", "")
            .replace("__CORE_CSS_HASH__", "")
        val injection = "<script src=\"/embedded-core.js\"></script>\n<script src=\"/web/local-runtime-web-entry.js\"></script>"
        val local = if (html.contains("</head>", ignoreCase = true)) {
            html.replaceFirst("</head>", injection + "\n</head>", ignoreCase = true)
        } else {
            injection + html
        }
        target.resolve("local.html").writeText(local)
    }
}
val packageAndroidAssets by tasks.registering(Sync::class) {
    dependsOn(packageRemoteRenderer, packageEmbeddedCore, generateLocalEntry, generateVersionInfo)
    from(generatedRendererSource)
    from(generatedWebUi) { into("web"); include("**/*") }
    from(generatedVersion)
    into(generatedRenderer)
    // Keep the small native pairing renderer at the asset root, and package the
    // complete public Web UI under web/ so local mode can reuse its module graph.
    include("index.html", "styles.css", "renderer.js", "embedded-core.js", "embedded-core.json", "version.json", "core-host.html", "prompts/**", "stories/**", "web/**")
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
        check(manifest["protocolVersion"].toString() == "1.1") { "Invalid embedded Core protocol version" }
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
        versionCode = gitCount.toIntOrNull()?.coerceAtMost(Int.MAX_VALUE) ?: 1
        versionName = releaseVersion
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            // 个人项目未配置正式 keystore：用 debug 签名兜底，保证 release 产物可安装
            // （内置完整 Web UI + 本地运行时，APK 约 11MB 属正常体量）
            signingConfig = signingConfigs.getByName("debug")
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
    // The mockable android.jar stubs org.json ("Method quote in org.json.JSONObject not mocked"),
    // so unit tests need the real implementation to exercise JSON boundaries such as JsonSafety.
    testImplementation("org.json:json:20231013")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:rules:1.6.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("junit:junit:4.13.2")
}
