package ai.stagecraft.android;

import ai.stagecraft.android.ICoreControlCallback;

/** Q8 最小控制面契约：bind 后由主进程调用；全部消息为小 JSON 字符串（≤8KiB），不承载业务数据。 */
interface ICoreControl {
    /** 端点就绪后返回 {"port":int,"nonce":String,"pid":int}；未就绪返回 null。 */
    String getEndpoint();

    /** 状态摘要 {"status","pid","startedAt","failureCode","protocolVersion"}。 */
    String getStatusSummary();

    /** 注册回调；注册即回发当前状态与端点（如已就绪）。 */
    void registerCallback(ICoreControlCallback callback);

    /** 优雅停止（fire-and-forget）。 */
    oneway void requestStop();

    /** 接受主进程的 PluginLaunchPlan（§2.4）；≤8KiB 小消息，不承载业务数据。 */
    void acceptLaunchPlan(String planJson);
}
