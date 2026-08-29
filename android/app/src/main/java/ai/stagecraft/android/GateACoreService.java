package ai.stagecraft.android;

import android.app.Application;
import android.app.Service;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Process;
import android.os.ResultReceiver;
import android.webkit.JavascriptInterface;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebView;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * W0 spike：:core 进程服务入口（计划 §4.2 / Q1 / Q8）。
 *
 * 职责：按进程分流初始化 WebView 数据目录 → appassets 加载 core-host 页面 →
 * 建立进程内桥（优先 WebMessagePort，回退 CoreNative interface 用于量测对照）→
 * 启动 nonce 数据服务 → 发布状态摘要。Binder 只交换 port/nonce/health/lifecycle 小消息（≤8KiB）。
 * 该服务是 spike 原型；Gate A 通过后由 W5/W6 选择性移植为正式 CoreService。
 */
public class GateACoreService extends Service {
    public static final int MSG_STATUS = 1;
    public static final int MSG_ENDPOINT_READY = 2;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final AtomicBoolean disposed = new AtomicBoolean(false);
    private final CopyOnWriteArrayList<ResultReceiver> callbacks = new CopyOnWriteArrayList<>();
    private WebView coreWebView;
    private GateACoreDataServer dataServer;
    private String startedAt;
    private String status = "starting";
    private String failureCode;
    private String nonce = "";
    private int corePid;

    /** Q8 最小 Binder 契约：getEndpoint / requestStop / getStatusSummary / registerCallback。 */
    public class Binder extends android.os.Binder {
        /** 端点就绪后返回 {"port":int,"nonce":String,"pid":int}；未就绪返回 null。nonce 仅经 Binder 传递。 */
        public JSONObject getEndpoint() {
            if (dataServer == null || dataServer.getPort() < 0 || !"ready".equals(status)) return null;
            try {
                return new JSONObject()
                    .put("port", dataServer.getPort())
                    .put("nonce", nonce)
                    .put("pid", corePid);
            } catch (Exception error) {
                return null;
            }
        }

        public JSONObject getStatusSummary() {
            return GateACoreService.this.getStatusSummary();
        }

        public synchronized void registerCallback(ResultReceiver receiver) {
            receiver.send(MSG_STATUS, summaryBundle());
            JSONObject endpoint = getEndpoint();
            if (endpoint != null) {
                Bundle data = new Bundle();
                data.putString("summary", endpoint.toString());
                receiver.send(MSG_ENDPOINT_READY, data);
            }
            callbacks.add(receiver);
        }

        public void requestStop() {
            stopGracefully();
        }
    }

    private final Binder control = new Binder();

    @Override
    public void onCreate() {
        super.onCreate();
        // 进程入口首行：:core 进程 WebView suffix（§5.1）。返回 false 表示已由更早入口初始化。
        String processName = Application.getProcessName();
        boolean initializedHere = ProcessGuard.init(processName);
        corePid = Process.myPid();
        startedAt = java.time.Instant.now().toString();
        GateALog.i("core service onCreate pid=" + corePid + " process=" + processName + " suffixInit=" + initializedHere);
        main.post(this::boot);
    }

    private void boot() {
        try {
            EmbeddedCoreArtifact.Verification artifact = EmbeddedCoreArtifact.verify(this);
            if (!artifact.valid()) {
                fail("bundle_invalid", "embedded core verification failed: " + artifact.reason());
                return;
            }
            nonce = java.util.UUID.randomUUID().toString().replace("-", "");
            dataServer = new GateACoreDataServer(nonce);
            dataServer.setCommandForwarder(this::forwardCommand);
            dataServer.start();

            coreWebView = new WebView(this);
            coreWebView.getSettings().setJavaScriptEnabled(true);
            coreWebView.getSettings().setAllowFileAccess(false);
            coreWebView.getSettings().setAllowContentAccess(false);
            coreWebView.getSettings().setDomStorageEnabled(false);
            coreWebView.setWebViewClient(new CoreHostAssetLoader(this, view -> fail("renderer_gone", "core webview renderer crashed")));
            coreWebView.addJavascriptInterface(new CoreNativeMeasure(), "CoreNative");
            setupWebMessageBridge();
            coreWebView.loadUrl(CoreHostAssetLoader.CORE_ORIGIN + "/assets/core-host.html");
            GateALog.i("core webview loading appassets core-host");
        } catch (Exception error) {
            fail("boot_failed", error.getClass().getSimpleName() + ": " + error.getMessage());
        }
    }

    /** Q1 优先通道：WebMessagePort。Java 建立通道并把一个端口交给页面，页面事件经端口回流。 */
    private void setupWebMessageBridge() {
        WebMessagePort[] channel = coreWebView.createWebMessageChannel();
        WebMessagePort hostPort = channel[0];
        WebMessagePort pagePort = channel[1];
        hostPort.setWebMessageCallback(new WebMessagePort.WebMessageCallback() {
            @Override
            public void onMessage(WebMessagePort port, WebMessage message) {
                handleBridgeMessage(message.getData());
            }
        });
        coreWebView.postWebMessage(new WebMessage("{\"type\":\"init\",\"bridge\":\"web-message-port\"}", new WebMessagePort[]{pagePort}), Uri.EMPTY);
        GateALog.i("web message bridge posted");
    }

