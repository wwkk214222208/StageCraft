package ai.stagecraft.android;

import org.json.JSONObject;

import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

/**
 * W5：Core 进程状态机（计划 §4.1）。
 *
 * 主进程管理 Core 状态：absent → starting → handshaking → ready → degraded → stopping → absent；
 * 故障路径 starting/handshaking/ready/degraded → crashed → recovering → starting。
 *
 * 本类为纯逻辑（JVM 可测），不持有 Android 对象；状态迁移由 CoreService/MainActivity 驱动。
 * 状态语义（§4.1 表）：
 *  - absent       ：Core 未启动（恢复页/启动按钮）
 *  - starting     ：Service 已启动，协议尚未可用（禁止提交命令）
 *  - handshaking  ：连接已建立，正在校验版本和插件集
 *  - ready        ：可正常执行命令
 *  - degraded     ：Core 可用，但有插件被隔离或能力降级
 *  - stopping     ：正在释放连接和任务（禁止新命令）
 *  - crashed      ：进程或连接异常退出（保留管理入口，不自动重放命令）
 *  - recovering   ：正在重启或切换备用路径
 */
public final class CoreLifecycle {
    public enum State {
        ABSENT("absent"),
        STARTING("starting"),
        HANDSHAKING("handshaking"),
        READY("ready"),
        DEGRADED("degraded"),
        STOPPING("stopping"),
        CRASHED("crashed"),
        RECOVERING("recovering");

        public final String wire;

        State(String wire) { this.wire = wire; }

        public static State fromWire(String value) {
            for (State state : values()) if (state.wire.equals(value)) return state;
            throw new IllegalArgumentException("Unknown core state: " + value);
        }
    }

    /** 非法迁移（当前状态 → 目标状态）。 */
    public static final class IllegalTransition extends RuntimeException {
        public IllegalTransition(State from, State to) {
            super("Illegal core lifecycle transition: " + from.wire + " -> " + to.wire);
        }
    }

    private State state = State.ABSENT;

    public CoreLifecycle() {}

    public CoreLifecycle(State initial) { this.state = initial; }

    public synchronized State state() { return state; }

    /** 幂等迁移：非法迁移抛 IllegalTransition（调用方按故障处理，不静默）。 */
    public synchronized State transition(State next) {
        if (next == state) return state;
        if (!isAllowed(state, next)) throw new IllegalTransition(state, next);
        state = next;
        return state;
    }

    /** 从崩溃/故障恢复：crashed → recovering → starting。 */
    public synchronized State recover() {
        if (state != State.CRASHED && state != State.RECOVERING) throw new IllegalTransition(state, State.RECOVERING);
        state = State.RECOVERING;
        return state;
    }

    public synchronized void reset() { state = State.ABSENT; }

    /** 可提交命令的状态集合（§4.1：ready/degraded 可执行；其余禁止）。 */
    public static boolean canSubmitCommands(State state) {
        return state == State.READY || state == State.DEGRADED;
    }

    private static boolean isAllowed(State from, State to) {
        switch (from) {
            case ABSENT:
                return to == State.STARTING;
            case STARTING:
                return to == State.HANDSHAKING || to == State.CRASHED || to == State.STOPPING;
            case HANDSHAKING:
                return to == State.READY || to == State.DEGRADED || to == State.CRASHED || to == State.STOPPING;
            case READY:
                // §4.1：ready → degraded（插件隔离/能力降级）或 ready → stopping/crashed
                return to == State.DEGRADED || to == State.STOPPING || to == State.CRASHED;
            case DEGRADED:
                // degraded → ready（恢复）或 stopping/crashed
                return to == State.READY || to == State.STOPPING || to == State.CRASHED;
            case STOPPING:
                return to == State.ABSENT;
            case CRASHED:
                return to == State.RECOVERING;
            case RECOVERING:
                return to == State.STARTING;
            default:
                return false;
        }
    }

    /** 状态摘要（Binder 控制面 §4.4：只含 status/pid/startedAt/failureCode/protocolVersion）。 */
    public JSONObject summary(String pid, String startedAt, String failureCode, String protocolVersion) {
        try {
            return new JSONObject()
                .put("status", state.wire)
                .put("pid", pid == null ? JSONObject.NULL : pid)
                .put("startedAt", startedAt == null ? JSONObject.NULL : startedAt)
                .put("failureCode", failureCode == null ? JSONObject.NULL : failureCode)
                .put("protocolVersion", protocolVersion == null ? JSONObject.NULL : protocolVersion);
        } catch (Exception error) {
            return new JSONObject();
        }
    }

    /** 允许的状态机可视化（测试/日志用）。 */
    public static Set<State> allowedNext(State from) {
        Set<State> next = new HashSet<>();
        for (State candidate : State.values()) {
            if (candidate != from && isAllowed(from, candidate)) next.add(candidate);
        }
        return Collections.unmodifiableSet(next);
    }
}
