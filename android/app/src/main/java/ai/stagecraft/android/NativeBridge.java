package ai.stagecraft.android;

import android.app.Activity;
import android.net.Uri;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;

public final class NativeBridge implements AutoCloseable {
    private final Activity activity;
    private final WebView webView;
    private final RemoteSessionStore sessionStore;
    private final ExecutorService networkExecutor = Executors.newSingleThreadExecutor();
    private final AtomicLong connectionGeneration = new AtomicLong();
    private final AtomicLong operationGeneration = new AtomicLong();
    private final AtomicLong fileGeneration = new AtomicLong();
    private volatile RemoteCoreConnection connection;
    private volatile HttpURLConnection activePairRequest;
    private volatile boolean foreground;
    private volatile boolean ready;
    private volatile boolean closed;
    private volatile boolean userDisconnected;
    private volatile String activeCredential;
    private final EmbeddedCoreArtifact.Verification embeddedCore;
    private final AndroidCompositionOperations compositionOperations;
    private volatile String pendingExportKind;
    private volatile JSONObject pendingExportPayload;

    public NativeBridge(Activity activity, WebView webView, RemoteSessionStore sessionStore, EmbeddedCoreArtifact.Verification embeddedCore) {
        this.activity = activity;
        this.webView = webView;
        this.sessionStore = sessionStore;
        this.embeddedCore = embeddedCore;
        this.compositionOperations = new AndroidCompositionOperations(activity, new AndroidSqliteRepository(activity), new AndroidSecretStore(activity), networkExecutor);
    }

    @JavascriptInterface public boolean localCoreAllowed() {
        return embeddedCore.valid();
    }

    /** 当前已配对会话的 Bearer token（仅供 StageCraftWebViewClient 注入，不暴露给页面 JS）。 */
    public String currentCredential() {
        return activeCredential;
    }

    @JavascriptInterface public synchronized String invokeSync(String operation, String inputJson) {
        if (closed) return errorJson("Native bridge is closed.");
        if (operation == null || operation.length() > 64 || inputJson == null || inputJson.length() > 4 * 1024 * 1024) return errorJson("Invalid native request.");
        try {
            JSONObject input = new JSONObject(inputJson);
            Object result = compositionOperations.invokeSync(operation, input);
            // A missing persisted Core snapshot is a valid first-run state, not a bridge error.
            return result == null ? JSONObject.NULL.toString() : result.toString();
        } catch (Exception error) { return errorJson(error.getMessage() == null ? "Native operation failed." : error.getMessage()); }
    }

    /**
     * 异步原生操作桥（模型请求 / 提示词、剧本源读取）。每个回调 id 允许多次
     * onResult（如模型 thinking 增量 + 最终结果）；页面侧按契约聚合。
     */
    @JavascriptInterface public void invokeAsync(String operation, String inputJson, String callbackId) {
        if (closed) { deliverAsync(callbackId, errorJson("Native bridge is closed.")); return; }
        if (operation == null || operation.length() > 64 || inputJson == null || inputJson.length() > 4 * 1024 * 1024 || callbackId == null || callbackId.length() > 96) {
            deliverAsync(callbackId, errorJson("Invalid native request."));
            return;
        }
        networkExecutor.execute(() -> {
            try {
                JSONObject input = new JSONObject(inputJson);
                compositionOperations.invoke(operation, input, new AndroidNativeOperations.Callback() {
                    @Override public void onResult(org.json.JSONObject result) {
                        if (!closed) deliverAsync(callbackId, result.toString());
                    }

                    @Override public void onError(String message) {
                        if (!closed) deliverAsync(callbackId, errorMessageJson(message));
                    }
                });
            } catch (Exception error) {
                if (!closed) deliverAsync(callbackId, errorMessageJson(error.getMessage() == null ? "Native operation failed." : error.getMessage()));
            }
        });
    }

    private void deliverAsync(String callbackId, String resultJson) {
        activity.runOnUiThread(() -> {
            if (closed) return;
            webView.evaluateJavascript("window.StageCraftNativeResult && window.StageCraftNativeResult.handle(" + JSONObject.quote(callbackId) + "," + JSONObject.quote(resultJson) + ")", null);
        });
    }