    /** 页面 → 宿主消息（:core 主线程）：事件发布 / 就绪上报 / 日志。 */
    private void handleBridgeMessage(String json) {
        try {
            JSONObject message = new JSONObject(json);
            String type = message.optString("type");
            switch (type) {
                case "core-ready" -> {
                    status = "ready";
                    JSONObject health = new JSONObject();
                    health.put("protocolVersion", message.optString("protocolVersion", "1.1"));
                    health.put("minSupportedProtocolVersion", "1.0");
                    health.put("maxSupportedProtocolVersion", "1.1");
                    health.put("bridgeVersion", "gatea-spike");
                    health.put("coreBundleVersion", message.optString("bundleVersion", ""));
                    health.put("coreBundleHash", message.optString("bundleSha256", ""));
                    health.put("pluginSetHash", "spike");
                    health.put("stateSchemaVersion", "spike");
                    health.put("status", "ready");
                    health.put("pid", corePid);
                    health.put("startedAt", startedAt);
                    if (message.optJSONObject("measure") != null) health.put("measure", message.optJSONObject("measure"));
                    dataServer.setHealthJson(health.toString());
                    publishEndpointReady();
                }
                case "core-event" -> {
                    if (dataServer != null) dataServer.publishCoreEvent(message.getJSONObject("event"));
                }
                case "log" -> GateALog.i("core-host: " + message.optString("text"));
                default -> GateALog.w("unknown bridge message type: " + type);
            }
        } catch (Exception error) {
            GateALog.w("bridge message failed: " + error.getClass().getSimpleName());
        }
    }

    private void publishEndpointReady() {
        JSONObject endpoint = control.getEndpoint();
        GateALog.i("endpoint ready port=" + dataServer.getPort() + " status=ready");
        for (ResultReceiver receiver : callbacks) {
            Bundle data = new Bundle();
            data.putString("summary", endpoint.toString());
            receiver.send(MSG_ENDPOINT_READY, data);
        }
    }

    /** POST /api/core/commands → 进程内桥（evaluateJavascript echo）→ 回执。Q1 量测点。 */
    private void forwardCommand(String bodyJson, java.util.function.BiConsumer<Integer, String> respond) {
        long startedAtMillis = System.currentTimeMillis();
        coreWebView.evaluateJavascript(
            "window.CoreHostBridge && window.CoreHostBridge.echo(" + JSONObject.quote(bodyJson) + ")",
            resultJson -> {
                long elapsed = System.currentTimeMillis() - startedAtMillis;
                String payload = unquote(resultJson);
                JSONObject receipt = new JSONObject();
                try {
                    receipt.put("requestId", new JSONObject(bodyJson).optString("requestId"));
                    receipt.put("status", payload == null ? "rejected" : "accepted");
                    receipt.put("bridgeElapsedMs", elapsed);
                    receipt.put("bodyBytes", bodyJson.getBytes(StandardCharsets.UTF_8).length);
                    if (payload != null) receipt.put("echo", new JSONObject(payload));
                    else receipt.put("error", new JSONObject().put("code", "bridge_failed").put("message", "core host echo unavailable"));
                } catch (Exception error) {
                    try { receipt.put("status", "rejected"); } catch (Exception ignored) { }
                }
                respond.accept(200, receipt.toString());
            });
    }

    /** Q1 回退通道量测：独立命名的 CoreNative interface（不得复用主 WebView 的 StageCraftNative）。 */
    public class CoreNativeMeasure {
        @JavascriptInterface
        public String ping(String payload) {
            return payload;
        }
    }

    /** evaluateJavascript 的返回值是 JSON 字符串字面量（带引号），还原为页面返回的原始文本。 */
    private static String unquote(String evaluateResult) {
        if (evaluateResult == null || "null".equals(evaluateResult)) return null;
        String trimmed = evaluateResult.trim();
        if (trimmed.length() >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
            try {
                return new JSONObject().put("value", new org.json.JSONTokener(trimmed).nextValue()).getString("value");
            } catch (Exception error) {
                return null;
            }
        }
        return null;
    }

    private void fail(String code, String message) {
        status = "failed";
        failureCode = code;
        GateALog.w("core failed code=" + code + " message=" + message);
        for (ResultReceiver receiver : callbacks) receiver.send(MSG_STATUS, summaryBundle());
    }

    private JSONObject getStatusSummary() {
        try {
            return new JSONObject()
                .put("status", status)
                .put("pid", corePid)
                .put("startedAt", startedAt)
                .put("failureCode", failureCode == null ? JSONObject.NULL : failureCode)
                .put("protocolVersion", "1.1");
        } catch (Exception error) {
            return new JSONObject();
        }
    }

    private Bundle summaryBundle() {
        Bundle bundle = new Bundle();
        bundle.putString("summary", getStatusSummary().toString());
        return bundle;
    }

    private void stopGracefully() {
        if (!disposed.compareAndSet(false, true)) return;
        status = "stopping";
        main.post(() -> {
            if (dataServer != null) dataServer.stop();
            if (coreWebView != null) {
                coreWebView.destroy();
                coreWebView = null;
            }
            stopSelf();
        });
    }

    @Override
    public IBinder onBind(Intent intent) {
        return control;
    }

    @Override
    public void onDestroy() {
        disposed.set(true);
        if (dataServer != null) dataServer.stop();
        if (coreWebView != null) coreWebView.destroy();
        super.onDestroy();
    }
}
