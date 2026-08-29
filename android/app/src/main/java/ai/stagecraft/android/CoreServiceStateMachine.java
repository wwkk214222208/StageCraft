package ai.stagecraft.android;

import org.json.JSONObject;

/**
 * W5-3：CoreService 的状态驱动逻辑（纯 Java，JVM 可测 seam）。
 *
 * CoreService 委托本类管理 §4.1 状态机 + failureCode + 控制面摘要；测试直接驱动
 * 本类验证状态迁移接线（bridge ready → READY、boot/renderer 失败 → CRASHED、
 * 停止 → STOPPING → ABSENT、summary 字段），避免只测孤立的 CoreLifecycle。
 */
public final class CoreServiceStateMachine {
    private final CoreLifecycle lifecycle;
    private String failureCode;

    public CoreServiceStateMachine() {
        this(new CoreLifecycle(CoreLifecycle.State.STARTING));
    }

    public CoreServiceStateMachine(CoreLifecycle lifecycle) {
        this.lifecycle = java.util.Objects.requireNonNull(lifecycle, "lifecycle");
    }

    public CoreLifecycle lifecycle() { return lifecycle; }
    public CoreLifecycle.State state() { return lifecycle.state(); }
    public String failureCode() { return failureCode; }

    /** bridge core-ready：STARTING → HANDSHAKING → READY（两跳）；DEGRADED → READY（恢复）；READY 幂等。 */
    public boolean onBridgeReady() {
        CoreLifecycle.State current = lifecycle.state();
        if (current == CoreLifecycle.State.READY) return false; // 幂等
        if (current == CoreLifecycle.State.STARTING) {
            lifecycle.transition(CoreLifecycle.State.HANDSHAKING);
            lifecycle.transition(CoreLifecycle.State.READY);
            return true;
        }
        if (current == CoreLifecycle.State.HANDSHAKING || current == CoreLifecycle.State.DEGRADED) {
            lifecycle.transition(CoreLifecycle.State.READY);
            return true;
        }
        return false; // 其他状态忽略
    }

    /** 启动/渲染失败：任意运行态 → CRASHED；同 failureCode 幂等。 */
    public boolean onFailure(String code) {
        if (lifecycle.state() == CoreLifecycle.State.CRASHED && code.equals(failureCode)) return false;
        failureCode = code;
        try {
            lifecycle.transition(CoreLifecycle.State.CRASHED);
        } catch (CoreLifecycle.IllegalTransition error) {
            // recovering/absent 等非法迁移：保持 crashed 语义
            if (lifecycle.state() != CoreLifecycle.State.CRASHED) lifecycle.reset();
        }
        return true;
    }

    /** 优雅停止：→ STOPPING；随后释放完成 → ABSENT。 */
    public boolean onStopRequested() {
        try {
            lifecycle.transition(CoreLifecycle.State.STOPPING);
            return true;
        } catch (CoreLifecycle.IllegalTransition error) {
            return false; // 已 crashed/absent：按停止路径处理（调用方继续释放）
        }
    }

    public void onStopped() {
        try {
            lifecycle.transition(CoreLifecycle.State.ABSENT);
        } catch (CoreLifecycle.IllegalTransition ignored) { }
    }

    /** 主进程可发起恢复：CRASHED → RECOVERING（由主进程驱动重启）。 */
    public boolean onRecoverRequested() {
        try {
            lifecycle.recover();
            return true;
        } catch (CoreLifecycle.IllegalTransition error) {
            return false;
        }
    }

    /** 数据面命令门禁（§4.1：仅 ready/degraded 可提交）。 */
    public boolean canSubmitCommands() {
        return CoreLifecycle.canSubmitCommands(lifecycle.state());
    }

    /** 控制面摘要（§4.4：只含 status/pid/startedAt/failureCode/protocolVersion）。 */
    public JSONObject summary(String pid, String startedAt, String protocolVersion) {
        return lifecycle.summary(pid, startedAt, failureCode, protocolVersion);
    }
}