    private String errorMessageJson(String message) {
        try { return new JSONObject().put("ok", false).put("error", new JSONObject().put("code", "NATIVE_OPERATION_FAILED").put("message", message == null || message.isEmpty() ? "Native operation failed." : message)).toString(); }
        catch (Exception ignored) { return "{\"ok\":false,\"error\":{\"code\":\"NATIVE_OPERATION_FAILED\",\"message\":\"Native operation failed.\"}}"; }
    }

    private String errorJson(String message) {
        try { return new JSONObject().put("ok", false).put("error", new JSONObject().put("code", "NATIVE_OPERATION_FAILED").put("message", message == null || message.isEmpty() ? "Native operation failed." : message)).toString(); }
        catch (Exception ignored) { return "{\"ok\":false,\"error\":{\"code\":\"NATIVE_OPERATION_FAILED\",\"message\":\"Native operation failed.\"}}"; }
    }

    @JavascriptInterface public void ready() {
        if (closed) return;
        ready = true;
        restoreAndConnect();
    }

    @JavascriptInterface public void pair(String addressInput, boolean allowInsecureHttp, String pairingCode) {
        if (closed) return;
        final URI address;
        try {
            address = ServerAddressValidator.validate(addressInput, allowInsecureHttp);
            if (pairingCode == null || pairingCode.trim().isEmpty() || pairingCode.length() > 32) throw new IllegalArgumentException("Pairing code is invalid.");
        } catch (IllegalArgumentException error) {
            emit(errorMessage(error.getMessage()));
            return;
        }
        long operation = operationGeneration.incrementAndGet();
        cancelPairRequest();
        emit(stateMessage("pairing"));
        networkExecutor.execute(() -> exchangePairingCode(operation, address, allowInsecureHttp, pairingCode.trim()));
    }

    @JavascriptInterface public void reconnect() {
        userDisconnected = false;
        RemoteCoreConnection current = connection;
        if (current != null) current.reconnect();
        else restoreAndConnect();
    }

    @JavascriptInterface public void disconnect() {
        userDisconnected = true;
        RemoteCoreConnection current = connection;
        if (current != null) current.pause();
    }

    @JavascriptInterface public void refresh() {
        RemoteCoreConnection current = connection;
        if (current != null) current.refresh();
    }

    @JavascriptInterface public void dispatch(String commandJson) {
        RemoteCoreConnection current = connection;
        if (current != null) current.dispatch(commandJson);
    }

    @JavascriptInterface public void loadMedia(String path, String requestId) {
        RemoteCoreConnection current = connection;
        if (current != null) current.loadMedia(path, requestId);
    }

    @JavascriptInterface public void chooseStoryArchive() {
        if (closed || !(activity instanceof MainActivity)) return;
        activity.runOnUiThread(() -> ((MainActivity) activity).openStoryDocument());
    }

    void importStoryDocument(Uri uri) {
        if (closed || uri == null) return; long fileOperation = fileGeneration.incrementAndGet();
        networkExecutor.execute(() -> {
            try (InputStream input = activity.getContentResolver().openInputStream(uri)) {
                if (input == null) throw new IllegalArgumentException("无法读取剧本包。");
                JSONObject result = compositionOperations.importStoryArchive(input);
                if (closed || fileOperation != fileGeneration.get()) return;
                activity.runOnUiThread(() -> { if (!closed && activity instanceof MainActivity) ((MainActivity) activity).showLocalUi(); });
            } catch (Exception error) { if (!closed && fileOperation == fileGeneration.get()) emit(errorMessage("导入剧本失败：" + (error.getMessage() == null ? "文件无效。" : error.getMessage()))); }
        });
    }

    @JavascriptInterface public void exportDocument(String kind, String payloadJson, String suggestedName) {
        if (closed || !(activity instanceof MainActivity)) return;
        try { pendingExportKind = kind; pendingExportPayload = new JSONObject(payloadJson == null ? "{}" : payloadJson); }
        catch (Exception error) { emit(errorMessage("导出数据无效：" + error.getMessage())); return; }
        activity.runOnUiThread(() -> ((MainActivity) activity).createExportDocument(
            "story".equals(kind) ? "application/zip" : "application/json", suggestedName));
    }

