package ai.stagecraft.android;

import android.app.Service;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Process;
import android.os.RemoteCallbackList;
import android.webkit.JavascriptInterface;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * W5：Core 进程服务入口（计划 §4.2 / §5.1 / §5.2 / §5.4）。
 *
 * 职责（按进程分流初始化 WebView 数据目录 → appassets 加载 core-host →
 * 建立进程内桥（WebMessagePort 优先）→ 启动 nonce 数据服务 → 接受 PluginLaunchPlan →
 * 发布 CoreHealth。Binder 控制面只交换 port/nonce/health/lifecycle 小消息（≤8KiB，§4.4）。
 *
 * 主进程通过 bindService(BIND_AUTO_CREATE) 创建并持有本服务；本服务绝不承载主 UI。
 */
public final class CoreService extends Service {

    private final Handler main = new Handler(Looper.getMainLooper());
    private final AtomicBoolean disposed = new AtomicBoolean(false);
    private WebView coreWebView;
    private CoreDataServer dataServer;
    private String startedAt;
    private String status = "starting";
    private String failureCode;
    private String coreBundleVersion = "unknown";
    private String coreBundleHash = "";
    private String pluginSetHash = "unknown";
    private String stateSchemaVersion = "unknown";
    private String protocolVersion = "1.1";
    private EmbeddedCoreArtifact.Verification verifiedArtifact;
    private String nonce = "";
    private int corePid;
    private JSONObject launchPlan = new JSONObject();

