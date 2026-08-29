package ai.stagecraft.android;

import android.app.Activity;
import android.app.Application;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Bundle;
import android.os.IBinder;
import android.os.Process;
import android.os.ResultReceiver;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * W0 Gate A spike 入口（真机验证用）：自动执行阶段 0 检查序列并导出证据。
 *
 * 检查项（计划阶段 0 + Gate A 硬条件）：
 *  1) 独立 :core 进程 + appassets core-host + 真实 bundle 求值（health/bridge 就绪）；
 *  2) SSE 逐条到达（3 事件间隔投递，非整包缓冲）；
 *  3) 命令 POST 往返（进程内桥时延/回显）与进程内大消息量测；
 *  4) 页面 abort → 上游 socket 有界关闭；
 *  5) kill :core 进程 → 主进程存活、下游有界结束、自动重启后新端点重新握手。
 *
 * 证据：屏幕日志 + logcat(GATEA) + getExternalFilesDir/gatea-report.json。
 */
public class GateASpikeActivity extends Activity {
    private static final String CORE_HOST_URL = "http://127.0.0.1:%d%s";
    private TextView logView;
    private ScrollView scroll;
    private final List<String> screenLog = new ArrayList<>();
    private final List<JSONObject> checks = new ArrayList<>();
    private GateAGatewayServer gateway;
    private GateACoreService.Binder core;
    private volatile JSONObject endpoint;
    private final Object endpointSignal = new Object();
    private long startedAtMillis;

