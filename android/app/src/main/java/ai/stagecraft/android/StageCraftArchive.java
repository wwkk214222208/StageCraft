package ai.stagecraft.android;

import android.content.Context;
import android.net.Uri;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

/** Bounded, path-safe archive import/export. The archive is data, never executable UI. */
public final class StageCraftArchive {
    public static final int MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
    public static byte[] exportJson(JSONObject snapshot) throws Exception { byte[] json = snapshot.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8); ByteArrayOutputStream output = new ByteArrayOutputStream(); try (ZipOutputStream zip = new ZipOutputStream(output)) { zip.putNextEntry(new ZipEntry("stagecraft.json")); zip.write(json); zip.closeEntry(); } return output.toByteArray(); }
    public static JSONObject importJson(InputStream input) throws Exception { byte[] archive = readLimited(input, MAX_ARCHIVE_BYTES); try (ZipInputStream zip = new ZipInputStream(new ByteArrayInputStream(archive))) { ZipEntry entry; while ((entry = zip.getNextEntry()) != null) { if (!entry.isDirectory() && entry.getName().equals("stagecraft.json")) return new JSONObject(new String(readLimited(zip, MAX_ARCHIVE_BYTES), java.nio.charset.StandardCharsets.UTF_8)); } } throw new IllegalArgumentException("Archive does not contain stagecraft.json."); }
    public static byte[] readLimited(InputStream input, int maximum) throws Exception { ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int total = 0, count; while ((count = input.read(buffer)) >= 0) { total += count; if (total > maximum) throw new IllegalArgumentException("File is too large."); output.write(buffer, 0, count); } return output.toByteArray(); }
    public static boolean isPng(byte[] data) { byte[] signature = {(byte) 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}; if (data == null || data.length < signature.length) return false; for (int i = 0; i < signature.length; i++) if (data[i] != signature[i]) return false; return true; }
    private StageCraftArchive() {}
}
