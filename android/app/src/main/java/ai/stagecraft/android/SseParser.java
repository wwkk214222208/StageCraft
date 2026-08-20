package ai.stagecraft.android;

import java.util.ArrayList;
import java.util.List;

/** Incremental SSE data parser supporting LF, CRLF split across chunks, and standalone CR. */
public final class SseParser {
    private final StringBuilder buffer = new StringBuilder();
    private boolean previousChunkEndedWithCarriageReturn;

    public List<String> accept(String input) {
        List<String> messages = new ArrayList<>();
        if (input == null || input.isEmpty()) return messages;
        int start = 0;
        if (previousChunkEndedWithCarriageReturn) {
            previousChunkEndedWithCarriageReturn = false;
            if (input.charAt(0) == '\n') start = 1;
            if (start == input.length()) return messages;
        }
        previousChunkEndedWithCarriageReturn = input.charAt(input.length() - 1) == '\r';
        for (int index = start; index < input.length(); index++) {
            char current = input.charAt(index);
            if (current == '\r') {
                buffer.append('\n');
                if (index + 1 < input.length() && input.charAt(index + 1) == '\n') index++;
            } else {
                buffer.append(current);
            }
        }
        int boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            String block = buffer.substring(0, boundary);
            buffer.delete(0, boundary + 2);
            StringBuilder data = new StringBuilder();
            for (String line : block.split("\n", -1)) {
                if (!line.startsWith("data:")) continue;
                if (data.length() > 0) data.append('\n');
                String value = line.substring(5);
                data.append(value.startsWith(" ") ? value.substring(1) : value);
            }
            if (data.length() > 0) messages.add(data.toString());
        }
        return messages;
    }
}
