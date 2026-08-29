package ai.stagecraft.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Gate B/C 收口测试（JVM，无 Robolectric）：
 *  - Gate B：Java RouteRegistry 消费构建期 JSON 资产（100+ 路由、歧义失败、authPolicy 显式、sha256 核对）；
 *            NativeOperationGuard 在真实分派层执行 allowlist（legacy-main-core 封闭例外）。
 *  - Gate C：TS 黄金样本（protocol-fixtures.json）在 Java 侧逐条对等断言（版本协商/envelope/receipt/SSE 帧）；
 *            真实 HTTP 边界行为（401/413/415/404/200/SSE 逐条/超时 504）。
 * 资产路径按 gradle 单测工作目录（android/app）解析。
 */
public class GateBcClosureTest {

    private static String readAsset(String name) throws Exception {
        for (String prefix : new String[]{"src/main/assets/", "../../android/app/src/main/assets/"}) {
            File file = new File(prefix + name);
            if (file.exists()) {
                try (FileInputStream input = new FileInputStream(file)) {
                    byte[] bytes = new byte[input.available()];
                    int read = input.read(bytes);
                    return new String(bytes, 0, Math.max(0, read), StandardCharsets.UTF_8);
                }
            }
        }
        throw new IllegalStateException("asset not found: " + name);
    }

    // ── Gate B：RouteRegistry ──

    @Test
    public void routeRegistryLoadsRealAssetWithAuthPolicy() throws Exception {
        RouteRegistry registry = RouteRegistry.parse(readAsset("api-route-registry.json"), null);
        assertTrue("真实 registry 应有 100+ 路由，实际 " + registry.size(), registry.size() >= 100);
        RouteRegistry.Route core = registry.match("GET", "/api/room");
        assertNotNull(core);
        assertEquals("core", core.owner);
        assertEquals("core-nonce", core.authPolicy.optString("kind"));
        RouteRegistry.Route host = registry.match("PUT", "/api/remote/sync");
        assertNotNull(host);
        assertEquals("main-host", host.owner);
        assertEquals("local-open", host.authPolicy.optString("kind"));
        RouteRegistry.Route desktop = registry.match("POST", "/api/agent/message");
        assertNotNull(desktop);
        assertEquals("remote-paired", desktop.authPolicy.optString("kind"));
    }

    @Test
    public void routeRegistryMatchSemanticsQ6() throws Exception {
        RouteRegistry registry = RouteRegistry.parse(readAsset("api-route-registry.json"), null);
        assertNull("未登记 method 不得命中", registry.match("DELETE", "/api/room"));
        assertNull(registry.match("GET", "/api/definitely/not/registered"));
        assertEquals("room.snapshot", registry.match("GET", "/api/room?x=1").handlerId);
        assertEquals("story.get", registry.match("GET", "/api/story/get").handlerId);
    }

    @Test
    public void routeRegistryRejectsDuplicateAndAmbiguousAndMissingAuth() throws Exception {
        String base = readAsset("api-route-registry.json");
        JSONObject root = new JSONObject(base);
        JSONArray routes = root.getJSONArray("routes");
        JSONObject duplicate = routes.getJSONObject(0);
        routes.put(duplicate);
        try {
            RouteRegistry.parse(root.toString(), null);
            fail("重复 (method,pattern) 必须使 parse 失败");
        } catch (RouteRegistry.RegistryException expected) { }

        JSONObject ambiguousRoot = new JSONObject();
        ambiguousRoot.put("registryVersion", "test");
        ambiguousRoot.put("routes", new JSONArray()
            .put(new JSONObject().put("order", 0).put("method", "POST").put("pattern", "/api/a/{}")
                .put("owner", "core").put("capability", "c").put("handlerId", "h1")
                .put("auth", "none").put("authPolicy", new JSONObject().put("kind", "core-nonce")))
            .put(new JSONObject().put("order", 1).put("method", "POST").put("pattern", "/api/a/{id}")
                .put("owner", "core").put("capability", "c").put("auth", "none").put("handlerId", "h2")
                .put("authPolicy", new JSONObject().put("kind", "core-nonce"))));
        try {
            RouteRegistry.parse(ambiguousRoot.toString(), null);
            fail("同形状歧义 pattern 必须使 parse 失败");
        } catch (RouteRegistry.RegistryException expected) { }

        JSONObject missingAuth = new JSONObject(ambiguousRoot.toString());
        JSONArray missingAuthRoutes = missingAuth.getJSONArray("routes");
        missingAuthRoutes.getJSONObject(1).remove("authPolicy");
        try {
            RouteRegistry.parse(missingAuth.toString(), null);
            fail("缺少显式 authPolicy 必须使 parse 失败（Gate B）");
        } catch (RouteRegistry.RegistryException expected) { }
    }

