package ai.stagecraft.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** W5-3：CoreServiceStateMachine（CoreService 状态接线 seam）JVM 测试。 */
public final class CoreServiceStateMachineTest {

    @Test public void startsInStartingState() {
        CoreServiceStateMachine machine = new CoreServiceStateMachine();
        assertEquals(CoreLifecycle.State.STARTING, machine.state());
    }

    @Test public void bridgeReadyTransitionsToReady() {
        CoreServiceStateMachine machine = new CoreServiceStateMachine();
        assertTrue(machine.onBridgeReady());
        assertEquals(CoreLifecycle.State.READY, machine.state());
        // 幂等：重复 ready 不再迁移
        assertFalse(machine.onBridgeReady());
        assertEquals(CoreLifecycle.State.READY, machine.state());
    }

    @Test public void readyCanDegradeAndRecover() {
        CoreServiceStateMachine machine = new CoreServiceStateMachine();
        machine.onBridgeReady();
        machine.lifecycle().transition(CoreLifecycle.State.DEGRADED);
        assertEquals(CoreLifecycle.State.DEGRADED, machine.state());
        // degraded → ready（恢复）
        assertTrue(machine.onBridgeReady());
        assertEquals(CoreLifecycle.State.READY, machine.state());
    }

    @Test public void failureTransitionsToCrashed() {
        CoreServiceStateMachine machine = new CoreServiceStateMachine();
        machine.onBridgeReady();
        assertTrue(machine.onFailure("renderer_gone"));
        assertEquals(CoreLifecycle.State.CRASHED, machine.state());
        assertEquals("renderer_gone", machine.failureCode());
        // 同 failureCode 幂等
        assertFalse(machine.onFailure("renderer_gone"));
        assertEquals(CoreLifecycle.State.CRASHED, machine.state());
    }

    @Test public void crashRecoversToStarting() {
        CoreServiceStateMachine machine = new CoreServiceStateMachine();
        machine.onBridgeReady();
        machine.onFailure("boot_failed");
        assertTrue(machine.onRecoverRequested());
        assertEquals(CoreLifecycle.State.RECOVERING, machine.state());
        machine.lifecycle().transition(CoreLifecycle.State.STARTING);
        assertEquals(CoreLifecycle.State.STARTING, machine.state());
    }

    @Test public void stopTransitionsToStoppingThenAbsent() {
        CoreServiceStateMachine machine = new CoreServiceStateMachine();
        machine.onBridgeReady();
        assertTrue(machine.onStopRequested());
        assertEquals(CoreLifecycle.State.STOPPING, machine.state());
        machine.onStopped();
        assertEquals(CoreLifecycle.State.ABSENT, machine.state());
    }

    @Test public void commandGateFollowsState() {
        CoreServiceStateMachine machine = new CoreServiceStateMachine();
        assertFalse(machine.canSubmitCommands()); // starting
        machine.onBridgeReady();
        assertTrue(machine.canSubmitCommands()); // ready
        machine.lifecycle().transition(CoreLifecycle.State.DEGRADED);
        assertTrue(machine.canSubmitCommands()); // degraded
        machine.onFailure("x");
        assertFalse(machine.canSubmitCommands()); // crashed
    }

    @Test public void summaryContainsOnlyControlPlaneFields() {
        CoreServiceStateMachine machine = new CoreServiceStateMachine();
        machine.onBridgeReady();
        org.json.JSONObject summary = machine.summary("42", "2026-08-29T00:00:00Z", "1.1");
        assertEquals("ready", summary.optString("status"));
        assertEquals("42", summary.optString("pid"));
        assertEquals("1.1", summary.optString("protocolVersion"));
        assertFalse(summary.has("port"));
        assertFalse(summary.has("nonce"));
        assertFalse(summary.has("binderMaxPayloadBytes"));
    }

    @Test public void failureSummaryExposesFailureCode() {
        CoreServiceStateMachine machine = new CoreServiceStateMachine();
        machine.onBridgeReady();
        machine.onFailure("renderer_gone");
        org.json.JSONObject summary = machine.summary("1", "t", "1.1");
        assertEquals("crashed", summary.optString("status"));
        assertEquals("renderer_gone", summary.optString("failureCode"));
    }

    @Test public void stopFromCrashedIsTolerated() {
        CoreServiceStateMachine machine = new CoreServiceStateMachine();
        machine.onBridgeReady();
        machine.onFailure("x");
        // crashed → stopping 非法；onStopRequested 返回 false 但调用方仍继续释放
        assertFalse(machine.onStopRequested());
        machine.onStopped(); // crashed → absent 非法，被容忍（状态保持 crashed，由主进程 recover）
        assertEquals(CoreLifecycle.State.CRASHED, machine.state());
    }
}
