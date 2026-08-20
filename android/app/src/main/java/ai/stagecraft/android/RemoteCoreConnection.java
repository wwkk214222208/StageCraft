package ai.stagecraft.android;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

public final class RemoteCoreConnection implements AutoCloseable {
    public interface Listener {
        void onMessage(String messageJson);
        void onUnauthorized();
    }

    private final URI baseAddress;
    private final String credential;
    private final Listener listener;
    private final ConnectionBackoff backoff = new ConnectionBackoff(250, 5_000);
    private final ExecutorService streamExecutor = Executors.newSingleThreadExecutor();
    private final ExecutorService requestExecutor = Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService retryExecutor = Executors.newSingleThreadScheduledExecutor();
    private final Set<HttpURLConnection> activeRequests = ConcurrentHashMap.newKeySet();
    private volatile HttpURLConnection activeStream;
    private volatile long generation;
    private volatile boolean paused;
    private volatile boolean closed;

    public RemoteCoreConnection(URI baseAddress, String credential, Listener listener) {
        this.baseAddress = baseAddress;
        this.credential = credential;
        this.listener = listener;
    }

    public synchronized void connect() {
        if (closed) return;
        paused = false;
        long current = ++generation;
        stopAllConnections();
        streamExecutor.execute(() -> openStream(current, "initial", 0));
    }

    public synchronized void reconnect() {
        if (closed) return;
        emitState("disconnected", 0);
        paused = false;
        long current = ++generation;
        stopAllConnections();
        streamExecutor.execute(() -> openStream(current, "manual", 0));
    }

    public synchronized void pause() {
        if (closed || paused) return;
        paused = true;
        generation++;
        stopAllConnections();
        emitState("disconnected", 0);
    }

    public synchronized void resume() {
        if (closed || !paused) return;
        paused = false;
        long current = ++generation;
        streamExecutor.execute(() -> openStream(current, "reconnect", 0));
    }

    public void refresh() {
        if (closed || paused) return;
        long requestGeneration = generation;
        requestExecutor.execute(() -> {
            try {
                if (!isActive(requestGeneration)) return;
                JSONObject view = requestView(requestGeneration);
                if (isActive(requestGeneration)) emitResync("refresh", view);
            } catch (Unauthorized error) {
                if (isActive(requestGeneration)) listener.onUnauthorized();
            } catch (Exception error) {
                if (isActive(requestGeneration)) emitError();
            }
        });
    }

    /** A command is attempted exactly once; reconnection never replays it. */
    public void dispatch(String commandJson) {
        if (closed || paused) return;
        long requestGeneration = generation;
        requestExecutor.execute(() -> {
            HttpURLConnection connection = null;
            try {
                if (!isActive(requestGeneration)) return;
                new JSONObject(commandJson);
                connection = open("/api/core/commands", "POST", "application/json");
                if (!isActive(requestGeneration)) return;
                byte[] body = commandJson.getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(body.length);
                connection.setDoOutput(true);
                try (OutputStream output = connection.getOutputStream()) { output.write(body); }
                int status = connection.getResponseCode();
                if (status == 401 || status == 403) throw new Unauthorized();
                if (status < 200 || status >= 300) throw new IOException("Command rejected.");
                JSONObject result = new JSONObject(readLimited(connection.getInputStream()));
                JSONObject view = result.optJSONObject("view");
                if (view != null && isActive(requestGeneration)) emitResync("command", view);
            } catch (Unauthorized error) {
                if (isActive(requestGeneration)) listener.onUnauthorized();
            } catch (Exception error) {
                if (isActive(requestGeneration)) emitError();
            } finally {
                release(connection);
            }
        });
    }

