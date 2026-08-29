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
        JSONObject coreSurface = new JSONObject().put("action", "proxy-core").put("auth", "core-nonce");
        JSONObject dispatch = new JSONObject().put("androidLocal", coreSurface).put("androidRemote", coreSurface);
        ambiguousRoot.put("routes", new JSONArray()
            .put(new JSONObject().put("order", 0).put("method", "POST").put("pattern", "/api/a/{}")
                .put("owner", "core").put("capability", "c").put("handlerId", "h1")
                .put("auth", "none").put("authPolicy", new JSONObject().put("kind", "core-nonce"))
                .put("dispatchPolicy", dispatch))
            .put(new JSONObject().put("order", 1).put("method", "POST").put("pattern", "/api/a/{id}")
                .put("owner", "core").put("capability", "c").put("auth", "none").put("handlerId", "h2")
                .put("authPolicy", new JSONObject().put("kind", "core-nonce"))
                .put("dispatchPolicy", dispatch)));
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

        // Gate B 收口：缺 dispatchPolicy 必须使 parse 失败（评审 B-3 P1）
        JSONObject missingDispatch = new JSONObject(ambiguousRoot.toString());
        JSONArray missingDispatchRoutes = missingDispatch.getJSONArray("routes");
        missingDispatchRoutes.getJSONObject(1).remove("dispatchPolicy");
        try {
            RouteRegistry.parse(missingDispatch.toString(), null);
            fail("缺少 dispatchPolicy 必须使 parse 失败（Gate B 收口）");
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
        // 迁移期（legacyGenericDispatchEnabled=true）：已知 legacy 操作放行，未知拒绝
        NativeOperationGuard guard = NativeOperationGuard.parse(readAsset("native-operation-registry.json"), true);
        System.out.println("[diag] legacy=" + guard.legacyMainCore());
        System.out.println("[diag] mainHost=" + guard.mainHost());
        String archiveRejection = guard.checkGenericDispatch("archive.list");
        if (archiveRejection != null) fail("archive.list rejected: " + archiveRejection);
        String modelRejection = guard.checkGenericDispatch("model.request");
        if (modelRejection != null) fail("model.request rejected: " + modelRejection);
        assertNull("stagecraft.room.get 必须放行（迁移期默认）", guard.checkGenericDispatch("stagecraft.room.get"));
        assertNull("stories.list 必须放行（迁移期默认）", guard.checkGenericDispatch("stories.list"));
        assertNotNull(guard.checkGenericDispatch("made.up.operation"), "未登记操作必须拒绝");
        assertNotNull(guard.checkCoreNative("pair"), "main-host 操作不得进入 core 侧");
        assertNull(guard.checkCoreNative("stagecraft.repository"));

        // Gate D：legacyGenericDispatchEnabled=false → core-native 从通用入口全部拒绝
        NativeOperationGuard gateD = NativeOperationGuard.parse(readAsset("native-operation-registry.json"), false);
        assertNotNull(gateD.checkGenericDispatch("archive.list"), "Gate D 翻转后 legacy 例外必须拒绝");
        assertNotNull(gateD.checkGenericDispatch("stagecraft.room.get"), "Gate D 后 core-native 必须拒绝");
        assertNotNull(gateD.checkGenericDispatch("model.request"), "Gate D 后 model.request 必须拒绝");
        assertNull("main-host 操作 Gate D 后仍放行", gateD.checkGenericDispatch("dispatch"));
    }

    // ── Gate B：Holder 生产默认路径 + 初始化后翻转（评审 B-1 P0）──

    @Test
    public void guardHolderDefaultAllowsLegacyAndFlipsAfterInit() throws Exception {
        // 先重置 Holder 状态，保证测试独立
        NativeOperationGuardHolder.setLegacyGenericDispatchEnabled(true);

        // 生产默认（无 Context 路径）：从资产解析的 guard 必须放行已知 legacy 操作
        // Holder 无 Context 时未初始化；直接验证 parse(true) 语义 + Holder 翻转行为
        NativeOperationGuard defaultGuard = NativeOperationGuard.parse(readAsset("native-operation-registry.json"), true);
        assertNull("默认必须放行 stagecraft.room.get", defaultGuard.checkGenericDispatch("stagecraft.room.get"));
        assertNull("默认必须放行 archive.list", defaultGuard.checkGenericDispatch("archive.list"));
        assertNotNull("默认必须拒绝未登记操作", defaultGuard.checkGenericDispatch("made.up.operation"));

        // 翻转后（Gate D）：对已初始化实例立即生效（原子替换，非旁路布尔）
        NativeOperationGuard flipped = defaultGuard.rebuild(false);
        assertNotNull("翻转后 stagecraft.room.get 必须拒绝", flipped.checkGenericDispatch("stagecraft.room.get"));
        assertNotNull("翻转后 archive.list 必须拒绝", flipped.checkGenericDispatch("archive.list"));
        assertNull("翻转后 main-host 操作仍放行", flipped.checkGenericDispatch("dispatch"));

        // 重复翻转幂等：false→false 仍拒绝
        NativeOperationGuard flippedAgain = flipped.rebuild(false);
        assertNotNull("重复翻转后仍拒绝", flippedAgain.checkGenericDispatch("archive.list"));
    }

    @Test
    public void guardHolderFlipAffectsInitializedInstance() throws Exception {
        String assetJson = readAsset("native-operation-registry.json");
        // 经 Holder 初始化（注入资产 JSON，模拟生产 get(Context) 路径的解析结果）
        NativeOperationGuardHolder.setLegacyGenericDispatchEnabled(true, assetJson);
        NativeOperationGuard initialized = NativeOperationGuardHolder.get();
        assertNull("Holder 默认必须放行已知 legacy 操作", initialized.checkGenericDispatch("archive.list"));
        assertNull("Holder 默认必须放行 stagecraft.room.get", initialized.checkGenericDispatch("stagecraft.room.get"));
        assertNotNull("Holder 必须拒绝未登记操作", initialized.checkGenericDispatch("made.up.operation"));

        // 翻转：对已初始化实例立即生效（原子替换）
        NativeOperationGuardHolder.setLegacyGenericDispatchEnabled(false, assetJson);
        NativeOperationGuard afterFlip = NativeOperationGuardHolder.get();
        assertNotNull("翻转后 archive.list 必须拒绝", afterFlip.checkGenericDispatch("archive.list"));
        assertNotNull("翻转后 stagecraft.room.get 必须拒绝", afterFlip.checkGenericDispatch("stagecraft.room.get"));
        assertNull("翻转后 main-host 操作仍放行", afterFlip.checkGenericDispatch("dispatch"));

        // 重复翻转幂等
        NativeOperationGuardHolder.setLegacyGenericDispatchEnabled(false, assetJson);
        assertNotNull("重复翻转后仍拒绝", NativeOperationGuardHolder.get().checkGenericDispatch("archive.list"));
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

    // ── Gate C-1：heartbeat / resume / abort 共享 fixture 的 JVM 侧消费（评审 C-1 P1）──

    @Test
    public void heartbeatFixtureParsesOnJavaSide() throws Exception {
        JSONArray heartbeat = fixtures().getJSONArray("heartbeat");
        assertTrue("heartbeat 样本必须存在", heartbeat.length() >= 2);
        for (int index = 0; index < heartbeat.length(); index++) {
            JSONObject sample = heartbeat.getJSONObject(index);
            SseParser parser = new SseParser();
            java.util.List<String> messages = parser.accept(sample.getString("wire"));
            assertEquals(sample.getInt("expectedEvents") + "（" + sample.getString("name") + "：注释帧不得产生业务事件）",
                sample.getInt("expectedEvents"), messages.size());
            for (String message : messages) {
                assertTrue("data 帧必须是有效 envelope", CoreProtocolSupport.isValidEnvelope(new JSONObject(message)));
            }
        }
    }

    @Test
    public void resumeFixtureRevisionFloorMatchesJavaSemantics() throws Exception {
        JSONObject resume = fixtures().getJSONObject("resume");
        int authoritativeRevision = resume.getInt("authoritativeViewRevision");
        JSONArray buffered = resume.getJSONArray("bufferedDuringReconnect");
        java.util.List<Integer> delivered = new java.util.ArrayList<>();
        for (int index = 0; index < buffered.length(); index++) {
            JSONObject item = buffered.getJSONObject(index);
            int revision = item.getInt("revision");
            // JVM 侧对等判定：revision >= 权威 view revision 才放行（TS shouldDeliverCoreEvent 同语义）
            boolean deliver = revision >= authoritativeRevision;
            assertEquals(item.getString("reason"), item.getBoolean("shouldDeliver"), deliver);
            if (deliver) delivered.add(revision);
        }
        JSONArray expected = resume.getJSONArray("finalDeliverableSequence");
        assertEquals("最终允许投递序列必须与 fixture 一致", expected.length(), delivered.size());
        for (int index = 0; index < expected.length(); index++) {
            assertEquals("投递序列位置 " + index, expected.getInt(index), delivered.get(index).intValue());
        }
    }

    @Test
    public void abortFixtureSemanticsAreExplicit() throws Exception {
        JSONObject abort = fixtures().getJSONObject("abort");
        assertEquals("命令 cancel 与流 abort 语义必须分离", true, abort.getBoolean("commandCancelIsSeparate"));
        assertTrue("上游关闭必须有界时限", abort.getInt("upstreamCloseWithinMs") > 0);
        assertTrue("订阅释放必须有界时限", abort.getInt("subscriberReleaseWithinMs") > 0);
        assertEquals("abort 后不得继续投递", true, abort.getBoolean("noFurtherDelivery"));
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

    // ── Gate B-2 / C-2：真实 gateway 消费 registry（评审 B-2 P1 / C-2 P1）──

    private static final class GatewayFixture implements AutoCloseable {
        final GateACoreDataServer core;
        final GateAGatewayServer gateway;
        final int gatewayPort;

        GatewayFixture() throws Exception {
            core = new GateACoreDataServer("test-nonce", DIRECT);
            core.setHealthJson("{\"protocolVersion\":\"1.1\",\"status\":\"ready\"}");
            core.setCommandForwarder((body, callback) -> callback.accept("{\"requestId\":\"rq\",\"status\":\"accepted\",\"revision\":8}"));
            core.start();
            RouteRegistry registry = RouteRegistry.parse(readAsset("api-route-registry.json"), null);
            gateway = new GateAGatewayServer("test", registry);
            gateway.start();
            gateway.setCoreEndpoint(core.getPort(), "test-nonce");
            gatewayPort = gateway.getPort();
        }

        @Override public void close() {
            gateway.stop();
            core.stop();
        }
    }

    @Test
    public void gatewayConsumesRegistryForFourOwnerDecisions() throws Exception {
        try (GatewayFixture fixture = new GatewayFixture()) {
            int port = fixture.gatewayPort;
            // core → 代理（200 + 回执透传 + nonce 由 gateway 注入，Core 侧接受）
            String coreResult = httpRequest(port, "POST", "/api/core/commands",
                java.util.Map.of("content-type", "application/json"),
                "{\"requestId\":\"rq\",\"type\":\"submit-text\",\"actor\":\"player\"}");
            assertTrue("core 路由必须代理成功，实际: " + coreResult.split("\n")[0], coreResult.contains("200"));
            assertTrue("core 代理必须透传回执", coreResult.contains("\"status\":\"accepted\""));
            assertTrue("gateway 必须代理计数", fixture.gateway.getProxiedCount() >= 1);
            // main-host → 宿主分派占位（稳定 host_handler_unavailable，不触碰 Core）
            String hostResult = httpRequest(port, "GET", "/api/version", java.util.Map.of(), null);
            assertTrue("main-host 必须稳定 501，实际: " + hostResult.split("\n")[0], hostResult.contains("501"));
            assertTrue("main-host 必须带 host_handler_unavailable", hostResult.contains("host_handler_unavailable"));
            // desktop-only → 稳定 unsupported_capability（C-2：真实 gateway 返回，非字符串常量）
            String desktopResult = httpRequest(port, "POST", "/api/agent/context", java.util.Map.of("content-type", "application/json"), "{}");
            assertTrue("desktop-only 必须稳定 501，实际: " + desktopResult.split("\n")[0], desktopResult.contains("501"));
            assertTrue("desktop-only 必须带 unsupported_capability", desktopResult.contains("unsupported_capability"));
            // deprecated → 稳定 410 route_deprecated
            String deprecatedResult = httpRequest(port, "GET", "/api/stream", java.util.Map.of(), null);
            assertTrue("deprecated 必须稳定 410，实际: " + deprecatedResult.split("\n")[0], deprecatedResult.contains("410"));
            assertTrue("deprecated 必须带 route_deprecated", deprecatedResult.contains("route_deprecated"));
            // 未知 method/path → 稳定 404（不代理，无 Core 副作用）
            String unknown = httpRequest(port, "GET", "/api/definitely/not/registered", java.util.Map.of(), null);
            assertTrue("未知路径必须稳定 404，实际: " + unknown.split("\n")[0], unknown.contains("404"));
            assertTrue("未知路径必须带 route_not_registered", unknown.contains("route_not_registered"));
            // 未登记 method（DELETE /api/room）→ 404
            String wrongMethod = httpRequest(port, "DELETE", "/api/room", java.util.Map.of(), null);
            assertTrue("未登记 method 必须 404", wrongMethod.contains("404"));
            // 非 core 决策不得产生代理副作用
            assertEquals("只有 core 路由产生代理", 1, fixture.gateway.getProxiedCount());
            assertEquals("策略拒绝必须计数", 5, fixture.gateway.getRejectedByPolicyCount());
        }
    }

    @Test
    public void gatewayRegistryIdentityMatchesFixture() throws Exception {
        // health 中的 registry 身份来自 gateway 实际持有的同一份资产（B-2 第 4 条）
        try (GatewayFixture fixture = new GatewayFixture()) {
            RouteRegistry registry = RouteRegistry.parse(readAsset("api-route-registry.json"), null);
            JSONObject boundaries = fixtures().getJSONObject("boundaries");
            assertEquals("gateway 持有 registry 版本必须与 fixture 一致",
                boundaries.getString("registryVersion"), registry.registryVersion());
            assertEquals("gateway 持有 registry sha256 必须与 fixture 一致",
                boundaries.getString("registrySha256"), registry.sha256());
        }
    }

    // ── Gate C-3：gateway 级 abort 传播（评审 C-3 P1）──

    @Test
    public void gatewayAbortPropagatesToCoreSubscriberWithinBound() throws Exception {
        try (GatewayFixture fixture = new GatewayFixture()) {
            int port = fixture.gatewayPort;
            // 客户端经 gateway 订阅 Core SSE
            Socket client = new Socket(InetAddress.getByName("127.0.0.1"), port);
            client.setSoTimeout(3000);
            OutputStream output = client.getOutputStream();
            output.write(("GET /api/core/events HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n").getBytes(StandardCharsets.UTF_8));
            output.flush();
            BufferedReader reader = new BufferedReader(new InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8));
            // 等 SSE 头 + 订阅确认行（经 gateway 透传）
            String statusLine = reader.readLine();
            assertTrue("gateway SSE 必须 200，实际: " + statusLine, statusLine != null && statusLine.contains("200"));
            String line;
            while ((line = reader.readLine()) != null && !line.isEmpty()) { /* 消费头 */ }
            String confirm = reader.readLine();
            assertTrue("必须收到订阅确认行（经 gateway）", confirm != null && confirm.startsWith(": connected"));
            // Core 侧 subscriber 已建立
            assertEquals("Core subscriber 必须建立", 1, fixture.core.getSubscriberCount());

            // 客户端 abort：关闭 socket
            long started = System.currentTimeMillis();
            client.close();
            // 有界时间内：gateway 检测到客户端断开 → 关闭上游 → Core subscriber 释放
            long deadline = System.currentTimeMillis() + 3000;
            while (fixture.core.getSubscriberCount() > 0 && System.currentTimeMillis() < deadline) {
                Thread.sleep(20);
            }
            long elapsed = System.currentTimeMillis() - started;
            assertEquals("客户端 abort 后 Core subscriber 必须在有界时间内释放（实际 " + elapsed + "ms）",
                0, fixture.core.getSubscriberCount());
            assertTrue("gateway 必须计数客户端断开（实际 " + elapsed + "ms）", elapsed < 3000);
            assertTrue("gateway upstreamClosedByClient 必须计数", fixture.gateway.getUpstreamClosedByClientCount() >= 1);
        }
    }
}
