package ai.stagecraft.android;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.HashSet;
import java.util.Set;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Collections;
import java.util.regex.Pattern;

/** Cold-start v2 plan and recovery state, kept separate from v1 PluginManager. */
public final class V2PlanStore {
    private final File active;
    private final File lastGood;
    private final File recovery;
    private static final int MAX_PLAN_BYTES = 256 * 1024;
    public static final String SUPPORTED_HOST_API_VERSION = "0.1";
    public static final String HOST_LOG_CAPABILITY = "host.log";
    public static final String HOST_STORAGE_CAPABILITY = "host.storage";
    public static final String HOST_SECRETS_CAPABILITY = "host.secrets";
    private static final Set<String> SUPPORTED_HOST_CAPABILITIES = new HashSet<>(java.util.Arrays.asList(HOST_LOG_CAPABILITY, HOST_STORAGE_CAPABILITY, HOST_SECRETS_CAPABILITY));
    private static final Pattern ID = Pattern.compile("^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)+$");
    private static final Pattern VERSION = Pattern.compile("^\\d+\\.\\d+\\.\\d+(?:[-+][\\w.-]+)?$");

    public V2PlanStore(File filesDir) {
        this.active = new File(filesDir, "component-launch-plan.v2.json");
        this.lastGood = new File(filesDir, "component-launch-plan.v2.last-good.json");
        this.recovery = new File(filesDir, "component-launch-plan.v2.recovery.json");
    }
    public V2PlanStore(File active, File lastGood, File recovery) { this.active = active; this.lastGood = lastGood; this.recovery = recovery; }
    public File activeFile() { return active; }
    public synchronized JSONObject readActive() { return read(active); }
    public synchronized JSONObject readLastGood() { return read(lastGood); }
    /** Resolve the cold-start effective plan without executing any component. */
    public static JSONObject resolveEffectivePlan(JSONObject requested, JSONObject lastGood, JSONObject recovery) {
        if (requested == null) return null;
        if (recovery != null && recovery.optBoolean("safeMode", false)) return usableFallback(lastGood, recovery) ? lastGood : null;
        String requestedId = requested.optJSONObject("core") == null ? "" : requested.optJSONObject("core").optString("id");
        if (isQuarantined(recovery, requestedId)) return usableFallback(lastGood, recovery) ? lastGood : null;
        return requested;
    }
    public synchronized JSONObject recoveryState() { JSONObject value = read(recovery); if (value != null) return value; try { return new JSONObject().put("safeMode", false).put("failureCount", new JSONObject()).put("quarantine", new JSONArray()); } catch (Exception error) { return new JSONObject(); } }

    public synchronized void writeActive(JSONObject plan) throws Exception { validatePlan(plan); atomicWrite(active, plan); }
    public synchronized void clearActive() throws Exception { Files.deleteIfExists(active.toPath()); }

    /** Ready is recorded only after the selected Core has completed its handshake. */
    public synchronized void markReady(JSONObject plan) throws Exception {
        validatePlan(plan); atomicWrite(lastGood, plan); JSONObject state = recoveryState(); JSONObject counts = state.optJSONObject("failureCount"); if (counts == null) counts = new JSONObject(); String id = plan.getJSONObject("core").optString("id"); counts.put(id, 0); state.put("failureCount", counts).put("recoveryReason", JSONObject.NULL); atomicWrite(recovery, state);
    }

    /** Renderer/boot failure is sticky; the third failure quarantines that Core. */
    public synchronized JSONObject recordFailure(String coreId, String reason) throws Exception {
        if (coreId == null || coreId.isEmpty()) throw new IllegalArgumentException("core id is required");
        JSONObject state = recoveryState(); JSONObject counts = state.optJSONObject("failureCount"); if (counts == null) counts = new JSONObject(); int count = counts.optInt(coreId, 0) + 1; counts.put(coreId, count); JSONArray quarantine = state.optJSONArray("quarantine"); if (quarantine == null) quarantine = new JSONArray(); if (count >= 3 && !contains(quarantine, coreId)) quarantine.put(new JSONObject().put("coreId", coreId).put("reason", reason == null ? "core_failed" : reason)); state.put("failureCount", counts).put("quarantine", quarantine).put("recoveryReason", reason == null ? "core_failed" : reason); atomicWrite(recovery, state); return new JSONObject(state.toString());
    }

