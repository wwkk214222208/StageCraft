package ai.stagecraft.android;

import android.content.Context;
import android.util.Base64;

import org.json.JSONObject;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.net.URI;
import java.util.concurrent.Executor;
import java.util.concurrent.ConcurrentHashMap;
import java.util.Map;

/** Android implementation of the portable composition I/O port. */
public final class AndroidCompositionOperations implements AndroidNativeOperations, AutoCloseable {
    private final Context context;
    private final AndroidSqliteRepository repository;
    private final AndroidSecretStore secrets;
    private final Executor executor;
    private final AndroidModelTransport modelTransport;

    public AndroidCompositionOperations(Context context, AndroidSqliteRepository repository, AndroidSecretStore secrets, Executor executor) {
        this(context, repository, secrets, executor, new AndroidModelTransport());
    }
    public AndroidCompositionOperations(Context context, AndroidSqliteRepository repository, AndroidSecretStore secrets, Executor executor, AndroidModelTransport modelTransport) {
        this.context = context.getApplicationContext();
        this.repository = repository;
        this.secrets = secrets;
        this.executor = executor;
        this.modelTransport = modelTransport;
    }

    @Override public JSONObject invokeSync(String operation, JSONObject input) throws Exception {
        if (operation == null || operation.length() > 64 || input == null) throw new IllegalArgumentException("Invalid native operation.");
        if ("core-state.commit".equals(operation)) {
            repository.saveCoreState(JsonSafety.requiredString(input, "roomId", 256), input.optLong("revision", -1), JsonSafety.requiredObject(input, "state"), JsonSafety.requiredArray(input, "events"), JsonSafety.requiredArray(input, "workflows"));
            return new JSONObject().put("ok", true);
        }
        if ("core-state.restore".equals(operation)) return repository.loadCoreState(JsonSafety.requiredString(input, "roomId", 256));
        if ("stagecraft.room.get".equals(operation)) {
            String roomId = JsonSafety.requiredString(input, "roomId", 256);
            JSONObject room = repository.getRoom(roomId);
            if (room == null) {
                room = defaultRoom(roomId);
                repository.saveRoom(room);
            }
            return room;
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
            String path = JsonSafety.requiredString(input, "path", 512); JsonSafety.path(path);
            byte[] data = repository.getAsset(path);
            return data == null ? new JSONObject().put("found", false) : new JSONObject().put("found", true).put("data", Base64.encodeToString(data, Base64.NO_WRAP));
        }
        if ("asset.write".equals(operation)) {
            String path = JsonSafety.requiredString(input, "path", 512); JsonSafety.path(path); String encoded = JsonSafety.requiredString(input, "data", 16 * 1024 * 1024);
            repository.putAsset(path, JsonSafety.optionalString(input, "contentType", 128), Base64.decode(encoded, Base64.DEFAULT));
            return new JSONObject().put("ok", true);
        }
        if ("asset.remove".equals(operation)) { String path = JsonSafety.requiredString(input, "path", 512); JsonSafety.path(path); repository.removeAsset(path); return new JSONObject().put("ok", true); }
        if ("secret.get".equals(operation)) { String value = secrets.get(JsonSafety.requiredString(input, "key", 256)); return value == null ? new JSONObject().put("found", false) : new JSONObject().put("found", true).put("value", value); }
        if ("secret.set".equals(operation)) { secrets.set(JsonSafety.requiredString(input, "key", 256), JsonSafety.requiredString(input, "value", 1024 * 1024)); return new JSONObject().put("ok", true); }
        if ("secret.remove".equals(operation)) { secrets.remove(JsonSafety.requiredString(input, "key", 256)); return new JSONObject().put("ok", true); }
        if ("model.cancel".equals(operation)) { modelTransport.cancel(JsonSafety.requiredString(input, "requestId", 256)); return new JSONObject().put("ok", true); }
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
                    String id = JsonSafety.requiredString(input, "id", 128);
                    if (!id.matches("[A-Za-z0-9._-]+")) throw new IllegalArgumentException("Invalid story id.");
                    callback.onResult(new JSONObject().put("value", readAssetText("stories/" + id + ".json")));
                    return;
                }
                if ("model.request".equals(operation)) {
                    URI endpoint = URI.create(JsonSafety.requiredString(input, "endpoint", 2048));
                    String apiKey = JsonSafety.optionalString(input, "apiKey", 4096);
                    modelTransport.request(endpoint, apiKey, input, new AndroidModelTransport.Listener() {
                        @Override public void onDelta(String requestId, String text) { try { callback.onResult(new JSONObject().put("requestId", requestId).put("thinkingDelta", text)); } catch (Exception error) { callback.onError(error.getMessage()); } }
                        @Override public void onComplete(JSONObject result) { callback.onResult(result); }
                        @Override public void onError(String requestId, String message) { callback.onError(message); }
                    });
                    return;
                }
                callback.onError("Unsupported asynchronous composition operation: " + operation);
            } catch (Exception error) { callback.onError(error.getMessage() == null ? "Composition operation failed." : error.getMessage()); }
        });
    }

    private JSONObject defaultRoom(String roomId) {
        try {
            return new JSONObject()
                .put("id", roomId)
                .put("title", "Royal Festival")
                .put("mode", "director")
                .put("autoPublish", false)
                .put("phase", "awaiting-player-input")
                .put("revision", 0)
                .put("playerCharacter", new JSONObject().put("name", "Player").put("persona", "A careful observer.").put("currentState", "Just entered the scene."))
                .put("roles", new org.json.JSONArray())
                .put("lore", new org.json.JSONArray())
                .put("scenes", new org.json.JSONArray());
        } catch (Exception error) {
            throw new IllegalStateException("Unable to create the default local room.", error);
        }
    }

    @Override public void close() { modelTransport.close(); }

    private String readAssetText(String path) throws Exception {
        try (InputStream input = context.getAssets().open(path)) {
            byte[] data = StageCraftArchive.readLimited(input, 4 * 1024 * 1024);
            return new String(data, StandardCharsets.UTF_8);
        }
    }
}
