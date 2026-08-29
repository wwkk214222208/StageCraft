package ai.stagecraft.android;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/**
 * W6：主进程 PluginConfigStore（计划 §2.1/§5.3/§6，阶段 5；Q4 裁决）。
 *
 * 只持久化 desiredEnabled/config/quarantine/launchPlan——全部在 Core 之外，
 * Core 从未启动或已 crashed 时仍可读写（阶段 1 验收锚点）。
 * 不实现依赖拓扑/冲突规则（深度校验唯一实现在 TS plugin-bootstrap.ts，Q4 裁决），
 * 本类只做 JSON 文件原子持久化（先写临时文件再 rename）。
 *
 * 存储形状与 TS createNodeFilePluginConfigStore 对齐（formatVersion/config/enabled/
 * quarantine/launchPlan），保证桌面与 Android 同构。
 */
public final class PluginConfigStore {
    private static final int STORE_FORMAT_VERSION = 1;
    private final File file;

    public PluginConfigStore(Context context) {
        this.file = new File(context.getFilesDir(), "plugin-config-store.json");
    }

    /** 测试 seam：指定文件。 */
    public PluginConfigStore(File file) {
        this.file = file;
    }

    public File file() { return file; }

    private JSONObject load() {
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] bytes = new byte[(int) file.length()];
            int read = input.read(bytes);
            String json = new String(bytes, 0, Math.max(0, read), StandardCharsets.UTF_8);
            JSONObject parsed = new JSONObject(json);
            if (parsed.optInt("formatVersion", -1) != STORE_FORMAT_VERSION) return emptyState();
            return parsed;
        } catch (Exception error) {
            // 文件不存在/损坏：空状态起步（Core 不可用时管理器必须仍可用）
            return emptyState();
        }
    }

    private static JSONObject emptyState() {
        JSONObject state = new JSONObject();
        try {
            state.put("formatVersion", STORE_FORMAT_VERSION);
            state.put("updatedAt", "1970-01-01T00:00:00.000Z");
            state.put("config", new JSONObject());
            state.put("enabled", new JSONObject());
            state.put("quarantine", new JSONArray());
            state.put("launchPlan", JSONObject.NULL);
        } catch (Exception ignored) { }
        return state;
    }

    private synchronized void persist(JSONObject state) {
        try {
            state.put("updatedAt", java.time.Instant.now().toString());
            File parent = file.getParentFile();
            if (parent != null && !parent.exists()) parent.mkdirs();
            File temporary = new File(file.getParentFile(), file.getName() + ".tmp");
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                output.write(state.toString(2).getBytes(StandardCharsets.UTF_8));
            }
            if (file.exists()) file.delete();
            temporary.renameTo(file);
        } catch (Exception error) {
            GateALog.w("plugin config store persist failed: " + error);
        }
    }

    /** 读全部启用意图（id → boolean）。 */
    public synchronized JSONObject readEnabled() {
        return load().optJSONObject("enabled");
    }

    /** 写单个启用意图。 */
    public synchronized void writeEnabled(String id, boolean enabled) {
        JSONObject state = load();
        JSONObject enabledMap = state.optJSONObject("enabled");
        if (enabledMap == null) { enabledMap = new JSONObject(); try { state.put("enabled", enabledMap); } catch (Exception ignored) { } }
        try { enabledMap.put(id, enabled); } catch (Exception ignored) { }
        persist(state);
    }

    /** 读全部配置（id → config）。 */
    public synchronized JSONObject readConfig() {
        return load().optJSONObject("config");
    }

    /** 写单个插件配置。 */
    public synchronized void writeConfig(String id, JSONObject config) {
        JSONObject state = load();
        JSONObject configMap = state.optJSONObject("config");
        if (configMap == null) { configMap = new JSONObject(); try { state.put("config", configMap); } catch (Exception ignored) { } }
        try {
            if (config == null) configMap.remove(id);
            else configMap.put(id, config);
        } catch (Exception ignored) { }
        persist(state);
    }

    /** 读隔离记录（Core 上报，主进程只读展示）。 */
    public synchronized JSONArray readQuarantine() {
        return load().optJSONArray("quarantine");
    }

    /** 写隔离记录（Core bootstrap 结果经 Binder/数据面回报）。 */
    public synchronized void writeQuarantine(JSONArray records) {
        JSONObject state = load();
        try { state.put("quarantine", records == null ? new JSONArray() : records); } catch (Exception ignored) { }
        persist(state);
    }

    /** 读最近一次 launch plan（Core 重启后复用同一 plan 身份）。 */
    public synchronized JSONObject readLaunchPlan() {
        Object plan = load().opt("launchPlan");
        return plan instanceof JSONObject ? (JSONObject) plan : null;
    }

    /** 写 launch plan。 */
    public synchronized void writeLaunchPlan(JSONObject plan) {
        JSONObject state = load();
        try { state.put("launchPlan", plan == null ? JSONObject.NULL : plan); } catch (Exception ignored) { }
        persist(state);
    }
}
