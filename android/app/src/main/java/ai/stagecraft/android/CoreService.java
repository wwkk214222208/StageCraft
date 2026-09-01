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
import java.util.Map;
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
    private final AtomicBoolean stopCompleted = new AtomicBoolean(false);
    private WebView coreWebView;
    private CoreDataServer dataServer;
    private String startedAt;
    /** W5-3：状态机 seam（§4.1）——CoreService 委托本类驱动生命周期与摘要。 */
    private CoreServiceStateMachine stateMachine = new CoreServiceStateMachine();
    private String coreBundleVersion = "unknown";
    private String coreBundleHash = "";
    private String pluginSetHash = "unknown";
    private String stateSchemaVersion = "unknown";
    private String protocolVersion = "1.1";
    private EmbeddedCoreArtifact.Verification verifiedArtifact;
    private String nonce = "";
    private int corePid;
    private JSONObject launchPlan = new JSONObject();
    /** M5/M6 v2 plan is independent from the v1 PluginManager launch plan. */
    private V2ComponentStore v2ComponentStore;
    private V2PlanStore v2PlanStore;
    private boolean v2ExternalCore;
    private JSONObject v2SelectedPlan;
    private JSONObject v2RequestedPlan;
    private Runnable v2BootTimeout;
    /** Distinct from bridgeReady: the page bridge can exist before the Core handshake. */
    private final AtomicBoolean coreReady = new AtomicBoolean(false);
    /** W6：组合根回报的插件隔离记录（plugin-report 桥消息）。 */
    private volatile org.json.JSONArray pluginQuarantine;

    /** W4 合流：pending 协议请求表（requestId → 等待 forwardApi 结果的消费者）。 */
    private final java.util.concurrent.ConcurrentHashMap<String, java.util.function.Consumer<String>> pendingApi = new java.util.concurrent.ConcurrentHashMap<>();
    private final java.util.concurrent.atomic.AtomicLong pendingApiSequence = new java.util.concurrent.atomic.AtomicLong();

    /** W5-R1-2：Binder 控制面纯 Java 执行体（Stub 只做一行委托；JVM 可测）。 */
    private final CoreControlBinder controlBinder = new CoreControlBinder(        // 端点提供者：ready/degraded 且 dataServer 就绪时返回端点 JSON
        () -> {
            if (dataServer == null || dataServer.getPort() < 0) return null;
            CoreLifecycle.State state = stateMachine.state();
            if (state != CoreLifecycle.State.READY && state != CoreLifecycle.State.DEGRADED) return null;
            try {
                return new JSONObject()
                    .put("port", dataServer.getPort())
                    .put("nonce", nonce)
                    .put("pid", corePid)
                    .toString();
            } catch (Exception error) {
                return null;
            }
        },
        // 摘要提供者：状态机生成控制面摘要
        () -> stateMachine.summary(String.valueOf(corePid), startedAt, protocolVersion));

    /** Q8 最小 AIDL 契约：getEndpoint / getStatusSummary / registerCallback / requestStop。 */
    private final ICoreControl.Stub control = new ICoreControl.Stub() {
        @Override public String getEndpoint() {
            // 一行委托：全部逻辑在 CoreControlBinder（W5-R1-2：Stub 可运行 seam 与测试同路径）
            return controlBinder.getEndpoint();
        }

        @Override public String getStatusSummary() {
            // 一行委托：不递归（CoreControlBinder 无自调用）
            return controlBinder.getStatusSummary();
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
                AppLog.w("acceptLaunchPlan rejected: " + error);
            }
        }
    };

    private final RemoteCallbackList<ICoreControlCallback> callbacks = new RemoteCallbackList<>();

    private void broadcastStatus() {
        String summary = controlBinder.getStatusSummary();
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
        String endpoint = controlBinder.enforceBinderLimit(endpointRaw);
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
        AppLog.i("core service onCreate pid=" + corePid + " process=" + processName + " suffixInit=" + initializedHere);
        CrashGuard.install(this);
        bridge = loadBridge();
        main.post(this::boot);
    }

    private void boot() {
        try {
            // Select/validate the private v2 plan before touching the bundled Core.
            // A present external plan is authoritative; failure is reported rather
            // than silently falling back to the embedded identity.
            v2ComponentStore = new V2ComponentStore(getFilesDir());
            v2PlanStore = new V2PlanStore(getFilesDir());
            JSONObject privatePlan = v2PlanStore.readActive();
            v2RequestedPlan = privatePlan;
            JSONObject effectivePlan = V2PlanStore.resolveEffectivePlan(privatePlan, v2PlanStore.readLastGood(), v2PlanStore.recoveryState());
            if (effectivePlan != null) {
                try { V2PlanStore.validatePlan(effectivePlan, v2ComponentStore); }
                catch (Exception error) {
                    String failedId = effectivePlan.optJSONObject("core") == null ? "unknown" : effectivePlan.getJSONObject("core").optString("id", "unknown");
                    v2PlanStore.recordFailure(failedId, "plan_validation_failed");
                    AppLog.w("v2 plan validation failed; using embedded rescue: " + error.getMessage());
                    effectivePlan = null;
                }
            }
            if (effectivePlan != null) {
                v2SelectedPlan = effectivePlan;
                v2ExternalCore = true;
                launchPlan = new JSONObject(effectivePlan.toString());
                coreBundleVersion = effectivePlan.optJSONObject("core").optString("version", "unknown");
                bootV2(effectivePlan);
                return;
            }
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
            // W5-5：注入 ApiRouteRegistry（构建资产）——未挂载的 core 路由返回稳定 handler_not_mounted
            RouteRegistry registry = loadRouteRegistry();
            if (registry != null) dataServer.setRouteRegistry(registry);
            // W5-R1-1：命令门禁——只有 ready/degraded 才允许命令类请求（与状态机同一状态源）
            dataServer.setCommandGate(stateMachine::canSubmitCommands);
            dataServer.setCommandForwarder(createCommandForwarder());
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
                    AppLog.i("core-host console [" + message.messageLevel() + "] " + message.message() + " @" + message.sourceId() + ":" + message.lineNumber());
                    return true;
                }
            });
            coreWebView.addJavascriptInterface(new CoreNative(), "CoreNative");
            coreWebView.loadUrl(CoreHostAssetLoader.CORE_ORIGIN + "/assets/core-host.html");
            AppLog.i("core webview loading appassets core-host");
        } catch (Throwable error) {
            // 捕获 Throwable：任何 Error 不得杀掉 :core 进程进重启循环
            fail("boot_failed", error.getClass().getSimpleName() + ": " + error.getMessage());
        }
    }

    /** Configure the trusted appassets loader with a validated external plan. */
    private CoreDataServer.CommandForwarder createCommandForwarder() {
        return new CoreDataServer.CommandForwarder() {
            @Override public void forward(String bodyJson, java.util.function.Consumer<String> resultConsumer) {
                forwardCommand(bodyJson, resultConsumer);
            }

            @Override public String view() {
                return currentView();
            }

            @Override public void cancel(String requestId) {
                // R3-5/R7：客户端断开 → 经桥取消 JS 侧对应请求（abort AbortSignal，长模型请求停止）；
                // R7：pendingApi 立即移除（防悬挂回调堆积；迟到 protocol-result 因表无条目被忽略）
                String safeId = requestId == null ? "" : requestId.replace("\"", "");
                if (!safeId.isEmpty()) {
                    pendingApi.remove(safeId);
                    main.post(() -> {
                        if (coreWebView != null) {
                            coreWebView.evaluateJavascript(
                                "window.CoreHostBridge && window.CoreHostBridge.cancelPortableRequest(" + JSONObject.quote(safeId) + ")",
                                null);
                        }
                    });
                }
            }

            @Override public void forwardApi(String method, String path, Map<String, String> headers, String bodyJson, java.util.function.Consumer<String> resultConsumer) {
                forwardApiRequest(method, path, headers, bodyJson, resultConsumer);
            }

            @Override public void forwardApiTracked(String method, String path, Map<String, String> headers, String bodyJson,
                                                    java.util.function.Consumer<String> transportIdConsumer,
                                                    java.util.function.Consumer<String> resultConsumer) {
                // R5-4：api-* transport id 既用于 pending 表（结果回传），也作为取消 key——
                // CoreDataServer 断开时经 cancel(transportId) → protocol-cancel → JS abort。
                final String transportId = "api-" + System.currentTimeMillis() + "-" + pendingApiSequence.incrementAndGet();
                pendingApi.put(transportId, resultConsumer);
                transportIdConsumer.accept(transportId);
                try {
                    String headersJson = new JSONObject(headers).toString();
                    main.post(() -> {
                        if (coreWebView == null) {
                            java.util.function.Consumer<String> consumer = pendingApi.remove(transportId);
                            if (consumer != null) consumer.accept("{\"status\":503,\"body\":\"{\\\"error\\\":{\\\"code\\\":\\\"core_not_ready\\\",\\\"message\\\":\\\"core webview is not available\\\"}}\"}");
                            return;
                        }
                        coreWebView.evaluateJavascript(
                            "window.CoreHostBridge && window.CoreHostBridge.dispatchRequest("
                                + JSONObject.quote(transportId) + ","
                                + JSONObject.quote(method) + ","
                                + JSONObject.quote(path) + ","
                                + JSONObject.quote(headersJson) + ","
                                + JSONObject.quote(bodyJson) + ")",
                            null);
                    });
                } catch (Exception error) {
                    java.util.function.Consumer<String> consumer = pendingApi.remove(transportId);
                    if (consumer != null) consumer.accept("{\"status\":500,\"body\":\"{\\\"error\\\":{\\\"code\\\":\\\"bridge_failed\\\",\\\"message\\\":\\\"" + error.getMessage() + "\\\"}}\"}");
                }
            }
        };
    }

    private void bootV2(JSONObject plan) throws Exception {
        dataServer = new CoreDataServer(nonce = java.util.UUID.randomUUID().toString().replace("-", ""));
        RouteRegistry registry = loadRouteRegistry();
        if (registry != null) dataServer.setRouteRegistry(registry);
        dataServer.setCommandGate(stateMachine::canSubmitCommands);
        // v1 and v2 use the same data-plane bridge. Keep command/view/cancel and
        // portable API forwarding enabled for an externally selected Core too.
        dataServer.setCommandForwarder(createCommandForwarder());
        dataServer.start();
        coreWebView = new WebView(this);
        coreWebView.getSettings().setJavaScriptEnabled(true);
        coreWebView.getSettings().setAllowFileAccess(false);
        coreWebView.getSettings().setAllowContentAccess(false);
        coreWebView.setWebViewClient(new CoreHostAssetLoader(this, view -> fail("renderer_gone", "v2 core webview renderer crashed"), (view, url) -> {
            if (bridgeReady.compareAndSet(false, true)) {
                try {
                    String config = buildV2WebConfig(plan);
                    coreWebView.evaluateJavascript("window.StageCraftV2Config=" + config + ";", ignored -> setupWebMessageBridge());
                } catch (Exception error) {
                    bridgeReady.set(false);
                    fail("v2_config_failed", error.getMessage() == null ? "v2 config failed" : error.getMessage());
                }
            }
        }, v2ComponentStore, v2PlanStore, plan));
        coreWebView.addJavascriptInterface(new CoreNative(), "CoreNative");
        v2BootTimeout = () -> { if (!coreReady.get()) fail("v2_boot_timeout", "external Core did not complete ready handshake"); };
        main.postDelayed(v2BootTimeout, 15_000L);
        coreWebView.loadUrl(CoreHostAssetLoader.CORE_ORIGIN + "/assets/core-host.html");
    }

    private String buildV2WebConfig(JSONObject plan) throws Exception {
        JSONObject config = new JSONObject(); JSONObject core = plan.getJSONObject("core");
        JSONObject coreManifest = v2ComponentStore.read(core.optString("id"), core.optString("version"));
        config.put("request", new JSONObject().put("hostApiVersion", plan.optString("hostApiVersion")).put("selectedCore", core).put("pluginSelections", plan.optJSONArray("plugins") == null ? new org.json.JSONArray() : plan.getJSONArray("plugins")).put("planHash", plan.optString("planHash")));
        // core manifest 一并下发：页面侧宿主端口需要它计算 Core 自身的 granted 能力集合。
        config.put("core", new JSONObject().put("id", core.optString("id")).put("version", core.optString("version")).put("manifest", coreManifest).put("url", "/components/" + core.optString("id") + "/" + core.optString("version") + "/" + coreManifest.getJSONObject("entrypoints").getString("runtime")));
        org.json.JSONArray plugins = new org.json.JSONArray(); org.json.JSONArray selections = plan.optJSONArray("plugins"); if (selections != null) for (int i = 0; i < selections.length(); i++) { JSONObject selected = selections.getJSONObject(i); JSONObject manifest = v2ComponentStore.read(selected.getString("id"), selected.getString("version")); plugins.put(new JSONObject().put("id", selected.getString("id")).put("version", selected.getString("version")).put("manifest", manifest).put("url", "/components/" + selected.getString("id") + "/" + selected.getString("version") + "/" + manifest.getJSONObject("entrypoints").getString("runtime"))); }
        config.put("plugins", plugins); return config.toString();
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
        AppLog.i("web message bridge posted");
    }

    /** 页面 → 宿主消息（:core 主线程）：事件发布 / 就绪上报 / 日志。 */
    private void handleBridgeMessage(String json) {
        try {
            JSONObject message = new JSONObject(json);
            String type = message.optString("type");
            switch (type) {
                case "core-ready" -> {
                    // 幂等状态迁移：重复 ready 不重复广播
                    if (!stateMachine.onBridgeReady()) {
                        AppLog.w("core-ready ignored in state " + stateMachine.state().wire);
                        return;
                    }
                    coreReady.set(true);
                    JSONObject health = buildHealth(message.optJSONObject("measure"));
                    dataServer.setHealthJson(health.toString());
                    publishEndpointReady();
                    if (v2BootTimeout != null) { main.removeCallbacks(v2BootTimeout); v2BootTimeout = null; }
                    if (v2ExternalCore && v2PlanStore != null) try { v2PlanStore.markReady(v2SelectedPlan); } catch (Exception error) { AppLog.w("v2 last-good write failed: " + error); }
                }
                case "core-failed" -> fail(message.optString("code", "core_failed"), message.optString("message", "v2 Core failed"));
                case "core-event" -> {
                    if (dataServer != null) dataServer.publishCoreEvent(message.getJSONObject("event"));
                }
                case "protocol-result" -> {
                    // W4 合流：可移植 handler 的结果回传（requestId → 唤醒等待的 forwardApi）
                    String requestId = message.optString("requestId", "");
                    if (!requestId.isEmpty()) {
                        java.util.function.Consumer<String> consumer = pendingApi.remove(requestId);
                        if (consumer != null) {
                            JSONObject wrapped = new JSONObject()
                                .put("status", message.optInt("status", 200))
                                .put("body", message.optString("body", "{}"));
                            consumer.accept(wrapped.toString());
                        }
                    }
                }
                case "plugin-report" -> {
                    // W6：组合根 launch plan 隔离记录回报 → 存 health（主进程经数据面读取）
                    pluginQuarantine = message.optJSONArray("quarantine");
                    AppLog.i("plugin-report ok=" + message.optBoolean("ok", false)
                        + " quarantine=" + (pluginQuarantine == null ? 0 : pluginQuarantine.length()));
                    // 有隔离记录 → degraded（计划 §6.3：失败插件使 Core 降级，管理器仍可用）；
                    // 无隔离 → 保持当前状态（ready 幂等；degraded 由后续 core-ready 恢复）
                    if (pluginQuarantine != null && pluginQuarantine.length() > 0) {
                        stateMachine.onPluginQuarantined();
                    }
                    if (dataServer != null) {
                        dataServer.setHealthJson(buildHealth(null).toString());
                    }
                    // W6-2：事件驱动——隔离记录变化经 Binder status 广播（主进程 onStatus 触发 fetch）
                    broadcastStatus();
                }
                case "log" -> AppLog.i("core-host: " + message.optString("text"));
                default -> AppLog.w("unknown bridge message type: " + type);
            }
        } catch (Exception error) {
            AppLog.w("bridge message failed: " + error.getClass().getSimpleName());
        }
    }

    private JSONObject buildHealth(JSONObject measure) {
        try {
            JSONObject health = new JSONObject();
            health.put("protocolVersion", protocolVersion);
            health.put("minSupportedProtocolVersion", "1.0");
            health.put("maxSupportedProtocolVersion", "1.1");
            health.put("bridgeVersion", "core-service");
            // External v2 identity is taken from the validated private plan; it
            // must never be reported as the embedded artifact identity.
            JSONObject recovery = v2PlanStore == null ? null : v2PlanStore.recoveryState();
            org.json.JSONArray quarantine = recovery == null ? null : recovery.optJSONArray("quarantine");
            if (v2RequestedPlan != null || (quarantine != null && quarantine.length() > 0)) {
                JSONObject identity = buildV2HealthIdentity(v2RequestedPlan, v2SelectedPlan, recovery);
                health.put("requestedCore", identity.opt("requestedCore"));
                health.put("effectiveCore", identity.opt("effectiveCore"));
                health.put("coreBundleVersion", identity.opt("coreBundleVersion"));
                health.put("coreBundleHash", identity.opt("coreBundleHash"));
                health.put("recovery", recovery == null ? JSONObject.NULL : recovery);
            } else {
                health.put("effectiveCore", "bundled-default");
                health.put("coreBundleVersion", verifiedArtifact == null ? "unknown" : verifiedArtifact.version());
                health.put("coreBundleHash", verifiedArtifact == null ? "" : verifiedArtifact.sha256());
            }
            health.put("pluginSetHash", pluginSetHash);
            health.put("stateSchemaVersion", stateSchemaVersion);
            health.put("status", stateMachine.state().wire);
            health.put("pid", corePid);
            health.put("startedAt", startedAt);
            health.put("binderMaxPayloadBytes", controlBinder.maxPayloadBytes());
            if (launchPlan.length() > 0) health.put("launchPlan", launchPlan);
            // W6：插件隔离记录（组合根 plugin-report 回报；主进程 PluginManager 读取）
            if (pluginQuarantine != null) health.put("quarantine", pluginQuarantine);
            if (measure != null) health.put("measure", measure);
            return health;
        } catch (Exception error) {
            return new JSONObject();
        }
    }

    /** Pure v2 health identity seam; a failed requested plan has no selected plan. */
    static JSONObject buildV2HealthIdentity(JSONObject requestedPlan, JSONObject selectedPlan, JSONObject recovery) {
        try {
            JSONObject selected = selectedPlan == null ? null : selectedPlan.optJSONObject("core");
            JSONObject requested = requestedPlan == null ? null : requestedPlan.optJSONObject("core");
            return new JSONObject()
                .put("requestedCore", requested == null ? JSONObject.NULL : requested)
                .put("effectiveCore", selected == null ? "bundled-rescue" : selected)
                .put("coreBundleVersion", selected == null ? "unknown" : selected.optString("version", "unknown"))
                .put("coreBundleHash", selected == null ? "" : selected.optString("manifestHash", ""));
        } catch (Exception error) {
            return new JSONObject();
        }
    }

    private void publishEndpointReady() {
        AppLog.i("endpoint ready port=" + dataServer.getPort() + " status=ready");
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

    /**
     * W4 合流：协议端点请求转发——经桥把 method/path/headers/body 交给 Core WebView 内
     * 可移植 handler（CoreProtocolPortableHandler），结果以 protocol-result 桥消息回传。
     */
    private void forwardApiRequest(String method, String path, Map<String, String> headers, String bodyJson, java.util.function.Consumer<String> resultConsumer) {
        if (coreWebView == null) {
            resultConsumer.accept("{\"status\":503,\"body\":\"{\\\"error\\\":{\\\"code\\\":\\\"core_not_ready\\\",\\\"message\\\":\\\"core webview is not available\\\"}}\"}");
            return;
        }
        final String requestId = "api-" + System.currentTimeMillis() + "-" + pendingApiSequence.incrementAndGet();
        pendingApi.put(requestId, resultConsumer);
        try {
            String headersJson = new JSONObject(headers).toString();
            main.post(() -> {
                if (coreWebView == null) {
                    java.util.function.Consumer<String> consumer = pendingApi.remove(requestId);
                    if (consumer != null) consumer.accept("{\"status\":503,\"body\":\"{\\\"error\\\":{\\\"code\\\":\\\"core_not_ready\\\",\\\"message\\\":\\\"core webview is not available\\\"}}\"}");
                    return;
                }
                coreWebView.evaluateJavascript(
                    "window.CoreHostBridge && window.CoreHostBridge.dispatchRequest("
                        + JSONObject.quote(requestId) + ","
                        + JSONObject.quote(method) + ","
                        + JSONObject.quote(path) + ","
                        + JSONObject.quote(headersJson) + ","
                        + JSONObject.quote(bodyJson) + ")",
                    null);
            });
        } catch (Exception error) {
            java.util.function.Consumer<String> consumer = pendingApi.remove(requestId);
            if (consumer != null) consumer.accept("{\"status\":500,\"body\":\"{\\\"error\\\":{\\\"code\\\":\\\"bridge_failed\\\",\\\"message\\\":\\\"" + error.getMessage() + "\\\"}}\"}");
        }
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
            AppLog.w("crash-renderer terminate path failed: " + error);
        }
        coreWebView.evaluateJavascript(
            "(async function(){ return window.CoreHostBridge ? await window.CoreHostBridge.dispatch(" + JSONObject.quote(bodyJson) + ") : null })()",
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
            // W6：经桥把 plan 下发给 Core WebView 组合根（校验 + 隔离回报 plugin-report）
            String planJson = plan.toString();
            main.post(() -> {
                if (coreWebView != null) {
                    coreWebView.evaluateJavascript(
                        "window.CoreHostBridge && window.CoreHostBridge.applyLaunchPlan(" + JSONObject.quote(planJson) + ")",
                        null);
                }
            });
            // 若已 ready/degraded 则刷新 health（插件集身份进入数据面）
            CoreLifecycle.State state = stateMachine.state();
            if ((state == CoreLifecycle.State.READY || state == CoreLifecycle.State.DEGRADED) && dataServer != null) {
                dataServer.setHealthJson(buildHealth(null).toString());
            }
        } catch (Exception error) {
            AppLog.w("launch plan rejected: " + error);
        }
    }

    private void fail(String code, String message) {
        if (v2BootTimeout != null) { main.removeCallbacks(v2BootTimeout); v2BootTimeout = null; }
        stateMachine.onFailure(code);
        coreReady.set(false);
        if (v2ExternalCore && v2PlanStore != null && v2SelectedPlan != null) {
            try {
                String coreId = v2SelectedPlan.optJSONObject("core") == null ? "unknown" : v2SelectedPlan.getJSONObject("core").optString("id", "unknown");
                JSONObject recovery = v2PlanStore.recordFailure(coreId, code);
            } catch (Exception error) { AppLog.w("v2 failure state write failed: " + error); }
        }
        if (dataServer != null) dataServer.setHealthJson(buildHealth(null).toString());
        AppLog.w("core failed code=" + code + " message=" + message);
        if ("renderer_gone".equals(code)) {
            // renderer 证据独立落盘（评审：oneway 广播竞态导致主进程侧漏帧）——
            // 本文件由 :core 进程在 onRenderProcessGone 处理路径内同步写入，先于 stopSelf
            try {
                File evidence = new File(getExternalFilesDir(null), "app-renderer-gone.txt");
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
        return stateMachine.summary(String.valueOf(corePid), startedAt, protocolVersion);
    }

    private void stopGracefully() {
        if (!disposed.compareAndSet(false, true)) return;
        stateMachine.onStopRequested();
        main.post(() -> {
            final WebView view = coreWebView;
            if (view == null) {
                completeGracefulStop();
                return;
            }
            // Give the selected third-party Core a chance to release its own
            // resources before destroying the WebView. A bounded fallback
            // keeps a broken shutdown hook from holding the service forever.
            main.postDelayed(() -> completeGracefulStopIf(view), 2_000L);
            try {
                view.evaluateJavascript(
                    "window.CoreHostBridge && window.CoreHostBridge.shutdown(function(){ window.CoreNative && window.CoreNative.shutdownComplete(); })",
                    null);
            } catch (Exception error) {
                AppLog.w("core shutdown bridge failed: " + error.getMessage());
                completeGracefulStopIf(view);
            }
        });
    }

    private void completeGracefulStopIf(WebView expected) {
        if (coreWebView != expected) return;
        completeGracefulStop();
    }

    private void completeGracefulStop() {
        if (!stopCompleted.compareAndSet(false, true)) return;
        if (dataServer != null) dataServer.stop();
        if (coreWebView != null) {
            coreWebView.destroy();
            coreWebView = null;
        }
        stateMachine.onStopped();
        stopSelf();
    }

    /** W5-3 测试 seam：注入受控状态机（仅测试包使用；生产走 onCreate 默认 STARTING）。 */
    void setStateMachineForTest(CoreServiceStateMachine stateMachine) {
        if (stateMachine != null) this.stateMachine = stateMachine;
    }

    /** W5-3 测试 seam：当前状态（仅测试包使用）。 */
    CoreLifecycle.State stateForTest() {
        return stateMachine.state();
    }

    /** W5-3 测试 seam：驱动一次状态迁移（仅测试包使用；非法迁移抛 IllegalTransition）。 */
    void transitionForTest(CoreLifecycle.State next) {
        stateMachine.lifecycle().transition(next);
    }

    /** W5-3 测试 seam：控制面摘要（仅测试包使用）。 */
    JSONObject summaryForTest() {
        return stateMachine.summary(String.valueOf(corePid), startedAt, protocolVersion);
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
        @JavascriptInterface public void shutdownComplete() {
            // Javascript interfaces are called off the main thread on some
            // WebView versions; lifecycle and WebView teardown stay on main.
            main.post(CoreService.this::completeGracefulStop);
        }

        @JavascriptInterface public String invokeSync(String operation, String inputJson) {
            return bridge.invokeSync(operation, inputJson);
        }

        @JavascriptInterface public void invokeAsync(String operation, String inputJson, String callbackId) {
            // invokeAsync callbacks carry only stream payloads and the terminal result. A separate
            // "accepted" callback resolves the JS model promise before AndroidModelTransport finishes.
            bridge.invokeAsync(operation, inputJson, new CoreNativeBridge.Callback() {
                @Override public void onResult(org.json.JSONObject result) {
                    deliverAsync(callbackId, result.toString());
                }

                @Override public void onError(String message) {
                    deliverAsync(callbackId, errorMessageJson(message));
                }
            });
        }

        private void deliverAsync(String callbackId, String resultJson) {
            if (coreWebView == null || callbackId == null) return;
            main.post(() -> {
                if (coreWebView != null) {
                    coreWebView.evaluateJavascript(
                        "window.StageCraftNativeResult && window.StageCraftNativeResult.handle(" + JSONObject.quote(callbackId) + "," + JSONObject.quote(resultJson) + ")", null);
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

    /** 从 APK 资产加载 api-route-registry.json（构建期产物；加载失败返回 null，不阻断数据服务）。 */
    private RouteRegistry loadRouteRegistry() {
        try (java.io.InputStream input = getAssets().open("api-route-registry.json")) {
            byte[] bytes = new byte[input.available()];
            int read = input.read(bytes);
            String json = new String(bytes, 0, Math.max(0, read), StandardCharsets.UTF_8);
            return RouteRegistry.parse(json, null);
        } catch (Exception error) {
            AppLog.w("route registry load failed: " + error);
            return null;
        }
    }

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
        // v2 host.storage（逐能力授权）：caller 携带组件身份，V2ComponentStorage 校验
        // caller 组件 manifest 已声明 host.storage 能力后，才读写其命名空间（fail closed）。
        built.registerSync("storage.read", input -> new V2ComponentStorage(getFilesDir(), v2ComponentStore).read(input));
        built.registerSync("storage.write", input -> new V2ComponentStorage(getFilesDir(), v2ComponentStore).write(input));
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
            "preset.active-scope.set", "preset.save", "preset.delete", "prompt.gameplay.list",
            "story.create", "story.save", "story.saveAs", "story.delete",
            "archive.save", "archive.list", "archive.load", "archive.delete",
            "model.cancel",
        }) {
            built.registerSync(operation, input -> coreOperations.invokeSync(operation, input));
        }
        // 异步端口：模型请求 / 故事读取（invoke 返回可取消句柄——模型请求超时可取消底层 transport）
        built.registerAsync("model.request", (operation, input, callback) -> {
            coreOperations.invoke(operation, input, new AndroidNativeOperations.Callback() {
                @Override public void onResult(org.json.JSONObject result) { callback.onResult(result); }
                @Override public void onError(String message) { callback.onError(message); }
            });
            return () -> {
                try {
                    coreOperations.invokeSync("model.cancel", new org.json.JSONObject().put("requestId", input.optString("requestId", "")));
                } catch (Exception ignored) { }
            };
        });
        built.registerAsync("story.read", (operation, input, callback) -> {
            coreOperations.invoke(operation, input, new AndroidNativeOperations.Callback() {
                @Override public void onResult(org.json.JSONObject result) { callback.onResult(result); }
                @Override public void onError(String message) { callback.onError(message); }
            });
            return null;
        });
    }
}
