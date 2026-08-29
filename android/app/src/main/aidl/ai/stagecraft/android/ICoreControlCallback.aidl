package ai.stagecraft.android;

/** Q8 控制面回调：oneway，避免阻塞 :core 主线程；summary/endpoint 均为小 JSON 字符串。 */
interface ICoreControlCallback {
    oneway void onStatus(String summaryJson);

    oneway void onEndpointReady(String endpointJson);
}
