package ai.stagecraft.android;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;

/**
 * W5-R1-2：CoreService Binder 控制面的纯 Java 执行体（JVM 可测 seam）。
 *
 * ICoreControl.Stub 的方法体只做一行委托到本类；测试直接调用本类即执行与
 * Binder Stub 完全相同的代码路径（摘要生成、64KiB 上限、端点就绪判定），
 * 覆盖初始/ready/failed 摘要且不递归。Binder 线程边界由 Android 框架承担，
 * 本类不依赖任何 Android 对象。
 */
public final class CoreControlBinder {
    public static final int BINDER_HARD_LIMIT_BYTES = 64 * 1024;

    /** 端点就绪判定（CoreService 注入）。 */
    public interface EndpointProvider {
        /** 返回端点 JSON（port/nonce/pid）或 null（未就绪）。 */
        String endpointOrNull();
    }

    /** 状态摘要提供者（CoreService 注入，委托 CoreServiceStateMachine.summary）。 */
    public interface SummaryProvider {
        JSONObject summary();
    }

    private final EndpointProvider endpoints;
    private final SummaryProvider summaries;
    private volatile int maxPayloadBytes = 0;

    public CoreControlBinder(EndpointProvider endpoints, SummaryProvider summaries) {
        this.endpoints = java.util.Objects.requireNonNull(endpoints, "endpoints");
        this.summaries = java.util.Objects.requireNonNull(summaries, "summaries");
    }

    /** 发送侧 64KiB 硬断言 + 最大单条观测（§4.4）。 */
    public String enforceBinderLimit(String payload) {
        int bytes = payload.getBytes(StandardCharsets.UTF_8).length;
        if (bytes > maxPayloadBytes) maxPayloadBytes = bytes;
        if (bytes > BINDER_HARD_LIMIT_BYTES) {
            throw new IllegalStateException("Binder payload exceeds 64KiB hard limit: " + bytes);
        }
        return payload;
    }

    public int maxPayloadBytes() { return maxPayloadBytes; }

    /** getEndpoint：未就绪返回 null；就绪返回受上限约束的端点 JSON。 */
    public String getEndpoint() {
        String endpoint = endpoints.endpointOrNull();
        if (endpoint == null) return null;
        return enforceBinderLimit(endpoint);
    }

    /** getStatusSummary：受上限约束的摘要 JSON；不递归（本类无自调用）。 */
    public String getStatusSummary() {
        return enforceBinderLimit(summaries.summary().toString());
    }
}
