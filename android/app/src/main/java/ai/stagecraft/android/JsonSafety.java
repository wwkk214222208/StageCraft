package ai.stagecraft.android;

import org.json.JSONArray;
import org.json.JSONObject;

/** Small fail-closed validators for the JavaScript/native boundary. */
public final class JsonSafety {
    private JsonSafety() { }
    public static String requiredString(JSONObject value, String key, int maximum) {
        if (value == null || !value.has(key) || value.isNull(key)) throw new IllegalArgumentException("Missing " + key + ".");
        String result = value.optString(key, null);
        if (result == null || result.isEmpty() || result.length() > maximum) throw new IllegalArgumentException("Invalid " + key + ".");
        return result;
    }
    public static String optionalString(JSONObject value, String key, int maximum) {
        if (value == null || !value.has(key) || value.isNull(key)) return "";
        String result = value.optString(key, null);
        if (result == null || result.length() > maximum) throw new IllegalArgumentException("Invalid " + key + ".");
        return result;
    }
    public static JSONObject requiredObject(JSONObject value, String key) {
        JSONObject result = value == null ? null : value.optJSONObject(key);
        if (result == null) throw new IllegalArgumentException("Missing " + key + ".");
        return result;
    }
    public static JSONArray requiredArray(JSONObject value, String key) {
        JSONArray result = value == null ? null : value.optJSONArray(key);
        if (result == null) throw new IllegalArgumentException("Missing " + key + ".");
        return result;
    }
    public static void path(String path) {
        if (path == null || path.isEmpty() || path.length() > 512 || path.startsWith("/") || path.contains("..") || path.indexOf('\\') >= 0 || path.indexOf('\0') >= 0) throw new IllegalArgumentException("Invalid asset path.");
    }
}
