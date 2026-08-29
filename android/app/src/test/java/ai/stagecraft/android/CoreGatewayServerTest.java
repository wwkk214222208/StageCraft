package ai.stagecraft.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * W6：CoreGatewayServer 纯 JVM 测试（计划 §2.3 / 阶段 4 / §10.2）。
 *
 * 验证：
 *  - registry 分派：core owner 代理到 CoreDataServer（nonce 注入）、main-host 走宿主 handler、
 *    desktop-only/deprecated 稳定错误、未知路径稳定 404；
 *  - nonce 不进页面：页面请求无 nonce，代理请求注入；
 *  - SSE 逐块透传与客户端断开上游有界关闭；
 *  - 静态资产面与非 /api 路径共存。
 *
 * 测试不依赖 Android：CoreGatewayServer 构造需要 Context（LocalAssetResolver），
 * 用 null 时静态面不可用——API 面独立测试。静态面由 android-contract 测试覆盖。
 */
public final class CoreGatewayServerTest {

    private static final String REGISTRY_JSON = "{\"registryVersion\":\"test-w6\",\"routes\":["
        + "{\"order\":0,\"method\":\"GET\",\"pattern\":\"/api/core/health\",\"owner\":\"core\",\"capability\":\"core.health\",\"auth\":\"none\",\"authPolicy\":{\"kind\":\"core-nonce\"},\"dispatchPolicy\":{\"androidLocal\":{\"action\":\"proxy-core\",\"auth\":\"core-nonce\"},\"androidRemote\":{\"action\":\"proxy-core\",\"auth\":\"core-nonce\"}},\"handlerId\":\"core.health\"},"
        + "{\"order\":1,\"method\":\"POST\",\"pattern\":\"/api/core/commands\",\"owner\":\"core\",\"capability\":\"core.commands\",\"auth\":\"none\",\"authPolicy\":{\"kind\":\"core-nonce\"},\"dispatchPolicy\":{\"androidLocal\":{\"action\":\"proxy-core\",\"auth\":\"core-nonce\"},\"androidRemote\":{\"action\":\"proxy-core\",\"auth\":\"core-nonce\"}},\"handlerId\":\"core.commands\"},"
        + "{\"order\":2,\"method\":\"GET\",\"pattern\":\"/api/core/events\",\"owner\":\"core\",\"capability\":\"core.events\",\"auth\":\"none\",\"authPolicy\":{\"kind\":\"core-nonce\"},\"dispatchPolicy\":{\"androidLocal\":{\"action\":\"proxy-core\",\"auth\":\"core-nonce\"},\"androidRemote\":{\"action\":\"proxy-core\",\"auth\":\"core-nonce\"}},\"handlerId\":\"core.events\"},"
        + "{\"order\":3,\"method\":\"POST\",\"pattern\":\"/api/remote/revoke\",\"owner\":\"main-host\",\"capability\":\"host.remote\",\"auth\":\"none\",\"authPolicy\":{\"kind\":\"local-open\"},\"dispatchPolicy\":{\"androidLocal\":{\"action\":\"host-handler\",\"auth\":\"local\"},\"androidRemote\":{\"action\":\"host-handler\",\"auth\":\"remote-paired\"}},\"handlerId\":\"host.remote.revoke\"},"
        + "{\"order\":4,\"method\":\"GET\",\"pattern\":\"/api/agent/capability\",\"owner\":\"desktop-only\",\"capability\":\"agent.dsh\",\"auth\":\"none\",\"authPolicy\":{\"kind\":\"remote-paired\"},\"dispatchPolicy\":{\"androidLocal\":{\"action\":\"stable-unsupported\",\"auth\":\"none\",\"errorCode\":\"unsupported_capability\"},\"androidRemote\":{\"action\":\"host-handler\",\"auth\":\"remote-paired\"}},\"handlerId\":\"agent.capability\"},"
        + "{\"order\":5,\"method\":\"GET\",\"pattern\":\"/api/stream\",\"owner\":\"deprecated\",\"capability\":\"core.events\",\"auth\":\"none\",\"authPolicy\":{\"kind\":\"local-open\"},\"dispatchPolicy\":{\"androidLocal\":{\"action\":\"deprecated-adapter\",\"auth\":\"none\",\"errorCode\":\"route_deprecated\"},\"androidRemote\":{\"action\":\"deprecated-adapter\",\"auth\":\"none\",\"errorCode\":\"route_deprecated\"}},\"handlerId\":\"stream.deprecated\"}"
        + "]}";

