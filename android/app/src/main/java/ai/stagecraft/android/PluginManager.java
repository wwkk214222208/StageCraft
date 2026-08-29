package ai.stagecraft.android;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * W6：主进程 PluginManager（计划 §2.1/§5.3/阶段 5；D2 管理层独立于 Core）。
 *
 * 状态模型（与 TS plugin-bootstrap.ts 对齐）：
 *  - desired：PluginConfigStore 的启用意图（主进程持久化，Core 不可用时仍可读写）；
 *  - effective：desired − quarantined（Core bootstrap 实际装载结果，经数据面回报）；
 *  - quarantined：Core 上报的隔离记录（manifest/dependency/install 失败）。
 *
 * W6-2（评审整改）：launch plan 消费构建期 plugin-manifest.json（id/version/manifestHash
 * 真实值，与 :core 组合根 BUILTIN_PLUGIN_MANIFESTS 同一来源），不再用占位身份；
 * pluginSetHash 用与 TS 同语义的确定性哈希（排序后 id/version/manifestHash/enabled）。
 *
 * 本类只做状态聚合与 launch plan 生成，不实现依赖拓扑规则（Q4：深度校验唯一在 TS）。
 */
public final class PluginManager {
    /** 构建期插件目录（assets/plugin-manifest.json；与 :core 组合根同源）。 */
    public static final class PluginCatalog {
        public final String id;
        public final String version;
        public final String manifestHash;
        PluginCatalog(String id, String version, String manifestHash) {
            this.id = id;
            this.version = version;
            this.manifestHash = manifestHash;
        }
    }

    private final PluginConfigStore store;
    private volatile JSONArray quarantine = new JSONArray();
    private final List<PluginCatalog> catalog = new ArrayList<>();

    public PluginManager(PluginConfigStore store) {
        this.store = store;
        this.quarantine = store.readQuarantine();
    }

    /** 加载构建期插件目录（assets/plugin-manifest.json）。失败时目录为空（plan 生成退化为空集）。 */
    public void loadCatalog(Context context) {
        catalog.clear();
        try (InputStream input = context.getAssets().open("plugin-manifest.json")) {
            byte[] bytes = new byte[input.available()];
            int read = input.read(bytes);
            JSONObject root = new JSONObject(new String(bytes, 0, Math.max(0, read), StandardCharsets.UTF_8));
            JSONArray plugins = root.optJSONArray("plugins");
            if (plugins != null) {
                for (int i = 0; i < plugins.length(); i++) {
                    JSONObject plugin = plugins.optJSONObject(i);
                    if (plugin != null) {
                        catalog.add(new PluginCatalog(
                            plugin.optString("id", ""),
                            plugin.optString("version", ""),
                            plugin.optString("manifestHash", "")));
                    }
                }
            }
            GateALog.i("plugin catalog loaded: " + catalog.size() + " plugins");
        } catch (Exception error) {
            GateALog.w("plugin catalog load failed: " + error);
        }
    }

    /** 构建期插件目录（测试/诊断用）。 */
    public List<PluginCatalog> catalog() { return catalog; }

    /** 插件启用意图（desired）：id → boolean。 */
    public JSONObject desiredEnabled() {
        return store.readEnabled();
    }

    /** 写启用意图（改配置 → 提示重启生效，不热加载）。 */
    public void setEnabled(String id, boolean enabled) {
        store.writeEnabled(id, enabled);
    }

    /** 插件配置（desired config）。 */
    public JSONObject pluginConfig(String id) {
        JSONObject config = store.readConfig();
        return config == null ? null : config.optJSONObject(id);
    }

    /** 写插件配置。 */
    public void setPluginConfig(String id, JSONObject config) {
        store.writeConfig(id, config);
    }

    /** Core 上报的隔离记录（quarantined）。 */
    public JSONArray quarantined() {
        return quarantine;
    }

    /** 更新隔离记录（Core plugin-report 经 health 回报；主进程持久化）。 */
    public void updateQuarantine(JSONArray records) {
        quarantine = records == null ? new JSONArray() : records;
        store.writeQuarantine(quarantine);
    }

