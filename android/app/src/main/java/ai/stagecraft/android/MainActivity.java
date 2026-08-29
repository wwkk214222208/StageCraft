package ai.stagecraft.android;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.pm.ApplicationInfo;
import android.content.Intent;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.JsPromptResult;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebChromeClient;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.Map;

public final class MainActivity extends Activity {
    private static final int PICK_CHARACTER_CARD = 7001;
    private static final int CREATE_EXPORT_DOCUMENT = 7002;
    private static final int OPEN_STORY_DOCUMENT = 7003;
    private WebView webView;
    private NativeBridge bridge;
    /** W6：主进程同源 UI gateway（页面 origin；静态资产 + /api/* registry 分派）。 */
    private CoreGatewayServer gateway;
    /** 回退：gateway 启动失败时的旧静态服务器。 */
    private LocalLoopbackServer localServer;
    private WebChromeClient webChromeClient;
    /** W6：Core 进程连接（bindService/握手/重绑/launch plan）。 */
    private CoreConnection coreConnection;
    /** W6：插件配置持久化（主进程独立，Core 不可用时仍可读写）。 */
    private PluginConfigStore pluginConfigStore;
    /** W6：插件管理状态（desired/effective/quarantined + launch plan）。 */
    private PluginManager pluginManager;
    private volatile boolean coreReady;
    private volatile String lastCoreStatus = "";

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webView = new WebView(this);
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debuggable);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(false);
        settings.setDatabaseEnabled(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        CookieManager.getInstance().setAcceptCookie(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        EmbeddedCoreArtifact.Verification embeddedCore = EmbeddedCoreArtifact.verify(this);
        bridge = new NativeBridge(this, webView, new RemoteSessionStore(this), embeddedCore);
        webView.addJavascriptInterface(bridge, "StageCraftNative");
        // Enable browser dialogs used by the Web UI (prompt/confirm/alert).
        // WebView 默认不实现 onJsPrompt（prompt() 会静默失败）——「与电脑同步」绑定等流程依赖它输入地址/配对码。
        webChromeClient = new WebChromeClient() {
            @Override public boolean onJsPrompt(WebView view, String url, String message, String defaultValue, JsPromptResult result) {
                LinearLayout layout = new LinearLayout(MainActivity.this);
                layout.setOrientation(LinearLayout.VERTICAL);
                layout.setPadding(48, 16, 48, 16);
                TextView label = new TextView(MainActivity.this);
                label.setText(message);
                layout.addView(label);
                EditText input = new EditText(MainActivity.this);
                if (defaultValue != null) input.setText(defaultValue);
                layout.addView(input);
                new AlertDialog.Builder(MainActivity.this)
                    .setTitle("StageCraft")
                    .setView(layout)
                    .setPositiveButton(android.R.string.ok, (dialog, which) -> result.confirm(input.getText().toString()))
                    .setNegativeButton(android.R.string.cancel, (dialog, which) -> result.cancel())
                    .setOnCancelListener(dialog -> result.cancel())
                    .show();
                return true;
            }

            @Override public void onProgressChanged(WebView view, int newProgress) {
                // page-ready 证据（评审 R6）：进度 100 且 URL 含 mode=remote 时落盘——
                // 恢复链验证以此证明远程页"完成加载"而非仅调用了 loadUrl
                if (newProgress >= 100 && view.getUrl() != null && view.getUrl().contains("mode=remote")) {
                    GateALog.i("main webview page ready: " + view.getUrl());
                }
            }
        };
        webView.setWebChromeClient(webChromeClient);
        // W6：主进程同源 UI gateway（静态资产 + /api/* registry 分派）。
        // 页面 origin 由 gateway 持有；启动失败回退旧 LocalLoopbackServer（静态面）。
        RouteRegistry registry = loadRouteRegistry();
        CoreGatewayServer gatewayServer = null;
        if (registry != null) {
            try {
                gatewayServer = new CoreGatewayServer(this, registry);
                gatewayServer.setHostHandlers(this::hostHandlerFor);
            } catch (Exception initFailure) {
                GateALog.w("core gateway init failed: " + initFailure);
                gatewayServer = null;
            }
        }
        gateway = gatewayServer;
        LocalLoopbackServer loopback = null;
        if (gateway == null) {
            try {
                loopback = new LocalLoopbackServer(this);
            } catch (Exception initFailure) {
                loopback = null;
            }
        }
        localServer = loopback;
        final CoreGatewayServer gatewayFinal = gateway;
        final LocalLoopbackServer server = loopback;
        webView.setWebViewClient(new StageCraftWebViewClient(this, () -> bridge.currentCredential(),
            path -> gatewayFinal != null ? gatewayFinal.urlFor(path) : (server == null ? null : server.urlFor(path))));
        setContentView(webView);
        // W6：Core 进程连接与插件配置存储（Core 不可用时仍可用）。
        pluginConfigStore = new PluginConfigStore(this);
        pluginManager = new PluginManager(pluginConfigStore);
        coreConnection = new CoreConnection(this, new CoreConnection.Listener() {
            @Override public void onEndpointReady(JSONObject endpoint) {
                handleEndpointReady(endpoint);
            }

            @Override public void onStatus(JSONObject summary) {
                lastCoreStatus = summary.optString("status", "");
                GateALog.i("core status: " + lastCoreStatus);
            }

            @Override public void onCoreDisconnected() {
                coreReady = false;
                GateALog.w("core disconnected; recovery path available");
                // 页面由 CoreClient 的重连逻辑驱动；主进程保持绑定自动重建（BIND_AUTO_CREATE）
            }
        });
        // APK defaults to the packaged full Web UI. Remote pairing remains available
        // through the existing native bridge and can be exposed by a redesigned UI later.
        // Deep link：携带 OPEN_REMOTE_ENTRY extra 的启动（如 Core 不可用时的恢复页"远程模式入口"）
        // 直接打开远程/配对页，而非默认本地完整 UI。
        if ("remote-entry".equals(getIntent().getStringExtra("gatea_entry"))) {
            showPairingPage();
        } else {
            showLocalUi();
        }
        GateALog.init(this);
        GateALog.i("main activity ready (entry=" + getIntent().getStringExtra("gatea_entry") + ")");
        // W6：绑定 CoreService 并握手（endpoint/nonce → gateway；launch plan → :core）
        coreConnection.bind();
        if (registry != null && gateway != null) {
            GateALog.i("core gateway listening on " + gateway.baseUrl() + " registry=" + registry.registryVersion());
        }
    }

    /** 加载构建期 api-route-registry.json（与 :core 同一资产）。 */
    private RouteRegistry loadRouteRegistry() {
        try (java.io.InputStream input = getAssets().open("api-route-registry.json")) {
            byte[] bytes = new byte[input.available()];
            int read = input.read(bytes);
            return RouteRegistry.parse(new String(bytes, 0, Math.max(0, read), java.nio.charset.StandardCharsets.UTF_8), null);
        } catch (Exception error) {
            GateALog.w("route registry load failed: " + error);
            return null;
        }
    }

    /** W6：main-host 路由的宿主 handler 注册表（handlerId → 主进程实现）。 */
    private CoreGatewayServer.HostHandler hostHandlerFor(String handlerId) {
        switch (handlerId) {
            case "host.remote.pairing-code":
            case "host.remote.revoke":
            case "host.remote.sync.get":
            case "host.remote.sync.put":
            case "host.version":
            case "host.update.check":
            case "host.update.download":
            case "host.restart":
                return (method, path, headers, bodyJson) -> handleMainHostRoute(handlerId, method, path, headers, bodyJson);
            default:
                return null;
        }
    }

    /** W6：main-host 路由的宿主实现（配对/同步/版本/更新/重启走 NativeBridge 或稳定占位）。 */
    private String handleMainHostRoute(String handlerId, String method, String path, Map<String, String> headers, String bodyJson) throws Exception {
        switch (handlerId) {
            case "host.version": {
                // 构建期 version.json
                try (java.io.InputStream input = getAssets().open("version.json")) {
                    byte[] bytes = new byte[input.available()];
                    int read = input.read(bytes);
                    String json = new String(bytes, 0, Math.max(0, read), java.nio.charset.StandardCharsets.UTF_8);
                    return "{\"status\":200,\"body\":" + json + "}";
                }
            }
            case "host.remote.sync.get": {
                JSONObject result = new JSONObject();
                result.put("status", 200);
                JSONObject body = new JSONObject();
                body.put("paired", bridge != null && bridge.currentCredential() != null && !bridge.currentCredential().isEmpty());
                result.put("body", body.toString());
                return result.toString();
            }
            case "host.restart": {
                // 重启 Core（插件配置变更后生效）：请求优雅停止 → BIND_AUTO_CREATE 自动重建
                if (coreConnection != null) coreConnection.requestStop();
                return "{\"status\":200,\"body\":\"{\\\"ok\\\":true,\\\"restarting\\\":true}\"}";
            }
            default:
                // 迁移期占位：配对/更新等仍走 NativeBridge 原生通道，HTTP 面返回稳定不可用
                return "{\"status\":501,\"body\":\"{\\\"error\\\":{\\\"code\\\":\\\"host_handler_unavailable\\\",\\\"message\\\":\\\"handler 迁移中: " + handlerId + "\\\"}}\"}";
        }
    }

    /** W6：Core endpoint 就绪 → gateway 注入（nonce 只进原生连接层）；传递 launch plan。 */
    private synchronized void handleEndpointReady(JSONObject endpoint) {
        try {
            if (gateway != null) {
                gateway.setCoreEndpoint(endpoint.optInt("port"), endpoint.optString("nonce"));
                GateALog.i("core endpoint ready: port=" + endpoint.optInt("port") + " pid=" + endpoint.optInt("pid") + " nonce=<native-only>");
            }
            coreReady = true;
            // 传递 PluginLaunchPlan（主进程配置 → :core；不可变；插件配置变更后 regenerate 并重启）
            JSONObject plan = pluginManager == null ? null : pluginManager.buildLaunchPlan();
            if (plan == null) plan = buildDefaultLaunchPlan();
            if (coreConnection != null) coreConnection.acceptLaunchPlan(plan);
        } catch (Exception error) {
            GateALog.w("endpoint ready handling failed: " + error);
        }
    }

    /** W6：默认 launch plan（无已存 plan 时；插件集由构建期 manifest 决定，这里用空集 + 身份标记）。 */
    private JSONObject buildDefaultLaunchPlan() {
        JSONObject plan = new JSONObject();
        try {
            plan.put("protocolVersion", "1.1");
            plan.put("pluginSetHash", "default-empty");
            plan.put("plugins", new org.json.JSONArray());
            plan.put("stateSchemaVersion", "unknown");
        } catch (Exception ignored) { }
        return plan;
    }

    /** Package-visible test hook; does not expose the WebView outside the app package. */
    WebView testingWebView() { return webView; }
    WebChromeClient testingWebChromeClient() { return webChromeClient; }

    /** Open the packaged full Web UI directly, without passing through the pairing renderer. */
    void showLocalUi() {
        String localUrl;
        if (gateway != null) {
            localUrl = gateway.urlFor("/web/local.html");
        } else if (localServer != null) {
            localUrl = localServer.urlFor("/web/local.html");
        } else {
            localUrl = StageCraftWebViewClient.LOCAL_ORIGIN + "/web/local.html";
        }
        GateALog.i("main webview load: " + localUrl);
        webView.loadUrl(localUrl);
    }

    /** 配对成功 / 会话恢复后：切换到 PC 完整 Web UI（令牌由 StageCraftWebViewClient 注入）。 */
    void showRemoteUi(String address) {
        if (address == null || address.isEmpty()) return;
        webView.loadUrl(address);
    }

    /** 会话失效 / 清除后：回到本地配对页（远程模式）。 */
    void showPairingPage() {
        GateALog.i("main webview load: " + StageCraftWebViewClient.LOCAL_ORIGIN + "/index.html?mode=remote");
        webView.loadUrl(StageCraftWebViewClient.LOCAL_ORIGIN + "/index.html?mode=remote");
    }

    @Override protected void onStart() {
        super.onStart();
        if (bridge != null) bridge.onForeground();
    }

    void openCharacterCardPicker() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("image/png");
        startActivityForResult(intent, PICK_CHARACTER_CARD);
    }

    void openStoryDocument() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/zip");
        startActivityForResult(intent, OPEN_STORY_DOCUMENT);
    }

    void createExportDocument(String mimeType, String suggestedName) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mimeType);
        intent.putExtra(Intent.EXTRA_TITLE, suggestedName);
        startActivityForResult(intent, CREATE_EXPORT_DOCUMENT);
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == PICK_CHARACTER_CARD && resultCode == RESULT_OK && data != null && bridge != null) {
            bridge.importCharacterCard(data.getData());
        } else if (requestCode == OPEN_STORY_DOCUMENT && bridge != null) {
            bridge.importStoryDocument(resultCode == RESULT_OK && data != null ? data.getData() : null);
        } else if (requestCode == CREATE_EXPORT_DOCUMENT && bridge != null) {
            bridge.completeExportDocument(resultCode == RESULT_OK && data != null ? data.getData() : null);
        }
    }

    @Override protected void onStop() {
        if (bridge != null) bridge.onBackground();
        super.onStop();
    }

    @Override protected void onDestroy() {
        if (coreConnection != null) coreConnection.unbind();
        if (gateway != null) gateway.close();
        if (localServer != null) localServer.close();
        if (bridge != null) bridge.close();
        if (webView != null) {
            webView.removeJavascriptInterface("StageCraftNative");
            webView.stopLoading();
            webView.destroy();
        }
        super.onDestroy();
    }
}
