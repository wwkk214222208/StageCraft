# Engineering Lessons

## Android WebView Local Runtime Debugging

### Root cause

When a Web UI is embedded in Android WebView, a failure that looks like a storage or API failure may happen earlier in the interaction chain. In this case, the editor's first step was `prompt()` for the new story title. Android had JavaScript enabled but no `WebChromeClient`, so `prompt()`, `alert()`, and `confirm()` were not visible. The API request was never reached, and the user saw no error.

### Required investigation order

For Android local-runtime issues, verify the complete chain in this order:

1. User gesture reaches the expected DOM event handler.
2. Browser APIs used by the handler are supported and visible in WebView (`prompt`, `confirm`, `alert`, file pickers, dialogs).
3. The page script and the local-runtime entry actually load from the APK.
4. The request is dispatched with the expected method, query parameters, and JSON body.
5. The Web entry maps the request to the native Bridge operation.
6. The native operation reaches the intended repository or platform port.
7. Data is persisted and can be read back.
8. The UI handles both HTTP errors and `{ ok: false }` responses.

Do not begin with SQLite or API persistence when the user reports that a button does nothing. First prove that the button's first browser interaction occurs.

### WebView requirements

Any Android WebView that hosts the full UI must configure a `WebChromeClient` when the UI uses browser dialogs:

```java
webView.setWebChromeClient(new WebChromeClient());
```

Without this, JavaScript dialogs can be invisible even though the page itself renders normally.

### Test boundary

A Node or VM test with a fake `StageCraftNative` validates only the route and bridge contract. It does not validate:

- DOM event registration;
- WebView browser dialogs;
- `WebChromeClient` configuration;
- actual Android WebView navigation;
- the real Java Bridge implementation;
- Android SQLite behavior.

Therefore, a simulated route test must not be reported as proof that the Android UI works. For user-facing Android fixes, add at least one UI-level validation path, or explicitly state that device verification is still required.

### Error visibility

Local operations must never fail silently. The local Web entry should convert synchronous and asynchronous native failures into non-2xx JSON responses. The Web UI should catch rejected promises and check both `response.ok` and `data.ok !== false`, then show the operation name and original error message to the user.

## Review Checklist

- Does the first click invoke `prompt`, `confirm`, or another browser-controlled UI?
- Is `WebChromeClient` configured before loading the page?
- Is the actual APK asset inspected, rather than only the source file?
- Does the test exercise the user interaction, or only call the API directly?
- Can the user see the original failure without adb, root, or debug mode?
- After a successful write, does the UI read the same object back through the real runtime?
