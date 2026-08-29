package ai.stagecraft.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.io.File;
import java.nio.file.Files;

/**
 * W6：PluginConfigStore + PluginManager 纯 JVM 测试（计划 §2.1/§5.3/阶段 5；Q4 裁决）。
 *
 * 验证：
 *  - PluginConfigStore：Core 不可用时仍可读写（独立文件，损坏兜底空状态）；
 *  - PluginManager：desired/effective/quarantined 状态聚合；launch plan 生成与持久化；
 *  - 隔离插件不进 effective。
 */
public final class PluginManagerTest {

    private File tempStore() throws Exception {
        File dir = Files.createTempDirectory("w6-plugin-store").toFile();
        return new File(dir, "plugin-config-store.json");
    }

    @Test public void storeReadWriteEnabled() throws Exception {
        File file = tempStore();
        PluginConfigStore store = new PluginConfigStore(file);
        store.writeEnabled("stagecraft.chat", false);
        JSONObject enabled = store.readEnabled();
        assertFalse("写后必须可读", enabled.optBoolean("stagecraft.chat", true));
        // 重新实例化（模拟重启）仍可读
        PluginConfigStore reloaded = new PluginConfigStore(file);
        assertFalse("重启后必须持久化", reloaded.readEnabled().optBoolean("stagecraft.chat", true));
    }

