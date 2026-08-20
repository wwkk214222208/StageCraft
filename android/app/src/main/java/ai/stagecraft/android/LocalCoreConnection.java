package ai.stagecraft.android;

import org.json.JSONObject;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/** In-process transport. The host is the shared Core runtime, never a second Android business layer. */
public final class LocalCoreConnection implements AutoCloseable {
    public interface CoreHost {
        JSONObject view() throws Exception;
        JSONObject dispatch(JSONObject command) throws Exception;
        void subscribe(Listener listener);
        void unsubscribe(Listener listener);
        void reconnect() throws Exception;
        void cancel(String requestId) throws Exception;
    }
    public interface Listener { void onEvent(JSONObject event); }
    public interface ListenerSink { void onMessage(String messageJson); }
    private final CoreHost host;
    private final ListenerSink sink;
    private final Set<Listener> subscriptions = ConcurrentHashMap.newKeySet();
    private volatile boolean closed;
    public LocalCoreConnection(CoreHost host, ListenerSink sink) {
        this.host = Objects.requireNonNull(host, "A shared Core runtime host is required for local mode.");
        this.sink = Objects.requireNonNull(sink, "A listener sink is required.");
    }
    public synchronized void connect() {
        if (closed) return;
        if (subscriptions.isEmpty()) { Listener listener = event -> emit(messageWithEvent(event)); subscriptions.add(listener); host.subscribe(listener); }
        try { emit(message("connection.state", "state", "connected")); emitResync("initial", host.view()); } catch (Exception error) { emitError(error); }
    }
    public void reconnect() { if (closed) return; try { host.reconnect(); emitResync("reconnect", host.view()); } catch (Exception error) { emitError(error); } }
    public void refresh() { if (closed) return; try { emitResync("refresh", host.view()); } catch (Exception error) { emitError(error); } }
    public void dispatch(String commandJson) { if (closed) return; try { JSONObject result = host.dispatch(new JSONObject(commandJson)); JSONObject view = result.optJSONObject("view"); if (view != null) emitResync("command", view); } catch (Exception error) { emitError(error); } }
    public void cancel(String requestId) { try { host.cancel(requestId); } catch (Exception error) { emitError(error); } }
    public void pause() { if (!closed) emit(message("connection.state", "state", "disconnected")); }
    public void resume() { connect(); }
    private JSONObject message(String type, String key, String value) { try { return new JSONObject().put("type", type).put(key, value); } catch (Exception error) { return new JSONObject(); } }
    private JSONObject messageWithEvent(JSONObject event) { try { return new JSONObject().put("type", "core.event").put("event", event); } catch (Exception error) { return new JSONObject(); } }
    private void emitResync(String reason, JSONObject view) { try { emit(new JSONObject().put("type", "core.resync").put("reason", reason).put("revision", view.optLong("revision", 0)).put("view", view)); } catch (Exception ignored) { } }
    private void emitError(Exception error) { try { emit(new JSONObject().put("type", "connection.error").put("message", error.getMessage() == null ? "Local Core request failed." : error.getMessage())); } catch (Exception ignored) { } }
    private void emit(JSONObject message) { if (!closed) sink.onMessage(message.toString()); }
    @Override public synchronized void close() { if (closed) return; closed = true; for (Listener listener : subscriptions) host.unsubscribe(listener); subscriptions.clear(); }
}