    void completeExportDocument(Uri uri) {
        final String kind = pendingExportKind; final JSONObject payload = pendingExportPayload;
        pendingExportKind = null; pendingExportPayload = null;
        if (uri == null || kind == null || payload == null || closed) return;
        networkExecutor.execute(() -> {
            try {
                byte[] bytes; String type;
                if ("story".equals(kind)) {
                    String id = JsonSafety.requiredString(payload, "storyId", 128);
                    bytes = compositionOperations.exportStoryArchive(JsonSafety.requiredString(payload, "storyId", 128)); type = "剧本";
                } else {
                    Object value = "preset".equals(kind) ? new JSONObject().put("format", "stagecraft-prompt-preset").put("version", 1).put("preset", payload.opt("preset")) : new JSONObject().put("version", 1).put("exportedAt", new java.util.Date().toString()).put("room", payload.opt("archive"));
                    bytes = value.toString().getBytes(StandardCharsets.UTF_8); type = "preset".equals(kind) ? "预设" : "存档";
                }
                try (OutputStream output = activity.getContentResolver().openOutputStream(uri)) { if (output == null) throw new IllegalStateException("无法打开导出文件。"); output.write(bytes); }
                emit(stateMessage("已导出" + type));
            } catch (Exception error) { emit(errorMessage("导出失败：" + error.getMessage())); }
        });
    }

    @JavascriptInterface public String syncStatus() {
        try {
            RemoteSessionStore.SavedSession saved = sessionStore.load();
            if (saved == null) return new JSONObject().put("paired", false).toString();
            return new JSONObject().put("paired", true).put("address", saved.address()).toString();
        } catch (Exception error) {
            try { return new JSONObject().put("paired", false).toString(); } catch (Exception ignored) { return "{\"paired\":false}"; }
        }
    }

    /** 仅配对并保存会话（不切换到远程 Web UI），供设置页「与电脑同步」使用。 */
    @JavascriptInterface public void syncPair(String addressInput, boolean allowInsecureHttp, String pairingCode) {
        if (closed) return;
        final URI address;
        try {
            address = ServerAddressValidator.validate(addressInput, allowInsecureHttp);
            if (pairingCode == null || pairingCode.trim().isEmpty() || pairingCode.length() > 32) throw new IllegalArgumentException("Pairing code is invalid.");
        } catch (IllegalArgumentException error) {
            deliverSyncPairResult("{\"ok\":false,\"message\":\"地址或配对码无效。\"}");
            return;
        }
        long operation = operationGeneration.incrementAndGet();
        cancelPairRequest();
        networkExecutor.execute(() -> exchangeSyncPair(operation, address, allowInsecureHttp, pairingCode.trim()));
    }

    /** 带配对会话 Bearer 调用电脑端同步端点（GET/PUT /api/remote/sync）；配对凭据不进入页面。 */
    @JavascriptInterface public void syncRemoteFetch(String method, String bodyJson, String callbackId) {
        if (closed || callbackId == null || callbackId.length() > 96) return;
        final String verb = "GET".equals(method) ? "GET" : "PUT";
        networkExecutor.execute(() -> {
            HttpURLConnection request = null;
            try {
                RemoteSessionStore.SavedSession saved = sessionStore.load();
                if (saved == null) throw new IllegalStateException("未绑定电脑，请先配对。");
                URI address = ServerAddressValidator.validate(saved.address(), saved.allowInsecureHttp());
                request = (HttpURLConnection) address.resolve("/api/remote/sync").toURL().openConnection();
                request.setRequestMethod(verb);
                request.setRequestProperty("Accept", "application/json");
                request.setRequestProperty("Authorization", "Bearer " + saved.credential());
                request.setConnectTimeout(10_000);
                request.setReadTimeout(60_000);
                request.setUseCaches(false);
                request.setInstanceFollowRedirects(false);
                if ("PUT".equals(verb)) {
                    if (bodyJson == null || bodyJson.length() > 32 * 1024 * 1024) throw new IllegalStateException("同步数据过大。");
                    byte[] body = bodyJson.getBytes(StandardCharsets.UTF_8);
                    request.setRequestProperty("Content-Type", "application/json");
                    request.setFixedLengthStreamingMode(body.length);
                    request.setDoOutput(true);
                    try (OutputStream output = request.getOutputStream()) { output.write(body); }
                }
                int status = request.getResponseCode();
                if (status == 401 || status == 403) {
                    sessionStore.clearSession();
                    activeCredential = null;
                    throw new IllegalStateException("电脑会话已失效，请重新绑定。");
                }
                if (status < 200 || status >= 300) throw new IllegalStateException("同步失败（HTTP " + status + "）。");
                String responseText = readLimited(request.getInputStream(), 32 * 1024 * 1024);
                deliverSyncFetch(callbackId, true, status, responseText, null);
            } catch (Exception error) {
                if (!closed) deliverSyncFetch(callbackId, false, 0, null, error.getMessage() == null ? "同步失败。" : error.getMessage());
            } finally {
                if (request != null) request.disconnect();
            }
        });
    }

