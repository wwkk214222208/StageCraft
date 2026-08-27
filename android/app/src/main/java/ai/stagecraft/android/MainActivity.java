package ai.stagecraft.android;

import android.app.Activity;
import android.content.pm.ApplicationInfo;
import android.content.Intent;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebChromeClient;

public final class MainActivity extends Activity {
    private static final int PICK_CHARACTER_CARD = 7001;
    private static final int CREATE_EXPORT_DOCUMENT = 7002;
    private static final int OPEN_STORY_DOCUMENT = 7003;
    private WebView webView;
    private NativeBridge bridge;
    private OfflineLoopbackServer offlineServer;
    private WebChromeClient webChromeClient;

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
        webChromeClient = new WebChromeClient();
        webView.setWebChromeClient(webChromeClient);
        // 离线完整 Web UI 走 127.0.0.1 环回服务器（http://localhost 常规 Web 语义，见 OfflineLoopbackServer）
        OfflineLoopbackServer loopback = null;
        try {
            loopback = new OfflineLoopbackServer(this);
        } catch (Exception initFailure) {
            loopback = null;
        }
        offlineServer = loopback;
        final OfflineLoopbackServer server = loopback;
        webView.setWebViewClient(new StageCraftWebViewClient(this, () -> bridge.currentCredential(), server == null ? null : path -> server.urlFor(path)));
        setContentView(webView);
        // APK defaults to the packaged full Web UI. Remote pairing remains available
        // through the existing native bridge and can be exposed by a redesigned UI later.
        showLocalUi();
    }

    /** Package-visible test hook; does not expose the WebView outside the app package. */
    WebView testingWebView() { return webView; }
    WebChromeClient testingWebChromeClient() { return webChromeClient; }

    /** Open the packaged full Web UI directly, without passing through the pairing renderer. */
    void showLocalUi() {
        String localUrl = offlineServer == null
            ? StageCraftWebViewClient.LOCAL_ORIGIN + "/web/offline.html"
            : offlineServer.urlFor("/web/offline.html");
        webView.loadUrl(localUrl);
    }

    /** 配对成功 / 会话恢复后：切换到 PC 完整 Web UI（令牌由 StageCraftWebViewClient 注入）。 */
    void showRemoteUi(String address) {
        if (address == null || address.isEmpty()) return;
        webView.loadUrl(address);
    }

    /** 会话失效 / 清除后：回到本地配对页（远程模式）。 */
    void showPairingPage() {
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
        if (offlineServer != null) offlineServer.close();
        if (bridge != null) bridge.close();
        if (webView != null) {
            webView.removeJavascriptInterface("StageCraftNative");
            webView.stopLoading();
            webView.destroy();
        }
        super.onDestroy();
    }
}
