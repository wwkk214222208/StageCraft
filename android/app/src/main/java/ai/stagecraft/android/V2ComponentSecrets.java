package ai.stagecraft.android;

import org.json.JSONObject;
import java.util.regex.Pattern;

/** Keystore-backed v2 Host secret port. Values are namespaced by component. */
public final class V2ComponentSecrets {
    public static final String SECRETS_CAPABILITY = "host.secrets";
    private static final Pattern ID = Pattern.compile("^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)+$");
    private static final Pattern VERSION = Pattern.compile("^\\d+\\.\\d+\\.\\d+(?:[-+][\\w.-]+)?$");
    private static final Pattern KEY = Pattern.compile("^[A-Za-z][A-Za-z0-9._:-]{0,255}$");
    private final AndroidSecretStore store;
    private final V2ComponentStore components;

    public V2ComponentSecrets(AndroidSecretStore store, V2ComponentStore components) {
        this.store = store;
        this.components = components;
    }

    public JSONObject get(JSONObject input) throws Exception {
        String key = checkedKey(input);
        String value = store.get(namespaced(input, key));
        return new JSONObject().put("ok", true).put("found", value != null).put("value", value == null ? JSONObject.NULL : value);
    }

    public JSONObject has(JSONObject input) throws Exception {
        String key = checkedKey(input);
        return new JSONObject().put("ok", true).put("found", store.get(namespaced(input, key)) != null);
    }

    public JSONObject set(JSONObject input) throws Exception {
        String key = checkedKey(input);
        Object raw = input == null ? null : input.opt("value");
        if (!(raw instanceof String) || ((String) raw).length() > 1024 * 1024) throw new IllegalArgumentException("secret value must be a bounded string");
        store.set(namespaced(input, key), (String) raw);
        return new JSONObject().put("ok", true);
    }

    public JSONObject delete(JSONObject input) throws Exception {
        String key = checkedKey(input);
        store.remove(namespaced(input, key));
        return new JSONObject().put("ok", true);
    }

    private String checkedKey(JSONObject input) throws Exception {
        if (input == null) throw new IllegalArgumentException("secret input is required");
        String key = input.optString("key", "");
        if (!KEY.matcher(key).matches()) throw new IllegalArgumentException("secret key is invalid");
        checkedCaller(input);
        return key;
    }

    private String namespaced(JSONObject input, String key) throws Exception {
        JSONObject caller = input.getJSONObject("caller");
        return "v2/" + caller.getString("pluginId") + "/" + caller.getString("version") + "/" + key;
    }

    private void checkedCaller(JSONObject input) throws Exception {
        JSONObject caller = input.optJSONObject("caller");
        if (caller == null) throw new IllegalArgumentException("secret caller identity is required");
        String id = caller.optString("pluginId", ""), version = caller.optString("version", "");
        if (!ID.matcher(id).matches() || !VERSION.matcher(version).matches()) throw new IllegalArgumentException("secret caller identity is invalid");
        if (components == null) throw new IllegalStateException("component store is not ready");
        JSONObject manifest = components.read(id, version);
        if (!manifestHasCapability(manifest)) throw new IllegalArgumentException("host.secrets capability is not declared by " + id + "@" + version);
    }

    static boolean manifestHasCapability(JSONObject manifest) {
        JSONObject caps = manifest == null ? null : manifest.optJSONObject("capabilities");
        if (caps == null) return false;
        for (String kind : new String[]{"required", "optional"}) {
            org.json.JSONArray list = caps.optJSONArray(kind);
            if (list == null) continue;
            for (int i = 0; i < list.length(); i++) if (SECRETS_CAPABILITY.equals(list.optString(i))) return true;
        }
        return false;
    }
}
