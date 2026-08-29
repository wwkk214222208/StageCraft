package ai.stagecraft.android;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.os.Bundle;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.IBinder;
import android.os.Process;
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
    private ICoreControl core;
    private volatile JSONObject endpoint;
    /** :core 上报 fail(renderer_gone) 的时刻（onRenderProcessGone 证据，评审第 4 条）。 */
    private volatile String rendererGoneStatusAt;
    private volatile String runId;
    private final java.util.concurrent.atomic.AtomicBoolean sequenceRunning = new java.util.concurrent.atomic.AtomicBoolean(false);
    /** 恢复视图（评审：正式恢复页为 W6 交付；spike 级恢复链路演示 + 可操作性断言）。 */
    private LinearLayout recoveryPanel;
    private TextView recoveryStatusText;
    private Button recoveryRestartButton;
    private Button recoveryRemoteEntryButton;
    private volatile boolean remoteEntryOpened;
    private final java.util.concurrent.atomic.AtomicLong rebindDedupedCount = new java.util.concurrent.atomic.AtomicLong();
    private final Object endpointSignal = new Object();
    private long startedAtMillis;

    private final ServiceConnection connection = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            log("service connected (cross-process proxy), registering callback");
            rebindPending.set(false); // 绑定完成：新一轮死亡通知方可触发重绑
            core = ICoreControl.Stub.asInterface(binder);
            try {
                // 客户端 death recipient（评审第 1 条）：RemoteCallbackList 只覆盖服务端，客户端必须 linkToDeath
                binder.linkToDeath(() -> runOnUiThread(() -> {
                    log("binder death recipient fired");
                    scheduleRebindOnce("death-recipient");
                }), 0);
                core.registerCallback(new ICoreControlCallback.Stub() {
                    @Override public void onStatus(String summaryJson) {
                        if (summaryJson != null && summaryJson.contains("renderer_gone")) {
                            rendererGoneStatusAt = java.time.LocalTime.now().toString();
                        }
                        // 恢复视图由 Core 故障状态自动驱动（评审 R5：不得由测试手动 show）
                        if (summaryJson != null && (summaryJson.contains("renderer_gone") || summaryJson.contains("\"status\":\"failed\""))) {
                            runOnUiThread(() -> showRecoveryView());
                        }
                        log("status: " + summaryJson);
                    }

                    @Override public void onEndpointReady(String endpointJson) {
                        handleEndpointReady(endpointJson);
                    }
                });
            } catch (Exception error) {
                log("registerCallback FAILED: " + error);
            }
        }

        @Override public void onServiceDisconnected(ComponentName name) {
            log("service disconnected (core process died?)");
            core = null;
            endpoint = null;
            // Core 不可用 = 故障状态：恢复视图自动驱动（评审 R6 P1-1：普通 kill 时 Core 无机会
            // 发送 status=failed，断连事件本身就是驱动源；测试不得手动 show）
            runOnUiThread(() -> showRecoveryView());
            scheduleRebindOnce("onServiceDisconnected");
        }

        @Override public void onBindingDied(ComponentName name) {
            log("binding died");
            core = null;
            endpoint = null;
            scheduleRebindOnce("onBindingDied");
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        GateACrashGuard.install(this);
        ProcessGuard.init(ProcessGuard.currentProcessName());
        startedAtMillis = System.currentTimeMillis();
        buildUi();
        startGateway();
        bindCoreService();
        // 打开即自动运行（与 GATEA-DEVICE-GUIDE 一致）；端点未就绪时序列内部等待
        runCheckSequence();
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
        // 恢复视图（评审：正式恢复页为 W6 交付；spike 级恢复链路演示 + 可操作性断言）
        recoveryPanel = new LinearLayout(this);
        recoveryPanel.setOrientation(LinearLayout.VERTICAL);
        recoveryPanel.setPadding(32, 32, 32, 32);
        recoveryPanel.setVisibility(View.GONE);
        TextView recoveryTitle = new TextView(this);
        recoveryTitle.setText("Core 不可用 — 恢复视图");
        recoveryTitle.setTextSize(15);
        recoveryPanel.addView(recoveryTitle);
        recoveryStatusText = new TextView(this);
        recoveryPanel.addView(recoveryStatusText);
        recoveryRestartButton = new Button(this);
        recoveryRestartButton.setText("重新启动 Core");
        recoveryRestartButton.setOnClickListener(view -> restartCoreFromRecovery());
        recoveryPanel.addView(recoveryRestartButton);
        recoveryRemoteEntryButton = new Button(this);
        recoveryRemoteEntryButton.setText("远程模式入口");
        recoveryRemoteEntryButton.setOnClickListener(view -> {
            remoteEntryOpened = true;
            Intent remote = new Intent(this, MainActivity.class);
            remote.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            remote.putExtra("gatea_entry", "remote-entry");
            startActivity(remote);
        });
        recoveryPanel.addView(recoveryRemoteEntryButton);
        root.addView(recoveryPanel, new LinearLayout.LayoutParams(-1, 0, 1f));
        setContentView(root);
    }

    private void showRecoveryView() {
        runOnUiThread(() -> {
            recoveryStatusText.setText("Core 不可用（pid=" + (endpoint == null ? -1 : endpoint.optInt("pid")) + "）。可选择：重新启动 Core，或切换远程模式。");
            recoveryPanel.setVisibility(View.VISIBLE);
            scroll.setVisibility(View.GONE);
        });
    }

    private void hideRecoveryView() {
        runOnUiThread(() -> {
            recoveryPanel.setVisibility(View.GONE);
            scroll.setVisibility(View.VISIBLE);
        });
    }

    /** 恢复视图"重新启动 Core"：杀当前 :core 进程（同 UID，debug-only），绑定死亡自动重建。 */
    private void restartCoreFromRecovery() {
        JSONObject current = endpoint;
        if (current != null && current.optInt("pid") > 0) {
            GateALog.i("recovery restart: killing core pid=" + current.optInt("pid"));
            android.os.Process.killProcess(current.optInt("pid"));
        } else {
            scheduleRebindOnce("recovery-restart");
        }
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

    /**
     * 幂等重绑守卫（评审第 1 条）：death recipient / onServiceDisconnected / onBindingDied
     * 可能对同一次死亡先后触发——同一轮只执行一次 unbind+rebind，不重复迁移状态。
     */
    private final java.util.concurrent.atomic.AtomicBoolean rebindPending = new java.util.concurrent.atomic.AtomicBoolean(false);

    private void scheduleRebindOnce(String source) {
        if (!rebindPending.compareAndSet(false, true)) {
            rebindDedupedCount.incrementAndGet();
            log("rebind already pending, deduped source=" + source);
            return;
        }
        log("rebind scheduled (source=" + source + ", BIND_AUTO_CREATE restart)");
        new Thread(() -> {
            try { Thread.sleep(300); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
            try { unbindService(connection); } catch (Exception ignored) { }
            core = null;
            endpoint = null;
            // rebindPending 在 onServiceConnected 后才清零（评审：清零过早存在重复重绑窗口）
            runOnUiThread(() -> bindCoreService());
        }, "gatea-rebind").start();
    }

    private synchronized void handleEndpointReady(String summaryJson) {
        try {
            endpoint = new JSONObject(summaryJson);
            // 关键链路：把 :core 端点交给 gateway（nonce 只在原生层流转，不进页面）
            gateway.setCoreEndpoint(endpoint.optInt("port"), endpoint.optString("nonce"));
            log("endpoint ready: port=" + endpoint.optInt("port") + " pid=" + endpoint.optInt("pid") + " nonce=<native-only>");
            synchronized (endpointSignal) { endpointSignal.notifyAll(); }
        } catch (Exception error) {
            log("endpoint parse failed: " + error);
        }
    }

    private void runCheckSequence() {
        // P0 隔离：并发序列会互相 kill/rebind Core、污染证据——同一时刻只允许一个序列
        if (!sequenceRunning.compareAndSet(false, true)) {
            log("sequence already running, new run rejected");
            return;
        }
        checks.clear();
        runId = java.util.UUID.randomUUID().toString().substring(0, 8);
        // 防陈旧证据：序列开始即重置报告文件 + 删除上一轮 renderer 证据 + 截断每轮日志
        try {
            File stale = new File(getExternalFilesDir(null), "gatea-report.json");
            try (java.io.FileOutputStream output = new java.io.FileOutputStream(stale)) {
                output.write(("{\"status\":\"running\",\"runId\":\"" + runId + "\"}").getBytes(StandardCharsets.UTF_8));
            }
            new File(getExternalFilesDir(null), "gatea-renderer-gone.txt").delete();
            GateALog.resetExternalLogs();
        } catch (Exception ignored) { }
        new Thread(() -> {
            try {
                runCheck("endpoint-ready", () -> awaitEndpoint(30_000));
                // 逐项容错：单项失败不中断其余检查（Gate A 需要完整证据面）
                runCheck("health-handshake", this::checkHealth);
                runCheck("sse-incremental-delivery", this::checkSseRoundtrip);
                runCheck("command-roundtrip", this::checkCommandRoundtrip);
                runCheck("bridge-measurements", this::checkBridgeMeasurements);
                runCheck("client-abort-propagation", this::checkClientAbort);
                runCheck("core-kill-restart", this::checkCoreKillAndRestart);
                runCheck("renderer-crash-recovery", this::checkRendererCrash);
                runCheck("recovery-chain", this::checkRecoveryChain);
                finishReport();
            } finally {
                sequenceRunning.set(false);
            }
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
        int code = connection.getResponseCode();
        String body = readAll(connection);
        JSONObject health = new JSONObject(body);
        boolean pass = code == 200 && "ready".equals(health.optString("status")) && "1.1".equals(health.optString("protocolVersion"));
        JSONObject evidence = new JSONObject()
            .put("elapsedMs", System.currentTimeMillis() - started)
            .put("httpCode", code)
            .put("bodyPrefix", body.substring(0, Math.min(200, body.length())))
            .put("gatewayProxied", gateway.getProxiedCount())
            .put("status", health.optString("status"))
            .put("protocolVersion", health.optString("protocolVersion"))
            .put("coreBundleVersion", health.optString("coreBundleVersion"))
            .put("coreBundleHash", health.optString("coreBundleHash"))
            .put("binderMaxPayloadBytes", health.optInt("binderMaxPayloadBytes", -1))
            .put("dataServerStats", health.optJSONObject("dataServerStats"))
            .put("measure", health.optJSONObject("measure"));
        record("health-handshake", pass, evidence);
    }

    /** SSE 逐条到达：3 个事件应分批到达（间隔 > 0），且在流关闭前到达（非整包缓冲）。 */
    private void checkSseRoundtrip() throws Exception {
        Socket socket = openSse();
        // 等数据服务回执 ": connected"（订阅已生效），再派发事件——消除 setTimeout(0) 竞态
        BufferedReader headerReader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
        long confirmDeadline = System.currentTimeMillis() + 10_000;
        while (System.currentTimeMillis() < confirmDeadline) {
            String line = headerReader.readLine();
            if (line == null) throw new Exception("sse stream closed before subscription confirmation");
            if (line.startsWith(": connected")) break;
        }
        // 先开订阅，再让 Core 页面发 3 个事件（间隔 300ms）——原始 socket POST 旁路 okhttp
        String postResult = rawPost(new JSONObject().put("requestId", "emit-events").put("command", "emit-events").put("count", 3).put("intervalMs", 300));
        log("rawPost emit-events: " + postResult.substring(0, Math.min(220, postResult.length())));
        long started = System.currentTimeMillis();
        List<Long> arrivals = new ArrayList<>();
        List<String> rawEvents = new ArrayList<>();
        BufferedReader reader = headerReader; // 同一 socket 流，续读事件
        long deadline = System.currentTimeMillis() + 15_000;
        while (arrivals.size() < 3 && System.currentTimeMillis() < deadline) {
            String line = reader.readLine();
            if (line == null) break;
            if (line.startsWith("data:")) {
                arrivals.add(System.currentTimeMillis() - started);
                rawEvents.add(line.length() > 120 ? line.substring(0, 120) : line);
            }
        }
        socket.close();
        boolean pass = arrivals.size() == 3 && arrivals.get(1) - arrivals.get(0) > 50 && arrivals.get(2) - arrivals.get(1) > 50;
        record("sse-incremental-delivery", pass, new JSONObject()
            .put("arrivalOffsetsMs", new JSONArray(arrivals))
            .put("rawEvents", new JSONArray(rawEvents))
            .put("note", "间隔应≈300ms 且逐条 flush，非连接结束整包；原始事件前缀随报告存档"));
    }

    /** 命令 POST 往返：echo 回执 + 进程内桥时延。 */
    private void checkCommandRoundtrip() throws Exception {
        for (int bytes : new int[] {1024, 32_000}) {
            long started = System.currentTimeMillis();
            JSONObject command = new JSONObject()
                .put("requestId", "cmd-" + bytes)
                .put("command", "echo")
                .put("payload", repeat("x", bytes));
            long proxiedBefore = gateway.getProxiedCount();
            // 判定只认 gateway 路径（评审第 2 条：direct 响应不能作为通过依据）
            String viaGateway = rawPost(command, false);
            int gatewayStatusLineEnd = viaGateway.indexOf("\r\n");
            String statusLine = gatewayStatusLineEnd < 0 ? viaGateway : viaGateway.substring(0, gatewayStatusLineEnd);
            int bodyAt = viaGateway.indexOf("\r\n\r\n");
            String body = bodyAt < 0 ? "" : viaGateway.substring(bodyAt + 4);
            JSONObject receipt = new JSONObject(body);
            long proxiedAfter = gateway.getProxiedCount();
            // direct 仅作对照诊断，不参与判定
            String direct = rawPost(command, true);
            log("viaGateway=[" + statusLine + "] direct=[" + direct.substring(0, Math.min(120, direct.length())) + "]");
            boolean pass = receipt != null && "accepted".equals(receipt.optString("status"))
                && receipt.optJSONObject("echo") != null
                && bytes == receipt.optJSONObject("echo").optInt("payloadBytes");
            boolean pathProven = statusLine.contains(" 200 ") && proxiedAfter > proxiedBefore;
            record("command-roundtrip-" + bytes, pass && pathProven, new JSONObject()
                .put("elapsedMs", System.currentTimeMillis() - started)
                .put("gatewayStatusLine", statusLine)
                .put("gatewayProxiedDelta", proxiedAfter - proxiedBefore)
                .put("bridgeElapsedMs", receipt.optLong("bridgeElapsedMs"))
                .put("bodyBytes", receipt.optLong("bodyBytes"))
                .put("note", "判定只认 gateway 路径（status 200 + 代理计数增量）；direct 仅对照"));
        }
    }

    /** 进程内桥大消息量测：JS→Java evaluateJavascript 结果尺寸 8KB/512KB/2MB。 */
    private void checkBridgeMeasurements() throws Exception {
        for (int bytes : new int[] {8 * 1024, 512 * 1024, 2 * 1024 * 1024}) {
            long started = System.currentTimeMillis();
            String raw = rawPost(new JSONObject()
                .put("requestId", "measure-" + bytes)
                .put("command", "measure-eval")
                .put("bytes", bytes));
            JSONObject receipt = new JSONObject(raw.substring(raw.indexOf('{')));
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
        // 发多个间隔事件：close 之后紧跟的下一个事件写入必然触发 broken-pipe 检测
        // （若只发 1 个 interval=0 的事件，事件会在 close 前被消费，检测要等 10s 心跳）
        postCommand(new JSONObject().put("requestId", "abort-emit").put("command", "emit-events").put("count", 6).put("intervalMs", 300));
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
        while (gateway.getUpstreamClosedByClientCount() == before && System.currentTimeMillis() < deadlineWait) Thread.sleep(30);
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
        // 新端点二次握手
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
        // 有界结束硬断言（评审第 5 条）：1ms~3000ms 之外不算通过
        boolean boundedEnd = streamEndedMs <= 3_000;
        // 主进程 + 正式 MainActivity 在 kill 后仍可打开（评审第 3 条；恢复页/远程入口归 W6 验收）
        boolean mainActivityOk = false;
        boolean mainActivityAtTop = false;
        long mainLaunchStarted = System.currentTimeMillis();
        try {
            Intent mainIntent = new Intent(this, MainActivity.class);
            mainIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(mainIntent);
            Thread.sleep(2_500);
            mainActivityOk = true;
            // 栈顶验证：全部任务中本应用顶部 Activity 必须是 MainActivity（重试至 5s，评审第 3 条）
            android.app.ActivityManager manager = (android.app.ActivityManager) getSystemService(Context.ACTIVITY_SERVICE);
            long topDeadline = System.currentTimeMillis() + 5_000;
            while (!mainActivityAtTop && System.currentTimeMillis() < topDeadline && manager != null) {
                List<android.app.ActivityManager.RunningTaskInfo> tasks = manager.getRunningTasks(10);
                for (android.app.ActivityManager.RunningTaskInfo task : tasks) {
                    if (task.topActivity != null && task.baseActivity != null
                        && task.baseActivity.getPackageName().equals(getPackageName())
                        && MainActivity.class.getName().equals(task.topActivity.getClassName())) {
                        mainActivityAtTop = true;
                        break;
                    }
                }
                if (!mainActivityAtTop) Thread.sleep(200);
            }
            // 回到 spike 界面继续
            startActivity(new Intent(this, GateASpikeActivity.class));
        } catch (Exception error) {
            mainActivityOk = false;
        }
        long mainLaunchMs = System.currentTimeMillis() - mainLaunchStarted;
        record("core-kill-restart", restarted && secondHandshake && boundedEnd && mainActivityOk && mainActivityAtTop, new JSONObject()
            .put("downstreamEndedWithinMs", streamEndedMs)
            .put("boundedEndAssert", "<=3000ms")
            .put("downstreamEnd", streamEnd)
            .put("restarted", restarted)
            .put("newPort", restarted ? newEndpoint.optInt("port") : -1)
            .put("secondHandshakeReady", secondHandshake)
            .put("mainProcessAlive", true)
            .put("mainActivityLaunchVerified", mainActivityOk)
            .put("mainActivityAtTop", mainActivityAtTop)
            .put("mainActivityLaunchMs", mainLaunchMs)
            .put("recoveryPageAndRemoteEntry", "deferred-to-W6（恢复页/远程入口 UI 属 W6 交付；此处验证主 Activity 栈顶打开与主进程存活）"));
    }

    /** 恢复链验证（评审：恢复页可见/远程入口可用/Core 重启重连）。所有视图交互均在 UI 线程。 */
    private void checkRecoveryChain() throws Exception {
        awaitEndpoint(30_000);
        // 0. 状态清理（评审 R6 P1-1）：明确隐藏恢复视图并清空上一项测试残留，
        //    确认面板 GONE 后，本次 kill 触发的显示才能作为因果证据
        runOnUiThread(() -> recoveryPanel.setVisibility(View.GONE));
        rendererGoneStatusAt = null;
        long preHideDeadline = System.currentTimeMillis() + 3_000;
        boolean preStateGone = false;
        while (System.currentTimeMillis() < preHideDeadline) {
            final boolean[] gone = new boolean[1];
            runOnUiThread(() -> gone[0] = recoveryPanel.getVisibility() == View.GONE);
            Thread.sleep(200);
            if (gone[0]) { preStateGone = true; break; }
        }
        // 1. 杀 :core → 恢复视图必须由故障状态自动驱动出现：
        //    普通 kill 时 Core 无机会发送 status=failed，断连事件（onServiceDisconnected）
        //    即为驱动源；记录从 kill 到自动显示的时延
        JSONObject dead = endpoint;
        long killedAt = System.currentTimeMillis();
        android.os.Process.killProcess(dead.optInt("pid"));
        long showDeadline = killedAt + 10_000;
        final boolean[] panelVisible = new boolean[1];
        final String[] statusText = new String[1];
        long autoShownAt = 0;
        while (System.currentTimeMillis() < showDeadline && autoShownAt == 0) {
            final long[] shown = new long[1];
            runOnUiThread(() -> {
                shown[0] = recoveryPanel.getVisibility() == View.VISIBLE ? System.currentTimeMillis() : 0;
            });
            Thread.sleep(200);
            if (shown[0] > 0) autoShownAt = shown[0];
            runOnUiThread(() -> {
                panelVisible[0] = recoveryPanel.getVisibility() == View.VISIBLE;
                statusText[0] = recoveryStatusText.getText().toString();
            });
        }
        Thread.sleep(200);
        // 2. 远程入口可操作：UI 线程点击 → MainActivity(mode=remote) 打开、实际加载远程页并到栈顶
        //    （评审 R5：仅栈顶不足以证明——同时校验文件日志中 mode=remote 的 WebView 加载记录）
        final long[] remoteClickAt = new long[1];
        runOnUiThread(() -> {
            recoveryRemoteEntryButton.performClick();
            remoteClickAt[0] = System.currentTimeMillis();
        });
        long deadline = System.currentTimeMillis() + 8_000;
        boolean remoteEntryAtTop = false;
        while (System.currentTimeMillis() < deadline && !remoteEntryAtTop) {
            android.app.ActivityManager manager = (android.app.ActivityManager) getSystemService(Context.ACTIVITY_SERVICE);
            if (manager != null) {
                for (android.app.ActivityManager.RunningTaskInfo task : manager.getRunningTasks(10)) {
                    if (task.topActivity != null && task.baseActivity != null
                        && task.baseActivity.getPackageName().equals(getPackageName())
                        && MainActivity.class.getName().equals(task.topActivity.getClassName())) {
                        remoteEntryAtTop = true;
                        break;
                    }
                }
            }
            if (!remoteEntryAtTop) Thread.sleep(200);
        }
        long pageDeadline = System.currentTimeMillis() + 8_000;
        boolean remotePageLoaded = false;
        while (System.currentTimeMillis() < pageDeadline && !remotePageLoaded) {
            // page-ready 证据必须晚于本轮远程入口点击（runId 隔离同类校验，评审 R6 P1-2）
            String mainLog = readMainProcessLog();
            for (String line : mainLog.split("\n")) {
                if (line.contains("main webview page ready") && line.contains("mode=remote")) {
                    String millis = line.split("  ")[0];
                    if (millis.matches("\\d+") && Long.parseLong(millis) > remoteClickAt[0]) {
                        remotePageLoaded = true;
                        break;
                    }
                }
            }
            if (!remotePageLoaded) Thread.sleep(300);
        }
        // 3. 回到恢复视图 → 点击重新启动 Core → Core 重启 → 页面重连（ready）
        runOnUiThread(() -> {
            startActivity(new Intent(this, GateASpikeActivity.class));
            recoveryPanel.setVisibility(View.VISIBLE);
        });
        Thread.sleep(1_000);
        runOnUiThread(() -> recoveryRestartButton.performClick());
        long restartDeadline = System.currentTimeMillis() + 30_000;
        boolean coreRestartedAgain = false;
        while (System.currentTimeMillis() < restartDeadline) {
            JSONObject candidate = endpoint;
            if (candidate != null && candidate.optInt("pid") != dead.optInt("pid") && candidate.optInt("pid") > 0) {
                try {
                    HttpURLConnection connection = (HttpURLConnection) new URL(String.format(CORE_HOST_URL, gateway.getPort(), "/api/core/health")).openConnection();
                    connection.setConnectTimeout(3000);
                    connection.setReadTimeout(5000);
                    if ("ready".equals(new JSONObject(readAll(connection)).optString("status"))) {
                        coreRestartedAgain = true;
                        break;
                    }
                } catch (Exception retry) { /* 未就绪，继续轮询 */ }
            }
            Thread.sleep(300);
        }
        hideRecoveryView();
        boolean pass = panelVisible[0] && statusText[0].contains("Core 不可用") && remoteEntryAtTop && remotePageLoaded && coreRestartedAgain && autoShownAt > 0;
        record("recovery-chain", pass, new JSONObject()
            .put("recoveryViewVisible", panelVisible[0])
            .put("statusTextShown", statusText[0].contains("Core 不可用"))
            .put("remoteEntryAtTop", remoteEntryAtTop)
            .put("remotePageLoaded", remotePageLoaded)
            .put("recoveryAutoShowLatencyMs", autoShownAt == 0 ? -1 : autoShownAt - killedAt)
            .put("preStateGone", preStateGone)
            .put("coreRestartedAndReconnected", coreRestartedAgain)
            .put("note", "恢复页正式 UI 为 W6 交付；本项验证 spike 级恢复链路（状态可见/重启可操作/远程入口实际加载远程页/重连就绪）"));
    }

    /**
     * renderer crash 实测（Gate A 硬条件，评审第 4 条）：沙箱渲染进程运行在 isolated UID 下
     * （应用与 adb shell kill 均 EPERM，真机实测），唯一可行路径是经页面桥下发 commit-OOM——
     * 渲染进程内提交物理内存直到 Chromium 自行终止渲染进程 → onRenderProcessGone →
     * 服务 fail(renderer_gone) + 自杀 → binding died → rebind → 新端点二次握手全周期。
     * 显式标注为替代测法（GATE-A-LOW-PERMISSION §3 批准的是 :core 自杀钩子；本项替代测法
     * 需架构 AI 追认），证据含 onRenderProcessGone 时间戳、旧/新端点与端口变化时刻。
     */
    private void checkRendererCrash() throws Exception {
        awaitEndpoint(30_000);
        JSONObject oldEndpoint = endpoint;
        long oldCoreStartedAt = oldEndpoint == null ? 0 : 0; // 端点不含 startedAt，另经 status 摘要获取
        long dispatchedAt = System.currentTimeMillis();
        // 真正触发：经 gateway 下发 crash-renderer 命令（页内 commit-OOM）
        String raw = rawPost(new JSONObject()
            .put("requestId", "crash-renderer")
            .put("command", "crash-renderer"), false);
        log("crash-renderer dispatched, response=[" + raw.substring(0, Math.min(140, raw.length())) + "]");
        // 等 onRenderProcessGone → 服务 fail(renderer_gone)/自杀 → binding died → rebind → 新端点
        long deadline = System.currentTimeMillis() + 30_000;
        JSONObject newEndpoint = null;
        String goneStatusAt = null;
        while (System.currentTimeMillis() < deadline) {
            String captured = rendererGoneStatusAt;
            if (captured != null && goneStatusAt == null) goneStatusAt = captured;
            JSONObject candidate = endpoint;
            if (candidate != null && candidate.optInt("port") != oldEndpoint.optInt("port")) { newEndpoint = candidate; break; }
            Thread.sleep(200);
        }
        boolean restarted = newEndpoint != null;
        boolean secondHandshake = false;
        if (restarted) {
            try {
                HttpURLConnection connection = (HttpURLConnection) new URL(String.format(CORE_HOST_URL, gateway.getPort(), "/api/core/health")).openConnection();
                connection.setConnectTimeout(3000);
                connection.setReadTimeout(5000);
                secondHandshake = "ready".equals(new JSONObject(readAll(connection)).optString("status"));
            } catch (Exception error) {
                secondHandshake = false;
            }
        }
        // 权威证据：:core 在 onRenderProcessGone 处理路径内同步落盘的文件（与 oneway 广播竞态无关）
        // 校验（评审 P1）：PID 必须等于本轮旧端点 PID（防上一轮残留文件误判）；
        // 时间必须晚于本轮 dispatch（旧文件在序列开始时已删除，此处为双保险）
        String goneFileContent = readRendererGoneEvidence();
        boolean renderGoneConfirmed = false;
        String gonePid = null;
        if (goneFileContent != null && goneFileContent.contains("renderer_gone")) {
            try {
                JSONObject gone = new JSONObject(goneFileContent);
                gonePid = gone.optString("pid");
                String oldPid = String.valueOf(oldEndpoint == null ? -1 : oldEndpoint.optInt("pid"));
                boolean pidMatches = oldPid.equals(gonePid);
                // 统一 UTC 比较（SimpleDateFormat 默认本地时区会错判）
                java.time.Instant goneInstant = java.time.Instant.parse(gone.optString("at"));
                java.time.Instant dispatchedInstant = java.time.Instant.ofEpochMilli(dispatchedAt);
                boolean afterDispatch = goneInstant.isAfter(dispatchedInstant);
                renderGoneConfirmed = pidMatches && afterDispatch;
            } catch (Exception ignored) { }
        }
        JSONObject evidence = new JSONObject()
            .put("method", "WebViewRenderProcess.terminate()（API 29+ 官方路径；替代测法需追认，isolated UID 下应用/shell kill 均 EPERM 实测；fallback 页内 commit-OOM）")
            .put("dispatchedResponse", raw.substring(0, Math.min(140, raw.length())))
            .put("serviceRenderGoneEvidence", goneFileContent == null ? "missing" : goneFileContent)
            .put("gonePidMatchesOldEndpoint", renderGoneConfirmed)
            .put("gonePid", gonePid == null ? "missing" : gonePid)
            .put("oldPid", oldEndpoint == null ? -1 : oldEndpoint.optInt("pid"))
            .put("renderProcessGoneAt", rendererGoneStatusAt == null ? "not-observed" : rendererGoneStatusAt)
            .put("oldPort", oldEndpoint == null ? -1 : oldEndpoint.optInt("port"))
            .put("newPort", newEndpoint == null ? -1 : newEndpoint.optInt("port"))
            .put("portChangedMs", newEndpoint == null ? -1 : System.currentTimeMillis() - dispatchedAt)
            .put("restarted", restarted)
            .put("secondHandshakeReady", secondHandshake);
        record("renderer-crash-recovery", restarted && secondHandshake && renderGoneConfirmed, evidence);
        // 清除残留状态：本检查触发的恢复视图不得残留到下一项检查（评审 R6 P1-1）
        hideRecoveryView();
        Thread.sleep(800);
    }

    /** 读取主进程文件日志（验证远程页实际加载，评审 R5）。 */
    private String readMainProcessLog() {
        try {
            File log = new File(getFilesDir(), "gatea-log-" + getPackageName() + ".txt");
            if (!log.exists()) return "";
            try (java.io.BufferedReader reader = new java.io.BufferedReader(new java.io.FileReader(log))) {
                StringBuilder builder = new StringBuilder();
                char[] buffer = new char[65536];
                int read;
                while ((read = reader.read(buffer)) >= 0) builder.append(buffer, 0, read);
                return builder.toString();
            }
        } catch (Exception error) {
            return "";
        }
    }

    /** 读取 :core 落盘的 renderer-gone 证据文件（与主进程 oneway 竞态无关）。 */
    private String readRendererGoneEvidence() {
        try {
            File evidence = new File(getExternalFilesDir(null), "gatea-renderer-gone.txt");
            if (!evidence.exists()) return null;
            try (java.io.BufferedReader reader = new java.io.BufferedReader(new java.io.FileReader(evidence))) {
                StringBuilder builder = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) builder.append(line);
                return builder.toString();
            }
        } catch (Exception error) {
            return null;
        }
    }

    private Socket openSse() throws Exception {
        awaitEndpoint(30_000);
        Socket socket = new Socket(InetAddress.getByName("127.0.0.1"), gateway.getPort());
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
        int code = connection.getResponseCode();
        String response = readAll(connection);
        JSONObject parsed = new JSONObject(response);
        parsed.put("httpCode", code);
        parsed.put("gatewayProxied", gateway.getProxiedCount());
        return parsed;
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

    private void runCheck(String name, CheckBody body) {
        try { body.run(); } catch (Throwable error) {
            JSONObject evidence = new JSONObject();
            try {
                evidence.put("error", String.valueOf(error));
                evidence.put("gatewayProxied", gateway.getProxiedCount());
                evidence.put("upstreamClosedByClient", gateway.getUpstreamClosedByClientCount());
                evidence.put("downstreamClosedByUpstream", gateway.getDownstreamClosedByUpstreamCount());
            } catch (Exception ignored) { }
            record(name, false, evidence);
        }
    }

    interface CheckBody { void run() throws Exception; }

    /** 原始 socket POST（旁路 okhttp）：target=gateway 或直连 :core 数据服务；返回完整响应文本。 */
    private String rawPost(JSONObject command, boolean directToCore) throws Exception {
        awaitEndpoint(30_000);
        byte[] body = command.toString().getBytes(StandardCharsets.UTF_8);
        int targetPort = directToCore ? endpoint.optInt("port") : gateway.getPort();
        String nonceHeader = directToCore ? "x-core-nonce: " + endpoint.optString("nonce") + "\r\n" : "";
        try (Socket socket = new Socket(InetAddress.getByName("127.0.0.1"), targetPort)) {
            socket.setSoTimeout(20_000);
            OutputStream output = socket.getOutputStream();
            String requestHead = "POST /api/core/commands HTTP/1.1\r\n"
                + "host: 127.0.0.1\r\n"
                + nonceHeader
                + "content-type: application/json\r\n"
                + "content-length: " + body.length + "\r\n"
                + "connection: close\r\n\r\n";
            output.write(requestHead.getBytes(StandardCharsets.US_ASCII));
            output.write(body);
            output.flush();
            java.io.InputStream input = socket.getInputStream();
            StringBuilder builder = new StringBuilder();
            byte[] buffer = new byte[4096];
            int read;
            while ((read = input.read(buffer)) >= 0) builder.append(new String(buffer, 0, read, StandardCharsets.UTF_8));
            return builder.toString();
        }
    }

    private String rawPost(JSONObject command) throws Exception {
        return rawPost(command, false);
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
            // 构建身份（评审第 7 条：证据可追溯性）
            report.put("buildVariant", "debug");
            report.put("runId", runId == null ? "missing" : runId);
            report.put("rebindDedupedCount", rebindDedupedCount.get());
            report.put("buildCommit", readBuildCommit());
            report.put("apkSha256", apkSha256());
            report.put("startedAt", java.time.Instant.ofEpochMilli(startedAtMillis).toString());
            report.put("finishedAt", java.time.Instant.now().toString());
            report.put("checks", new JSONArray(checks));
            report.put("gateway", new JSONObject()
                .put("port", gateway.getPort())
                .put("proxied", gateway.getProxiedCount())
                .put("upstreamClosedByClient", gateway.getUpstreamClosedByClientCount())
                .put("downstreamClosedByUpstream", gateway.getDownstreamClosedByUpstreamCount()));
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

    /** 构建期 version.json（gradle generateVersionInfo 生成，含 git commit）。 */
    private String readBuildCommit() {
        try {
            String json = new String(readAsset("version.json"), StandardCharsets.UTF_8);
            return new JSONObject(json).optString("commit");
        } catch (Exception error) {
            return "unknown";
        }
    }

    private byte[] readAsset(String name) throws Exception {
        try (java.io.InputStream input = getAssets().open(name)) {
            java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
            return output.toByteArray();
        }
    }

    /** 当前 APK 摘要（证据可追溯）。 */
    private String apkSha256() {
        try {
            java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
            try (java.io.InputStream input = new java.io.FileInputStream(getApplicationInfo().sourceDir)) {
                byte[] buffer = new byte[65536];
                int read;
                while ((read = input.read(buffer)) >= 0) digest.update(buffer, 0, read);
            }
            StringBuilder builder = new StringBuilder();
            for (byte b : digest.digest()) builder.append(String.format("%02x", b));
            return builder.toString();
        } catch (Exception error) {
            return "unavailable";
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
