# WS-Mock → Replay Infrastructure Migration Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Migrate five WS-mock Playwright tests to use the replay infrastructure (real relay + MockOpenCodeServer), eliminating browser-level WebSocket mocking that hides integration bugs.

**Architecture:** Each migrated test will use the `replay-fixture.ts` infrastructure: a fresh `MockOpenCodeServer` + `createRelayStack()` per test, serving the built frontend. Tests use `mockServer.injectSSEEvents()` and `mockServer.setExactResponse()` to drive scenarios without needing new recordings. The `chat-simple` recording provides the base session/REST scaffold.

**Tech Stack:** Playwright, MockOpenCodeServer, replay-fixture.ts, chat-simple recording

---

## Background

### What changes
| Test file | Current infra | Target infra |
|---|---|---|
| `notification-reducer-indicators.spec.ts` | WS mock (`page.routeWebSocket`) | Replay fixture |
| `question-flow.spec.ts` | WS mock | Replay fixture |
| `variant-selector.spec.ts` | WS mock | Replay fixture |
| `subagent-sessions.spec.ts` | WS mock | Replay fixture |
| `dashboard-delete.spec.ts` | HTTP route mock (`page.route`) | **Deferred** (see below) |

### Why dashboard-delete is deferred
`dashboard-delete.spec.ts` does NOT use WebSocket mocking — it uses `page.route()` to intercept HTTP REST calls to `/api/projects`. The Dashboard page lives at `/` (daemon-level), not under a project path. The relay infrastructure is per-project (`/p/<slug>/`) and doesn't serve the `/api/projects` endpoint. Migrating this test requires a daemon replay harness, which is out of scope for this work.

### Key SSE event → relay message mappings (used throughout)
| SSE event type | Relay message | Notification behavior |
|---|---|---|
| `question.asked` | `ask_user` | ALWAYS broadcasts `notification_event` with `eventType: "ask_user"` (sse-wiring.ts:362) |
| `session.status` with `status.type: "idle"` | `done` | `notification_event` with `eventType: "done"` only when session has NO viewers |
| `session.error` | `error` | `notification_event` with `eventType: "error"` only when session has NO viewers |

### Key REST endpoints the relay calls (MockOpenCodeServer must handle)
| Relay handler | REST call | Current MockOpenCodeServer support |
|---|---|---|
| `handleAskUserResponse` | `POST /question/:id/reply` | Not handled (404) |
| `handleQuestionReject` | `POST /question/:id/reject` | Not handled (404) |
| `handleAskUserResponse` (fallback) | `GET /question` | Not handled (404) |
| `handleSwitchVariant` | `GET /provider` | Queue-based from recording |
| `refreshVariantState` | `GET /provider` | Queue-based from recording |

### Reference: existing replay notification test
`notification-session-nav-replay.spec.ts` demonstrates the pattern: use `chat-simple` recording, call `mockServer.injectSSEEvents()` to inject `session.error` for an unwatched session, assert that `notification_event` arrives via the browser WebSocket. All migrated tests follow this pattern.

---

## Task 1: Add question endpoint fallbacks to MockOpenCodeServer

**Files:**
- Modify: `test/helpers/mock-opencode-server.ts`

The relay's `handleAskUserResponse` calls `POST /question/:id/reply` and `handleQuestionReject` calls `POST /question/:id/reject`. The `handleAskUserResponse` fallback path calls `GET /question`. MockOpenCodeServer currently returns 404 for these endpoints. Add synthetic fallbacks (same pattern as the existing `/command`, `/file`, `/pty` fallbacks).

**Step 1: Add question endpoint handlers**

In `mock-opencode-server.ts`, in the `handleRequest` method, add handlers BEFORE the generic queue lookup (after the existing `GET /file/content` fallback block around line 517):

```typescript
// ── Synthetic fallbacks for question endpoints ──────────────────────
// The relay calls these when the browser answers or skips a question.
// Return empty/success responses so question-flow tests don't 404.

if (method === "GET" && basePath === "/question") {
    const queue =
        this.getActiveQueue(this.exactQueues, exact) ??
        this.getActiveQueue(this.normalizedQueues, normalized);
    if (!queue) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([]));
        return;
    }
}

if (method === "POST" && /^\/question\/[^/]+\/reply$/.test(basePath)) {
    res.writeHead(204);
    res.end();
    return;
}

if (method === "POST" && /^\/question\/[^/]+\/reject$/.test(basePath)) {
    res.writeHead(204);
    res.end();
    return;
}
```

