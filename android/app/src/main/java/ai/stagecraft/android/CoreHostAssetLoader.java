package ai.stagecraft.android;

import android.content.Context;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Map;

/**
 * Core host 页面资产加载器（Q7 裁决）：用 appassets HTTPS 虚拟域
 * （https://appassets.androidplatform.net/assets/**）加载 APK 内静态资产，
 * 等价 androidx.webkit WebViewAssetLoader 的最小实现——不引入新依赖、禁止 file://、
 * 也不为静态资产再起一个 Core 环回服务器。
 *
 * 边界：只服务静态资产字节；业务数据全部经 CoreDataServer + 进程内桥驱动，
 * 页面零外发业务 HTTP 请求。这里不承载 SSE 数据流（§5.4 禁令不因本类破例）。
 */
public final class CoreHostAssetLoader extends WebViewClient {
    public static final String CORE_HOST = "appassets.androidplatform.net";
    public static final String CORE_ORIGIN = "https://" + CORE_HOST;
    private static final String ASSET_PREFIX = "/assets/";

    public interface RenderGoneListener { void onRenderProcessGone(WebView view); }

    private final Context context;
    private final RenderGoneListener renderGoneListener;

    public CoreHostAssetLoader(Context context, RenderGoneListener renderGoneListener) {
        this.context = context.getApplicationContext();
        this.renderGoneListener = renderGoneListener;
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        if (!CORE_HOST.equals(request.getUrl().getHost())) return null;
        String path = request.getUrl().getPath();
        if (path == null || !path.startsWith(ASSET_PREFIX)) return null;
        String assetPath = path.substring(ASSET_PREFIX.length());
        try {
            InputStream input = context.getAssets().open(assetPath);
            return new WebResourceResponse(mimeFor(assetPath), null, input);
        } catch (IOException error) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                Map.of("content-type", "text/plain"), new ByteArrayInputStream("asset not found".getBytes()));
        }
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        // 页面禁止外部导航（Q7）：appassets 之外的一切导航一律拒绝。
        return !CORE_HOST.equals(request.getUrl().getHost());
    }

    @Override
    public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
        // renderer 崩溃：通知宿主进入失败路径；返回 true 表示 WebView 已被本类处置。
        if (renderGoneListener != null) renderGoneListener.onRenderProcessGone(view);
        if (view != null) view.destroy();
        return true;
    }

    static String mimeFor(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js")) return "text/javascript";
        if (path.endsWith(".json")) return "application/json";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".png")) return "image/png";
        if (path.endsWith(".svg")) return "image/svg+xml";
        return "application/octet-stream";
    }
}
