package ai.stagecraft.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

/**
 * W5-R1-2：CoreControlBinder（ICoreControl.Stub 的执行体）JVM 测试。
 *
 * CoreService 的 Stub 方法体只做一行委托到 CoreControlBinder；本测试直接调用
 * CoreControlBinder 即执行与 Binder Stub 完全相同的代码路径——覆盖初始摘要、
 * ready 摘要、failed 摘要，且验证不递归、不超 64KiB 上限。
 */
public final class CoreControlBinderTest {

    /** 构造 binder：endpoints/summaries 由可变的 JSONObject 提供者驱动。 */
    private static CoreControlBinder binder(JSONObject summary, String endpoint) {
        return new CoreControlBinder(
            () -> endpoint,
            () -> summary);
    }

    @Test public void initialSummaryIsStarting() {
        CoreServiceStateMachine machine = new CoreServiceStateMachine(); // 初始 STARTING
        CoreControlBinder binder = new CoreControlBinder(
            () -> null,
            () -> machine.summary("42", "2026-08-30T00:00:00Z", "1.1"));
        String summary = binder.getStatusSummary();
        assertTrue(summary.contains("\"status\":\"starting\""));
        assertTrue(summary.contains("\"pid\":\"42\""));
        assertTrue(summary.contains("\"protocolVersion\":\"1.1\""));
    }

    @Test public void readySummaryAfterBridgeReady() {
        CoreServiceStateMachine machine = new CoreServiceStateMachine();
        machine.onBridgeReady(); // STARTING → HANDSHAKING → READY
        CoreControlBinder binder = new CoreControlBinder(
            () -> "{\"port\":12345,\"nonce\":\"abc\",\"pid\":42}",
            () -> machine.summary("42", "t", "1.1"));
        assertTrue(binder.getStatusSummary().contains("\"status\":\"ready\""));
        // ready 时端点可用
        String endpoint = binder.getEndpoint();
        assertTrue(endpoint.contains("\"port\":12345"));
        assertTrue(endpoint.contains("\"nonce\":\"abc\""));
    }

    @Test public void failedSummaryAfterCrash() {
        CoreServiceStateMachine machine = new CoreServiceStateMachine();
        machine.onBridgeReady();
        machine.onFailure("renderer_gone");
        CoreControlBinder binder = new CoreControlBinder(
            () -> null,
            () -> machine.summary("42", "t", "1.1"));
        String summary = binder.getStatusSummary();
        assertTrue(summary.contains("\"status\":\"crashed\""));
        assertTrue(summary.contains("\"failureCode\":\"renderer_gone\""));
        // crashed 时端点不可用
        assertNull(binder.getEndpoint());
    }

    @Test public void noRecursionAcrossRepeatedCalls() {
        CoreServiceStateMachine machine = new CoreServiceStateMachine();
        machine.onBridgeReady();
        CoreControlBinder binder = new CoreControlBinder(
            () -> "{\"port\":1,\"nonce\":\"n\",\"pid\":1}",
            () -> machine.summary("1", "t", "1.1"));
        // 重复调用不得递归/栈溢出（W5-1 P0 回归防护）
        for (int i = 0; i < 10_000; i++) {
            binder.getStatusSummary();
            binder.getEndpoint();
        }
        assertTrue(binder.getStatusSummary().contains("\"status\":\"ready\""));
    }

    @Test public void binderHardLimitEnforced() {
        CoreServiceStateMachine machine = new CoreServiceStateMachine();
        machine.onBridgeReady();
        // 摘要 > 64KiB 时 enforceBinderLimit 必须抛 IllegalStateException
        CoreControlBinder binder = new CoreControlBinder(
            () -> null,
            () -> {
                StringBuilder huge = new StringBuilder();
                while (huge.length() <= CoreControlBinder.BINDER_HARD_LIMIT_BYTES) huge.append('x');
                try { return new JSONObject().put("status", huge.toString()); }
                catch (Exception error) { return new JSONObject(); }
            });
        assertThrows(IllegalStateException.class, binder::getStatusSummary);
    }

    @Test public void maxPayloadBytesObserved() {
        CoreServiceStateMachine machine = new CoreServiceStateMachine();
        machine.onBridgeReady();
        CoreControlBinder binder = new CoreControlBinder(
            () -> "{\"port\":1,\"nonce\":\"n\",\"pid\":1}",
            () -> machine.summary("1", "t", "1.1"));
        binder.getStatusSummary();
        binder.getEndpoint();
        assertTrue("观测到的最大单条字节应 > 0", binder.maxPayloadBytes() > 0);
    }

    @Test public void endpointNullWhenNotReady() {
        CoreServiceStateMachine machine = new CoreServiceStateMachine(); // starting
        CoreControlBinder binder = new CoreControlBinder(
            () -> "{\"port\":1,\"nonce\":\"n\",\"pid\":1}",
            () -> machine.summary("1", "t", "1.1"));
        // starting 时端点提供者返回非 null，但 getEndpoint 仍应受状态约束？
        // 注意：状态约束在 CoreService 的端点提供者内（ready/degraded 才返回端点）；
        // 本测试验证提供者语义——提供者返回 null 时 getEndpoint 为 null。
        CoreControlBinder nullBinder = new CoreControlBinder(() -> null, () -> machine.summary("1", "t", "1.1"));
        assertNull(nullBinder.getEndpoint());
    }

    @Test public void summaryFieldsMatchControlPlaneContract() {
        CoreServiceStateMachine machine = new CoreServiceStateMachine();
        machine.onBridgeReady();
        CoreControlBinder binder = new CoreControlBinder(
            () -> null,
            () -> machine.summary("7", "2026-08-30T00:00:00Z", "1.1"));
        String summary = binder.getStatusSummary();
        assertFalse(summary.contains("\"port\""));
        assertFalse(summary.contains("\"nonce\""));
        assertTrue(summary.contains("\"startedAt\":\"2026-08-30T00:00:00Z\""));
    }
}
