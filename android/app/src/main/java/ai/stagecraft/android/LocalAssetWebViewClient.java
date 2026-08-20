package ai.stagecraft.android;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.IOException;
import java.io.ByteArrayInputStream;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

public final class LocalAssetWebViewClient extends WebViewClient {
    public static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final Map<String, String> ASSETS;
    static {
        Map<String, String> assets = new HashMap<>();
        assets.put("/index.html", "text/html");
        assets.put("/styles.css", "text/css");
        assets.put("/renderer.js", "text/javascript");
        ASSETS = Collections.unmodifiableMap(assets);
    }
    private final Context context;

    public LocalAssetWebViewClient(Context context) {
        this.context = context;
    }

    @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri url = request.getUrl();
        if (!"https".equals(url.getScheme()) || !"appassets.androidplatform.net".equals(url.getHost())) return forbidden();
        String mime = ASSETS.get(url.getPath());
        if (mime == null) return forbidden();
        try {
            String name = url.getPath().substring(1);
            return new WebResourceResponse(mime, "UTF-8", context.getAssets().open(name));
        } catch (IOException error) {
            return forbidden();
        }
    }

    @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri url = request.getUrl();
        if (!request.isForMainFrame()) return true;
        boolean trusted = "https".equals(url.getScheme()) && "appassets.androidplatform.net".equals(url.getHost()) && "/index.html".equals(url.getPath());
        if (trusted) return false;
        if (request.isForMainFrame() && ("https".equals(url.getScheme()) || "http".equals(url.getScheme()))) {
            try { context.startActivity(new Intent(Intent.ACTION_VIEW, url)); } catch (Exception ignored) { }
        }
        return true;
    }

    private WebResourceResponse forbidden() {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", headers, new ByteArrayInputStream(new byte[0]));
    }
}