    @Test
    public void routeRegistrySha256Verification() throws Exception {
        String json = readAsset("api-route-registry.json");
        RouteRegistry registry = RouteRegistry.parse(json, null);
        RouteRegistry parsed = RouteRegistry.parse(json, RouteRegistry.sha256Hex(json));
        assertEquals("registry 版本必须与 fixture 一致（Gate B 可核对）",
            fixtures().getJSONObject("boundaries").getString("registryVersion"), registry.registryVersion());
        assertEquals("registry sha256 必须与 fixture 一致（Gate B 可核对）",
            fixtures().getJSONObject("boundaries").getString("registrySha256"), parsed.sha256());
        try {
            RouteRegistry.parse(json, "deadbeef");
            fail("sha256 不一致必须拒绝");
        } catch (RouteRegistry.RegistryException expected) { }
    }

    // ── Gate B：NativeOperationGuard ──

    @Test
    public void nativeOperationGuardEnforcesRealDispatch() throws Exception {
        NativeOperationGuard guard = NativeOperationGuard.parse(readAsset("native-operation-registry.json"), false);
        System.out.println("[diag] legacy=" + guard.legacyMainCore());
        System.out.println("[diag] mainHost=" + guard.mainHost());
        String archiveRejection = guard.checkGenericDispatch("archive.list");
        if (archiveRejection != null) fail("archive.list rejected: " + archiveRejection);
        String modelRejection = guard.checkGenericDispatch("model.request");
        if (modelRejection != null) fail("model.request rejected: " + modelRejection);
        assertNotNull(guard.checkGenericDispatch("made.up.operation"), "未登记操作必须拒绝");
        assertNotNull(guard.checkCoreNative("pair"), "main-host 操作不得进入 core 侧");
        assertNull(guard.checkCoreNative("stagecraft.repository"));

        NativeOperationGuard gateD = NativeOperationGuard.parse(readAsset("native-operation-registry.json"), true);
        assertNotNull(gateD.checkGenericDispatch("archive.list"), "Gate D 翻转后 legacy 例外必须拒绝");
    }

    // ── Gate C：协议黄金样本对等 ──

    private static JSONObject fixtures() throws Exception {
        return new JSONObject(readAsset("protocol-fixtures.json"));
    }

    @Test
    public void versionNegotiationMatchesTsImplementation() throws Exception {
        JSONArray cases = fixtures().getJSONArray("versionNegotiation");
        assertTrue(cases.length() >= 6);
        for (int index = 0; index < cases.length(); index++) {
            JSONObject item = cases.getJSONObject(index);
            boolean expected = item.getBoolean("expectedSupported");
            boolean actual = CoreProtocolSupport.supports(
                item.getString("clientVersion"), item.getString("serverMin"), item.getString("serverMax"));
            assertEquals("版本协商不一致: " + item, expected, actual);
        }
        // 混合段数字段（1.1 vs 1.1.0）两侧必须同语义
        assertEquals(0, CoreProtocolSupport.compareVersions("1.1", "1.1.0"));
    }

    @Test
    public void envelopesFromFixtureAreValidOnJavaSide() throws Exception {
        JSONArray envelopes = fixtures().getJSONArray("envelopes");
        for (int index = 0; index < envelopes.length(); index++) {
            JSONObject envelope = envelopes.getJSONObject(index);
            assertTrue(CoreProtocolSupport.isEnvelope(envelope));
            assertTrue(CoreProtocolSupport.isValidEnvelope(envelope));
        }
        JSONObject broken = new JSONObject(envelopes.getJSONObject(0).toString());
        broken.remove("roomId");
        assertFalse(CoreProtocolSupport.isValidEnvelope(broken));
    }

