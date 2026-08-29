package ai.stagecraft.android;

import android.app.Application;
import android.webkit.WebView;

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 双进程 WebView 唯一初始化入口（计划 §5.1 / Q1）。
 *
 * 主进程与 :core 进程不能共用 WebView 默认数据目录；:core 必须在第一次触碰 WebView 之前
 * 设置 suffix。任何进程入口（Activity/Service/Application）的第一行都必须调用 init()，
 * 不允许其它代码路径绕过本入口创建 WebView。每个进程生命周期内只允许调用一次。
 */
public final class ProcessGuard {
    /** :core 进程专用 WebView 数据目录后缀。 */
    public static final String CORE_SUFFIX = "core";

    private static final AtomicBoolean DONE = new AtomicBoolean(false);

    private ProcessGuard() {}

    /** 进程名 → WebView 数据目录后缀；主进程返回 null（使用默认目录）。纯函数，JVM 可测。 */
    public static String suffixForProcess(String processName) {
        if (processName == null) return null;
        return processName.endsWith(":core") ? CORE_SUFFIX : null;
    }

    /**
     * 当前进程名：API 28+ 走 Application.getProcessName()；更早版本读 /proc/self/cmdline
     * （公开接口，无限制）。getProcessName 是 API 28 引入——Lint 实锤的闪退根因之一。
     */
    public static String currentProcessName() {
        if (android.os.Build.VERSION.SDK_INT >= 28) return Application.getProcessName();
        try (java.io.DataInputStream input = new java.io.DataInputStream(new java.io.FileInputStream("/proc/self/cmdline"))) {
            byte[] buffer = new byte[256];
            int length = input.read(buffer);
            if (length > 0) {
                String name = new String(buffer, 0, length, java.nio.charset.StandardCharsets.UTF_8).trim();
                return name.isEmpty() ? null : name;
            }
        } catch (Throwable ignored) { }
        return null;
    }

    /**
     * 进程入口首行调用：:core 进程设置 WebView suffix，且只在第一次调用时生效。
     * setDataDirectorySuffix 同样是 API 28 引入（P 才有多进程 WebView 数据目录冲突问题），
     * API 26/27 无需也无法设置——直接跳过。
     */
    public static boolean init(String processName) {
        if (android.os.Build.VERSION.SDK_INT < 28) return false;
        String suffix = suffixForProcess(processName);
        if (suffix == null) return false;
        if (!DONE.compareAndSet(false, true)) return false;
        WebView.setDataDirectorySuffix(suffix);
        return true;
    }
}