    /** Fetches one authenticated raster asset without exposing the session or remote URL to JavaScript. */
    public void loadMedia(String path, String requestId) {
        if (closed || paused || requestId == null || requestId.length() > 96) return;
        final String safePath;
        try { safePath = RemoteAssetPolicy.requireAssetPath(path); }
        catch (IllegalArgumentException error) { emitMediaError(requestId); return; }
        long requestGeneration = generation;
        requestExecutor.execute(() -> {
            HttpURLConnection connection = null;
            try {
                if (!isActive(requestGeneration)) return;
                connection = open(safePath, "GET", "image/png,image/jpeg,image/gif,image/webp");
                int status = connection.getResponseCode();
                if (status == 401 || status == 403) throw new Unauthorized();
                if (status < 200 || status >= 300) throw new IOException("Media request rejected.");
                String mime = RemoteAssetPolicy.requireRasterMime(connection.getContentType());
                long length = connection.getContentLengthLong();
                if (length > RemoteAssetPolicy.MAX_BYTES) throw new IOException("Media is too large.");
                byte[] bytes = readBytesLimited(connection.getInputStream(), RemoteAssetPolicy.MAX_BYTES);
                if (bytes.length == 0) throw new IOException("Media is empty.");
                if (isActive(requestGeneration)) {
                    String dataUrl = "data:" + mime + ";base64," + Base64.getEncoder().encodeToString(bytes);
                    listener.onMessage(new JSONObject().put("type", "media.result").put("requestId", requestId).put("dataUrl", dataUrl).toString());
                }
            } catch (Unauthorized error) {
                if (isActive(requestGeneration)) listener.onUnauthorized();
            } catch (Exception error) {
                if (isActive(requestGeneration)) emitMediaError(requestId);
            } finally {
                release(connection);
            }
        });
    }

    /** Uploads a PNG card exactly once. It is never replayed by reconnect logic. */
    public void importCharacterCard(byte[] pngBytes) {
        if (closed || paused || pngBytes == null || pngBytes.length == 0 || pngBytes.length > 8 * 1024 * 1024) {
            emitCardImport(false);
            return;
        }
        byte[] ownedBytes = pngBytes.clone();
        long requestGeneration = generation;
        requestExecutor.execute(() -> {
            HttpURLConnection connection = null;
            try {
                if (!isActive(requestGeneration)) return;
                JSONObject bodyJson = new JSONObject()
                    .put("filename", "android-card.png")
                    .put("content", Base64.getEncoder().encodeToString(ownedBytes));
                byte[] body = bodyJson.toString().getBytes(StandardCharsets.UTF_8);
                connection = open("/api/st-cards/import", "POST", "application/json");
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setFixedLengthStreamingMode(body.length);
                connection.setDoOutput(true);
                try (OutputStream output = connection.getOutputStream()) { output.write(body); }
                int status = connection.getResponseCode();
                if (status == 401 || status == 403) throw new Unauthorized();
                if (status < 200 || status >= 300) throw new IOException("Card import rejected.");
                readLimited(connection.getInputStream());
                if (!isActive(requestGeneration)) return;
                emitCardImport(true);
                emitResync("card-import", requestView(requestGeneration));
            } catch (Unauthorized error) {
                if (isActive(requestGeneration)) listener.onUnauthorized();
            } catch (Exception error) {
                if (isActive(requestGeneration)) emitCardImport(false);
            } finally {
                release(connection);
            }
        });
    }

