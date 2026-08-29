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

    private GateALog() {}

    /** 进程入口调用一次：绑定本进程的日志落盘文件。 */
    static void init(Context context) {
        String suffix = GateACrashGuard.processName().replace(':', '_');
        logFile = new File(context.getFilesDir(), "gatea-log-" + suffix + ".txt");
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
        File target = logFile;
        if (target == null) return;
        try (FileOutputStream output = new FileOutputStream(target, true)) {
            output.write((System.currentTimeMillis() + "  " + message + "\n").getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) { }
    }
}
