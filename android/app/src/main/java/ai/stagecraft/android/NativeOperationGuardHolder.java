package ai.stagecraft.android;

import android.content.Context;

import java.io.InputStream;

/**
 * NativeOperationGuard 的进程级持有者：从 APK 资产加载（构建期生成，不手写）。
 *
 * 迁移期默认 legacyCoreBridgeEnabled=true（保持旧 Android Core 操作可用：主 WebView
 * 仍经 invokeSync/invokeAsync 执行 core-native 操作）；通过
 * setLegacyCoreBridgeEnabled(false) 翻转后拒绝跨 owner 调用。
 *
 * 翻转对已初始化实例立即生效：不是只改旁路布尔值，而是原子替换整个 guard 实例
 * （不可变对象 + volatile 替换，并发分派要么看到旧实例要么看到新实例，无中间态）。
 */
public final class NativeOperationGuardHolder {
    private static volatile NativeOperationGuard instance;
    private static volatile boolean legacyCoreBridgeEnabled = true;

    private NativeOperationGuardHolder() {}

    public static NativeOperationGuard get(Context context) {
        NativeOperationGuard local = instance;
        if (local == null) {
            synchronized (NativeOperationGuardHolder.class) {
                local = instance;
                if (local == null) {
                    try (InputStream input = context.getAssets().open("native-operation-registry.json")) {
                        java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
                        byte[] buffer = new byte[8192];
                        int read;
                        while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
                        local = NativeOperationGuard.parse(output.toString("UTF-8"), legacyCoreBridgeEnabled);
                        instance = local;
                    } catch (Exception error) {
                        throw new IllegalStateException("native-operation-registry.json 加载失败（构建期生成资产必须存在）", error);
                    }
                }
            }
        }
        return local;
    }

    /** 测试与文件日志路径使用。 */
    public static NativeOperationGuard get() {
        NativeOperationGuard local = instance;
        if (local == null) throw new IllegalStateException("NativeOperationGuard 未初始化（须先经 get(Context) 加载）");
        return local;
    }

    /**
     * 翻转：false=拒绝 legacy core-native 从主 WebView 通用入口进入。
     * 原子替换已缓存实例（重建 guard），对已初始化状态立即生效；重复翻转幂等。
     */
    public static synchronized void setLegacyCoreBridgeEnabled(boolean enabled, Context context) {
        legacyCoreBridgeEnabled = enabled;
        if (instance != null) {
            instance = NativeOperationGuard.parse(assetJson(context), enabled);
        }
    }

    /** 测试路径（无 Context）：重建已缓存实例；未初始化时仅记录布尔值。 */
    public static synchronized void setLegacyCoreBridgeEnabled(boolean enabled) {
        legacyCoreBridgeEnabled = enabled;
        NativeOperationGuard local = instance;
        if (local != null) {
            // 无 Context 无法重读资产：用当前实例的集合重建（同一份数据，仅翻转语义）
            instance = local.rebuild(enabled);
        }
    }

    /** 测试注入入口：用给定资产 JSON 重建实例（JVM 无 Context 时验证原子替换逻辑）。 */
    static synchronized void setLegacyCoreBridgeEnabled(boolean enabled, String assetJson) {
        legacyCoreBridgeEnabled = enabled;
        instance = NativeOperationGuard.parse(assetJson, enabled);
    }

    /** 测试可见：当前生效的 legacy 语义。 */
    static boolean legacyCoreBridgeEnabled() {
        return legacyCoreBridgeEnabled;
    }

    private static String assetJson(Context context) {
        try (InputStream input = context.getAssets().open("native-operation-registry.json")) {
            java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
            return output.toString("UTF-8");
        } catch (Exception error) {
            throw new IllegalStateException("native-operation-registry.json 读取失败", error);
        }
    }
}
