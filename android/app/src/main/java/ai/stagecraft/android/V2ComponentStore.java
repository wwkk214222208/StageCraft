package ai.stagecraft.android;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Small private-file v2 component store. Archives are user-trusted code, not
 * signed packages: validation is intended to prevent accidental escapes and
 * unsupported native/Node payloads, not to provide a sandbox or signature.
 */
public final class V2ComponentStore {
    public static final long MAX_ARCHIVE_BYTES = 32L * 1024 * 1024;
    public static final long MAX_TOTAL_BYTES = 64L * 1024 * 1024;
    public static final long MAX_FILE_BYTES = 16L * 1024 * 1024;
    public static final int MAX_FILES = 64;
    private static final Pattern ID = Pattern.compile("^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)+$");
    private static final Pattern VERSION = Pattern.compile("^\\d+\\.\\d+\\.\\d+(?:[-+][\\w.-]+)?$");
    private static final Pattern API_VERSION = Pattern.compile("^\\d+\\.\\d+(?:\\.\\d+)?$");
    private static final Pattern HASH = Pattern.compile("^sha256-[0-9a-fA-F]{64}$");
    private static final Pattern MODULE_LOAD = Pattern.compile("(?:\\bimport\\s*(?:(?:[^'\"]|\\r|\\n)*?\\sfrom\\s*)?['\"][^'\"]+['\"]|\\bexport\\s+(?:(?:[^'\"]|\\r|\\n)*?\\sfrom\\s*)['\"][^'\"]+['\"]|\\bimport\\s*\\()", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    /* Keep native suffixes token-bounded: e.g. a browser object's `node` field
       or an identifier containing "node" is not a native artifact reference. */
    private static final Pattern FORBIDDEN = Pattern.compile("(?:\\bnode:|\\brequire\\s*\\(|\\bmodule\\.exports\\b|\\bexports\\.[A-Za-z_$]|\\bprocess\\.[A-Za-z_$]|\\bDeno\\.[A-Za-z_$]|\\.(?:so|dll|dylib|node|dex)(?=$|[?#'\\\"\\s/])|\\b(?:Termux|Java|Kotlin|Dex)\\b)", Pattern.CASE_INSENSITIVE);

    private final File root;
    private final Set<String> bundled = new HashSet<>();

    public V2ComponentStore(File filesDir) { this(new File(filesDir, "components"), true); }
    public V2ComponentStore(File root, boolean directRoot) { this.root = root; }
    public File root() { return root; }

    /** Mark an APK-provided rescue/default package as non-removable. */
    public void markBundled(String id, String version) { bundled.add(key(id, version)); }

    public synchronized JSONObject install(InputStream input) throws Exception {
        if (input == null) throw new IllegalArgumentException("component archive is required");
        byte[] archive = readLimited(input, MAX_ARCHIVE_BYTES);
        LinkedHashMap<String, byte[]> entries = new LinkedHashMap<>();
        long total = 0;
        try (ZipInputStream zip = new ZipInputStream(new ByteArrayInputStream(archive))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                if (entry.isDirectory()) continue;
                String name = entry.getName();
                validatePath(name);
                if (entries.containsKey(name) || entries.size() >= MAX_FILES) throw new IllegalArgumentException("duplicate or too many archive entries");
                byte[] data = readLimited(zip, MAX_FILE_BYTES);
                total += data.length;
                if (total > MAX_TOTAL_BYTES) throw new IllegalArgumentException("component archive expands beyond limit");
                entries.put(name, data);
            }
        }
        byte[] manifestBytes = entries.get("manifest.json");
        if (manifestBytes == null) throw new IllegalArgumentException("component archive must contain root manifest.json");
        JSONObject manifest = new JSONObject(new String(manifestBytes, StandardCharsets.UTF_8));
        validateManifest(manifest);
        String runtime = manifest.getJSONObject("entrypoints").getString("runtime");
        validateEntry(entries, manifest, runtime, "runtime", true);
        JSONObject entrypoints = manifest.getJSONObject("entrypoints");
        if (entrypoints.has("ui")) validateEntry(entries, manifest, entrypoints.getString("ui"), "ui", false);
        for (String name : entries.keySet()) if (!name.equals("manifest.json") && !name.equals("stagecraft.plugin.json") && !name.equals(runtime) && !(entrypoints.has("ui") && name.equals(entrypoints.getString("ui")))) throw new IllegalArgumentException("archive contains unreferenced file: " + name);

        File destination = new File(root, manifest.getString("id") + File.separator + manifest.getString("version"));
        ensureContained(root, destination);
        if (destination.exists()) throw new IllegalArgumentException("component version is already installed");
        File temporary = new File(root, ".install-" + System.nanoTime());
        try {
            if (!temporary.mkdirs()) throw new IllegalStateException("cannot create component staging directory");
            for (java.util.Map.Entry<String, byte[]> item : entries.entrySet()) {
                File target = new File(temporary, item.getKey()); ensureContained(temporary, target);
                File parent = target.getParentFile(); if (parent != null && !parent.exists() && !parent.mkdirs()) throw new IllegalStateException("cannot create component directory");
                Files.write(target.toPath(), item.getValue());
            }
            File parent = destination.getParentFile(); if (parent != null) parent.mkdirs();
            try { Files.move(temporary.toPath(), destination.toPath(), StandardCopyOption.ATOMIC_MOVE); }
            catch (java.nio.file.AtomicMoveNotSupportedException ignored) { Files.move(temporary.toPath(), destination.toPath()); }
        } finally { deleteTree(temporary.toPath()); }
        return new JSONObject(manifest.toString()).put("origin", "local");
    }

