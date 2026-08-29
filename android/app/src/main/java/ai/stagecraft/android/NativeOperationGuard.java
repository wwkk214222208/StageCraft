package ai.stagecraft.android;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;

/**
 * Gate B：native operation allowlist 在真实 Java 分派层的执行器。
 *
 * 规则来源：src/native-operation-registry.ts 经 scripts/generate-gatebc-assets.mjs 生成的
 * native-operation-registry.json（构建期产物，Java 侧不得手写白名单）。
 *
 * 迁移期语义（与 CP-W1 一致）：通用分派入口允许 legacy-main-core 封闭例外集合内的操作；
 * 未登记操作一律拒绝。Gate D 将 enforceLegacyOnly 翻转为 false 后，通用入口只放行 main-host
 * 语义操作，core-native 全部拒绝。
 */
public final class NativeOperationGuard {
    private final java.util.Set<String> legacyMainCore;
    private final java.util.Set<String> mainHost;
    private final boolean enforceLegacyOnly;

    private NativeOperationGuard(java.util.Set<String> legacyMainCore,
                                 java.util.Set<String> mainHost,
                                 boolean enforceLegacyOnly) {
        this.legacyMainCore = legacyMainCore;
        this.mainHost = mainHost;
        this.enforceLegacyOnly = enforceLegacyOnly;
    }

    public static NativeOperationGuard parse(String json, boolean enforceLegacyOnly) {
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
            return new NativeOperationGuard(legacy, mainHost, enforceLegacyOnly);
        } catch (Exception error) {
            throw new IllegalStateException("native-operation-registry.json 解析失败", error);
        }
    }

    /** 从应用外部存储/资产目录加载。 */
    public static NativeOperationGuard load(File asset, boolean enforceLegacyOnly) {
        try (FileInputStream input = new FileInputStream(asset)) {
            byte[] bytes = new byte[input.available()];
            int read = input.read(bytes);
            return parse(new String(bytes, 0, Math.max(0, read), StandardCharsets.UTF_8), enforceLegacyOnly);
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
            return enforceLegacyOnly ? "legacy-main-core 例外已移除（Gate D）：" + operation : null;
        }
        if (mainHost.contains(operation)) return null;
        return "operation 未登记于 NativeOperationRegistry：" + operation;
    }

    /** :core 侧（W5 CoreNative 桥）专用：只允许 core-native。 */
    public String checkCoreNative(String operation) {
        if (coreNative().contains(operation)) return null;
        return "operation 不在 core-native allowlist：" + operation;
    }

    public java.util.Set<String> coreNative() {
        java.util.Set<String> names = new java.util.HashSet<>();
        // coreNative 列表 = legacy 例外全集（迁移期两者一致；Gate D 后仍为 core-native 目标集）
        names.addAll(legacyMainCore);
        return names;
    }

    public java.util.Set<String> mainHost() { return new java.util.HashSet<>(mainHost); }
}
