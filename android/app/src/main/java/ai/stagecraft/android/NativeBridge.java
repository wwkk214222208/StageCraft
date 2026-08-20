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
    private volatile AndroidHumanPlugin localPlugin;

    public NativeBridge(Activity activity, WebView webView, RemoteSessionStore sessionStore) {
        this.activity = activity;
        this.webView = webView;
        this.sessionStore = sessionStore;
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
        AndroidHumanPlugin local = localPlugin;
        if (local != null) { local.refresh(); return; }
        RemoteCoreConnection current = connection;
        if (current != null) current.refresh();
    }

    @JavascriptInterface public void dispatch(String commandJson) {
        AndroidHumanPlugin local = localPlugin;
        if (local != null) { local.dispatch(commandJson); return; }
        RemoteCoreConnection current = connection;
        if (current != null) current.dispatch(commandJson);
    }

    /** Host integration point for the shared Core runtime. The Android app does not implement domain logic. */
    public synchronized void installLocalCore(LocalCoreConnection.CoreHost host) {
        closeConnection();
        localPlugin = new AndroidHumanPlugin(host, this::emit);
        if (foreground && ready) localPlugin.start();
    }

    @JavascriptInterface public void loadMedia(String path, String requestId) {
        RemoteCoreConnection current = connection;
        if (current != null) current.loadMedia(path, requestId);
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
        sessionStore.clearSession();
        emit(authRequiredMessage("本机会话已清除，请重新配对。"));
    }

    public void onForeground() {
        foreground = true;
        AndroidHumanPlugin local = localPlugin;
        if (local != null) { if (!userDisconnected) local.onForeground(); return; }
        RemoteCoreConnection current = connection;
        if (current != null) {
            if (!userDisconnected) current.resume();
        } else if (ready) {
            restoreAndConnect();
        }
    }

    public void onBackground() {
        foreground = false;
        AndroidHumanPlugin local = localPlugin;
        if (local != null) local.onBackground();
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
                closeConnection();
                emit(authRequiredMessage("会话已过期或被撤销，请重新配对。"));
            }
        });
        connection = next;
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
        AndroidHumanPlugin local = localPlugin;
        localPlugin = null;
        if (local != null) local.close();
        networkExecutor.shutdownNow();
    }
}
