package ai.stagecraft.android;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicLong;

import javax.net.ServerSocketFactory;

/**
 * W5：Core 进程 HTTP/SSE 数据服务（计划 §5.4 / Gate A 承载项生产化）。
 *
 * 只绑定 127.0.0.1 随机端口；所有请求必须带 x-core-nonce（nonce 只存在于原生连接层，
 * 不进入页面/URL/日志/协议 payload）。支持：
 *  - GET  /api/core/health      ：CoreHealth（含实时统计）
 *  - GET  /api/core/view        ：权威 CoreView（经进程内桥取）
 *  - POST /api/core/commands    ：HumanCommand（经进程内桥 → 回执）
 *  - GET  /api/core/events      ：CoreEvent SSE（逐事件 flush，慢消费者背压）
 *  - POST /api/core/cancel      ：取消 requestId（经进程内桥）
 *  - GET  /api/core/capabilities：宿主能力矩阵
 *
 * 本服务不解析业务 payload；命令/视图/取消均经 CommandForwarder 转发到 Core WebView JS
 * 组合根。socket I/O 全部留在连接线程（主线程写 loopback 触发 NetworkOnMainThreadException，
 * Gate A 真机实测根因）。
 *
 * JVM 可测性：executor 与 logger 可注入（Android 默认主线程 Handler + GateALog；
 * 测试注入直接执行器与 no-op logger）。
 */
public final class CoreDataServer {
    public static final int MAX_BODY_BYTES = 64 * 1024;
    private static final long SSE_QUEUE_LIMIT = 256;
    private static final int BRIDGE_TIMEOUT_MS = 20_000;

    public interface Subscriber {
        /** 返回 false 表示订阅者已断开。 */
        boolean onEvent(String eventJson);
    }

    /** 命令/视图/取消转发（CoreService 注入；在 executor 上执行，回调只交付 JSON 字符串）。 */
    public interface CommandForwarder {
        void forward(String bodyJson, java.util.function.Consumer<String> resultConsumer);
        /** GET /api/core/view 的权威视图（可能经桥异步；返回 null 表示尚未就绪）。 */
        String view();
        void cancel(String requestId);
        /**
         * W4 合流：协议端点转发（commands/cancel/ui-action 的统一入口）。
         * 携带 method/path/headers/body（含 x-core-protocol-version 等协议上下文），
         * 由 Core WebView 内的可移植 handler（CoreProtocolPortableHandler）处理并回执。
         * 回调交付 {@code {"status":<http>, "body":"<json text>"}}；实现方保证只回调一次。
         */
        default void forwardApi(String method, String path, Map<String, String> headers, String bodyJson, java.util.function.Consumer<String> resultConsumer) {
            // 默认退化为原 forward（兼容旧实现）：不携带协议上下文，语义由各实现方决定。
            forward(bodyJson, resultConsumer);
        }
    }

    /**
     * W5-R1-1：命令门禁（§4.1）——只有 ready/degraded 才允许命令类请求（commands/cancel/ui-action）。
     * 由 CoreService 注入（委托 CoreServiceStateMachine.canSubmitCommands()）；测试可注入切换。
     */
    public interface CommandGate {
        boolean canSubmitCommands();
        CommandGate ALWAYS_OPEN = () -> true;
    }

    public interface Logger {
        void i(String message);
        void w(String message);
        Logger NONE = new Logger() {
            @Override public void i(String message) { }
            @Override public void w(String message) { }
        };
    }

    private final String nonce;
    private final Executor executor;
    private final Logger logger;
    private ServerSocket server;
    private int port = -1;
    private volatile String healthJson = "{}";
    private volatile CommandForwarder commandForwarder;
    private volatile RouteRegistry routeRegistry;
    private volatile CommandGate commandGate = CommandGate.ALWAYS_OPEN;
    private final AtomicLong connections = new AtomicLong();
    private final AtomicLong rejected = new AtomicLong();
    private final CopyOnWriteArrayList<Subscriber> subscribers = new CopyOnWriteArrayList<>();
    private volatile String lastError = "";

    /** Android 默认：主线程 executor + GateALog。 */
    public CoreDataServer(String nonce) {
        this(nonce,
            new android.os.Handler(android.os.Looper.getMainLooper())::post,
            new Logger() {
                @Override public void i(String message) { GateALog.i(message); }
                @Override public void w(String message) { GateALog.w(message); }
            });
    }

    public CoreDataServer(String nonce, Executor executor, Logger logger) {
        this.nonce = java.util.Objects.requireNonNull(nonce, "nonce");
        this.executor = java.util.Objects.requireNonNull(executor, "executor");
        this.logger = logger == null ? Logger.NONE : logger;
    }

