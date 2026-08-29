package ai.stagecraft.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/** W5（计划 §2.2/§5.2 / §10.2）：CoreNativeBridge 纯 JVM 测试。 */
public final class CoreNativeBridgeTest {

    /** 构造一个含 core-native 操作的最小 guard（与真实资产同形状）。 */
    private static NativeOperationGuard guard(String... coreNative) {
        StringBuilder legacy = new StringBuilder();
        for (String operation : coreNative) {
            if (legacy.length() > 0) legacy.append(',');
            legacy.append(JSONObject.quote(operation));
        }
        return NativeOperationGuard.parse(
            "{\"legacyMainCoreException\":[" + legacy + "],\"mainHost\":[]}", false);
    }

    @Test public void allowlistedSyncOperationRuns() throws Exception {
        CoreNativeBridge bridge = new CoreNativeBridge(guard("secret.get"));
        bridge.registerSync("secret.get", input -> new JSONObject().put("found", false));
        String result = bridge.invokeSync("secret.get", "{\"key\":\"k\"}");
        assertTrue(result.contains("\"found\":false"));
    }

    @Test public void nonCoreNativeOperationRejected() {
        CoreNativeBridge bridge = new CoreNativeBridge(guard("secret.get"));
        String result = bridge.invokeSync("stagecraft.room.get", "{}");
        assertTrue(result.contains("NATIVE_OPERATION_FAILED"));
        assertTrue(result.contains("core-native allowlist"));
    }

    @Test public void unregisteredOperationRejected() {
        CoreNativeBridge bridge = new CoreNativeBridge(guard());
        String result = bridge.invokeSync("secret.get", "{}");
        assertTrue(result.contains("core-native allowlist"));
    }

    @Test public void mainHostOperationRejected() {
        // main-host 操作（如 syncPair）不得出现在 CoreNative 桥
        CoreNativeBridge bridge = new CoreNativeBridge(guard("secret.get"));
        String result = bridge.invokeSync("syncPair", "{}");
        assertTrue(result.contains("core-native allowlist"));
    }

    @Test public void oversizedInputRejected() {
        CoreNativeBridge bridge = new CoreNativeBridge(guard("secret.get"));
        StringBuilder huge = new StringBuilder();
        while (huge.length() <= CoreNativeBridge.MAX_INPUT_BYTES) huge.append('x');
        String result = bridge.invokeSync("secret.get", huge.toString());
        assertTrue(result.contains("NATIVE_OPERATION_FAILED"));
    }

    @Test public void asyncOperationDeliversResult() throws Exception {
        CoreNativeBridge bridge = new CoreNativeBridge(guard("model.request"));
        bridge.registerAsync("model.request", (operation, input, callback) -> {
            new Thread(() -> {
                try { callback.onResult(new JSONObject().put("ok", true)); }
                catch (Exception error) { callback.onError(error.getMessage()); }
            }).start();
        });
        AtomicReference<String> result = new AtomicReference<>();
        AtomicBoolean error = new AtomicBoolean();
        java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
        bridge.invokeAsync("model.request", "{\"requestId\":\"r1\"}", new CoreNativeBridge.Callback() {
            @Override public void onResult(JSONObject value) { result.set(value.toString()); latch.countDown(); }
            @Override public void onError(String message) { error.set(true); latch.countDown(); }
        });
        assertTrue(latch.await(2, java.util.concurrent.TimeUnit.SECONDS));
        assertFalse(error.get());
        assertNotNull(result.get());
        assertTrue(result.get().contains("\"ok\":true"));
    }

    @Test public void asyncTimeoutReportsBridgeTimeout() throws Exception {
        CoreNativeBridge bridge = new CoreNativeBridge(guard("model.request"), 100, System::currentTimeMillis);
        bridge.registerAsync("model.request", (operation, input, callback) -> {
            // 永不回调 → 超时
        });
        AtomicReference<String> error = new AtomicReference<>();
        java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
        bridge.invokeAsync("model.request", "{}", new CoreNativeBridge.Callback() {
            @Override public void onResult(JSONObject value) { latch.countDown(); }
            @Override public void onError(String message) { error.set(message); latch.countDown(); }
        });
        assertTrue(latch.await(3, java.util.concurrent.TimeUnit.SECONDS));
        assertTrue(error.get() != null && error.get().contains("bridge_timeout"));
    }

    @Test public void asyncRejectsNonAsyncOperation() throws Exception {
        CoreNativeBridge bridge = new CoreNativeBridge(guard("secret.get"));
        bridge.registerSync("secret.get", input -> new JSONObject().put("found", true));
        AtomicReference<String> result = new AtomicReference<>();
        AtomicReference<String> error = new AtomicReference<>();
        java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
        bridge.invokeAsync("secret.get", "{\"key\":\"k\"}", new CoreNativeBridge.Callback() {
            @Override public void onResult(JSONObject value) { result.set(value.toString()); latch.countDown(); }
            @Override public void onError(String message) { error.set(message); latch.countDown(); }
        });
        assertTrue(latch.await(2, java.util.concurrent.TimeUnit.SECONDS));
        assertNotNull(result.get());
        assertTrue(result.get().contains("\"found\":true"));
    }

    @Test public void bridgeMessageParsingHandlesGarbage() {
        JSONObject parsed = CoreNativeBridge.parseBridgeMessage("not-json");
        assertEquals(0, parsed.length());
        JSONObject valid = CoreNativeBridge.parseBridgeMessage("{\"type\":\"core-ready\"}");
        assertEquals("core-ready", valid.optString("type"));
    }

    @Test public void outputSizeIsBounded() {
        CoreNativeBridge bridge = new CoreNativeBridge(guard("asset.read"));
        bridge.registerSync("asset.read", input -> {
            StringBuilder huge = new StringBuilder();
            while (huge.length() <= CoreNativeBridge.MAX_OUTPUT_BYTES) huge.append('x');
            return huge.toString();
        });
        String result = bridge.invokeSync("asset.read", "{\"path\":\"p\"}");
        assertTrue(result.contains("NATIVE_OPERATION_FAILED"));
    }
}
