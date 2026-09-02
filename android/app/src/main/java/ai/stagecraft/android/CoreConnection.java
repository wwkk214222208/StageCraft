package ai.stagecraft.android;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.IBinder;

import org.json.JSONObject;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.RejectedExecutionException;

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
    /** Rebind is deliberately bounded: a dead/unavailable Core must not leave a thread alive forever. */
    static final int MAX_REBIND_ATTEMPTS = 4;
    static final long REBIND_INITIAL_DELAY_MS = 300L;
    static final long REBIND_MAX_DELAY_MS = 2_000L;
    static final long BIND_CALLBACK_TIMEOUT_MS = 2_000L;
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
    private final AtomicBoolean closed = new AtomicBoolean(false);
    private final ScheduledExecutorService rebindExecutor = Executors.newSingleThreadScheduledExecutor(runnable -> {
        Thread thread = new Thread(runnable, "core-rebind");
        thread.setDaemon(true);
        return thread;
    });
    private final Object rebindLock = new Object();
    private ScheduledFuture<?> rebindTask;
    private ScheduledFuture<?> bindTimeoutTask;
    private int rebindAttempt;
    /** True while a restart has detached the old binding and is waiting for a new one. */
    private final AtomicBoolean restartRequested = new AtomicBoolean(false);
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
            if (closed.get()) {
                // Activity may be destroyed while Android delivers a queued callback.
                try { context.unbindService(connection); } catch (Exception ignored) { }
                return;
            }
            cancelBindTimeout();
            rebindPending.set(false); // 绑定完成：新一轮死亡通知方可触发重绑
            synchronized (rebindLock) {
                rebindAttempt = 0;
                restartRequested.set(false);
            }
            bound.set(true);
            core = ICoreControl.Stub.asInterface(binder);
            try {
                // 客户端 death recipient（评审第 1 条）：RemoteCallbackList 只覆盖服务端，客户端必须 linkToDeath
                binder.linkToDeath(() -> {
                    AppLog.i("core connection: binder death recipient fired");
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
                AppLog.i("core connection: service connected, callback registered");
            } catch (Exception error) {
                AppLog.w("core connection: registerCallback failed: " + error);
            }
        }

        @Override public void onServiceDisconnected(ComponentName name) {
            AppLog.i("core connection: service disconnected (core process died?)");
            handleDisconnect("onServiceDisconnected");
        }

        @Override public void onBindingDied(ComponentName name) {
            AppLog.i("core connection: binding died");
            handleDisconnect("onBindingDied");
        }
    };

    private void handleDisconnect(String source) {
        if (closed.get()) return;
        core = null;
        endpoint = null;
        bound.set(false);
        listener.onCoreDisconnected();
        scheduleRebindOnce(source);
    }

    /** 幂等重绑守卫（评审第 1 条）：同一轮死亡只执行一次 unbind+rebind。 */
    private void scheduleRebindOnce(String source) {
        if (closed.get()) return;
        if (!rebindPending.compareAndSet(false, true)) {
            rebindDedupedCount.incrementAndGet();
            AppLog.i("core connection: rebind already pending, deduped source=" + source);
            return;
        }
        synchronized (rebindLock) {
            rebindAttempt = 0;
        }
        AppLog.i("core connection: rebind scheduled (source=" + source + ")");
        scheduleRebindAttempt(REBIND_INITIAL_DELAY_MS);
    }

    private void scheduleRebindAttempt(long delayMs) {
        synchronized (rebindLock) {
            if (closed.get() || !rebindPending.get()) return;
            if (rebindTask != null) rebindTask.cancel(false);
            try {
                rebindTask = rebindExecutor.schedule(this::runRebindAttempt, delayMs, TimeUnit.MILLISECONDS);
            } catch (RejectedExecutionException error) {
                // unbind() may win the race after the closed check but before schedule().
                // Treat that race as an orderly end of this sequence, never as a binder
                // callback thread crash or a permanently latched rebindPending flag.
                rebindPending.set(false);
                restartRequested.set(false);
                rebindAttempt = 0;
                AppLog.i("core connection: rebind scheduler is closed; sequence abandoned");
            }
        }
    }

    private void runRebindAttempt() {
        if (closed.get() || !rebindPending.get()) return;
        final int attempt;
        synchronized (rebindLock) {
            attempt = ++rebindAttempt;
        }
        try { context.unbindService(connection); } catch (Exception ignored) { }
        core = null;
        endpoint = null;
        try {
            Intent intent = new Intent(context, CoreService.class);
            if (!context.bindService(intent, connection, Context.BIND_AUTO_CREATE)) {
                onRebindAttemptFailed(attempt, "bindService returned false");
                return;
            }
            // Android may accept a bind and never deliver onServiceConnected. Do not leave
            // rebindPending latched forever in that case.
            synchronized (rebindLock) {
                if (closed.get() || !rebindPending.get()) return;
                if (bindTimeoutTask != null) bindTimeoutTask.cancel(false);
                try {
                    bindTimeoutTask = rebindExecutor.schedule(
                        () -> onRebindAttemptFailed(attempt, "onServiceConnected timeout"),
                        BIND_CALLBACK_TIMEOUT_MS, TimeUnit.MILLISECONDS);
                } catch (RejectedExecutionException error) {
                    rebindPending.set(false);
                    restartRequested.set(false);
                    AppLog.i("core connection: bind timeout scheduler is closed; sequence abandoned");
                    try { context.unbindService(connection); } catch (Exception ignored) { }
                    return;
                }
            }
            AppLog.i("core connection: rebind attempt " + attempt + " accepted");
        } catch (Exception error) {
            onRebindAttemptFailed(attempt, "bindService exception: " + error.getClass().getSimpleName());
        }
    }

    private void onRebindAttemptFailed(int attempt, String reason) {
        if (closed.get() || !rebindPending.get()) return;
        cancelBindTimeout();
        try { context.unbindService(connection); } catch (Exception ignored) { }
        core = null;
        endpoint = null;
        if (attempt >= MAX_REBIND_ATTEMPTS) {
            rebindPending.set(false);
            restartRequested.set(false);
            synchronized (rebindLock) { rebindAttempt = 0; }
            AppLog.w("core connection: rebind exhausted after " + attempt + " attempts (" + reason + ")");
            return;
        }
        long delay = Math.min(REBIND_MAX_DELAY_MS,
            REBIND_INITIAL_DELAY_MS * (1L << Math.min(10, Math.max(0, attempt - 1))));
        AppLog.w("core connection: rebind attempt " + attempt + " failed (" + reason + "), retry in " + delay + "ms");
        scheduleRebindAttempt(delay);
    }

    private void cancelBindTimeout() {
        synchronized (rebindLock) {
            if (bindTimeoutTask != null) {
                bindTimeoutTask.cancel(false);
                bindTimeoutTask = null;
            }
        }
    }

    /** 绑定 CoreService（BIND_AUTO_CREATE）。 */
    public void bind() {
        if (closed.get()) return;
        Intent intent = new Intent(context, CoreService.class);
        try {
            if (context.bindService(intent, connection, Context.BIND_AUTO_CREATE)) {
                AppLog.i("core connection: bound :core service (BIND_AUTO_CREATE)");
                // A successful bind is only an acceptance, not a connection. Bound
                // services are occasionally observed to omit the callback; use the
                // same bounded recovery path as a failed rebind.
                synchronized (rebindLock) {
                    if (bindTimeoutTask != null) bindTimeoutTask.cancel(false);
                    try {
                        bindTimeoutTask = rebindExecutor.schedule(
                            () -> onInitialBindTimeout(), BIND_CALLBACK_TIMEOUT_MS, TimeUnit.MILLISECONDS);
                    } catch (RejectedExecutionException error) {
                        AppLog.i("core connection: initial bind timeout scheduler is closed");
                    }
                }
            } else {
                AppLog.w("core connection: bindService FAILED");
                scheduleRebindOnce("initial bind returned false");
            }
        } catch (Exception error) {
            AppLog.w("core connection: bindService exception: " + error);
            scheduleRebindOnce("initial bind exception");
        }
    }

    private void onInitialBindTimeout() {
        if (closed.get() || bound.get() || rebindPending.get()) return;
        try { context.unbindService(connection); } catch (Exception ignored) { }
        AppLog.w("core connection: initial bind timed out; entering bounded rebind");
        scheduleRebindOnce("initial bind timeout");
    }

    /**
     * Cold-restart Core. If the endpoint is ready, killing its pid drives the normal
     * binder-death path. Before handshake, detach the binding first and stop the
     * bind-only service; the bounded rebind then creates a fresh :core process.
     *
     * @return true when a restart sequence was accepted, false after Activity teardown
     */
    public boolean restart() {
        if (closed.get()) return false;
        JSONObject currentEndpoint = endpoint;
        int corePid = currentEndpoint == null ? 0 : currentEndpoint.optInt("pid", 0);
        if (corePid > 0) {
            AppLog.i("core connection: restart killing :core pid=" + corePid);
            android.os.Process.killProcess(corePid);
            // Do not depend solely on the platform death callback: scheduleRebindOnce
            // supplies the bounded fallback, while binder callbacks remain deduped.
            scheduleRebindOnce("restart-kill");
            return true;
        }
        if (!restartRequested.compareAndSet(false, true)) return true;
        AppLog.i("core connection: restart before endpoint; detach + stopService + bounded rebind");
        core = null;
        endpoint = null;
        bound.set(false);
        try { context.unbindService(connection); } catch (Exception ignored) { }
        try { context.stopService(new Intent(context, CoreService.class)); } catch (Exception error) {
            AppLog.w("core connection: stopService during restart failed: " + error.getClass().getSimpleName());
        }
        scheduleRebindOnce("restart-endpoint-not-ready");
        return true;
    }

    /** 解除绑定（Activity onDestroy）。 */
    public void unbind() {
        if (!closed.compareAndSet(false, true)) return;
        cancelBindTimeout();
        synchronized (rebindLock) {
            if (rebindTask != null) {
                rebindTask.cancel(false);
                rebindTask = null;
            }
        }
        rebindPending.set(false);
        restartRequested.set(false);
        rebindExecutor.shutdownNow();
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
                AppLog.w("core connection: launch plan too large, rejected");
                return;
            }
            current.acceptLaunchPlan(plan.toString());
            AppLog.i("core connection: launch plan accepted (pluginSetHash=" + plan.optString("pluginSetHash") + ")");
        } catch (Exception error) {
            AppLog.w("core connection: acceptLaunchPlan failed: " + error);
        }
    }

    /**
     * 请求优雅停止（fire-and-forget）。
     *
     * ⚠ 注意：:core 内 stopSelf 在绑定存活时不会触发重建（真机实测，见 CoreService renderer-gone
     * 注释）——本方法只会让服务实例掏空自己（数据面停、WebView 销毁），进程与绑定都还在。
     * 需要"重启 Core 生效"语义（如插件配置变更）请走 host.restart 的进程恢复链（kill :core pid），
     * 复用本类既有 binder-death 幂等重绑。
     */
    public void requestStop() {
        ICoreControl current = core;
        if (current == null) return;
        try { current.requestStop(); } catch (Exception ignored) { }
    }
}