    @Test public void storeCorruptFallsBackToEmpty() throws Exception {
        File file = tempStore();
        Files.write(file.toPath(), "{corrupt json".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        PluginConfigStore store = new PluginConfigStore(file);
        JSONObject enabled = store.readEnabled();
        assertNotNull("损坏文件必须兜底空状态（Core 不可用时管理器仍可用）", enabled);
        // 兜底后仍可写
        store.writeEnabled("stagecraft.chat", true);
        assertTrue(store.readEnabled().optBoolean("stagecraft.chat", false));
    }

    @Test public void managerTracksDesiredEffectiveQuarantined() throws Exception {
        File file = tempStore();
        PluginManager manager = new PluginManager(new PluginConfigStore(file));
        manager.setEnabled("stagecraft.chat", true);
        manager.setEnabled("bad.plugin", true);
        // Core 上报隔离 bad.plugin
        JSONArray quarantine = new JSONArray();
        quarantine.put(new JSONObject().put("pluginId", "bad.plugin").put("reason", "install failed").put("stage", "install"));
        manager.updateQuarantine(quarantine);
        // effective = desired − quarantined
        assertTrue("正常插件必须 effective", manager.effectiveEnabled().contains("stagecraft.chat"));
        assertFalse("隔离插件必须不进 effective", manager.effectiveEnabled().contains("bad.plugin"));
        assertEquals("隔离记录必须可读", "install failed", manager.quarantined().optJSONObject(0).optString("reason"));
    }

    @Test public void managerBuildsAndPersistsLaunchPlan() throws Exception {
        File file = tempStore();
        PluginManager manager = new PluginManager(new PluginConfigStore(file));
        // 注入构建期 catalog（真实 plugin-manifest.json；JVM 测试直读仓库资产）
        File manifest = new File("src/main/assets/plugin-manifest.json");
        assertTrue("plugin-manifest.json 必须存在", manifest.exists());
        String json = new String(Files.readAllBytes(manifest.toPath()), java.nio.charset.StandardCharsets.UTF_8);
        JSONObject root = new JSONObject(json);
        JSONArray catalog = root.optJSONArray("plugins");
        assertNotNull(catalog);
        assertTrue("catalog 必须含内置插件", catalog.length() >= 4);
        // 手工注入 catalog（loadCatalog 需要 Context；测试用直接构造）
        for (int i = 0; i < catalog.length(); i++) {
            JSONObject plugin = catalog.optJSONObject(i);
            manager.catalog().add(new PluginManager.PluginCatalog(
                plugin.optString("id"), plugin.optString("version"), plugin.optString("manifestHash")));
        }
        JSONObject plan = manager.regenerateLaunchPlan();
        assertNotNull(plan);
        assertEquals("1.1", plan.optString("protocolVersion"));
        JSONArray plugins = plan.optJSONArray("plugins");
        assertNotNull(plugins);
        boolean found = false;
        for (int i = 0; i < plugins.length(); i++) {
            JSONObject plugin = plugins.optJSONObject(i);
            if ("stagecraft.solution".equals(plugin.optString("id"))) {
                found = true;
                assertTrue("启用插件必须 enabled", plugin.optBoolean("enabled"));
                assertFalse("manifestHash 不得是占位 unknown", "unknown".equals(plugin.optString("manifestHash")));
                assertFalse("manifestHash 不得为空", plugin.optString("manifestHash").isEmpty());
            }
        }
        assertTrue("launch plan 必须含内置插件（catalog 驱动）", found);
        // plan 持久化：新实例可读同一 plan
        PluginManager reloaded = new PluginManager(new PluginConfigStore(file));
        assertNotNull("launch plan 必须持久化", reloaded.buildLaunchPlan());
    }

    @Test public void regeneratedPlanMarksQuarantinedDisabled() throws Exception {
        File file = tempStore();
        PluginManager manager = new PluginManager(new PluginConfigStore(file));
        // 注入 catalog（复用真实资产）
        File manifest = new File("src/main/assets/plugin-manifest.json");
        String json = new String(Files.readAllBytes(manifest.toPath()), java.nio.charset.StandardCharsets.UTF_8);
        JSONArray catalog = new JSONObject(json).optJSONArray("plugins");
        for (int i = 0; i < catalog.length(); i++) {
            JSONObject plugin = catalog.optJSONObject(i);
            manager.catalog().add(new PluginManager.PluginCatalog(
                plugin.optString("id"), plugin.optString("version"), plugin.optString("manifestHash")));
        }
        String quarantinedId = catalog.optJSONObject(0).optString("id");
        JSONArray quarantine = new JSONArray();
        quarantine.put(new JSONObject().put("pluginId", quarantinedId));
        manager.updateQuarantine(quarantine);
        JSONObject plan = manager.regenerateLaunchPlan();
        JSONArray plugins = plan.optJSONArray("plugins");
        boolean found = false;
        for (int i = 0; i < plugins.length(); i++) {
            JSONObject plugin = plugins.optJSONObject(i);
            if (quarantinedId.equals(plugin.optString("id"))) {
                found = true;
                assertFalse("隔离插件必须 enabled=false", plugin.optBoolean("enabled"));
            }
        }
        assertTrue("隔离插件必须仍在 plan 中（enabled=false）", found);
    }

    @Test public void r3SetEnabledRebuildsPlanWithChangedHash() throws Exception {
        File file = tempStore();
        PluginManager manager = new PluginManager(new PluginConfigStore(file));
        // 注入 catalog
        File manifest = new File("src/main/assets/plugin-manifest.json");
        String json = new String(Files.readAllBytes(manifest.toPath()), java.nio.charset.StandardCharsets.UTF_8);
        JSONArray catalog = new JSONObject(json).optJSONArray("plugins");
        for (int i = 0; i < catalog.length(); i++) {
            JSONObject plugin = catalog.optJSONObject(i);
            manager.catalog().add(new PluginManager.PluginCatalog(
                plugin.optString("id"), plugin.optString("version"), plugin.optString("manifestHash")));
        }
        // 初始 plan（全部 enabled）
        JSONObject planBefore = manager.buildLaunchPlan();
        String hashBefore = planBefore.optString("pluginSetHash");
        // R3-4：setEnabled(false) 必须立即重建 plan（哈希变化 + enabled=false）
        String targetId = catalog.optJSONObject(0).optString("id");
        manager.setEnabled(targetId, false);
        JSONObject planAfter = manager.buildLaunchPlan(); // 复用持久化 plan = 重建后的新 plan
        String hashAfter = planAfter.optString("pluginSetHash");
        assertFalse("禁用插件后 pluginSetHash 必须变化", hashBefore.equals(hashAfter));
        boolean found = false;
        JSONArray plugins = planAfter.optJSONArray("plugins");
        for (int i = 0; i < plugins.length(); i++) {
            JSONObject plugin = plugins.optJSONObject(i);
            if (targetId.equals(plugin.optString("id"))) {
                found = true;
                assertFalse("setEnabled(false) 后 plan 必须 enabled=false", plugin.optBoolean("enabled"));
            }
        }
        assertTrue("plan 必须含被禁用插件（enabled=false）", found);
        // 重启语义：新 PluginManager 实例（模拟 Core 重启）消费同一持久化 plan
        PluginManager restarted = new PluginManager(new PluginConfigStore(file));
        JSONObject planOnRestart = restarted.buildLaunchPlan();
        assertEquals("重启必须消费新 plan（哈希一致）", hashAfter, planOnRestart.optString("pluginSetHash"));
    }

    @Test public void r3QuarantineChangeRebuildsPlan() throws Exception {
        File file = tempStore();
        PluginManager manager = new PluginManager(new PluginConfigStore(file));
        File manifest = new File("src/main/assets/plugin-manifest.json");
        String json = new String(Files.readAllBytes(manifest.toPath()), java.nio.charset.StandardCharsets.UTF_8);
        JSONArray catalog = new JSONObject(json).optJSONArray("plugins");
        for (int i = 0; i < catalog.length(); i++) {
            JSONObject plugin = catalog.optJSONObject(i);
            manager.catalog().add(new PluginManager.PluginCatalog(
                plugin.optString("id"), plugin.optString("version"), plugin.optString("manifestHash")));
        }
        String hashBefore = manager.buildLaunchPlan().optString("pluginSetHash");
        // quarantine 变化 → plan 重建（哈希变化）
        String targetId = catalog.optJSONObject(1).optString("id");
        JSONArray quarantine = new JSONArray();
        quarantine.put(new JSONObject().put("pluginId", targetId));
        manager.updateQuarantine(quarantine);
        String hashAfter = manager.buildLaunchPlan().optString("pluginSetHash");
        assertFalse("quarantine 变化后 pluginSetHash 必须变化", hashBefore.equals(hashAfter));
        // 相同 quarantine 再上报 → 不重建（幂等）
        manager.updateQuarantine(quarantine);
        assertEquals("相同 quarantine 不得重建 plan", hashAfter, manager.buildLaunchPlan().optString("pluginSetHash"));
    }
}
