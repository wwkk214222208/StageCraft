package ai.stagecraft.android;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Gate B：api-route-registry.json 的 Java 消费器。
 *
 * Q6 语义：method 精确匹配；静态路径优先于参数路径；更具体 pattern 优先；
 * 重复 (method, pattern) 与同形状歧义 pattern 在 parse 时即失败。
 * 认证/代理策略（authPolicy）随路由显式下发，gateway 按此执行（Gate B：不能全部 auth:none）。
 * registrySha256 用于证据核对（构建期生成，Java 侧重算比对）。
 */
public final class RouteRegistry {

    public static final class RegistryException extends RuntimeException {
        public RegistryException(String message) { super(message); }
    }

    public static final class Route {
        public final int order;
        public final String method;
        public final String pattern;
        public final String owner;
        public final String capability;
        public final String handlerId;
        public final String auth;           // 遗留字段（v1 全为 none），保留以核对
        public final JSONObject authPolicy; // {kind: local-open | core-nonce | remote-paired}
        public final JSONObject dispatchPolicy; // {androidLocal: {action, auth, errorCode?}, androidRemote: {...}}（Gate B 收口）
        Route(int order, String method, String pattern, String owner, String capability,
              String handlerId, String auth, JSONObject authPolicy, JSONObject dispatchPolicy) {
            this.order = order;
            this.method = method;
            this.pattern = pattern;
            this.owner = owner;
            this.capability = capability;
            this.handlerId = handlerId;
            this.auth = auth;
            this.authPolicy = authPolicy;
            this.dispatchPolicy = dispatchPolicy;
        }
    }

    public static final class Match {
        public final Route route;
        Match(Route route) { this.route = route; }
        public String owner() { return route.owner; }
        public String handlerId() { return route.handlerId; }
        public boolean requiresCoreNonce() {
            return route.authPolicy != null && "core-nonce".equals(route.authPolicy.optString("kind"));
        }
    }

    private static final Set<String> VALID_AUTH_KINDS =
        new HashSet<>(java.util.Arrays.asList("local-open", "core-nonce", "remote-paired"));
    private static final Set<String> VALID_OWNERS =
        new HashSet<>(java.util.Arrays.asList("core", "main-host", "desktop-only", "deprecated"));
    private static final Set<String> VALID_ACTIONS =
        new HashSet<>(java.util.Arrays.asList("proxy-core", "host-handler", "stable-unsupported", "deprecated-adapter"));
    private static final Set<String> VALID_DISPATCH_AUTHS =
        new HashSet<>(java.util.Arrays.asList("core-nonce", "remote-paired", "local", "none"));

    private final String registryVersion;
    private final String sha256;
    private final List<Route> routes;
    private final Map<String, Route> byKey;

    private RouteRegistry(String registryVersion, String sha256, List<Route> routes, Map<String, Route> byKey) {
        this.registryVersion = registryVersion;
        this.sha256 = sha256;
        this.routes = routes;
        this.byKey = byKey;
    }

    /** 解析并校验 registry JSON。expectedSha256 非空时与原文哈希强比对。 */
    public static RouteRegistry parse(String json, String expectedSha256) {
        if (expectedSha256 != null) {
            String actual = sha256Hex(json);
            if (!expectedSha256.equals(actual)) {
                throw new RegistryException("registry sha256 mismatch: expected " + expectedSha256 + " got " + actual);
            }
        }
        JSONObject root;
        try { root = new JSONObject(json); }
        catch (JSONException error) { throw new RegistryException("registry is not valid JSON: " + error); }
        String version = root.optString("registryVersion", "");
        if (version.isEmpty()) throw new RegistryException("registry missing registryVersion");
        JSONArray array = root.optJSONArray("routes");
        if (array == null) throw new RegistryException("registry missing routes array");

        List<Route> routes = new ArrayList<>();
        Map<String, Route> byKey = new HashMap<>();
        Map<String, String> shapes = new HashMap<>();
        for (int index = 0; index < array.length(); index++) {
            JSONObject route = array.optJSONObject(index);
            if (route == null) throw new RegistryException("route #" + index + " is not an object");
            String method = route.optString("method", "");
            String pattern = route.optString("pattern", "");
            String owner = route.optString("owner", "");
            String key = method + " " + pattern;
            if (byKey.containsKey(key)) throw new RegistryException("重复登记：" + key);
            JSONObject authPolicy = route.optJSONObject("authPolicy");
            if (authPolicy == null || !VALID_AUTH_KINDS.contains(authPolicy.optString("kind"))) {
                throw new RegistryException("route " + key + " 缺少显式 authPolicy（Gate B）");
            }
            // Gate B 收口：machine-readable dispatchPolicy 必须存在且两个 surface 都合法
            JSONObject dispatchPolicy = route.optJSONObject("dispatchPolicy");
            if (dispatchPolicy == null) {
                throw new RegistryException("route " + key + " 缺少 dispatchPolicy（Gate B 收口）");
            }
            validateSurfacePolicy(key, dispatchPolicy.optJSONObject("androidLocal"), "androidLocal");
            validateSurfacePolicy(key, dispatchPolicy.optJSONObject("androidRemote"), "androidRemote");
            if (!VALID_OWNERS.contains(owner)) throw new RegistryException("route " + key + " owner 非法: " + owner);
            if (route.optString("capability", "").isEmpty() || route.optString("handlerId", "").isEmpty()) {
                throw new RegistryException("route " + key + " 缺少 capability/handlerId");
            }
            Route parsed = new Route(route.optInt("order", index), method, pattern, owner,
                route.optString("capability"), route.optString("handlerId"), route.optString("auth", "none"), authPolicy, dispatchPolicy);
            byKey.put(key, parsed);
            routes.add(parsed);
            // 同形状歧义检测：参数段名不同但形状相同（匹配行为无法区分）
            String shape = shapeKey(pattern);
            String ambiguous = shapes.putIfAbsent(method + " " + shape, pattern);
            if (ambiguous != null && !ambiguous.equals(pattern)) {
                throw new RegistryException("歧义 pattern：" + ambiguous + " 与 " + pattern + " 形状相同");
            }
        }
        return new RouteRegistry(version, sha256Hex(json), routes, byKey);
    }

