package ai.stagecraft.android;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** SQLite adapter for portable repository snapshots and JSON records. All writes are transactional. */
public final class AndroidSqliteRepository extends SQLiteOpenHelper {
    private static final int VERSION = 2;
    public AndroidSqliteRepository(Context context) { super(context, "stagecraft.sqlite", null, VERSION); }
    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("PRAGMA foreign_keys=ON");
        db.execSQL("CREATE TABLE records (collection TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(collection,id))");
        db.execSQL("CREATE TABLE rooms (id TEXT PRIMARY KEY, value TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE roles (room_id TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(room_id,id), FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE)");
        db.execSQL("CREATE TABLE npc_memories (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, role_id TEXT NOT NULL, value TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, FOREIGN KEY(room_id,role_id) REFERENCES roles(room_id,id) ON DELETE CASCADE)");
        db.execSQL("CREATE TABLE turns (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE)");
        db.execSQL("CREATE TABLE decisions (turn_id TEXT NOT NULL, role_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(turn_id,role_id), FOREIGN KEY(turn_id) REFERENCES turns(id) ON DELETE CASCADE)");
        db.execSQL("CREATE TABLE drafts (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE)");
        db.execSQL("CREATE TABLE scenes (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE)");
        db.execSQL("CREATE TABLE world_changes (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE)");
        db.execSQL("CREATE TABLE consultations (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE)");
        db.execSQL("CREATE TABLE reaction_previews (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE)");
        db.execSQL("CREATE TABLE core_state (room_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL, events TEXT NOT NULL, workflows TEXT NOT NULL, updated_at INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE assets (path TEXT PRIMARY KEY, content_type TEXT, data BLOB NOT NULL)");
        db.execSQL("CREATE TABLE recovery (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    }
    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        if (oldVersion < 2) {
            db.execSQL("CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, value TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)");
            db.execSQL("CREATE TABLE IF NOT EXISTS roles (room_id TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(room_id,id))");
            db.execSQL("CREATE TABLE IF NOT EXISTS npc_memories (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, role_id TEXT NOT NULL, value TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0)");
            db.execSQL("CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL)");
            db.execSQL("CREATE TABLE IF NOT EXISTS decisions (turn_id TEXT NOT NULL, role_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(turn_id,role_id))");
            db.execSQL("CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL)");
            db.execSQL("CREATE TABLE IF NOT EXISTS scenes (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL)");
            db.execSQL("CREATE TABLE IF NOT EXISTS world_changes (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL)");
            db.execSQL("CREATE TABLE IF NOT EXISTS consultations (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL)");
            db.execSQL("CREATE TABLE IF NOT EXISTS reaction_previews (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL)");
        }
        if (oldVersion > newVersion) throw new IllegalStateException("Cannot downgrade StageCraft database.");
    }
    public synchronized void putRecord(String collection, String id, JSONObject value) {
        if (collection == null || collection.length() > 96 || id == null || id.isEmpty() || id.length() > 256 || value == null) throw new IllegalArgumentException("Invalid repository record.");
        ContentValues row = new ContentValues(); row.put("collection", collection); row.put("id", id); row.put("value", value.toString());
        if (getWritableDatabase().insertWithOnConflict("records", null, row, SQLiteDatabase.CONFLICT_REPLACE) == -1) throw new IllegalStateException("Unable to save repository record.");
    }
    public synchronized JSONObject getRecord(String collection, String id) throws Exception { try (Cursor cursor = getReadableDatabase().query("records", new String[]{"value"}, "collection=? AND id=?", new String[]{collection, id}, null, null, null)) { return cursor.moveToFirst() ? new JSONObject(cursor.getString(0)) : null; } }
    public synchronized List<JSONObject> listRecords(String collection) throws Exception { List<JSONObject> values = new ArrayList<>(); try (Cursor cursor = getReadableDatabase().query("records", new String[]{"value"}, "collection=?", new String[]{collection}, null, null, "id ASC")) { while (cursor.moveToNext()) values.add(new JSONObject(cursor.getString(0))); } return values; }
    public synchronized void deleteRecord(String collection, String id) { getWritableDatabase().delete("records", "collection=? AND id=?", new String[]{collection, id}); }
    public interface RoomMutation { Object apply(JSONObject room) throws Exception; }
    public synchronized void saveRoom(JSONObject room) {
        if (room == null || room.optString("id", "").isEmpty()) throw new IllegalArgumentException("Invalid room snapshot.");
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            ContentValues canonical = new ContentValues(); canonical.put("id", room.optString("id")); canonical.put("value", room.toString()); canonical.put("revision", room.optLong("revision", 0)); canonical.put("updated_at", System.currentTimeMillis());
            if (db.insertWithOnConflict("rooms", null, canonical, SQLiteDatabase.CONFLICT_REPLACE) == -1) throw new IllegalStateException("Unable to save room.");
            ContentValues row = new ContentValues(); row.put("collection", "rooms"); row.put("id", room.optString("id")); row.put("value", room.toString());
            if (db.insertWithOnConflict("records", null, row, SQLiteDatabase.CONFLICT_REPLACE) == -1) throw new IllegalStateException("Unable to save room record.");
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }
    public synchronized JSONObject findRoomForTurn(String turnId) throws Exception {
        for (JSONObject room : listRecords("rooms")) {
            org.json.JSONArray turns = room.optJSONArray("turns");
            if (turns != null) for (int i = 0; i < turns.length(); i++) if (turnId.equals(turns.optString(i))) return room;
        }
        return null;
    }
    public synchronized JSONObject getRoom(String roomId) throws Exception {
        try (Cursor cursor = getReadableDatabase().query("rooms", new String[]{"value"}, "id=?", new String[]{roomId}, null, null, null)) {
            if (cursor.moveToFirst()) return new JSONObject(cursor.getString(0));
        }
        return getRecord("rooms", roomId);
    }
    public synchronized Object mutateRoom(String roomId, RoomMutation mutation) throws Exception {
        JSONObject current = getRoom(roomId);
        if (current == null) throw new IllegalArgumentException("Room not found.");
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            JSONObject next = new JSONObject(current.toString());
            Object result = mutation.apply(next);
            if (!roomId.equals(next.optString("id"))) throw new IllegalArgumentException("Invalid room mutation.");
            ContentValues canonical = new ContentValues(); canonical.put("id", roomId); canonical.put("value", next.toString()); canonical.put("revision", next.optLong("revision", 0)); canonical.put("updated_at", System.currentTimeMillis());
            if (db.insertWithOnConflict("rooms", null, canonical, SQLiteDatabase.CONFLICT_REPLACE) == -1) throw new IllegalStateException("Unable to persist room mutation.");
            ContentValues row = new ContentValues(); row.put("collection", "rooms"); row.put("id", roomId); row.put("value", next.toString());
            if (db.insertWithOnConflict("records", null, row, SQLiteDatabase.CONFLICT_REPLACE) == -1) throw new IllegalStateException("Unable to persist room record.");
            db.setTransactionSuccessful(); return result;
        } finally { db.endTransaction(); }
    }
    public synchronized void saveCoreState(String roomId, long revision, JSONObject state, org.json.JSONArray events, org.json.JSONArray workflows) {
        if (roomId == null || roomId.isEmpty() || roomId.length() > 256 || revision < 0 || state == null || events == null || workflows == null) throw new IllegalArgumentException("Invalid Core state snapshot.");
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            ContentValues row = new ContentValues(); row.put("room_id", roomId); row.put("revision", revision); row.put("state", state.toString()); row.put("events", events.toString()); row.put("workflows", workflows.toString()); row.put("updated_at", System.currentTimeMillis());
            if (db.insertWithOnConflict("core_state", null, row, SQLiteDatabase.CONFLICT_REPLACE) == -1) throw new IllegalStateException("Unable to commit Core state.");
            ContentValues recovery = new ContentValues(); recovery.put("key", "core-state:" + roomId); recovery.put("value", Long.toString(revision));
            if (db.insertWithOnConflict("recovery", null, recovery, SQLiteDatabase.CONFLICT_REPLACE) == -1) throw new IllegalStateException("Unable to commit Core recovery marker.");
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }
    public synchronized JSONObject loadCoreState(String roomId) throws Exception { try (Cursor cursor = getReadableDatabase().query("core_state", new String[]{"revision","state","events","workflows"}, "room_id=?", new String[]{roomId}, null, null, null)) { if (!cursor.moveToFirst()) return null; return new JSONObject().put("roomId", roomId).put("revision", cursor.getLong(0)).put("state", new JSONObject(cursor.getString(1))).put("events", new org.json.JSONArray(cursor.getString(2))).put("workflows", new org.json.JSONArray(cursor.getString(3))); } }
    public synchronized void putAsset(String path, String contentType, byte[] data) { ContentValues row = new ContentValues(); row.put("path", path); row.put("content_type", contentType); row.put("data", data); getWritableDatabase().insertWithOnConflict("assets", null, row, SQLiteDatabase.CONFLICT_REPLACE); }
    public synchronized byte[] getAsset(String path) { try (Cursor cursor = getReadableDatabase().query("assets", new String[]{"data"}, "path=?", new String[]{path}, null, null, null)) { return cursor.moveToFirst() ? cursor.getBlob(0) : null; } }
    public synchronized void removeAsset(String path) { getWritableDatabase().delete("assets", "path=?", new String[]{path}); }
    public synchronized void setRecovery(String key, String value) { ContentValues row = new ContentValues(); row.put("key", key); row.put("value", value); getWritableDatabase().insertWithOnConflict("recovery", null, row, SQLiteDatabase.CONFLICT_REPLACE); }
    public synchronized String getRecovery(String key) { try (Cursor cursor = getReadableDatabase().query("recovery", new String[]{"value"}, "key=?", new String[]{key}, null, null, null)) { return cursor.moveToFirst() ? cursor.getString(0) : null; } }
}
