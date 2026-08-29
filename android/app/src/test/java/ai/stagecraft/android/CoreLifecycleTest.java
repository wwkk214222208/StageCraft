package ai.stagecraft.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** W5（计划 §4.1）：Core 生命周期状态机。 */
public final class CoreLifecycleTest {

    @Test public void absentStarts() {
        CoreLifecycle lifecycle = new CoreLifecycle();
        assertEquals(CoreLifecycle.State.ABSENT, lifecycle.state());
        lifecycle.transition(CoreLifecycle.State.STARTING);
        assertEquals(CoreLifecycle.State.STARTING, lifecycle.state());
    }

    @Test public void startingHandshakesThenReady() {
        CoreLifecycle lifecycle = new CoreLifecycle(CoreLifecycle.State.STARTING);
        lifecycle.transition(CoreLifecycle.State.HANDSHAKING);
        lifecycle.transition(CoreLifecycle.State.READY);
        assertEquals(CoreLifecycle.State.READY, lifecycle.state());
    }

    @Test public void readyCanDegradeAndStop() {
        CoreLifecycle lifecycle = new CoreLifecycle(CoreLifecycle.State.READY);
        lifecycle.transition(CoreLifecycle.State.DEGRADED);
        assertEquals(CoreLifecycle.State.DEGRADED, lifecycle.state());
        lifecycle.transition(CoreLifecycle.State.STOPPING);
        lifecycle.transition(CoreLifecycle.State.ABSENT);
        assertEquals(CoreLifecycle.State.ABSENT, lifecycle.state());
    }

    @Test public void crashRecoversAndRestarts() {
        CoreLifecycle lifecycle = new CoreLifecycle(CoreLifecycle.State.READY);
        lifecycle.transition(CoreLifecycle.State.CRASHED);
        assertEquals(CoreLifecycle.State.CRASHED, lifecycle.state());
        lifecycle.recover();
        assertEquals(CoreLifecycle.State.RECOVERING, lifecycle.state());
        lifecycle.transition(CoreLifecycle.State.STARTING);
        assertEquals(CoreLifecycle.State.STARTING, lifecycle.state());
    }

    @Test public void illegalTransitionsThrow() {
        CoreLifecycle lifecycle = new CoreLifecycle();
        assertThrows(CoreLifecycle.IllegalTransition.class, () -> lifecycle.transition(CoreLifecycle.State.READY));
        assertThrows(CoreLifecycle.IllegalTransition.class, () -> lifecycle.transition(CoreLifecycle.State.CRASHED));
        CoreLifecycle stopping = new CoreLifecycle(CoreLifecycle.State.STOPPING);
        assertThrows(CoreLifecycle.IllegalTransition.class, () -> stopping.transition(CoreLifecycle.State.READY));
    }

    @Test public void commandsOnlyWhenReadyOrDegraded() {
        assertFalse(CoreLifecycle.canSubmitCommands(CoreLifecycle.State.ABSENT));
        assertFalse(CoreLifecycle.canSubmitCommands(CoreLifecycle.State.STARTING));
        assertFalse(CoreLifecycle.canSubmitCommands(CoreLifecycle.State.HANDSHAKING));
        assertTrue(CoreLifecycle.canSubmitCommands(CoreLifecycle.State.READY));
        assertTrue(CoreLifecycle.canSubmitCommands(CoreLifecycle.State.DEGRADED));
        assertFalse(CoreLifecycle.canSubmitCommands(CoreLifecycle.State.STOPPING));
        assertFalse(CoreLifecycle.canSubmitCommands(CoreLifecycle.State.CRASHED));
        assertFalse(CoreLifecycle.canSubmitCommands(CoreLifecycle.State.RECOVERING));
    }

    @Test public void idempotentTransitionIsNoOp() {
        CoreLifecycle lifecycle = new CoreLifecycle(CoreLifecycle.State.READY);
        assertEquals(CoreLifecycle.State.READY, lifecycle.transition(CoreLifecycle.State.READY));
    }

    @Test public void summaryContainsOnlyControlPlaneFields() {
        CoreLifecycle lifecycle = new CoreLifecycle(CoreLifecycle.State.READY);
        org.json.JSONObject summary = lifecycle.summary("42", "2026-08-29T00:00:00Z", null, "1.1");
        assertEquals("ready", summary.optString("status"));
        assertEquals("42", summary.optString("pid"));
        assertEquals("1.1", summary.optString("protocolVersion"));
        assertFalse(summary.has("port"));
        assertFalse(summary.has("nonce"));
    }

    @Test public void wireNamesMatchContract() {
        assertEquals("absent", CoreLifecycle.State.ABSENT.wire);
        assertEquals("starting", CoreLifecycle.State.STARTING.wire);
        assertEquals("handshaking", CoreLifecycle.State.HANDSHAKING.wire);
        assertEquals("ready", CoreLifecycle.State.READY.wire);
        assertEquals("degraded", CoreLifecycle.State.DEGRADED.wire);
        assertEquals("stopping", CoreLifecycle.State.STOPPING.wire);
        assertEquals("crashed", CoreLifecycle.State.CRASHED.wire);
        assertEquals("recovering", CoreLifecycle.State.RECOVERING.wire);
    }
}
