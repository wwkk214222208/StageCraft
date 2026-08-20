package ai.stagecraft.android;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public final class ConnectionBackoffTest {
    @Test public void doublesAndCapsWithoutOverflow() {
        ConnectionBackoff backoff = new ConnectionBackoff(250, 5_000);
        assertEquals(250, backoff.delayForAttempt(1));
        assertEquals(500, backoff.delayForAttempt(2));
        assertEquals(5_000, backoff.delayForAttempt(30));
        assertEquals(5_000, backoff.delayForAttempt(Integer.MAX_VALUE));
    }
}
