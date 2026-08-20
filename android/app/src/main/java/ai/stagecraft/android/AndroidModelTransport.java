package ai.stagecraft.android;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Provider transport for local mode. It emits deltas but returns only the final Core result. */
public final class AndroidModelTransport implements AutoCloseable {
    public interface Listener { void onDelta(String requestId, String text); void onComplete(JSONObject result); void onError(String requestId, String message); }
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final Set<HttpURLConnection> active = ConcurrentHashMap.newKeySet();
    private volatile boolean closed;
    public void request(URI endpoint, String apiKey, JSONObject request, Listener listener) { executor.execute(() -> run(endpoint, apiKey, request, listener)); }
    private void run(URI endpoint, String apiKey, JSONObject request, Listener listener) { String requestId = request.optString("requestId", "android-model"); HttpURLConnection connection = null; try { if (closed) return; connection = (HttpURLConnection) endpoint.toURL().openConnection(); active.add(connection); connection.setRequestMethod("POST"); connection.setRequestProperty("Accept", "text/event-stream, application/json"); connection.setRequestProperty("Content-Type", "application/json"); if (apiKey != null && !apiKey.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + apiKey); connection.setConnectTimeout(15_000); connection.setReadTimeout(0); connection.setDoOutput(true); byte[] body = request.toString().getBytes(StandardCharsets.UTF_8); connection.setFixedLengthStreamingMode(body.length); try (OutputStream output = connection.getOutputStream()) { output.write(body); } int status = connection.getResponseCode(); if (status < 200 || status >= 300) throw new IllegalStateException("Model request failed: " + status); String type = connection.getContentType() == null ? "" : connection.getContentType().toLowerCase(); if (type.startsWith("text/event-stream")) consumeSse(connection.getInputStream(), requestId, listener); else listener.onComplete(new JSONObject(read(connection.getInputStream(), 8 * 1024 * 1024))); } catch (Exception error) { if (!closed) listener.onError(requestId, error.getMessage() == null ? "Model request failed." : error.getMessage()); } finally { if (connection != null) { active.remove(connection); connection.disconnect(); } } }
    private void consumeSse(InputStream input, String requestId, Listener listener) throws Exception { try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) { String line; StringBuilder data = new StringBuilder(); while ((line = reader.readLine()) != null) { if (line.isEmpty()) { if (data.length() > 0) { String payload = data.toString(); data.setLength(0); if (payload.equals("[DONE]")) return; JSONObject value = new JSONObject(payload); String delta = value.optString("delta", value.optString("text", "")); if (!delta.isEmpty()) listener.onDelta(requestId, delta); if (value.optBoolean("done", false)) { listener.onComplete(value); return; } } } else if (line.startsWith("data:")) data.append(line.substring(5).trim()); } } }
    private String read(InputStream input, int maximum) throws Exception { try (InputStream stream = input) { byte[] buffer = new byte[4096]; StringBuilder result = new StringBuilder(); int count, total = 0; while ((count = stream.read(buffer)) >= 0) { total += count; if (total > maximum) throw new IllegalStateException("Model response is too large."); result.append(new String(buffer, 0, count, StandardCharsets.UTF_8)); } return result.toString(); } }
    public synchronized void cancelAll() { for (HttpURLConnection connection : active) connection.disconnect(); active.clear(); }
    @Override public synchronized void close() { closed = true; cancelAll(); executor.shutdownNow(); }
}