    public void setHealthJson(String json) { this.healthJson = json == null ? "{}" : json; }
    public void setCommandForwarder(CommandForwarder forwarder) { this.commandForwarder = forwarder; }
    /** W5-R1-1：注入命令门禁（CoreService 委托 CoreServiceStateMachine.canSubmitCommands）。 */
    public void setCommandGate(CommandGate gate) { this.commandGate = gate == null ? CommandGate.ALWAYS_OPEN : gate; }
    /** W5-5：注入 ApiRouteRegistry（构建资产）；未挂载的 core owner 路由返回稳定 handler_not_mounted。 */
    public void setRouteRegistry(RouteRegistry registry) { this.routeRegistry = registry; }
    public int getPort() { return port; }
    public long getConnectionCount() { return connections.get(); }
    public long getRejectedCount() { return rejected.get(); }
    public int getSubscriberCount() { return subscribers.size(); }

    public void start() throws IOException {
        // 显式 IPv4 回环（部分设备 getLoopbackAddress() 返回 ::1 导致拒连——Gate A 实测）
        server = ServerSocketFactory.getDefault().createServerSocket(0, 64, InetAddress.getByName("127.0.0.1"));
        port = server.getLocalPort();
        Thread acceptor = new Thread(this::acceptLoop, "core-data-accept");
        acceptor.setDaemon(true);
        acceptor.start();
    }

    public void stop() {
        try { if (server != null) server.close(); } catch (IOException ignored) { }
        port = -1;
        subscribers.clear();
    }

    private void acceptLoop() {
        while (server != null && !server.isClosed()) {
            try {
                Socket socket = server.accept();
                connections.incrementAndGet();
                Thread worker = new Thread(() -> handle(socket), "core-data-conn");
                worker.setDaemon(true);
                worker.start();
            } catch (SocketException closed) {
                return; // stop() 触发
            } catch (IOException error) {
                logger.w("core data accept failed: " + error);
            }
        }
    }

