package ai.stagecraft.android;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * WebView 客户端：既服务本地资产（配对页 / 本地核心模式），也在远程配对后直接加载 PC 端完整 Web UI。
 *
 * 远程模式令牌注入：
 * - 页面自身通过补丁后的 fetch / XHR / EventSource 携带 Bearer（由注入 bootstrap 脚本完成，POST 等带 body 的请求保留原生通道）；
 * - 图片等无头请求（/assets、/story-assets、/custom）在 shouldInterceptRequest 里用 Bearer 重新拉取；
 * - 主页面 HTML 由这里以 Bearer 拉取并在 <head> 注入 bootstrap 脚本（早于 app.js 执行）。
 */
public final class StageCraftWebViewClient extends WebViewClient {
    public static final String LOCAL_ORIGIN = "https://appassets.androidplatform.net";

    public interface CredentialProvider {
        /** 当前已配对会话的 Bearer token；未配对返回 null。 */
        String currentCredential();
    }

    private final Context context;
    private final CredentialProvider credentialProvider;

    public StageCraftWebViewClient(Context context, CredentialProvider credentialProvider) {
        this.context = context;
        this.credentialProvider = credentialProvider;
    }

    @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri url = request.getUrl();
        String scheme = url.getScheme();
        String host = url.getHost();
        if ("https".equals(scheme) && "appassets.androidplatform.net".equals(host)) return serveLocalAsset(url);

