package ai.stagecraft.android;

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
import java.util.concurrent.atomic.AtomicLong;

import javax.net.ServerSocketFactory;
import javax.net.SocketFactory;

import org.json.JSONObject;

/**
 * W0 spike：主进程同源 UI gateway（计划 §2.3 / §5.4 / Q2）。
 *
 * 页面只访问本 gateway（127.0.0.1 随机端口，与页面同源）。Gate B 收口：gateway 启动时加载
 * 同一份构建期 api-route-registry.json，运行时先按 method/path 匹配产生 owner/policy 决策——
 * core（proxy-core）→ 注入 nonce 代理到 CoreDataServer；main-host（host-handler）→ 宿主分派
 * （W6 实现真实 handler，本轮稳定 host_handler_unavailable）；desktop-only（stable-unsupported）
 * → 稳定 unsupported_capability；deprecated（deprecated-adapter）→ 稳定 route_deprecated；
 * 未知 method/path → 稳定拒绝。SSE 必须逐块透传（不得整包缓冲）；页面断开立即关闭上游 socket，
 * 上游断开立即结束下游（有界结束）。不解析业务 payload。
 */
public final class GateAGatewayServer {
    private static final int PIPE_BUFFER = 8 * 1024;

    private final String hostTag;
    private final RouteRegistry registry;
    private ServerSocket server;
    private int port = -1;
    private volatile int corePort = -1;
    private volatile String coreNonce = "";
    private final AtomicLong proxied = new AtomicLong();
    private final AtomicLong upstreamClosedByClient = new AtomicLong();
    private final AtomicLong downstreamClosedByUpstream = new AtomicLong();
    private final AtomicLong rejectedByPolicy = new AtomicLong();
    private final Map<Long, Socket> activeUpstreams = new ConcurrentHashMap<>();

    public GateAGatewayServer(String hostTag, RouteRegistry registry) {
        this.hostTag = hostTag;
        this.registry = java.util.Objects.requireNonNull(registry, "registry");
    }

    public void start() throws IOException {
        // 显式 IPv4 回环：部分设备 getLoopbackAddress() 返回 ::1，与页面/URL 的 127.0.0.1 不一致会导致拒连
        server = ServerSocketFactory.getDefault().createServerSocket(0, 64, InetAddress.getByName("127.0.0.1"));
        port = server.getLocalPort();
        Thread acceptor = new Thread(this::acceptLoop, "gatea-gateway-accept");
        acceptor.setDaemon(true);
        acceptor.start();
    }

    public void stop() {
        try { if (server != null) server.close(); } catch (IOException ignored) { }
        for (Socket socket : activeUpstreams.values()) closeQuietly(socket);
        activeUpstreams.clear();
        port = -1;
    }

    /** 端点就绪/更新（Core 重启后 port 与 nonce 都会更换）。 */
    public void setCoreEndpoint(int corePort, String coreNonce) {
        this.corePort = corePort;
        this.coreNonce = coreNonce;
    }

    public int getPort() { return port; }
    public long getProxiedCount() { return proxied.get(); }
    public long getUpstreamClosedByClientCount() { return upstreamClosedByClient.get(); }
    public long getDownstreamClosedByUpstreamCount() { return downstreamClosedByUpstream.get(); }
    public long getRejectedByPolicyCount() { return rejectedByPolicy.get(); }

    private void acceptLoop() {
        while (server != null && !server.isClosed()) {
            try {
                Socket client = server.accept();
                Thread worker = new Thread(() -> handle(client), "gatea-gateway-conn");
                worker.setDaemon(true);
                worker.start();
            } catch (SocketException closed) {
                return;
            } catch (IOException error) {
                GateALog.w(hostTag + " gateway accept failed: " + error);
            }
        }
    }

