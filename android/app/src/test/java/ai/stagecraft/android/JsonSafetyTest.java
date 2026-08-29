package ai.stagecraft.android;

import static org.junit.Assert.*;

import org.json.JSONObject;
import org.junit.Test;

/**
 * The WebView JSON.parse()s every invokeSync result, so the bridge must never emit a bare scalar.
 * Repository methods that return a String (getLatestTurnId, saveWorldChange, approveWorldChange)
 * used to arrive unquoted and fail with "Android bridge response is not valid JSON".
 */
public final class JsonSafetyTest {

    private static void assertParsesAs(String expected, Object value) {
        String text = JsonSafety.toJsonText(value);
        Object parsed;
        try { parsed = new org.json.JSONTokener(text).nextValue(); }
        catch (Exception error) { fail("not valid JSON: " + text); return; }
        assertEquals(expected, String.valueOf(parsed));
    }

    @Test public void stringResultsAreQuotedSoTheWebViewCanParseThem() {
        assertEquals("\"turn-42\"", JsonSafety.toJsonText("turn-42"));
        assertEquals("\"world-change-1712\"", JsonSafety.toJsonText("world-change-1712"));
        assertEquals("\"\"", JsonSafety.toJsonText(""));
        // Quotes/newlines inside the value must stay escaped.
        assertEquals("\"a\\\"b\\nc\"", JsonSafety.toJsonText("a\"b\nc"));
    }

    @Test public void nullAndJsonNullBecomeJsonNull() {
        assertEquals("null", JsonSafety.toJsonText(null));
        assertEquals("null", JsonSafety.toJsonText(JSONObject.NULL));
    }

    @Test public void objectsArraysBooleansAndNumbersPassThroughAsJson() throws Exception {
        assertEquals("{\"ok\":true}", JsonSafety.toJsonText(new JSONObject().put("ok", true)));
        assertEquals("[\"a\",\"b\"]", JsonSafety.toJsonText(new org.json.JSONArray().put("a").put("b")));
        assertEquals("true", JsonSafety.toJsonText(Boolean.TRUE));
        assertEquals("false", JsonSafety.toJsonText(Boolean.FALSE));
        assertEquals("7", JsonSafety.toJsonText(7));
        assertEquals("7", JsonSafety.toJsonText(7L));
        assertEquals("1.5", JsonSafety.toJsonText(1.5d));
    }

    @Test public void nonFiniteNumbersAreQuotedInsteadOfThrowing() {
        // org.json's numberToString rejects NaN/Infinity; the bridge must degrade to a quoted string
        // rather than letting the exception escape and turn into a generic "Native operation failed."
        assertParsesAs("NaN", Double.NaN);
        assertParsesAs("Infinity", Double.POSITIVE_INFINITY);
    }

    /** The regression itself: a repository String result must survive a JSON.parse round-trip. */
    @Test public void repositoryStringResultsRoundTripThroughTheWebViewContract() {
        assertParsesAs("turn-42", "turn-42");
        assertParsesAs("world-change-9", "world-change-9");
    }
}