**Step 2: Run existing tests to verify no regressions**

Run: `npx playwright test --config test/e2e/playwright-replay.config.ts`
Expected: All existing replay tests still pass (the new fallbacks only activate when no queue entry exists).

**Step 3: Commit**

```
feat(test): add question endpoint fallbacks to MockOpenCodeServer
```

---

## Task 2: Migrate notification-reducer-indicators to replay

**Files:**
- Rewrite: `test/e2e/specs/notification-reducer-indicators.spec.ts`
- Modify: `test/e2e/playwright-replay.config.ts` (add to testMatch)

This test has 5 scenarios. The existing `notification-session-nav-replay.spec.ts` (which uses `injectSSEEvents` with `session.error`) is the reference pattern.

**Step 1: Rewrite the spec file**

Replace the WS-mock implementation with replay fixture. Key changes:

- Import from `../helpers/replay-fixture.js` instead of `@playwright/test`
- Use `test.use({ recording: "chat-simple" })`
- Use `gotoRelay(page, relayUrl)` instead of `page.goto(baseURL + PROJECT_URL)`
- Use `mockServer.injectSSEEvents()` to inject events instead of `control.sendMessage()`
- Session IDs: the "current" session is from the recording; create an unwatched session ID like `"ses_notif_target"` for testing notifications on other sessions

SSE events to inject for each scenario:

**ask_user notification** — inject `question.asked` SSE event for the unwatched session:
```typescript
mockServer.injectSSEEvents([{
    type: "question.asked",
    properties: {
        sessionID: TARGET_SESSION,
        id: "que_test_001",
        questions: [{ question: "Test?", header: "Test", options: [] }],
    },
}]);
```
The relay translates this to `ask_user` and ALWAYS broadcasts `notification_event` with `eventType: "ask_user"` and `sessionId: TARGET_SESSION`.

**done notification** — inject `session.status` with idle for an unwatched session:
```typescript
mockServer.injectSSEEvents([{
    type: "session.status",
    properties: {
        sessionID: TARGET_SESSION,
        status: { type: "idle" },
    },
}]);
```
Since `TARGET_SESSION` has no viewers, the relay broadcasts `notification_event` with `eventType: "done"`.

**Clearing by navigation** — after injecting ask_user, click the session in the sidebar. Since the relay uses real `SessionRegistry`, viewing the session clears it. Note: the sidebar only shows sessions returned by `GET /session`. We need the target session to appear in the session list. Use `mockServer.setExactResponse("GET", "/session", 200, [...])` to include the target session, or use `mockServer.emitTestEvent("session.updated", ...)` to trigger a session list refresh that includes the target.

Actually, the simplest approach: before the test starts, override `GET /session` to include both the real session (from the recording) and the target session. The relay polls this endpoint and sends `session_list` to the browser.

**Reconciliation test** — inject `question.asked` SSE event to increment `pendingQuestionCount` in SessionManager. Then trigger a session_list refresh (create a session via prompt, or wait for poller). The frontend receives `session_list` with `pendingQuestionCount > 0` and reconciles.

Alternative approach for reconciliation: since `question.asked` both increments the count AND broadcasts `notification_event`, the attention dot will appear from the notification_event, not from reconciliation. To test reconciliation specifically, we'd need the count to be set without the notification. This is hard in the replay infra. **Recommendation**: drop the dedicated reconciliation sub-test from this spec. The reconciliation path is a frontend concern better tested via a Vitest unit test for the notification reducer. The replay tests already cover the more important full-pipeline path.

**Step 2: Update the gotoRelay wait helper**

The existing `gotoRelay` from `replay-fixture.ts` waits for `#layout` and `#connect-overlay` to disappear. The notification test needs the sidebar to be rendered with sessions. After `gotoRelay`, add:
```typescript
await page.locator("[data-session-id]").first().waitFor({ state: "visible", timeout: 10_000 });
```

**Step 3: Add to replay config**

In `playwright-replay.config.ts`, add `"notification-reducer-indicators.spec.ts"` to the `testMatch` array.

**Step 4: Run the migrated test**