    private void handle(Socket client) {
        long connectionId = Thread.currentThread().getId();
        Socket upstream = null;
        try (client) {
            client.setSoTimeout(0);
            Request request = Request.parse(client.getInputStream());
            if (request == null) return;
            // Gate B 收口：先按 registry 匹配产生 owner/policy 决策，未登记/非 proxy 不得触碰 Core
            RouteRegistry.Route route = registry.match(request.method, request.path);
            if (route == null) {
                rejectedByPolicy.incrementAndGet();
                writeResponse(client, 404, "application/json",
                    "{\"error\":{\"code\":\"route_not_registered\",\"message\":\"method/path 未登记于 ApiRouteRegistry\"}}");
                return;
            }
            JSONObject dispatchPolicy = route.dispatchPolicy;
            String action = dispatchPolicy == null ? "" : dispatchPolicy.optJSONObject("androidLocal") == null
                ? "" : dispatchPolicy.optJSONObject("androidLocal").optString("action", "");
            switch (action) {
                case "proxy-core" -> { /* 继续走 Core 代理 */ }
                case "host-handler" -> {
                    rejectedByPolicy.incrementAndGet();
                    writeResponse(client, 501, "application/json",
                        "{\"error\":{\"code\":\"host_handler_unavailable\",\"message\":\"main-host handler 由 W6 实现\"}}");
                    return;
                }
                case "stable-unsupported" -> {
                    rejectedByPolicy.incrementAndGet();
                    writeResponse(client, 501, "application/json",
                        "{\"error\":{\"code\":\"unsupported_capability\",\"message\":\"not supported on this surface\"}}");
                    return;
                }
                case "deprecated-adapter" -> {
                    rejectedByPolicy.incrementAndGet();
                    writeResponse(client, 410, "application/json",
                        "{\"error\":{\"code\":\"route_deprecated\",\"message\":\"route 已废弃，由统一协议替代\"}}");
                    return;
                }
                default -> {
                    rejectedByPolicy.incrementAndGet();
                    writeResponse(client, 500, "application/json",
                        "{\"error\":{\"code\":\"gateway_policy_error\",\"message\":\"registry dispatchPolicy 缺失或非法\"}}");
                    return;
                }
            }
            int currentCorePort = corePort;
            if (currentCorePort < 0) {
                writeResponse(client, 503, "application/json", "{\"error\":{\"code\":\"core_not_ready\",\"message\":\"core endpoint is not ready\"}}");
                return;
            }
            long[] downstreamBytes = new long[1]; // 已向页面写出的字节数：>0 后不得再注入 502（防响应协议损坏）
            try {
                upstream = SocketFactory.getDefault().createSocket(InetAddress.getByName("127.0.0.1"), currentCorePort);
                activeUpstreams.put(connectionId, upstream);
                request.writeTo(upstream.getOutputStream(), coreNonce, hostTag);
                // 请求体（POST）转发
                if (request.contentLength > 0) pipeFixed(request.bodyStream, upstream.getOutputStream(), request.contentLength);
                if (request.isSse()) {
                    // SSE：上游读加 500ms 超时，空闲时轮询客户端断开（客户端 close 后上游须有界关闭）
                    upstream.setSoTimeout(500);
                    pipeStreaming(upstream.getInputStream(), client.getOutputStream(), connectionId, true, downstreamBytes, client);
                } else {
                    pipeResponseAndClose(upstream, client, downstreamBytes);
                }
                proxied.incrementAndGet();
            } catch (IOException upstreamFailure) {
                // 仅当尚未向页面写出任何字节时注入明确 502（评审第 5 条+第 6 条次要项：
                // 部分透传后失败再写 502 会损坏响应协议，只能有界断流）
                if (downstreamBytes[0] == 0) {
                    writeResponse(client, 502, "application/json",
                        "{\"error\":{\"code\":\"core_unreachable\",\"message\":\"core data plane unreachable (killed or restarting)\"}}");
                }
                throw upstreamFailure;
            }
        } catch (IOException error) {
            GateALog.i(hostTag + " gateway connection ended: " + error.getClass().getSimpleName());
        } finally {
            if (upstream != null) {
                closeQuietly(upstream);
                activeUpstreams.remove(connectionId);
            }
        }
    }

    /**
     * SSE：逐块透传（读一块写一块立刻 flush）；客户端断开 → 关上游（取消传播）。
     * 上游读带 soTimeout：空闲时探测客户端 EOF（FIN），断开则退出并关闭上游（有界结束）。
     */
    private void pipeStreaming(InputStream upstreamInput, OutputStream downstream, long connectionId, boolean sse, long[] downstreamBytes, Socket clientSocket) throws IOException {
        byte[] buffer = new byte[PIPE_BUFFER];
        try {
            int read;
            while (true) {
                try {
                    read = upstreamInput.read(buffer);
                } catch (java.net.SocketTimeoutException idle) {
                    // 空闲期探测客户端是否断开（FIN → read EOF）：断开后必须停止转发并关闭上游
                    if (isClientGone(clientSocket)) {
                        upstreamClosedByClient.incrementAndGet();
                        GateALog.i(hostTag + " client disconnected (idle poll), closing upstream conn=" + connectionId);
                        return;
                    }
                    continue;
                }
                if (read < 0) break;
                downstream.write(buffer, 0, read);
                downstream.flush(); // 逐块 flush 是"逐条送达"的关键，不得整包缓冲
                downstreamBytes[0] += read;
            }
            downstreamClosedByUpstream.incrementAndGet();
            GateALog.i(hostTag + " upstream closed stream normally conn=" + connectionId);
        } catch (IOException clientDisconnected) {
            upstreamClosedByClient.incrementAndGet();
            GateALog.i(hostTag + " client disconnected, closing upstream conn=" + connectionId);
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
            return false; // 客户端仍连接（无数据）
        } catch (IOException closed) {
            return true; // 连接已重置/关闭
        }
    }

