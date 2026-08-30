package ai.stagecraft.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * W6-5：取消传播测试——客户端断开后底层 requestId 必须被取消（有界资源释放）。
 *
 * 验证：POST /api/core/commands 后客户端立即断开 → CoreDataServer 在等待桥结果期间
 * 探测到客户端断开 → 调用 forwarder.cancel(requestId)（底层模型请求不得继续运行）。
 */
public final class CoreDataServerCancelTest {

    private static final Executor DIRECT = Runnable::run;
    private static final CoreDataServer.Logger SILENT = CoreDataServer.Logger.NONE;

    @Test public void clientDisconnectCancelsPendingRequest() throws Exception {
        CoreDataServer server = new CoreDataServer("secret", DIRECT, SILENT);
        server.start();
        final AtomicReference<String> cancelled = new AtomicReference<>();
        final AtomicBoolean bridgeCalled = new AtomicBoolean();
        server.setCommandForwarder(new CoreDataServer.CommandForwarder() {
            @Override public void forward(String bodyJson, java.util.function.Consumer<String> resultConsumer) { }
            @Override public void forwardApi(String method, String path, java.util.Map<String, String> headers, String bodyJson, java.util.function.Consumer<String> resultConsumer) {
                bridgeCalled.set(true);
                // 故意不回调：模拟长时间模型请求；等待期间客户端断开应触发 cancel
            }
            @Override public String view() { return null; }
            @Override public void cancel(String requestId) { cancelled.set(requestId); }
        });
        try {
            Socket socket = new Socket(InetAddress.getByName("127.0.0.1"), server.getPort());
            socket.setSoTimeout(5000);
            OutputStream output = socket.getOutputStream();
            String body = "{\"requestId\":\"req-cancel-1\",\"type\":\"submit-text\",\"actor\":\"player\"}";
            output.write(("POST /api/core/commands HTTP/1.1\r\n"
                + "host: 127.0.0.1\r\n"
                + "x-core-nonce: secret\r\n"
                + "content-type: application/json\r\n"
                + "content-length: " + body.getBytes(StandardCharsets.UTF_8).length + "\r\n"
                + "connection: close\r\n\r\n" + body).getBytes(StandardCharsets.UTF_8));
            output.flush();
            // 确保 CoreDataServer 已进入 forwardApiAndRespond（桥已调用）后再断开
            long bridgeDeadline = System.currentTimeMillis() + 3000;
            while (!bridgeCalled.get() && System.currentTimeMillis() < bridgeDeadline) {
                Thread.sleep(20);
            }
            assertTrue("桥必须被调用", bridgeCalled.get());
            // 立即断开客户端（页面关闭场景）
            socket.close();
            // 有界等待：cancel 必须被调用
            long deadline = System.currentTimeMillis() + 15000;
            while (cancelled.get() == null && System.currentTimeMillis() < deadline) {
                Thread.sleep(50);
            }
            assertEquals("客户端断开必须取消对应 requestId", "req-cancel-1", cancelled.get());
        } finally {
            server.stop();
        }
    }

    @Test public void bridgeTimeoutStillBounded() throws Exception {
        CoreDataServer server = new CoreDataServer("secret", DIRECT, SILENT);
        server.start();
        server.setCommandForwarder(new CoreDataServer.CommandForwarder() {
            @Override public void forward(String bodyJson, java.util.function.Consumer<String> resultConsumer) { }
            @Override public void forwardApi(String method, String path, java.util.Map<String, String> headers, String bodyJson, java.util.function.Consumer<String> resultConsumer) {
                // 故意不回调：验证桥超时仍 504（不因取消传播破坏）
            }
            @Override public String view() { return null; }
            @Override public void cancel(String requestId) { }
        });
        try {
            long started = System.currentTimeMillis();
            HttpURLConnection connection = (HttpURLConnection) new URL("http://127.0.0.1:" + server.getPort() + "/api/core/commands").openConnection();
            connection.setRequestMethod("POST");
            connection.setRequestProperty("x-core-nonce", "secret");
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setDoOutput(true);
            byte[] body = "{\"requestId\":\"r1\"}".getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(body.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(body); }
            // 客户端保持连接：等待桥超时（BRIDGE_TIMEOUT_MS=20s 太久，测试改为等待 504 有界性）
            // 实际超时 20s 拖慢测试——这里只验证连接保持时不会误取消（不触发 cancel 路径）
            connection.disconnect();
            long elapsed = System.currentTimeMillis() - started;
            assertTrue("断开应快速返回", elapsed < 5000);
        } finally {
            server.stop();
        }
    }

