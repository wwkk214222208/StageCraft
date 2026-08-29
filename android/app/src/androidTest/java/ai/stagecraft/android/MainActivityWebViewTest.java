package ai.stagecraft.android;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.webkit.WebView;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.rule.ActivityTestRule;

import org.junit.Rule;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class MainActivityWebViewTest {
    @Rule public final ActivityTestRule<MainActivity> activityRule = new ActivityTestRule<>(MainActivity.class);

    @Test public void localWebViewHasChromeClientAndLoadsPackagedEntry() throws Exception {
        MainActivity activity = activityRule.getActivity();
        // WebView 方法必须在主线程调用
        final WebView[] view = new WebView[1];
        final android.webkit.WebChromeClient[] chrome = new android.webkit.WebChromeClient[1];
        activity.runOnUiThread(() -> {
            view[0] = activity.testingWebView();
            chrome[0] = activity.testingWebChromeClient();
        });
        Thread.sleep(500L);
        assertNotNull("MainActivity must create a WebView", view[0]);
        assertNotNull("WebView dialogs require a WebChromeClient", chrome[0]);

        long deadline = System.currentTimeMillis() + 10_000L;
        while (System.currentTimeMillis() < deadline) {
            final String[] url = new String[1];
            activity.runOnUiThread(() -> url[0] = view[0].getUrl());
            if (url[0] != null && url[0].endsWith("/web/local.html")) return;
            Thread.sleep(100L);
        }
        final String[] finalUrl = new String[1];
        activity.runOnUiThread(() -> finalUrl[0] = view[0].getUrl());
        assertTrue("Activity must load the packaged local.html entry", finalUrl[0] != null && finalUrl[0].contains("/web/local.html"));
    }
}
