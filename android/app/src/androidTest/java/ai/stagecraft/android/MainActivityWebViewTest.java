package ai.stagecraft.android;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.webkit.WebView;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.rule.ActivityTestRule;

import org.junit.Rule;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class MainActivityWebViewTest {
    @Rule public final ActivityTestRule<MainActivity> activityRule = new ActivityTestRule<>(MainActivity.class);

    @Test public void localWebViewHasChromeClientAndLoadsPackagedEntry() throws Exception {
        MainActivity activity = activityRule.getActivity();
        // WebView 方法必须在主线程调用；runOnMainSync 同步等待，消除读值竞态
        final WebView[] view = new WebView[1];
        final android.webkit.WebChromeClient[] chrome = new android.webkit.WebChromeClient[1];
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            view[0] = activity.testingWebView();
            chrome[0] = activity.testingWebChromeClient();
        });
        assertNotNull("MainActivity must create a WebView", view[0]);
        assertNotNull("WebView dialogs require a WebChromeClient", chrome[0]);

        // 入口 URL 带 gateway 查询参数（gateway=1/0，见 MainActivity.showLocalUi），
        // 断言用 contains 与最终断言一致；等待加载完成最多 10s。
        long deadline = System.currentTimeMillis() + 10_000L;
        while (System.currentTimeMillis() < deadline) {
            final String[] url = new String[1];
            InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> url[0] = view[0].getUrl());
            if (url[0] != null && url[0].contains("/web/local.html")) return;
            Thread.sleep(100L);
        }
        final String[] finalUrl = new String[1];
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> finalUrl[0] = view[0].getUrl());
        assertTrue("Activity must load the packaged local.html entry", finalUrl[0] != null && finalUrl[0].contains("/web/local.html"));
    }
}