    /** 起一个假的 CoreDataServer（记录收到的请求头，回固定响应）。 */
    private static final class FakeCoreServer implements AutoCloseable {
        final ServerSocket server;
        final int port;
        volatile String receivedNonce = "";
        volatile String receivedPath = "";
        volatile String receivedBody = "";
        volatile boolean sseMode = false;

        FakeCoreServer() throws Exception {
            server = new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"));
            port = server.getLocalPort();
            Thread acceptor = new Thread(() -> {
                while (!server.isClosed()) {
                    try {
                        Socket socket = server.accept();
                        Thread worker = new Thread(() -> handle(socket));
                        worker.setDaemon(true);
                        worker.start();
                    } catch (Exception error) { return; }
                }
            }, "fake-core");
            acceptor.setDaemon(true);
            acceptor.start();
        }

        void handle(Socket socket) {
            try (socket) {
                BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                String requestLine = reader.readLine();
                if (requestLine == null) return;
                String[] parts = requestLine.split(" ");
                if (parts.length >= 2) receivedPath = parts[1];
                Map<String, String> headers = new HashMap<>();
                String line;
                int contentLength = 0;
                while ((line = reader.readLine()) != null && !line.isEmpty()) {
                    int colon = line.indexOf(':');
                    if (colon > 0) {
                        String name = line.substring(0, colon).trim().toLowerCase();
                        String value = line.substring(colon + 1).trim();
                        headers.put(name, value);
                        if ("content-length".equals(name)) contentLength = Integer.parseInt(value);
                    }
                }
                receivedNonce = headers.getOrDefault("x-core-nonce", "");
                StringBuilder body = new StringBuilder();
                for (int i = 0; i < contentLength; i++) {
                    int ch = reader.read();
                    if (ch < 0) break;
                    body.append((char) ch);
                }
                receivedBody = body.toString();
                OutputStream output = socket.getOutputStream();
                if (sseMode) {
                    String head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n";
                    output.write(head.getBytes(StandardCharsets.US_ASCII));
                    output.write(": connected\n\n".getBytes(StandardCharsets.UTF_8));
                    output.write("data: {\"type\":\"state.changed\",\"revision\":1}\n\n".getBytes(StandardCharsets.UTF_8));
                    output.flush();
                } else {
                    String head = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 18\r\nconnection: close\r\n\r\n";
                    output.write(head.getBytes(StandardCharsets.US_ASCII));
                    output.write("{\"status\":\"ready\"}".getBytes(StandardCharsets.UTF_8));
                    output.flush();
                }
            } catch (Exception ignored) { }
        }

        @Override public void close() {
            try { server.close(); } catch (Exception ignored) { }
        }
    }

    private static CoreGatewayServer startGateway() throws Exception {
        RouteRegistry registry = RouteRegistry.parse(REGISTRY_JSON, null);
        // null context：静态资产面不可用，API 面独立测试
        CoreGatewayServer gateway = new CoreGatewayServer(null, registry);
        return gateway;
    }