    @Test
    public void receiptsFromFixtureAreValidatedOnJavaSide() throws Exception {
        JSONArray receipts = fixtures().getJSONArray("receipts");
        for (int index = 0; index < receipts.length(); index++) {
            assertTrue(CoreProtocolSupport.isValidReceipt(receipts.getJSONObject(index)));
        }
        assertFalse(CoreProtocolSupport.isValidReceipt(new JSONObject("{\"requestId\":\"x\",\"status\":\"maybe\"}")));
        assertFalse(CoreProtocolSupport.isValidReceipt(new JSONObject("{\"status\":\"accepted\"}")));
        assertFalse("rejected 必须带 error", CoreProtocolSupport.isValidReceipt(new JSONObject("{\"requestId\":\"x\",\"status\":\"rejected\"}")));
    }

    @Test
    public void sseFramesFromFixtureParseThroughJavaSseParser() throws Exception {
        JSONArray frames = fixtures().getJSONArray("sseFrames");
        SseParser parser = new SseParser();
        java.util.List<String> parsed = new java.util.ArrayList<>();
        for (int index = 0; index < frames.length(); index++) parsed.addAll(parser.accept(frames.getString(index)));
        assertEquals("SSE 帧应逐条解析", frames.length(), parsed.size());
        for (int index = 0; index < frames.length(); index++) {
            JSONObject frameEnvelope = new JSONObject(parsed.get(index));
            assertTrue(CoreProtocolSupport.isValidEnvelope(frameEnvelope));
            assertEquals(frameEnvelope.getJSONObject("payload").optString("type"), frameEnvelope.optString("type"));
        }
    }

    @Test
    public void boundaryConstantsMatchFixture() throws Exception {
        JSONObject boundaries = fixtures().getJSONObject("boundaries");
        assertEquals(boundaries.getInt("maxBodyBytes"), GateACoreDataServer.MAX_BODY_BYTES);
        assertEquals(boundaries.getInt("bridgeTimeoutMs"), 20000);
    }

    @Test
    public void unsupportedCapabilityFixtureIsStable() throws Exception {
        JSONObject error = fixtures().getJSONObject("boundaries").getJSONObject("unsupportedCapabilityError");
        assertEquals("unsupported_capability", error.getString("code"));
    }

    // ── Gate C：真实 HTTP 边界行为（JVM 直连 CoreDataServer，驱动 401/413/415/404/200/SSE/超时）──

    /** 直执行 dispatcher：命令转发回调同步完成（模拟 :core 主线程立即回执），避免 Handler/Looper 依赖。 */
    private static final GateACoreDataServer.RunnableDispatcher DIRECT = Runnable::run;