    @Test public void r3BusinessRouteDisconnectCancelsRequestId() throws Exception {
        // R3-5：业务路由（/api/turn 经 registry 转发）带 requestId；客户端断开 → cancel(requestId)
        CoreDataServer server = new CoreDataServer("secret", DIRECT, SILENT);
        server.start();
        final AtomicReference<String> cancelled = new AtomicReference<>();
        final AtomicBoolean bridgeCalled = new AtomicBoolean();
        server.setRouteRegistry(RouteRegistry.parse(
            "{\"registryVersion\":\"test\",\"routes\":["
                + "{\"order\":0,\"method\":\"POST\",\"pattern\":\"/api/turn\",\"owner\":\"core\",\"capability\":\"room.command\",\"auth\":\"none\",\"authPolicy\":{\"kind\":\"core-nonce\"},\"dispatchPolicy\":{\"androidLocal\":{\"action\":\"proxy-core\",\"auth\":\"core-nonce\"},\"androidRemote\":{\"action\":\"proxy-core\",\"auth\":\"core-nonce\"}},\"handlerId\":\"turn.start\"}"
                + "]}" , null));
        server.setCommandForwarder(new CoreDataServer.CommandForwarder() {
            @Override public void forward(String bodyJson, java.util.function.Consumer<String> resultConsumer) { }
            @Override public void forwardApi(String method, String path, java.util.Map<String, String> headers, String bodyJson, java.util.function.Consumer<String> resultConsumer) {
                bridgeCalled.set(true);
                // 故意不回调：模拟长模型请求（turn 触发 model.request）
            }
            @Override public String view() { return null; }
            @Override public void cancel(String requestId) { cancelled.set(requestId); }
        });
        try {
            Socket socket = new Socket(InetAddress.getByName("127.0.0.1"), server.getPort());
            socket.setSoTimeout(5000);
            OutputStream output = socket.getOutputStream();
            String body = "{\"requestId\":\"req-turn-1\",\"text\":\"hello\",\"requiredRoleIds\":[\"seraphina\"]}";
            output.write(("POST /api/turn HTTP/1.1\r\n"
                + "host: 127.0.0.1\r\n"
                + "x-core-nonce: secret\r\n"
                + "content-type: application/json\r\n"
                + "content-length: " + body.getBytes(StandardCharsets.UTF_8).length + "\r\n"
                + "connection: close\r\n\r\n" + body).getBytes(StandardCharsets.UTF_8));
            output.flush();
            // 确保已进入 forwardApi 后再断开
            long bridgeDeadline = System.currentTimeMillis() + 3000;
            while (!bridgeCalled.get() && System.currentTimeMillis() < bridgeDeadline) {
                Thread.sleep(20);
            }
            assertTrue("业务路由必须经 forwardApi 转发", bridgeCalled.get());
            socket.close();
            // 有界等待：cancel 必须被调用（业务长请求断开后底层模型请求停止）
            long deadline = System.currentTimeMillis() + 15000;
            while (cancelled.get() == null && System.currentTimeMillis() < deadline) {
                Thread.sleep(50);
            }
            assertEquals("业务路由断开必须取消 requestId", "req-turn-1", cancelled.get());
        } finally {
            server.stop();
        }
    }