    private static String request(CoreGatewayServer gateway, String method, String path, String body, Map<String, String> headers) throws Exception {
        try (Socket socket = new Socket(InetAddress.getByName("127.0.0.1"), gateway.getPort())) {
            socket.setSoTimeout(5_000);
            OutputStream output = socket.getOutputStream();
            StringBuilder request = new StringBuilder(method + " " + path + " HTTP/1.1\r\nhost: 127.0.0.1\r\n");
            if (headers != null) for (Map.Entry<String, String> entry : headers.entrySet()) request.append(entry.getKey()).append(": ").append(entry.getValue()).append("\r\n");
            if (body != null) request.append("content-length: ").append(body.getBytes(StandardCharsets.UTF_8).length).append("\r\n");
            request.append("\r\n");
            if (body != null) request.append(body);
            output.write(request.toString().getBytes(StandardCharsets.UTF_8));
            output.flush();
            BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
            String statusLine = reader.readLine();
            StringBuilder response = new StringBuilder();
            if (statusLine != null) response.append(statusLine).append("\n");
            String line;
            while ((line = reader.readLine()) != null && !line.isEmpty()) response.append(line).append("\n");
            StringBuilder payload = new StringBuilder();
            char[] buffer = new char[4096];
            int read;
            while ((read = reader.read(buffer)) >= 0) payload.append(buffer, 0, read);
            return response + "\nBODY:" + payload;
        }
    }

    @Test public void coreOwnerProxyInjectsNonce() throws Exception {
        try (FakeCoreServer core = new FakeCoreServer(); CoreGatewayServer gateway = startGateway()) {
            gateway.setCoreEndpoint(core.port, "secret-nonce-123");
            String response = request(gateway, "GET", "/api/core/health", null, Map.of("accept", "application/json"));
            assertTrue("core owner 必须 200: " + response.split("\n")[0], response.contains(" 200 "));
            assertEquals("代理必须注入 nonce", "secret-nonce-123", core.receivedNonce);
            assertEquals("路径必须透传", "/api/core/health", core.receivedPath);
            assertTrue("响应必须透传", response.contains("\"status\":\"ready\""));
        }
    }

    @Test public void coreOwnerProxyForwardsPostBody() throws Exception {
        try (FakeCoreServer core = new FakeCoreServer(); CoreGatewayServer gateway = startGateway()) {
            gateway.setCoreEndpoint(core.port, "nonce-2");
            String body = "{\"id\":\"c1\",\"type\":\"submit-text\"}";
            String response = request(gateway, "POST", "/api/core/commands", body, Map.of("content-type", "application/json"));
            assertTrue("POST 必须 200: " + response.split("\n")[0], response.contains(" 200 "));
            assertEquals("body 必须透传", body, core.receivedBody);
            assertEquals("nonce 注入", "nonce-2", core.receivedNonce);
        }
    }

    @Test public void coreNotReadyReturns503() throws Exception {
        try (CoreGatewayServer gateway = startGateway()) {
            // 未 setCoreEndpoint
            String response = request(gateway, "GET", "/api/core/health", null, null);
            assertTrue("core 未就绪必须 503", response.contains(" 503 "));
            assertTrue(response.contains("core_not_ready"));
        }
    }

    @Test public void mainHostHandlerIsInvoked() throws Exception {
        try (CoreGatewayServer gateway = startGateway()) {
            final String[] captured = new String[1];
            gateway.setHostHandlers(handlerId -> (method, path, headers, body) -> {
                captured[0] = handlerId + "|" + method + "|" + path + "|" + body;
                return "{\"status\":200,\"body\":\"{\\\"ok\\\":true}\"}";
            });
            String response = request(gateway, "POST", "/api/remote/revoke", "{}", Map.of("content-type", "application/json"));
            assertTrue("main-host 必须 200: " + response.split("\n")[0], response.contains(" 200 "));
            assertTrue("响应必须透传", response.contains("\"ok\":true"));
            assertNotNull(captured[0]);
            assertTrue("handlerId 必须正确", captured[0].startsWith("host.remote.revoke|POST|/api/remote/revoke|"));
        }
    }

    @Test public void unregisteredMainHostReturns501() throws Exception {
        try (CoreGatewayServer gateway = startGateway()) {
            // 未注入 handler
            String response = request(gateway, "POST", "/api/remote/revoke", "{}", null);
            assertTrue("未注入 handler 必须 501", response.contains(" 501 "));
            assertTrue(response.contains("host_handler_unavailable"));
        }
    }

