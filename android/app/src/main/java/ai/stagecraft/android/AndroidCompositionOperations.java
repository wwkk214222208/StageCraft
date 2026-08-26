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

    @Override public Object invokeSync(String operation, JSONObject input) throws Exception {
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
        if ("story.read".equals(operation)) {
            String id = JsonSafety.requiredString(input, "id", 128);
            if (!id.matches("[A-Za-z0-9._-]+")) throw new IllegalArgumentException("Invalid story id.");
            return new JSONObject().put("value", readStoryAsset(id));
        }
        if ("stagecraft.repository".equals(operation)) return dispatchRepository(input);
        if ("asset.read".equals(operation)) {
            String path = JsonSafety.requiredString(input, "path", 512); JsonSafety.path(path);
            byte[] data = repository.getAsset(path);
            return data == null ? new JSONObject().put("found", false) : new JSONObject().put("found", true).put("data", Base64.encodeToString(data, Base64.NO_WRAP));
        }
        if ("asset.write".equals(operation)) {
            String path = JsonSafety.requiredString(input, "path", 512); JsonSafety.path(path); String encoded = JsonSafety.requiredString(input, "data", 16 * 1024 * 1024);
            if (!encoded.matches("[A-Za-z0-9+/]*={0,2}") || (encoded.length() & 3) != 0) throw new IllegalArgumentException("Invalid asset encoding.");
            byte[] decoded = Base64.decode(encoded, Base64.DEFAULT);
            if (decoded.length > 12 * 1024 * 1024) throw new IllegalArgumentException("Asset is too large.");
            repository.putAsset(path, JsonSafety.optionalString(input, "contentType", 128), decoded);
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
                    callback.onResult(new JSONObject().put("value", readStoryAsset(id)));
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

    private Object dispatchRepository(JSONObject input) throws Exception {
        String method = JsonSafety.requiredString(input, "method", 96);
        if (!method.matches("[A-Za-z][A-Za-z0-9]{0,95}")) throw new IllegalArgumentException("Invalid repository method.");
        org.json.JSONArray args = JsonSafety.requiredArray(input, "args");
        if (args.toString().length() > 4 * 1024 * 1024) throw new IllegalArgumentException("Repository arguments are too large.");
        if (args.length() == 0) throw new IllegalArgumentException("Repository operation requires arguments.");
        if ("saveDecision".equals(method)) {
            String turnId = JsonSafety.stringArg(args, 0, 256);
            JSONObject decision = JsonSafety.objectArg(args, 1);
            JSONObject room = repository.findRoomForTurn(turnId);
            if (room == null) throw new IllegalArgumentException("Turn not found.");
            repository.mutateRoom(room.optString("id"), value -> { replaceBy(array(value, "decisions"), "roleId", decision.optString("roleId"), decision); return JSONObject.NULL; });
            return JSONObject.NULL;
        }
        String roomId = args.optString(0, null);
        if (roomId == null || roomId.isEmpty() || roomId.length() > 256) throw new IllegalArgumentException("Invalid room id.");
        if ("getLatestTurnId".equals(method)) {
            JSONObject room = repository.getRoom(roomId); if (room == null) throw new IllegalArgumentException("Room not found.");
            org.json.JSONArray turns = room.optJSONArray("turns"); return turns == null || turns.length() == 0 ? JSONObject.NULL : turns.optString(turns.length() - 1);
        }
        if ("listConsultationsForTurn".equals(method)) return listConsultations(roomId, args.optString(1, ""));
        if ("importRoom".equals(method)) {
            JSONObject archive = JsonSafety.objectArg(args, 1);
            JSONObject imported = archive.optJSONObject("room");
            if (imported == null) throw new IllegalArgumentException("Invalid room archive.");
            imported = new JSONObject(imported.toString()).put("id", roomId);
            repository.saveRoom(imported);
            return JSONObject.NULL;
        }
        return repository.mutateRoom(roomId, room -> applyRepositoryMutation(room, method, args));
    }

    private Object listConsultations(String roomId, String turnId) throws Exception {
        JSONObject room = repository.getRoom(roomId); if (room == null) throw new IllegalArgumentException("Room not found.");
        org.json.JSONArray all = room.optJSONArray("consultations"); org.json.JSONArray result = new org.json.JSONArray();
        if (all != null) for (int i = 0; i < all.length(); i++) { JSONObject item = all.optJSONObject(i); if (item != null && (turnId.isEmpty() || turnId.equals(item.optString("turnId", "")))) result.put(item); }
        return result;
    }

    private Object applyRepositoryMutation(JSONObject room, String method, org.json.JSONArray args) throws Exception {
        if ("setContribution".equals(method)) { room.put("playerContribution", JsonSafety.stringArg(args, 1, 1024 * 1024)); room.put("revision", room.optLong("revision") + 1); return JSONObject.NULL; }
        if ("updatePlayerCharacter".equals(method)) { room.put("playerCharacter", JsonSafety.objectArg(args, 1)); room.put("revision", room.optLong("revision") + 1); return JSONObject.NULL; }
        if ("setRoomConfig".equals(method)) { JSONObject config = JsonSafety.objectArg(args, 1); if (config.has("mode")) { String mode = config.getString("mode"); if (!"director".equals(mode) && !"chat".equals(mode)) throw new IllegalArgumentException("Invalid room mode."); room.put("mode", mode); } if (config.has("autoPublish")) room.put("autoPublish", config.getBoolean("autoPublish")); room.put("revision", room.optLong("revision") + 1); return JSONObject.NULL; }
        if ("updateScene".equals(method)) { JSONObject update = JsonSafety.objectArg(args, 1); if (update.has("time")) room.put("sceneTime", update.getString("time")); if (update.has("location")) room.put("sceneLocation", update.getString("location")); room.put("revision", room.optLong("revision") + 1); return JSONObject.NULL; }
        if ("saveLore".equals(method)) { room.put("lore", JsonSafety.arrayArg(args, 1)); room.put("revision", room.optLong("revision") + 1); return JSONObject.NULL; }
        if ("createTurn".equals(method)) { String id = JsonSafety.stringArg(args, 1, 256); org.json.JSONArray turns = array(room, "turns"); turns.put(id); room.put("decisions", JsonSafety.arrayArg(args, 3)); room.put("playerContribution", JsonSafety.stringArg(args, 2, 1024 * 1024)); room.put("phase", args.length() > 4 ? args.optString(4, "collecting-decisions") : "collecting-decisions"); bump(room); return JSONObject.NULL; }
        if ("saveDecision".equals(method)) { JSONObject decision = JsonSafety.objectArg(args, 1); org.json.JSONArray decisions = array(room, "decisions"); replaceBy(decisions, "roleId", decision.optString("roleId"), decision); return JSONObject.NULL; }
        if ("saveReactionPreview".equals(method)) { JSONObject p = new JSONObject().put("turnId", JsonSafety.stringArg(args, 1, 256)).put("roleId", JsonSafety.stringArg(args, 2, 256)).put("text", JsonSafety.stringArg(args, 3, 1024 * 1024)).put("createdAt", now()); replaceBy(array(room, "reactions"), "roleId", p.optString("roleId"), p); return JSONObject.NULL; }
        if ("transitionToDrafting".equals(method)) { room.put("phase", "drafting"); bump(room); return JSONObject.NULL; }
        if ("saveDraft".equals(method)) { room.put("draft", JsonSafety.objectArg(args, 1)); room.put("phase", "awaiting-approval"); bump(room); return JSONObject.NULL; }
        if ("rejectDraft".equals(method)) { room.remove("draft"); room.put("phase", "awaiting-player-input"); bump(room); return JSONObject.NULL; }
        if ("saveSpeech".equals(method)) { room.put("speech", JsonSafety.objectArg(args, 1)); room.put("phase", "awaiting-approval"); bump(room); return JSONObject.NULL; }
        if ("rejectSpeech".equals(method)) { JSONObject speech = room.optJSONObject("speech"); if (speech == null) throw new IllegalArgumentException("No speech awaiting rejection."); room.remove("speech"); room.put("phase", "awaiting-player-input"); bump(room); return speech; }
        if ("approveSpeech".equals(method)) { JSONObject speech = room.optJSONObject("speech"); if (speech == null) throw new IllegalArgumentException("No speech awaiting approval."); addScene(room, JsonSafety.stringArg(args, 1, 1024 * 1024), speech.optString("roleId"), speech.optString("turnId")); room.remove("speech"); room.put("phase", "awaiting-player-input"); bump(room); return JSONObject.NULL; }
        if ("addPlayerScene".equals(method) || "addNarrationScene".equals(method)) { addScene(room, JsonSafety.stringArg(args, 1, 1024 * 1024), "addPlayerScene".equals(method) ? "player" : null, "scene"); bump(room); return JSONObject.NULL; }
        if ("saveWorldChange".equals(method)) { String id = "world-change-" + System.nanoTime(); room.put("pendingWorldChange", JsonSafety.objectArg(args, 1)); room.put("pendingWorldChangeId", id); room.put("phase", "world-change-approval"); bump(room); return id; }
        if ("approveWorldChange".equals(method)) { String id = room.optString("pendingWorldChangeId", ""); room.remove("pendingWorldChange"); room.remove("pendingWorldChangeId"); room.put("phase", "awaiting-player-input"); bump(room); return id.isEmpty() ? JSONObject.NULL : id; }
        if ("rejectWorldChange".equals(method)) { room.remove("pendingWorldChange"); room.remove("pendingWorldChangeId"); room.put("phase", "awaiting-player-input"); bump(room); return JSONObject.NULL; }
        if ("publish".equals(method)) { JSONObject draft = room.optJSONObject("draft"); if (draft == null) throw new IllegalArgumentException("Draft is no longer available."); addScene(room, JsonSafety.stringArg(args, 2, 1024 * 1024), null, draft.optString("turnId", "turn")); room.remove("draft"); room.put("phase", "awaiting-player-input"); bump(room); return JSONObject.NULL; }
        if ("restartRoom".equals(method)) {
            JSONObject story = JsonSafety.objectArg(args, 1);
            room.put("storyId", story.optString("id", room.optString("storyId", "eldoria")));
            room.put("title", story.optString("title", room.optString("title")));
            room.put("roles", story.optJSONArray("roles") == null ? new org.json.JSONArray() : story.getJSONArray("roles"));
            room.put("lore", story.optJSONArray("lore") == null ? new org.json.JSONArray() : story.getJSONArray("lore"));
            room.put("playerCharacter", story.optJSONObject("playerCharacter") == null ? new JSONObject() : story.getJSONObject("playerCharacter"));
            room.put("sceneTime", story.optString("sceneTime", ""));
            room.put("sceneLocation", story.optString("sceneLocation", ""));
            room.put("scenes", new org.json.JSONArray().put(new JSONObject().put("id", "opening-" + room.optString("id")).put("turnId", "opening").put("text", story.optString("opening", "")).put("kind", "narration").put("createdAt", now())));
            room.put("phase", "awaiting-player-input"); room.remove("draft"); room.remove("speech"); bump(room); return JSONObject.NULL;
        }
        if ("failRoom".equals(method)) { room.put("lastError", JsonSafety.stringArg(args, 1, 1024 * 1024)); bump(room); return JSONObject.NULL; }
        if ("cancelTurn".equals(method)) { room.put("phase", "awaiting-player-input"); room.remove("speech"); room.remove("draft"); bump(room); return JSONObject.NULL; }
        if ("setPlayerAvatar".equals(method)) { JSONObject player = room.optJSONObject("playerCharacter"); if (player == null) throw new IllegalArgumentException("Player unavailable."); player.put("portraitRef", JsonSafety.stringArg(args, 1, 1024)); bump(room); return JSONObject.NULL; }
        if (method.startsWith("setRole") || "updateRolePrivateState".equals(method) || "applyRoleImpressions".equals(method) || "createRole".equals(method) || "deleteRole".equals(method) || "reorderRoles".equals(method) || method.contains("NpcMemory")) return applyRoleOrMemory(room, method, args);
        if ("addConsultation".equals(method)) { org.json.JSONArray c = array(room, "consultations"); c.put(new JSONObject().put("role", JsonSafety.stringArg(args, 2, 32)).put("text", JsonSafety.stringArg(args, 3, 1024 * 1024)).put("createdAt", now())); return JSONObject.NULL; }
        if ("startConsultation".equals(method)) { room.put("phase", "consulting-director"); bump(room); return JSONObject.NULL; }
        if ("finishConsultation".equals(method)) { room.put("phase", "awaiting-approval"); bump(room); return JSONObject.NULL; }
        throw new IllegalArgumentException("Unsupported Android repository operation: " + method);
    }

    private Object applyRoleOrMemory(JSONObject room, String method, org.json.JSONArray args) throws Exception {
        org.json.JSONArray roles = array(room, "roles");
        if ("createRole".equals(method)) { JSONObject role = JsonSafety.objectArg(args, 1); if (find(roles, "id", role.optString("id")) != null) throw new IllegalArgumentException("Role already exists."); roles.put(role); bump(room); return JSONObject.NULL; }
        if ("deleteRole".equals(method)) { JSONObject role = find(roles, "id", JsonSafety.stringArg(args, 1, 256)); if (role == null) throw new IllegalArgumentException("Role not found."); roles.remove(indexOf(roles, role)); bump(room); return JSONObject.NULL; }
        if (method.startsWith("setRole") || "updateRolePrivateState".equals(method) || "applyRoleImpressions".equals(method)) { JSONObject role = find(roles, "id", JsonSafety.stringArg(args, 1, 256)); if (role == null) throw new IllegalArgumentException("Role not found."); if ("setRolePresence".equals(method)) role.put("presence", JsonSafety.stringArg(args, 2, 32)); else if ("setRoleAvatar".equals(method)) role.put("portraitRef", JsonSafety.stringArg(args, 2, 1024)); else if ("setRoleCurrentState".equals(method)) role.put("currentState", JsonSafety.stringArg(args, 2, 1024 * 1024)); else if ("setRoleThinking".equals(method)) role.put("thinkingStrength", JsonSafety.stringArg(args, 2, 32)); else if ("updateRolePrivateState".equals(method)) { role.put("selfModel", JsonSafety.stringArg(args, 2, 1024 * 1024)); if (args.length() > 3 && !args.isNull(3)) role.put("memoryTimeline", args.getJSONObject(3)); } else role.put("impressions", JsonSafety.objectArg(args, 2)); bump(room); return JSONObject.NULL; }
        if (method.contains("Memory")) { JSONObject role = find(roles, "id", JsonSafety.stringArg(args, 1, 256)); if (role == null) throw new IllegalArgumentException("Role not found."); if ("insertNpcMemories".equals(method)) role.put("memories", JsonSafety.arrayArg(args, 2)); else if ("reorderNpcMemories".equals(method)) role.put("memories", JsonSafety.arrayArg(args, 2)); bump(room); return JSONObject.NULL; }
        throw new IllegalArgumentException("Unsupported role operation: " + method);
    }

    private static org.json.JSONArray array(JSONObject o, String key) throws Exception { org.json.JSONArray a = o.optJSONArray(key); if (a == null) { a = new org.json.JSONArray(); o.put(key, a); } return a; }
    private static JSONObject find(org.json.JSONArray a, String key, String value) { for (int i=0;i<a.length();i++) { JSONObject o=a.optJSONObject(i); if (o!=null && value.equals(o.optString(key))) return o; } return null; }
    private static int indexOf(org.json.JSONArray a, JSONObject value) { for(int i=0;i<a.length();i++) if(a.optJSONObject(i)==value) return i; return -1; }
    private static void replaceBy(org.json.JSONArray a,String key,String value,JSONObject next) throws Exception { JSONObject old=find(a,key,value); if(old==null)a.put(next); else { int i=indexOf(a,old); a.put(i,next); } }
    private static void addScene(JSONObject room,String text,String speaker,String turnId) throws Exception { JSONObject s=new JSONObject().put("id", "scene-"+System.nanoTime()).put("turnId",turnId).put("text",text).put("createdAt",now()); if(speaker!=null)s.put("speaker",speaker); array(room,"scenes").put(s); }
    private static void bump(JSONObject room) throws Exception { room.put("revision", room.optLong("revision") + 1); }
    private static String now() { return new java.util.Date().toInstant().toString(); }

    private JSONObject defaultRoom(String roomId) {
        try {
            JSONObject story = new JSONObject(readStoryAsset("eldoria"));
            return new JSONObject()
                .put("id", roomId)
                .put("title", story.optString("title", "StageCraft"))
                .put("mode", "director")
                .put("autoPublish", false)
                .put("phase", "awaiting-player-input")
                .put("revision", 0)
                .put("playerCharacter", story.optJSONObject("playerCharacter") == null ? new JSONObject() : story.getJSONObject("playerCharacter"))
                .put("roles", story.optJSONArray("roles") == null ? new org.json.JSONArray() : story.getJSONArray("roles"))
                .put("lore", story.optJSONArray("lore") == null ? new org.json.JSONArray() : story.getJSONArray("lore"))
                .put("sceneTime", story.optString("sceneTime", ""))
                .put("sceneLocation", story.optString("sceneLocation", ""))
                .put("scenes", new org.json.JSONArray().put(new JSONObject().put("id", "opening-" + roomId).put("turnId", "opening").put("text", story.optString("opening", "")).put("kind", "narration").put("createdAt", now())));
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

    private String readStoryAsset(String id) throws Exception {
        try {
            return readAssetText("stories/default/" + id + ".json");
        } catch (Exception missingDefault) {
            return readAssetText("stories/" + id + ".json");
        }
    }
}
