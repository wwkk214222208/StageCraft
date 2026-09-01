package ai.stagecraft.android;

import org.json.JSONObject;
import org.junit.Test;

import java.io.File;
import java.io.FileWriter;
import java.nio.file.Files;
import java.security.MessageDigest;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/** v2 host.storage 的逐能力授权与每组件命名空间 JVM 验证。 */
public final class V2ComponentStorageTest {
    private static final String RUNTIME_SOURCE = "export default 1\n";

    /** 在临时 filesDir 布置一个通过 V2ComponentStore.read 校验的已安装组件。 */
    private static V2ComponentStore storeWithComponent(File filesDir, String id, String version, boolean declareStorageCapability) throws Exception {
        V2ComponentStore store = new V2ComponentStore(filesDir);
        File root = new File(filesDir, "components");
        File dir = new File(root, id + "/" + version + "/dist");
        assertTrue(dir.mkdirs());
        try (FileWriter runtimeWriter = new FileWriter(new File(dir, "index.js"))) { runtimeWriter.write(RUNTIME_SOURCE); }
        byte[] runtime = RUNTIME_SOURCE.getBytes("UTF-8");
        String sha = "sha256-" + java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(runtime));
        JSONObject capabilities = declareStorageCapability
            ? new JSONObject().put("required", new org.json.JSONArray().put("host.storage"))
            : new JSONObject();
        JSONObject manifest = new JSONObject()
            .put("schemaVersion", "0.1")
            .put("id", id)
            .put("version", version)
            .put("title", "Storage test component")
            .put("componentType", "plugin")
            .put("pluginCategory", "tool")
            .put("entrypoints", new JSONObject().put("runtime", "dist/index.js"))
            .put("integrity", new JSONObject().put("runtime", sha))
            .put("capabilities", capabilities);
        try (FileWriter writer = new FileWriter(new File(root, id + "/" + version + "/manifest.json"))) {
            writer.write(manifest.toString());
        }
        return store;
    }

    private static JSONObject caller(String id, String version) throws Exception {
        return new JSONObject().put("pluginId", id).put("version", version);
    }

    @Test public void writeAndReadRoundTripInsideCallerNamespace() throws Exception {
        File files = Files.createTempDirectory("v2storage").toFile();
        V2ComponentStore store = storeWithComponent(files, "example.tool", "1.0.0", true);
        V2ComponentStorage storage = new V2ComponentStorage(files, store);

        JSONObject writeResult = storage.write(new JSONObject()
            .put("caller", caller("example.tool", "1.0.0"))
            .put("area", "notes")
            .put("value", new JSONObject().put("n", 7)));
        assertEquals(true, writeResult.getBoolean("ok"));

        JSONObject readResult = storage.read(new JSONObject()
            .put("caller", caller("example.tool", "1.0.0"))
            .put("area", "notes"));
        assertEquals(7, readResult.getJSONObject("value").getInt("n"));
        assertTrue("写入必须落在组件命名空间内",
            new File(files, "v2-storage/example.tool/notes.json").isFile());
    }

    @Test public void readMissingAreaReturnsNullValue() throws Exception {
        File files = Files.createTempDirectory("v2storage").toFile();
        V2ComponentStore store = storeWithComponent(files, "example.tool", "1.0.0", true);
        V2ComponentStorage storage = new V2ComponentStorage(files, store);
        JSONObject readResult = storage.read(new JSONObject()
            .put("caller", caller("example.tool", "1.0.0"))
            .put("area", "absent"));
        assertEquals(true, readResult.getBoolean("ok"));
        assertTrue(readResult.isNull("value"));
    }

    @Test public void undeclaredCapabilityIsDenied() throws Exception {
        File files = Files.createTempDirectory("v2storage").toFile();
        V2ComponentStore store = storeWithComponent(files, "example.tool", "1.0.0", false);
        V2ComponentStorage storage = new V2ComponentStorage(files, store);
        try {
            storage.write(new JSONObject()
                .put("caller", caller("example.tool", "1.0.0"))
                .put("area", "notes")
                .put("value", new JSONObject().put("n", 1)));
            fail("未声明 host.storage 能力的组件必须被拒绝");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("host.storage"));
        }
        assertFalse("拒绝调用不得落盘", new File(files, "v2-storage/example.tool/notes.json").exists());
    }

    @Test public void missingCallerIdentityIsDenied() throws Exception {
        File files = Files.createTempDirectory("v2storage").toFile();
        V2ComponentStore store = storeWithComponent(files, "example.tool", "1.0.0", true);
        V2ComponentStorage storage = new V2ComponentStorage(files, store);
        try {
            storage.write(new JSONObject().put("area", "notes").put("value", 1));
            fail("缺少 caller 身份必须拒绝");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("caller"));
        }
        try {
            storage.write(new JSONObject().put("caller", caller("example.absent", "1.0.0")).put("area", "notes").put("value", 1));
            fail("未安装组件的 caller 必须拒绝");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("capability") || expected.getMessage().contains("missing"));
        }
    }

    @Test public void invalidAreaIsRejected() throws Exception {
        File files = Files.createTempDirectory("v2storage").toFile();
        V2ComponentStore store = storeWithComponent(files, "example.tool", "1.0.0", true);
        V2ComponentStorage storage = new V2ComponentStorage(files, store);
        try {
            storage.write(new JSONObject()
                .put("caller", caller("example.tool", "1.0.0"))
                .put("area", "../escape")
                .put("value", 1));
            fail("非法 area 必须拒绝");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("area"));
        }
    }
}
