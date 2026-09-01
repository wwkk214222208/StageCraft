package ai.stagecraft.android;

import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;

/** JVM coverage for the v2 rescue health identity seam. */
public final class CoreServiceHealthTest {
    @Test public void missingSelectedPlanReportsBundledRescue() throws Exception {
        JSONObject requested = new JSONObject()
            .put("core", new JSONObject().put("id", "com.example.external").put("version", "1.0.0"));

        JSONObject health = CoreService.buildV2HealthIdentity(requested, null, null);

        assertEquals("com.example.external", health.getJSONObject("requestedCore").getString("id"));
        assertEquals("bundled-rescue", health.getString("effectiveCore"));
        assertEquals("unknown", health.getString("coreBundleVersion"));
        assertEquals("", health.getString("coreBundleHash"));
    }
}