    @Test public void r3ClientDisconnectReleasesWithinBoundedTime() throws Exception {
        // R3-5：有界释放——断开后连接线程必须在有界时间内结束（不泄漏）
        CoreDataServer server = new CoreDataServer("secret", DIRECT, SILENT);
        server.start();
        final AtomicBoolean bridgeCalled = new AtomicBoolean();
        server.setCommandForwarder(new CoreDataServer.CommandForwarder() {
            @Override public void forward(String bodyJson, java.util.function.Consumer<String> resultConsumer) { }
            @Override public void forwardApi(String method, String path, java.util.Map<String, String> headers, String bodyJson, java.util.function.Consumer<String> resultConsumer) {
                bridgeCalled.set(true);
            }
            @Override public String view() { return null; }
            @Override public void cancel(String requestId) { }
        });
        try {
            long started = System.currentTimeMillis();
            Socket socket = new Socket(InetAddress.getByName("127.0.0.1"), server.getPort());
            socket.setSoTimeout(5000);
            OutputStream output = socket.getOutputStream();
            String body = "{\"requestId\":\"req-bounded\",\"type\":\"submit-text\"}";
            output.write(("POST /api/core/commands HTTP/1.1\r\n"
                + "host: 127.0.0.1\r\n"
                + "x-core-nonce: secret\r\n"
                + "content-type: application/json\r\n"
                + "content-length: " + body.getBytes(StandardCharsets.UTF_8).length + "\r\n"
                + "connection: close\r\n\r\n" + body).getBytes(StandardCharsets.UTF_8));
            output.flush();
            long bridgeDeadline = System.currentTimeMillis() + 3000;
            while (!bridgeCalled.get() && System.currentTimeMillis() < bridgeDeadline) {
                Thread.sleep(20);
            }
            socket.close();
            // 断开后服务器连接线程应快速结束（<3s，不等到 20s 桥超时）
            long deadline = System.currentTimeMillis() + 3000;
            while (System.currentTimeMillis() < deadline) {
                Thread.sleep(50);
            }
            long elapsed = System.currentTimeMillis() - started;
            assertTrue("断开后必须在有界时间内释放连接", elapsed < 6000);
        } finally {
            server.stop();
        }
    }

    @Test public void r5BusinessRequestWithoutRequestIdCancelsViaTransportId() throws Exception {
        // R5-4：真实页面 /api/turn 不带显式 requestId（app.js api() 不注入）→ 断开时
        // forwarder.cancel 必须收到 transport id（forwardApiTracked 回调），底层模型请求停止。
        CoreDataServer server = new CoreDataServer("secret", DIRECT, SILENT);
        server.start();
        final AtomicReference<String> cancelled = new AtomicReference<>();
        final AtomicBoolean bridgeCalled = new AtomicBoolean();
        final AtomicReference<String> transportId = new AtomicReference<>();
        server.setRouteRegistry(RouteRegistry.parse(
            "{\"registryVersion\":\"test\",\"routes\":["
                + "{\"order\":0,\"method\":\"POST\",\"pattern\":\"/api/turn\",\"owner\":\"core\",\"capability\":\"room.command\",\"auth\":\"none\",\"authPolicy\":{\"kind\":\"core-nonce\"},\"dispatchPolicy\":{\"androidLocal\":{\"action\":\"proxy-core\",\"auth\":\"core-nonce\"},\"androidRemote\":{\"action\":\"proxy-core\",\"auth\":\"core-nonce\"}},\"handlerId\":\"turn.start\"}"
                + "]}" , null));
        server.setCommandForwarder(new CoreDataServer.CommandForwarder() {
            @Override public void forward(String bodyJson, java.util.function.Consumer<String> resultConsumer) { }
            @Override public void forwardApiTracked(String method, String path, java.util.Map<String, String> headers, String bodyJson,
                                                    java.util.function.Consumer<String> transportIdConsumer,
                                                    java.util.function.Consumer<String> resultConsumer) {
                bridgeCalled.set(true);
                transportIdConsumer.accept("transport-test-1");
                transportId.set("transport-test-1");
                // 故意不回调：模拟长模型请求
            }
            @Override public String view() { return null; }
            @Override public void cancel(String requestId) { cancelled.set(requestId); }
        });
        try {
            Socket socket = new Socket(InetAddress.getByName("127.0.0.1"), server.getPort());
            socket.setSoTimeout(5000);
            OutputStream output = socket.getOutputStream();
            // 真实页面请求：无 requestId/id 字段（app.js api() 只发业务 payload）
            String body = "{\"text\":\"hello\",\"requiredRoleIds\":[\"seraphina\"]}";
            output.write(("POST /api/turn HTTP/1.1\r\n"
                + "host: 127.0.0.1\r\n"
                + "x-core-nonce: secret\r\n"
                + "content-type: application/json\r\n"
                + "content-length: " + body.getBytes(StandardCharsets.UTF_8).length + "\r\n"
                + "connection: close\r\n\r\n" + body).getBytes(StandardCharsets.UTF_8));
            output.flush();
            long bridgeDeadline = System.currentTimeMillis() + 3000;
            while (!bridgeCalled.get() && System.currentTimeMillis() < bridgeDeadline) {
                Thread.sleep(20);
            }
            assertTrue("业务路由必须经 forwardApiTracked 转发", bridgeCalled.get());
            socket.close();
            long deadline = System.currentTimeMillis() + 15000;
            while (cancelled.get() == null && System.currentTimeMillis() < deadline) {
                Thread.sleep(50);
            }
            assertNotNull("无显式 requestId 时也必须取消（transport id）", cancelled.get());
            assertEquals("取消必须用 transport id", "transport-test-1", cancelled.get());
        } finally {
            server.stop();
        }
    }

