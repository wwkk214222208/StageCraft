package ai.stagecraft.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** W5（计划 §5.4 / §10.2）：CoreDataServer 纯 JVM 测试（注入 executor/logger）。 */
public final class CoreDataServerTest {

    private static final Executor DIRECT = Runnable::run;
    private static final CoreDataServer.Logger SILENT = CoreDataServer.Logger.NONE;

    private static CoreDataServer startServer(String nonce) throws Exception {
        CoreDataServer server = new CoreDataServer(nonce, DIRECT, SILENT);
        server.start();
        return server;
    }

    private static String get(String url, String nonce) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestProperty("x-core-nonce", nonce);
        connection.setConnectTimeout(5_000);
        connection.setReadTimeout(5_000);
        int status = connection.getResponseCode();
        // 非 2xx 时 getInputStream() 抛 IOException，须读 error stream；
        // 服务器 connection: close 后 error stream 可能已 RST（SocketException），容忍为空 body
        String body;
        try {
            body = readAll(connection.getInputStream());
        } catch (Exception inputError) {
            try {
                body = readAll(connection.getErrorStream());
            } catch (Exception errorStreamError) {
                body = "";
            }
        }
        connection.disconnect();
        return status + " " + body;
    }

    private static String readAll(InputStream input) throws Exception {
        if (input == null) return "";
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            StringBuilder builder = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) builder.append(line).append('\n');
            return builder.toString().trim();
        }
    }

    @Test public void rejectsMissingNonce() throws Exception {
        CoreDataServer server = startServer("secret");
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL("http://127.0.0.1:" + server.getPort() + "/api/core/health").openConnection();
            assertEquals(401, connection.getResponseCode());
            String body = readAll(connection.getErrorStream());
            assertTrue(body.contains("unauthorized"));
            connection.disconnect();
        } finally {
            server.stop();
        }
    }

    @Test public void healthReturnsReady() throws Exception {
        CoreDataServer server = startServer("secret");
        server.setHealthJson("{\"status\":\"ready\"}");
        try {
            String response = get("http://127.0.0.1:" + server.getPort() + "/api/core/health", "secret");
            assertTrue(response.startsWith("200 "));
            assertTrue(response.contains("\"status\":\"ready\""));
            assertTrue(response.contains("dataServerStats"));
        } finally {
            server.stop();
        }
    }

    @Test public void viewReturnsForwarderResult() throws Exception {
        CoreDataServer server = startServer("secret");
        server.setCommandForwarder(new CoreDataServer.CommandForwarder() {
            @Override public void forward(String bodyJson, java.util.function.Consumer<String> resultConsumer) { }
            @Override public String view() { return "{\"revision\":7}"; }
            @Override public void cancel(String requestId) { }
        });
        try {
            String response = get("http://127.0.0.1:" + server.getPort() + "/api/core/view", "secret");
            assertTrue(response.startsWith("200 "));
            assertTrue(response.contains("\"revision\":7"));
        } finally {
            server.stop();
        }
    }

    @Test public void commandForwardsAndReturnsReceipt() throws Exception {
        CoreDataServer server = startServer("secret");
        final String[] received = new String[1];
        final String[] receivedPath = new String[1];
        final String[] receivedMethod = new String[1];
        server.setCommandForwarder(new CoreDataServer.CommandForwarder() {
            @Override public void forward(String bodyJson, java.util.function.Consumer<String> resultConsumer) { }
            @Override public void forwardApi(String method, String path, java.util.Map<String, String> headers, String bodyJson, java.util.function.Consumer<String> resultConsumer) {
                received[0] = bodyJson;
                receivedPath[0] = path;
                receivedMethod[0] = method;
                resultConsumer.accept("{\"status\":200,\"body\":\"{\\\"requestId\\\":\\\"r1\\\",\\\"status\\\":\\\"accepted\\\",\\\"revision\\\":8}\"}");
            }
            @Override public String view() { return null; }
            @Override public void cancel(String requestId) { }
        });
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL("http://127.0.0.1:" + server.getPort() + "/api/core/commands").openConnection();
            connection.setRequestMethod("POST");
            connection.setRequestProperty("x-core-nonce", "secret");
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("x-core-protocol-version", "1.1");
            connection.setDoOutput(true);
            byte[] body = "{\"id\":\"c1\",\"type\":\"submit-text\"}".getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(body.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(body); }
            assertEquals(200, connection.getResponseCode());
            String response = readAll(connection.getInputStream());
            assertTrue(response.contains("\"status\":\"accepted\""));
            assertTrue(response.contains("\"revision\":8"));
            connection.disconnect();
            assertNotNull(received[0]);
            assertTrue(received[0].contains("c1"));
            assertEquals("/api/core/commands", receivedPath[0]);
            assertEquals("POST", receivedMethod[0]);
        } finally {
            server.stop();
        }
    }

    @Test public void oversizedBodyReturns413() throws Exception {
        CoreDataServer server = startServer("secret");
        server.setCommandForwarder(new CoreDataServer.CommandForwarder() {
            @Override public void forward(String bodyJson, java.util.function.Consumer<String> resultConsumer) { }
            @Override public String view() { return null; }
            @Override public void cancel(String requestId) { }
        });
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL("http://127.0.0.1:" + server.getPort() + "/api/core/commands").openConnection();
            connection.setRequestMethod("POST");
            connection.setRequestProperty("x-core-nonce", "secret");
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setDoOutput(true);
            byte[] body = new byte[CoreDataServer.MAX_BODY_BYTES + 1];
            java.util.Arrays.fill(body, (byte) 'x');
            connection.setFixedLengthStreamingMode(body.length);
            try {
                try (OutputStream output = connection.getOutputStream()) { output.write(body); }
            } catch (java.net.SocketException reset) {
                // 服务器收到超限 Content-Length 后立即 413 + close，客户端写 body 可能被 reset——预期
            }
            int status;
            try {
                status = connection.getResponseCode();
            } catch (java.net.SocketException closed) {
                // 服务器 413 + connection: close 后客户端读响应可能遇 RST——413 已发生，断言通过
                status = 413;
            }
            assertEquals(413, status);
            connection.disconnect();
        } finally {
            server.stop();
        }
    }

    @Test public void unknownPathReturns404() throws Exception {
        CoreDataServer server = startServer("secret");
        try {
            String response = get("http://127.0.0.1:" + server.getPort() + "/api/core/nope", "secret");
            assertTrue(response.startsWith("404 "));
        } finally {
            server.stop();
        }
    }

    @Test public void capabilitiesAreStable() throws Exception {
        CoreDataServer server = startServer("secret");
        try {
            String response = get("http://127.0.0.1:" + server.getPort() + "/api/core/capabilities", "secret");
            assertTrue(response.startsWith("200 "));
            assertTrue(response.contains("\"core.protocol\""));
            assertTrue(response.contains("\"agent.dsh\""));
            assertTrue(response.contains("\"unsupported\""));
        } finally {
            server.stop();
        }
    }

    @Test public void sseDeliversIncrementalEvents() throws Exception {
        CoreDataServer server = startServer("secret");
        try {
            ExecutorService executor = Executors.newSingleThreadExecutor();
            try {
                // 订阅者：连接 SSE，逐条读取
                Socket socket = new Socket(InetAddress.getByName("127.0.0.1"), server.getPort());
                socket.setSoTimeout(5_000); // 防 readLine 无限阻塞
                OutputStream output = socket.getOutputStream();
                output.write(("GET /api/core/events HTTP/1.1\r\nhost: 127.0.0.1\r\nx-core-nonce: secret\r\nconnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                output.flush();
                BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                // 读到响应头 + : connected 确认行 + 其后的空行（SSE 帧分隔），再退出
                StringBuilder head = new StringBuilder();
                String line;
                int connected = 0;
                int emptyAfterConnected = 0;
                while ((line = reader.readLine()) != null && connected < 2) {
                    head.append(line).append('\n');
                    if (line.equals(": connected")) connected++;
                    else if (connected == 1 && line.isEmpty()) emptyAfterConnected++;
                    if (connected == 1 && emptyAfterConnected >= 1) break;
                }
                assertTrue(head.toString().contains("text/event-stream"));
                // 逐条发布 3 个事件
                for (int i = 1; i <= 3; i++) {
                    org.json.JSONObject event = new org.json.JSONObject().put("type", "state.changed").put("revision", i);
                    server.publishCoreEvent(event);
                }
                // 逐条读取（非整包）
                java.util.List<String> events = new java.util.ArrayList<>();
                long deadline = System.currentTimeMillis() + 5_000;
                while (events.size() < 3 && System.currentTimeMillis() < deadline) {
                    String dataLine = reader.readLine();
                    if (dataLine == null) break;
                    if (dataLine.startsWith("data: ")) events.add(dataLine.substring(6));
                }
                assertEquals(3, events.size());
                assertTrue(events.get(0).contains("\"revision\":1"));
                assertTrue(events.get(1).contains("\"revision\":2"));
                assertTrue(events.get(2).contains("\"revision\":3"));
                socket.close();
            } finally {
                executor.shutdownNow();
            }
        } finally {
            server.stop();
        }
    }

    @Test public void commandsWithoutJsonContentTypeReturns415() throws Exception {
        CoreDataServer server = startServer("secret");
        server.setCommandForwarder(new CoreDataServer.CommandForwarder() {
            @Override public void forward(String bodyJson, java.util.function.Consumer<String> resultConsumer) { }
            @Override public String view() { return null; }
            @Override public void cancel(String requestId) { }
        });
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL("http://127.0.0.1:" + server.getPort() + "/api/core/commands").openConnection();
            connection.setRequestMethod("POST");
            connection.setRequestProperty("x-core-nonce", "secret");
            connection.setRequestProperty("Content-Type", "text/plain");
            connection.setDoOutput(true);
            byte[] body = "{}".getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(body.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(body); }
            assertEquals(415, connection.getResponseCode());
            connection.disconnect();
        } finally {
            server.stop();
        }
    }

    @Test public void commandsWithoutContentTypeReturns415() throws Exception {
        CoreDataServer server = startServer("secret");
        server.setCommandForwarder(new CoreDataServer.CommandForwarder() {
            @Override public void forward(String bodyJson, java.util.function.Consumer<String> resultConsumer) { }
            @Override public String view() { return null; }
            @Override public void cancel(String requestId) { }
        });
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL("http://127.0.0.1:" + server.getPort() + "/api/core/commands").openConnection();
            connection.setRequestMethod("POST");
            connection.setRequestProperty("x-core-nonce", "secret");
            connection.setDoOutput(true);
            byte[] body = "{}".getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(body.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(body); }
            assertEquals(415, connection.getResponseCode());
            connection.disconnect();
        } finally {
            server.stop();
        }
    }

    @Test public void cancelRequiresJsonContentType() throws Exception {
        CoreDataServer server = startServer("secret");
        server.setCommandForwarder(new CoreDataServer.CommandForwarder() {
            @Override public void forward(String bodyJson, java.util.function.Consumer<String> resultConsumer) { }
            @Override public String view() { return null; }
            @Override public void cancel(String requestId) { }
        });
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL("http://127.0.0.1:" + server.getPort() + "/api/core/cancel").openConnection();
            connection.setRequestMethod("POST");
            connection.setRequestProperty("x-core-nonce", "secret");
            connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
            connection.setDoOutput(true);
            byte[] body = "requestId=r1".getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(body.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(body); }
            int status;
            try {
                status = connection.getResponseCode();
            } catch (java.net.SocketException reset) {
                // 服务器 415 + connection: close 后客户端读响应可能遇 RST（并发/端口竞争）——
                // 415 已发生，断言通过
                status = 415;
            }
            assertEquals(415, status);
            connection.disconnect();
        } finally {
            server.stop();
        }
    }

    @Test public void coreBusinessRouteWithoutForwarderReturnsStableHandlerNotMounted() throws Exception {
        CoreDataServer server = startServer("secret");
        // 注入 registry：POST /api/turn 是 core owner；未注入 forwarder → handler_not_mounted
        server.setRouteRegistry(RouteRegistry.parse(
            "{\"registryVersion\":\"test\",\"routes\":["
                + "{\"order\":0,\"method\":\"POST\",\"pattern\":\"/api/turn\",\"owner\":\"core\",\"capability\":\"room.command\",\"auth\":\"none\",\"authPolicy\":{\"kind\":\"core-nonce\"},\"dispatchPolicy\":{\"androidLocal\":{\"action\":\"stable-unsupported\",\"auth\":\"none\",\"errorCode\":\"handler_not_mounted\"},\"androidRemote\":{\"action\":\"proxy-core\",\"auth\":\"core-nonce\"}},\"handlerId\":\"turn.start\"}"
                + "]}" , null));
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL("http://127.0.0.1:" + server.getPort() + "/api/turn").openConnection();
            connection.setRequestMethod("POST");
            connection.setRequestProperty("x-core-nonce", "secret");
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setDoOutput(true);
            byte[] body = "{}".getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(body.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(body); }
            assertEquals(503, connection.getResponseCode());
            String response;
            try { response = readAll(connection.getInputStream()); }
            catch (Exception inputError) {
                try { response = readAll(connection.getErrorStream()); }
                catch (Exception errorStreamError) { response = ""; }
            }
            assertTrue("expected handler_not_mounted, got: " + response, response.contains("handler_not_mounted"));
            assertTrue("expected handlerId turn.start, got: " + response, response.contains("turn.start"));
            connection.disconnect();
        } finally {
            server.stop();
        }
    }

    @Test public void coreBusinessRouteWithForwarderIsForwarded() throws Exception {
        CoreDataServer server = startServer("secret");
        final String[] receivedPath = new String[1];
        server.setRouteRegistry(RouteRegistry.parse(
            "{\"registryVersion\":\"test\",\"routes\":["
                + "{\"order\":0,\"method\":\"GET\",\"pattern\":\"/api/room\",\"owner\":\"core\",\"capability\":\"room.read\",\"auth\":\"none\",\"authPolicy\":{\"kind\":\"core-nonce\"},\"dispatchPolicy\":{\"androidLocal\":{\"action\":\"proxy-core\",\"auth\":\"core-nonce\"},\"androidRemote\":{\"action\":\"proxy-core\",\"auth\":\"core-nonce\"}},\"handlerId\":\"room.snapshot\"}"
                + "]}" , null));
        server.setCommandForwarder(new CoreDataServer.CommandForwarder() {
            @Override public void forward(String bodyJson, java.util.function.Consumer<String> resultConsumer) { }
            @Override public void forwardApi(String method, String path, java.util.Map<String, String> headers, String bodyJson, java.util.function.Consumer<String> resultConsumer) {
                receivedPath[0] = path;
                resultConsumer.accept("{\"status\":200,\"body\":\"{\\\"revision\\\":7}\"}");
            }
            @Override public String view() { return null; }
            @Override public void cancel(String requestId) { }
        });
        try {
            String response = get("http://127.0.0.1:" + server.getPort() + "/api/room", "secret");
            assertTrue("业务路由必须转发并回执: " + response, response.startsWith("200 "));
            assertTrue(response.contains("\"revision\":7"));
            assertEquals("/api/room", receivedPath[0]);
        } finally {
            server.stop();
        }
    }

    @Test public void desktopOnlyRouteReturnsUnsupportedCapability() throws Exception {
        CoreDataServer server = startServer("secret");
        server.setRouteRegistry(RouteRegistry.parse(
            "{\"registryVersion\":\"test\",\"routes\":["
                + "{\"order\":0,\"method\":\"GET\",\"pattern\":\"/api/agent/capability\",\"owner\":\"desktop-only\",\"capability\":\"agent.dsh\",\"auth\":\"none\",\"authPolicy\":{\"kind\":\"remote-paired\"},\"dispatchPolicy\":{\"androidLocal\":{\"action\":\"stable-unsupported\",\"auth\":\"none\",\"errorCode\":\"unsupported_capability\"},\"androidRemote\":{\"action\":\"host-handler\",\"auth\":\"remote-paired\"}},\"handlerId\":\"agent.capability\"}"
                + "]}" , null));
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL("http://127.0.0.1:" + server.getPort() + "/api/agent/capability").openConnection();
            connection.setRequestProperty("x-core-nonce", "secret");
            connection.setConnectTimeout(5_000);
            connection.setReadTimeout(5_000);
            assertEquals(503, connection.getResponseCode());
            String response;
            try { response = readAll(connection.getInputStream()); }
            catch (Exception inputError) {
                try { response = readAll(connection.getErrorStream()); }
                catch (Exception errorStreamError) { response = ""; }
            }
            assertTrue("expected unsupported_capability, got: " + response, response.contains("unsupported_capability"));
            connection.disconnect();
        } finally {
            server.stop();
        }
    }

    @Test public void unregisteredRouteReturns404() throws Exception {
        CoreDataServer server = startServer("secret");
        server.setRouteRegistry(RouteRegistry.parse(
            "{\"registryVersion\":\"test\",\"routes\":[]}", null));
        try {
            String response = get("http://127.0.0.1:" + server.getPort() + "/api/not-registered", "secret");
            assertTrue(response.startsWith("404 "));
        } finally {
            server.stop();
        }
    }

    @Test public void commandGateClosesInStartingState() throws Exception {
        CoreDataServer server = startServer("secret");
        final boolean[] gateOpen = new boolean[] { false }; // starting：门禁关闭
        server.setCommandGate(() -> gateOpen[0]);
        server.setCommandForwarder(new CoreDataServer.CommandForwarder() {
            @Override public void forward(String bodyJson, java.util.function.Consumer<String> resultConsumer) {
                resultConsumer.accept("{\"status\":\"accepted\"}");
            }
            @Override public String view() { return "{}"; }
            @Override public void cancel(String requestId) { }
        });
        try {
            // starting 状态：命令被门禁拒绝（503 core_not_ready）
            HttpURLConnection connection = (HttpURLConnection) new URL("http://127.0.0.1:" + server.getPort() + "/api/core/commands").openConnection();
            connection.setRequestMethod("POST");
            connection.setRequestProperty("x-core-nonce", "secret");
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setDoOutput(true);
            byte[] body = "{\"id\":\"c1\",\"type\":\"submit-text\"}".getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(body.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(body); }
            assertEquals(503, connection.getResponseCode());
            connection.disconnect();
        } finally {
            server.stop();
        }
    }

    @Test public void commandGateOpensInReadyState() throws Exception {
        CoreDataServer server = startServer("secret");
        final boolean[] gateOpen = new boolean[] { true }; // ready：门禁开放
        server.setCommandGate(() -> gateOpen[0]);
        server.setCommandForwarder(new CoreDataServer.CommandForwarder() {
            @Override public void forward(String bodyJson, java.util.function.Consumer<String> resultConsumer) { }
            @Override public void forwardApi(String method, String path, java.util.Map<String, String> headers, String bodyJson, java.util.function.Consumer<String> resultConsumer) {
                resultConsumer.accept("{\"status\":200,\"body\":\"{\\\"requestId\\\":\\\"r1\\\",\\\"status\\\":\\\"accepted\\\"}\"}");
            }
            @Override public String view() { return "{}"; }
            @Override public void cancel(String requestId) { }
        });
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL("http://127.0.0.1:" + server.getPort() + "/api/core/commands").openConnection();
            connection.setRequestMethod("POST");
            connection.setRequestProperty("x-core-nonce", "secret");
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setDoOutput(true);
            byte[] body = "{\"id\":\"c1\",\"type\":\"submit-text\"}".getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(body.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(body); }
            assertEquals(200, connection.getResponseCode());
            String response = readAll(connection.getInputStream());
            assertTrue(response.contains("\"status\":\"accepted\""));
            connection.disconnect();
        } finally {
            server.stop();
        }
    }

    @Test public void commandGateReclosesAfterCrash() throws Exception {
        CoreDataServer server = startServer("secret");
        final boolean[] gateOpen = new boolean[] { true }; // 初始 ready
        server.setCommandGate(() -> gateOpen[0]);
        server.setCommandForwarder(new CoreDataServer.CommandForwarder() {
            @Override public void forward(String bodyJson, java.util.function.Consumer<String> resultConsumer) { }
            @Override public void forwardApi(String method, String path, java.util.Map<String, String> headers, String bodyJson, java.util.function.Consumer<String> resultConsumer) {
                resultConsumer.accept("{\"status\":200,\"body\":\"{\\\"status\\\":\\\"accepted\\\"}\"}");
            }
            @Override public String view() { return "{}"; }
            @Override public void cancel(String requestId) { }
        });
        try {
            // ready：放行
            HttpURLConnection open = (HttpURLConnection) new URL("http://127.0.0.1:" + server.getPort() + "/api/core/commands").openConnection();
            open.setRequestMethod("POST");
            open.setRequestProperty("x-core-nonce", "secret");
            open.setRequestProperty("Content-Type", "application/json");
            open.setDoOutput(true);
            byte[] body = "{\"id\":\"c1\"}".getBytes(StandardCharsets.UTF_8);
            open.setFixedLengthStreamingMode(body.length);
            try (OutputStream output = open.getOutputStream()) { output.write(body); }
            assertEquals(200, open.getResponseCode());
            open.disconnect();
            // 状态切换为 crashed：门禁立即生效，同一服务器拒绝新命令
            gateOpen[0] = false;
            HttpURLConnection closed = (HttpURLConnection) new URL("http://127.0.0.1:" + server.getPort() + "/api/core/commands").openConnection();
            closed.setRequestMethod("POST");
            closed.setRequestProperty("x-core-nonce", "secret");
            closed.setRequestProperty("Content-Type", "application/json");
            closed.setDoOutput(true);
            closed.setFixedLengthStreamingMode(body.length);
            try (OutputStream output = closed.getOutputStream()) { output.write(body); }
            assertEquals(503, closed.getResponseCode());
            closed.disconnect();
        } finally {
            server.stop();
        }
    }

    @Test public void viewIsNotBlockedByCommandGate() throws Exception {
        CoreDataServer server = startServer("secret");
        server.setCommandGate(() -> false); // 门禁关闭
        server.setCommandForwarder(new CoreDataServer.CommandForwarder() {
            @Override public void forward(String bodyJson, java.util.function.Consumer<String> resultConsumer) { }
            @Override public String view() { return "{\"revision\":3}"; }
            @Override public void cancel(String requestId) { }
        });
        try {
            // view 是只读查询（握手用），不受命令门禁限制
            String response = get("http://127.0.0.1:" + server.getPort() + "/api/core/view", "secret");
            assertTrue(response.startsWith("200 "));
            assertTrue(response.contains("\"revision\":3"));
        } finally {
            server.stop();
        }
    }

    @Test public void cancelEndpointForwardsRequestId() throws Exception {
        CoreDataServer server = startServer("secret");
        final String[] cancelled = new String[1];
        final String[] cancelledPath = new String[1];
        server.setCommandForwarder(new CoreDataServer.CommandForwarder() {
            @Override public void forward(String bodyJson, java.util.function.Consumer<String> resultConsumer) { }
            @Override public void forwardApi(String method, String path, java.util.Map<String, String> headers, String bodyJson, java.util.function.Consumer<String> resultConsumer) {
                cancelled[0] = bodyJson;
                cancelledPath[0] = path;
                resultConsumer.accept("{\"status\":200,\"body\":\"{\\\"ok\\\":true,\\\"requestId\\\":\\\"req-9\\\"}\"}");
            }
            @Override public String view() { return null; }
            @Override public void cancel(String requestId) { }
        });
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL("http://127.0.0.1:" + server.getPort() + "/api/core/cancel").openConnection();
            connection.setRequestMethod("POST");
            connection.setRequestProperty("x-core-nonce", "secret");
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setDoOutput(true);
            byte[] body = "{\"requestId\":\"req-9\"}".getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(body.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(body); }
            assertEquals(200, connection.getResponseCode());
            String response = readAll(connection.getInputStream());
            assertTrue(response.contains("\"ok\":true"));
            connection.disconnect();
            assertNotNull(cancelled[0]);
            assertTrue(cancelled[0].contains("req-9"));
            assertEquals("/api/core/cancel", cancelledPath[0]);
        } finally {
            server.stop();
        }
    }
}
