package ai.stagecraft.android;

import org.json.JSONObject;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * W5：Core 进程内桥（Core WebView JS ↔ 原生端口）。
 *
 * 职责（计划 §5.2/§2.2）：
 *  - 独立命名 CoreNative interface（不得复用主 WebView 的 StageCraftNative）；
 *  - 只允许 core-native allowlist 内的 operation（Gate B：NativeOperationGuard.checkCoreNative）；
 *  - 同步/异步操作带 requestId、单消息上限、超时与取消；
 *  - 不暴露 main-host operation，不向页面返回任意原生凭据。
 *
 * 页面侧经 WebMessagePort 或 evaluateJavascript 调用（CoreService 负责通道建立）。
 * 本类只做分派与守卫，不持有 WebView 引用（JVM 可测）。
 */
public final class CoreNativeBridge {
    public static final int MAX_OPERATION_LENGTH = 64;
    public static final int MAX_INPUT_BYTES = 4 * 1024 * 1024;
    public static final int MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
    public static final long DEFAULT_TIMEOUT_MS = 20_000;

    /** 同步操作结果回调（页面 → 原生端口）。 */
    public interface SyncResult {
        Object apply(JSONObject input) throws Exception;
    }

    /** 异步操作（模型请求等流式回调）。 */
    public interface AsyncInvoker {
        void invoke(String operation, JSONObject input, Callback callback);
    }

    public interface Callback {
        void onResult(JSONObject result);
        void onError(String message);
    }

    public interface Clock {
        long now();
    }

    private final NativeOperationGuard guard;
    private final Map<String, SyncResult> syncOperations = new ConcurrentHashMap<>();
    private final Map<String, AsyncInvoker> asyncOperations = new ConcurrentHashMap<>();
    private final AtomicLong sequence = new AtomicLong();
    private final long timeoutMs;
    private final Clock clock;

    public CoreNativeBridge(NativeOperationGuard guard) {
        this(guard, DEFAULT_TIMEOUT_MS, System::currentTimeMillis);
    }

    public CoreNativeBridge(NativeOperationGuard guard, long timeoutMs, Clock clock) {
        this.guard = java.util.Objects.requireNonNull(guard, "guard");
        this.timeoutMs = timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
        this.clock = clock == null ? System::currentTimeMillis : clock;
    }

    public void registerSync(String operation, SyncResult handler) {
        syncOperations.put(operation, handler);
    }

    public void registerAsync(String operation, AsyncInvoker invoker) {
        asyncOperations.put(operation, invoker);
    }

    public long timeoutMs() { return timeoutMs; }

    /** 同步调用入口（CoreService 的 @JavascriptInterface 回调）。失败返回错误 JSON，不抛出。 */
    public String invokeSync(String operation, String inputJson) {
        try {
            if (operation == null || operation.length() > MAX_OPERATION_LENGTH) return errorJson("Invalid native operation.");
            String denied = guard.checkCoreNative(operation);
            if (denied != null) return errorJson(denied);
            if (inputJson == null || inputJson.length() > MAX_INPUT_BYTES) return errorJson("Invalid native input.");
            JSONObject input = new JSONObject(inputJson);
            SyncResult handler = syncOperations.get(operation);
            if (handler == null) {
                AsyncInvoker async = asyncOperations.get(operation);
                if (async == null) return errorJson("Unsupported core-native operation: " + operation);
                // 异步操作不允许走同步入口（模型请求必须异步）。
                return errorJson("Operation requires async invocation: " + operation);
            }
            Object result = handler.apply(input);
            String encoded = JsonSafety.toJsonText(result);
            if (encoded.length() > MAX_OUTPUT_BYTES) return errorJson("Native output is too large.");
            return encoded;
        } catch (Exception error) {
            return errorJson(error.getMessage() == null ? "Native operation failed." : error.getMessage());
        }
    }

    /**
     * 异步调用入口。回调 id 由调用方分配；每次调用返回一个 requestId。
     * 超时：handler 未在 timeoutMs 内首次回调 → onError("bridge_timeout")。
     */
    public String invokeAsync(String operation, String inputJson, Callback callback) {
        if (operation == null || operation.length() > MAX_OPERATION_LENGTH) {
            callback.onError("Invalid native operation.");
            return "";
        }
        String denied = guard.checkCoreNative(operation);
        if (denied != null) { callback.onError(denied); return ""; }
        if (inputJson == null || inputJson.length() > MAX_INPUT_BYTES) {
            callback.onError("Invalid native input.");
            return "";
        }
        AsyncInvoker invoker = asyncOperations.get(operation);
        if (invoker == null) {
            SyncResult sync = syncOperations.get(operation);
            if (sync != null) {
                // 同步操作经异步入口：包一层直接执行（模型取消等少量场景）。
                try {
                    callback.onResult(new JSONObject(JsonSafety.toJsonText(sync.apply(new JSONObject(inputJson)))));
                } catch (Exception error) {
                    callback.onError(error.getMessage() == null ? "Native operation failed." : error.getMessage());
                }
                return "";
            }
            callback.onError("Unsupported core-native operation: " + operation);
            return "";
        }
        String requestId = "core-native-" + clock.now() + "-" + sequence.incrementAndGet();
        final long deadline = clock.now() + timeoutMs;
        JSONObject input;
        try { input = new JSONObject(inputJson); } catch (Exception error) { callback.onError("Invalid native input."); return ""; }
        final boolean[] done = new boolean[1];
        invoker.invoke(operation, input, new Callback() {
            @Override public void onResult(JSONObject result) {
                if (done[0]) return;
                done[0] = true;
                callback.onResult(result);
            }

            @Override public void onError(String message) {
                if (done[0]) return;
                done[0] = true;
                callback.onError(message);
            }
        });
        // 超时护栏：首次回调未发生则报超时（幂等，已回调则忽略）。
        java.util.concurrent.CompletableFuture.delayedExecutor(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS).execute(() -> {
            if (!done[0]) {
                done[0] = true;
                callback.onError("bridge_timeout: " + operation + " did not respond within " + timeoutMs + "ms");
            }
        });
        return requestId;
    }

    /** 页面侧事件/状态上报（core-event / core-ready / log）：CoreService 负责处理。 */
    public static JSONObject parseBridgeMessage(String json) {
        try { return new JSONObject(json == null ? "{}" : json); }
        catch (Exception error) { return new JSONObject(); }
    }

    private static String errorJson(String message) {
        try { return new JSONObject().put("ok", false).put("error", new JSONObject().put("code", "NATIVE_OPERATION_FAILED").put("message", message == null || message.isEmpty() ? "Native operation failed." : message)).toString(); }
        catch (Exception ignored) { return "{\"ok\":false,\"error\":{\"code\":\"NATIVE_OPERATION_FAILED\",\"message\":\"Native operation failed.\"}}"; }
    }
}
