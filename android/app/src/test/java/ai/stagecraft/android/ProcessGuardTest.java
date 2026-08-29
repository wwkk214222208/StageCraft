package ai.stagecraft.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * W0（§5.1）：双进程 WebView 数据目录分流决策测试。
 * setDataDirectorySuffix 本身的调用时序由 Gate A 真机记录（源码契约测试辅证）。
 */
public class ProcessGuardTest {
    @Test
    public void coreProcessMapsToCoreSuffix() {
        assertEquals(ProcessGuard.CORE_SUFFIX, ProcessGuard.suffixForProcess("ai.stagecraft.android:core"));
    }

    @Test
    public void mainProcessUsesDefaultDirectory() {
        assertNull(ProcessGuard.suffixForProcess("ai.stagecraft.android"));
        assertNull(ProcessGuard.suffixForProcess(null));
    }

    @Test
    public void unrelatedColonSuffixIsNotCore() {
        assertNull(ProcessGuard.suffixForProcess("ai.stagecraft.android:sandbox"));
        assertFalse("core".equals(ProcessGuard.suffixForProcess("ai.stagecraft.android:corex")));
    }
}
