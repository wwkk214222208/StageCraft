package ai.stagecraft.android;

import android.content.Context;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 离线 Web UI 环回静态服务器（127.0.0.1:随机端口）。
 *
 * 独立 APK 的完整 Web UI 以 http://localhost 打开：该 origin 是安全上下文，
 * ES module / fetch / EventSource 全部按常规 Web 语义工作（appassets:// 自定义
 * scheme 下 WebView 对 module 脚本支持不可靠，曾导致离线页只剩 HTML 骨架）。
 * API 路由仍由页面内 offline-adapter.js 的 fetch 补丁承担；本服务器只负责
 * 静态资产（web/**、/assets、/story-assets 与根资源），资产契约与
 * StageCraftWebViewClient 共用 LocalAssetResolver。
 */
public final class OfflineLoopbackServer implements AutoCloseable {
    private static final int MAX_BODY_BYTES = 16 * 1024 * 1024;
    private final LocalAssetResolver resolver;
    private final ServerSocket serverSocket;
    private final ExecutorService executor;
    private final AtomicBoolean closed = new AtomicBoolean();
    private volatile int port;

    public OfflineLoopbackServer(Context context) throws IOException {
        this.resolver = new LocalAssetResolver(context.getAssets());
        this.serverSocket = new ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"));
        this.port = serverSocket.getLocalPort();
        this.executor = Executors.newCachedThreadPool(runnable -> {
            Thread thread = new Thread(runnable, "offline-loopback");
            thread.setDaemon(true);
            return thread;
        });
        executor.execute(this::acceptLoop);
    }

    public String baseUrl() {
        return "http://127.0.0.1:" + port;
    }

    public String urlFor(String path) {
        return baseUrl() + path;
    }

    private void acceptLoop() {
        while (!closed.get()) {
            try {
                Socket socket = serverSocket.accept();
                executor.execute(() -> handle(socket));
            } catch (IOException error) {
                if (closed.get()) return;
            }
        }
    }

    private void handle(Socket socket) {
        try (Socket connection = socket) {
            connection.setSoTimeout(15_000);
            InputStream input = connection.getInputStream();
            String requestLine = readLineLimited(input, 8_192);
            if (requestLine == null || requestLine.isEmpty()) return;
            // 请求行: METHOD SP PATH SP HTTP/x
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) return;
            String method = parts[0].toUpperCase(java.util.Locale.ROOT);
            String rawPath = parts[1];
            if (!"GET".equals(method) && !"HEAD".equals(method)) {
                writeResponse(connection, 405, "text/plain; charset=utf-8", "405 method not allowed".getBytes(StandardCharsets.UTF_8));
                return;
            }
            // 读取请求头直到空行（\r\n\r\n 或 \n\n；限制总长度防滥用）
            int headerBytes = 0;
            int newlines = 0;
            while (true) {
                int current = input.read();
                if (current < 0) return;
                headerBytes++;
                if (headerBytes > 32 * 1024) { writeResponse(connection, 413, "text/plain", new byte[0]); return; }
                if (current == '\n') { newlines++; if (newlines >= 2) break; }
                else if (current != '\r') { newlines = 0; }
            }
            String path = rawPath;
            int query = path.indexOf('?');
            if (query >= 0) path = path.substring(0, query);
            LocalAssetResolver.Resolved resolved;
            try {
                resolved = resolver.resolve(path);
            } catch (Exception error) {
                resolved = null;
            }
            if (resolved == null) {
                if ("/".equals(path)) {
                    writeResponse(connection, 302, "text/plain", new byte[0], "Location: /web/offline.html");
                    return;
                }
                writeResponse(connection, 404, "text/plain; charset=utf-8", "not found".getBytes(StandardCharsets.UTF_8));
                return;
            }
            try (InputStream asset = resolver.open(resolved.assetPath)) {
                byte[] data = readLimited(asset, MAX_BODY_BYTES);
                writeResponse(connection, 200, resolved.mime, data);
            } catch (IOException error) {
                writeResponse(connection, 403, "text/plain; charset=utf-8", "forbidden".getBytes(StandardCharsets.UTF_8));
            }
        } catch (IOException ignored) {
            // 连接异常直接关闭
        }
    }

    private void writeResponse(Socket socket, int status, String mime, byte[] body) throws IOException {
        writeResponse(socket, status, mime, body, null);
    }

    private void writeResponse(Socket socket, int status, String mime, byte[] body, String extraHeader) throws IOException {
        OutputStream output = socket.getOutputStream();
        StringBuilder head = new StringBuilder(160);
        head.append("HTTP/1.1 ").append(status).append(statusReason(status)).append("\r\n");
        head.append("Content-Type: ").append(mime).append("\r\n");
        head.append("Content-Length: ").append(body.length).append("\r\n");
        head.append("Cache-Control: no-store\r\n");
        head.append("Connection: close\r\n");
        if (extraHeader != null) head.append(extraHeader).append("\r\n");
        head.append("\r\n");
        output.write(head.toString().getBytes(StandardCharsets.US_ASCII));
        output.write(body);
        output.flush();
    }

    private static String statusReason(int status) {
        switch (status) {
            case 200: return " OK";
            case 302: return " Found";
            case 403: return " Forbidden";
            case 404: return " Not Found";
            case 405: return " Method Not Allowed";
            case 413: return " Payload Too Large";
            default: return " Status";
        }
    }

    private static String readLineLimited(InputStream input, int maximum) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        int total = 0;
        int previous = -1;
        while (true) {
            int current = input.read();
            if (current < 0) return buffer.size() == 0 ? null : buffer.toString(StandardCharsets.UTF_8.name());
            total++;
            if (total > maximum) throw new IOException("Request line is too large.");
            if (previous == '\r' && current == '\n') {
                byte[] raw = buffer.toByteArray();
                return new String(raw, 0, Math.max(0, raw.length - 1), StandardCharsets.UTF_8);
            }
            if (current != '\r') buffer.write(current);
            previous = current;
        }
    }

    private static byte[] readLimited(InputStream input, int maximum) throws IOException {
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8_192];
            int total = 0;
            int count;
            while ((count = stream.read(buffer)) >= 0) {
                total += count;
                if (total > maximum) throw new IOException("Asset is too large.");
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        }
    }

    @Override public void close() {
        if (!closed.compareAndSet(false, true)) return;
        try { serverSocket.close(); } catch (IOException ignored) { }
        executor.shutdownNow();
    }
}