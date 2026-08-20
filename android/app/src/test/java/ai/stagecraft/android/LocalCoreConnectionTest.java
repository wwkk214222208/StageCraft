package ai.stagecraft.android;

import static org.junit.Assert.*;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;
import org.junit.Test;

public final class LocalCoreConnectionTest {
    @Test public void closeUnsubscribesFromSharedCoreHost() {
        List<LocalCoreConnection.Listener> listeners = new ArrayList<>();
        LocalCoreConnection.CoreHost host = new LocalCoreConnection.CoreHost() {
            public JSONObject view() { return null; }
            public JSONObject dispatch(JSONObject command) { return null; }
            public void subscribe(LocalCoreConnection.Listener listener) { listeners.add(listener); }
            public void unsubscribe(LocalCoreConnection.Listener listener) { listeners.remove(listener); }
            public void reconnect() {}
            public void cancel(String requestId) {}
        };
        LocalCoreConnection connection = new LocalCoreConnection(host, message -> {});
        connection.close();
        assertTrue(listeners.isEmpty());
    }
}
