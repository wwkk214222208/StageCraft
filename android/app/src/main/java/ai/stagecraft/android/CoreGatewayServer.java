package ai.stagecraft.android;

import android.content.Context;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

import javax.net.SocketFactory;

/**
 * W6：主进程同源 UI gateway（计划 §2.3 / §5.4 / 阶段 4）。
 *
 * 页面只访问本 gateway（127.0.0.1:随机端口，与页面同源），它是全部 /api/* 的唯一入口：
 *  - 静态资产：web/**、/assets、/story-assets、根资源（原 LocalLoopbackServer 职责，同端口共存）；
 *  - /api/* 按 ApiRouteRegistry 分派：
 *      core（proxy-core）        → 注入 nonce 代理到 :core 进程 CoreDataServer（字节流透传，不解析业务 payload）；
 *      main-host（host-handler） → 主进程宿主 handler（HostHandler 接口，MainActivity 注入配对/同步/更新/SAF 等）；
 *      desktop-only（stable-unsupported）→ 稳定 unsupported_capability；
 *      deprecated（deprecated-adapter）  → 稳定 route_deprecated；
 *      未知 method/path         → 稳定 route_not_registered。
 *  - nonce 只由 gateway 注入到原生代理请求头，不进入页面/URL/日志/payload。
 *  - SSE 逐块透传（不得整包缓冲）；页面断开立即关闭上游 socket，上游断开立即结束下游（有界结束）。
 *
 * main-host handler 的接口契约（W6）：handler 以 JSON 文本进出，主进程实现具体能力；
 * 未注入 handler 的路由返回稳定 host_handler_unavailable（迁移期占位）。
 */
public final class CoreGatewayServer implements AutoCloseable {
    private static final int MAX_BODY_BYTES = 16 * 1024 * 1024; // 静态资产与 POST body 统一上限
    private static final int PIPE_BUFFER = 8 * 1024;

    /** W6：main-host 宿主 handler（主进程实现）。返回 JSON 文本；status 为 HTTP 状态码。 */
    public interface HostHandler {
        String handle(String method, String path, Map<String, String> headers, String bodyJson) throws Exception;
    }

    /** main-host 路由 handler 注册表：handlerId → handler（MainActivity 注入）。 */
    public interface HostHandlerRegistry {
        HostHandler get(String handlerId);
    }

    private final LocalAssetResolver resolver;
    private final RouteRegistry registry;
    private final ServerSocket serverSocket;
    private final ExecutorService executor;
    private final AtomicBoolean closed = new AtomicBoolean();
    private volatile int port;
    private volatile int corePort = -1;
    private volatile String coreNonce = "";
    private volatile HostHandlerRegistry hostHandlers;
    private final AtomicLong proxied = new AtomicLong();
    private final AtomicLong rejectedByPolicy = new AtomicLong();
    private final Map<Long, Socket> activeUpstreams = new ConcurrentHashMap<>();

    public CoreGatewayServer(Context context, RouteRegistry registry) throws IOException {
        this.resolver = context == null ? null : new LocalAssetResolver(context);
        this.registry = java.util.Objects.requireNonNull(registry, "registry");
        this.serverSocket = new ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"));
        this.port = serverSocket.getLocalPort();
        this.executor = Executors.newCachedThreadPool(runnable -> {
            Thread thread = new Thread(runnable, "core-gateway");
            thread.setDaemon(true);
            return thread;
        });
        executor.execute(this::acceptLoop);
    }

    public String baseUrl() { return "http://127.0.0.1:" + port; }
    public String urlFor(String path) { return baseUrl() + path; }
    public int getPort() { return port; }
    public long getProxiedCount() { return proxied.get(); }
    public long getRejectedByPolicyCount() { return rejectedByPolicy.get(); }

    /** W6：注入 main-host handler 注册表（MainActivity 提供配对/同步/更新/SAF 等宿主能力）。 */
    public void setHostHandlers(HostHandlerRegistry handlers) { this.hostHandlers = handlers; }

