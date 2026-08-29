package ai.stagecraft.android;

import android.os.Handler;
import android.os.Looper;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicLong;

import javax.net.ServerSocketFactory;

/**
 * Core 进程 HTTP/SSE 数据服务（W0 spike；计划 §5.4 / Q8）。
 *
 * 只绑定 127.0.0.1 随机端口；所有请求必须带 x-core-nonce（nonce 只存在于原生连接层，
 * 不进入页面/URL/日志/协议 payload）。支持 POST JSON 透传、SSE 逐事件 flush、
 * 请求体大小上限、客户端断开即时清理。不做业务解析。
 */
public final class GateACoreDataServer {
    public static final int MAX_BODY_BYTES = 64 * 1024;
    private static final long SSE_QUEUE_LIMIT = 256;

    /** 一条待推送的 SSE 事件；由 :core 主线程（WebMessage 回调）投递。 */
    public interface CoreEventSource {
        void subscribe(Subscriber subscriber);

        void unsubscribe(Subscriber subscriber);
    }

    public interface Subscriber {
        /** 返回 false 表示订阅者已断开。 */
        boolean onEvent(String eventJson);
    }

    /** 命令转发投递器：生产用主线程 Handler（桥回调须在 :core 主线程执行）；JVM 测试注入直执行器。 */
    private final Handler main;
    private final RunnableDispatcher dispatcher;
    private final long bridgeTimeoutMs;
    private final String nonce;
    private ServerSocket server;
    private int port = -1;
    private volatile String healthJson = "{}";
    private volatile String lastError = "";
    private final AtomicLong connections = new AtomicLong();
    private final AtomicLong rejected = new AtomicLong();
    /** 由 GateACoreService 注入：把 HTTP POST 转发到 Core WebView JS（进程内桥量测）。 */
    private volatile CommandForwarder commandForwarder;

    public interface CommandForwarder {
        /**
         * 在主线程异步执行；回调只交付回执 JSON 字符串（不做任何 socket I/O——
         * 主线程上写 socket 会抛 NetworkOnMainThreadException，实测根因）。
         * HTTP 写回由数据服务连接线程完成。
         */
        void forward(String bodyJson, java.util.function.Consumer<String> resultConsumer);
    }

    /** 把转发任务投递到桥线程（生产=主线程 Handler；测试=直执行）。 */
    public interface RunnableDispatcher {
        void dispatch(Runnable task);
    }

    public GateACoreDataServer(String nonce) {
        this(nonce, null, 20_000);
    }

    /** JVM 边界测试用：允许注入直执行 dispatcher 与短桥超时，避免 android.jar stub 的 Looper 依赖。 */
    GateACoreDataServer(String nonce, RunnableDispatcher dispatcher) {
        this(nonce, dispatcher, 20_000);
    }

    GateACoreDataServer(String nonce, RunnableDispatcher dispatcher, long bridgeTimeoutMs) {
        this.nonce = java.util.Objects.requireNonNull(nonce, "nonce");
        this.bridgeTimeoutMs = bridgeTimeoutMs;
        // 生产路径（dispatcher==null）用主线程 Handler；测试注入直执行器时不再触碰 Looper
        this.main = dispatcher == null ? new Handler(Looper.getMainLooper()) : null;
        this.dispatcher = dispatcher == null ? task -> main.post(task) : dispatcher;
    }

    public void setHealthJson(String json) { this.healthJson = json == null ? "{}" : json; }
    public void setCommandForwarder(CommandForwarder forwarder) { this.commandForwarder = forwarder; }
    public int getPort() { return port; }
    public long getConnectionCount() { return connections.get(); }
    public long getRejectedCount() { return rejected.get(); }

    public void start() throws IOException {
        // 显式 IPv4 回环（与 gateway 的 127.0.0.1 连接一致，见 GateAGatewayServer 注释）
        server = ServerSocketFactory.getDefault().createServerSocket(0, 64, InetAddress.getByName("127.0.0.1"));
        port = server.getLocalPort();
        Thread acceptor = new Thread(this::acceptLoop, "gatea-core-data-accept");
        acceptor.setDaemon(true);
        acceptor.start();
    }

    public void stop() {
        try { if (server != null) server.close(); } catch (IOException ignored) { }
        port = -1;
    }