    private void exchangeSyncPair(long operation, URI address, boolean allowInsecureHttp, String pairingCode) {
        HttpURLConnection request = null;
        try {
            if (closed || operation != operationGeneration.get()) return;
            request = (HttpURLConnection) address.resolve("/api/remote/pair").toURL().openConnection();
            activePairRequest = request;
            if (closed || operation != operationGeneration.get()) return;
            request.setRequestMethod("POST");
            request.setRequestProperty("Accept", "application/json");
            request.setRequestProperty("Content-Type", "application/json");
            request.setConnectTimeout(10_000);
            request.setReadTimeout(20_000);
            request.setUseCaches(false);
            request.setInstanceFollowRedirects(false);
            request.setDoOutput(true);
            byte[] body = new JSONObject().put("code", pairingCode).toString().getBytes(StandardCharsets.UTF_8);
            request.setFixedLengthStreamingMode(body.length);
            try (OutputStream output = request.getOutputStream()) { output.write(body); }
            int status = request.getResponseCode();
            if (status < 200 || status >= 300) {
                String detail = "HTTP " + status;
                try {
                    InputStream stream = request.getErrorStream();
                    if (stream != null) {
                        String errorBody = readLimited(stream, 4_096);
                        if (!errorBody.isEmpty()) detail += " " + errorBody;
                    }
                } catch (Exception ignored) { }
                throw new IllegalStateException(detail);
            }
            JSONObject response = new JSONObject(readLimited(request.getInputStream(), 65_536));
            String credential = response.optString("token", "");
            if (credential.length() < 32) throw new IllegalStateException("配对响应缺少有效 token。");
            if (closed || operation != operationGeneration.get()) return;
            String normalized = address.toString();
            sessionStore.save(normalized, allowInsecureHttp, credential);
            activeCredential = credential;
            deliverSyncPairResult(new JSONObject().put("ok", true).put("address", normalized).toString());
        } catch (Exception error) {
            if (!closed && operation == operationGeneration.get()) {
                try {
                    String reason = error.getMessage() == null || error.getMessage().isEmpty() ? "请检查地址和配对码。" : error.getMessage();
                    deliverSyncPairResult(new JSONObject().put("ok", false).put("message", "绑定失败：" + reason).toString());
                } catch (Exception ignored) { deliverSyncPairResult("{\"ok\":false,\"message\":\"绑定失败。\"}"); }
            }
        } finally {
            if (request != null) request.disconnect();
            if (activePairRequest == request) activePairRequest = null;
        }
    }

    private void deliverSyncPairResult(String resultJson) {
        activity.runOnUiThread(() -> {
            if (closed) return;
            // resultJson 本身是合法 JSON 对象字面量，直接嵌入 JS；不可用 JSONObject.quote 再包一层（会把对象变成字符串，网页端 result.ok 失效）。
            webView.evaluateJavascript("window.StageCraftSyncPairResult && window.StageCraftSyncPairResult(" + resultJson + ")", null);
        });
    }

    private void deliverSyncFetch(String callbackId, boolean ok, int status, String bodyText, String message) {
        final JSONObject result = new JSONObject();
        try {
            result.put("callbackId", callbackId).put("ok", ok).put("status", status);
            if (ok) result.put("body", bodyText == null ? "" : bodyText);
            else result.put("message", message == null ? "同步失败。" : message);
        } catch (Exception ignored) { }
        activity.runOnUiThread(() -> {
            if (closed) return;
            webView.evaluateJavascript("window.StageCraftSyncFetchResult && window.StageCraftSyncFetchResult(" + result.toString() + ")", null);
        });
    }

