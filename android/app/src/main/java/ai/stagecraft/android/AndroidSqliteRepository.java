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
    private static final int VERSION = 1;
    public AndroidSqliteRepository(Context context) { super(context, "stagecraft.sqlite", null, VERSION); }
    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE records (collection TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(collection,id))");
        db.execSQL("CREATE TABLE core_state (room_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL, events TEXT NOT NULL, workflows TEXT NOT NULL, updated_at INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE assets (path TEXT PRIMARY KEY, content_type TEXT, data BLOB NOT NULL)");
        db.execSQL("CREATE TABLE recovery (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    }
    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) { if (oldVersion != newVersion) throw new IllegalStateException("Unsupported StageCraft database version."); }
    public synchronized void putRecord(String collection, String id, JSONObject value) { ContentValues row = new ContentValues(); row.put("collection", collection); row.put("id", id); row.put("value", value.toString()); getWritableDatabase().insertWithOnConflict("records", null, row, SQLiteDatabase.CONFLICT_REPLACE); }
    public synchronized JSONObject getRecord(String collection, String id) throws Exception { try (Cursor cursor = getReadableDatabase().query("records", new String[]{"value"}, "collection=? AND id=?", new String[]{collection, id}, null, null, null)) { return cursor.moveToFirst() ? new JSONObject(cursor.getString(0)) : null; } }
    public synchronized List<JSONObject> listRecords(String collection) throws Exception { List<JSONObject> values = new ArrayList<>(); try (Cursor cursor = getReadableDatabase().query("records", new String[]{"value"}, "collection=?", new String[]{collection}, null, null, "id ASC")) { while (cursor.moveToNext()) values.add(new JSONObject(cursor.getString(0))); } return values; }
    public synchronized void deleteRecord(String collection, String id) { getWritableDatabase().delete("records", "collection=? AND id=?", new String[]{collection, id}); }
    public synchronized void saveCoreState(String roomId, long revision, JSONObject state, org.json.JSONArray events, org.json.JSONArray workflows) { SQLiteDatabase db = getWritableDatabase(); db.beginTransaction(); try { ContentValues row = new ContentValues(); row.put("room_id", roomId); row.put("revision", revision); row.put("state", state.toString()); row.put("events", events.toString()); row.put("workflows", workflows.toString()); row.put("updated_at", System.currentTimeMillis()); db.insertWithOnConflict("core_state", null, row, SQLiteDatabase.CONFLICT_REPLACE); db.setTransactionSuccessful(); } finally { db.endTransaction(); } }
    public synchronized JSONObject loadCoreState(String roomId) throws Exception { try (Cursor cursor = getReadableDatabase().query("core_state", new String[]{"revision","state","events","workflows"}, "room_id=?", new String[]{roomId}, null, null, null)) { if (!cursor.moveToFirst()) return null; return new JSONObject().put("roomId", roomId).put("revision", cursor.getLong(0)).put("state", new JSONObject(cursor.getString(1))).put("events", new org.json.JSONArray(cursor.getString(2))).put("workflows", new org.json.JSONArray(cursor.getString(3))); } }
    public synchronized void putAsset(String path, String contentType, byte[] data) { ContentValues row = new ContentValues(); row.put("path", path); row.put("content_type", contentType); row.put("data", data); getWritableDatabase().insertWithOnConflict("assets", null, row, SQLiteDatabase.CONFLICT_REPLACE); }
    public synchronized byte[] getAsset(String path) { try (Cursor cursor = getReadableDatabase().query("assets", new String[]{"data"}, "path=?", new String[]{path}, null, null, null)) { return cursor.moveToFirst() ? cursor.getBlob(0) : null; } }
    public synchronized void removeAsset(String path) { getWritableDatabase().delete("assets", "path=?", new String[]{path}); }
    public synchronized void setRecovery(String key, String value) { ContentValues row = new ContentValues(); row.put("key", key); row.put("value", value); getWritableDatabase().insertWithOnConflict("recovery", null, row, SQLiteDatabase.CONFLICT_REPLACE); }
    public synchronized String getRecovery(String key) { try (Cursor cursor = getReadableDatabase().query("recovery", new String[]{"value"}, "key=?", new String[]{key}, null, null, null)) { return cursor.moveToFirst() ? cursor.getString(0) : null; } }
}