    /** surface 策略合法性：action/auth 必须属于枚举；stable-unsupported/deprecated-adapter 必须带 errorCode。 */
    private static void validateSurfacePolicy(String key, JSONObject surface, String surfaceName) {
        if (surface == null) throw new RegistryException("route " + key + " 缺少 dispatchPolicy." + surfaceName + "（Gate B 收口）");
        String action = surface.optString("action", "");
        if (!VALID_ACTIONS.contains(action)) {
            throw new RegistryException("route " + key + " dispatchPolicy." + surfaceName + " action 非法: " + action);
        }
        String auth = surface.optString("auth", "");
        if (!VALID_DISPATCH_AUTHS.contains(auth)) {
            throw new RegistryException("route " + key + " dispatchPolicy." + surfaceName + " auth 非法: " + auth);
        }
        if (("stable-unsupported".equals(action) || "deprecated-adapter".equals(action)) && surface.optString("errorCode", "").isEmpty()) {
            throw new RegistryException("route " + key + " dispatchPolicy." + surfaceName + " 稳定错误策略必须带 errorCode");
        }
    }

    static String shapeKey(String pattern) {        StringBuilder builder = new StringBuilder();
        for (String segment : pattern.split("/")) {
            if (segment.isEmpty()) continue;
            builder.append(segment.startsWith("{") ? "{param}" : segment).append('/');
        }
        return builder.toString();
    }

    /** Q6 匹配：method 精确、query 剥离、段数与参数槽同形、静态段多者优先。 */
    public Route match(String method, String path) {
        String upper = method == null ? "" : method.toUpperCase(java.util.Locale.ROOT);
        String cleanPath = path == null ? "" : path.split("\\?")[0];
        String[] segments = cleanPath.split("/");
        List<String> parts = new ArrayList<>();
        for (String segment : segments) if (!segment.isEmpty()) parts.add(segment);
        Route best = null;
        int bestStatic = -1;
        for (Route route : routes) {
            if (!route.method.equals(upper)) continue;
            String[] patternSegments = route.pattern.split("/");
            List<String> patternParts = new ArrayList<>();
            for (String segment : patternSegments) if (!segment.isEmpty()) patternParts.add(segment);
            if (patternParts.size() != parts.size()) continue;
            boolean matched = true;
            int staticCount = 0;
            for (int i = 0; i < parts.size(); i++) {
                String patternPart = patternParts.get(i);
                if (patternPart.startsWith("{")) continue;
                if (!patternPart.equals(parts.get(i))) { matched = false; break; }
                staticCount++;
            }
            if (!matched) continue;
            if (best == null || staticCount > bestStatic) { best = route; bestStatic = staticCount; }
        }
        return best;
    }

    public String registryVersion() { return registryVersion; }
    public String sha256() { return sha256; }
    public int size() { return routes.size(); }
    public List<Route> routes() { return java.util.Collections.unmodifiableList(routes); }

    static String sha256Hex(String text) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(text.getBytes(StandardCharsets.UTF_8));
            StringBuilder builder = new StringBuilder();
            for (byte b : hash) builder.append(String.format("%02x", b));
            return builder.toString();
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }

}
