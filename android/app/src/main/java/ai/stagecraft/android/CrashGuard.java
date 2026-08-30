package ai.stagecraft.android;

import android.content.Context;

import java.io.File;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;

/**
 * W0 spike 崩溃捕获：主进程与 :core 进程的任何未捕获 Throwable 都写入
 * files/app-crash-<进程名>.txt 并打 logcat（APP_CRASH），随后仍交给系统默认处理。
 * 目的：用户端闪退时无需 adb 也能拿回确切堆栈。
 */
public final class CrashGuard {
    private CrashGuard() {}

    public static void install(Context context) {
        AppLog.init(context);
        String processName = processName();
        final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, throwable) -> {
            try {
                String stack = stackOf(thread, throwable);
                AppLog.w("CRASH in " + processName + ": " + throwable);
                File output = new File(context.getFilesDir(), "app-crash-" + safe(processName) + ".txt");
                writeStack(output, stack);
                // 同时写一份到外部存储，便于无需 root 直接 adb pull / 文件管理器分享
                File external = context.getExternalFilesDir(null);
                if (external != null) {
                    writeStack(new File(external, "app-crash-" + safe(processName) + ".txt"), stack);
                }
            } catch (Throwable ignored) { }
            if (previous != null) previous.uncaughtException(thread, throwable);
        });
    }

    static String processName() {
        try {
            String name = ProcessGuard.currentProcessName();
            return name == null ? "unknown" : name;
        } catch (Throwable error) {
            return "unknown";
        }
    }

    static String stackOf(Thread thread, Throwable throwable) {
        StringWriter buffer = new StringWriter();
        buffer.write("process: " + processName() + "\n");
        buffer.write("thread: " + thread.getName() + "\n");
        buffer.write("at: " + java.time.Instant.now() + "\n\n");
        throwable.printStackTrace(new PrintWriter(buffer));
        return buffer.toString();
    }

    private static void writeStack(File target, String stack) {
        try (java.io.FileOutputStream output = new java.io.FileOutputStream(target)) {
            output.write(stack.getBytes(StandardCharsets.UTF_8));
        } catch (Throwable ignored) { }
    }

    private static String safe(String name) {
        return name.replace(':', '_');
    }
}