    /** effective：desired − quarantined（id 列表）。 */
    public List<String> effectiveEnabled() {
        JSONObject desired = desiredEnabled();
        List<String> result = new ArrayList<>();
        if (desired != null) {
            java.util.Iterator<String> keys = desired.keys();
            while (keys.hasNext()) {
                String id = keys.next();
                if (desired.optBoolean(id, true) && !isQuarantined(id)) result.add(id);
            }
        }
        return result;
    }

    private boolean isQuarantined(String id) {
        for (int i = 0; i < quarantine.length(); i++) {
            JSONObject record = quarantine.optJSONObject(i);
            if (record != null && id.equals(record.optString("pluginId"))) return true;
        }
        return false;
    }

    private PluginCatalog catalogEntry(String id) {
        for (PluginCatalog entry : catalog) {
            if (entry.id.equals(id)) return entry;
        }
        return null;
    }

    /**
     * 生成 PluginLaunchPlan（§2.4）：消费构建期 plugin-manifest.json 的真实 id/version/manifestHash。
     * 候选集 = 目录全部插件；enabled = desired（缺省启用）− quarantined。
     * plan 不可变，运行中不热替换；改配置后由调用方重启 Core。
     */
    public JSONObject buildLaunchPlan() {
        JSONObject existing = store.readLaunchPlan();
        if (existing != null) return existing;
        JSONObject plan = buildPlan();
        store.writeLaunchPlan(plan);
        return plan;
    }

    /** 插件配置变更后：重新生成 plan 并保存（调用方负责重启 Core 使生效）。 */
    public JSONObject regenerateLaunchPlan() {
        JSONObject plan = buildPlan();
        store.writeLaunchPlan(plan);
        return plan;
    }

    private JSONObject buildPlan() {
        JSONObject plan = new JSONObject();
        try {
            plan.put("protocolVersion", "1.1");
            JSONArray plugins = new JSONArray();
            JSONObject desired = desiredEnabled();
            JSONObject config = store.readConfig();
            // 目录按 id 排序（与 TS buildPluginLaunchPlan 同序）
            List<PluginCatalog> sorted = new ArrayList<>(catalog);
            sorted.sort((a, b) -> a.id.compareTo(b.id));
            for (PluginCatalog entry : sorted) {
                JSONObject plugin = new JSONObject();
                plugin.put("id", entry.id);
                plugin.put("version", entry.version);
                plugin.put("manifestHash", entry.manifestHash);
                boolean desiredEnabled = desired == null || desired.optBoolean(entry.id, true);
                plugin.put("enabled", desiredEnabled && !isQuarantined(entry.id));
                JSONObject pluginConfig = config == null ? null : config.optJSONObject(entry.id);
                if (pluginConfig != null) plugin.put("config", pluginConfig);
                plugins.put(plugin);
            }
            plan.put("plugins", plugins);
            // pluginSetHash：与 TS 同语义（排序后 id/version/manifestHash/enabled 的确定性哈希）
            plan.put("pluginSetHash", computePluginSetHash(plugins));
            plan.put("stateSchemaVersion", "unknown");
        } catch (Exception ignored) { }
        return plan;
    }

    /** 确定性 FNV-1a 32bit 哈希（与 TS stableHash 同算法；仅一致性核对，非安全）。 */
    private static String computePluginSetHash(JSONArray plugins) {
        StringBuilder material = new StringBuilder();
        for (int i = 0; i < plugins.length(); i++) {
            JSONObject plugin = plugins.optJSONObject(i);
            if (plugin == null) continue;
            material.append(plugin.optString("id", ""))
                .append(plugin.optString("version", ""))
                .append(plugin.optString("manifestHash", ""))
                .append(plugin.optBoolean("enabled", false));
        }
        int hash = 0x811c9dc5;
        String value = material.toString();
        for (int i = 0; i < value.length(); i++) {
            hash ^= value.charAt(i);
            // FNV-1a 32bit：Java int 溢出自然截断为 32 位（与 TS Math.imul >>> 0 同语义）
            hash = hash * 0x01000193;
        }
        return String.format("%08x", hash);
    }
}
