package ai.stagecraft.android;

import org.json.JSONObject;
import org.junit.Test;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import static org.junit.Assert.*;

public class V2ComponentStoreTest {
    // Keep this fixture byte-for-byte aligned with the external-core smoke
    // package so the Store's browser/native filter is covered before device use.
    private static final String EXTERNAL_CORE_JS = "export default {kind:'core',manifest:{id:'example.stagecraft.core',version:'1.0.0'},start(ctx){const values=ctx.components.map(c=>c.defaultExport),solution=values.find(v=>v&&v.kind==='solution'),llm=values.find(v=>v&&v.kind==='llm-system'),driver=values.find(v=>v&&v.kind==='provider-driver'),tool=values.find(v=>v&&v.kind==='tool');if(!solution||!llm||!driver||!tool)throw new Error('demo components missing');llm.start({upsertCredentialProfile(){}});ctx.registerCommand('demo/run',async input=>{const route=llm.route({}),assembled=solution.assemblePrompt({user:String(input&&input.user||'')}),messages=[{role:'system',content:solution.systemPrompt},{role:'user',content:assembled}],chunks=[];for await(const chunk of driver.request({providerId:route.providerId,model:route.model,messages}))chunks.push(chunk);return {messages,chunks,tool:tool.execute(input&&input.tool||'ok')}});ctx.registerCommand('demo/ping',()=>({ok:true,core:ctx.pluginId}));ctx.ready();}};";
    private static String sha(byte[] bytes) throws Exception {
        StringBuilder out = new StringBuilder("sha256-");
        for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) out.append(String.format("%02x", b));
        return out.toString();
    }
    @Test public void installsPortableSingleFileComponentAtomically() throws Exception {
        File root = Files.createTempDirectory("v2-store").toFile();
        try {
            byte[] runtime = "export default { kind: 'plugin' }".getBytes(StandardCharsets.UTF_8);
            JSONObject manifest = new JSONObject().put("schemaVersion", "0.1").put("id", "com.example.plugin")
                .put("version", "1.0.0").put("title", "Example").put("componentType", "plugin")
                .put("pluginCategory", "tool").put("entrypoints", new JSONObject().put("runtime", "runtime.js"))
                .put("integrity", new JSONObject().put("runtime", sha(runtime)));
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (ZipOutputStream zip = new ZipOutputStream(bytes)) {
                zip.putNextEntry(new ZipEntry("manifest.json")); zip.write(manifest.toString().getBytes(StandardCharsets.UTF_8)); zip.closeEntry();
                zip.putNextEntry(new ZipEntry("runtime.js")); zip.write(runtime); zip.closeEntry();
            }
            V2ComponentStore store = new V2ComponentStore(root, true);
            assertEquals("com.example.plugin", store.install(new ByteArrayInputStream(bytes.toByteArray())).getString("id"));
            assertEquals(1, store.list().size());
        } finally { delete(root); }
    }
    private static void delete(File file) { if (file == null || !file.exists()) return; File[] children = file.listFiles(); if (children != null) for (File child : children) delete(child); file.delete(); }

    private static File install(V2ComponentStore store, File root, JSONObject manifest, String runtime, String ui) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(bytes)) {
            zip.putNextEntry(new ZipEntry("manifest.json")); zip.write(manifest.toString().getBytes(StandardCharsets.UTF_8)); zip.closeEntry();
            zip.putNextEntry(new ZipEntry(manifest.getJSONObject("entrypoints").getString("runtime"))); zip.write(runtime.getBytes(StandardCharsets.UTF_8)); zip.closeEntry();
            if (ui != null) { zip.putNextEntry(new ZipEntry(manifest.getJSONObject("entrypoints").getString("ui"))); zip.write(ui.getBytes(StandardCharsets.UTF_8)); zip.closeEntry(); }
        }
        store.install(new ByteArrayInputStream(bytes.toByteArray()));
        return new File(root, manifest.getString("id") + File.separator + manifest.getString("version"));
    }

    private static JSONObject validManifest(String id, String runtime, String ui) throws Exception {
        JSONObject entrypoints = new JSONObject().put("runtime", "runtime.js"); JSONObject integrity = new JSONObject().put("runtime", sha(runtime.getBytes(StandardCharsets.UTF_8)));
        if (ui != null) { entrypoints.put("ui", "ui.js"); integrity.put("ui", sha(ui.getBytes(StandardCharsets.UTF_8))); }
        return new JSONObject().put("schemaVersion", "0.1").put("id", id).put("version", "1.0.0").put("title", "Example")
            .put("componentType", "plugin").put("pluginCategory", "tool").put("entrypoints", entrypoints).put("integrity", integrity);
    }

    @Test public void coldReadRevalidatesRuntimeAndUiBytesAfterInstall() throws Exception {
        File root = Files.createTempDirectory("v2-store-integrity").toFile();
        try {
            V2ComponentStore store = new V2ComponentStore(root, true); String runtime = "export default {}"; String ui = "export default {}";
            JSONObject manifest = validManifest("com.example.integrity", runtime, ui); File directory = install(store, root, manifest, runtime, ui);
            assertEquals("com.example.integrity", store.read("com.example.integrity", "1.0.0").getString("id"));
            Files.write(new File(directory, "runtime.js").toPath(), "export default { changed: true }".getBytes(StandardCharsets.UTF_8));
            try { store.read("com.example.integrity", "1.0.0"); fail("runtime tamper must fail cold read"); } catch (IllegalArgumentException expected) { assertTrue(expected.getMessage().contains("runtime integrity mismatch")); }
            Files.write(new File(directory, "runtime.js").toPath(), runtime.getBytes(StandardCharsets.UTF_8));
            Files.write(new File(directory, "ui.js").toPath(), "export default { changed: true }".getBytes(StandardCharsets.UTF_8));
            try { store.read("com.example.integrity", "1.0.0"); fail("ui tamper must fail cold read"); } catch (IllegalArgumentException expected) { assertTrue(expected.getMessage().contains("ui integrity mismatch")); }
        } finally { delete(root); }
    }

    @Test public void rejectsInvalidCategoryApiPathAndCapabilityShape() throws Exception {
        File root = Files.createTempDirectory("v2-store-fields").toFile();
        try {
            V2ComponentStore store = new V2ComponentStore(root, true); String runtime = "export default {}";
            JSONObject invalidCategory = validManifest("com.example.category", runtime, null).put("pluginCategory", "native");
            try { install(store, root, invalidCategory, runtime, null); fail("invalid pluginCategory must fail"); } catch (IllegalArgumentException expected) { assertTrue(expected.getMessage().contains("pluginCategory")); }
            JSONObject invalidApi = validManifest("com.example.api", runtime, null).put("hostApi", new JSONObject().put("version", "not-an-api"));
            try { install(store, root, invalidApi, runtime, null); fail("invalid hostApi must fail"); } catch (IllegalArgumentException expected) { assertTrue(expected.getMessage().contains("hostApi")); }
            JSONObject invalidPath = validManifest("com.example.path", runtime, null); invalidPath.getJSONObject("entrypoints").put("runtime", "../runtime.js");
            try { install(store, root, invalidPath, runtime, null); fail("unsafe entry path must fail"); } catch (IllegalArgumentException expected) { assertTrue(expected.getMessage().contains("path")); }
            JSONObject invalidCapabilities = validManifest("com.example.cap", runtime, null).put("capabilities", new JSONObject().put("required", new org.json.JSONArray().put(3)));
            try { install(store, root, invalidCapabilities, runtime, null); fail("invalid capability shape must fail"); } catch (IllegalArgumentException expected) { assertTrue(expected.getMessage().contains("capabilities")); }
        } finally { delete(root); }
    }

    @Test public void externalCoreSmokeFixtureIsAcceptedAsBrowserEsm() throws Exception {
        File root = Files.createTempDirectory("v2-store-browser-esm").toFile();
        try {
            V2ComponentStore store = new V2ComponentStore(root, true);
            JSONObject manifest = new JSONObject().put("schemaVersion", "0.1").put("id", "example.stagecraft.core").put("version", "1.0.0")
                .put("title", "External Core").put("componentType", "core").put("hostApi", new JSONObject().put("version", "0.1"))
                .put("entrypoints", new JSONObject().put("runtime", "index.js"))
                .put("integrity", new JSONObject().put("runtime", sha(EXTERNAL_CORE_JS.getBytes(StandardCharsets.UTF_8))));
            install(store, root, manifest, EXTERNAL_CORE_JS, null);
            assertEquals("example.stagecraft.core", store.read("example.stagecraft.core", "1.0.0").getString("id"));
        } finally { delete(root); }
    }

    @Test public void stillRejectsNodeAndNativeMarkers() throws Exception {
        File root = Files.createTempDirectory("v2-store-native-markers").toFile();
        try {
            V2ComponentStore store = new V2ComponentStore(root, true);
            String[] forbidden = { "export default { boot(){ return require('x') } }", "export default { boot(){ return process.env.X } }", "export default { boot(){ return module.exports } }", "export default { boot(){ return 'addon.node' } }" };
            for (int i = 0; i < forbidden.length; i++) {
                String id = "com.example.native" + i; JSONObject manifest = validManifest(id, forbidden[i], null);
                try { install(store, root, manifest, forbidden[i], null); fail("native marker must be rejected: " + forbidden[i]); } catch (IllegalArgumentException expected) { assertTrue(expected.getMessage().contains("Node/native")); }
            }
        } finally { delete(root); }
    }
}