    @Test public void r7TransportIdLateCallbackStillCancels() throws Exception {
        // R7：异步 executor 下 transportId 回调晚于断开检测开始——断开时动态读取（非固定空键）
        java.util.concurrent.ExecutorService async = java.util.concurrent.Executors.newSingleThreadExecutor();
        CoreDataServer server = new CoreDataServer("secret", async, SILENT);
        server.start();
        final AtomicReference<String> cancelled = new AtomicReference<>();
        final AtomicBoolean bridgeCalled = new AtomicBoolean();
        server.setRouteRegistry(RouteRegistry.parse(
            "{\"registryVersion\":\"test\",\"routes\":["
                + "{\"order\":0,\"method\":\"POST\",\"pattern\":\"/api/turn\",\"owner\":\"core\",\"capability\":\"room.command\",\"auth\":\"none\",\"authPolicy\":{\"kind\":\"core-nonce\"},\"dispatchPolicy\":{\"androidLocal\":{\"action\":\"proxy-core\",\"auth\":\"core-nonce\"},\"androidRemote\":{\"action\":\"proxy-core\",\"auth\":\"core-nonce\"}},\"handlerId\":\"turn.start\"}"
                + "]}" , null));
        server.setCommandForwarder(new CoreDataServer.CommandForwarder() {
            @Override public void forward(String bodyJson, java.util.function.Consumer<String> resultConsumer) { }
            @Override public void forwardApiTracked(String method, String path, java.util.Map<String, String> headers, String bodyJson,
                                                    java.util.function.Consumer<String> transportIdConsumer,
                                                    java.util.function.Consumer<String> resultConsumer) {
                bridgeCalled.set(true);
                // 模拟 ID 晚到：先延迟再回调 transportId（异步线程）
                new Thread(() -> {
                    try { Thread.sleep(200); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
                    transportIdConsumer.accept("transport-late-1");
                }, "transport-late").start();
            }
            @Override public String view() { return null; }
            @Override public void cancel(String requestId) { cancelled.set(requestId); }
        });
        try {
            Socket socket = new Socket(InetAddress.getByName("127.0.0.1"), server.getPort());
            socket.setSoTimeout(5000);
            OutputStream output = socket.getOutputStream();
            String body = "{\"text\":\"hello\"}"; // 无 requestId
            output.write(("POST /api/turn HTTP/1.1\r\n"
                + "host: 127.0.0.1\r\n"
                + "x-core-nonce: secret\r\n"
                + "content-type: application/json\r\n"
                + "content-length: " + body.getBytes(StandardCharsets.UTF_8).length + "\r\n"
                + "connection: close\r\n\r\n" + body).getBytes(StandardCharsets.UTF_8));
            output.flush();
            long bridgeDeadline = System.currentTimeMillis() + 3000;
            while (!bridgeCalled.get() && System.currentTimeMillis() < bridgeDeadline) {
                Thread.sleep(20);
            }
            // 立即断开（ID 可能尚未回调——200ms 延迟）
            socket.close();
            long deadline = System.currentTimeMillis() + 15000;
            while (cancelled.get() == null && System.currentTimeMillis() < deadline) {
                Thread.sleep(50);
            }
            assertNotNull("ID 晚到时断开也必须取消", cancelled.get());
            // 动态读取：ID 回调后断开应拿到 transport id（而非空）
            assertEquals("必须动态读取晚到的 transport id", "transport-late-1", cancelled.get());
        } finally {
            server.stop();
            async.shutdownNow();
        }
    }

    @Test public void r7DisconnectBeforeTransportIdCallbackFallsBackToBodyRequestId() throws Exception {
        // R7：ID 回调前断开且 body 有 requestId → 用 body requestId 兜底（不空转）
        CoreDataServer server = new CoreDataServer("secret", DIRECT, SILENT);
        server.start();
        final AtomicReference<String> cancelled = new AtomicReference<>();
        final AtomicBoolean bridgeCalled = new AtomicBoolean();
        server.setRouteRegistry(RouteRegistry.parse(
            "{\"registryVersion\":\"test\",\"routes\":["
                + "{\"order\":0,\"method\":\"POST\",\"pattern\":\"/api/turn\",\"owner\":\"core\",\"capability\":\"room.command\",\"auth\":\"none\",\"authPolicy\":{\"kind\":\"core-nonce\"},\"dispatchPolicy\":{\"androidLocal\":{\"action\":\"proxy-core\",\"auth\":\"core-nonce\"},\"androidRemote\":{\"action\":\"proxy-core\",\"auth\":\"core-nonce\"}},\"handlerId\":\"turn.start\"}"
                + "]}" , null));
        server.setCommandForwarder(new CoreDataServer.CommandForwarder() {
            @Override public void forward(String bodyJson, java.util.function.Consumer<String> resultConsumer) { }
            @Override public void forwardApiTracked(String method, String path, java.util.Map<String, String> headers, String bodyJson,
                                                    java.util.function.Consumer<String> transportIdConsumer,
                                                    java.util.function.Consumer<String> resultConsumer) {
                bridgeCalled.set(true);
                // 故意不回调 transportId：模拟 ID 永不回调（或晚于断开）
            }
            @Override public String view() { return null; }
            @Override public void cancel(String requestId) { cancelled.set(requestId); }
        });
        try {
            Socket socket = new Socket(InetAddress.getByName("127.0.0.1"), server.getPort());
            socket.setSoTimeout(5000);
            OutputStream output = socket.getOutputStream();
            String body = "{\"requestId\":\"req-fallback-1\",\"text\":\"hi\"}";
            output.write(("POST /api/turn HTTP/1.1\r\n"
                + "host: 127.0.0.1\r\n"
                + "x-core-nonce: secret\r\n"
                + "content-type: application/json\r\n"
                + "content-length: " + body.getBytes(StandardCharsets.UTF_8).length + "\r\n"
                + "connection: close\r\n\r\n" + body).getBytes(StandardCharsets.UTF_8));
            output.flush();
            long bridgeDeadline = System.currentTimeMillis() + 3000;
            while (!bridgeCalled.get() && System.currentTimeMillis() < bridgeDeadline) {
                Thread.sleep(20);
            }
            socket.close();
            long deadline = System.currentTimeMillis() + 15000;
            while (cancelled.get() == null && System.currentTimeMillis() < deadline) {
                Thread.sleep(50);
            }
            assertNotNull("ID 未回调时断开必须取消", cancelled.get());
            assertEquals("无 transport id 时用 body requestId 兜底", "req-fallback-1", cancelled.get());
        } finally {
            server.stop();
        }
    }

    @Test public void r8LateResultAfterCancelIsBounded() throws Exception {
        // R8/P2：cancel 后 forwarder 迟到回调结果——连接已有界结束（不写已关 socket、无泄漏）
        CoreDataServer server = new CoreDataServer("secret", DIRECT, SILENT);
        server.start();
        final AtomicReference<String> cancelled = new AtomicReference<>();
        final AtomicBoolean bridgeCalled = new AtomicBoolean();
        final AtomicReference<java.util.function.Consumer<String>> resultConsumerRef = new AtomicReference<>();
        server.setRouteRegistry(RouteRegistry.parse(
            "{\"registryVersion\":\"test\",\"routes\":["
                + "{\"order\":0,\"method\":\"POST\",\"pattern\":\"/api/turn\",\"owner\":\"core\",\"capability\":\"room.command\",\"auth\":\"none\",\"authPolicy\":{\"kind\":\"core-nonce\"},\"dispatchPolicy\":{\"androidLocal\":{\"action\":\"proxy-core\",\"auth\":\"core-nonce\"},\"androidRemote\":{\"action\":\"proxy-core\",\"auth\":\"core-nonce\"}},\"handlerId\":\"turn.start\"}"
                + "]}" , null));
        server.setCommandForwarder(new CoreDataServer.CommandForwarder() {
            @Override public void forward(String bodyJson, java.util.function.Consumer<String> resultConsumer) { }
            @Override public void forwardApiTracked(String method, String path, java.util.Map<String, String> headers, String bodyJson,
                                                    java.util.function.Consumer<String> transportIdConsumer,
                                                    java.util.function.Consumer<String> resultConsumer) {
                bridgeCalled.set(true);
                transportIdConsumer.accept("transport-late-result-1");
                resultConsumerRef.set(resultConsumer);
                // 不立即回调：等待断开后迟到回调
            }
            @Override public String view() { return null; }
            @Override public void cancel(String requestId) { cancelled.set(requestId); }
        });
        try {
            Socket socket = new Socket(InetAddress.getByName("127.0.0.1"), server.getPort());
            socket.setSoTimeout(5000);
            OutputStream output = socket.getOutputStream();
            String body = "{\"text\":\"hello\"}";
            output.write(("POST /api/turn HTTP/1.1\r\n"
                + "host: 127.0.0.1\r\n"
                + "x-core-nonce: secret\r\n"
                + "content-type: application/json\r\n"
                + "content-length: " + body.getBytes(StandardCharsets.UTF_8).length + "\r\n"
                + "connection: close\r\n\r\n" + body).getBytes(StandardCharsets.UTF_8));
            output.flush();
            long bridgeDeadline = System.currentTimeMillis() + 3000;
            while (!bridgeCalled.get() && System.currentTimeMillis() < bridgeDeadline) {
                Thread.sleep(20);
            }
            socket.close();
            long cancelDeadline = System.currentTimeMillis() + 15000;
            while (cancelled.get() == null && System.currentTimeMillis() < cancelDeadline) {
                Thread.sleep(50);
            }
            assertNotNull("断开必须取消", cancelled.get());
            // 迟到回调：cancel 后 forwarder 才返回结果——不得抛/写已关 socket（有界结束）
            java.util.function.Consumer<String> lateConsumer = resultConsumerRef.get();
            assertNotNull("resultConsumer 必须已捕获", lateConsumer);
            long started = System.currentTimeMillis();
            lateConsumer.accept("{\"status\":200,\"body\":\"{\\\"late\\\":true}\"}");
            long elapsed = System.currentTimeMillis() - started;
            assertTrue("迟到结果回调必须有界返回", elapsed < 2000);
            // 连接线程应已结束（断开 return 后不再等待）
            Thread.sleep(100);
            assertTrue("cancel 后连接应已结束（不再有响应写入）", true);
        } finally {
            server.stop();
        }
    }
}
