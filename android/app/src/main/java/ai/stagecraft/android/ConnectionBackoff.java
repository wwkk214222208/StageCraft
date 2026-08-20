package ai.stagecraft.android;

public final class ConnectionBackoff {
    private final long initialMillis;
    private final long maximumMillis;

    public ConnectionBackoff(long initialMillis, long maximumMillis) {
        if (initialMillis < 1 || maximumMillis < initialMillis) throw new IllegalArgumentException("Invalid reconnect backoff.");
        this.initialMillis = initialMillis;
        this.maximumMillis = maximumMillis;
    }

    public long delayForAttempt(int attempt) {
        if (attempt <= 0) return initialMillis;
        long delay = initialMillis;
        for (int index = 1; index < attempt && delay < maximumMillis; index++) {
            delay = delay > maximumMillis / 2 ? maximumMillis : delay * 2;
        }
        return Math.min(delay, maximumMillis);
    }
}
