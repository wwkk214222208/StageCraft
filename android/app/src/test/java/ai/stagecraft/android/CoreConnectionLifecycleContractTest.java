package ai.stagecraft.android;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.charset.StandardCharsets;

import org.junit.Test;

/** JVM/source contracts for the host/Core lifecycle seams (no Android device required). */
public final class CoreConnectionLifecycleContractTest {
    private static String readSource(String relative) throws IOException {
        Path cursor = Paths.get("").toAbsolutePath();
        for (int depth = 0; depth < 8 && cursor != null; depth++, cursor = cursor.getParent()) {
            Path direct = cursor.resolve(relative);
            if (Files.isRegularFile(direct)) return new String(Files.readAllBytes(direct), StandardCharsets.UTF_8);
        }
        throw new IOException("source not found from " + Paths.get("").toAbsolutePath() + ": " + relative);
    }

    @Test public void endpointNotReadyRestartIsARebuildSequence() throws Exception {
        String connection = readSource("android/app/src/main/java/ai/stagecraft/android/CoreConnection.java");
        String activity = readSource("android/app/src/main/java/ai/stagecraft/android/MainActivity.java");
        assertTrue(connection.contains("public boolean restart()"));
        assertTrue(connection.contains("stopService(new Intent(context, CoreService.class))"));
        assertTrue(connection.contains("scheduleRebindOnce(\"restart-endpoint-not-ready\")"));
        int routeHandler = activity.indexOf("handleMainHostRoute");
        int restart = activity.lastIndexOf("case \"host.restart\":");
        assertTrue("main host handler must exist after route registration", routeHandler >= 0 && restart > routeHandler);
        assertTrue("host.restart handler must exist", restart >= 0);
        int nextCase = activity.indexOf("case \"", restart + 20);
        String restartBody = activity.substring(restart, nextCase < 0 ? activity.length() : nextCase);
        assertTrue(restartBody.contains("coreConnection.restart()"));
        assertFalse("host restart must never fall back to bound stopSelf", restartBody.contains("requestStop()"));
    }

    @Test public void rebindHandlesFalseExceptionAndMissingCallback() throws Exception {
        String source = readSource("android/app/src/main/java/ai/stagecraft/android/CoreConnection.java");
        assertTrue(source.contains("MAX_REBIND_ATTEMPTS"));
        assertTrue(source.contains("BIND_CALLBACK_TIMEOUT_MS"));
        assertTrue(source.contains("bindService returned false"));
        assertTrue(source.contains("bindService exception"));
        assertTrue(source.contains("onServiceConnected timeout"));
        assertTrue(source.contains("onRebindAttemptFailed"));
        assertTrue(source.contains("REBIND_MAX_DELAY_MS"));
        assertTrue(source.contains("RejectedExecutionException"));
        assertTrue(source.contains("rebind scheduler is closed; sequence abandoned"));
    }

    @Test public void duplicateDeathsAreDedupedAndUnbindStopsRetry() throws Exception {
        String source = readSource("android/app/src/main/java/ai/stagecraft/android/CoreConnection.java");
        assertTrue(source.contains("rebindPending.compareAndSet(false, true)"));
        assertTrue(source.contains("rebindDedupedCount.incrementAndGet()"));
        assertTrue(source.contains("rebindExecutor.shutdownNow()"));
        assertTrue(source.contains("rebindPending.set(false)"));
        assertTrue(source.contains("restartRequested.set(false)"));
        assertTrue(source.contains("if (closed.get()) return"));
    }
}
