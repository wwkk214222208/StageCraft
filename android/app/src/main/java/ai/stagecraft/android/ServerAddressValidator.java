package ai.stagecraft.android;

import java.net.URI;
import java.net.URISyntaxException;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.Locale;

public final class ServerAddressValidator {
    private ServerAddressValidator() {}

    public static URI validate(String input, boolean allowInsecureHttp) {
        if (input == null || input.trim().isEmpty()) throw new IllegalArgumentException("Server address is required.");
        final URI uri;
        try {
            uri = new URI(input.trim());
        } catch (URISyntaxException error) {
            throw new IllegalArgumentException("Server address is invalid.");
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!scheme.equals("https") && !scheme.equals("http")) throw new IllegalArgumentException("Only HTTPS or HTTP server addresses are supported.");
        if (uri.getHost() == null || uri.getHost().isEmpty()) throw new IllegalArgumentException("Server address must contain a host.");
        if (scheme.equals("http") && !allowInsecureHttp) throw new IllegalArgumentException("HTTP requires explicit insecure LAN consent.");
        if (scheme.equals("http") && !isPrivateIpLiteral(uri.getHost())) throw new IllegalArgumentException("Insecure HTTP is limited to private LAN IP addresses.");
        if (uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null) throw new IllegalArgumentException("Credentials, query strings and fragments are not allowed.");
        if (uri.getPath() != null && !uri.getPath().isEmpty() && !uri.getPath().equals("/")) throw new IllegalArgumentException("Server address must not contain a path.");
        int port = uri.getPort();
        if (port < -1 || port > 65535) throw new IllegalArgumentException("Server port is invalid.");
        try {
            return new URI(scheme, null, uri.getHost(), port, null, null, null);
        } catch (URISyntaxException impossible) {
            throw new IllegalArgumentException("Server address is invalid.");
        }
    }

    private static boolean isPrivateIpLiteral(String host) {
        String normalized = host.startsWith("[") && host.endsWith("]") ? host.substring(1, host.length() - 1) : host;
        if (normalized.indexOf(':') >= 0) {
            if (normalized.indexOf('%') >= 0) return false;
            try {
                byte[] bytes = InetAddress.getByName(normalized).getAddress();
                if (bytes.length == 4) return isPrivateIpv4(bytes);
                int first = bytes[0] & 0xff;
                int second = bytes[1] & 0xff;
                boolean loopback = true;
                for (int index = 0; index < 15; index++) loopback &= bytes[index] == 0;
                loopback &= bytes[15] == 1;
                return loopback || (first & 0xfe) == 0xfc || (first == 0xfe && (second & 0xc0) == 0x80);
            } catch (UnknownHostException error) {
                return false;
            }
        }
        String[] parts = normalized.split("\\.", -1);
        if (parts.length != 4) return false;
        byte[] bytes = new byte[4];
        for (int index = 0; index < 4; index++) {
            if (parts[index].isEmpty() || (parts[index].length() > 1 && parts[index].startsWith("0"))) return false;
            try {
                int value = Integer.parseInt(parts[index]);
                if (value < 0 || value > 255) return false;
                bytes[index] = (byte) value;
            } catch (NumberFormatException error) {
                return false;
            }
        }
        return isPrivateIpv4(bytes);
    }

    private static boolean isPrivateIpv4(byte[] bytes) {
        int first = bytes[0] & 0xff;
        int second = bytes[1] & 0xff;
        return first == 10 || first == 127 || (first == 172 && second >= 16 && second <= 31) || (first == 192 && second == 168) || (first == 169 && second == 254);
    }

    /** ADB reverse 隧道地址判定：本机回环（127.0.0.1 / ::1 / localhost）。 */
    public static boolean isLoopbackHost(String host) {
        if (host == null) return false;
        String normalized = host.startsWith("[") && host.endsWith("]") ? host.substring(1, host.length() - 1) : host;
        String lower = normalized.toLowerCase(Locale.ROOT);
        return lower.equals("127.0.0.1") || lower.equals("::1") || lower.equals("localhost");
    }
}
