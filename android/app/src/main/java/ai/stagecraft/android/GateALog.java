package ai.stagecraft.android;

import android.util.Log;

/** W0 spike 统一日志：所有证据行带 GATEA 前缀，便于 adb logcat 抓取。 */
final class GateALog {
    static final String TAG = "GATEA";

    private GateALog() {}

    static void i(String message) { Log.i(TAG, message); }
    static void w(String message) { Log.w(TAG, message); }
    static void result(String json) { Log.i(TAG, "GATEA_RESULT " + json); }
}