    private static String httpRequest(int port, String method, String path, java.util.Map<String, String> headers, String body) throws Exception {
        try (Socket socket = new Socket(InetAddress.getByName("127.0.0.1"), port)) {
            socket.setSoTimeout(5000);
            StringBuilder request = new StringBuilder(method + " " + path + " HTTP/1.1\r\n");
            request.append("host: 127.0.0.1\r\n");
            if (headers != null) for (java.util.Map.Entry<String, String> entry : headers.entrySet()) request.append(entry.getKey()).append(": ").append(entry.getValue()).append("\r\n");
            if (body != null) request.append("content-length: ").append(body.getBytes(StandardCharsets.UTF_8).length).append("\r\n");
            request.append("\r\n");
            if (body != null) request.append(body);
            OutputStream output = socket.getOutputStream();
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

    private static GateACoreDataServer startBoundaryServer() throws Exception {
        GateACoreDataServer server = new GateACoreDataServer("test-nonce", DIRECT);
        server.setHealthJson("{\"protocolVersion\":\"1.1\",\"status\":\"ready\"}");
        server.setCommandForwarder((body, callback) -> callback.accept("{\"requestId\":\"rq\",\"status\":\"accepted\",\"revision\":8}"));
        server.start();
        return server;
    }

    @Test
    public void coreDataServerBoundaryBehaviors() throws Exception {
        GateACoreDataServer server = startBoundaryServer();
        try {
            int port = server.getPort();
            // 401：缺 nonce
            String noNonce = httpRequest(port, "GET", "/api/core/health", java.util.Map.of(), null);
            assertTrue("缺 nonce 必须 401，实际: " + noNonce.split("\n")[0], noNonce.contains("401"));
            assertTrue("缺 nonce 错误码必须 unauthorized", noNonce.contains("unauthorized"));
            // 401：nonce 错误
            String wrongNonce = httpRequest(port, "GET", "/api/core/health", java.util.Map.of("x-core-nonce", "wrong"), null);
            assertTrue("错 nonce 必须 401", wrongNonce.contains("401"));
            // 200：health 带 nonce，且 health 含协议版本
            String health = httpRequest(port, "GET", "/api/core/health", java.util.Map.of("x-core-nonce", "test-nonce"), null);
            assertTrue("health 必须 200: " + health.split("\n")[0], health.contains("200"));
            assertTrue("health 必须含协议版本", health.contains("\"protocolVersion\":\"1.1\""));
            // 404：未知路径（稳定错误，不是随机 503）
            String unknown = httpRequest(port, "GET", "/api/core/definitely-not", java.util.Map.of("x-core-nonce", "test-nonce"), null);
            assertTrue("未知路径必须稳定 404", unknown.contains("404"));
            assertTrue("404 必须带稳定错误码 not_found", unknown.contains("not_found"));
            // 413：body 超限（MAX_BODY_BYTES+1）
            String oversized = httpRequest(port, "POST", "/api/core/commands",
                java.util.Map.of("x-core-nonce", "test-nonce", "content-type", "application/json"),
                "{\"x\":\"" + "a".repeat(GateACoreDataServer.MAX_BODY_BYTES) + "\"}");
            assertTrue("超限 body 必须 413", oversized.contains("413"));
            assertTrue("413 必须带稳定错误码 payload_too_large", oversized.contains("payload_too_large"));
            // 415：POST 但 content-type 非 JSON
            String wrongType = httpRequest(port, "POST", "/api/core/commands",
                java.util.Map.of("x-core-nonce", "test-nonce", "content-type", "text/plain"),
                "{}");
            assertTrue("非 JSON content-type 必须 415", wrongType.contains("415"));
            assertTrue("415 必须带稳定错误码 unsupported_media_type", wrongType.contains("unsupported_media_type"));
            // 415：无 content-type
            String noType = httpRequest(port, "POST", "/api/core/commands", java.util.Map.of("x-core-nonce", "test-nonce"), "{}");
            assertTrue("缺 content-type 必须 415", noType.contains("415"));
            // 200：合法命令回执透传（requestId/status/accepted）
            String accepted = httpRequest(port, "POST", "/api/core/commands",
                java.util.Map.of("x-core-nonce", "test-nonce", "content-type", "application/json"),
                "{\"requestId\":\"rq\",\"type\":\"submit-text\",\"actor\":\"player\"}");
            assertTrue("合法命令必须 200: " + accepted.split("\n")[0], accepted.contains("200"));
            assertTrue("回执必须透传 accepted", accepted.contains("\"status\":\"accepted\""));
            assertTrue("回执必须透传 revision", accepted.contains("\"revision\":8"));
            // 404：POST 到非命令路径也稳定
            String postUnknown = httpRequest(port, "POST", "/api/core/nope", java.util.Map.of("x-core-nonce", "test-nonce", "content-type", "application/json"), "{}");
            assertTrue("未知 POST 路径必须 404", postUnknown.contains("404"));
        } finally {
            server.stop();
        }
    }

    @Test
    public void coreDataServerSseStreamingAndContentType() throws Exception {
        GateACoreDataServer server = startBoundaryServer();
        try {
            int port = server.getPort();
            try (Socket socket = new Socket(InetAddress.getByName("127.0.0.1"), port)) {
                socket.setSoTimeout(3000);
                OutputStream output = socket.getOutputStream();
                output.write(("GET /api/core/events HTTP/1.1\r\nhost: 127.0.0.1\r\nx-core-nonce: test-nonce\r\n\r\n").getBytes(StandardCharsets.UTF_8));
                output.flush();
                BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                String statusLine = reader.readLine();
                assertTrue("SSE 必须 200，实际: " + statusLine, statusLine != null && statusLine.contains("200"));
                String contentType = null;
                String line;
                while ((line = reader.readLine()) != null && !line.isEmpty()) {
                    if (line.toLowerCase().startsWith("content-type:")) contentType = line.substring("content-type:".length()).trim();
                }
                assertEquals("SSE 必须声明 text/event-stream", "text/event-stream", contentType);
                // 订阅确认行
                String confirm = reader.readLine();
                assertTrue("必须收到订阅确认行", confirm != null && confirm.startsWith(": connected"));
                // 事件逐条送达（先确认后派发；写循环异步，循环读直到 data: 帧或超时）
                JSONObject event = new JSONObject()
                    .put("protocolVersion", "1.1").put("roomId", "r").put("revision", 1)
                    .put("type", "state.changed").put("payload", new JSONObject().put("revision", 1)).put("createdAt", "2026-08-29T00:00:00.000Z");
                server.publishCoreEvent(event);
                String frame = readSseFrame(reader);
                assertNotNull("SSE 必须逐条收到事件帧", frame);
                assertTrue("SSE 帧必须以 data: 开头", frame.startsWith("data: "));
                JSONObject received = new JSONObject(frame.substring("data: ".length()));
                assertTrue(CoreProtocolSupport.isValidEnvelope(received));
                assertEquals("state.changed", received.getString("type"));
                // 第二条事件（连续逐条）
                JSONObject second = new JSONObject(event.toString()).put("revision", 2).put("type", "model.thinking.delta")
                    .put("payload", new JSONObject().put("revision", 2).put("requestId", "fx").put("text", "思"));
                server.publishCoreEvent(second);
                String secondFrame = readSseFrame(reader);
                assertNotNull("第二条事件必须逐条到达", secondFrame);
                assertTrue(new JSONObject(secondFrame.substring("data: ".length())).getString("type").equals("model.thinking.delta"));
            }
        } finally {
            server.stop();
        }
    }

    /** 读下一条 data: SSE 帧；跳过注释行/空行，直到 data: 或超时（返回 null）。 */
    private static String readSseFrame(BufferedReader reader) throws Exception {
        long deadline = System.currentTimeMillis() + 3000;
        String line;
        while ((line = reader.readLine()) != null) {
            if (line.startsWith("data: ")) return line;
            if (System.currentTimeMillis() > deadline) return null;
        }
        return null;
    }

    @Test
    public void coreDataServerBridgeTimeoutIsBounded() throws Exception {
        // 桥回调永不返回：连接线程必须在有界时间内回 504，不得泄漏（注入 500ms 短超时避免拖慢测试）
        GateACoreDataServer server = new GateACoreDataServer("test-nonce", DIRECT, 500);
        server.setHealthJson("{\"protocolVersion\":\"1.1\",\"status\":\"ready\"}");
        server.setCommandForwarder((body, callback) -> { /* 故意不回调 */ });
        server.start();
        try {
            long started = System.currentTimeMillis();
            String result = httpRequest(server.getPort(), "POST", "/api/core/commands",
                java.util.Map.of("x-core-nonce", "test-nonce", "content-type", "application/json"),
                "{\"requestId\":\"rq\",\"type\":\"submit-text\",\"actor\":\"player\"}");
            long elapsed = System.currentTimeMillis() - started;
            assertTrue("504 必须带稳定错误码 bridge_timeout", result.contains("bridge_timeout"));
            assertTrue("504 必须稳定返回（有界），实际: " + result.split("\n")[0], result.contains("504"));
            assertTrue("超时必须在有界时间内（<3s），实际 " + elapsed + "ms", elapsed < 3000);
        } finally {
            server.stop();
        }
    }
}