    public synchronized void setSafeMode(boolean enabled) throws Exception { JSONObject state = recoveryState(); state.put("safeMode", enabled); atomicWrite(recovery, state); }
    public synchronized void clearQuarantine(String coreId) throws Exception { JSONObject state = recoveryState(); JSONArray next = new JSONArray(); JSONArray old = state.optJSONArray("quarantine"); if (old != null) for (int i = 0; i < old.length(); i++) { JSONObject item = old.optJSONObject(i); if (item != null && !coreId.equals(item.optString("coreId"))) next.put(item); } state.put("quarantine", next); JSONObject counts = state.optJSONObject("failureCount"); if (counts != null) counts.put(coreId, 0); atomicWrite(recovery, state); }

    public static void validatePlan(JSONObject plan) {
        if (plan == null || !isString(plan, "planVersion") || !"0.1".equals(plan.optString("planVersion")) || !isString(plan, "hostApiVersion") || plan.optString("hostApiVersion").isEmpty()) throw new IllegalArgumentException("invalid v2 plan version or Host API");
        if (!SUPPORTED_HOST_API_VERSION.equals(plan.optString("hostApiVersion"))) throw new IllegalArgumentException("unsupported Android Host API: " + plan.optString("hostApiVersion"));
        JSONObject core = plan.optJSONObject("core"); if (core == null || !validSelection(core)) throw new IllegalArgumentException("v2 plan requires an independent core selection");
        JSONArray plugins = plan.optJSONArray("plugins"); if (plugins == null) throw new IllegalArgumentException("v2 plan plugins must be an array"); Set<String> ids = new HashSet<>(); ids.add(core.optString("id")); for (int i = 0; i < plugins.length(); i++) { JSONObject plugin = plugins.optJSONObject(i); if (plugin == null || !validSelection(plugin)) throw new IllegalArgumentException("plugin selection is invalid"); if (!ids.add(plugin.optString("id"))) throw new IllegalArgumentException("duplicate component id in v2 plan: " + plugin.optString("id")); if (plugin.has("componentTypeCore") && !(plugin.opt("componentTypeCore") instanceof Boolean)) throw new IllegalArgumentException("plugin componentTypeCore must be boolean"); if (plugin.optBoolean("componentTypeCore", false)) throw new IllegalArgumentException("core is not allowed in plugins"); }
        if (plan.has("planHash")) {
            if (!isString(plan, "planHash") || !planHash(plan).equals(plan.optString("planHash"))) throw new IllegalArgumentException("planHash mismatch");
        }
    }

    /** Validate selected package identities and exact manifest hashes before cold boot. */
    public static void validatePlan(JSONObject plan, V2ComponentStore store) throws Exception {
        validatePlan(plan);
        if (store == null) throw new IllegalArgumentException("component store is required");
        JSONObject coreSelection = plan.getJSONObject("core"); JSONObject core = store.read(coreSelection.getString("id"), coreSelection.getString("version"));
        if (!"core".equals(core.optString("componentType"))) throw new IllegalArgumentException("core selection does not point to a Core manifest");
        if (core.optJSONObject("hostApi") == null || !plan.optString("hostApiVersion").equals(core.optJSONObject("hostApi").optString("version"))) throw new IllegalArgumentException("Core Host API does not match plan");
        if (!manifestHash(core).equals(coreSelection.optString("manifestHash"))) throw new IllegalArgumentException("Core manifestHash mismatch");
        validateRequiredCapabilities(core);
        JSONArray plugins = plan.getJSONArray("plugins"); JSONArray pluginManifests = new JSONArray(); for (int i = 0; i < plugins.length(); i++) { JSONObject selection = plugins.getJSONObject(i); JSONObject plugin = store.read(selection.getString("id"), selection.getString("version")); if (!"plugin".equals(plugin.optString("componentType"))) throw new IllegalArgumentException("Core is not allowed in plugins"); if (!manifestHash(plugin).equals(selection.optString("manifestHash"))) throw new IllegalArgumentException("plugin manifestHash mismatch"); if (plugin.optJSONObject("hostApi") != null && !plan.optString("hostApiVersion").equals(plugin.optJSONObject("hostApi").optString("version"))) throw new IllegalArgumentException("plugin Host API does not match plan"); pluginManifests.put(plugin); }
        for (int i = 0; i < pluginManifests.length(); i++) validateRequiredCapabilities(pluginManifests.getJSONObject(i));
        validateCorePluginCompatibility(core, pluginManifests);
    }

