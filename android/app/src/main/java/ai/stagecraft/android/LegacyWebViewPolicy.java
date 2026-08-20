package ai.stagecraft.android;

import android.net.Uri;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/** Security policy for legacy card content. It intentionally installs no native bridge. */
public final class LegacyWebViewPolicy {
    private LegacyWebViewPolicy() { }

    public static void configure(WebView view, String assetId) {
        WebSettings settings = view.getSettings();
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
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false);
        view.setWebViewClient(new LegacyClient(assetId));
    }

    public static boolean isAllowed(String rawUrl, String assetId) {
        try {
            Uri url = Uri.parse(rawUrl);
            String prefix = "/legacy/" + Uri.encode(assetId) + "/";
            return "https".equals(url.getScheme())
                    && "appassets.androidplatform.net".equals(url.getHost())
                    && url.getUserInfo() == null
                    && url.getPath() != null
                    && url.getPath().startsWith(prefix)
                    && !url.getPath().contains("..")
                    && !url.getQueryParameterNames().iterator().hasNext();
        } catch (Exception ignored) { return false; }
    }

    private static final class LegacyClient extends WebViewClient {
        private final String assetId;
        LegacyClient(String assetId) { this.assetId = assetId; }
        @Override public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest request) {
            return !isAllowed(request.getUrl().toString(), assetId);
        }
    }
}
