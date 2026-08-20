package ai.stagecraft.android;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Keystore-backed model provider secrets. Plaintext never enters WebView or CoreView. */
public final class AndroidSecretStore {
    private static final String ALIAS = "stagecraft.model.keys.v1";
    private final SharedPreferences preferences;
    public AndroidSecretStore(Context context) { preferences = context.getSharedPreferences("stagecraft_model_secrets", Context.MODE_PRIVATE); }
    public synchronized void put(String id, String value) throws Exception { Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key()); boolean ok = preferences.edit().putString(id + ".data", Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP)).putString(id + ".iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)).commit(); if (!ok) throw new IllegalStateException("Unable to save model secret."); }
    public synchronized String get(String id) throws Exception { String data = preferences.getString(id + ".data", null), iv = preferences.getString(id + ".iv", null); if (data == null || iv == null) return null; Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP))); return new String(cipher.doFinal(Base64.decode(data, Base64.NO_WRAP)), StandardCharsets.UTF_8); }
    public synchronized void remove(String id) { preferences.edit().remove(id + ".data").remove(id + ".iv").commit(); }
    private SecretKey key() throws Exception { KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null); SecretKey existing = (SecretKey) store.getKey(ALIAS, null); if (existing != null) return existing; KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore"); generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).setUserAuthenticationRequired(false).build()); return generator.generateKey(); }
}