        String credential = credentialProvider == null ? null : credentialProvider.currentCredential();
        if (credential == null || credential.isEmpty()) return null;
        String method = request.getMethod() == null ? "GET" : request.getMethod().toUpperCase(Locale.ROOT);
        // POST/PUT/DELETE 等带 body 的请求由注入脚本补丁后的 fetch/XHR 携带 token，WebView 无法在拦截层转发 body。
        if (!"GET".equals(method) && !"HEAD".equals(method)) return null;
        // 已带 Authorization（来自补丁后的 fetch/XHR/EventSource）→ 交给 WebView 原生处理。
        if (request.getRequestHeaders() != null && request.getRequestHeaders().containsKey("Authorization")) return null;
        String path = url.getPath() == null ? "/" : url.getPath();
        boolean protectedPath = isProtectedPath(path);
        // 未受保护的非主框架资源（app.js/style.css 等）无需令牌，原生加载。
        if (!protectedPath && !request.isForMainFrame()) return null;
        return fetchWithToken(url, credential, request.isForMainFrame());
    }

    @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        if (!request.isForMainFrame()) return true;
        Uri url = request.getUrl();
        String scheme = url.getScheme();
        String host = url.getHost();
        if ("https".equals(scheme) && "appassets.androidplatform.net".equals(host)) return false;
        if ("http".equals(scheme) || "https".equals(scheme)) return false; // 远程 UI 保持在本 WebView 内
        return true;
    }

    private WebResourceResponse serveLocalAsset(Uri url) {
        String path = url.getPath() == null ? "/" : url.getPath();
        String mime = mimeFor(path);
        if (mime == null) return forbidden();
        String assetPath = localAssetPath(path);
        if (assetPath == null) return forbidden();
        try {
            InputStream input = openLocalAsset(assetPath);
            if (input == null) return forbidden();
            return new WebResourceResponse(mime, "UTF-8", input);
        } catch (IOException error) {
            return forbidden();
        }
    }

    /** 本地 asset 路径映射：配对页/核心文件在根目录；Web UI（public 打包）在 web/，
     *  其中的资源公约为根路径引用（/app.js、/style.css、/core-client.js 等），映射到 web/；
     *  头像资源 /assets/** 取自打包的 public/assets，剧本自包含资源 /story-assets/<id>/<file>
     *  取自 stories/{default,custom}/<id>.assets/。拒绝路径穿越。 */
    private static String localAssetPath(String path) {
        if (path.contains("..")) return null;
        if (path.startsWith("/story-assets/")) {
            String remaining = path.substring("/story-assets/".length());
            int slash = remaining.indexOf('/');
            if (slash <= 0 || slash == remaining.length() - 1) return null;
            String id = remaining.substring(0, slash);
            String file = remaining.substring(slash + 1);
            return id + ".assets/" + file; // resolved against stories/{default,custom}/
        }
        if (path.startsWith("/assets/") || path.startsWith("/custom/")) return "web" + path;
        if (path.startsWith("/web/")) return path.substring(1);
        // 根级引用：优先根资产（配对页 index.html/styles.css + 核心），否则回退 web/（Web UI 资源）。
        return path.substring(1);
    }

    private static String mimeFor(String path) {
        String lower = path.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".gif")) return "image/gif";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".txt")) return "text/plain";
        if (lower.endsWith(".map")) return "application/json";
        return "application/octet-stream";
    }

    private InputStream openLocalAsset(String assetPath) throws IOException {
        if (assetPath.contains(".assets/")) {
            // /story-assets/<id>/<file>：先查 default，再查 custom
            try { return context.getAssets().open("stories/default/" + assetPath); }
            catch (IOException ignored) { return context.getAssets().open("stories/custom/" + assetPath); }
        }
        if (assetPath.startsWith("web/")) return context.getAssets().open(assetPath);
        // 根级引用：先试根资产（配对页/核心），再回退 web/（Web UI 根引用资源，如 /app.js）
        try { return context.getAssets().open(assetPath); }
        catch (IOException ignored) { return context.getAssets().open("web/" + assetPath); }
    }

    private WebResourceResponse fetchWithToken(Uri url, String credential, boolean mainFrame) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url.toString()).openConnection();
            connection.setRequestMethod("GET");
            connection.setRequestProperty("Authorization", "Bearer " + credential);
            connection.setRequestProperty("Accept", mainFrame ? "text/html" : "*/*");
            connection.setConnectTimeout(10_000);
            connection.setReadTimeout(30_000);
            connection.setUseCaches(false);
            connection.setInstanceFollowRedirects(false);
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) return null; // 交给 WebView 呈现错误
            String contentType = connection.getContentType();
            String mime = contentType == null ? "application/octet-stream" : contentType.split(";")[0].trim().toLowerCase(Locale.ROOT);
            if (mainFrame && mime.contains("html")) {
                byte[] bytes = readLimited(connection.getInputStream(), 4 * 1024 * 1024);
                String html = new String(bytes, StandardCharsets.UTF_8);
                html = injectBootstrap(html, credential);
                return new WebResourceResponse("text/html", "UTF-8", new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8)));
            }
            return new WebResourceResponse(mime, "UTF-8", connection.getInputStream());
        } catch (Exception error) {
            if (connection != null) connection.disconnect();
            return null;
        }
    }

    /** 在远程 HTML 的 <head> 注入令牌补丁脚本，早于页面模块脚本（app.js）执行。 */
    private static String injectBootstrap(String html, String credential) {
        String bootstrap = String.format(
            "<script>(function(){" +
                "var t=%s;var a='Bearer '+t;" +
                "var f=window.fetch;window.fetch=function(i,o){o=o||{};var h=new Headers(o.headers||(i&&i.headers)||{});h.set('Authorization',a);o.headers=h;return f.call(this,i,o)};" +
                "var s=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.send=function(){try{this.setRequestHeader('Authorization',a)}catch(e){}return s.apply(this,arguments)};" +
                "var E=window.EventSource;window.EventSource=function(u,o){o=o||{};var h=Object.assign({},o.headers||{},{Authorization:a});return new E(u,Object.assign({},o,{headers:h}))};window.EventSource.prototype=E.prototype;Object.setPrototypeOf(window.EventSource,E);" +
                "})();</script>",
            JSONObject.quote(credential));
        int head = html.toLowerCase(Locale.ROOT).indexOf("<head>");
        if (head >= 0) return html.substring(0, head + 6) + bootstrap + html.substring(head + 6);
        return bootstrap + html;
    }

    private static boolean isProtectedPath(String path) {
        return path.equals("/api") || path.startsWith("/api/")
            || path.equals("/assets") || path.startsWith("/assets/")
            || path.equals("/custom") || path.startsWith("/custom/")
            || path.equals("/story-assets") || path.startsWith("/story-assets/");
    }

    private static byte[] readLimited(InputStream input, int maximumBytes) throws IOException {
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8_192];
            int total = 0;
            int count;
            while ((count = stream.read(buffer)) >= 0) {
                total += count;
                if (total > maximumBytes) throw new IOException("Response is too large.");
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        }
    }

    private WebResourceResponse forbidden() {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", headers, new ByteArrayInputStream(new byte[0]));
    }
}
