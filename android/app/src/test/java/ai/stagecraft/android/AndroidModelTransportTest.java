package ai.stagecraft.android;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.lang.reflect.Field;
import java.net.HttpURLConnection;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * R11：AndroidModelTransport request-scoped 取消行为测试。
 *
 * 验证：
 * 1. cancel(已知 requestId) 只断开该请求，其他 active 请求存活；
 * 2. cancel(未知 requestId) 直接 no-op（不误杀任何 active 请求）；
 * 3. cancelAll 全量断开（保留语义）。
 *
 * 纯 JVM：不发起真实 HTTP，用反射注入假 HttpURLConnection 到 requests/active 表。
 */
public final class AndroidModelTransportTest {

    /** 假 HttpURLConnection：记录 disconnect 调用。 */
    private static final class FakeConnection extends HttpURLConnection {
        boolean disconnected = false;
        FakeConnection() {
            super(fakeUrl());
        }
        private static java.net.URL fakeUrl() {
            try { return new java.net.URL("http://127.0.0.1:1"); }
            catch (java.net.MalformedURLException error) { throw new IllegalStateException(error); }
        }
        @Override public void disconnect() { disconnected = true; }
        @Override public void connect() throws java.io.IOException { }
        @Override public boolean usingProxy() { return false; }
        @Override public void setChunkedStreamingMode(int chunklen) { }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, HttpURLConnection> requestsMap(AndroidModelTransport transport) throws Exception {
        Field field = AndroidModelTransport.class.getDeclaredField("requests");
        field.setAccessible(true);
        return (Map<String, HttpURLConnection>) field.get(transport);
    }

    @SuppressWarnings("unchecked")
    private static java.util.Set<HttpURLConnection> activeSet(AndroidModelTransport transport) throws Exception {
        Field field = AndroidModelTransport.class.getDeclaredField("active");
        field.setAccessible(true);
        return (java.util.Set<HttpURLConnection>) field.get(transport);
    }

    @Test public void cancelKnownRequestOnlyDisconnectsIt() throws Exception {
        AndroidModelTransport transport = new AndroidModelTransport();
        FakeConnection first = new FakeConnection();
        FakeConnection second = new FakeConnection();
        Map<String, HttpURLConnection> requests = requestsMap(transport);
        java.util.Set<HttpURLConnection> active = activeSet(transport);
        requests.put("req-1", first);
        requests.put("req-2", second);
        active.add(first);
        active.add(second);
        // 取消 req-1：只有 first 断开，second 存活
        transport.cancel("req-1");
        assertTrue("已知 requestId 必须断开对应连接", first.disconnected);
        assertFalse("其他请求必须存活（request-scoped）", second.disconnected);
        assertTrue("被取消请求必须从表移除", !requests.containsKey("req-1"));
        assertTrue("另一请求仍在表", requests.containsKey("req-2"));
    }

    @Test public void cancelUnknownRequestIsNoop() throws Exception {
        AndroidModelTransport transport = new AndroidModelTransport();
        FakeConnection active = new FakeConnection();
        java.util.Set<HttpURLConnection> activeSet = activeSet(transport);
        activeSet.add(active);
        // 未知 requestId（如 transport 兜底的 api-* ID）：no-op，不误杀 active
        transport.cancel("api-unknown-123");
        assertFalse("未知 requestId 不得断开任何连接（no-op）", active.disconnected);
    }

    @Test public void cancelAllDisconnectsEverything() throws Exception {
        AndroidModelTransport transport = new AndroidModelTransport();
        FakeConnection first = new FakeConnection();
        FakeConnection second = new FakeConnection();
        java.util.Set<HttpURLConnection> activeSet = activeSet(transport);
        activeSet.add(first);
        activeSet.add(second);
        transport.cancelAll();
        assertTrue("cancelAll 必须断开全部", first.disconnected && second.disconnected);
        assertTrue("cancelAll 必须清空 active", activeSet.isEmpty());
    }
}
