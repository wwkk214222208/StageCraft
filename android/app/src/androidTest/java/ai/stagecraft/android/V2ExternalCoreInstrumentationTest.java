package ai.stagecraft.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.rule.ActivityTestRule;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.Rule;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * Real-device v2 smoke test.
 *
 * The five browser ESM entries are the exact checked-in examples/v2 dist
 * artifacts, copied into the test APK by the Gradle androidTest-assets task.
 * The test adds only the M3 manifest envelope in memory, installs through the
 * same V2ComponentStore used by SAF, then selects via the public
 * StageCraftNative developer bridge. No test-only production hook or release
 * UI is involved.
 *
 * Run with:
 *   adb shell am instrument -w -e class \
 *     ai.stagecraft.android.V2ExternalCoreInstrumentationTest \
 *     ai.stagecraft.android.test/androidx.test.runner.AndroidJUnitRunner
 */
@RunWith(AndroidJUnit4.class)
public final class V2ExternalCoreInstrumentationTest {
    @Rule public final ActivityTestRule<MainActivity> activityRule = new ActivityTestRule<>(MainActivity.class);

    private static final String VERSION = "1.0.0";
    private static final String CORE = "example.stagecraft.core";
    private static final String DRIVER = "example.stagecraft.driver";
    private static final String LLM = "example.stagecraft.llm";
    private static final String SOLUTION = "example.stagecraft.solution";
    private static final String TOOL = "example.stagecraft.tool";
    private static final List<String> COMPONENT_IDS = Arrays.asList(CORE, DRIVER, LLM, SOLUTION, TOOL);

    private static final String CORE_ASSET = "v2/core/index.js";
    private static final String DRIVER_ASSET = "v2/driver/index.js";
    private static final String LLM_ASSET = "v2/llm/index.js";
    private static final String SOLUTION_ASSET = "v2/solution/index.js";
    private static final String TOOL_ASSET = "v2/tool/index.js";

    @Test public void externalCoreColdRestartAndDemoChain() throws Exception {
        MainActivity activity = activityRule.getActivity();
        waitForWebView(activity, 15_000L);
        int gatewayPort = waitForGateway(activity, 15_000L);

        File files = InstrumentationRegistry.getInstrumentation().getTargetContext().getFilesDir();
        File backup = new File(files, ".v2-instrumentation-backup-" + UUID.randomUUID());
        Map<File, File> moved = new LinkedHashMap<>();
        try {
            backupExistingState(files, backup, moved);
            V2ComponentStore store = new V2ComponentStore(files);
            install(store, CORE, "core", null, CORE_ASSET);
            install(store, DRIVER, "provider-driver", "provider-driver", DRIVER_ASSET);
            install(store, LLM, "llm-system", "llm-system", LLM_ASSET);
            install(store, SOLUTION, "solution", "solution", SOLUTION_ASSET);
            install(store, TOOL, "tool", "tool", TOOL_ASSET);

            assertJsonOk(eval(activity, "StageCraftNative.selectV2Core(" + quote(CORE) + "," + quote(VERSION) + ",true)"));
            for (String id : Arrays.asList(DRIVER, LLM, SOLUTION, TOOL)) {
                assertJsonOk(eval(activity, "StageCraftNative.setV2PluginEnabled(" + quote(id) + "," + quote(VERSION) + ",true,true)"));
            }
            JSONObject state = new JSONObject(eval(activity, "StageCraftNative.getV2ComponentState()"));
            assertEquals(5, state.getJSONArray("components").length());
            assertTrue(state.getJSONObject("plan").getJSONObject("core").getString("id").equals(CORE));

            String restart = httpPost(gatewayPort, "/api/host/restart", "{}");
            assertTrue("host.restart must acknowledge the cold restart: " + restart, restart.contains("restarting"));
            JSONObject health = awaitExternalHealth(activity, 45_000L);
            assertEquals("ready", health.getString("status"));
            assertEquals(CORE, health.getJSONObject("effectiveCore").getString("id"));
            assertEquals(VERSION, health.getJSONObject("effectiveCore").getString("version"));

            JSONObject receipt = new JSONObject(httpPost(gatewayPort, "/api/core/commands", "{\"requestId\":\"android-v2-smoke\",\"command\":\"invoke\",\"operation\":\"demo/run\",\"input\":{\"user\":\"android-v2-smoke\",\"tool\":\"device\"}}"));
            assertEquals("android-v2-smoke", receipt.getString("requestId"));
            assertEquals("accepted", receipt.getString("status"));
            JSONObject result = receipt.getJSONObject("result");
            JSONArray messages = result.getJSONArray("messages");
            assertEquals("system", messages.getJSONObject(0).getString("role"));
            assertEquals("You are the StageCraft demo narrator.", messages.getJSONObject(0).getString("content"));
            assertEquals("User says: android-v2-smoke", messages.getJSONObject(1).getString("content"));
            JSONArray chunks = result.getJSONArray("chunks");
            assertTrue(chunks.getJSONObject(0).getString("text").contains("You are the StageCraft demo narrator."));
            assertTrue(chunks.getJSONObject(0).getString("text").contains("User says: android-v2-smoke"));
            assertEquals(4, chunks.getJSONObject(1).getJSONObject("usage").getInt("inputTokens"));
            assertEquals(6, chunks.getJSONObject(1).getJSONObject("usage").getInt("outputTokens"));
            assertEquals("done", chunks.getJSONObject(2).getString("type"));
            JSONObject tool = result.getJSONObject("tool");
            assertEquals("echo", tool.getString("tool"));
            assertEquals("device", tool.getString("input"));
        } finally {
            // Return the app to rescue mode before restoring any pre-existing
            // user plan. This keeps the test's selected Core from leaking.
            try { eval(activity, "StageCraftNative.selectV2Rescue()"); } catch (Exception ignored) { }
            try { httpPost(gatewayPort, "/api/host/restart", "{}"); } catch (Exception ignored) { }
            // Remove every fixture identity and all plan snapshots created by
            // this run. Entries that existed before the test are restored below.
            // This also covers a failure during the first install call.
            try { cleanupTestState(files); } catch (Exception ignored) { }
            restoreState(backup, moved);
        }
    }