    private void acceptLoop() {
        while (server != null && !server.isClosed()) {
            try {
                Socket socket = server.accept();
                connections.incrementAndGet();
                Thread worker = new Thread(() -> handle(socket), "gatea-core-data-conn");
                worker.setDaemon(true);
                worker.start();
            } catch (SocketException closed) {
                return; // server.stop() 触发
            } catch (IOException error) {
                GateALog.w("core data accept failed: " + error);
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
            if ("/api/core/commands".equals(path) && "POST".equals(method)) {
                String contentType = headers.getOrDefault("content-type", "");
                if (!contentType.toLowerCase(Locale.ROOT).startsWith("application/json")) {
                    respond(socket, 415, "application/json", "{\"error\":{\"code\":\"unsupported_media_type\",\"message\":\"commands 必须携带 application/json content-type\"}}");
                    return;
                }
                String body = readBody(reader, headers);
                if (body == null) {
                    respond(socket, 413, "application/json", "{\"error\":{\"code\":\"payload_too_large\",\"message\":\"body exceeds " + MAX_BODY_BYTES + " bytes\"}}");
                    return;
                }
                CommandForwarder forwarder = commandForwarder;
                if (forwarder == null) {
                    respond(socket, 503, "application/json", "{\"error\":{\"code\":\"core_not_ready\",\"message\":\"core bridge is not ready\"}}");
                    return;
                }
                // 命令转发经主线程进 WebView（evaluateJavascript）；连接线程等结果后自行写回，
                // socket I/O 全部留在连接线程（主线程写 loopback 也触发 NetworkOnMainThreadException）。
                final String[] result = new String[1];
                java.util.concurrent.CountDownLatch responded = new java.util.concurrent.CountDownLatch(1);
                dispatcher.dispatch(() -> forwarder.forward(body, json -> { result[0] = json; responded.countDown(); }));
                // 超时护栏：桥回调永久不返回时连接线程不得泄漏（评审实现风险 1）
                if (!responded.await(bridgeTimeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)) {
                    respond(socket, 504, "application/json", "{\"error\":{\"code\":\"bridge_timeout\",\"message\":\"core bridge did not respond within " + bridgeTimeoutMs + "ms\"}}");
                    return;
                }
                respond(socket, 200, "application/json", result[0] == null
                    ? "{\"error\":{\"code\":\"bridge_no_result\",\"message\":\"core bridge returned no result\"}}"
                    : result[0]);
                return;
            }
            respond(socket, 404, "application/json", "{\"error\":{\"code\":\"not_found\",\"message\":\"unknown core data path\"}}");
        } catch (InterruptedException latchWait) {
            Thread.currentThread().interrupt();
        } catch (Throwable error) {
            // 华为设备 logcat 受抑制：把异常如实回写进响应体并记录到 lastError（health 可见）
            lastError = error.getClass().getSimpleName() + ": " + error.getMessage();
            GateALog.w("core data error: " + lastError);
            try { respond(socket, 500, "application/json", "{\"error\":{\"code\":\"data_server_internal\",\"message\":\"" + lastError.replace("\"", "'") + "\"}}"); } catch (Exception ignored) { }
            try { socket.close(); } catch (IOException ignored) { }
        }
    }

    private void handleSse(Socket socket) throws IOException {
        OutputStream output = socket.getOutputStream();
        socket.setSoTimeout(0); // SSE 长连接不限读超时（写入走同一 socket）
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
                overflowClosed.set(true); // 慢消费者背压：通知写循环关闭连接（评审实现风险 2）
                return false;
            }
            queue.add(event);
            return true;
        };
        eventSource.subscribe(subscriber);
        try {
            // 订阅已生效，回执确认行：调用方读到本行后才允许派发事件（消除 setTimeout(0) 竞态）
            output.write(": connected\n\n".getBytes(StandardCharsets.US_ASCII));
            output.flush();
            long lastHeartbeat = System.currentTimeMillis();
            long lastProbe = System.currentTimeMillis();
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
                // 客户端（gateway）断开探测：空闲期周期性读 socket，FIN → EOF → 退出释放 subscriber
                // （评审 C-3：不得依赖 10s 心跳才感知断开，须在 fixture 时限内有界释放）
                if (now - lastProbe >= 500) {
                    if (isSseClientGone(socket)) break;
                    lastProbe = now;
                }
                Thread.sleep(20);
            }
        } catch (InterruptedException stopSignal) {
            Thread.currentThread().interrupt();
        } catch (IOException clientGone) {
            GateALog.i("core sse client disconnected");
        } finally {
            subscribers.remove(subscriber);
            try { socket.close(); } catch (IOException ignored) { }
        }
    }

    /** SSE 客户端断开探测：读其输入流，EOF(-1) 表示 FIN；带超时避免阻塞。 */
    private static boolean isSseClientGone(Socket socket) {
        try {
            socket.setSoTimeout(200);
            int probe = socket.getInputStream().read();
            return probe < 0;
        } catch (java.net.SocketTimeoutException alive) {
            return false; // 客户端仍连接（无数据）
        } catch (IOException closed) {
            return true; // 连接已重置/关闭
        }
    }

    private final CopyOnWriteArrayList<Subscriber> subscribers = new CopyOnWriteArrayList<>();
    private final CoreEventSource eventSource = new CoreEventSource() {
        @Override public void subscribe(Subscriber subscriber) { subscribers.add(subscriber); }
        @Override public void unsubscribe(Subscriber subscriber) { subscribers.remove(subscriber); }
    };

    /** :core 主线程调用：把 Core runtime（页面桥）事件逐条推给所有 SSE 订阅者。 */
    public void publishCoreEvent(JSONObject event) {
        String json = event.toString();
        for (Subscriber subscriber : subscribers) {
            if (!subscriber.onEvent(json)) subscribers.remove(subscriber);
        }
    }

    public int getSubscriberCount() { return subscribers.size(); }

    /** 读取 POST body；超过上限返回 null（调用方回 413）。 */
    private String readBody(BufferedReader reader, Map<String, String> headers) throws IOException {
        long length = Long.parseLong(headers.getOrDefault("content-length", "0"));
        if (length > MAX_BODY_BYTES) {
            // 消费并丢弃到连接关闭，避免残留字节污染下一个请求（本服务每连接一请求，直接截断即可）
            return null;
        }
        char[] buffer = new char[(int) length];
        int offset = 0;
        while (offset < length) {
            int read = reader.read(buffer, offset, (int) (length - offset));
            if (read < 0) break;
            offset += read;
        }
        return new String(java.util.Arrays.copyOfRange(buffer, 0, offset)); // char[]→String 恒为 UTF-16，无编码歧义
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
            GateALog.w("core data respond failed: " + error.getClass().getSimpleName());
        }
    }

    private static String reason(int status) {
        return switch (status) {
            case 200 -> "OK";
            case 401 -> "Unauthorized";
            case 404 -> "Not Found";
            case 413 -> "Payload Too Large";
            case 415 -> "Unsupported Media Type";
            case 502 -> "Bad Gateway";
            case 503 -> "Service Unavailable";
            default -> "Status";
        };
    }
}