    /** Q8 最小 AIDL 契约：getEndpoint / getStatusSummary / registerCallback / requestStop。 */
    private final ICoreControl.Stub control = new ICoreControl.Stub() {
        @Override public String getEndpoint() {
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

        @Override public String getStatusSummary() {
            return enforceBinderLimit(getStatusSummary().toString());
        }

        @Override public void registerCallback(ICoreControlCallback callback) {
            callbacks.register(callback);
            broadcastStatus();
            String endpoint = getEndpoint();
            if (endpoint != null) broadcastEndpoint(endpoint);
        }

        @Override public void requestStop() {
            stopGracefully();
        }

        @Override public void acceptLaunchPlan(String planJson) {
            try {
                if (planJson == null || planJson.length() > 8 * 1024) throw new IllegalArgumentException("launch plan too large");
                // 限定外层方法：本匿名类同名方法会遮蔽外层 acceptLaunchPlan(JSONObject)
                CoreService.this.acceptLaunchPlan(new JSONObject(planJson));
            } catch (Exception error) {
                GateALog.w("acceptLaunchPlan rejected: " + error);
            }
        }
    };

    private final RemoteCallbackList<ICoreControlCallback> callbacks = new RemoteCallbackList<>();
    /** Binder 发送侧观测到的最大单条字节（Q8：硬上限 64KiB）。 */
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

    @Override public void onCreate() {
        super.onCreate();
        // 进程入口首行：:core 进程 WebView suffix（§5.1）。返回 false 表示已由更早入口初始化。
        String processName = ProcessGuard.currentProcessName();
        boolean initializedHere = ProcessGuard.init(processName);
        corePid = Process.myPid();
        startedAt = java.time.Instant.now().toString();
        GateALog.i("core service onCreate pid=" + corePid + " process=" + processName + " suffixInit=" + initializedHere);
        GateACrashGuard.install(this);
        bridge = loadBridge();
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
            coreBundleVersion = artifact.version();
            coreBundleHash = artifact.sha256();
            nonce = java.util.UUID.randomUUID().toString().replace("-", "");
            dataServer = new CoreDataServer(nonce);
            dataServer.setCommandForwarder(new CoreDataServer.CommandForwarder() {
                @Override public void forward(String bodyJson, java.util.function.Consumer<String> resultConsumer) {
                    forwardCommand(bodyJson, resultConsumer);
                }

                @Override public String view() {
                    return currentView();
                }

                @Override public void cancel(String requestId) {
                    forwardCommand("{\"command\":\"cancel\",\"requestId\":\"" + requestId.replace("\"", "") + "\"}", result -> { });
                }
            });
            dataServer.start();

            coreWebView = new WebView(this);
            coreWebView.getSettings().setJavaScriptEnabled(true);
            coreWebView.getSettings().setAllowFileAccess(false);
            coreWebView.getSettings().setAllowContentAccess(false);
            coreWebView.getSettings().setDomStorageEnabled(false);
            coreWebView.setWebViewClient(new CoreHostAssetLoader(this, view -> {
                // renderer 崩溃：标记 failed 后走 :core 进程内自杀钩子（GATE-A-LOW-PERMISSION §3 批准路径）。
                // stopSelf 在绑定存活时服务进 stopped 态，BIND_AUTO_CREATE 不会重建（真机实测）；
                // 进程自杀则绑定死亡自动触发重建，与 kill-restart 同一条已验证恢复链。
                fail("renderer_gone", "core webview renderer crashed");
                Process.killProcess(Process.myPid());
            }, (view, url) -> {
                if (bridgeReady.compareAndSet(false, true)) setupWebMessageBridge();
            }));
            coreWebView.setWebChromeClient(new android.webkit.WebChromeClient() {
                @Override public boolean onConsoleMessage(android.webkit.ConsoleMessage message) {
                    GateALog.i("core-host console [" + message.messageLevel() + "] " + message.message() + " @" + message.sourceId() + ":" + message.lineNumber());
                    return true;
                }
            });
            coreWebView.addJavascriptInterface(new CoreNative(), "CoreNative");
            coreWebView.loadUrl(CoreHostAssetLoader.CORE_ORIGIN + "/assets/core-host.html");
            GateALog.i("core webview loading appassets core-host");
        } catch (Throwable error) {
            // 捕获 Throwable：任何 Error 不得杀掉 :core 进程进重启循环
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
            @Override public void onMessage(WebMessagePort port, WebMessage message) {
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
                    JSONObject health = buildHealth(message.optJSONObject("measure"));
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

    private JSONObject buildHealth(JSONObject measure) {
        try {
            JSONObject health = new JSONObject();
            health.put("protocolVersion", protocolVersion);
            health.put("minSupportedProtocolVersion", "1.0");
            health.put("maxSupportedProtocolVersion", "1.1");
            health.put("bridgeVersion", "core-service");
            // bundle 身份以服务端 EmbeddedCoreArtifact 校验结果为权威（评审：页面自报不可信）
            health.put("coreBundleVersion", verifiedArtifact == null ? "unknown" : verifiedArtifact.version());
            health.put("coreBundleHash", verifiedArtifact == null ? "" : verifiedArtifact.sha256());
            health.put("pluginSetHash", pluginSetHash);
            health.put("stateSchemaVersion", stateSchemaVersion);
            health.put("status", "ready");
            health.put("pid", corePid);
            health.put("startedAt", startedAt);
            health.put("binderMaxPayloadBytes", maxBinderPayloadBytes);
            if (launchPlan.length() > 0) health.put("launchPlan", launchPlan);
            if (measure != null) health.put("measure", measure);
            return health;
        } catch (Exception error) {
            return new JSONObject();
        }
    }

    private void publishEndpointReady() {
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

    /** POST /api/core/commands → 进程内桥 → 回执。 */
    private void forwardCommand(String bodyJson, java.util.function.Consumer<String> resultConsumer) {
        if (coreWebView == null) {
            resultConsumer.accept("{\"status\":\"rejected\",\"error\":{\"code\":\"core_unavailable\",\"message\":\"core webview is not available\"}}");
            return;
        }
        long startedAtMillis = System.currentTimeMillis();
        // crash-renderer：API 29+ 官方 terminate()（随后必然回调 onRenderProcessGone，构成证据链）
        try {
            if ("crash-renderer".equals(new JSONObject(bodyJson).optString("command"))
                && android.os.Build.VERSION.SDK_INT >= 29 && coreWebView != null) {
                android.webkit.WebViewRenderProcess renderProcess = coreWebView.getWebViewRenderProcess();
                if (renderProcess != null) {
                    renderProcess.terminate();
                    resultConsumer.accept(new JSONObject()
                        .put("requestId", new JSONObject(bodyJson).optString("requestId"))
                        .put("status", "accepted")
                        .put("method", "WebViewRenderProcess.terminate()").toString());
                    return;
                }
            }
        } catch (Exception error) {
            GateALog.w("crash-renderer terminate path failed: " + error);
        }
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

    /** GET /api/core/view 的权威视图：经桥取（异步回调，返回 null 表示未就绪）。 */
    private String currentView() {
        if (coreWebView == null) return null;
        final String[] result = new String[1];
        final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
        main.post(() -> {
            if (coreWebView == null) { latch.countDown(); return; }
            coreWebView.evaluateJavascript(
                "window.CoreHostBridge && window.CoreHostBridge.view()",
                value -> {
                    result[0] = unquote(value);
                    latch.countDown();
                });
        });
        try {
            if (!latch.await(5, java.util.concurrent.TimeUnit.SECONDS)) return null;
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            return null;
        }
        return result[0];
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

    /** 接受主进程的 PluginLaunchPlan（§2.4）：不可变，运行中不热替换。 */
    public void acceptLaunchPlan(JSONObject plan) {
        if (plan == null) return;
        try {
            launchPlan = plan;
            pluginSetHash = plan.optString("pluginSetHash", "unknown");
            stateSchemaVersion = plan.optString("stateSchemaVersion", "unknown");
            // 若已 ready 则刷新 health（插件集身份进入数据面）
            if ("ready".equals(status) && dataServer != null) {
                dataServer.setHealthJson(buildHealth(null).toString());
            }
        } catch (Exception error) {
            GateALog.w("launch plan rejected: " + error);
        }
    }

    private void fail(String code, String message) {
        if ("failed".equals(status) && code.equals(failureCode)) return; // 幂等：重复失败通知不重复迁移
        status = "failed";
        failureCode = code;
        GateALog.w("core failed code=" + code + " message=" + message);
        if ("renderer_gone".equals(code)) {
            // renderer 证据独立落盘（评审：oneway 广播竞态导致主进程侧漏帧）——
            // 本文件由 :core 进程在 onRenderProcessGone 处理路径内同步写入，先于 stopSelf
            try {
                File evidence = new File(getExternalFilesDir(null), "gatea-renderer-gone.txt");
                String payload = new JSONObject()
                    .put("event", "onRenderProcessGone")
                    .put("failureCode", code)
                    .put("message", message)
                    .put("pid", corePid)
                    .put("at", java.time.Instant.now().toString())
                    .toString();
                try (FileOutputStream output = new FileOutputStream(evidence, false)) {
                    output.write(payload.getBytes(StandardCharsets.UTF_8));
                }
            } catch (Exception ignored) { }
        }
        broadcastStatus();
    }

    private JSONObject getStatusSummary() {
        try {
            return new JSONObject()
                .put("status", status)
                .put("pid", corePid)
                .put("startedAt", startedAt)
                .put("failureCode", failureCode == null ? JSONObject.NULL : failureCode)
                .put("protocolVersion", protocolVersion);
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

    @Override public IBinder onBind(Intent intent) {
        return control;
    }

    @Override public void onDestroy() {
        disposed.set(true);
        if (dataServer != null) dataServer.stop();
        if (coreWebView != null) coreWebView.destroy();
        if (coreOperations != null) coreOperations.close();
        super.onDestroy();
    }

    /** 独立命名的 CoreNative interface：只暴露 core-native operation（Gate B：checkCoreNative）。 */
    public class CoreNative {
        @JavascriptInterface public String invokeSync(String operation, String inputJson) {
            return bridge.invokeSync(operation, inputJson);
        }

        @JavascriptInterface public void invokeAsync(String operation, String inputJson, String callbackId) {
            String requestId = bridge.invokeAsync(operation, inputJson, new CoreNativeBridge.Callback() {
                @Override public void onResult(org.json.JSONObject result) {
                    deliverAsync(callbackId, result.toString());
                }

                @Override public void onError(String message) {
                    deliverAsync(callbackId, errorMessageJson(message));
                }
            });
            if (!requestId.isEmpty()) {
                try {
                    deliverAsync(callbackId, new JSONObject().put("requestId", requestId).toString());
                } catch (Exception ignored) { }
            }
        }

        private void deliverAsync(String callbackId, String resultJson) {
            if (coreWebView == null || callbackId == null) return;
            main.post(() -> {
                if (coreWebView != null) {
                    coreWebView.evaluateJavascript(
                        "window.CoreNativeResult && window.CoreNativeResult.handle(" + JSONObject.quote(callbackId) + "," + JSONObject.quote(resultJson) + ")", null);
                }
            });
        }

        private String errorMessageJson(String message) {
            try { return new JSONObject().put("ok", false).put("error", new JSONObject().put("code", "NATIVE_OPERATION_FAILED").put("message", message == null || message.isEmpty() ? "Native operation failed." : message)).toString(); }
            catch (Exception ignored) { return "{\"ok\":false,\"error\":{\"code\":\"NATIVE_OPERATION_FAILED\",\"message\":\"Native operation failed.\"}}"; }
        }
    }

    private CoreNativeBridge bridge;
    private AndroidCompositionOperations coreOperations;

    /** 从 APK 资产加载 native-operation-registry.json 并构造桥（构建期产物，Java 侧不得手写白名单）。 */
    private CoreNativeBridge loadBridge() {
        CoreNativeBridge built;
        try (java.io.InputStream input = getAssets().open("native-operation-registry.json")) {
            byte[] bytes = new byte[input.available()];
            int read = input.read(bytes);
            String json = new String(bytes, 0, Math.max(0, read), StandardCharsets.UTF_8);
            built = new CoreNativeBridge(NativeOperationGuard.parse(json, false));
        } catch (Exception error) {
            // 资产缺失 = 构建期契约破坏：失败关闭（不执行任何 operation）
            built = new CoreNativeBridge(NativeOperationGuard.parse("{\"legacyMainCoreException\":[],\"mainHost\":[]}", false));
        }
        registerCorePorts(built);
        return built;
    }

    /** 把 Core 进程原生端口（repository/secret/model transport/story 资产）挂到桥。 */
    private void registerCorePorts(CoreNativeBridge built) {
        coreOperations = new AndroidCompositionOperations(
            this, new AndroidSqliteRepository(this), new AndroidSecretStore(this),
            java.util.concurrent.Executors.newCachedThreadPool());
        // 同步端口：直接转发到 AndroidCompositionOperations.invokeSync
        for (String operation : new String[] {
            "asset.read", "asset.write", "asset.remove",
            "secret.get", "secret.set", "secret.remove",
            "core-state.commit", "core-state.restore",
            "stagecraft.room.get", "stagecraft.repository", "stories.list", "story.read", "preset.list",
            "preset.active-scope.set", "preset.save", "preset.delete",
            "story.create", "story.save", "story.saveAs", "story.delete",
            "archive.save", "archive.list", "archive.load", "archive.delete",
            "model.cancel",
        }) {
            built.registerSync(operation, input -> coreOperations.invokeSync(operation, input));
        }
        // 异步端口：模型请求 / 故事读取
        built.registerAsync("model.request", (operation, input, callback) -> coreOperations.invoke(operation, input, new AndroidNativeOperations.Callback() {
            @Override public void onResult(org.json.JSONObject result) { callback.onResult(result); }
            @Override public void onError(String message) { callback.onError(message); }
        }));
        built.registerAsync("story.read", (operation, input, callback) -> coreOperations.invoke(operation, input, new AndroidNativeOperations.Callback() {
            @Override public void onResult(org.json.JSONObject result) { callback.onResult(result); }
            @Override public void onError(String message) { callback.onError(message); }
        }));
    }
}