    /** 端点就绪/更新（Core 重启后 port 与 nonce 都会更换；由 CoreConnection 驱动）。 */
    public void setCoreEndpoint(int corePort, String coreNonce) {
        this.corePort = corePort;
        this.coreNonce = coreNonce;
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
        long connectionId = Thread.currentThread().getId();
        Socket upstream = null;
        try (Socket connection = socket) {
            connection.setSoTimeout(15_000);
            InputStream input = connection.getInputStream();
            String requestLine = readLineLimited(input, 8_192);
            if (requestLine == null || requestLine.isEmpty()) return;
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) return;
            String method = parts[0].toUpperCase(Locale.ROOT);
            String rawPath = parts[1];
            Map<String, String> headers = readHeaders(input);
            String path = rawPath;
            int query = path.indexOf('?');
            if (query >= 0) path = path.substring(0, query);
            // R3-1：pathOnly 用于 registry 分派（query 不参与匹配）；rawPath（含 query）用于转发，
            // 保证 /api/story/get?id=... 等 GET/DELETE 查询参数到达 handler。
            String pathOnly = URI.create(rawPath).getPath();
            String fullPath = URI.create(rawPath).getPath() + (query >= 0 ? rawPath.substring(query) : "");
            // POST body 统一读入内存（≤16MB），静态/代理/host 三面共用
            byte[] body = readBodyBytes(input, headers);

            // ── 静态资产面（非 /api/*）：原 LocalLoopbackServer 职责 ──
            if (!pathOnly.startsWith("/api/")) {
                serveStatic(connection, method, path, headers);
                return;
            }
            // ── API 面：registry 分派 ──
            RouteRegistry.Route route = registry.match(method, pathOnly);
            if (route == null) {
                rejectedByPolicy.incrementAndGet();
                writeResponse(connection, 404, "application/json", errorBody("route_not_registered", "method/path 未登记于 ApiRouteRegistry"));
                return;
            }
            JSONObject dispatchPolicy = route.dispatchPolicy;
            String action = dispatchPolicy == null ? "" : dispatchPolicy.optJSONObject("androidLocal") == null
                ? "" : dispatchPolicy.optJSONObject("androidLocal").optString("action", "");
            switch (action) {
                case "proxy-core" -> { /* 继续走 Core 代理 */ }
                case "host-handler" -> {
                    handleHostRoute(connection, method, fullPath, headers, body, route);
                    return;
                }
                case "stable-unsupported" -> {
                    rejectedByPolicy.incrementAndGet();
                    String errorCode = dispatchPolicy.optJSONObject("androidLocal").optString("errorCode", "unsupported_capability");
                    writeResponse(connection, 503, "application/json", errorBody(errorCode, "capability is not supported on this surface"));
                    return;
                }
                case "deprecated-adapter" -> {
                    rejectedByPolicy.incrementAndGet();
                    String errorCode = dispatchPolicy.optJSONObject("androidLocal").optString("errorCode", "route_deprecated");
                    writeResponse(connection, 410, "application/json", errorBody(errorCode, "route 已废弃，由统一协议替代"));
                    return;
                }
                default -> {
                    rejectedByPolicy.incrementAndGet();
                    writeResponse(connection, 500, "application/json", errorBody("gateway_policy_error", "registry dispatchPolicy 缺失或非法"));
                    return;
                }
            }
            // proxy-core：代理到 :core CoreDataServer
            int currentCorePort = corePort;
            if (currentCorePort < 0) {
                writeResponse(connection, 503, "application/json", errorBody("core_not_ready", "core endpoint is not ready"));
                return;
            }
            long[] downstreamBytes = new long[1]; // 已向页面写出的字节数：>0 后不得再注入 502（防响应协议损坏）
            try {
                upstream = SocketFactory.getDefault().createSocket(InetAddress.getByName("127.0.0.1"), currentCorePort);
                activeUpstreams.put(connectionId, upstream);
                writeProxyHead(upstream.getOutputStream(), method, fullPath, headers, body.length, coreNonce);
                if (body.length > 0) {
                    upstream.getOutputStream().write(body);
                    upstream.getOutputStream().flush();
                }
                if (isSse(method, pathOnly)) {
                    // SSE：上游读加 500ms 超时，空闲时轮询客户端断开（客户端 close 后上游须有界关闭）
                    upstream.setSoTimeout(500);
                    pipeStreaming(upstream.getInputStream(), connection.getOutputStream(), connectionId, connection);
                } else {
                    pipeResponseAndClose(upstream, connection, downstreamBytes);
                }
                proxied.incrementAndGet();
            } catch (IOException upstreamFailure) {
                // 仅当尚未向页面写出任何字节时注入明确 502（部分透传后失败再写 502 会损坏响应协议，只能有界断流）
                if (downstreamBytes[0] == 0) {
                    writeResponse(connection, 502, "application/json", errorBody("core_unreachable", "core data plane unreachable (killed or restarting)"));
                }
                throw upstreamFailure;
            }
        } catch (IOException error) {
            GateALog.i("core gateway connection ended: " + error.getClass().getSimpleName());
        } finally {
            if (upstream != null) {
                closeQuietly(upstream);
                activeUpstreams.remove(connectionId);
            }
        }
    }

    /** main-host 路由：注入的宿主 handler 处理；未注入 → 稳定 host_handler_unavailable。 */
    private void handleHostRoute(Socket connection, String method, String path, Map<String, String> headers, byte[] body, RouteRegistry.Route route) throws IOException {
        HostHandlerRegistry handlers = hostHandlers;
        HostHandler handler = handlers == null ? null : handlers.get(route.handlerId);
        if (handler == null) {
            rejectedByPolicy.incrementAndGet();
            writeResponse(connection, 501, "application/json", errorBody("host_handler_unavailable", "main-host handler 未注入: " + route.handlerId));
            return;
        }
        try {
            String bodyJson = body.length == 0 ? "{}" : new String(body, StandardCharsets.UTF_8);
            String result = handler.handle(method, path, headers, bodyJson);
            JSONObject parsed = new JSONObject(result);
            int status = parsed.optInt("status", 200);
            String payload = parsed.optString("body", "{}");
            writeResponse(connection, status, "application/json", payload);
        } catch (Exception error) {
            GateALog.w("host handler failed: " + error);
            writeResponse(connection, 500, "application/json", errorBody("host_handler_error", error.getMessage() == null ? "host handler failed" : error.getMessage()));
        }
    }

    /** 静态资产服务（原 LocalLoopbackServer 逻辑）。 */
    private void serveStatic(Socket connection, String method, String path, Map<String, String> headers) throws IOException {
        if (!"GET".equals(method) && !"HEAD".equals(method)) {
            writeResponse(connection, 405, "text/plain; charset=utf-8", "405 method not allowed".getBytes(StandardCharsets.UTF_8));
            return;
        }
        LocalAssetResolver.Resolved resolved;
        try {
            resolved = resolver.resolve(path);
        } catch (Exception error) {
            resolved = null;
        }
        if (resolved == null) {
            if ("/".equals(path)) {
                writeResponse(connection, 302, "text/plain", new byte[0], "Location: /web/local.html");
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
    }

    private static boolean isSse(String method, String path) {
        return "GET".equals(method) && path.startsWith("/api/core/events");
    }

    /** 上游请求头：注入 nonce 与协议版本；content-type 透传（Core 数据服务 415 校验依赖）。 */
    private static void writeProxyHead(OutputStream output, String method, String path, Map<String, String> headers, long bodyLength, String nonce) throws IOException {
        StringBuilder head = new StringBuilder(method + " " + path + " HTTP/1.1\r\n")
            .append("host: 127.0.0.1\r\n")
            .append("x-core-nonce: ").append(nonce).append("\r\n")
            .append("x-core-protocol-version: 1.1\r\n")
            .append("connection: close\r\n");
        if (bodyLength > 0) head.append("content-length: ").append(bodyLength).append("\r\n");
        String contentType = headers.get("content-type");
        if (contentType != null && !contentType.isEmpty()) head.append("content-type: ").append(contentType).append("\r\n");
        head.append("\r\n");
        output.write(head.toString().getBytes(StandardCharsets.US_ASCII));
        output.flush();
    }

    /** SSE：逐块透传（读一块写一块立刻 flush）；客户端断开 → 关上游（取消传播）。 */
    private void pipeStreaming(InputStream upstreamInput, OutputStream downstream, long connectionId, Socket clientSocket) throws IOException {
        byte[] buffer = new byte[PIPE_BUFFER];
        try {
            int read;
            while (true) {
                try {
                    read = upstreamInput.read(buffer);
                } catch (java.net.SocketTimeoutException idle) {
                    if (isClientGone(clientSocket)) {
                        GateALog.i("core gateway: client disconnected (idle poll), closing upstream conn=" + connectionId);
                        return;
                    }
                    continue;
                }
                if (read < 0) break;
                downstream.write(buffer, 0, read);
                downstream.flush(); // 逐块 flush 是"逐条送达"的关键，不得整包缓冲
            }
            GateALog.i("core gateway: upstream closed stream normally conn=" + connectionId);
        } catch (IOException clientDisconnected) {
            GateALog.i("core gateway: client disconnected, closing upstream conn=" + connectionId);
            throw clientDisconnected;
        }
    }

    /** 探测客户端是否已断开：读其输入流，EOF(-1) 表示 FIN；带超时，避免阻塞。 */
    private static boolean isClientGone(Socket clientSocket) {
        try {
            clientSocket.setSoTimeout(100);
            int probe = clientSocket.getInputStream().read();
            return probe < 0;
        } catch (java.net.SocketTimeoutException alive) {
            return false;
        } catch (IOException closed) {
            return true;
        }
    }

    /** 有限响应：透传上游状态行/头/体后关闭（JSON 请求用）。 */
    private static void pipeResponseAndClose(Socket upstream, Socket client, long[] downstreamBytes) throws IOException {
        InputStream input = upstream.getInputStream();
        OutputStream downstream = client.getOutputStream();
        byte[] buffer = new byte[PIPE_BUFFER];
        int read;
        while ((read = input.read(buffer)) >= 0) {
            downstream.write(buffer, 0, read);
            downstreamBytes[0] += read;
        }
        downstream.flush();
    }

    /** 读取请求头到 Map（小写键）。 */
    private static Map<String, String> readHeaders(InputStream input) throws IOException {
        Map<String, String> headers = new java.util.HashMap<>();
        int newlines = 0;
        int headerBytes = 0;
        StringBuilder line = new StringBuilder();
        while (true) {
            int current = input.read();
            if (current < 0) return headers;
            headerBytes++;
            if (headerBytes > 32 * 1024) throw new IOException("headers too large");
            if (current == '\n') {
                newlines++;
                if (newlines >= 2) break;
                String header = line.toString().trim();
                line.setLength(0);
                if (!header.isEmpty()) {
                    int colon = header.indexOf(':');
                    if (colon > 0) {
                        headers.put(header.substring(0, colon).trim().toLowerCase(Locale.ROOT), header.substring(colon + 1).trim());
                    }
                }
            } else if (current != '\r') {
                newlines = 0;
                line.append((char) current);
            }
        }
        return headers;
    }

    /** 读取请求 body（按 content-length，≤16MB；无 body 返回空数组）。 */
    private static byte[] readBodyBytes(InputStream input, Map<String, String> headers) throws IOException {
        String length = headers.get("content-length");
        if (length == null) return new byte[0];
        long size = Long.parseLong(length);
        if (size > MAX_BODY_BYTES) throw new IOException("body too large");
        if (size == 0) return new byte[0];
        ByteArrayOutputStream buffer = new ByteArrayOutputStream((int) size);
        byte[] chunk = new byte[8_192];
        long remaining = size;
        while (remaining > 0) {
            int read = input.read(chunk, 0, (int) Math.min(chunk.length, remaining));
            if (read < 0) break;
            buffer.write(chunk, 0, read);
            remaining -= read;
        }
        return buffer.toByteArray();
    }

    private static String errorBody(String code, String message) {
        try {
            return new JSONObject().put("error", new JSONObject().put("code", code).put("message", message)).toString();
        } catch (Exception error) {
            return "{\"error\":{\"code\":\"" + code + "\",\"message\":\"" + message + "\"}}";
        }
    }

    private void writeResponse(Socket socket, int status, String mime, byte[] body) throws IOException {
        writeResponse(socket, status, mime, body, null);
    }

    private void writeResponse(Socket socket, int status, String mime, String body) throws IOException {
        writeResponse(socket, status, mime, body.getBytes(StandardCharsets.UTF_8), null);
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
            case 410: return " Gone";
            case 413: return " Payload Too Large";
            case 500: return " Internal Server Error";
            case 501: return " Not Implemented";
            case 502: return " Bad Gateway";
            case 503: return " Service Unavailable";
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

    private static void closeQuietly(Socket socket) {
        try { socket.close(); } catch (IOException ignored) { }
    }

    @Override public void close() {
        if (!closed.compareAndSet(false, true)) return;
        try { serverSocket.close(); } catch (IOException ignored) { }
        for (Socket socket : activeUpstreams.values()) closeQuietly(socket);
        activeUpstreams.clear();
        executor.shutdownNow();
    }
}