    private static boolean validSelection(JSONObject selection) {
        return isString(selection, "id") && ID.matcher(selection.optString("id")).matches()
            && isString(selection, "version") && VERSION.matcher(selection.optString("version")).matches()
            && isString(selection, "manifestHash") && !selection.optString("manifestHash").isEmpty();
    }

    private static boolean isString(JSONObject value, String key) { return value != null && value.opt(key) instanceof String; }

    /** Android HostPort grants the negotiated diagnostic logging and per-component storage capabilities. */
    private static void validateRequiredCapabilities(JSONObject manifest) {
        JSONObject capabilities = manifest.optJSONObject("capabilities"); if (capabilities == null || !capabilities.has("required")) return;
        Object raw = capabilities.opt("required"); if (!(raw instanceof JSONArray)) throw new IllegalArgumentException("capabilities.required must be an array");
        JSONArray required = (JSONArray) raw; for (int i = 0; i < required.length(); i++) { Object item = required.opt(i); if (!(item instanceof String) || !SUPPORTED_HOST_CAPABILITIES.contains(item)) throw new IllegalArgumentException("Android Host does not provide required capability: " + String.valueOf(item)); }
    }

    /** Pure plan mutation seam used by NativeBridge and JVM tests. */
    public static JSONObject setPluginEnabled(JSONObject activePlan, JSONObject pluginManifest, boolean enabled) throws Exception {
        if (activePlan == null) throw new IllegalArgumentException("an active external Core plan is required");
        validatePlan(activePlan);
        if (pluginManifest == null || !"plugin".equals(pluginManifest.optString("componentType"))) throw new IllegalArgumentException("selected component is not a plugin");
        String id = pluginManifest.getString("id"); String version = pluginManifest.getString("version");
        ArrayList<JSONObject> selections = new ArrayList<>(); JSONArray existing = activePlan.getJSONArray("plugins");
        for (int i = 0; i < existing.length(); i++) { JSONObject item = existing.getJSONObject(i); if (!id.equals(item.optString("id"))) selections.add(new JSONObject(item.toString())); }
        if (enabled) selections.add(new JSONObject().put("id", id).put("version", version).put("manifestHash", manifestHash(pluginManifest)));
        selections.sort(Comparator.comparing(item -> item.optString("id") + "@" + item.optString("version")));
        JSONObject next = new JSONObject(activePlan.toString()).put("plugins", new JSONArray(selections));
        return refreshPlanHash(next);
    }

    /** Switch Core while retaining current plugin selections for full validation by the caller. */
    public static JSONObject selectCore(JSONObject activePlan, JSONObject coreManifest) throws Exception {
        if (coreManifest == null || !"core".equals(coreManifest.optString("componentType"))) throw new IllegalArgumentException("selected component is not a Core");
        JSONObject hostApi = coreManifest.optJSONObject("hostApi"); if (hostApi == null || hostApi.optString("version").isEmpty()) throw new IllegalArgumentException("selected Core has no Host API");
        JSONArray plugins = activePlan == null ? new JSONArray() : new JSONArray(activePlan.getJSONArray("plugins").toString());
        JSONObject next = new JSONObject().put("planVersion", "0.1").put("hostApiVersion", hostApi.getString("version"))
            .put("core", new JSONObject().put("id", coreManifest.getString("id")).put("version", coreManifest.getString("version")).put("manifestHash", manifestHash(coreManifest)))
            .put("plugins", plugins).put("stateSchemaVersion", activePlan == null ? "unknown" : activePlan.optString("stateSchemaVersion", "unknown"));
        return refreshPlanHash(next);
    }

