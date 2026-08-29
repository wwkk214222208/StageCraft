package ai.stagecraft.android;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.IBinder;

import org.json.JSONObject;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * W6：主进程 CoreConnection（计划 §2.1/§2.4/§4.4，阶段 1/4）。
 *
 * 负责：
 *  - bindService(BIND_AUTO_CREATE) 创建并持有 :core 进程 CoreService；
 *  - ServiceConnection + Binder death recipient + 幂等重绑（onServiceDisconnected/
 *    onBindingDied/death recipient 对同一次死亡去重）；
 *  - endpoint/nonce 握手（onEndpointReady 回调）；
 *  - acceptLaunchPlan 传递（不可变 PluginLaunchPlan，≤8KiB）；
 *  - Core 故障状态上报（Listener.onCoreStatus）。
 *
 * 状态机由 CoreServiceStateMachine（:core 侧）驱动；本类只负责主进程侧连接生命周期。
 * 回调全部在 UI 线程（ServiceConnection 回调本身在 binder 线程，需 runOnUiThread）。
 */
public final class CoreConnection {
    /** 主进程监听 Core 生命周期事件。 */
    public interface Listener {
        /** endpoint 就绪/更新：{port, nonce, pid}（nonce 只进原生连接层）。 */
        void onEndpointReady(JSONObject endpoint);
        /** Core 状态摘要：{status, pid, startedAt, failureCode, protocolVersion}。 */
        void onStatus(JSONObject summary);
        /** Core 进程死亡/断连（onServiceDisconnected/onBindingDied/death recipient）。 */
        void onCoreDisconnected();
    }

    private final Context context;
    private final Listener listener;
    private final AtomicBoolean rebindPending = new AtomicBoolean(false);
    private final AtomicLong rebindDedupedCount = new AtomicLong();
    private final AtomicBoolean bound = new AtomicBoolean(false);
    private volatile ICoreControl core;
    private volatile JSONObject endpoint;
    private volatile String lastStatus = "";

    public CoreConnection(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
    }

    public boolean isBound() { return bound.get(); }
    public JSONObject endpoint() { return endpoint; }
    public String lastStatus() { return lastStatus; }
    public long rebindDedupedCount() { return rebindDedupedCount.get(); }

    private final ServiceConnection connection = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            rebindPending.set(false); // 绑定完成：新一轮死亡通知方可触发重绑
            bound.set(true);
            core = ICoreControl.Stub.asInterface(binder);
            try {
                // 客户端 death recipient（评审第 1 条）：RemoteCallbackList 只覆盖服务端，客户端必须 linkToDeath
                binder.linkToDeath(() -> {
                    GateALog.i("core connection: binder death recipient fired");
                    handleDisconnect("death-recipient");
                }, 0);
                core.registerCallback(new ICoreControlCallback.Stub() {
                    @Override public void onStatus(String summaryJson) {
                        if (summaryJson != null) lastStatus = summaryJson;
                        try {
                            listener.onStatus(new JSONObject(summaryJson == null ? "{}" : summaryJson));
                        } catch (Exception ignored) { }
                    }

                    @Override public void onEndpointReady(String endpointJson) {
                        try {
                            endpoint = new JSONObject(endpointJson);
                            listener.onEndpointReady(endpoint);
                        } catch (Exception ignored) { }
                    }
                });
                GateALog.i("core connection: service connected, callback registered");
            } catch (Exception error) {
                GateALog.w("core connection: registerCallback failed: " + error);
            }
        }

        @Override public void onServiceDisconnected(ComponentName name) {
            GateALog.i("core connection: service disconnected (core process died?)");
            handleDisconnect("onServiceDisconnected");
        }

        @Override public void onBindingDied(ComponentName name) {
            GateALog.i("core connection: binding died");
            handleDisconnect("onBindingDied");
        }
    };

    private void handleDisconnect(String source) {
        core = null;
        endpoint = null;
        bound.set(false);
        listener.onCoreDisconnected();
        scheduleRebindOnce(source);
    }

    /** 幂等重绑守卫（评审第 1 条）：同一轮死亡只执行一次 unbind+rebind。 */
    private void scheduleRebindOnce(String source) {
        if (!rebindPending.compareAndSet(false, true)) {
            rebindDedupedCount.incrementAndGet();
            GateALog.i("core connection: rebind already pending, deduped source=" + source);
            return;
        }
        GateALog.i("core connection: rebind scheduled (source=" + source + ")");
        new Thread(() -> {
            try { Thread.sleep(300); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
            try { context.unbindService(connection); } catch (Exception ignored) { }
            core = null;
            endpoint = null;
            // rebindPending 在 onServiceConnected 后才清零（评审：清零过早存在重复重绑窗口）
            bind();
        }, "core-rebind").start();
    }

    /** 绑定 CoreService（BIND_AUTO_CREATE）。 */
    public void bind() {
        Intent intent = new Intent(context, CoreService.class);
        try {
            if (context.bindService(intent, connection, Context.BIND_AUTO_CREATE)) {
                GateALog.i("core connection: bound :core service (BIND_AUTO_CREATE)");
            } else {
                GateALog.w("core connection: bindService FAILED");
            }
        } catch (Exception error) {
            GateALog.w("core connection: bindService exception: " + error);
        }
    }

    /** 解除绑定（Activity onDestroy）。 */
    public void unbind() {
        try { context.unbindService(connection); } catch (Exception ignored) { }
        bound.set(false);
        core = null;
        endpoint = null;
    }

    /** 传递 PluginLaunchPlan（≤8KiB；不可变，运行中不热替换）。 */
    public void acceptLaunchPlan(JSONObject plan) {
        ICoreControl current = core;
        if (current == null || plan == null) return;
        try {
            if (plan.toString().length() > 8 * 1024) {
                GateALog.w("core connection: launch plan too large, rejected");
                return;
            }
            current.acceptLaunchPlan(plan.toString());
            GateALog.i("core connection: launch plan accepted (pluginSetHash=" + plan.optString("pluginSetHash") + ")");
        } catch (Exception error) {
            GateALog.w("core connection: acceptLaunchPlan failed: " + error);
        }
    }

    /** 请求优雅停止（fire-and-forget）。 */
    public void requestStop() {
        ICoreControl current = core;
        if (current == null) return;
        try { current.requestStop(); } catch (Exception ignored) { }
    }
}
