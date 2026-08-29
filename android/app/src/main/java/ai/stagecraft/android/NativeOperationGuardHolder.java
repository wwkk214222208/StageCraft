package ai.stagecraft.android;

import android.content.Context;

import java.io.File;
import java.io.InputStream;

/**
 * NativeOperationGuard 的进程级持有者：从 APK 资产加载（构建期生成，不手写）。
 * 首次访问懒加载；Gate D 通过 setEnforceLegacyOnly(false) 翻转。
 */
public final class NativeOperationGuardHolder {
    private static volatile NativeOperationGuard instance;
    private static volatile boolean enforceLegacyOnly = true;

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
                        local = NativeOperationGuard.parse(output.toString("UTF-8"), enforceLegacyOnly);
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

    public static void setEnforceLegacyOnly(boolean value) { enforceLegacyOnly = value; }
}
