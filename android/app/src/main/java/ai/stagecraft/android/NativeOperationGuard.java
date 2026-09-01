package ai.stagecraft.android;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;

/**
 * native operation allowlist 在真实 Java 分派层的执行器。
 *
 * 规则来源：src/native-operation-registry.ts 经 scripts/generate-gatebc-assets.mjs 生成的
 * native-operation-registry.json（构建期产物，Java 侧不得手写白名单）。
 *
 * 迁移期语义：通用分派入口允许 legacy-main-core 封闭例外集合内的操作；
 * 未登记操作一律拒绝。legacyCoreBridgeEnabled 翻转为 false 后，通用入口只放行 main-host
 * 语义操作，core-native 全部拒绝。
 *
 * 命名约定：legacyCoreBridgeEnabled=true 表示"legacy 通用入口允许 core-native 操作"（迁移期，
 * 当前生产默认）；false 表示拒绝跨 owner 调用。语义只随该布尔单向演进（true→false）。
 */
public final class NativeOperationGuard {
    private final java.util.Set<String> legacyMainCore;
    private final java.util.Set<String> mainHost;
    /** 目标态 core-native 全集（registry JSON 的 coreNative 数组；旧 JSON 缺失时回退 legacy 集合）。 */
    private final java.util.Set<String> coreNativeTargets;
    private final boolean legacyCoreBridgeEnabled;

    private NativeOperationGuard(java.util.Set<String> legacyMainCore,
                                 java.util.Set<String> mainHost,
                                 java.util.Set<String> coreNativeTargets,
                                 boolean legacyCoreBridgeEnabled) {
        this.legacyMainCore = legacyMainCore;
        this.mainHost = mainHost;
        this.coreNativeTargets = coreNativeTargets;
        this.legacyCoreBridgeEnabled = legacyCoreBridgeEnabled;
    }

    /** 同包重建（Holder 翻转时用同一份集合数据，仅翻转语义）。 */
    NativeOperationGuard rebuild(boolean legacyCoreBridgeEnabled) {
        return new NativeOperationGuard(legacyMainCore, mainHost, coreNativeTargets, legacyCoreBridgeEnabled);
    }

    public static NativeOperationGuard parse(String json, boolean legacyCoreBridgeEnabled) {
        try {
            JSONObject root = new JSONObject(json);
            java.util.Set<String> legacy = new java.util.HashSet<>();
            org.json.JSONArray legacyArray = root.optJSONArray("legacyMainCoreException");
            if (legacyArray != null) {
                for (int index = 0; index < legacyArray.length(); index++) legacy.add(legacyArray.optString(index));
            }
            java.util.Set<String> mainHost = new java.util.HashSet<>();
            org.json.JSONArray mainHostArray = root.optJSONArray("mainHost");
            if (mainHostArray != null) {
                for (int index = 0; index < mainHostArray.length(); index++) mainHost.add(mainHostArray.optString(index));
            }
            java.util.Set<String> coreNativeTargets = new java.util.HashSet<>();
            org.json.JSONArray coreNativeArray = root.optJSONArray("coreNative");
            if (coreNativeArray != null) {
                for (int index = 0; index < coreNativeArray.length(); index++) coreNativeTargets.add(coreNativeArray.optString(index));
            } else {
                // 旧版资产只有 legacy 集合（迁移期两者一致）。
                coreNativeTargets.addAll(legacy);
            }
            return new NativeOperationGuard(legacy, mainHost, coreNativeTargets, legacyCoreBridgeEnabled);
        } catch (Exception error) {
            throw new IllegalStateException("native-operation-registry.json 解析失败", error);
        }
    }

    /** 从应用外部存储/资产目录加载。 */
    public static NativeOperationGuard load(File asset, boolean legacyCoreBridgeEnabled) {
        try (FileInputStream input = new FileInputStream(asset)) {
            byte[] bytes = new byte[input.available()];
            int read = input.read(bytes);
            return parse(new String(bytes, 0, Math.max(0, read), StandardCharsets.UTF_8), legacyCoreBridgeEnabled);
        } catch (Exception error) {
            throw new IllegalStateException("native-operation-registry.json 加载失败", error);
        }
    }

    /**
     * 通用分派入口（invokeSync/invokeAsync）操作校验。
     * 返回 null 表示放行；返回非 null 为拒绝理由（调用方转成稳定错误 JSON）。
     */
    public String checkGenericDispatch(String operation) {
        if (operation == null || operation.isEmpty()) return "operation is empty";
        if (legacyMainCore.contains(operation)) {
            return legacyCoreBridgeEnabled ? null : "legacy-main-core 例外已移除：" + operation;
        }
        if (mainHost.contains(operation)) return null;
        return "operation 未登记于 NativeOperationRegistry（legacy=" + legacyMainCore.size() + ", mainHost=" + mainHost.size() + "）：" + operation;
    }

    /** :core 侧（W5 CoreNative 桥）专用：只允许 core-native 目标集。 */
    public String checkCoreNative(String operation) {
        if (coreNative().contains(operation)) return null;
        return "operation 不在 core-native allowlist：" + operation;
    }

    public java.util.Set<String> coreNative() {
        // 目标态集合：生成器按 owner=core-native 独立输出；不再是 legacy 例外集合的别名，
        // 因此新增仅 Core WebView 可达的操作（如 storage.*）不会扩大 legacy 例外。
        return new java.util.HashSet<>(coreNativeTargets);
    }

    public java.util.Set<String> mainHost() { return new java.util.HashSet<>(mainHost); }

    public java.util.Set<String> legacyMainCore() { return new java.util.HashSet<>(legacyMainCore); }
}