    public static void validateCorePluginCompatibility(JSONObject core, JSONArray plugins) {
        String provided = core.optJSONObject("coreApi") == null ? "" : core.optJSONObject("coreApi").optString("version");
        for (int i = 0; i < plugins.length(); i++) { JSONObject plugin = plugins.optJSONObject(i); if (plugin == null) continue; JSONObject requiredApi = plugin.optJSONObject("coreApi"); String required = requiredApi == null ? "" : requiredApi.optString("version"); if (!required.isEmpty() && !required.equals(provided)) throw new IllegalArgumentException("plugin " + plugin.optString("id") + " requires Core API " + required + " but selected Core provides " + (provided.isEmpty() ? "none" : provided)); }
    }

    private static JSONObject refreshPlanHash(JSONObject plan) throws Exception { JSONObject copy = new JSONObject(plan.toString()); copy.remove("planHash"); return copy.put("planHash", planHash(copy)); }

    /** Plan identity contract shared with src/v2/launch-plan.ts. */
    public static String planHash(JSONObject plan) {
        JSONObject identity = new JSONObject();
        try {
            identity.put("planVersion", plan.opt("planVersion"));
            identity.put("hostApiVersion", plan.opt("hostApiVersion"));
            identity.put("core", plan.opt("core"));
            identity.put("plugins", plan.opt("plugins"));
            identity.put("stateSchemaVersion", plan.opt("stateSchemaVersion"));
        } catch (Exception error) { throw new IllegalArgumentException("invalid plan identity", error); }
        return manifestHash(identity);
    }

    /** Same provisional FNV/stable JSON identity used by the TypeScript M3 contract. */
    public static String manifestHash(JSONObject manifest) { String value = stableStringify(manifest); int hash = 0x811c9dc5; for (int i = 0; i < value.length(); i++) { hash ^= value.charAt(i); hash *= 0x01000193; } return String.format("%08x", hash); }
    private static String stableStringify(Object value) { if (value == JSONObject.NULL || value == null) return "null"; if (value instanceof JSONObject object) { java.util.List<String> keys = new java.util.ArrayList<>(); java.util.Iterator<String> iterator = object.keys(); while (iterator.hasNext()) keys.add(iterator.next()); java.util.Collections.sort(keys); StringBuilder out = new StringBuilder("{"); for (String key : keys) { if (out.length() > 1) out.append(','); out.append(JSONObject.quote(key)).append(':').append(stableStringify(object.opt(key))); } return out.append('}').toString(); } if (value instanceof JSONArray array) { StringBuilder out = new StringBuilder("["); for (int i = 0; i < array.length(); i++) { if (i > 0) out.append(','); out.append(stableStringify(array.opt(i))); } return out.append(']').toString(); } if (value instanceof String) return JSONObject.quote((String) value); return String.valueOf(value); }

    private static boolean contains(JSONArray values, String coreId) { for (int i = 0; i < values.length(); i++) if (coreId.equals(values.optJSONObject(i) == null ? "" : values.optJSONObject(i).optString("coreId"))) return true; return false; }
    private static boolean usableFallback(JSONObject plan, JSONObject recovery) { if (plan == null) return false; JSONObject core = plan.optJSONObject("core"); return core != null && !isQuarantined(recovery, core.optString("id")); }
    private static boolean isQuarantined(JSONObject recovery, String coreId) { if (recovery == null || coreId == null || coreId.isEmpty()) return false; JSONArray values = recovery.optJSONArray("quarantine"); if (values == null) return false; return contains(values, coreId); }
    private static JSONObject read(File file) { try { if (!file.isFile() || file.length() > MAX_PLAN_BYTES) return null; return new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8)); } catch (Exception error) { return null; } }
    private static void atomicWrite(File file, JSONObject value) throws Exception { File parent = file.getParentFile(); if (parent != null) parent.mkdirs(); File temporary = new File(file.getPath() + ".tmp"); Files.write(temporary.toPath(), (value.toString() + "\n").getBytes(StandardCharsets.UTF_8)); try { Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); } catch (java.nio.file.AtomicMoveNotSupportedException ignored) { Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING); } }
}