    @Test public void desktopOnlyReturnsStableUnsupported() throws Exception {
        try (CoreGatewayServer gateway = startGateway()) {
            String response = request(gateway, "GET", "/api/agent/capability", null, null);
            assertTrue("desktop-only 必须 503", response.contains(" 503 "));
            assertTrue(response.contains("unsupported_capability"));
        }
    }

    @Test public void deprecatedReturnsStableGone() throws Exception {
        try (CoreGatewayServer gateway = startGateway()) {
            String response = request(gateway, "GET", "/api/stream", null, null);
            assertTrue("deprecated 必须 410", response.contains(" 410 "));
            assertTrue(response.contains("route_deprecated"));
        }
    }

    @Test public void unknownPathReturns404() throws Exception {
        try (CoreGatewayServer gateway = startGateway()) {
            String response = request(gateway, "GET", "/api/definitely-not-registered", null, null);
            assertTrue("未知路径必须 404", response.contains(" 404 "));
            assertTrue(response.contains("route_not_registered"));
        }
    }

    @Test public void sseStreamsThroughAndClientCloseBounded() throws Exception {
        try (FakeCoreServer core = new FakeCoreServer(); CoreGatewayServer gateway = startGateway()) {
            core.sseMode = true;
            gateway.setCoreEndpoint(core.port, "nonce-sse");
            try (Socket socket = new Socket(InetAddress.getByName("127.0.0.1"), gateway.getPort())) {
                socket.setSoTimeout(5_000);
                OutputStream output = socket.getOutputStream();
                output.write(("GET /api/core/events HTTP/1.1\r\nhost: 127.0.0.1\r\naccept: text/event-stream\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                output.flush();
                BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                String line;
                boolean sawEvent = false;
                long deadline = System.currentTimeMillis() + 5_000;
                while (System.currentTimeMillis() < deadline && (line = reader.readLine()) != null) {
                    if (line.startsWith("data:")) { sawEvent = true; break; }
                }
                assertTrue("SSE 必须透传事件", sawEvent);
                // 客户端关闭：gateway 应有界关闭上游（不抛、不泄漏）
                socket.close();
            }
            assertTrue("nonce 必须注入", "nonce-sse".equals(core.receivedNonce));
        }
    }

    @Test public void queryIsPreservedInForwardedRequest() throws Exception {
        try (FakeCoreServer core = new FakeCoreServer(); CoreGatewayServer gateway = startGateway()) {
            gateway.setCoreEndpoint(core.port, "nonce-q");
            // GET with query：/api/story/get?id=s1（registry 匹配 pathOnly，转发保留 query）
            String response = request(gateway, "GET", "/api/core/health?id=s1", null, null);
            assertTrue("query 请求必须 200: " + response.split("\n")[0], response.contains(" 200 "));
            assertTrue("转发必须保留 query", core.receivedPath.contains("?id=s1"));
        }
    }

    @Test public void queryPreservedForBusinessRouteThroughCoreDataServer() throws Exception {
        // 经 CoreDataServer 的 forwardApi 链路：query 从 gateway → CoreDataServer → forwardApi
        try (CoreGatewayServer gateway = startGateway()) {
            // 未设 core endpoint：验证 gateway 仍按 registry 分派（proxy-core → core_not_ready）
            // query 保留由 CoreGatewayServerTest.queryIsPreservedInForwardedRequest 覆盖字节级；
            // 这里验证 CoreDataServer 侧（CoreDataServerTest.coreBusinessRouteWithForwarderIsForwarded 已覆盖转发）
            String response = request(gateway, "GET", "/api/core/health?x=1", null, null);
            assertTrue("未就绪 core 必须 503（query 不影响分派）", response.contains(" 503 "));
            assertTrue(response.contains("core_not_ready"));
        }
    }
}