    private void handle(Socket socket) {
        try (socket) {
            socket.setSoTimeout(30_000);
            BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII), 8192);
            String requestLine = reader.readLine();
            if (requestLine == null) return;
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) { respond(socket, 400, "text/plain", "bad request"); return; }
            String method = parts[0].toUpperCase(Locale.ROOT);
            String path = parts[1];
            Map<String, String> headers = new java.util.HashMap<>();
            String line;
            while ((line = reader.readLine()) != null && !line.isEmpty()) {
                int colon = line.indexOf(':');
                if (colon > 0) headers.put(line.substring(0, colon).trim().toLowerCase(Locale.ROOT), line.substring(colon + 1).trim());
            }
            if (!nonce.equals(headers.get("x-core-nonce"))) {
                rejected.incrementAndGet();
                respond(socket, 401, "application/json", "{\"error\":{\"code\":\"unauthorized\",\"message\":\"missing or wrong nonce\"}}");
                return;
            }
            if ("/api/core/health".equals(path) && "GET".equals(method)) {
                String payload = healthJson;
                try {
                    JSONObject health = new JSONObject(healthJson);
                    health.put("dataServerStats", new JSONObject()
                        .put("connections", connections.get())
                        .put("rejected", rejected.get())
                        .put("subscribers", subscribers.size())
                        .put("lastError", lastError));
                    payload = health.toString();
                } catch (Exception ignored) { }
                respond(socket, 200, "application/json", payload);
                return;
            }
            if ("/api/core/events".equals(path) && "GET".equals(method)) {
                handleSse(socket);
                return;
            }
            // capabilities 不需要 forwarder（宿主能力矩阵恒定）
            if ("/api/core/capabilities".equals(path) && "GET".equals(method)) {
                respond(socket, 200, "application/json", capabilitiesJson());
                return;
            }
            // 需要 forwarder 的端点（view/commands/cancel/ui-action）：未就绪返回 503
            CommandForwarder forwarder = commandForwarder;
            boolean needsForwarder = ("/api/core/view".equals(path) && "GET".equals(method))
                || ("/api/core/commands".equals(path) && "POST".equals(method))
                || ("/api/core/cancel".equals(path) && "POST".equals(method))
                || ("/api/core/ui/action".equals(path) && "POST".equals(method));
            if (needsForwarder && forwarder == null) {
                respond(socket, 503, "application/json", "{\"error\":{\"code\":\"core_not_ready\",\"message\":\"core bridge is not ready\"}}");
                return;
            }
            // W5-R1-1 命令门禁：commands/cancel/ui-action 只有 ready/degraded 才放行；
            // starting/handshaking/crashed 等状态返回冻结契约等价错误 core_not_ready。
            boolean needsCommandGate = ("/api/core/commands".equals(path) && "POST".equals(method))
                || ("/api/core/cancel".equals(path) && "POST".equals(method))
                || ("/api/core/ui/action".equals(path) && "POST".equals(method));
            if (needsCommandGate && !commandGate.canSubmitCommands()) {
                respond(socket, 503, "application/json", "{\"error\":{\"code\":\"core_not_ready\",\"message\":\"core is not ready to accept commands (state gate closed)\"}}");
                return;
            }
            if ("/api/core/view".equals(path) && "GET".equals(method)) {
                String view = forwarder.view();
                if (view == null) {
                    respond(socket, 503, "application/json", "{\"error\":{\"code\":\"core_not_ready\",\"message\":\"core view is not ready\"}}");
                    return;
                }
                respond(socket, 200, "application/json", view);
                return;
            }
            if ("/api/core/commands".equals(path) && "POST".equals(method)) {
                String contentType = headers.get("content-type");
                if (!isJsonContentType(contentType)) {
                    respond(socket, 415, "application/json", "{\"error\":{\"code\":\"unsupported_media_type\",\"message\":\"commands requires application/json\"}}");
                    return;
                }
                String body = readBody(reader, headers);
                if (body == null) {
                    respond(socket, 413, "application/json", "{\"error\":{\"code\":\"payload_too_large\",\"message\":\"body exceeds " + MAX_BODY_BYTES + " bytes\"}}");
                    return;
                }
                // W4 合流：协议端点经 forwardApi 转发（携带 method/path/headers/body），
                // 由 Core WebView 内可移植 handler 处理（1.1 receipt / 1.0 旧形状）。
                forwardApiAndRespond(socket, "POST", "/api/core/commands", headers, body, forwarder);
                return;
            }
            if ("/api/core/cancel".equals(path) && "POST".equals(method)) {
                String contentType = headers.get("content-type");
                if (!isJsonContentType(contentType)) {
                    respond(socket, 415, "application/json", "{\"error\":{\"code\":\"unsupported_media_type\",\"message\":\"cancel requires application/json\"}}");
                    return;
                }
                String body = readBody(reader, headers);
                if (body == null) {
                    respond(socket, 413, "application/json", "{\"error\":{\"code\":\"payload_too_large\",\"message\":\"body exceeds " + MAX_BODY_BYTES + " bytes\"}}");
                    return;
                }
                // W4 合流：cancel 语义由可移植 handler 承载（requestId 校验 + core.cancel）。
                // 传输层保留 content-type/body 上限校验。
                forwardApiAndRespond(socket, "POST", "/api/core/cancel", headers, body, forwarder);
                return;
            }
            // W5：core owner 的协议面扩展端点（registry handlerId core.ui.action）。
            // 经 CommandForwarder 转发到 Core 组合根（UI action 由 Core 的 CoreExtensionPort 执行），
            // 不在此复制业务逻辑。
            if ("/api/core/ui/action".equals(path) && "POST".equals(method)) {
                String contentType = headers.get("content-type");
                if (!isJsonContentType(contentType)) {
                    respond(socket, 415, "application/json", "{\"error\":{\"code\":\"unsupported_media_type\",\"message\":\"ui/action requires application/json\"}}");
                    return;
                }
                String body = readBody(reader, headers);
                if (body == null) {
                    respond(socket, 413, "application/json", "{\"error\":{\"code\":\"payload_too_large\",\"message\":\"body exceeds " + MAX_BODY_BYTES + " bytes\"}}");
                    return;
                }
                // W4 合流：ui/action 语义由可移植 handler 承载（invokeUiAction）。
                forwardApiAndRespond(socket, "POST", "/api/core/ui/action", headers, body, forwarder);
                return;
            }
            // 未知路径/未知方法：先查 registry——登记为 core owner 但未挂载的路由返回稳定
            // handler_not_mounted（含 handlerId），替代随机 404（计划 §1.4 / §3.5 稳定能力错误）。
            // 注意：已实现端点（health/view/commands/events/cancel/capabilities/ui-action）在前面
            // 分支已 return，不会走到这里。
            RouteRegistry registry = routeRegistry;
            if (registry != null) {
                RouteRegistry.Route registered = registry.match(method, path);
                if (registered != null) {
                    if ("core".equals(registered.owner)) {
                        respond(socket, 503, "application/json", "{\"error\":{\"code\":\"handler_not_mounted\",\"message\":\"core handler not mounted yet\",\"handlerId\":\"" + registered.handlerId + "\"}}");
                        return;
                    }
                    if ("deprecated".equals(registered.owner)) {
                        respond(socket, 410, "application/json", "{\"error\":{\"code\":\"route_deprecated\",\"message\":\"deprecated route is not served by CoreDataServer\"}}");
                        return;
                    }
                    if ("desktop-only".equals(registered.owner)) {
                        respond(socket, 503, "application/json", "{\"error\":{\"code\":\"unsupported_capability\",\"message\":\"capability is not supported on Android local core\"}}");
                        return;
                    }
                }
            }
            respond(socket, 404, "application/json", "{\"error\":{\"code\":\"not_found\",\"message\":\"unknown core data path\"}}");
        } catch (Throwable error) {
            lastError = error.getClass().getSimpleName() + ": " + error.getMessage();
            logger.w("core data error: " + lastError);
            try { respond(socket, 500, "application/json", "{\"error\":{\"code\":\"data_server_internal\",\"message\":\"" + lastError.replace("\"", "'") + "\"}}"); } catch (Exception ignored) { }
            try { socket.close(); } catch (IOException ignored) { }
        }
    }

    /**
     * W4 合流：经 CommandForwarder.forwardApi 转发协议端点请求并写回响应。
     * 回调交付 {"status":<http>, "body":"<json>"}；超时回 504。
     */
    private void forwardApiAndRespond(Socket socket, String method, String path, Map<String, String> headers, String body, CommandForwarder forwarder) {
        final String[] result = new String[1];
        java.util.concurrent.CountDownLatch responded = new java.util.concurrent.CountDownLatch(1);
        executor.execute(() -> forwarder.forwardApi(method, path, headers, body, json -> { result[0] = json; responded.countDown(); }));
        try {
            if (!responded.await(BRIDGE_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)) {
                respond(socket, 504, "application/json", "{\"error\":{\"code\":\"bridge_timeout\",\"message\":\"core bridge did not respond within " + BRIDGE_TIMEOUT_MS + "ms\"}}");
                return;
            }
        } catch (InterruptedException latchWait) {
            Thread.currentThread().interrupt();
            respond(socket, 504, "application/json", "{\"error\":{\"code\":\"bridge_timeout\",\"message\":\"core bridge interrupted\"}}");
            return;
        }
        if (result[0] == null) {
            respond(socket, 503, "application/json", "{\"error\":{\"code\":\"bridge_no_result\",\"message\":\"core bridge returned no result\"}}");
            return;
        }
        try {
            JSONObject wrapped = new JSONObject(result[0]);
            int status = wrapped.optInt("status", 200);
            String bodyText = wrapped.optString("body", "");
            respond(socket, status, "application/json", bodyText.isEmpty() ? "{}" : bodyText);
        } catch (Exception error) {
            respond(socket, 502, "application/json", "{\"error\":{\"code\":\"bridge_bad_result\",\"message\":\"core bridge returned malformed result\"}}");
        }
    }

    private static final String CAPABILITIES = "{\"capabilities\":["
        + "{\"id\":\"core.protocol\",\"supported\":true,\"mode\":\"full\"},"
        + "{\"id\":\"room.read\",\"supported\":true,\"mode\":\"full\"},"
        + "{\"id\":\"room.write\",\"supported\":true,\"mode\":\"full\"},"
        + "{\"id\":\"room.command\",\"supported\":true,\"mode\":\"full\"},"
        + "{\"id\":\"role.read\",\"supported\":true,\"mode\":\"full\"},"
        + "{\"id\":\"role.write\",\"supported\":true,\"mode\":\"full\"},"
        + "{\"id\":\"story.library\",\"supported\":true,\"mode\":\"full\"},"
        + "{\"id\":\"provider.config\",\"supported\":true,\"mode\":\"full\"},"
        + "{\"id\":\"prompt.presets\",\"supported\":true,\"mode\":\"full\"},"
        + "{\"id\":\"archive.port\",\"supported\":true,\"mode\":\"full\"},"
        + "{\"id\":\"billing.runtime\",\"supported\":true,\"mode\":\"full\"},"
        + "{\"id\":\"creator.workbench\",\"supported\":true,\"mode\":\"full\"},"
        + "{\"id\":\"ui.panels\",\"supported\":true,\"mode\":\"full\"},"
        + "{\"id\":\"agent.dsh\",\"supported\":false,\"mode\":\"unsupported\",\"reason\":\"DSH agent 仅桌面宿主提供\"}"
        + "]}";

    private static String capabilitiesJson() { return CAPABILITIES; }

    private void handleSse(Socket socket) throws IOException {
        OutputStream output = socket.getOutputStream();
        socket.setSoTimeout(0); // SSE 长连接不限读超时
        StringBuilder head = new StringBuilder();
        head.append("HTTP/1.1 200 OK\r\n");
        head.append("content-type: text/event-stream\r\n");
        head.append("cache-control: no-cache\r\n");
        head.append("connection: keep-alive\r\n\r\n");
        output.write(head.toString().getBytes(StandardCharsets.US_ASCII));
        output.flush();
        ConcurrentLinkedQueue<String> queue = new ConcurrentLinkedQueue<>();
        java.util.concurrent.atomic.AtomicBoolean overflowClosed = new java.util.concurrent.atomic.AtomicBoolean(false);
        Subscriber subscriber = event -> {
            if (queue.size() >= SSE_QUEUE_LIMIT) {
                overflowClosed.set(true); // 慢消费者背压：通知写循环关闭连接
                return false;
            }
            queue.add(event);
            return true;
        };
        subscribers.add(subscriber);
        try {
            output.write(": connected\n\n".getBytes(StandardCharsets.US_ASCII));
            output.flush();
            long lastHeartbeat = System.currentTimeMillis();
            while (!overflowClosed.get()) {
                String event = queue.poll();
                if (event != null) {
                    output.write(("data: " + event + "\n\n").getBytes(StandardCharsets.UTF_8));
                    output.flush();
                    continue;
                }
                long now = System.currentTimeMillis();
                if (now - lastHeartbeat >= 10_000) {
                    output.write(": heartbeat\n\n".getBytes(StandardCharsets.US_ASCII));
                    output.flush();
                    lastHeartbeat = now;
                }
                Thread.sleep(20);
            }
        } catch (InterruptedException stopSignal) {
            Thread.currentThread().interrupt();
        } catch (IOException clientGone) {
            logger.i("core sse client disconnected");
        } finally {
            subscribers.remove(subscriber);
            try { socket.close(); } catch (IOException ignored) { }
        }
    }

    /** Core 主线程调用：把 Core runtime 事件逐条推给所有 SSE 订阅者。 */
    public void publishCoreEvent(JSONObject event) {
        String json = event.toString();
        for (Subscriber subscriber : subscribers) {
            if (!subscriber.onEvent(json)) subscribers.remove(subscriber);
        }
    }

    /** Gate C 语义：POST JSON 端点要求 content-type 为 application/json（缺失或非 JSON → 415）。 */
    private static boolean isJsonContentType(String contentType) {
        if (contentType == null) return false;
        String normalized = contentType.trim().toLowerCase(Locale.ROOT);
        int semicolon = normalized.indexOf(';');
        if (semicolon >= 0) normalized = normalized.substring(0, semicolon).trim();
        return "application/json".equals(normalized);
    }

    /** 读取 POST body；超过上限返回 null（调用方回 413）。 */
    private String readBody(BufferedReader reader, Map<String, String> headers) throws IOException {
        long length = Long.parseLong(headers.getOrDefault("content-length", "0"));
        if (length > MAX_BODY_BYTES) return null;
        char[] buffer = new char[(int) length];
        int offset = 0;
        while (offset < length) {
            int read = reader.read(buffer, offset, (int) (length - offset));
            if (read < 0) break;
            offset += read;
        }
        return new String(java.util.Arrays.copyOfRange(buffer, 0, offset));
    }

    private void respond(Socket socket, int status, String contentType, String body) {
        try {
            OutputStream output = socket.getOutputStream();
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            String head = "HTTP/1.1 " + status + " " + reason(status) + "\r\n"
                + "content-type: " + contentType + "\r\n"
                + "content-length: " + bytes.length + "\r\n"
                + "connection: close\r\n\r\n";
            output.write(head.getBytes(StandardCharsets.US_ASCII));
            output.write(bytes);
            output.flush();
            socket.shutdownOutput();
        } catch (IOException error) {
            logger.w("core data respond failed: " + error.getClass().getSimpleName());
        }
    }

    private static String reason(int status) {
        return switch (status) {
            case 200 -> "OK";
            case 400 -> "Bad Request";
            case 401 -> "Unauthorized";
            case 404 -> "Not Found";
            case 410 -> "Gone";
            case 413 -> "Payload Too Large";
            case 415 -> "Unsupported Media Type";
            case 500 -> "Internal Server Error";
            case 503 -> "Service Unavailable";
            case 504 -> "Gateway Timeout";
            default -> "Status";
        };
    }
}
