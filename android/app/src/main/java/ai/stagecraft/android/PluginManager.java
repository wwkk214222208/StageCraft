package ai.stagecraft.android;

import org.json.JSONArray;
import org.json.JSONObject;

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
 * 本类只做状态聚合与 launch plan 生成，不实现依赖拓扑规则（Q4：深度校验唯一在 TS）。
 * launch plan 生成后经 CoreConnection.acceptLaunchPlan 传给 :core（≤8KiB）。
 */
public final class PluginManager {
    private final PluginConfigStore store;
    private volatile JSONArray quarantine = new JSONArray();

    public PluginManager(PluginConfigStore store) {
        this.store = store;
        this.quarantine = store.readQuarantine();
    }

    /** 插件启用意图（desired）：id → enabled。 */
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

    /** 更新隔离记录（Core bootstrap 结果回报）。 */
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

    /**
     * 生成 PluginLaunchPlan（§2.4）：从 PluginConfigStore 的 desired 配置构建。
     * 插件集由构建期 manifest 决定（本类不持有 manifest 表）；无已存 plan 时生成空集标记。
     * plan 不可变，运行中不热替换；改配置后由调用方重启 Core。
     */
    public JSONObject buildLaunchPlan() {
        JSONObject existing = store.readLaunchPlan();
        if (existing != null) return existing;
        JSONObject plan = new JSONObject();
        try {
            plan.put("protocolVersion", "1.1");
            plan.put("pluginSetHash", "default-empty");
            plan.put("plugins", new JSONArray());
            plan.put("stateSchemaVersion", "unknown");
        } catch (Exception ignored) { }
        store.writeLaunchPlan(plan);
        return plan;
    }

    /** 插件配置变更后：重新生成 plan 并保存（调用方负责重启 Core 使生效）。 */
    public JSONObject regenerateLaunchPlan() {
        JSONObject plan = new JSONObject();
        try {
            plan.put("protocolVersion", "1.1");
            JSONArray plugins = new JSONArray();
            JSONObject desired = desiredEnabled();
            JSONObject config = store.readConfig();
            if (desired != null) {
                java.util.Iterator<String> keys = desired.keys();
                while (keys.hasNext()) {
                    String id = keys.next();
                    JSONObject plugin = new JSONObject();
                    plugin.put("id", id);
                    plugin.put("version", "1.0.0");
                    plugin.put("manifestHash", "unknown");
                    plugin.put("enabled", desired.optBoolean(id, true) && !isQuarantined(id));
                    JSONObject pluginConfig = config == null ? null : config.optJSONObject(id);
                    if (pluginConfig != null) plugin.put("config", pluginConfig);
                    plugins.put(plugin);
                }
            }
            plan.put("plugins", plugins);
            // pluginSetHash：与 TS 同语义（排序后的 id/version/manifestHash/enabled 哈希）；
            // Java 侧用确定性字符串标记，真实哈希由 TS bootstrap 计算（构建期身份以 :core health 为准）。
            plan.put("pluginSetHash", "java-managed-" + plugins.length());
            plan.put("stateSchemaVersion", "unknown");
        } catch (Exception ignored) { }
        store.writeLaunchPlan(plan);
        return plan;
    }
}