    @JavascriptInterface public void chooseCharacterCard() {
        if (closed || !(activity instanceof MainActivity)) return;
        activity.runOnUiThread(() -> ((MainActivity) activity).openCharacterCardPicker());
    }

    void importCharacterCard(Uri uri) {
        if (closed || uri == null) return;
        long fileOperation = fileGeneration.incrementAndGet();
        networkExecutor.execute(() -> {
            try {
                byte[] bytes;
                try (InputStream input = activity.getContentResolver().openInputStream(uri)) {
                    if (input == null) throw new IllegalArgumentException("Card cannot be read.");
                    bytes = readBytesLimited(input, 8 * 1024 * 1024);
                }
                if (!isPng(bytes)) throw new IllegalArgumentException("Card must be a PNG file.");
                if (closed || fileOperation != fileGeneration.get()) return;
                RemoteCoreConnection current = connection;
                if (current == null) throw new IllegalStateException("Not connected.");
                current.importCharacterCard(bytes);
            } catch (Exception error) {
                if (!closed && fileOperation == fileGeneration.get()) emit(cardImportErrorMessage());
            }
        });
    }

    @JavascriptInterface public void clearSession() {
        userDisconnected = true;
        operationGeneration.incrementAndGet();
        cancelPairRequest();
        connectionGeneration.incrementAndGet();
        closeConnection();
        activeCredential = null;
        sessionStore.clearSession();
        activity.runOnUiThread(() -> ((MainActivity) activity).showPairingPage());
        emit(authRequiredMessage("本机会话已清除，请重新配对。"));
    }

    public void onForeground() {
        foreground = true;
        RemoteCoreConnection current = connection;
        if (current != null) {
            if (!userDisconnected) current.resume();
        } else if (ready) {
            restoreAndConnect();
        }
    }

    public void onBackground() {
        foreground = false;
        RemoteCoreConnection current = connection;
        if (current != null) current.pause();
    }

    private void restoreAndConnect() {
        if (closed || !ready) return;
        long operation = operationGeneration.incrementAndGet();
        cancelPairRequest();
        networkExecutor.execute(() -> {
            RemoteSessionStore.SavedSession saved = sessionStore.load();
            if (closed || operation != operationGeneration.get()) return;
            if (saved == null) { emit(authRequiredMessage("请输入电脑上显示的一次性配对码。")); return; }
            try {
                URI address = ServerAddressValidator.validate(saved.address(), saved.allowInsecureHttp());
                activeCredential = saved.credential();
                emit(restoredMessage(saved.address(), saved.allowInsecureHttp()));
                installConnection(address, saved.credential());
            } catch (IllegalArgumentException error) {
                sessionStore.clearSession();
                emit(authRequiredMessage("保存的服务器地址已失效，请重新配对。"));
            }
        });
    }

    private void exchangePairingCode(long operation, URI address, boolean allowInsecureHttp, String pairingCode) {
        HttpURLConnection request = null;
        try {
            if (closed || operation != operationGeneration.get()) return;
            request = (HttpURLConnection) address.resolve("/api/remote/pair").toURL().openConnection();
            activePairRequest = request;
            if (closed || operation != operationGeneration.get()) return;
            request.setRequestMethod("POST");
            request.setRequestProperty("Accept", "application/json");
            request.setRequestProperty("Content-Type", "application/json");
            request.setConnectTimeout(10_000);
            request.setReadTimeout(20_000);
            request.setUseCaches(false);
            request.setInstanceFollowRedirects(false);
            request.setDoOutput(true);
            byte[] body = new JSONObject().put("code", pairingCode).toString().getBytes(StandardCharsets.UTF_8);
            request.setFixedLengthStreamingMode(body.length);
            try (OutputStream output = request.getOutputStream()) { output.write(body); }
            int status = request.getResponseCode();
            if (status < 200 || status >= 300) throw new IllegalStateException("Pairing failed.");
            JSONObject response = new JSONObject(readLimited(request.getInputStream(), 65_536));
            String credential = response.optString("token", "");
            if (credential.length() < 32) throw new IllegalStateException("Pairing failed.");
            if (closed || operation != operationGeneration.get()) return;
            String normalized = address.toString();
            sessionStore.save(normalized, allowInsecureHttp, credential);
            activeCredential = credential;
            emit(restoredMessage(normalized, allowInsecureHttp));
            installConnection(address, credential);
        } catch (Exception error) {
            if (!closed && operation == operationGeneration.get()) emit(errorMessage("配对失败，请检查地址和一次性配对码。"));
        } finally {
            if (request != null) request.disconnect();
            if (activePairRequest == request) activePairRequest = null;
        }
    }