    public synchronized JSONObject read(String id, String version) throws Exception {
        File dir = componentDir(id, version); File file = new File(dir, "manifest.json");
        if (!file.isFile()) throw new IllegalArgumentException("component manifest is missing");
        ensureContained(dir, file);
        byte[] manifestBytes; try (FileInputStream input = new FileInputStream(file)) { manifestBytes = readLimited(input, MAX_FILE_BYTES); }
        JSONObject manifest = new JSONObject(new String(manifestBytes, StandardCharsets.UTF_8));
        if (!id.equals(manifest.optString("id")) || !version.equals(manifest.optString("version"))) throw new IllegalArgumentException("installed manifest identity mismatch");
        validateInstalledPackage(dir, manifest);
        return manifest;
    }

    public synchronized List<JSONObject> list() {
        List<JSONObject> result = new ArrayList<>();
        if (!root.isDirectory()) return result;
        File[] ids = root.listFiles(File::isDirectory); if (ids == null) return result;
        for (File id : ids) { File[] versions = id.listFiles(File::isDirectory); if (versions == null) continue; for (File version : versions) try { result.add(read(id.getName(), version.getName())); } catch (Exception ignored) { } }
        result.sort(Comparator.comparing(item -> item.optString("id") + "@" + item.optString("version")));
        return result;
    }

    public synchronized void delete(String id, String version) throws Exception {
        if (bundled.contains(key(id, version))) throw new IllegalArgumentException("bundled component cannot be deleted");
        File dir = componentDir(id, version); if (!dir.exists()) return; deleteTree(dir.toPath());
    }

    private File componentDir(String id, String version) throws Exception {
        if (id == null || version == null || !ID.matcher(id).matches() || !VERSION.matcher(version).matches()) throw new IllegalArgumentException("invalid component identity");
        File dir = new File(new File(root, id), version); ensureContained(root, dir); return dir;
    }

    private static void validateManifest(JSONObject manifest) {
        if (manifest == null || !isString(manifest, "schemaVersion") || !"0.1".equals(manifest.optString("schemaVersion"))
            || !isString(manifest, "id") || !ID.matcher(manifest.optString("id")).matches()
            || !isString(manifest, "version") || !VERSION.matcher(manifest.optString("version")).matches()
            || !isString(manifest, "title") || manifest.optString("title").trim().isEmpty()) throw new IllegalArgumentException("invalid component manifest identity");
        if (!isString(manifest, "componentType")) throw new IllegalArgumentException("invalid componentType");
        String type = manifest.optString("componentType");
        if (!"core".equals(type) && !"plugin".equals(type)) throw new IllegalArgumentException("invalid componentType");
        if ("core".equals(type) && manifest.has("pluginCategory")) throw new IllegalArgumentException("core must not declare pluginCategory");
        if ("plugin".equals(type) && (!isString(manifest, "pluginCategory") || !isPluginCategory(manifest.optString("pluginCategory")))) throw new IllegalArgumentException("pluginCategory is invalid");

        JSONObject entrypoints = objectOrNull(manifest, "entrypoints");
        if (entrypoints == null || !isString(entrypoints, "runtime") || entrypoints.optString("runtime").trim().isEmpty()) throw new IllegalArgumentException("runtime entry is required");
        validateEntryPath(entrypoints.optString("runtime"), "runtime");
        if (entrypoints.has("ui")) {
            if (!isString(entrypoints, "ui") || entrypoints.optString("ui").trim().isEmpty()) throw new IllegalArgumentException("ui entry is invalid");
            if (entrypoints.optString("runtime").equals(entrypoints.optString("ui"))) throw new IllegalArgumentException("runtime and ui entries must differ");
            validateEntryPath(entrypoints.optString("ui"), "ui");
        }

        JSONObject integrity = objectOrNull(manifest, "integrity");
        if (integrity == null || !isString(integrity, "runtime") || !HASH.matcher(integrity.optString("runtime")).matches()) throw new IllegalArgumentException("runtime integrity is required");
        if (entrypoints.has("ui") && (!isString(integrity, "ui") || !HASH.matcher(integrity.optString("ui")).matches())) throw new IllegalArgumentException("ui integrity is required");
        if (!entrypoints.has("ui") && integrity.has("ui")) throw new IllegalArgumentException("ui integrity requires ui entry");

        validateApi(manifest, "hostApi");
        validateApi(manifest, "coreApi");
        if ("core".equals(type)) {
            JSONObject hostApi = objectOrNull(manifest, "hostApi");
            if (hostApi == null || !"0.1".equals(hostApi.optString("version"))) throw new IllegalArgumentException("core hostApi 0.1 is required");
        }
        validateDependencies(manifest);
        validateCapabilities(manifest);
    }

