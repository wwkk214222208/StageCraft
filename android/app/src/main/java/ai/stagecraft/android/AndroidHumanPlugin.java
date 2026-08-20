package ai.stagecraft.android;

import org.json.JSONObject;

/** Android human boundary shared by local and remote renderers. It forwards protocol messages only. */
public final class AndroidHumanPlugin implements AutoCloseable {
    public interface Sink { void onMessage(String messageJson); }
    private final LocalCoreConnection connection;
    private final Sink sink;
    private volatile boolean foreground;

    public AndroidHumanPlugin(LocalCoreConnection.CoreHost host, Sink sink) {
        this.sink = sink;
        this.connection = new LocalCoreConnection(host, sink::onMessage);
    }
    public void start() { foreground = true; connection.connect(); }
    public void onBackground() { foreground = false; connection.pause(); }
    public void onForeground() { foreground = true; connection.resume(); }
    public void refresh() { connection.refresh(); }
    public void dispatch(String commandJson) { connection.dispatch(commandJson); }
    public void cancel(String requestId) { connection.cancel(requestId); }
    public boolean isForeground() { return foreground; }
    public void emitModelDelta(String requestId, String text) { try { sink.onMessage(new JSONObject().put("type", "core.event").put("event", new JSONObject().put("type", "model.thinking.delta").put("requestId", requestId).put("text", text)).toString()); } catch (Exception ignored) { } }
    @Override public void close() { connection.close(); }
}
