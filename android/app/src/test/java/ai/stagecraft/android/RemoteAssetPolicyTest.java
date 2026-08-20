package ai.stagecraft.android;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

public final class RemoteAssetPolicyTest {
    @Test public void acceptsOnlyFlatAssetPaths() {
        assertEquals("/assets/avatar-1.png", RemoteAssetPolicy.requireAssetPath("/assets/avatar-1.png"));
        assertThrows(IllegalArgumentException.class, () -> RemoteAssetPolicy.requireAssetPath("//attacker.invalid/image.png"));
        assertThrows(IllegalArgumentException.class, () -> RemoteAssetPolicy.requireAssetPath("/assets/../secret.png"));
        assertThrows(IllegalArgumentException.class, () -> RemoteAssetPolicy.requireAssetPath("/custom/private.png"));
        assertThrows(IllegalArgumentException.class, () -> RemoteAssetPolicy.requireAssetPath("/assets/image.png?token=x"));
    }

    @Test public void acceptsOnlyRasterImages() {
        assertEquals("image/png", RemoteAssetPolicy.requireRasterMime("image/png; charset=binary"));
        assertThrows(IllegalArgumentException.class, () -> RemoteAssetPolicy.requireRasterMime("image/svg+xml"));
        assertThrows(IllegalArgumentException.class, () -> RemoteAssetPolicy.requireRasterMime("text/html"));
    }
}
