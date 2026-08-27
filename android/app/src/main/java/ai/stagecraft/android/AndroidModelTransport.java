package ai.stagecraft.android;

import org.json.JSONArray;
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
    public interface Listener { void onDelta(String requestId, String text); void onComplete(JSONObject result); void onError(String requestId, String message); }
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final Set<HttpURLConnection> active = ConcurrentHashMap.newKeySet();
    private final ConcurrentHashMap<String, HttpURLConnection> requests = new ConcurrentHashMap<>();
    private volatile boolean closed;
    public void request(URI endpoint, String apiKey, JSONObject request, Listener listener) { executor.execute(() -> run(endpoint, apiKey, request, listener)); }

    private void run(URI endpoint, String apiKey, JSONObject request, Listener listener) {
        String requestId = request.optString("requestId", "android-model");
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
            if (status < 200 || status >= 300) throw new IllegalStateException("Model request failed: " + status);
            String type = connection.getContentType() == null ? "" : connection.getContentType().toLowerCase();
            if (type.startsWith("text/event-stream")) consumeSse(connection.getInputStream(), requestId, listener);
            else listener.onComplete(parseCompleteBody(read(connection.getInputStream(), 16 * 1024 * 1024), requestId));
        } catch (Exception error) {
            if (!closed) listener.onError(requestId, error.getMessage() == null ? "Model request failed." : error.getMessage());
        } finally {
            if (connection != null) { active.remove(connection); requests.remove(requestId, connection); connection.disconnect(); }
        }
    }

    /** 解析 OpenAI 兼容 SSE：支持标准 choices[].delta 与旧的最小 {delta,done} 两种格式。 */
    private void consumeSse(InputStream input, String requestId, Listener listener) throws Exception {
        StringBuilder content = new StringBuilder();
        StringBuilder thinking = new StringBuilder();
        JSONObject usage = null;
        boolean finished = false;
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            String line;
            StringBuilder data = new StringBuilder();
            while ((line = reader.readLine()) != null) {
                if (line.isEmpty()) {
                    if (data.length() == 0) continue;
                    String payload = data.toString();
                    data.setLength(0);
                    if (payload.equals("[DONE]")) { finished = true; break; }
                    JSONObject value = new JSONObject(payload);
                    if (value.has("done") || value.has("delta") || value.has("text")) {
                        // 旧最小格式：data: {"delta":"...","done":true}
                        String delta = value.optString("delta", value.optString("text", ""));
                        if (!delta.isEmpty()) content.append(delta);
                        if (value.optBoolean("done", false)) { finished = true; if (value.has("usage")) usage = value.optJSONObject("usage"); break; }
                        continue;
                    }
                    // OpenAI 格式
                    JSONArray choices = value.optJSONArray("choices");
                    if (choices != null && choices.length() > 0) {
                        JSONObject choice = choices.optJSONObject(0);
                        JSONObject delta = choice == null ? null : choice.optJSONObject("delta");
                        if (delta != null) {
                            String reasoning = delta.optString("reasoning_content", "");
                            if (reasoning.isEmpty()) reasoning = delta.optString("reasoning", "");
                            if (!reasoning.isEmpty()) {
                                thinking.append(reasoning);
                                listener.onDelta(requestId, reasoning);
                            }
                            String text = delta.optString("content", "");
                            if (!text.isEmpty()) content.append(text);
                        }
                        if (choice != null && !choice.isNull("finish_reason")) { finished = true; }
                    }
                    if (value.has("usage")) usage = value.optJSONObject("usage");
                } else if (line.startsWith("data:")) {
                    data.append(line.substring(5).trim());
                }
            }
        }
        listener.onComplete(buildResult(requestId, content.toString(), thinking.toString(), usage));
    }

    /** 非流式 JSON：OpenAI 格式 {choices:[{message:{content,reasoning_content}}], usage:{...}}。 */
    private JSONObject parseCompleteBody(String json, String requestId) throws Exception {
        try {
            JSONObject value = new JSONObject(json);
            if (value.has("choices") && !value.has("output")) {
                JSONArray choices = value.optJSONArray("choices");
                JSONObject choice = choices == null || choices.length() == 0 ? null : choices.optJSONObject(0);
                JSONObject message = choice == null ? null : choice.optJSONObject("message");
                String content = message == null ? "" : message.optString("content", "");
                String reasoning = message == null ? "" : message.optString("reasoning_content", message.optString("reasoning", ""));
                return buildResult(requestId, content, reasoning, value.optJSONObject("usage"));
            }
            JSONObject output = new JSONObject();
            output.put("requestId", requestId);
            if (value.has("output")) output.put("output", value.opt("output"));
            if (value.has("thinking")) output.put("thinking", value.opt("thinking"));
            if (value.has("usage")) output.put("usage", value.opt("usage"));
            if (value.has("error")) output.put("error", value.opt("error"));
            return output;
        } catch (Exception error) {
            return new JSONObject().put("requestId", requestId).put("error", "Model response is not valid JSON.");
        }
    }

    private JSONObject buildResult(String requestId, String content, String thinking, JSONObject usage) throws Exception {
        JSONObject result = new JSONObject().put("requestId", requestId);
        if (content != null && !content.isEmpty()) result.put("output", content);
        if (thinking != null && !thinking.isEmpty()) result.put("thinking", thinking);
        if (usage != null) {
            JSONObject normalized = new JSONObject();
            normalized.put("promptTokens", usage.optInt("prompt_tokens", usage.optInt("promptTokens", 0)));
            normalized.put("completionTokens", usage.optInt("completion_tokens", usage.optInt("completionTokens", 0)));
            result.put("usage", normalized);
        }
        return result;
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
        for (HttpURLConnection connection : active) connection.disconnect();
    }
    public synchronized void cancelAll() { for (HttpURLConnection connection : active) connection.disconnect(); active.clear(); }
    @Override public synchronized void close() { closed = true; cancelAll(); executor.shutdownNow(); }
}