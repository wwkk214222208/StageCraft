package ai.stagecraft.android;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/**
 * W0 spike 统一日志：所有证据行带 GATEA 前缀，便于 adb logcat 抓取。
 * 华为设备会抑制三方应用 logcat——因此每行同步落盘到
 * files/gatea-log-<进程名>.txt（评审：非空日志证据必须不依赖 logcat 存在）。
 */
final class GateALog {
    static final String TAG = "GATEA";

    private static volatile File logFile;
    private static volatile File externalLogFile;
    private static volatile File externalDir;

    private GateALog() {}

    /** 进程入口调用一次：绑定本进程的日志落盘文件。内部 + 外部双写（外部可 adb pull）。 */
    static void init(Context context) {
        String suffix = GateACrashGuard.processName().replace(':', '_');
        logFile = new File(context.getFilesDir(), "gatea-log-" + suffix + ".txt");
        File external = context.getExternalFilesDir(null);
        if (external != null) {
            externalDir = external;
            externalLogFile = new File(external, "gatea-log-" + suffix + ".txt");
        }
    }

    static void i(String message) {
        Log.i(TAG, message);
        append(message);
    }

    static void w(String message) {
        Log.w(TAG, message);
        append(message);
    }

    static void result(String json) {
        Log.i(TAG, "GATEA_RESULT " + json);
        append("GATEA_RESULT " + json);
    }

    private static synchronized void append(String message) {
        String line = System.currentTimeMillis() + "  " + message + "\n";
        appendTo(logFile, line);
        appendTo(externalLogFile, line);
    }

    /**
     * 每轮序列开始时重置日志（评审 R5：必须覆盖 :core 进程的日志文件）。
     * 两个进程的日志文件名都可由主进程名派生：
     *   ai.stagecraft.android          （主进程）
     *   ai.stagecraft.android:core     （:core 进程 → 文件名中 : 替换为 _）
     * 外部存储（R6 修正：必须用 getExternalFilesDir，此前误用内部目录导致外部证据未重置）
     * 与内部文件一并重置；写入 run-reset 分隔行。
     */
    static void resetExternalLogs() {
        String mainName = GateACrashGuard.processName();
        java.util.List<String> processNames = java.util.Arrays.asList(mainName, mainName + ":core");
        File external = externalDir;
        for (String processName : processNames) {
            String suffix = processName.replace(':', '_');
            if (external != null) truncate(new File(external, "gatea-log-" + suffix + ".txt"));
            truncate(new File(logFile == null ? null : logFile.getParentFile(), "gatea-log-" + suffix + ".txt"));
        }
    }

    private static void truncate(File target) {
        if (target == null) return;
        String resetLine = "--- run reset " + System.currentTimeMillis() + " ---" + String.valueOf((char) 10);
        try (FileOutputStream output = new FileOutputStream(target, false)) {
            output.write(resetLine.getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) { }
    }

    private static void appendTo(File target, String line) {
        if (target == null) return;
        try (FileOutputStream output = new FileOutputStream(target, true)) {
            output.write(line.getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) { }
    }
}
