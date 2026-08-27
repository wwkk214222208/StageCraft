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
 *
 * 本地模式：/web/* 主框架导航由 LocalNavigation 重写到环回 HTTP 服务器
 * （127.0.0.1），使完整 Web UI 以常规 Web 语义运行（见 LocalLoopbackServer）。
 */
public final class StageCraftWebViewClient extends WebViewClient {
    public static final String LOCAL_ORIGIN = "https://appassets.androidplatform.net";

    public interface CredentialProvider {
        /** 当前已配对会话的 Bearer token；未配对返回 null。 */
        String currentCredential();
    }

    /** 本地 Web UI 主框架导航重写：返回替代 URL（如环回地址），返回 null 保持默认。 */
    public interface LocalNavigation {
        String rewriteMainFrame(String path);
    }

    private final Context context;
    private final CredentialProvider credentialProvider;
    private final LocalAssetResolver assetResolver;
    private final LocalNavigation localNavigation;

    public StageCraftWebViewClient(Context context, CredentialProvider credentialProvider) {
        this(context, credentialProvider, null);
    }

    public StageCraftWebViewClient(Context context, CredentialProvider credentialProvider, LocalNavigation localNavigation) {
        this.context = context;
        this.credentialProvider = credentialProvider;
        this.assetResolver = new LocalAssetResolver(context);
        this.localNavigation = localNavigation;
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
        String path = url.getPath() == null ? "/" : url.getPath();
        // 本地模式：appassets 下的 /web/* 主框架导航重写到环回服务器（http://localhost 常规 Web 语义）
        if ("https".equals(scheme) && "appassets.androidplatform.net".equals(host) && path.startsWith("/web/") && localNavigation != null) {
            String target = localNavigation.rewriteMainFrame(path);
            if (target != null && !target.isEmpty()) {
                view.loadUrl(target);
                return true;
            }
        }
        if ("https".equals(scheme) && "appassets.androidplatform.net".equals(host)) return false;
        if ("http".equals(scheme) || "https".equals(scheme)) return false; // 远程 UI / 环回本地页保持在本 WebView 内
        return true;
    }

    private WebResourceResponse serveLocalAsset(Uri url) {
        String path = url.getPath() == null ? "/" : url.getPath();
        LocalAssetResolver.Resolved resolved = assetResolver.resolve(path);
        if (resolved == null) return forbidden();
        try {
            InputStream input = assetResolver.open(resolved.assetPath);
            if (input == null) return forbidden();
            String contentType = resolved.mime;
            int parameter = contentType == null ? -1 : contentType.indexOf(';');
            String mime = parameter < 0 ? contentType : contentType.substring(0, parameter).trim();
            String encoding = mime != null && (mime.startsWith("text/") || mime.startsWith("application/")) ? "UTF-8" : null;
            return new WebResourceResponse(mime, encoding, input);
        } catch (IOException error) {
            return forbidden();
        }
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
