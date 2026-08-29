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

import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;

/**
 * Gate B/C 收口测试（JVM，无 Robolectric）：
 *  - Gate B：Java RouteRegistry 消费构建期 JSON 资产（100+ 路由、歧义失败、authPolicy 显式、sha256 核对）；
 *            NativeOperationGuard 在真实分派层执行 allowlist（legacy-main-core 封闭例外）。
 *  - Gate C：TS 黄金样本（protocol-fixtures.json）在 Java 侧逐条对等断言（版本协商/envelope/receipt/SSE 帧）。
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
        RouteRegistry.parse(json, RouteRegistry.sha256Hex(json));
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
}