Run: `npx playwright test --config test/e2e/playwright-replay.config.ts --grep "notification reducer"`
Expected: All notification indicator tests pass.

**Step 5: Commit**

```
refactor(test): migrate notification-reducer-indicators to replay infra
```

---

## Task 3: Migrate question-flow to replay

**Files:**
- Rewrite: `test/e2e/specs/question-flow.spec.ts`
- Modify: `test/e2e/playwright-replay.config.ts` (add to testMatch)

The question flow test has 4 scenarios: question card appears, user selects and submits, agent continues after answer, user skips.

**Step 1: Rewrite the spec file**

Key approach:
- Use `chat-simple` recording via replay fixture
- Navigate, wait for relay to connect
- Inject `question.asked` SSE event for the CURRENT session (the one the browser is viewing)
- The relay translates to `ask_user` and routes it to the session's viewers
- QuestionCard appears in the browser
- User interacts with the QuestionCard (select option, submit/skip)
- Relay's `handleAskUserResponse`/`handleQuestionReject` calls MockOpenCodeServer's question endpoints (Task 1 added these)
- For the "agent continues" test: after the answer, inject continuation SSE events (`message.part.delta`, `session.status:idle`)

SSE event for the question:
```typescript
mockServer.injectSSEEvents([{
    type: "question.asked",
    properties: {
        sessionID: CURRENT_SESSION_ID,
        id: "que_test_db_001",
        questions: [{
            question: "Which database should I use?",
            header: "Database",
            options: [
                { label: "PostgreSQL", description: "Relational database" },
                { label: "MongoDB", description: "Document database" },
            ],
            multiple: false,
            custom: true,
        }],
        tool: { callID: "toolu_question_001" },
    },
}]);
```

For determining `CURRENT_SESSION_ID`: extract it from the recording. The replay fixture loads `chat-simple`, which has a session used in `prompt_async`. Extract it the same way `notification-session-nav-replay.spec.ts` does:
```typescript
function findTargetSessionId(recording: OpenCodeRecording): string | undefined {
    for (const ix of recording.interactions) {
        if (ix.kind === "rest" && ix.method === "POST") {
            const match = /\/session\/([^/]+)\/prompt_async/.exec(ix.path);
            if (match?.[1]) return match[1];
        }
    }
    return undefined;
}
```
Or more simply: after `gotoRelay`, the browser's URL contains `/s/<sessionId>`. Extract it from the URL, or capture it from `session_switched` WS frames.

For the "agent continues after answer" test:
After the user submits the answer, the relay calls `POST /question/:id/reply` on MockOpenCodeServer (which returns 204). Then inject continuation SSE events:
```typescript
mockServer.injectSSEEvents([
    { type: "message.part.delta", properties: { sessionID: sessionId, delta: { content: "Great choice!" } } },
    { type: "session.status", properties: { sessionID: sessionId, status: { type: "idle" } } },
]);
```

**Note on verifying client messages**: The WS-mock version uses `control.waitForClientMessage()` to verify the frontend sent `ask_user_response`. In the replay version, we can capture WS frames via `page.on("websocket", ...)` (same pattern as `notification-session-nav-replay.spec.ts`).

**Step 2: Add to replay config**

In `playwright-replay.config.ts`, add `"question-flow.spec.ts"` to the `testMatch` array.

**Step 3: Run the migrated test**

Run: `npx playwright test --config test/e2e/playwright-replay.config.ts --grep "Question"`
Expected: All question flow tests pass.

**Step 4: Commit**

```
refactor(test): migrate question-flow to replay infra
```

---

## Task 4: Migrate variant-selector to replay

**Files:**
- Rewrite: `test/e2e/specs/variant-selector.spec.ts`
- Modify: `test/e2e/playwright-replay.config.ts` (add to testMatch)

The variant test has 6 groups: badge visibility, dropdown, selection UI, WS message verification, server-pushed updates, Ctrl+T shortcut.

**Step 1: Rewrite the spec file**

Key approach:
- Use `chat-simple` recording via replay fixture
- Before navigating, override `GET /provider` to return a provider list with variant-capable models
- The relay's `refreshVariantState` (called during client init) calls `listProviders`, sees variants, broadcasts `variant_info`
- Badge appears, dropdown works, variant selection calls `handleSwitchVariant`

