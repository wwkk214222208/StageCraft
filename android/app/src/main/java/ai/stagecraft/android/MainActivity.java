package ai.stagecraft.android;

import android.app.Activity;
import android.content.pm.ApplicationInfo;
import android.content.Intent;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;

public final class MainActivity extends Activity {
    private static final int PICK_CHARACTER_CARD = 7001;
    private WebView webView;
    private NativeBridge bridge;

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
        webView.setWebViewClient(new StageCraftWebViewClient(this, () -> bridge.currentCredential()));
        setContentView(webView);
        // 默认进入远程配对页（?mode=remote）；本地嵌入模式经配对页按钮进入（?mode=local）。
        webView.loadUrl(StageCraftWebViewClient.LOCAL_ORIGIN + "/index.html?mode=remote");
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

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == PICK_CHARACTER_CARD && resultCode == RESULT_OK && data != null && bridge != null) {
            bridge.importCharacterCard(data.getData());
        }
    }

    @Override protected void onStop() {
        if (bridge != null) bridge.onBackground();
        super.onStop();
    }

    @Override protected void onDestroy() {
        if (bridge != null) bridge.close();
        if (webView != null) {
            webView.removeJavascriptInterface("StageCraftNative");
            webView.stopLoading();
            webView.destroy();
        }
        super.onDestroy();
    }
}
