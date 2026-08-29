package ai.stagecraft.android;

import android.app.Service;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.RemoteCallbackList;
import android.os.Process;
import android.webkit.JavascriptInterface;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebView;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
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

    private final Handler main = new Handler(Looper.getMainLooper());
    private final AtomicBoolean disposed = new AtomicBoolean(false);
    private WebView coreWebView;
    private GateACoreDataServer dataServer;
    private String startedAt;
    private String status = "starting";
    private String failureCode;
    private EmbeddedCoreArtifact.Verification verifiedArtifact;
    private String nonce = "";
    private int corePid;

    /** Q8 最小 AIDL 契约：getEndpoint / getStatusSummary / registerCallback / requestStop。 */
    private final ICoreControl.Stub control = new ICoreControl.Stub() {
        @Override
        public String getEndpoint() {
            if (dataServer == null || dataServer.getPort() < 0 || !"ready".equals(status)) return null;
            try {
                return enforceBinderLimit(new JSONObject()
                    .put("port", dataServer.getPort())
                    .put("nonce", nonce)
                    .put("pid", corePid)
                    .toString());
            } catch (IllegalStateException limit) {
                throw limit;
            } catch (Exception error) {
                return null;
            }
        }

        @Override
        public String getStatusSummary() {
            return enforceBinderLimit(GateACoreService.this.getStatusSummary().toString());
        }

        @Override
        public void registerCallback(ICoreControlCallback callback) {
            callbacks.register(callback);
            broadcastStatus();
            String endpoint = getEndpoint();
            if (endpoint != null) broadcastEndpoint(endpoint);
        }

        @Override
        public void requestStop() {
            stopGracefully();
        }
    };

    private final RemoteCallbackList<ICoreControlCallback> callbacks = new RemoteCallbackList<>();
    /** Binder 发送侧观测到的最大单条字节（Q8：硬上限 64KiB；GATE-A-LOW-PERMISSION §5 要求记录）。 */
    private volatile int maxBinderPayloadBytes = 0;

    /** 发送侧 64KiB 硬断言 + 最大单条观测记录。 */
    private String enforceBinderLimit(String payload) {
        int bytes = payload.getBytes(StandardCharsets.UTF_8).length;
        if (bytes > maxBinderPayloadBytes) maxBinderPayloadBytes = bytes;
        if (bytes > 64 * 1024) throw new IllegalStateException("Binder payload exceeds 64KiB hard limit: " + bytes);
        return payload;
    }

    private void broadcastStatus() {
        String summary = enforceBinderLimit(getStatusSummary().toString());
        int count = callbacks.beginBroadcast();
        try {
            for (int index = 0; index < count; index++) {
                try { callbacks.getBroadcastItem(index).onStatus(summary); } catch (Exception ignored) { }
            }
        } finally {
            callbacks.finishBroadcast();
        }
    }

    private void broadcastEndpoint(String endpointRaw) {
        String endpoint = enforceBinderLimit(endpointRaw);
        int count = callbacks.beginBroadcast();
        try {
            for (int index = 0; index < count; index++) {
                try { callbacks.getBroadcastItem(index).onEndpointReady(endpoint); } catch (Exception ignored) { }
            }
        } finally {
            callbacks.finishBroadcast();
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        // 进程入口首行：:core 进程 WebView suffix（§5.1）。返回 false 表示已由更早入口初始化。
        String processName = ProcessGuard.currentProcessName();
        boolean initializedHere = ProcessGuard.init(processName);
        corePid = Process.myPid();
        startedAt = java.time.Instant.now().toString();
        GateALog.i("core service onCreate pid=" + corePid + " process=" + processName + " suffixInit=" + initializedHere);
        GateACrashGuard.install(this);
        main.post(this::boot);
    }

    private void boot() {
        try {
            EmbeddedCoreArtifact.Verification artifact = EmbeddedCoreArtifact.verify(this);
            if (!artifact.valid()) {
                fail("bundle_invalid", "embedded core verification failed: " + artifact.reason());
                return;
            }
            verifiedArtifact = artifact;
            nonce = java.util.UUID.randomUUID().toString().replace("-", "");
            dataServer = new GateACoreDataServer(nonce);
            dataServer.setCommandForwarder(this::forwardCommand);
            dataServer.start();

            coreWebView = new WebView(this);
            coreWebView.getSettings().setJavaScriptEnabled(true);
            coreWebView.getSettings().setAllowFileAccess(false);
            coreWebView.getSettings().setAllowContentAccess(false);
            coreWebView.getSettings().setDomStorageEnabled(false);
            coreWebView.setWebViewClient(new CoreHostAssetLoader(this, view -> {
                // renderer 崩溃（Gate A 硬条件实测项）：标记 failed 并自杀，主进程 onBindingDied → rebind 全周期
                fail("renderer_gone", "core webview renderer crashed");
                stopGracefully();
            }, (view, url) -> {
                if (bridgeReady.compareAndSet(false, true)) setupWebMessageBridge(); // 页面监听器就绪后下发端口
            }));
            coreWebView.setWebChromeClient(new android.webkit.WebChromeClient() {
                @Override
                public boolean onConsoleMessage(android.webkit.ConsoleMessage message) {
                    GateALog.i("core-host console [" + message.messageLevel() + "] " + message.message() + " @" + message.sourceId() + ":" + message.lineNumber());
                    return true;
                }
            });
            coreWebView.addJavascriptInterface(new CoreNativeMeasure(), "CoreNative");
            coreWebView.loadUrl(CoreHostAssetLoader.CORE_ORIGIN + "/assets/core-host.html");
            GateALog.i("core webview loading appassets core-host");
        } catch (Throwable error) {
            // 捕获 Throwable：任何 Error（如 NoClassDefFoundError）不得杀掉 :core 进程进重启循环
            fail("boot_failed", error.getClass().getSimpleName() + ": " + error.getMessage());
        }
    }

    private final AtomicBoolean bridgeReady = new AtomicBoolean(false);

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
        coreWebView.postWebMessage(new WebMessage("{\"type\":\"init\",\"bridge\":\"web-message-port\"}", new WebMessagePort[]{pagePort}), Uri.parse(CoreHostAssetLoader.CORE_ORIGIN));
        GateALog.i("web message bridge posted");
    }

    /** 页面 → 宿主消息（:core 主线程）：事件发布 / 就绪上报 / 日志。 */
    private void handleBridgeMessage(String json) {
        try {
            JSONObject message = new JSONObject(json);
            String type = message.optString("type");
            switch (type) {
                case "core-ready" -> {
                    // 幂等状态迁移：重复 ready 不重复广播
                    if ("ready".equals(status)) return;
                    status = "ready";
                    JSONObject health = new JSONObject();
                    health.put("protocolVersion", "1.1");
                    health.put("minSupportedProtocolVersion", "1.0");
                    health.put("maxSupportedProtocolVersion", "1.1");
                    health.put("bridgeVersion", "gatea-spike");
                    // bundle 身份以服务端 EmbeddedCoreArtifact 校验结果为权威（评审第 6 条：页面自报不可信）
                    health.put("coreBundleVersion", verifiedArtifact == null ? "unknown" : verifiedArtifact.version());
                    health.put("coreBundleHash", verifiedArtifact == null ? "" : verifiedArtifact.sha256());
                    health.put("pluginSetHash", "spike");
                    health.put("stateSchemaVersion", "spike");
                    health.put("status", "ready");
                    health.put("pid", corePid);
                    health.put("startedAt", startedAt);
                    health.put("binderMaxPayloadBytes", maxBinderPayloadBytes);
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
        // 控制面约定：端点信息只经 Binder 小消息（Q8）；此处直接广播，不经本地 Stub 以免 RemoteException
        GateALog.i("endpoint ready port=" + dataServer.getPort() + " status=ready");
        String endpoint = null;
        try {
            if (dataServer != null) {
                endpoint = new JSONObject()
                    .put("port", dataServer.getPort())
                    .put("nonce", nonce)
                    .put("pid", corePid)
                    .toString();
            }
        } catch (Exception error) {
            endpoint = null;
        }
        if (endpoint != null) broadcastEndpoint(endpoint);
    }

    /** POST /api/core/commands → 进程内桥（evaluateJavascript echo）→ 回执。Q1 量测点。 */
    private void forwardCommand(String bodyJson, java.util.function.Consumer<String> resultConsumer) {
        long startedAtMillis = System.currentTimeMillis();
        coreWebView.evaluateJavascript(
            "window.CoreHostBridge && window.CoreHostBridge.dispatch(" + JSONObject.quote(bodyJson) + ")",
            resultJson -> {
                long elapsed = System.currentTimeMillis() - startedAtMillis;
                String payload = unquote(resultJson);
                String receipt;
                try {
                    JSONObject object = new JSONObject();
                    object.put("requestId", new JSONObject(bodyJson).optString("requestId"));
                    object.put("status", payload == null ? "rejected" : "accepted");
                    object.put("bridgeElapsedMs", elapsed);
                    object.put("bodyBytes", bodyJson.getBytes(StandardCharsets.UTF_8).length);
                    if (payload != null) object.put("echo", new JSONObject(payload));
                    else object.put("error", new JSONObject().put("code", "bridge_failed").put("message", "core host echo unavailable"));
                    receipt = object.toString();
                } catch (Exception error) {
                    receipt = "{\"status\":\"rejected\"}";
                }
                resultConsumer.accept(receipt); // 只交付 JSON 字符串，socket 写回在连接线程
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
        if ("failed".equals(status) && code.equals(failureCode)) return; // 幂等：重复失败通知不重复迁移
        status = "failed";
        failureCode = code;
        GateALog.w("core failed code=" + code + " message=" + message);
        broadcastStatus();
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
