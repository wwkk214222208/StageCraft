package ai.stagecraft.android;

import android.content.Context;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Verifies the generated embedded Core contract before local WebView mode is allowed. */
public final class EmbeddedCoreArtifact {
    public static final String ASSET = "embedded-core.js";
    public static final String MANIFEST = "embedded-core.json";
    public static final String EXPECTED_PROTOCOL = "1.1";
    public static final String EXPECTED_BRIDGE = "1";
    public static final String EXPECTED_BUNDLE = "1.1.0";

    private EmbeddedCoreArtifact() {}

    public static Verification verify(Context context) {
        try {
            JSONObject manifest;
            try (InputStream input = context.getAssets().open(MANIFEST)) {
                manifest = new JSONObject(new String(readAll(input), StandardCharsets.UTF_8));
            }
            byte[] bundle;
            try (InputStream input = context.getAssets().open(ASSET)) { bundle = readAll(input); }
            String digest = hex(MessageDigest.getInstance("SHA-256").digest(bundle));
            if (!"stagecraft-embedded-core".equals(manifest.optString("artifact"))) return Verification.invalid("artifact");
            if (!EXPECTED_PROTOCOL.equals(manifest.optString("protocolVersion"))) return Verification.invalid("protocol");
            if (!EXPECTED_BRIDGE.equals(manifest.optString("bridgeVersion"))) return Verification.invalid("bridge");
            if (!EXPECTED_BUNDLE.equals(manifest.optString("bundleVersion"))) return Verification.invalid("bundle");
            if (!digest.equals(manifest.optString("sha256"))) return Verification.invalid("sha256");
            if (bundle.length != manifest.optInt("bytes", -1)) return Verification.invalid("bytes");
            return Verification.valid(manifest.optString("bundleVersion"), digest);
        } catch (Exception error) { return Verification.invalid(error.getClass().getSimpleName()); }
    }

    private static byte[] readAll(InputStream input) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int count;
        while ((count = input.read(buffer)) >= 0) output.write(buffer, 0, count);
        return output.toByteArray();
    }

    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format("%02x", value));
        return result.toString();
    }

    public record Verification(boolean valid, String reason, String version, String sha256) {
        static Verification valid(String version, String sha256) { return new Verification(true, "", version, sha256); }
        static Verification invalid(String reason) { return new Verification(false, reason, "", ""); }
    }
}
