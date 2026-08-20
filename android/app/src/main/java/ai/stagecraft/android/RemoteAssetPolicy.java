package ai.stagecraft.android;

import java.util.Locale;
import java.util.regex.Pattern;

public final class RemoteAssetPolicy {
    public static final int MAX_BYTES = 2 * 1024 * 1024;
    private static final Pattern ASSET_PATH = Pattern.compile("^/assets/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$");

    private RemoteAssetPolicy() {}

    public static String requireAssetPath(String path) {
        if (path == null || !ASSET_PATH.matcher(path).matches() || path.contains("..")) {
            throw new IllegalArgumentException("Remote media path is not allowed.");
        }
        return path;
    }

    public static String requireRasterMime(String contentType) {
        String mime = contentType == null ? "" : contentType.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
        if (!mime.equals("image/png") && !mime.equals("image/jpeg") && !mime.equals("image/gif") && !mime.equals("image/webp")) {
            throw new IllegalArgumentException("Remote media type is not allowed.");
        }
        return mime;
    }
}
