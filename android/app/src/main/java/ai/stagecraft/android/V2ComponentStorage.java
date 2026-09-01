package ai.stagecraft.android;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.regex.Pattern;

/**
 * v2 host.storage 的 Android 参考实现：每组件命名空间 KV（filesDir/v2-storage/<id>/<area>.json）。
 *
 * 逐能力授权闭环的 Java 侧执行点：caller 必须携带组件身份（pluginId + version），且该组件
 * manifest 的 capabilities（required 或 optional）必须声明 host.storage。缺失 caller、
 * 组件未安装或能力未声明的调用一律 fail closed。
 *
 * 这不是秘密存储：内容是 filesDir 下的明文 JSON，信任级别与桌面 v2 存储一致；密钥级
 * 存储仍走 AndroidSecretStore（secret.* 操作）。
 */
public final class V2ComponentStorage {
    public static final String STORAGE_CAPABILITY = "host.storage";
    public static final long MAX_VALUE_BYTES = 1024 * 1024;
    private static final Pattern ID = Pattern.compile("^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)+$");
    private static final Pattern VERSION = Pattern.compile("^\\d+\\.\\d+\\.\\d+(?:[-+][\\w.-]+)?$");
    private static final Pattern AREA = Pattern.compile("^[a-z][a-z0-9-]*$");

    private final File root;
    private final V2ComponentStore componentStore;

    public V2ComponentStorage(File filesDir, V2ComponentStore componentStore) {
        this.root = new File(filesDir, "v2-storage");
        this.componentStore = componentStore;
    }

    /** host.storage.read。返回 {ok:true, value}；缺失返回 value=null；拒绝/非法抛出。 */
    public JSONObject read(JSONObject input) throws Exception {
        Caller caller = checkedCaller(input);
        File file = fileFor(caller, area(input));
        if (!file.isFile()) return new JSONObject().put("ok", true).put("value", JSONObject.NULL);
        byte[] bytes = readLimited(file);
        try {
            return new JSONObject().put("ok", true).put("value", new JSONObject(new String(bytes, StandardCharsets.UTF_8)));
        } catch (Exception error) {
            // 损坏按缺失处理（与桌面参考实现一致），不阻断 Core 启动。
            return new JSONObject().put("ok", true).put("value", JSONObject.NULL);
        }
    }

    /** host.storage.write。原子替换写；成功返回 {ok:true}。 */
    public JSONObject write(JSONObject input) throws Exception {
        Caller caller = checkedCaller(input);
        String area = area(input);
        Object value = input == null ? null : input.opt("value");
        String encoded = (value == null ? JSONObject.NULL : value).toString();
        if (encoded.length() > MAX_VALUE_BYTES) throw new IllegalArgumentException("storage value exceeds " + MAX_VALUE_BYTES + " bytes");
        File file = fileFor(caller, area);
        File parent = file.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IllegalStateException("cannot create storage directory");
        File temporary = new File(parent, file.getName() + "." + System.nanoTime() + ".tmp");
        Files.write(temporary.toPath(), encoded.getBytes(StandardCharsets.UTF_8));
        try {
            Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (java.nio.file.AtomicMoveNotSupportedException ignored) {
            Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING);
        }
        return new JSONObject().put("ok", true);
    }

    private Caller checkedCaller(JSONObject input) throws Exception {
        JSONObject caller = input == null ? null : input.optJSONObject("caller");
        if (caller == null) throw new IllegalArgumentException("storage caller identity is required");
        String pluginId = caller.optString("pluginId", "");
        String version = caller.optString("version", "");
        if (!ID.matcher(pluginId).matches()) throw new IllegalArgumentException("storage caller pluginId is invalid");
        if (!VERSION.matcher(version).matches()) throw new IllegalArgumentException("storage caller version is invalid");
        if (componentStore == null) throw new IllegalStateException("component store is not ready");
        JSONObject manifest = componentStore.read(pluginId, version);
        if (!manifestHasStorageCapability(manifest)) {
            throw new IllegalArgumentException("host.storage capability is not declared by " + pluginId + "@" + version);
        }
        return new Caller(pluginId, version);
    }

    static boolean manifestHasStorageCapability(JSONObject manifest) {
        JSONObject capabilities = manifest == null ? null : manifest.optJSONObject("capabilities");
        if (capabilities == null) return false;
        for (String kind : new String[]{"required", "optional"}) {
            org.json.JSONArray list = capabilities.optJSONArray(kind);
            if (list == null) continue;
            for (int index = 0; index < list.length(); index++) if (STORAGE_CAPABILITY.equals(list.optString(index))) return true;
        }
        return false;
    }

    private static String area(JSONObject input) {
        String area = input.optString("area", "");
        if (!AREA.matcher(area).matches()) throw new IllegalArgumentException("storage area must be a lowercase identifier");
        return area;
    }

    private File fileFor(Caller caller, String area) {
        // ID/AREA 正则不含路径分隔符，目录天然包含于 root。
        File dir = new File(root, caller.pluginId);
        File file = new File(dir, area + ".json");
        String relative = dir.toPath().toAbsolutePath().normalize().toString();
        if (!relative.startsWith(root.toPath().toAbsolutePath().normalize().toString() + File.separator)) {
            throw new IllegalArgumentException("storage path escapes its root");
        }
        return file;
    }

    private static byte[] readLimited(File file) throws Exception {
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] bytes = new byte[(int) Math.min(file.length() + 1, MAX_VALUE_BYTES + 1)];
            int read = input.read(bytes);
            if (read > MAX_VALUE_BYTES) throw new IllegalArgumentException("storage value exceeds limit");
            byte[] exact = new byte[Math.max(0, read)];
            System.arraycopy(bytes, 0, exact, 0, exact.length);
            return exact;
        }
    }

    private static final class Caller {
        final String pluginId;
        final String version;
        Caller(String pluginId, String version) { this.pluginId = pluginId; this.version = version; }
    }
}