    private void openStream(long currentGeneration, String reason, int attempt) {
        if (!isActive(currentGeneration)) return;
        emitState(reason.equals("reconnect") ? "reconnecting" : "connecting", attempt);
        HttpURLConnection connection = null;
        try {
            connection = open("/api/core/events", "GET", "text/event-stream");
            activeStream = connection;
            int status = connection.getResponseCode();
            if (status == 401 || status == 403) throw new Unauthorized();
            if (status < 200 || status >= 300) throw new IOException("Event stream rejected.");
            String contentType = connection.getContentType();
            if (contentType == null || !contentType.toLowerCase().startsWith("text/event-stream")) throw new IOException("Unexpected event stream type.");

            // The SSE response is established before fetching the authoritative view.
            JSONObject view = requestView(currentGeneration);
            if (!isActive(currentGeneration)) return;
            emitState("connected", attempt);
            emitResync(reason, view);

            SseParser parser = new SseParser();
            try (InputStreamReader reader = new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8)) {
                char[] chunk = new char[1_024];
                int count;
                while (isActive(currentGeneration) && (count = reader.read(chunk)) >= 0) {
                    for (String data : parser.accept(new String(chunk, 0, count))) {
                        try {
                            JSONObject event = new JSONObject(data);
                            listener.onMessage(new JSONObject().put("type", "core.event").put("event", event).toString());
                        } catch (Exception ignored) { }
                    }
                }
            }
            if (isActive(currentGeneration)) throw new IOException("Event stream closed.");
        } catch (Unauthorized error) {
            if (isActive(currentGeneration)) listener.onUnauthorized();
        } catch (Exception error) {
            if (isActive(currentGeneration)) scheduleReconnect(currentGeneration, Math.min(attempt + 1, 30));
        } finally {
            release(connection);
            if (activeStream == connection) activeStream = null;
        }
    }

    private void scheduleReconnect(long currentGeneration, int attempt) {
        emitState("reconnecting", attempt);
        retryExecutor.schedule(() -> {
            if (!isActive(currentGeneration)) return;
            streamExecutor.execute(() -> openStream(currentGeneration, "reconnect", attempt));
        }, backoff.delayForAttempt(attempt), TimeUnit.MILLISECONDS);
    }

    private JSONObject requestView(long requestGeneration) throws Exception {
        if (!isActive(requestGeneration)) throw new IOException("Request superseded.");
        HttpURLConnection connection = open("/api/core/view", "GET", "application/json");
        try {
            if (!isActive(requestGeneration)) throw new IOException("Request superseded.");
            int status = connection.getResponseCode();
            if (status == 401 || status == 403) throw new Unauthorized();
            if (status < 200 || status >= 300) throw new IOException("View request rejected.");
            return new JSONObject(readLimited(connection.getInputStream()));
        } finally {
            release(connection);
        }
    }

    private HttpURLConnection open(String path, String method, String accept) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) baseAddress.resolve(path).toURL().openConnection();
        connection.setRequestMethod(method);
        connection.setRequestProperty("Accept", accept);
        connection.setRequestProperty("Authorization", "Bearer " + credential);
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(path.endsWith("/events") ? 0 : 20_000);
        connection.setUseCaches(false);
        connection.setInstanceFollowRedirects(false);
        activeRequests.add(connection);
        return connection;
    }

    private String readLimited(InputStream input) throws IOException {
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4_096];
            int total = 0;
            int count;
            while ((count = stream.read(buffer)) >= 0) {
                total += count;
                if (total > 1_048_576) throw new IOException("Response is too large.");
                output.write(buffer, 0, count);
            }
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private byte[] readBytesLimited(InputStream input, int maximumBytes) throws IOException {
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8_192];
            int total = 0;
            int count;
            while ((count = stream.read(buffer)) >= 0) {
                total += count;
                if (total > maximumBytes) throw new IOException("Response is too large.");
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        }
    }

    private void emitState(String state, int attempt) {
        try {
            listener.onMessage(new JSONObject().put("type", "connection.state").put("state", state).put("attempt", attempt).toString());
        } catch (Exception ignored) { }
    }

    private void emitResync(String reason, JSONObject view) {
        try {
            listener.onMessage(new JSONObject().put("type", "core.resync").put("reason", reason).put("revision", view.optLong("revision", 0)).put("view", view).toString());
        } catch (Exception ignored) { }
    }

    private void emitError() {
        try {
            listener.onMessage(new JSONObject().put("type", "connection.error").put("message", "Network request failed.").toString());
        } catch (Exception ignored) { }
    }

    private void emitMediaError(String requestId) {
        try { listener.onMessage(new JSONObject().put("type", "media.error").put("requestId", requestId).toString()); }
        catch (Exception ignored) { }
    }

    private void emitCardImport(boolean success) {
        try { listener.onMessage(new JSONObject().put("type", success ? "card.imported" : "card.import.error").toString()); }
        catch (Exception ignored) { }
    }

    private boolean isActive(long currentGeneration) {
        return !closed && !paused && generation == currentGeneration;
    }

    private void stopAllConnections() {
        HttpURLConnection connection = activeStream;
        activeStream = null;
        if (connection != null) connection.disconnect();
        for (HttpURLConnection request : activeRequests) request.disconnect();
        activeRequests.clear();
    }

    private void release(HttpURLConnection connection) {
        if (connection == null) return;
        activeRequests.remove(connection);
        connection.disconnect();
    }

    @Override public synchronized void close() {
        if (closed) return;
        closed = true;
        generation++;
        stopAllConnections();
        streamExecutor.shutdownNow();
        requestExecutor.shutdownNow();
        retryExecutor.shutdownNow();
    }

    private static final class Unauthorized extends Exception {}
}
