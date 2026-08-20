package ai.stagecraft.android;

import org.json.JSONObject;

/**
 * Native I/O surface for the portable TypeScript composition root.
 * It contains persistence/assets/secrets only; StageCraft commands remain in Core.
 */
public interface AndroidNativeOperations {
    Object invokeSync(String operation, JSONObject input) throws Exception;
    void invoke(String operation, JSONObject input, Callback callback);

    interface Callback {
        void onResult(JSONObject result);
        void onError(String message);
    }
}