    private final ServiceConnection connection = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            log("service connected, registering callback");
            core = (GateACoreService.Binder) binder;
            core.registerCallback(new ResultReceiver(null) {
                @Override protected void onReceiveResult(int resultCode, Bundle resultData) {
                    if (resultCode == GateACoreService.MSG_ENDPOINT_READY) handleEndpointReady(resultData.getString("summary"));
                    else log("status: " + resultData.getString("summary"));
                }
            });
        }

        @Override public void onServiceDisconnected(ComponentName name) {
            log("service disconnected (core process died?)");
            core = null;
            endpoint = null;
        }

        @Override public void onBindingDied(ComponentName name) {
            log("binding died, rebinding (BIND_AUTO_CREATE restart)");
            core = null;
            endpoint = null;
            unbindService(connection);
            bindCoreService();
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        ProcessGuard.init(Application.getProcessName());
        startedAtMillis = System.currentTimeMillis();
        buildUi();
        startGateway();
        bindCoreService();
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(32, 48, 32, 32);
        TextView title = new TextView(this);
        title.setText("StageCraft Gate A Spike（阶段 0 真机验证）");
        title.setTextSize(16);
        root.addView(title);
        Button rerun = new Button(this);
        rerun.setText("重新运行检查序列");
        rerun.setOnClickListener(view -> runCheckSequence());
        root.addView(rerun);
        logView = new TextView(this);
        logView.setTextIsSelectable(true);
        logView.setTextSize(12);
        scroll = new ScrollView(this);
        scroll.addView(logView);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1f));
        setContentView(root);
    }

    private void startGateway() {
        gateway = new GateAGatewayServer("spike");
        try {
            gateway.start();
            log("gateway listening on 127.0.0.1:" + gateway.getPort());
        } catch (Exception error) {
            log("gateway start FAILED: " + error);
        }
    }

    private void bindCoreService() {
        Intent intent = new Intent(this, GateACoreService.class);
        if (!bindService(intent, connection, Context.BIND_AUTO_CREATE)) {
            log("bindService FAILED");
        } else {
            log("bound :core service (BIND_AUTO_CREATE)");
        }
    }

    private synchronized void handleEndpointReady(String summaryJson) {
        try {
            endpoint = new JSONObject(summaryJson);
            log("endpoint ready: port=" + endpoint.optInt("port") + " pid=" + endpoint.optInt("pid") + " nonce=<native-only>");
            synchronized (endpointSignal) { endpointSignal.notifyAll(); }
        } catch (Exception error) {
            log("endpoint parse failed: " + error);
        }
    }

    private void runCheckSequence() {
        checks.clear();
        new Thread(() -> {
            try {
                awaitEndpoint(30_000);
                checkHealth();
                checkSseRoundtrip();
                checkCommandRoundtrip();
                checkBridgeMeasurements();
                checkClientAbort();
                checkCoreKillAndRestart();
            } catch (Exception error) {
                JSONObject evidence = new JSONObject();
                try { evidence.put("error", String.valueOf(error)); } catch (Exception ignored) { }
                record("sequence", false, evidence);
            }
            finishReport();
        }, "gatea-checks").start();
    }

    private void awaitEndpoint(long timeoutMillis) throws Exception {
        long deadline = System.currentTimeMillis() + timeoutMillis;
        while (endpoint == null) {
            if (System.currentTimeMillis() > deadline) throw new Exception("endpoint not ready within " + timeoutMillis + "ms");
            synchronized (endpointSignal) { endpointSignal.wait(200); }
        }
    }

    private void checkHealth() throws Exception {
        long started = System.currentTimeMillis();
        HttpURLConnection connection = (HttpURLConnection) new URL(String.format(CORE_HOST_URL, gateway.getPort(), "/api/core/health")).openConnection();
        connection.setConnectTimeout(3000);
        connection.setReadTimeout(5000);
        String body = readAll(connection);
        JSONObject health = new JSONObject(body);
        boolean pass = connection.getResponseCode() == 200 && "ready".equals(health.optString("status")) && "1.1".equals(health.optString("protocolVersion"));
        JSONObject evidence = new JSONObject()
            .put("elapsedMs", System.currentTimeMillis() - started)
            .put("status", health.optString("status"))
            .put("protocolVersion", health.optString("protocolVersion"))
            .put("coreBundleVersion", health.optString("coreBundleVersion"))
            .put("coreBundleHash", health.optString("coreBundleHash"))
            .put("measure", health.optJSONObject("measure"));
        record("health-handshake", pass, evidence);
    }

    /** SSE 逐条到达：3 个事件应分批到达（间隔 > 0），且在流关闭前到达（非整包缓冲）。 */
    private void checkSseRoundtrip() throws Exception {
        Socket socket = openSse();
        // 先开订阅，再让 Core 页面发 3 个事件（间隔 300ms）
        postCommand(new JSONObject().put("requestId", "emit-events").put("command", "emit-events").put("count", 3).put("intervalMs", 300));
        long started = System.currentTimeMillis();
        List<Long> arrivals = new ArrayList<>();
        BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
        long deadline = System.currentTimeMillis() + 15_000;
        while (arrivals.size() < 3 && System.currentTimeMillis() < deadline) {
            String line = reader.readLine();
            if (line == null) break;
            if (line.startsWith("data:")) arrivals.add(System.currentTimeMillis() - started);
        }
        socket.close();
        boolean pass = arrivals.size() == 3 && arrivals.get(1) - arrivals.get(0) > 50 && arrivals.get(2) - arrivals.get(1) > 50;
        record("sse-incremental-delivery", pass, new JSONObject()
            .put("arrivalOffsetsMs", new JSONArray(arrivals))
            .put("note", "间隔应≈300ms 且逐条 flush，非连接结束整包"));
    }

    /** 命令 POST 往返：echo 回执 + 进程内桥时延。 */
    private void checkCommandRoundtrip() throws Exception {
        for (int bytes : new int[] {1024, 32_000}) {
            long started = System.currentTimeMillis();
            JSONObject command = new JSONObject()
                .put("requestId", "cmd-" + bytes)
                .put("command", "echo")
                .put("payload", repeat("x", bytes));
            JSONObject receipt = postCommand(command);
            boolean pass = receipt != null && "accepted".equals(receipt.optString("status"))
                && receipt.optJSONObject("echo") != null
                && bytes == receipt.optJSONObject("echo").optInt("payloadBytes");
            record("command-roundtrip-" + bytes, pass, new JSONObject()
                .put("elapsedMs", System.currentTimeMillis() - started)
                .put("bridgeElapsedMs", receipt == null ? -1 : receipt.optLong("bridgeElapsedMs"))
                .put("bodyBytes", receipt == null ? -1 : receipt.optLong("bodyBytes")));
        }
    }

    /** 进程内桥大消息量测：JS→Java evaluateJavascript 结果尺寸 8KB/512KB/2MB。 */
    private void checkBridgeMeasurements() throws Exception {
        for (int bytes : new int[] {8 * 1024, 512 * 1024, 2 * 1024 * 1024}) {
            long started = System.currentTimeMillis();
            JSONObject receipt = postCommand(new JSONObject()
                .put("requestId", "measure-" + bytes)
                .put("command", "measure-eval")
                .put("bytes", bytes));
            long elapsed = System.currentTimeMillis() - started;
            int echoBytes = receipt == null || receipt.optJSONObject("echo") == null ? -1 : receipt.optJSONObject("echo").optInt("payloadBytes");
            record("bridge-eval-result-" + bytes, echoBytes == bytes, new JSONObject()
                .put("elapsedMs", elapsed)
                .put("bridgeElapsedMs", receipt == null ? -1 : receipt.optLong("bridgeElapsedMs"))
                .put("echoBytes", echoBytes)
                .put("note", "JS→Java 大结果（近似 CoreView 尺寸）经进程内桥的时延/尺寸量测"));
        }
    }

    /** abort：读首事件后立即断开客户端；gateway 应在有界时间内关闭上游。 */
    private void checkClientAbort() throws Exception {
        long before = gateway.getUpstreamClosedByClientCount();
        Socket socket = openSse();
        postCommand(new JSONObject().put("requestId", "abort-emit").put("command", "emit-events").put("count", 1).put("intervalMs", 0));
        BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
        long deadline = System.currentTimeMillis() + 10_000;
        while (System.currentTimeMillis() < deadline) {
            String line = reader.readLine();
            if (line == null) break;
            if (line.startsWith("data:")) break;
        }
        long closedAt = System.currentTimeMillis();
        socket.close();
        long deadlineWait = System.currentTimeMillis() + 5_000;
        while (gateway.getUpstreamClosedByClientCount() == before && System.currentTimeMillis() < deadlineWait) Thread.sleep(50);
        boolean pass = gateway.getUpstreamClosedByClientCount() > before;
        long observedWithinMs = System.currentTimeMillis() - closedAt;
        record("client-abort-propagation", pass, new JSONObject()
            .put("upstreamClosedWithinMs", pass ? observedWithinMs : -1)
            .put("upstreamClosedByClientCount", gateway.getUpstreamClosedByClientCount())
            .put("note", "客户端断开后 gateway 立即关闭上游 socket（时间戳见 logcat GATEA）"));
    }

    /** kill：:core 进程被杀 → 下游 SSE 有界结束 + 服务自动重启 + 新端点 + 二次握手。 */
    private void checkCoreKillAndRestart() throws Exception {
        JSONObject oldEndpoint = endpoint;
        Socket stream = openSse();
        postCommand(new JSONObject().put("requestId", "kill-emit").put("command", "emit-events").put("count", 1).put("intervalMs", 0));
        BufferedReader reader = new BufferedReader(new InputStreamReader(stream.getInputStream(), StandardCharsets.UTF_8));
        long deadline = System.currentTimeMillis() + 10_000;
        while (System.currentTimeMillis() < deadline) {
            String line = reader.readLine();
            if (line == null) break;
            if (line.startsWith("data:")) break;
        }
        long killStarted = System.currentTimeMillis();
        Process.killProcess(oldEndpoint.optInt("pid")); // 同 UID，允许 kill
        // 下游应在有界时间内结束（EOF 或异常）
        String streamEnd;
        try {
            streamEnd = reader.readLine() == null ? "eof" : "closed-with-error";
        } catch (Exception error) {
            streamEnd = "exception:" + error.getClass().getSimpleName();
        }
        long streamEndedMs = System.currentTimeMillis() - killStarted;
        stream.close();
        // BIND_AUTO_CREATE 自动重启：等待新端点（port/nonce 更换）
        long restartDeadline = System.currentTimeMillis() + 30_000;
        JSONObject newEndpoint = null;
        while (System.currentTimeMillis() < restartDeadline) {
            JSONObject candidate = endpoint;
            if (candidate != null && candidate.optInt("port") != oldEndpoint.optInt("port")) { newEndpoint = candidate; break; }
            Thread.sleep(100);
        }
        boolean restarted = newEndpoint != null;
        // 主进程存活（本 Activity 仍在运行即是证据）+ 新端点二次握手
        boolean secondHandshake = false;
        if (restarted) {
            try {
                HttpURLConnection connection = (HttpURLConnection) new URL(String.format(CORE_HOST_URL, gateway.getPort(), "/api/core/health")).openConnection();
                connection.setConnectTimeout(3000);
                connection.setReadTimeout(5000);
                JSONObject health = new JSONObject(readAll(connection));
                secondHandshake = "ready".equals(health.optString("status"));
            } catch (Exception error) {
                secondHandshake = false;
            }
        }
        record("core-kill-restart", restarted && secondHandshake, new JSONObject()
            .put("downstreamEndedWithinMs", streamEndedMs)
            .put("downstreamEnd", streamEnd)
            .put("restarted", restarted)
            .put("newPort", restarted ? newEndpoint.optInt("port") : -1)
            .put("secondHandshakeReady", secondHandshake)
            .put("mainProcessAlive", true));
    }

    private Socket openSse() throws Exception {
        awaitEndpoint(30_000);
        Socket socket = new Socket(InetAddress.getLoopbackAddress(), gateway.getPort());
        OutputStream output = socket.getOutputStream();
        output.write(("GET /api/core/events HTTP/1.1\r\nhost: 127.0.0.1\r\naccept: text/event-stream\r\nconnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        output.flush();
        return socket;
    }

    private JSONObject postCommand(JSONObject command) throws Exception {
        awaitEndpoint(30_000);
        HttpURLConnection connection = (HttpURLConnection) new URL(String.format(CORE_HOST_URL, gateway.getPort(), "/api/core/commands")).openConnection();
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.setConnectTimeout(3000);
        connection.setReadTimeout(20_000);
        byte[] body = command.toString().getBytes(StandardCharsets.UTF_8);
        connection.setFixedLengthStreamingMode(body.length);
        connection.setRequestProperty("content-type", "application/json");
        connection.getOutputStream().write(body);
        String response = readAll(connection);
        return new JSONObject(response);
    }

    private static String readAll(HttpURLConnection connection) throws Exception {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                connection.getResponseCode() < 400 ? connection.getInputStream() : connection.getErrorStream(), StandardCharsets.UTF_8))) {
            StringBuilder builder = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) builder.append(line).append('\n');
            return builder.toString();
        }
    }

    private static String repeat(String unit, int bytes) {
        StringBuilder builder = new StringBuilder(bytes);
        while (builder.length() < bytes) builder.append(unit);
        return builder.substring(0, bytes);
    }

    private synchronized void record(String name, boolean pass, JSONObject evidence) {
        JSONObject check = new JSONObject();
        try {
            check.put("name", name).put("pass", pass).put("evidence", evidence);
        } catch (Exception ignored) { }
        checks.add(check);
        log((pass ? "PASS " : "FAIL ") + name + " — " + evidence);
    }

    private void finishReport() {
        JSONObject report = new JSONObject();
        try {
            report.put("device", android.os.Build.MODEL + " (API " + android.os.Build.VERSION.SDK_INT + ")");
            report.put("kind", "w0-gatea-spike");
            report.put("startedAt", java.time.Instant.ofEpochMilli(startedAtMillis).toString());
            report.put("finishedAt", java.time.Instant.now().toString());
            report.put("checks", new JSONArray(checks));
            boolean allPass = true;
            for (JSONObject check : checks) allPass &= check.optBoolean("pass");
            report.put("allPass", allPass);
        } catch (Exception ignored) { }
        GateALog.result(report.toString());
        try {
            File output = new File(getExternalFilesDir(null), "gatea-report.json");
            java.io.FileWriter writer = new java.io.FileWriter(output);
            writer.write(report.toString(2));
            writer.close();
            log("report written: " + output.getAbsolutePath());
        } catch (Exception error) {
            log("report write FAILED: " + error);
        }
    }

    private void log(String message) {
        String stamped = java.time.LocalTime.now() + "  " + message;
        GateALog.i(stamped);
        runOnUiThread(() -> {
            screenLog.add(stamped);
            if (screenLog.size() > 200) screenLog.remove(0);
            logView.setText(String.join("\n", screenLog));
            scroll.post(() -> scroll.fullScroll(View.FOCUS_DOWN));
        });
    }

    @Override
    protected void onDestroy() {
        try { unbindService(connection); } catch (Exception ignored) { }
        if (gateway != null) gateway.stop();
        super.onDestroy();
    }
}