    private static boolean isPluginCategory(String value) {
        return Arrays.asList("llm-system", "provider-driver", "solution", "tool", "effect", "ui", "composite").contains(value);
    }

    private static void validateApi(JSONObject manifest, String key) {
        if (!manifest.has(key)) return;
        JSONObject api = objectOrNull(manifest, key);
        if (api == null || !isString(api, "version") || !API_VERSION.matcher(api.optString("version")).matches()) throw new IllegalArgumentException(key + ".version is invalid");
    }

    private static void validateDependencies(JSONObject manifest) {
        if (!manifest.has("dependencies")) return;
        Object value = manifest.opt("dependencies");
        if (!(value instanceof org.json.JSONArray)) throw new IllegalArgumentException("dependencies must be an array");
        Set<String> seen = new HashSet<>(); org.json.JSONArray dependencies = (org.json.JSONArray) value;
        for (int i = 0; i < dependencies.length(); i++) {
            JSONObject dependency = dependencies.optJSONObject(i);
            if (dependency == null || !isString(dependency, "id") || !ID.matcher(dependency.optString("id")).matches() || !isString(dependency, "version") || !VERSION.matcher(dependency.optString("version")).matches()) throw new IllegalArgumentException("dependency is invalid");
            if (!seen.add(dependency.optString("id"))) throw new IllegalArgumentException("duplicate dependency: " + dependency.optString("id"));
            if (dependency.has("optional") && !(dependency.opt("optional") instanceof Boolean)) throw new IllegalArgumentException("dependency optional must be boolean");
        }
    }

    private static void validateCapabilities(JSONObject manifest) {
        if (!manifest.has("capabilities")) return;
        JSONObject capabilities = objectOrNull(manifest, "capabilities");
        if (capabilities == null) throw new IllegalArgumentException("capabilities must be an object");
        Set<String> required = capabilityList(capabilities, "required"); Set<String> optional = capabilityList(capabilities, "optional");
        for (String item : required) if (optional.contains(item)) throw new IllegalArgumentException("capability cannot be both required and optional: " + item);
    }

    private static Set<String> capabilityList(JSONObject capabilities, String key) {
        Set<String> result = new HashSet<>(); if (!capabilities.has(key)) return result;
        Object value = capabilities.opt(key); if (!(value instanceof org.json.JSONArray)) throw new IllegalArgumentException("capabilities." + key + " must be an array");
        org.json.JSONArray values = (org.json.JSONArray) value;
        for (int i = 0; i < values.length(); i++) { Object item = values.opt(i); if (!(item instanceof String) || ((String) item).trim().isEmpty()) throw new IllegalArgumentException("capabilities." + key + " must contain non-empty strings"); result.add((String) item); }
        return result;
    }

    private static boolean isString(JSONObject value, String key) { return value != null && value.opt(key) instanceof String; }
    private static JSONObject objectOrNull(JSONObject value, String key) { Object item = value == null ? null : value.opt(key); return item instanceof JSONObject ? (JSONObject) item : null; }

    private static void validateEntry(LinkedHashMap<String, byte[]> entries, JSONObject manifest, String path, String label, boolean runtime) throws Exception {
        validateEntryPath(path, label);
        byte[] bytes = entries.get(path); if (bytes == null) throw new IllegalArgumentException(label + " entry is missing: " + path);
        validateSource(bytes, label); verifyIntegrity(bytes, manifest, label);
    }