    /** Regression guard for Android evaluateJavascript's optional extra JSON string layer. */
    @Test public void javascriptResultDecoderAcceptsOneOrTwoStringLayers() throws Exception {
        String json = "{\"ok\":true}";
        String oneLayer = JSONObject.quote(json);
        String twoLayers = JSONObject.quote(oneLayer);
        assertEquals(json, decodeJavascriptResult(oneLayer));
        assertEquals(json, decodeJavascriptResult(twoLayers));
    }

    private static void install(V2ComponentStore store, String id, String category, String pluginCategory, String assetPath) throws Exception {
        byte[] bytes = readTestAsset(assetPath);
        JSONObject manifest = new JSONObject()
            .put("schemaVersion", "0.1").put("id", id).put("version", VERSION)
            .put("title", "Android instrumentation " + id).put("componentType", "core".equals(category) ? "core" : "plugin")
            .put("entrypoints", new JSONObject().put("runtime", "index.js"))
            .put("integrity", new JSONObject().put("runtime", "sha256-" + sha256(bytes)));
        if (!"core".equals(category)) manifest.put("pluginCategory", pluginCategory);
        else manifest.put("hostApi", new JSONObject().put("version", "0.1"));
        ByteArrayOutputStream archive = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(archive, StandardCharsets.UTF_8)) {
            zip.putNextEntry(new ZipEntry("manifest.json")); zip.write((manifest.toString() + "\n").getBytes(StandardCharsets.UTF_8)); zip.closeEntry();
            zip.putNextEntry(new ZipEntry("index.js")); zip.write(bytes); zip.closeEntry();
        }
        store.install(new ByteArrayInputStream(archive.toByteArray()));
    }

    /** Read the exact example dist artifact copied into the androidTest APK. */
    private static byte[] readTestAsset(String assetPath) throws Exception {
        try (InputStream input = InstrumentationRegistry.getInstrumentation().getContext().getAssets().open(assetPath);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int count;
            while ((count = input.read(buffer)) >= 0) output.write(buffer, 0, count);
            return output.toByteArray();
        }
    }

    private static JSONObject awaitExternalHealth(MainActivity activity, long timeoutMs) throws Exception {
        long deadline = System.currentTimeMillis() + timeoutMs;
        JSONObject last = new JSONObject();
        while (System.currentTimeMillis() < deadline) {
            try {
                int port = activity.gatewayPortForTest();
                String response = httpGet(port, "/api/core/health");
                last = new JSONObject(response);
                if ("ready".equals(last.optString("status")) && last.optJSONObject("effectiveCore") != null && CORE.equals(last.getJSONObject("effectiveCore").optString("id"))) return last;
            } catch (Exception ignored) { }
            Thread.sleep(250L);
        }
        throw new AssertionError("external Core did not become ready: " + last);
    }

    private static int waitForGateway(MainActivity activity, long timeoutMs) throws Exception {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            int port = activity.gatewayPortForTest();
            if (port > 0) return port;
            Thread.sleep(100L);
        }
        throw new AssertionError("MainActivity gateway did not start");
    }

    private static void waitForWebView(MainActivity activity, long timeoutMs) throws Exception {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            String url = readWebViewUrl(activity);
            if (url != null && url.contains("/web/local.html")) return;
            Thread.sleep(100L);
        }
        throw new AssertionError("local WebView did not load: " + readWebViewUrl(activity));
    }

    private static String eval(MainActivity activity, String script) throws Exception {
        final String[] value = new String[1];
        final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> activity.testingWebView().evaluateJavascript("JSON.stringify(" + script + ")", raw -> {
            try { value[0] = decodeJavascriptResult(raw); } catch (Exception ignored) { value[0] = null; }
            latch.countDown();
        }));
        if (!latch.await(5, java.util.concurrent.TimeUnit.SECONDS)) throw new AssertionError("WebView evaluation timed out: " + script);
        assertNotNull("WebView evaluation returned null: " + script, value[0]);
        return value[0];
    }

    /**
     * evaluateJavascript returns a JSON-encoded representation of the JS
     * return value. The explicit JSON.stringify above can therefore result in
     * either one or two string layers depending on WebView implementation.
     */
    private static String decodeJavascriptResult(String raw) throws Exception {
        Object current = new JSONTokener(raw == null ? "null" : raw).nextValue();
        for (int depth = 0; depth < 2 && current instanceof String; depth++) {
            String text = ((String) current).trim();
            if (!(text.startsWith("\"") && text.endsWith("\""))) return (String) current;
            Object nested = new JSONTokener(text).nextValue();
            if (!(nested instanceof String)) return (String) current;
            current = nested;
        }
        return current == null || current == JSONObject.NULL ? null : String.valueOf(current);
    }

    private static String readWebViewUrl(MainActivity activity) throws Exception {
        final String[] url = new String[1];
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> url[0] = activity.testingWebView().getUrl());
        return url[0];
    }

    private static void assertJsonOk(String value) throws Exception {
        JSONObject result = new JSONObject(value);
        assertTrue("Native v2 operation failed: " + value, result.optBoolean("ok", false));
    }

    private static String quote(String value) { return JSONObject.quote(value); }

    private static String httpGet(int port, String path) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL("http://127.0.0.1:" + port + path).openConnection();
        connection.setConnectTimeout(3_000); connection.setReadTimeout(5_000);
        int status = connection.getResponseCode();
        String body = read(connection, status < 400 ? connection.getInputStream() : connection.getErrorStream());
        connection.disconnect();
        if (status >= 400) throw new java.io.IOException("HTTP " + status + " " + body);
        return body;
    }

    private static String httpPost(int port, String path, String body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL("http://127.0.0.1:" + port + path).openConnection();
        connection.setRequestMethod("POST"); connection.setDoOutput(true); connection.setConnectTimeout(3_000); connection.setReadTimeout(15_000);
        connection.setRequestProperty("Content-Type", "application/json");
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8); connection.setFixedLengthStreamingMode(bytes.length);
        try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
        int status = connection.getResponseCode();
        String response = read(connection, status < 400 ? connection.getInputStream() : connection.getErrorStream());
        connection.disconnect();
        if (status >= 400) throw new java.io.IOException("HTTP " + status + " " + response);
        return response;
    }

    private static String read(HttpURLConnection connection, InputStream input) throws Exception {
        if (input == null) return "";
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int count;
            while ((count = stream.read(buffer)) >= 0) output.write(buffer, 0, count);
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static String sha256(byte[] bytes) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder result = new StringBuilder();
        for (byte value : digest) result.append(String.format(java.util.Locale.ROOT, "%02x", value));
        return result.toString();
    }

    private static void backupExistingState(File files, File backup, Map<File, File> moved) throws Exception {
        if (!backup.mkdirs()) throw new java.io.IOException("cannot create backup directory");
        for (String id : COMPONENT_IDS) {
            File source = new File(new File(files, "components"), id);
            if (source.exists()) { File target = new File(backup, "component-" + moved.size()); Files.move(source.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE); moved.put(source, target); }
        }
        for (String name : Arrays.asList("component-launch-plan.v2.json", "component-launch-plan.v2.last-good.json", "component-launch-plan.v2.recovery.json")) {
            File source = new File(files, name);
            if (source.exists()) { File target = new File(backup, "state-" + moved.size()); Files.move(source.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE); moved.put(source, target); }
        }
    }

    private static void restoreState(File backup, Map<File, File> moved) throws Exception {
        for (Map.Entry<File, File> item : moved.entrySet()) {
            File parent = item.getKey().getParentFile(); if (parent != null) parent.mkdirs();
            if (item.getValue().exists()) Files.move(item.getValue().toPath(), item.getKey().toPath(), StandardCopyOption.REPLACE_EXISTING);
        }
        deleteTree(backup);
    }

    private static void cleanupTestState(File files) throws Exception {
        File components = new File(files, "components");
        for (String id : COMPONENT_IDS) deleteTree(new File(components, id));
        for (String name : Arrays.asList("component-launch-plan.v2.json", "component-launch-plan.v2.last-good.json", "component-launch-plan.v2.recovery.json")) {
            Files.deleteIfExists(new File(files, name).toPath());
        }
    }

    private static void deleteTree(File root) throws Exception {
        if (root == null || !root.exists()) return;
        Files.walk(root.toPath()).sorted(Comparator.reverseOrder()).forEach(path -> { try { Files.deleteIfExists(path); } catch (Exception ignored) { } });
    }
}
