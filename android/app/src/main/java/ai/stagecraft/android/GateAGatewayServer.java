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

/**
 * W0 spike：主进程同源 UI gateway（计划 §2.3 / §5.4 / Q2）。
 *
 * 页面只访问本 gateway（127.0.0.1 随机端口，与页面同源）；core 路由按字节流代理到
 * CoreDataServer 并注入原生持有的 nonce。SSE 必须逐块透传（不得整包缓冲）；
 * 页面断开立即关闭上游 socket，上游断开立即结束下游（有界结束）。不解析业务 payload。
 */
public final class GateAGatewayServer {
    private static final int PIPE_BUFFER = 8 * 1024;

    private final String hostTag;
    private ServerSocket server;
    private int port = -1;
    private volatile int corePort = -1;
    private volatile String coreNonce = "";
    private final AtomicLong proxied = new AtomicLong();
    private final AtomicLong upstreamClosedByClient = new AtomicLong();
    private final AtomicLong downstreamClosedByUpstream = new AtomicLong();
    private final Map<Long, Socket> activeUpstreams = new ConcurrentHashMap<>();

    public GateAGatewayServer(String hostTag) {
        this.hostTag = hostTag;
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
            int currentCorePort = corePort;
            if (currentCorePort < 0) {
                writeResponse(client, 503, "application/json", "{\"error\":{\"code\":\"core_not_ready\",\"message\":\"core endpoint is not ready\"}}");
                return;
            }
            upstream = SocketFactory.getDefault().createSocket(InetAddress.getByName("127.0.0.1"), currentCorePort);
            activeUpstreams.put(connectionId, upstream);
            request.writeTo(upstream.getOutputStream(), coreNonce, hostTag);
            // 请求体（POST）转发
            if (request.contentLength > 0) pipeFixed(request.bodyStream, upstream.getOutputStream(), request.contentLength);
            if (request.isSse()) {
                pipeStreaming(upstream.getInputStream(), client.getOutputStream(), connectionId, true);
            } else {
                pipeResponseAndClose(upstream, client);
            }
            proxied.incrementAndGet();
        } catch (IOException error) {
            GateALog.i(hostTag + " gateway connection ended: " + error.getClass().getSimpleName());
        } finally {
            if (upstream != null) {
                closeQuietly(upstream);
                activeUpstreams.remove(connectionId);
            }
        }
    }

    /** SSE：逐块透传（读一块写一块立刻 flush）；客户端断开 → 关上游（取消传播）。 */
    private void pipeStreaming(InputStream upstreamInput, OutputStream downstream, long connectionId, boolean sse) throws IOException {
        byte[] buffer = new byte[PIPE_BUFFER];
        try {
            int read;
            while ((read = upstreamInput.read(buffer)) >= 0) {
                downstream.write(buffer, 0, read);
                downstream.flush(); // 逐块 flush 是"逐条送达"的关键，不得整包缓冲
            }
            downstreamClosedByUpstream.incrementAndGet();
            GateALog.i(hostTag + " upstream closed stream normally conn=" + connectionId);
        } catch (IOException clientDisconnected) {
            upstreamClosedByClient.incrementAndGet();
            GateALog.i(hostTag + " client disconnected, closing upstream conn=" + connectionId);
            throw clientDisconnected;
        }
    }

    /** 有限响应：透传上游状态行/头/体后关闭（JSON 请求用）。 */
    private void pipeResponseAndClose(Socket upstream, Socket client) throws IOException {
        InputStream input = upstream.getInputStream();
        OutputStream downstream = client.getOutputStream();
        byte[] buffer = new byte[PIPE_BUFFER];
        int read;
        while ((read = input.read(buffer)) >= 0) {
            downstream.write(buffer, 0, read);
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

    /** 最小 HTTP 请求解析：请求行 + 头（含 body 流式引用，不整包缓存）。 */
    private record Request(String method, String path, long contentLength, InputStream bodyStream) {
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
            StringBuilder headerLine = new StringBuilder();
            while (true) {
                headerLine.setLength(0);
                while ((ch = input.read()) >= 0 && ch != '\n') headerLine.append((char) ch);
                String header = headerLine.toString().trim();
                if (header.isEmpty()) break;
                if (header.toLowerCase(Locale.ROOT).startsWith("content-length:")) {
                    contentLength = Long.parseLong(header.substring(header.indexOf(':') + 1).trim());
                }
            }
            return new Request(method, path, contentLength, input);
        }

        boolean isSse() { return "GET".equals(method) && path.startsWith("/api/core/events"); }

        void writeTo(OutputStream output, String nonce, String hostTag) throws IOException {
            // nonce 只由 gateway 注入到原生代理请求头（§2.3），不进入页面/URL/日志/payload
            String head = method + " " + path + " HTTP/1.1\r\n"
                + "host: 127.0.0.1\r\n"
                + "x-core-nonce: " + nonce + "\r\n"
                + "x-core-protocol-version: 1.1\r\n"
                + "connection: close\r\n"
                + (contentLength > 0 ? "content-length: " + contentLength + "\r\n" : "")
                + "\r\n";
            output.write(head.getBytes(StandardCharsets.US_ASCII));
            output.flush();
        }
    }
}
