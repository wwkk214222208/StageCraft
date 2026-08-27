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
        WebView webView = activity.testingWebView();
        assertNotNull("MainActivity must create a WebView", webView);
        assertNotNull("WebView dialogs require a WebChromeClient", activity.testingWebChromeClient());

        long deadline = System.currentTimeMillis() + 10_000L;
        while (System.currentTimeMillis() < deadline) {
            String url = webView.getUrl();
            if (url != null && url.endsWith("/web/offline.html")) return;
            Thread.sleep(100L);
        }
        assertTrue("Activity must load the packaged offline.html entry", webView.getUrl() != null && webView.getUrl().contains("/web/offline.html"));
    }
}