    private static void validateInstalledPackage(File dir, JSONObject manifest) throws Exception {
        validateManifest(manifest);
        JSONObject entrypoints = manifest.getJSONObject("entrypoints");
        validateInstalledEntry(dir, manifest, entrypoints.getString("runtime"), "runtime");
        if (entrypoints.has("ui")) validateInstalledEntry(dir, manifest, entrypoints.getString("ui"), "ui");
        Set<String> expected = new HashSet<>(); expected.add("manifest.json"); expected.add(entrypoints.getString("runtime"));
        if (entrypoints.has("ui")) expected.add(entrypoints.getString("ui")); expected.add("stagecraft.plugin.json");
        long total = 0;
        try (java.util.stream.Stream<Path> paths = Files.walk(dir.toPath())) {
            for (Path path : (Iterable<Path>) paths::iterator) {
                if (Files.isDirectory(path)) continue;
                File file = path.toFile(); ensureContained(dir, file); String relative = dir.toPath().relativize(path).toString().replace(File.separatorChar, '/'); validatePath(relative);
                if (!expected.contains(relative)) throw new IllegalArgumentException("installed package contains unreferenced file: " + relative);
                long size = Files.size(path); if (size > MAX_FILE_BYTES) throw new IllegalArgumentException("installed file exceeds size limit: " + relative); total += size;
            }
        }
        if (total > MAX_TOTAL_BYTES) throw new IllegalArgumentException("installed package expands beyond limit");
    }

    private static void validateInstalledEntry(File dir, JSONObject manifest, String path, String label) throws Exception {
        validateEntryPath(path, label); File file = new File(dir, path); ensureContained(dir, file); if (!file.isFile()) throw new IllegalArgumentException(label + " entry is missing: " + path);
        byte[] bytes; try (FileInputStream input = new FileInputStream(file)) { bytes = readLimited(input, MAX_FILE_BYTES); }
        validateSource(bytes, label); verifyIntegrity(bytes, manifest, label);
    }

    private static void validateEntryPath(String path, String label) {
        validatePath(path); String lower = path.toLowerCase(Locale.ROOT); if (!(lower.endsWith(".js") || lower.endsWith(".mjs"))) throw new IllegalArgumentException(label + " must be a .js or .mjs file");
    }

    private static void validateSource(byte[] bytes, String label) {
        String source = new String(bytes, StandardCharsets.UTF_8); if (FORBIDDEN.matcher(source).find()) throw new IllegalArgumentException(label + " contains Node/native code");
        if (MODULE_LOAD.matcher(source).find()) throw new IllegalArgumentException(label + " must be a single-file browser ESM entry");
    }

    private static void verifyIntegrity(byte[] bytes, JSONObject manifest, String label) throws Exception {
        String expected = manifest.getJSONObject("integrity").getString(label); String actual = "sha256-" + hex(MessageDigest.getInstance("SHA-256").digest(bytes)); if (!expected.equalsIgnoreCase(actual)) throw new IllegalArgumentException(label + " integrity mismatch");
    }

    private static void validatePath(String path) { if (path == null || path.isEmpty() || path.startsWith("/") || path.startsWith("\\") || path.contains("\\") || path.contains(":") || path.contains("\0")) throw new IllegalArgumentException("unsafe archive path: " + path); for (String part : path.split("/")) if (part.isEmpty() || ".".equals(part) || "..".equals(part)) throw new IllegalArgumentException("unsafe archive path: " + path); }
    private static void ensureContained(File root, File child) throws Exception { String base = root.getCanonicalPath() + File.separator; String target = child.getCanonicalPath(); if (!target.startsWith(base)) throw new IllegalArgumentException("path escapes component store"); }
    private static byte[] readLimited(InputStream input, long maximum) throws Exception { ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; long total = 0; int count; while ((count = input.read(buffer)) >= 0) { total += count; if (total > maximum) throw new IllegalArgumentException("file exceeds size limit"); output.write(buffer, 0, count); } return output.toByteArray(); }
    private static String hex(byte[] bytes) { StringBuilder result = new StringBuilder(bytes.length * 2); for (byte value : bytes) result.append(String.format(Locale.ROOT, "%02x", value)); return result.toString(); }
    private static String key(String id, String version) { return id + "@" + version; }
    private static void deleteTree(Path path) { try { if (!Files.exists(path)) return; Files.walk(path).sorted(Comparator.reverseOrder()).forEach(item -> { try { Files.deleteIfExists(item); } catch (Exception ignored) { } }); } catch (Exception ignored) { } }
}