    private synchronized void installConnection(URI address, String credential) {
        long installedGeneration = connectionGeneration.incrementAndGet();
        closeConnection();
        userDisconnected = false;
        RemoteCoreConnection next = new RemoteCoreConnection(address, credential, new RemoteCoreConnection.Listener() {
            @Override public void onMessage(String messageJson) {
                if (installedGeneration == connectionGeneration.get()) emit(messageJson);
            }

            @Override public void onUnauthorized() {
                if (installedGeneration != connectionGeneration.get()) return;
                connectionGeneration.incrementAndGet();
                sessionStore.clearSession();
                activeCredential = null;
                closeConnection();
                activity.runOnUiThread(() -> ((MainActivity) activity).showPairingPage());
            }
        });
        connection = next;
        activity.runOnUiThread(() -> ((MainActivity) activity).showRemoteUi(address.toString()));
        if (foreground) next.connect();
        else next.pause();
    }

    private synchronized void closeConnection() {
        RemoteCoreConnection current = connection;
        connection = null;
        if (current != null) current.close();
    }

    private void cancelPairRequest() {
        HttpURLConnection request = activePairRequest;
        activePairRequest = null;
        if (request != null) request.disconnect();
    }

    private String readLimited(InputStream input, int maximumBytes) throws Exception {
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[2_048];
            int total = 0;
            int count;
            while ((count = stream.read(buffer)) >= 0) {
                total += count;
                if (total > maximumBytes) throw new IllegalStateException("Response is too large.");
                output.write(buffer, 0, count);
            }
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private byte[] readBytesLimited(InputStream input, int maximumBytes) throws Exception {
        try (ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8_192];
            int total = 0;
            int count;
            while ((count = input.read(buffer)) >= 0) {
                total += count;
                if (total > maximumBytes) throw new IllegalStateException("Card is too large.");
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        }
    }

    private boolean isPng(byte[] bytes) {
        byte[] signature = new byte[] {(byte) 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a};
        if (bytes.length < signature.length) return false;
        for (int index = 0; index < signature.length; index++) if (bytes[index] != signature[index]) return false;
        return true;
    }

    private void emit(String messageJson) {
        if (!ready || closed) return;
        activity.runOnUiThread(() -> {
            if (!closed) webView.evaluateJavascript("window.StageCraftNativeReceive(" + JSONObject.quote(messageJson) + ")", null);
        });
    }

    private String stateMessage(String state) {
        try { return new JSONObject().put("type", "connection.state").put("state", state).toString(); }
        catch (Exception ignored) { return "{}"; }
    }

    private String restoredMessage(String address, boolean allowInsecureHttp) {
        try { return new JSONObject().put("type", "session.restored").put("address", address).put("allowInsecureHttp", allowInsecureHttp).toString(); }
        catch (Exception ignored) { return "{}"; }
    }

    private String authRequiredMessage(String message) {
        try { return new JSONObject().put("type", "auth.required").put("message", message).toString(); }
        catch (Exception ignored) { return "{}"; }
    }

    private String errorMessage(String message) {
        try { return new JSONObject().put("type", "connection.error").put("message", message).toString(); }
        catch (Exception ignored) { return "{}"; }
    }

    private String cardImportErrorMessage() {
        try { return new JSONObject().put("type", "card.import.error").toString(); }
        catch (Exception ignored) { return "{}"; }
    }

    @Override public synchronized void close() {
        if (closed) return;
        closed = true;
        operationGeneration.incrementAndGet();
        fileGeneration.incrementAndGet();
        cancelPairRequest();
        connectionGeneration.incrementAndGet();
        closeConnection();
        compositionOperations.close();
        networkExecutor.shutdownNow();
    }
}
