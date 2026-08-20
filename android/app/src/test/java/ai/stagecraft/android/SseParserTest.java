package ai.stagecraft.android;

import static org.junit.Assert.assertEquals;

import java.util.ArrayList;
import java.util.List;

import org.junit.Test;

public final class SseParserTest {
    @Test public void parsesSplitCrLfMultiDataAndStandaloneCr() {
        SseParser parser = new SseParser();
        List<String> messages = new ArrayList<>();
        for (String part : new String[] { "da", "ta: {\r", "\ndata: \"revision\": 4\r", "\ndata: }\r", "\n\r", "\n" }) messages.addAll(parser.accept(part));
        messages.addAll(parser.accept("data: second\r\r"));
        assertEquals(List.of("{\n\"revision\": 4\n}", "second"), messages);
    }
}
