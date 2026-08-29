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
    public static String stringArg(JSONArray args, int index, int maximum) {
        if (args == null || index < 0 || index >= args.length() || args.isNull(index)) throw new IllegalArgumentException("Missing repository argument " + index + ".");
        String result = args.optString(index, null);
        if (result == null || result.length() > maximum) throw new IllegalArgumentException("Invalid repository argument " + index + ".");
        return result;
    }
    public static JSONObject objectArg(JSONArray args, int index) {
        JSONObject result = args == null || index < 0 || index >= args.length() ? null : args.optJSONObject(index);
        if (result == null) throw new IllegalArgumentException("Invalid repository object argument " + index + ".");
        return result;
    }
    public static JSONArray arrayArg(JSONArray args, int index) {
        JSONArray result = args == null || index < 0 || index >= args.length() ? null : args.optJSONArray(index);
        if (result == null) throw new IllegalArgumentException("Invalid repository array argument " + index + ".");
        return result;
    }
    public static void path(String path) {
        if (path == null || path.isEmpty() || path.length() > 512 || path.startsWith("/") || path.contains("..") || path.indexOf('\\') >= 0 || path.indexOf('\0') >= 0) throw new IllegalArgumentException("Invalid asset path.");
    }

    /**
     * Encodes a native operation result as JSON text for the WebView.
     *
     * The WebView always JSON.parse()s whatever invokeSync returns, so every result must be a
     * complete JSON document. JSONObject/JSONArray already serialize that way, but a bare scalar
     * does not: `String.toString()` emits `turn-42`, which JSON.parse rejects. That is exactly what
     * broke repository methods returning a String (getLatestTurnId, saveWorldChange,
     * approveWorldChange) with "Android bridge response is not valid JSON for stagecraft.repository."
     */
    public static String toJsonText(Object value) {
        if (value == null || value == JSONObject.NULL) return "null";
        if (value instanceof JSONObject || value instanceof JSONArray) return value.toString();
        if (value instanceof Boolean) return value.toString();
        if (value instanceof Byte || value instanceof Short || value instanceof Integer || value instanceof Long) return value.toString();
        if (value instanceof Number) {
            // Non-finite doubles (NaN/Infinity) have no JSON literal; quote them instead of failing.
            try { return JSONObject.numberToString((Number) value); }
            catch (Exception error) { return JSONObject.quote(String.valueOf(value)); }
        }
        return JSONObject.quote(String.valueOf(value));
    }
}
