package ai.stagecraft.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

public final class ServerAddressValidatorTest {
    @Test public void acceptsHttpsAndNormalizesTrailingSlash() {
        assertEquals("https://example.test", ServerAddressValidator.validate("https://example.test/", false).toString());
    }

    @Test public void httpRequiresExplicitConsent() {
        assertThrows(IllegalArgumentException.class, () -> ServerAddressValidator.validate("http://192.168.1.8:8787", false));
        assertEquals("http://192.168.1.8:8787", ServerAddressValidator.validate("http://192.168.1.8:8787", true).toString());
    }

    @Test public void insecureHttpIsLimitedToPrivateIpLiterals() {
        for (String address : new String[] { "http://10.0.0.2", "http://172.16.1.2", "http://192.168.1.8", "http://169.254.3.4", "http://127.0.0.1", "http://[fd00::1]", "http://[fe80::1]", "http://[::1]" }) {
            ServerAddressValidator.validate(address, true);
        }
        for (String address : new String[] { "http://example.test", "http://localhost", "http://8.8.8.8", "http://172.32.0.1", "http://[2001:4860:4860::8888]" }) {
            assertThrows(IllegalArgumentException.class, () -> ServerAddressValidator.validate(address, true));
        }
    }

    @Test public void rejectsCredentialsQueryFragmentAndPath() {
        for (String address : new String[] { "https://user:pass@example.test", "https://example.test/?secret=x", "https://example.test/#x", "https://example.test/private", "file:///tmp/app" }) {
            assertThrows(IllegalArgumentException.class, () -> ServerAddressValidator.validate(address, false));
        }
    }
}
