# Error Details & Debug Verbosity

## Problem

Errors in the chat UI show only a bare message (e.g. "The operation was aborted.") with no error code, status code, or context. The backend has rich error data (`RelayError.context`, `statusCode`, endpoint, response body) but `toMessage()` strips it before sending over WebSocket.

The debug panel and console logs show only message type names (`#347 notification_event`) with zero payload data, making them useless for debugging. The verbose toggle only controls client-side message sampling, not actual log verbosity.

## Approach

Enrich at the wire protocol level. Extend `RelayError.toMessage()` to include `details` and `statusCode`. Frontend renders the richer data. For the debug panel, store full message payloads and expose runtime server log level control.

## Design

### 1. Enriched Error Wire Protocol

**`RelayError.toMessage()`** — currently returns `{ type, code, message }`. Add two optional fields:

```ts
{ type: "error", code: string, message: string, statusCode?: number, details?: Record<string, unknown> }
```

- `details` sourced from `RelayError.context` (already populated by all subclasses).
- `statusCode` from the existing field on the error object.
- Both optional — errors without context still work.

**`shared-types.ts`** — Update the `RelayMessage` error variant with the two new optional fields.

**`SystemMessage.svelte`** — New rendering:
- Error code shown as monospace badge/prefix.
- "Show details" toggle expands to show formatted key-value pairs from `details` + `statusCode`.
- Collapsed by default.

**`ws-dispatch.ts`** — `handleChatError()` currently passes only `msg.message` to `addSystemMessage()`. Updated to pass the full error object so the store and component have access to `code`, `details`, `statusCode`.

### 2. Debug Panel — Always-Visible Payloads

**`WsDebugEvent`** — Add `payload?: unknown` field. When logging a `ws:message` event, store the full parsed message object unconditionally.

**Debug panel rendering** — Each entry with a `payload` gets an expand chevron. Clicking reveals formatted JSON. Always available, not gated by any toggle.

**Console logging** — `console.log("[ws]", event, detail, payload)` so DevTools always shows the full object as an expandable entry.

**Ring buffer** — Increase from 200 to 300 events.

### 3. Verbose Toggle = Runtime Server Log Level

**New behavior** — The toggle sends a WS message to the backend to call `setLogLevel("verbose")` or revert to the original level.

**WS message type:**

```ts
{ type: "set_log_level", level: "verbose" | "info" }
```

Backend handler calls `setLogLevel(level)`. On toggle-off, reverts to the captured original level.

**Combined effect** — Toggle-on enables both server verbose logging and client show-all-messages sampling. Toggle-off reverts both.

**Security** — Handler validates level value against allowed set. Only changes log verbosity, not behavior.

## Files Affected

### Backend
- `src/lib/errors.ts` — `toMessage()` returns `details` + `statusCode`
- `src/lib/shared-types.ts` — `RelayMessage` error variant widened
- `src/lib/server/ws-handler.ts` — Handle `set_log_level` message
- `src/lib/logger.ts` — May need to expose `getLogLevel()` for revert

### Frontend
- `src/lib/frontend/stores/ws-debug.svelte.ts` — `payload` field, 300 buffer, console payload logging
- `src/lib/frontend/stores/chat.svelte.ts` — `addSystemMessage` accepts richer error data
- `src/lib/frontend/stores/ws-dispatch.ts` — Pass full error object through
- `src/lib/frontend/components/chat/SystemMessage.svelte` — Code badge, expandable details
- `src/lib/frontend/components/debug/DebugPanel.svelte` — Payload expansion, verbose toggle behavior
- `src/lib/frontend/types.ts` — `SystemMessage` type may need enrichment