Override the provider response to include variants:
```typescript
mockServer.setExactResponse("GET", "/provider", 200, [
    {
        id: "anthropic",
        name: "Anthropic",
        models: {
            "claude-sonnet-4": {
                id: "claude-sonnet-4",
                name: "claude-sonnet-4",
                variants: {
                    low: {}, medium: {}, high: {}, max: {},
                },
            },
        },
    },
]);
```

Note: `GET /provider` response format is `{ all: Provider[], ... }` or just `Provider[]`. Check the exact format in `opencode-client.ts:listProviders()` (line 393+). The client normalizes both formats.

For the "no variants" test: use a separate test block with a recording where the provider response has NO variants. Either use a second harness or override the response per-test.

**Two approaches for variant vs no-variant tests:**
1. Use `test.describe` blocks with different recordings (but we only need one recording)
2. Use `test.beforeEach` to set up the provider response per-test

Approach 2 is cleaner: in each test, before navigating, set the exact provider response. The issue is that `refreshVariantState` runs during client init (on WS connect), which happens after `gotoRelay`. So the override must be set BEFORE the page navigates.

The replay fixture creates the harness (and starts MockOpenCodeServer) before navigation. The `mockServer` fixture is available. Set the override before `gotoRelay`:
```typescript
test("shows variant badge when model has variants", async ({ page, relayUrl, mockServer }) => {
    mockServer.setExactResponse("GET", "/provider", 200, variantProviderList);
    await gotoRelay(page, relayUrl);
    // ... assertions
});
```

For verifying WS messages (variant selection sends `switch_variant`): capture frames via `page.on("websocket", ...)`.

For server-pushed `variant_info`: use `mockServer.emitTestEvent("variant_info", ...)` — wait, that emits SSE, not a WS message. We need the relay to send a `variant_info` WS message to the browser. The relay broadcasts `variant_info` when `refreshVariantState` runs. We could trigger this by having another variant-related SSE event...

Actually, for the "server-pushed variant_info" test (where the server pushes a variant change), in the real system this would come from another client switching the variant (which triggers `handleSwitchVariant` → broadcasts `variant_info`). In the replay test, we can't easily trigger this from outside.

Alternative: the relay broadcasts `variant_info` on model switch and during `refreshVariantState`. We can trigger a model switch by opening a second browser page (second WS client) that sends `switch_variant`. Or we can use the relay's WS handler directly by connecting a raw WS client.

Simpler approach: use `page.evaluate()` to trigger a variant switch from the browser itself (via keyboard shortcut or dropdown click), then verify the badge updates. This tests the round-trip: browser sends `switch_variant` → relay's `handleSwitchVariant` → relay broadcasts `variant_info` → browser updates badge. This is MORE realistic than the WS-mock version which just injected a `variant_info` message.

For the "server pushes variant change" test specifically, we'd need an external event. One option: connect a second WS client via `new WebSocket()` in a second page, have it send `switch_variant`. The relay broadcasts `variant_info` to all clients.

**Recommendation**: For this specific sub-test, the replay version tests a slightly different (but more realistic) path. The existing tests for dropdown selection + Ctrl+T already cover the full round-trip. The "server push" sub-test can be adapted to verify that variant state syncs across tabs using the relay as the real intermediary.

**Step 2: Add to replay config**

In `playwright-replay.config.ts`, add `"variant-selector.spec.ts"` to the `testMatch` array.

**Step 3: Run the migrated test**

Run: `npx playwright test --config test/e2e/playwright-replay.config.ts --grep "Variant"`
Expected: All variant selector tests pass.

**Step 4: Commit**

```
refactor(test): migrate variant-selector to replay infra
```

---

## Task 5: Migrate subagent-sessions to replay

**Files:**
- Rewrite: `test/e2e/specs/subagent-sessions.spec.ts`
- Modify: `test/e2e/playwright-replay.config.ts` (add to testMatch)

The subagent test has 2 groups: toggle (hide/show in sidebar) and navigation (parent↔child). This is the most complex migration because it needs multiple sessions with parentID relationships.

**Step 1: Set up session data in MockOpenCodeServer**

Use `chat-simple` recording. Before navigating, override the session list response to include parent, child, and unrelated sessions:

