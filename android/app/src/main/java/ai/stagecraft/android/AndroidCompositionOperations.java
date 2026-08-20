package ai.stagecraft.android;

import android.content.Context;
import android.util.Base64;

import org.json.JSONObject;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executor;

/** Android implementation of the portable composition I/O port. */
public final class AndroidCompositionOperations implements AndroidNativeOperations {
    private final Context context;
    private final AndroidSqliteRepository repository;
    private final AndroidSecretStore secrets;
    private final Executor executor;

    public AndroidCompositionOperations(Context context, AndroidSqliteRepository repository, AndroidSecretStore secrets, Executor executor) {
        this.context = context.getApplicationContext();
        this.repository = repository;
        this.secrets = secrets;
        this.executor = executor;
    }

    @Override public JSONObject invokeSync(String operation, JSONObject input) throws Exception {
        if ("core-state.commit".equals(operation)) {
            repository.saveCoreState(input.optString("roomId"), input.optLong("revision"), input.optJSONObject("state"), input.optJSONArray("events"), input.optJSONArray("workflows"));
            return new JSONObject();
        }
        if ("core-state.restore".equals(operation)) return repository.loadCoreState(input.optString("roomId"));
        if ("stagecraft.room.get".equals(operation)) {
            JSONObject snapshot = repository.loadCoreState(input.optString("roomId"));
            if (snapshot == null || snapshot.optJSONObject("state") == null) throw new IllegalStateException("Android local room is unavailable.");
            return snapshot.getJSONObject("state");
        }
        if ("stagecraft.repository".equals(operation)) {
            String method = input.optString("method");
            org.json.JSONArray args = input.optJSONArray("args");
            if ("importRoom".equals(method) && args != null && args.length() >= 2) {
                JSONObject room = args.optJSONObject(1);
                if (room != null) repository.saveRoom(room);
                return new JSONObject();
            }
            throw new IllegalArgumentException("Unsupported Android repository operation: " + method);
        }
        if ("asset.read".equals(operation)) {
            byte[] data = repository.getAsset(input.optString("path"));
            return data == null ? new JSONObject() : new JSONObject().put("data", Base64.encodeToString(data, Base64.NO_WRAP));
        }
        if ("asset.write".equals(operation)) {
            repository.putAsset(input.optString("path"), input.optString("contentType"), Base64.decode(input.optString("data"), Base64.DEFAULT));
            return new JSONObject();
        }
        if ("asset.remove".equals(operation)) { repository.removeAsset(input.optString("path")); return new JSONObject(); }
        if ("secret.get".equals(operation)) { String value = secrets.get(input.optString("key")); return value == null ? new JSONObject() : new JSONObject().put("value", value); }
        if ("secret.set".equals(operation)) { secrets.set(input.optString("key"), input.optString("value")); return new JSONObject(); }
        if ("secret.remove".equals(operation)) { secrets.remove(input.optString("key")); return new JSONObject(); }
        throw new IllegalArgumentException("Unsupported synchronous composition operation: " + operation);
    }

    @Override public void invoke(String operation, JSONObject input, Callback callback) {
        executor.execute(() -> {
            try {
                if ("prompts.read".equals(operation)) {
                    callback.onResult(new JSONObject().put("value", readAssetText("prompts/prompts.json")));
                    return;
                }
                if ("story.read".equals(operation)) {
                    callback.onResult(new JSONObject().put("value", readAssetText("stories/" + input.optString("id") + ".json")));
                    return;
                }
                callback.onError("Unsupported asynchronous composition operation: " + operation);
            } catch (Exception error) { callback.onError(error.getMessage() == null ? "Composition operation failed." : error.getMessage()); }
        });
    }

    private String readAssetText(String path) throws Exception {
        try (InputStream input = context.getAssets().open(path)) {
            byte[] data = StageCraftArchive.readLimited(input, 4 * 1024 * 1024);
            return new String(data, StandardCharsets.UTF_8);
        }
    }
}
