package ai.stagecraft.android;

import android.content.Context;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
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

    /** 页面加载完成回调：WebMessage 端口必须在此时下发，早于页面监听器注册会被丢弃。 */
    public interface PageLoadListener { void onPageFinished(WebView view, String url); }

    private final Context context;
    private final RenderGoneListener renderGoneListener;
    private final PageLoadListener pageLoadListener;
    private final V2ComponentStore componentStore;
    private final V2PlanStore planStore;
    private final org.json.JSONObject effectivePlan;

    public CoreHostAssetLoader(Context context, RenderGoneListener renderGoneListener, PageLoadListener pageLoadListener) {
        this(context, renderGoneListener, pageLoadListener, null, null, null);
    }

    public CoreHostAssetLoader(Context context, RenderGoneListener renderGoneListener, PageLoadListener pageLoadListener, V2ComponentStore componentStore, V2PlanStore planStore) {
        this(context, renderGoneListener, pageLoadListener, componentStore, planStore, null);
    }

    public CoreHostAssetLoader(Context context, RenderGoneListener renderGoneListener, PageLoadListener pageLoadListener, V2ComponentStore componentStore, V2PlanStore planStore, org.json.JSONObject effectivePlan) {
        this.context = context.getApplicationContext();
        this.renderGoneListener = renderGoneListener;
        this.pageLoadListener = pageLoadListener;
        this.componentStore = componentStore;
        this.planStore = planStore;
        this.effectivePlan = effectivePlan;
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        if (!CORE_HOST.equals(request.getUrl().getHost())) return null;
        String path = request.getUrl().getPath();
        if (path == null) return null;
        WebResourceResponse v2 = resolveV2(path);
        if (v2 != null) return v2;
        if (!path.startsWith(ASSET_PREFIX)) return null;
        String assetPath = path.substring(ASSET_PREFIX.length());
        try {
            InputStream input = context.getAssets().open(assetPath);
            return new WebResourceResponse(mimeFor(assetPath), null, input);
        } catch (IOException error) {
            Map<String, String> headers = new java.util.HashMap<>();
            headers.put("content-type", "text/plain");
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, new ByteArrayInputStream("asset not found".getBytes()));
        }
    }

    /** Read-only private-store resolver for the v2 plan; APK /assets remains unchanged. */
    private WebResourceResponse resolveV2(String path) {
        if (componentStore == null || planStore == null || (!path.equals("/v2/launch-plan.json") && !path.startsWith("/components/"))) return null;
        try {
            org.json.JSONObject plan = effectivePlan != null ? effectivePlan : planStore.readActive(); if (plan == null) return notFound(); V2PlanStore.validatePlan(plan, componentStore);
            if (path.equals("/v2/launch-plan.json")) return bytesResponse("application/json", plan.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
            String[] parts = path.substring("/components/".length()).split("/", -1); if (parts.length < 3 || parts[0].isEmpty() || parts[1].isEmpty()) return forbidden();
            String id = android.net.Uri.decode(parts[0]); String version = android.net.Uri.decode(parts[1]); StringBuilder entryText = new StringBuilder(); for (int i = 2; i < parts.length; i++) { if (i > 2) entryText.append('/'); entryText.append(parts[i]); } String entry = android.net.Uri.decode(entryText.toString());
            boolean selected = selectionMatches(plan.optJSONObject("core"), id, version); org.json.JSONArray plugins = plan.optJSONArray("plugins"); if (!selected && plugins != null) for (int i = 0; i < plugins.length(); i++) if (selectionMatches(plugins.optJSONObject(i), id, version)) selected = true;
            if (!selected) return forbidden();
            org.json.JSONObject manifest = componentStore.read(id, version); org.json.JSONObject entries = manifest.getJSONObject("entrypoints"); if (!entry.equals(entries.optString("runtime")) && !entry.equals(entries.optString("ui"))) return forbidden();
            File root = new File(componentStore.root(), id + File.separator + version); File file = new File(root, entry); String canonicalRoot = root.getCanonicalPath() + File.separator; String canonicalFile = file.getCanonicalPath(); if (!canonicalFile.startsWith(canonicalRoot) || !file.isFile()) return notFound();
            return new WebResourceResponse(mimeFor(entry), "utf-8", 200, "OK", noStore(), new FileInputStream(file));
        } catch (IllegalArgumentException error) { return forbidden(); } catch (Exception error) { return notFound(); }
    }

    private static boolean selectionMatches(org.json.JSONObject selection, String id, String version) { return selection != null && id.equals(selection.optString("id")) && version.equals(selection.optString("version")); }
    private static Map<String, String> noStore() { Map<String, String> headers = new java.util.HashMap<>(); headers.put("Cache-Control", "no-store"); return headers; }
    private static WebResourceResponse bytesResponse(String mime, byte[] bytes) { return new WebResourceResponse(mime, "utf-8", 200, "OK", noStore(), new ByteArrayInputStream(bytes)); }
    private static WebResourceResponse notFound() { return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", noStore(), new ByteArrayInputStream("Not Found".getBytes())); }
    private static WebResourceResponse forbidden() { return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", noStore(), new ByteArrayInputStream("Forbidden".getBytes())); }

    @Override
    public void onPageFinished(WebView view, String url) {
        AppLog.i("core host page finished: " + url);
        if (pageLoadListener != null) pageLoadListener.onPageFinished(view, url);
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