```typescript
const PARENT_ID = "ses_parent001";
const CHILD_ID = "ses_child001";
const OTHER_ID = "ses_other001";

const sessionList = [
    { id: PARENT_ID, title: "Synthesis UI rendering bug", createdAt: "2024-03-10T00:00:00Z", parentID: undefined },
    { id: CHILD_ID, title: "Explore synthesis pipeline (@explore)", createdAt: "2024-03-10T00:01:00Z", parentID: PARENT_ID },
    { id: OTHER_ID, title: "Unrelated session", createdAt: "2024-03-09T20:00:00Z" },
];

mockServer.setExactResponse("GET", "/session", 200, sessionList);
```

Also set up message responses for each session so `view_session` / `switch_session` handlers can fetch messages:
```typescript
mockServer.setExactResponse("GET", `/session/${PARENT_ID}/message`, 200, parentMessages);
mockServer.setExactResponse("GET", `/session/${CHILD_ID}/message`, 200, childMessages);
```

The message data can be imported from the existing `subagent-snapshot.json` fixture.

**Step 2: Rewrite the spec file**

Key changes:
- Import from `../helpers/replay-fixture.js`
- Use `test.use({ recording: "chat-simple" })`
- Set up session overrides in MockOpenCodeServer before `gotoRelay`
- Use page objects (`SidebarPage`, `ChatPage`) — same as before

For the toggle tests:
- The relay sends `session_list` with `roots: true` (excluding child sessions) and `roots: false` (all sessions) via `sendDualSessionLists`. MockOpenCodeServer's `GET /session` returns all sessions; the relay's `SessionManager.sendDualSessionLists()` handles the filtering based on `parentID`.
- The subagent toggle in the sidebar filters client-side. The relay sends both root-only and full session lists. The toggle switches between them.

For navigation tests:
- Click subagent link → frontend sends `switch_session` → relay handler calls `GET /session/:id/message` → relay sends `session_switched` with history → `SubagentBackBar` appears (because session has `parentID`)
- Click back → frontend sends `switch_session` for parent → relay returns parent's messages

**Important**: The relay needs to know about the parent-child relationship to build the session list correctly. The `SessionManager.sendDualSessionLists()` method queries `GET /session` from OpenCode and separates root sessions from child sessions based on `parentID`. So `GET /session` must return sessions with the `parentID` field.

**Step 3: Handle session switching in MockOpenCodeServer**

When the relay switches sessions, it calls:
1. `GET /session/:id/message` — messages for the new session
2. May call `GET /session` — to refresh the session list

The `setExactResponse` calls from Step 1 handle this. The relay's session handler calls `GET /session/:id/message?after=0` (or similar). Set up the exact responses to match.

**Step 4: Add to replay config**

In `playwright-replay.config.ts`, add `"subagent-sessions.spec.ts"` to the `testMatch` array.

**Step 5: Run the migrated test**

Run: `npx playwright test --config test/e2e/playwright-replay.config.ts --grep "Subagent"`
Expected: All subagent session tests pass.

**Step 6: Commit**

```
refactor(test): migrate subagent-sessions to replay infra
```

---

## Task 6: Remove old WS-mock configs and update scripts

**Files:**
- Delete: `test/e2e/playwright-notification-reducer.config.ts`
- Delete: `test/e2e/playwright-question-flow.config.ts`
- Delete: `test/e2e/playwright-variant.config.ts`
- Delete: `test/e2e/playwright-subagent.config.ts`
- Modify: `scripts/test-all.sh` (remove the old config runs)
- Modify: `package.json` (update/remove scripts that reference deleted configs)

**Step 1: Delete the old Playwright config files**

These configs are no longer needed since the tests now run under `playwright-replay.config.ts`.

**Step 2: Update test-all.sh**

Remove the line:
```bash
run "E2E subagent tests"       npx playwright test --config test/e2e/playwright-subagent.config.ts
```

The notification-reducer, question-flow, and variant configs are NOT currently in `test-all.sh` (they were individual developer scripts), so no removal needed for those.

**Step 3: Update package.json scripts**

Remove or update:
- `"test:subagent-e2e"` — remove (now part of `test:e2e`)
- Other WS-mock specific scripts can be removed if they exist

**Step 4: Check for remaining references to deleted configs**

Search for any remaining references to the deleted config file names in documentation, CI configs, or other scripts.

**Step 5: Commit**

```
chore: remove WS-mock Playwright configs migrated to replay
```

