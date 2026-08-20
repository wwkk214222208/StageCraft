package ai.stagecraft.android;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public final class RemoteSessionStore {
    public record SavedSession(String address, boolean allowInsecureHttp, String credential) {}

    private static final String KEY_ALIAS = "stagecraft.remote.session.v1";
    private static final String PREFS = "stagecraft_remote";
    private static final String CIPHERTEXT = "session_ciphertext";
    private static final String IV = "session_iv";
    private final SharedPreferences preferences;

    public RemoteSessionStore(Context context) {
        preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public synchronized void save(String address, boolean allowInsecureHttp, String credential) throws Exception {
        SecretKey key = getOrCreateKey();
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] plaintext = new JSONObject().put("address", address).put("allowInsecureHttp", allowInsecureHttp).put("credential", credential).toString().getBytes(StandardCharsets.UTF_8);
        byte[] encrypted = cipher.doFinal(plaintext);
        boolean committed = preferences.edit()
            .putString(CIPHERTEXT, Base64.encodeToString(encrypted, Base64.NO_WRAP))
            .putString(IV, Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
            .commit();
        if (!committed) throw new IllegalStateException("Unable to persist encrypted remote session.");
    }

    public synchronized SavedSession load() {
        String ciphertext = preferences.getString(CIPHERTEXT, null);
        String iv = preferences.getString(IV, null);
        if (ciphertext == null || iv == null) return null;
        try {
            KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
            keyStore.load(null);
            SecretKey key = (SecretKey) keyStore.getKey(KEY_ALIAS, null);
            if (key == null) throw new IllegalStateException("Keystore key is missing.");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
            JSONObject session = new JSONObject(new String(cipher.doFinal(Base64.decode(ciphertext, Base64.NO_WRAP)), StandardCharsets.UTF_8));
            String address = session.getString("address");
            String credential = session.getString("credential");
            if (address.isEmpty() || credential.isEmpty()) throw new IllegalStateException("Encrypted session is incomplete.");
            return new SavedSession(address, session.optBoolean("allowInsecureHttp", false), credential);
        } catch (Exception error) {
            clearSession();
            return null;
        }
    }

    public synchronized void clearSession() {
        preferences.edit().remove(CIPHERTEXT).remove(IV).commit();
    }

    private SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        SecretKey existing = (SecretKey) keyStore.getKey(KEY_ALIAS, null);
        if (existing != null) return existing;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(false)
            .build());
        return generator.generateKey();
    }
}
