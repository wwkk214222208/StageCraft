package ai.stagecraft.android;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import org.junit.Test;

public final class StageCraftArchiveTest {
    @Test public void rejectsOversizedInput() throws Exception {
        byte[] bytes = new byte[StageCraftArchive.MAX_ARCHIVE_BYTES + 1];
        try { StageCraftArchive.readLimited(new ByteArrayInputStream(bytes), StageCraftArchive.MAX_ARCHIVE_BYTES); fail("expected bound"); }
        catch (IllegalArgumentException expected) { assertTrue(expected.getMessage().contains("large")); }
    }
    @Test public void rejectsInvalidPng() { assertFalse(StageCraftArchive.isPng("not png".getBytes(StandardCharsets.UTF_8))); }
    @Test public void acceptsPngSignature() { assertTrue(StageCraftArchive.isPng(new byte[]{(byte) 0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a})); }
}