    /** 有限响应：透传上游状态行/头/体后关闭（JSON 请求用）。 */
    private void pipeResponseAndClose(Socket upstream, Socket client, long[] downstreamBytes) throws IOException {
        InputStream input = upstream.getInputStream();
        OutputStream downstream = client.getOutputStream();
        byte[] buffer = new byte[PIPE_BUFFER];
        int read;
        while ((read = input.read(buffer)) >= 0) {
            downstream.write(buffer, 0, read);
            downstreamBytes[0] += read;
        }
        downstream.flush();
        downstreamClosedByUpstream.incrementAndGet();
    }

    private static void pipeFixed(InputStream input, OutputStream output, long length) throws IOException {
        byte[] buffer = new byte[PIPE_BUFFER];
        long remaining = length;
        while (remaining > 0) {
            int read = input.read(buffer, 0, (int) Math.min(buffer.length, remaining));
            if (read < 0) break;
            output.write(buffer, 0, read);
            remaining -= read;
        }
        output.flush();
    }

    private static void writeResponse(Socket socket, int status, String contentType, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        String head = "HTTP/1.1 " + status + "\r\ncontent-type: " + contentType + "\r\ncontent-length: " + bytes.length + "\r\nconnection: close\r\n\r\n";
        socket.getOutputStream().write(head.getBytes(StandardCharsets.US_ASCII));
        socket.getOutputStream().write(bytes);
        socket.getOutputStream().flush();
    }

    static void closeQuietly(Socket socket) {
        try { socket.close(); } catch (IOException ignored) { }
    }

    /** 最小 HTTP 请求解析：请求行 + 头（含 body 流式引用，不整包缓存）。content-type 透传（Core 数据服务按此做 415 校验）。 */
    private record Request(String method, String path, long contentLength, String contentType, InputStream bodyStream) {
        static Request parse(InputStream input) throws IOException {
            StringBuilder line = new StringBuilder();
            int ch;
            while ((ch = input.read()) >= 0 && ch != '\n') line.append((char) ch);
            if (line.length() == 0) return null;
            String[] parts = line.toString().trim().split(" ");
            if (parts.length < 2) return null;
            String method = parts[0].toUpperCase(Locale.ROOT);
            String path = URI.create(parts[1]).getPath();
            long contentLength = 0;
            String contentType = "";
            StringBuilder headerLine = new StringBuilder();
            while (true) {
                headerLine.setLength(0);
                while ((ch = input.read()) >= 0 && ch != '\n') headerLine.append((char) ch);
                String header = headerLine.toString().trim();
                if (header.isEmpty()) break;
                if (header.toLowerCase(Locale.ROOT).startsWith("content-length:")) {
                    contentLength = Long.parseLong(header.substring(header.indexOf(':') + 1).trim());
                } else if (header.toLowerCase(Locale.ROOT).startsWith("content-type:")) {
                    contentType = header.substring(header.indexOf(':') + 1).trim();
                }
            }
            return new Request(method, path, contentLength, contentType, input);
        }

        boolean isSse() { return "GET".equals(method) && path.startsWith("/api/core/events"); }

        void writeTo(OutputStream output, String nonce, String hostTag) throws IOException {
            // nonce 只由 gateway 注入到原生代理请求头（§2.3），不进入页面/URL/日志/payload
            StringBuilder head = new StringBuilder(method + " " + path + " HTTP/1.1\r\n")
                .append("host: 127.0.0.1\r\n")
                .append("x-core-nonce: ").append(nonce).append("\r\n")
                .append("x-core-protocol-version: 1.1\r\n")
                .append("connection: close\r\n");
            if (contentLength > 0) head.append("content-length: ").append(contentLength).append("\r\n");
            // 透传原 content-type（Core 数据服务 415 校验依赖；gateway 不改写业务头）
            if (contentType != null && !contentType.isEmpty()) head.append("content-type: ").append(contentType).append("\r\n");
            head.append("\r\n");
            output.write(head.toString().getBytes(StandardCharsets.US_ASCII));
            output.flush();
        }
    }
}
