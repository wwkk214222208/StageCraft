package ai.stagecraft.android;

import org.json.JSONObject;

/**
 * Gate C：协议 1.1 核心判定的 Java 侧实现，与 src/core/protocol.ts、src/core/connection.ts、
 * public/core-client.js 保持同语义（由 protocol-fixtures.json 黄金样本逐条对等验证）。
 */
public final class CoreProtocolSupport {
    private CoreProtocolSupport() {}

    /** 与 TS compareVersions 同语义：逐数字段比较。 */
    public static int compareVersions(String a, String b) {
        String[] pa = a == null ? new String[0] : a.split("\\.");
        String[] pb = b == null ? new String[0] : b.split("\\.");
        int length = Math.max(pa.length, pb.length);
        for (int index = 0; index < length; index++) {
            int left = index < pa.length ? parseSegment(pa[index]) : 0;
            int right = index < pb.length ? parseSegment(pb[index]) : 0;
            int delta = left - right;
            if (delta != 0) return delta;
        }
        return 0;
    }

    private static int parseSegment(String segment) {
        if (segment == null || segment.isEmpty()) return 0;
        try {
            return Integer.parseInt(segment);
        } catch (NumberFormatException error) {
            return 0;
        }
    }

    /** client 版本是否落在 server 声明的支持范围内（§3.2）。 */
    public static boolean supports(String clientVersion, String serverMin, String serverMax) {
        return compareVersions(clientVersion, serverMin) >= 0 && compareVersions(clientVersion, serverMax) <= 0;
    }

    /** 1.1 envelope 判别（TS isCoreEventEnvelope 同语义）。 */
    public static boolean isEnvelope(JSONObject value) {
        return value != null && value.has("payload") && value.has("protocolVersion") && value.has("roomId");
    }

    /** 1.1 envelope 完整性：protocolVersion/roomId/revision/type/payload/createdAt 全必备。 */
    public static boolean isValidEnvelope(JSONObject envelope) {
        return envelope != null
            && envelope.has("protocolVersion") && envelope.has("roomId")
            && envelope.has("revision") && envelope.has("type")
            && envelope.has("payload") && envelope.has("createdAt")
            && envelope.optJSONObject("payload") != null;
    }

    /** 1.1 receipt 完整性：requestId 必备，status 限三值，rejected 必须带 error。 */
    public static boolean isValidReceipt(JSONObject receipt) {
        if (receipt == null) return false;
        String requestId = receipt.optString("requestId", "");
        String status = receipt.optString("status", "");
        if (requestId.isEmpty()) return false;
        switch (status) {
            case "accepted":
            case "unknown-after-disconnect":
                return true;
            case "rejected":
                return receipt.has("error");
            default:
                return false;
        }
    }
}
