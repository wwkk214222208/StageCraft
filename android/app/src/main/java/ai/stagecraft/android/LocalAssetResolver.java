package ai.stagecraft.android;

import android.content.Context;
import android.content.res.AssetManager;

import java.io.IOException;
import java.io.InputStream;
import java.util.Locale;

/**
 * 本地资产解析：配对页/核心文件在根目录；Web UI（public 打包）在 web/，其资源以根路径引用
 * （/app.js、/style.css、/core-client.js 等）映射到 web/；头像 /assets/** 取自打包的 public/assets；
 * 剧本自包含资源 /story-assets/<id>/<file> 取自 stories/{default,custom}/<id>.assets/。
 * 由 StageCraftWebViewClient（appassets 拦截）与 LocalLoopbackServer（127.0.0.1）共用，
 * 保证两条投递路径的资产契约完全一致。
 */
public final class LocalAssetResolver {
    private final AssetManager assets;
    private final AndroidSqliteRepository repository;

    public LocalAssetResolver(Context context) {
        this.assets = context.getAssets();
        this.repository = new AndroidSqliteRepository(context);
    }

    public static final class Resolved {
        public final String assetPath;
        public final String mime;
        Resolved(String assetPath, String mime) { this.assetPath = assetPath; this.mime = mime; }
    }

    /** url path → {assetPath, mime}；不存在的路径返回 null（调用方按 404/403 处理）。 */
    public Resolved resolve(String path) {
        if (path == null || !path.startsWith("/") || path.contains("..")) return null;
        String assetPath;
        if (path.startsWith("/story-assets/")) {
            String remaining = path.substring("/story-assets/".length());
            int slash = remaining.indexOf('/');
            if (slash <= 0 || slash == remaining.length() - 1) return null;
            String id = remaining.substring(0, slash);
            String file = remaining.substring(slash + 1);
            assetPath = id + ".assets/" + file; // resolved against stories/{default,custom}/
        } else if (path.startsWith("/assets/") || path.startsWith("/custom/")) {
            assetPath = "web" + path;
        } else if (path.startsWith("/web/")) {
            assetPath = path.substring(1);
        } else {
            // 根级引用：优先根资产（配对页 index.html/styles.css + 核心），否则回退 web/（Web UI 资源）。
            assetPath = path.substring(1);
        }
        String mime = mimeFor(path);
        if (mime == null) return null;
        return new Resolved(assetPath, mime);
    }

    /** 打开资产：story-assets 先 default 后 custom；根引用先根后 web/。 */
    public InputStream open(String assetPath) throws IOException {
        if (assetPath.contains(".assets/")) {
            int marker = assetPath.indexOf(".assets/"); String id = assetPath.substring(0, marker); String file = assetPath.substring(marker + ".assets/".length());
            byte[] stored = repository.getAsset("/story-assets/" + id + "/" + file); if (stored != null) return new java.io.ByteArrayInputStream(stored);
            try { return assets.open("stories/default/" + assetPath); }
            catch (IOException ignored) { return assets.open("stories/custom/" + assetPath); }
        }
        if (assetPath.startsWith("web/")) return assets.open(assetPath);
        try { return assets.open(assetPath); }
        catch (IOException ignored) { return assets.open("web/" + assetPath); }
    }

    private static String mimeFor(String path) {
        String lower = path.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html; charset=utf-8";
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript; charset=utf-8";
        if (lower.endsWith(".css")) return "text/css; charset=utf-8";
        if (lower.endsWith(".json")) return "application/json; charset=utf-8";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".gif")) return "image/gif";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".txt")) return "text/plain; charset=utf-8";
        if (lower.endsWith(".map")) return "application/json";
        return null;
    }
}