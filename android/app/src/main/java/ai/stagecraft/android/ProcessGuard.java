package ai.stagecraft.android;

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
     * 进程入口首行调用：:core 进程设置 WebView suffix，且只在第一次调用时生效。
     * 返回本次调用是否执行了初始化（供测试与启动时序记录）。
     */
    public static boolean init(String processName) {
        String suffix = suffixForProcess(processName);
        if (suffix == null) return false;
        if (!DONE.compareAndSet(false, true)) return false;
        WebView.setDataDirectorySuffix(suffix);
        return true;
    }
}
