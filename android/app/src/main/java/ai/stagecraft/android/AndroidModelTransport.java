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

/**
 * Provider transport for local mode. It parses OpenAI-compatible chat completion
 * responses (both `text/event-stream` chunks and plain JSON) and returns only the
 * final Core result. Live reasoning deltas are delivered through {@code onDelta};
 * content is accumulated and returned in the final result (streaming UI reads the
 * room snapshot after notify, so content-per-chunk delivery is not required).
 *
 * The request body is the OpenAI-shaped payload built by the JS transport layer
 * ({@code /v1/chat/completions}: model/messages/stream/response_format/tools).
 */
public final class AndroidModelTransport implements AutoCloseable {
    public interface Listener { void onStreamEvent(String requestId, String payload); void onComplete(JSONObject result); void onError(String requestId, String message); }
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final Set<HttpURLConnection> active = ConcurrentHashMap.newKeySet();
    private final ConcurrentHashMap<String, HttpURLConnection> requests = new ConcurrentHashMap<>();
    private volatile boolean closed;
    public void request(URI endpoint, String apiKey, String requestId, JSONObject request, Listener listener) { executor.execute(() -> run(endpoint, apiKey, requestId, request, listener)); }

    private void run(URI endpoint, String apiKey, String requestId, JSONObject request, Listener listener) {
        HttpURLConnection connection = null;
        try {
            if (closed) return;
            connection = (HttpURLConnection) endpoint.toURL().openConnection();
            active.add(connection);
            requests.put(requestId, connection);
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Accept", "text/event-stream, application/json");
            connection.setRequestProperty("Content-Type", "application/json");
            if (apiKey != null && !apiKey.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + apiKey);
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(0);
            connection.setDoOutput(true);
            byte[] body = request.toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(body.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(body); }
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) {
                InputStream errorStream = connection.getErrorStream();
                String detail = errorStream == null ? "" : read(errorStream, 64 * 1024);
                throw new IllegalStateException("Model request failed: " + status + (detail.isEmpty() ? "" : " - " + detail));
            }
            String type = connection.getContentType() == null ? "" : connection.getContentType().toLowerCase();
            if (type.startsWith("text/event-stream")) consumeSse(connection.getInputStream(), requestId, listener);
            else listener.onComplete(new JSONObject().put("requestId", requestId).put("responseBody", read(connection.getInputStream(), 16 * 1024 * 1024)));
        } catch (Exception error) {
            if (!closed) listener.onError(requestId, error.getMessage() == null ? "Model request failed." : error.getMessage());
        } finally {
            if (connection != null) { active.remove(connection); requests.remove(requestId, connection); connection.disconnect(); }
        }
    }

    /** Only frame SSE here. Model/provider semantics are shared with desktop in TypeScript. */
    private void consumeSse(InputStream input, String requestId, Listener listener) throws Exception {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            String line;
            StringBuilder data = new StringBuilder();
            while ((line = reader.readLine()) != null) {
                if (line.isEmpty()) {
                    if (data.length() == 0) continue;
                    String payload = data.toString();
                    data.setLength(0);
                    listener.onStreamEvent(requestId, payload);
                    if (payload.equals("[DONE]")) break;
                } else if (line.startsWith("data:")) {
                    if (data.length() > 0) data.append('\n');
                    String value = line.substring(5);
                    data.append(value.startsWith(" ") ? value.substring(1) : value);
                }
            }
            if (data.length() > 0) listener.onStreamEvent(requestId, data.toString());
        }
        listener.onComplete(new JSONObject().put("requestId", requestId).put("streamComplete", true));
    }

    private String read(InputStream input, int maximum) throws Exception {
        try (InputStream stream = input) {
            byte[] buffer = new byte[4096];
            StringBuilder result = new StringBuilder();
            int count, total = 0;
            while ((count = stream.read(buffer)) >= 0) {
                total += count;
                if (total > maximum) throw new IllegalStateException("Model response is too large.");
                result.append(new String(buffer, 0, count, StandardCharsets.UTF_8));
            }
            return result.toString();
        }
    }
    public synchronized void cancel(String requestId) {
        if (requestId == null || requestId.isEmpty()) return;
        HttpURLConnection request = requests.remove(requestId);
        if (request != null) { request.disconnect(); return; }
        // R10：request-scoped——未知 requestId 直接 no-op，绝不遍历断开全部 active 连接
        // （否则 transport 兜底取消（api-* ID）会误杀同 Core 其他并发模型请求）。
        // 明确只支持单房间时，也应保证同房间独立后台任务不被未知 ID 误杀。
        return;
    }
    public synchronized void cancelAll() { for (HttpURLConnection connection : active) connection.disconnect(); active.clear(); }
    @Override public synchronized void close() { closed = true; cancelAll(); executor.shutdownNow(); }
}
