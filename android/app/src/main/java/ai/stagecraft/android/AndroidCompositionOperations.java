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
        // 真实分派层 allowlist 执行（legacy-main-core 迁移期例外封闭集合；翻转后 core-native 在此拒绝）
        String guardRejection = NativeOperationGuardHolder.get(this.context).checkGenericDispatch(operation);
        if (guardRejection != null) throw new IllegalArgumentException("Native operation rejected: " + guardRejection);
        if ("core-state.commit".equals(operation)) {
            repository.saveCoreState(JsonSafety.requiredString(input, "roomId", 256), input.optLong("revision", -1), JsonSafety.requiredObject(input, "state"), JsonSafety.requiredArray(input, "events"), JsonSafety.requiredArray(input, "workflows"));
            return new JSONObject().put("ok", true);
        }
        if ("core-state.restore".equals(operation)) return repository.loadCoreState(JsonSafety.requiredString(input, "roomId", 256));
        if ("stagecraft.room.get".equals(operation)) {
            String roomId = JsonSafety.requiredString(input, "roomId", 256);
            JSONObject room = repository.getRoom(roomId);
            if (room == null || isLegacyPlaceholder(room)) {
                room = defaultRoom(roomId);
                repository.saveRoom(room);
            }
            return room;
        }
        if ("stories.list".equals(operation)) {
            org.json.JSONArray result = new org.json.JSONArray();
            java.util.HashSet<String> ids = new java.util.HashSet<>();
            String[] files = context.getAssets().list("stories/default");
            if (files != null) for (String file : files) {
                if (!file.endsWith(".json")) continue;
                String id = file.substring(0, file.length() - 5);
                try { JSONObject story = new JSONObject(readAssetText("stories/default/" + file)); result.put(new JSONObject().put("id", id).put("title", story.optString("title", id)).put("mode", story.optString("mode", "director")).put("custom", false)); ids.add(id); } catch (Exception ignore) { }
            }
            for (JSONObject story : repository.listRecords("story-packages")) {
                String id = story.optString("id", "");
                if (!id.isEmpty() && !ids.contains(id)) result.put(new JSONObject().put("id", id).put("title", story.optString("title", id)).put("mode", story.optString("mode", "director")).put("custom", true));
            }
            return new JSONObject().put("stories", result);
        }
        if ("preset.list".equals(operation)) { org.json.JSONArray presets = new org.json.JSONArray(); for (JSONObject preset : repository.listRecords("prompt-presets")) presets.put(preset); JSONObject meta = repository.getRecord("prompt-meta", "active-by-scope"); JSONObject activeByScope = meta == null ? null : meta.optJSONObject("value"); return new JSONObject().put("presets", presets).put("activeByScope", activeByScope == null ? new JSONObject() : activeByScope); }
        if ("prompt.gameplay.list".equals(operation)) {
            // R7/R8/R9：gameplay 场景从打包 assets/web/gameplay/*.json 读取。
            // R8：有界循环读取（≤256KB）。R9：区分语义——
            //   目录/资产缺失 → 空态（前端按空处理）；
            //   发现但内容损坏/超大 → 明确抛错（拒绝该资产，外层转 400），不静默吞掉。
            JSONObject scenarios = new JSONObject();
            String[] files = null;
            try {
                files = context.getAssets().list("web/gameplay");
            } catch (Exception missing) {
                return new JSONObject().put("gameplayScenarios", new JSONObject()); // 目录缺失：空态
            }
            if (files != null) {
                for (String file : files) {
                    if (!file.endsWith(".json")) continue;
                    String scope = file.substring(0, file.length() - 5);
                    try (java.io.InputStream assetInput = context.getAssets().open("web/gameplay/" + file)) {
                        java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
                        byte[] chunk = new byte[8192];
                        int total = 0;
                        int read;
                        while ((read = assetInput.read(chunk)) >= 0) {
                            total += read;
                            if (total > 256 * 1024) throw new IllegalArgumentException("gameplay 资产过大: " + file);
                            buffer.write(chunk, 0, read);
                        }
                        if (total == 0) continue; // 空资产跳过
                        try {
                            scenarios.put(scope, new JSONObject(new String(buffer.toByteArray(), java.nio.charset.StandardCharsets.UTF_8)));
                        } catch (org.json.JSONException malformed) {
                            // R9：内容损坏 → 明确拒绝该资产（不静默吞掉）
                            throw new IllegalArgumentException("gameplay 资产 JSON 损坏: " + file + " (" + malformed.getMessage() + ")");
                        }
                    } catch (java.io.IOException openFailed) {
                        // 单个资产打开失败：记录并跳过（该文件缺失等价空态；不阻断其他场景）
                        AppLog.w("gameplay asset open failed: " + file);
                    }
                }
            }
            return new JSONObject().put("gameplayScenarios", scenarios);
        }
        if ("preset.active-scope.set".equals(operation)) { JSONObject activeByScope = JsonSafety.requiredObject(input, "activeByScope"); repository.putRecord("prompt-meta", "active-by-scope", new JSONObject().put("value", activeByScope)); return new JSONObject().put("ok", true); }
        if ("preset.save".equals(operation)) { JSONObject preset = JsonSafety.requiredObject(input, "preset"); String id = JsonSafety.requiredString(preset, "id", 256); repository.putRecord("prompt-presets", id, preset); return new JSONObject().put("ok", true).put("preset", preset); }
        if ("preset.delete".equals(operation)) { String id = JsonSafety.requiredString(input, "id", 256); if (!repository.deleteRecord("prompt-presets", id)) throw new IllegalArgumentException("预设不存在或已删除。"); return new JSONObject().put("ok", true).put("id", id); }
        if ("story.create".equals(operation)) {
            String title = input.optString("title", "未命名剧本").trim();
            if (title.isEmpty()) title = "未命名剧本";
            String id = input.optString("id", "story-" + System.currentTimeMillis()).trim();
            validateStoryId(id);
            JSONObject story = new JSONObject()
                .put("id", id)
                .put("title", title)
                .put("opening", input.optString("opening", title + "：一个全新的故事即将展开。"))
                .put("sceneTime", input.optString("sceneTime", "第一日黄昏"))
                .put("sceneLocation", input.optString("sceneLocation", "未知地点"))
                .put("playerCharacter", new JSONObject().put("name", "玩家").put("persona", "由玩家自由定义的参与者。").put("currentState", "刚刚进入当前场景。"))
                .put("roles", new org.json.JSONArray().put(new JSONObject().put("id", "guide").put("name", "向导").put("portraitRef", "/assets/default.svg").put("currentState", "刚刚进入当前场景。等待玩家行动。 ").put("presence", "present").put("selfModel", "一位介绍当前世界与背景的向导。")))
                .put("lore", new org.json.JSONArray());
            repository.putRecord("story-packages", id, story);
            return new JSONObject().put("ok", true).put("id", id).put("title", title);
        }
        if ("story.save".equals(operation)) { JSONObject story = JsonSafety.requiredObject(input, "story"); validateStoryId(story.optString("id")); repository.putRecord("story-packages", story.getString("id"), story); return new JSONObject().put("ok", true).put("id", story.getString("id")); }
        if ("story.saveAs".equals(operation)) { JSONObject story = JsonSafety.requiredObject(input, "story"); String id = JsonSafety.requiredString(input, "id", 128); validateStoryId(id); story.put("id", id); if (input.has("title")) story.put("title", JsonSafety.requiredString(input, "title", 512)); repository.putRecord("story-packages", id, story); return new JSONObject().put("ok", true).put("id", id).put("title", story.optString("title", id)); }
        if ("story.read".equals(operation)) { String id = JsonSafety.requiredString(input, "id", 128); validateStoryId(id); return new JSONObject().put("value", readStoryText(id)); }
        if ("story.delete".equals(operation)) { String id = JsonSafety.requiredString(input, "id", 128); validateStoryId(id); if ("eldoria".equals(id)) throw new IllegalArgumentException("默认剧本不可删除。"); if (!repository.deleteRecord("story-packages", id)) throw new IllegalArgumentException("剧本不存在或已删除。"); return new JSONObject().put("ok", true).put("id", id); }
        if ("archive.save".equals(operation)) { String name = JsonSafety.requiredString(input, "name", 256); validateArchiveName(name); JSONObject archive = new JSONObject(JsonSafety.requiredObject(input, "archive").toString()).put("name", name); repository.putRecord("archives", name, archive); return new JSONObject().put("ok", true).put("name", name); }
        if ("archive.list".equals(operation)) { org.json.JSONArray names = new org.json.JSONArray(); for (JSONObject archive : repository.listRecords("archives")) names.put(archive.optString("name", "")); return new JSONObject().put("files", names); }
        if ("archive.load".equals(operation)) { String name = JsonSafety.requiredString(input, "name", 256); validateArchiveName(name); JSONObject archive = repository.getRecord("archives", name); if (archive == null) throw new IllegalArgumentException("存档不存在。"); return archive; }
        if ("archive.delete".equals(operation)) { String name = JsonSafety.requiredString(input, "name", 256); validateArchiveName(name); if (!repository.deleteRecord("archives", name)) throw new IllegalArgumentException("存档不存在或已删除。"); return new JSONObject().put("ok", true).put("name", name); }
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

    public byte[] exportStoryArchive(String id) throws Exception {
        validateStoryId(id);
        JSONObject readResult = (JSONObject) invokeSync("story.read", new JSONObject().put("id", id));
        String storyText = readResult.optString("value", "");
        if (storyText.isEmpty()) throw new IllegalStateException("剧本内容为空。");
        java.util.Map<String, byte[]> entries = new java.util.LinkedHashMap<>();
        entries.put("manifest.json", "{\"format\":\"stagecraft-story\",\"version\":1,\"storyFile\":\"story.json\",\"assetRoot\":\"assets/\"}".getBytes(StandardCharsets.UTF_8));
        JSONObject portableStory = new JSONObject(storyText); rewritePortraitRefsForExport(portableStory, id);
        entries.put("story.json", portableStory.toString(2).getBytes(StandardCharsets.UTF_8));
        collectPackagedStoryAssets("stories/default/" + id + ".assets", "", entries);
        collectPackagedStoryAssets("stories/custom/" + id + ".assets", "", entries);
        for (java.util.Map.Entry<String, byte[]> asset : repository.listAssets("/story-assets/" + id + "/").entrySet()) {
            String name = asset.getKey().substring(("/story-assets/" + id + "/").length());
            if (!name.isEmpty() && !name.contains("..") && !name.contains("\\") && name.matches("(?i).+\\.(png|jpe?g|webp|gif|svg)$")) entries.put("assets/" + name, asset.getValue());
        }
        return StageCraftArchive.exportEntries(entries);
    }

    private void collectPackagedStoryAssets(String directory, String relative, java.util.Map<String, byte[]> entries) throws Exception {
        String[] names; try { names = context.getAssets().list(directory + (relative.isEmpty() ? "" : "/" + relative)); } catch (java.io.IOException error) { return; }
        if (names == null) return;
        for (String name : names) { String child = relative.isEmpty() ? name : relative + "/" + name; String path = directory + "/" + child; String[] nested = context.getAssets().list(path); if (nested != null && nested.length > 0) collectPackagedStoryAssets(directory, child, entries); else if (child.matches("(?i).+\\.(png|jpe?g|webp|gif|svg)$")) try (InputStream input = context.getAssets().open(path)) { entries.put("assets/" + child, StageCraftArchive.readLimited(input, 64 * 1024 * 1024)); } }
    }

    private static void rewritePortraitRefsForExport(Object value, String id) throws Exception {
        if (value instanceof JSONObject) { JSONObject object = (JSONObject) value; java.util.Iterator<String> keys = object.keys(); while (keys.hasNext()) { String key = keys.next(); Object item = object.opt(key); if ("portraitRef".equals(key) && item instanceof String) { String prefix = "/story-assets/" + id + "/"; if (((String) item).startsWith(prefix)) object.put(key, "assets/" + ((String) item).substring(prefix.length())); } else rewritePortraitRefsForExport(item, id); } }
        else if (value instanceof org.json.JSONArray) { org.json.JSONArray array = (org.json.JSONArray) value; for (int i = 0; i < array.length(); i++) rewritePortraitRefsForExport(array.opt(i), id); }
    }

    public JSONObject importStoryArchive(InputStream input) throws Exception {
        java.util.Map<String, byte[]> entries = StageCraftArchive.importEntries(input);
        byte[] manifestBytes = entries.get("manifest.json"), storyBytes = entries.get("story.json");
        if (manifestBytes == null || storyBytes == null) throw new IllegalArgumentException("剧本包缺少 manifest.json 或 story.json。");
        JSONObject manifest = new JSONObject(new String(manifestBytes, StandardCharsets.UTF_8));
        if (!"stagecraft-story".equals(manifest.optString("format")) || manifest.optInt("version") != 1 || !"story.json".equals(manifest.optString("storyFile")) || !"assets/".equals(manifest.optString("assetRoot"))) throw new IllegalArgumentException("剧本包格式或版本不受支持。");
        String id = "story-" + Long.toString(System.currentTimeMillis(), 36); validateStoryId(id);
        JSONObject story = new JSONObject(new String(storyBytes, StandardCharsets.UTF_8)); story.put("id", id); validateImportedStory(story); rewritePortraitRefs(story, id);
        java.util.Map<String, byte[]> assets = new java.util.LinkedHashMap<>();
        for (java.util.Map.Entry<String, byte[]> item : entries.entrySet()) if (item.getKey().startsWith("assets/")) { String name = item.getKey().substring(7); if (name.isEmpty() || !name.matches("(?i).+\\.(png|jpe?g|webp|gif|svg)$")) throw new IllegalArgumentException("剧本包包含不支持的资源类型。"); assets.put(name, item.getValue()); }
        repository.importStory(id, story, assets); return new JSONObject().put("ok", true).put("id", id).put("title", story.getString("title"));
    }

    private static void validateImportedStory(JSONObject story) throws Exception {
        JsonSafety.requiredString(story, "id", 128); JsonSafety.requiredString(story, "title", 512); JsonSafety.requiredString(story, "opening", 1024 * 1024);
        JSONObject player = JsonSafety.requiredObject(story, "playerCharacter"); JsonSafety.requiredString(player, "name", 512); JsonSafety.requiredString(player, "persona", 1024 * 1024); JsonSafety.requiredString(player, "currentState", 1024 * 1024);
        org.json.JSONArray roles = JsonSafety.requiredArray(story, "roles"); if (roles.length() > 256) throw new IllegalArgumentException("剧本角色列表无效。"); java.util.Set<String> ids = new java.util.HashSet<>();
        for (int i = 0; i < roles.length(); i++) { JSONObject role = roles.getJSONObject(i); String roleId = JsonSafety.requiredString(role, "id", 128); if (!ids.add(roleId)) throw new IllegalArgumentException("剧本包含重复角色 ID。"); JsonSafety.requiredString(role, "name", 512); JsonSafety.requiredString(role, "portraitRef", 2048); JsonSafety.requiredString(role, "currentState", 1024 * 1024); JsonSafety.requiredString(role, "selfModel", 1024 * 1024); if (!java.util.Arrays.asList("present", "absent", "unavailable").contains(role.optString("presence"))) throw new IllegalArgumentException("剧本角色在场状态无效。"); }
    }

    private static void rewritePortraitRefs(Object value, String id) throws Exception {
        if (value instanceof JSONObject) { JSONObject object = (JSONObject) value; java.util.Iterator<String> keys = object.keys(); while (keys.hasNext()) { String key = keys.next(); Object item = object.opt(key); if ("portraitRef".equals(key) && item instanceof String) { String ref = (String) item; if (ref.startsWith("assets/")) object.put(key, "/story-assets/" + id + "/" + ref.substring(7)); else if (ref.startsWith("/story-assets/")) { int slash = ref.indexOf('/', "/story-assets/".length()); if (slash >= 0) object.put(key, "/story-assets/" + id + ref.substring(slash)); } } else rewritePortraitRefs(item, id); } }
        else if (value instanceof org.json.JSONArray) { org.json.JSONArray array = (org.json.JSONArray) value; for (int i = 0; i < array.length(); i++) rewritePortraitRefs(array.opt(i), id); }
    }

    @Override public void invoke(String operation, JSONObject input, Callback callback) {
        executor.execute(() -> {
            try {
                if ("story.read".equals(operation)) {
                    String id = JsonSafety.requiredString(input, "id", 128);
                    validateStoryId(id);
                    callback.onResult(new JSONObject().put("value", readStoryText(id)));
                    return;
                }
                if ("model.request".equals(operation)) {
                    URI endpoint = URI.create(JsonSafety.requiredString(input, "endpoint", 2048));
                    String apiKey = JsonSafety.optionalString(input, "apiKey", 4096);
                    modelTransport.request(endpoint, apiKey, input, new AndroidModelTransport.Listener() {
                        @Override public void onStreamEvent(String requestId, String payload) { try { callback.onResult(new JSONObject().put("requestId", requestId).put("streamPayload", payload)); } catch (Exception error) { callback.onError(error.getMessage()); } }
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
        if ("setRoomConfig".equals(method)) { JSONObject config = JsonSafety.objectArg(args, 1); if (config.has("mode")) { String mode = config.getString("mode"); if (!"director".equals(mode) && !"chat".equals(mode)) throw new IllegalArgumentException("Invalid room mode."); room.put("mode", mode); } if (config.has("autoPublish")) room.put("autoPublish", config.getBoolean("autoPublish")); if (config.has("speechMode")) { String speechMode = config.getString("speechMode"); if (!"manual".equals(speechMode) && !"director".equals(speechMode) && !"all".equals(speechMode)) throw new IllegalArgumentException("Invalid chat speech mode."); room.put("speechMode", speechMode); } if (config.has("hidePlayerSpeech")) room.put("hidePlayerSpeech", config.getBoolean("hidePlayerSpeech")); room.put("revision", room.optLong("revision") + 1); return JSONObject.NULL; }
        if ("setRoomPhase".equals(method)) { room.put("phase", JsonSafety.stringArg(args, 1, 96)); bump(room); return JSONObject.NULL; }
        if ("updateScene".equals(method)) { JSONObject update = JsonSafety.objectArg(args, 1); if (update.has("time")) room.put("sceneTime", update.getString("time")); if (update.has("location")) room.put("sceneLocation", update.getString("location")); room.put("revision", room.optLong("revision") + 1); return JSONObject.NULL; }
        if ("saveLore".equals(method)) { room.put("lore", JsonSafety.arrayArg(args, 1)); room.put("revision", room.optLong("revision") + 1); return JSONObject.NULL; }
        if ("createTurn".equals(method)) { String id = JsonSafety.stringArg(args, 1, 256); org.json.JSONArray turns = array(room, "turns"); turns.put(id); room.put("decisions", JsonSafety.arrayArg(args, 3)); room.put("playerContribution", JsonSafety.stringArg(args, 2, 1024 * 1024)); room.put("phase", args.length() > 4 ? args.optString(4, "collecting-decisions") : "collecting-decisions"); bump(room); return JSONObject.NULL; }
        if ("saveDecision".equals(method)) { JSONObject decision = JsonSafety.objectArg(args, 1); org.json.JSONArray decisions = array(room, "decisions"); replaceBy(decisions, "roleId", decision.optString("roleId"), decision); return JSONObject.NULL; }
        if ("saveReactionPreview".equals(method)) { JSONObject p = new JSONObject().put("turnId", JsonSafety.stringArg(args, 1, 256)).put("roleId", JsonSafety.stringArg(args, 2, 256)).put("text", JsonSafety.stringArg(args, 3, 1024 * 1024)).put("createdAt", now()); replaceBy(array(room, "reactions"), "roleId", p.optString("roleId"), p); return JSONObject.NULL; }
        if ("transitionToDrafting".equals(method)) { room.put("phase", "drafting"); bump(room); return JSONObject.NULL; }
        if ("saveDraft".equals(method)) { room.put("draft", JsonSafety.objectArg(args, 1)); room.put("phase", "awaiting-approval"); bump(room); return JSONObject.NULL; }
        if ("rejectDraft".equals(method)) { room.remove("draft"); room.remove("playerContribution"); room.put("phase", "awaiting-player-input"); bump(room); return JSONObject.NULL; }
        if ("saveSpeech".equals(method)) { room.put("speech", JsonSafety.objectArg(args, 1)); room.put("phase", "awaiting-approval"); bump(room); return JSONObject.NULL; }
        if ("rejectSpeech".equals(method)) { JSONObject speech = room.optJSONObject("speech"); if (speech == null) throw new IllegalArgumentException("No speech awaiting rejection."); room.remove("speech"); room.remove("playerContribution"); room.put("phase", "awaiting-player-input"); bump(room); return speech; }
        if ("approveSpeech".equals(method)) { JSONObject speech = room.optJSONObject("speech"); if (speech == null) throw new IllegalArgumentException("No speech awaiting approval."); addScene(room, JsonSafety.stringArg(args, 1, 1024 * 1024), speech.optString("roleId"), speech.optString("turnId"), "dialogue"); room.remove("speech"); room.remove("playerContribution"); room.put("phase", "awaiting-player-input"); bump(room); return JSONObject.NULL; }
        if ("addPlayerScene".equals(method) || "addNarrationScene".equals(method)) { addScene(room, JsonSafety.stringArg(args, 1, 1024 * 1024), "addPlayerScene".equals(method) ? "player" : null, "scene", "addPlayerScene".equals(method) ? "player" : "narration"); bump(room); return JSONObject.NULL; }
        if ("saveWorldChange".equals(method)) { String id = "world-change-" + System.nanoTime(); room.put("pendingWorldChange", JsonSafety.objectArg(args, 1)); room.put("pendingWorldChangeId", id); room.put("phase", "world-change-approval"); bump(room); return id; }
        if ("approveWorldChange".equals(method)) {
            // 与桌面 store.applyWorldChangeLocked 对齐：批准世界变更须落地场景时间/地点、
            // 新建角色提议、角色进离场与角色状态，而不只是清空 pending（原实现只清 pending）。
            JSONObject change = room.optJSONObject("pendingWorldChange");
            if (change != null) {
                if (change.has("sceneTime") && !change.optString("sceneTime", "").trim().isEmpty()) room.put("sceneTime", change.optString("sceneTime").trim());
                if (change.has("sceneLocation") && !change.optString("sceneLocation", "").trim().isEmpty()) room.put("sceneLocation", change.optString("sceneLocation").trim());
                org.json.JSONArray roles = array(room, "roles");
                org.json.JSONArray proposals = change.optJSONArray("roleProposals");
                if (proposals != null) {
                    for (int i = 0; i < proposals.length(); i++) {
                        JSONObject proposal = proposals.optJSONObject(i);
                        if (proposal == null) continue;
                        String id = proposal.optString("id", "");
                        String name = proposal.optString("name", "");
                        String currentState = proposal.optString("currentState", "");
                        String selfModel = proposal.optString("selfModel", "");
                        if (id.isEmpty() || name.isEmpty() || currentState.isEmpty() || selfModel.isEmpty()) continue;
                        if (find(roles, "id", id) != null) continue;
                        JSONObject role = new JSONObject()
                            .put("id", id).put("name", name)
                            .put("portraitRef", proposal.optString("portraitRef", "/assets/default.svg"))
                            .put("currentState", currentState)
                            .put("presence", proposal.optString("presence", "present"))
                            .put("selfModel", selfModel);
                        org.json.JSONArray memories = proposal.optJSONArray("memories");
                        if (memories != null) role.put("memories", new org.json.JSONArray(memories.toString()));
                        roles.put(role);
                    }
                }
                org.json.JSONArray presenceChanges = change.optJSONArray("rolePresence");
                if (presenceChanges != null) {
                    for (int i = 0; i < presenceChanges.length(); i++) {
                        JSONObject item = presenceChanges.optJSONObject(i);
                        if (item == null) continue;
                        String presence = item.optString("presence", "");
                        if (!"present".equals(presence) && !"absent".equals(presence) && !"unavailable".equals(presence)) continue;
                        JSONObject role = find(roles, "id", item.optString("roleId", ""));
                        if (role != null) role.put("presence", presence);
                    }
                }
                JSONObject roleStates = change.optJSONObject("roleStates");
                if (roleStates != null) {
                    for (java.util.Iterator<String> keys = roleStates.keys(); keys.hasNext(); ) {
                        String roleId = keys.next();
                        String currentState = roleStates.optString(roleId, "");
                        if (currentState.trim().isEmpty()) continue;
                        JSONObject role = find(roles, "id", roleId);
                        if (role != null) role.put("currentState", currentState.trim());
                    }
                }
            }
            String id = room.optString("pendingWorldChangeId", "");
            room.remove("pendingWorldChange"); room.remove("pendingWorldChangeId"); room.put("phase", "awaiting-player-input"); bump(room); return id.isEmpty() ? JSONObject.NULL : id;
        }
        if ("rejectWorldChange".equals(method)) { room.remove("pendingWorldChange"); room.remove("pendingWorldChangeId"); room.put("phase", "awaiting-player-input"); bump(room); return JSONObject.NULL; }
        if ("publish".equals(method)) { JSONObject draft = room.optJSONObject("draft"); if (draft == null) throw new IllegalArgumentException("Draft is no longer available."); String turnId = draft.optString("turnId", "turn"); String contribution = room.optString("playerContribution", ""); if (contribution != null && !contribution.trim().isEmpty()) addScene(room, contribution, "player", turnId, "player"); addScene(room, JsonSafety.stringArg(args, 2, 1024 * 1024), null, turnId, "narration"); room.remove("draft"); room.remove("playerContribution"); room.put("phase", "awaiting-player-input"); bump(room); return JSONObject.NULL; }
        if ("restartRoom".equals(method)) {
            JSONObject story = JsonSafety.objectArg(args, 1);
            JSONObject initialized = roomFromStory(room.optString("id"), story);
            if (args.length() > 2 && !args.isNull(2)) {
                JSONObject options = JsonSafety.objectArg(args, 2);
                if ("chat".equals(options.optString("mode")) || "director".equals(options.optString("mode"))) initialized.put("mode", options.getString("mode"));
                if (options.has("autoPublish")) initialized.put("autoPublish", options.getBoolean("autoPublish"));
            }
            java.util.Iterator<String> keys = room.keys();
            java.util.ArrayList<String> existingKeys = new java.util.ArrayList<>();
            while (keys.hasNext()) existingKeys.add(keys.next());
            for (String key : existingKeys) room.remove(key);
            java.util.Iterator<String> initializedKeys = initialized.keys();
            while (initializedKeys.hasNext()) { String key = initializedKeys.next(); room.put(key, initialized.get(key)); }
            return JSONObject.NULL;
        }
        if ("failRoom".equals(method)) { room.put("lastError", JsonSafety.stringArg(args, 1, 1024 * 1024)); bump(room); return JSONObject.NULL; }
        if ("cancelTurn".equals(method)) { room.put("phase", "awaiting-player-input"); room.remove("speech"); room.remove("draft"); room.remove("playerContribution"); bump(room); return JSONObject.NULL; }
        if ("restartRoom".equals(method)) { room.put("phase", "awaiting-player-input"); room.remove("speech"); room.remove("draft"); room.remove("pendingWorldChange"); room.remove("pendingWorldChangeId"); room.put("decisions", new org.json.JSONArray()); room.put("turns", new org.json.JSONArray()); room.put("reactions", new org.json.JSONArray()); room.put("consultations", new org.json.JSONArray()); bump(room); return JSONObject.NULL; }
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
        if ("reorderRoles".equals(method)) { org.json.JSONArray ordered = JsonSafety.arrayArg(args, 1); org.json.JSONArray current = array(room, "roles"); org.json.JSONArray next = new org.json.JSONArray(); for (int i = 0; i < ordered.length(); i++) { JSONObject role = find(current, "id", ordered.optString(i, "")); if (role != null) { next.put(role); current.remove(indexOf(current, role)); } } for (int i = 0; i < current.length(); i++) next.put(current.opt(i)); room.put("roles", next); bump(room); return JSONObject.NULL; }
        if (method.contains("Memory")) { JSONObject role = find(roles, "id", JsonSafety.stringArg(args, 1, 256)); if (role == null) throw new IllegalArgumentException("Role not found."); org.json.JSONArray memories = array(role, "memories"); String memoryId = args.length() > 2 && !args.isNull(2) ? args.optString(2, "") : ""; if ("insertNpcMemories".equals(method)) role.put("memories", JsonSafety.arrayArg(args, 2)); else if ("reorderNpcMemories".equals(method)) role.put("memories", JsonSafety.arrayArg(args, 2)); else if ("retractNpcMemory".equals(method)) { JSONObject found = find(memories, "id", memoryId); if (found != null) memories.remove(indexOf(memories, found)); } else if ("supersedeNpcMemory".equals(method)) { JSONObject replacement = JsonSafety.objectArg(args, 2); if (memoryId.isEmpty()) memoryId = replacement.optString("id", ""); JSONObject found = find(memories, "id", memoryId); if (found != null) { int at = indexOf(memories, found); memories.put(at, replacement); } else memories.put(replacement); } else if ("updateNpcMemory".equals(method)) { JSONObject found = find(memories, "id", memoryId); if (found != null) { JSONObject patch = JsonSafety.objectArg(args, 2); for (java.util.Iterator<String> keys = patch.keys(); keys.hasNext(); ) { String key = keys.next(); found.put(key, patch.get(key)); } } } bump(room); return JSONObject.NULL; }
        throw new IllegalArgumentException("Unsupported role operation: " + method);
    }

    private static org.json.JSONArray array(JSONObject o, String key) throws Exception { org.json.JSONArray a = o.optJSONArray(key); if (a == null) { a = new org.json.JSONArray(); o.put(key, a); } return a; }
    private static JSONObject find(org.json.JSONArray a, String key, String value) { for (int i=0;i<a.length();i++) { JSONObject o=a.optJSONObject(i); if (o!=null && value.equals(o.optString(key))) return o; } return null; }
    private static int indexOf(org.json.JSONArray a, JSONObject value) { for(int i=0;i<a.length();i++) if(a.optJSONObject(i)==value) return i; return -1; }
    private static void replaceBy(org.json.JSONArray a,String key,String value,JSONObject next) throws Exception { JSONObject old=find(a,key,value); if(old==null)a.put(next); else { int i=indexOf(a,old); a.put(i,next); } }
    private static void addScene(JSONObject room, String text, String speaker, String turnId, String kind) throws Exception { JSONObject s = new JSONObject().put("id", "scene-" + System.nanoTime()).put("turnId", turnId).put("text", text).put("createdAt", now()); if (speaker != null) s.put("speaker", speaker); if (kind != null) s.put("kind", kind); array(room, "scenes").put(s); }
    private static void bump(JSONObject room) throws Exception { room.put("revision", room.optLong("revision") + 1); }
    private static String now() { return new java.util.Date().toInstant().toString(); }

    private static boolean isLegacyPlaceholder(JSONObject room) {
        return "Royal Festival".equals(room.optString("title")) || ("eldoria".equals(room.optString("storyId")) && room.optJSONArray("roles") != null && find(room.optJSONArray("roles"), "id", "aria") != null);
    }

    private JSONObject defaultRoom(String roomId) {
        try { return roomFromStory(roomId, new JSONObject(readStoryText("eldoria"))); }
        catch (Exception error) { throw new IllegalStateException("Unable to create the default local room.", error); }
    }

    private JSONObject roomFromStory(String roomId, JSONObject story) throws Exception {
        String storyId = story.optString("id", "eldoria");
        validateStoryId(storyId);
        return new JSONObject()
            .put("id", roomId)
            .put("title", story.optString("title", storyId))
            .put("storyId", storyId)
            .put("mode", "director")
            .put("speechMode", "manual")
            .put("hidePlayerSpeech", false)
            .put("autoPublish", false)
            .put("phase", "awaiting-player-input")
            .put("revision", 0)
            .put("playerCharacter", story.optJSONObject("playerCharacter") == null ? new JSONObject().put("name", "玩家").put("persona", "由玩家自由定义的参与者。").put("currentState", "刚刚进入当前场景。") : new JSONObject(story.getJSONObject("playerCharacter").toString()))
            .put("roles", story.optJSONArray("roles") == null ? new org.json.JSONArray() : new org.json.JSONArray(story.getJSONArray("roles").toString()))
            .put("lore", story.optJSONArray("lore") == null ? new org.json.JSONArray() : new org.json.JSONArray(story.getJSONArray("lore").toString()))
            .put("sceneTime", story.optString("sceneTime", "第一日黄昏"))
            .put("sceneLocation", story.optString("sceneLocation", "未知地点"))
            .put("scenes", new org.json.JSONArray().put(new JSONObject().put("id", "opening-" + roomId).put("turnId", "opening").put("text", story.optString("opening", "")).put("kind", "narration").put("createdAt", now())))
            .put("consultations", new org.json.JSONArray())
            .put("reactions", new org.json.JSONArray())
            .put("decisions", new org.json.JSONArray());
    }

    @Override public void close() { modelTransport.close(); }

    private String readAssetText(String path) throws Exception {
        try (InputStream input = context.getAssets().open(path)) {
            byte[] data = StageCraftArchive.readLimited(input, 4 * 1024 * 1024);
            return new String(data, StandardCharsets.UTF_8);
        }
    }

    private static void validateArchiveName(String name) {
        if (name == null || name.isEmpty() || name.length() > 256 || name.contains("..") || name.indexOf('/') >= 0 || name.indexOf('\\') >= 0) throw new IllegalArgumentException("Invalid archive name.");
    }

    private static void validateStoryId(String id) {
        if (id == null || id.isEmpty() || id.length() > 128 || id.contains("..") || id.indexOf('/') >= 0 || id.indexOf('\\') >= 0) throw new IllegalArgumentException("Invalid story id.");
        for (int index = 0; index < id.length(); index++) if (Character.isISOControl(id.charAt(index))) throw new IllegalArgumentException("Invalid story id.");
    }

    /** Built-in stories are read-only assets; user stories live in the app-private database. */
    private String readStoryText(String id) throws Exception {
        validateStoryId(id);
        JSONObject custom = repository.getRecord("story-packages", id);
        if (custom != null) return custom.toString();
        return readAssetText("stories/default/" + id + ".json");
    }
}