---

## Task 7: Clean up unused WS-mock fixtures

**Files:**
- Modify: `test/e2e/fixtures/mockup-state.ts` — review and remove exports only used by deleted WS-mock tests
- Modify: `test/e2e/helpers/ws-mock.ts` — keep if still used by `scroll-stability.spec.ts` or other tests; mark as deprecated if only visual-mockup.spec.ts remains

**Step 1: Identify remaining WS-mock consumers**

Search for imports from `ws-mock.ts` and `mockup-state.ts`. Files that still import them:
- `scroll-stability.spec.ts` (hybrid: uses both replay + ws-mock)
- `visual-mockup.spec.ts` (WS-mock visual test)
- `multi-instance.spec.ts` (WS-mock, not being migrated)
- `notification-session-nav.spec.ts` (WS-mock, has replay counterpart)
- `project-management.spec.ts` (WS-mock, not being migrated)

**Step 2: Remove dead exports from mockup-state.ts**

If any exports from `mockup-state.ts` are only imported by the migrated test files (notification-reducer-indicators, question-flow, variant-selector, subagent-sessions), remove them. Keep exports used by remaining WS-mock tests.

**Step 3: Keep ws-mock.ts**

`ws-mock.ts` is still needed by remaining WS-mock tests (multi-instance, visual-mockup, scroll-stability). Do not delete it.

**Step 4: Delete the old WS-mock notification test**

`notification-session-nav.spec.ts` has a replay counterpart (`notification-session-nav-replay.spec.ts`). The WS-mock version is now redundant. Check if it's referenced in any config and remove it.

**Step 5: Commit**

```
chore: clean up unused WS-mock fixtures after replay migration
```

---

## Task 8: Full verification

**Step 1: Run the replay test suite**

Run: `npx playwright test --config test/e2e/playwright-replay.config.ts`
Expected: All tests pass, including the 4 newly migrated specs.

**Step 2: Run the remaining WS-mock test suites**

Run: `npx playwright test --config test/e2e/playwright-multi-instance.config.ts`
Run: `npx playwright test --config test/e2e/playwright-visual.config.ts`
Expected: No regressions — these tests were not modified.

**Step 3: Run the full test suite**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Run: `npx playwright test --config test/e2e/playwright-replay.config.ts`
Expected: Type check, lint, unit tests, and replay E2E tests all pass.

**Step 4: Run test-all.sh**

Run: `pnpm test:all`
Expected: All steps pass. The removed subagent config no longer runs separately; its tests run as part of the replay config.

---

## Implementation Notes

### Getting the current session ID in replay tests
The recording's session ID is embedded in the `prompt_async` URLs. Extract it with:
```typescript
import { loadOpenCodeRecording } from "../helpers/recorded-loader.js";
const recording = loadOpenCodeRecording("chat-simple");
const sessionId = recording.interactions
    .find(ix => ix.kind === "rest" && ix.method === "POST" && ix.path.includes("prompt_async"))
    ?.path.match(/\/session\/([^/]+)\//)?.[1];
```
Or after `gotoRelay`, extract from the URL: `page.url()` contains `/s/<sessionId>`.

### Overriding GET /session for multi-session tests
The relay polls `GET /session` to build session lists. `mockServer.setExactResponse("GET", "/session", 200, sessionArray)` sets a sticky response that the relay will use for all subsequent polls. This is how notification and subagent tests create additional sessions visible in the sidebar.

### Timing considerations
The replay infrastructure is slower than WS-mock (real HTTP server, real SSE connection, real polling). Tests should use Playwright's `expect.poll()` or `waitFor()` with adequate timeouts (5-10s) rather than fixed `waitForTimeout()` calls. The existing replay tests use 5-10s timeouts which work well.

### WS frame capture for verifying client messages
Replace `control.waitForClientMessage()` with the frame capture pattern from `notification-session-nav-replay.spec.ts`:
```typescript
const sentFrames: string[] = [];
page.on("websocket", (ws) => {
    ws.on("framesent", (frame) => {
        if (typeof frame.payload === "string") sentFrames.push(frame.payload);
    });
});
// ... later ...
await expect.poll(() => sentFrames.some(f => {
    const msg = JSON.parse(f);
    return msg.type === "ask_user_response";
}), { timeout: 5000 }).toBe(true);
```
