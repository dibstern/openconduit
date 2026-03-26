# Remove Mock Fallbacks & Re-Record Fixtures Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Eliminate all synthetic/fallback data from MockOpenCodeServer so recordings are the sole source of truth, then re-record all fixtures so each recording is self-contained.

**Architecture:** Two coordinated changes: (1) the recording script creates a fresh RelayStack per scenario so each recording captures the full init sequence; (2) MockOpenCodeServer removes all `ensureFallback` calls, the message normalized override, and `promoteTargetSession`. After re-recording, every endpoint the relay needs during init and test execution has real recorded data.

**Tech Stack:** TypeScript, MockOpenCodeServer, RecordingProxy, `pnpm test:record-snapshots`

---

## Background

### Why recordings are missing init data

The recording script creates ONE RelayStack and resets the proxy between scenarios. The relay's init sequence (`GET /path`, `GET /config`, `GET /command`, `GET /file`, `GET /session`, etc.) is captured only in the first scenario's recording. All subsequent scenarios lack init data.

`ensureFallback` was added to paper over this gap. But it introduced synthetic data that doesn't match real OpenCode responses, and in the case of `GET /file`, it created an infinite recursive directory traversal that blocks 4 E2E tests.

### What gets removed

| Synthetic | Location | Purpose | Why safe to remove |
|-----------|----------|---------|-------------------|
| `ensureFallback("GET /path", ...)` | `buildQueues():355` | Health check | Re-recording captures it |
| `ensureFallback("GET /command", ...)` | `buildQueues():366` | Command list | Re-recording captures it |
| `ensureFallback("GET /file", ...)` | `buildQueues():370` | File list (causes infinite recursion) | Re-recording captures it |
| `normalizedQueues.set(msgNormKey, ...)` | `buildQueues():384` | Empty messages for non-target sessions | Re-recording captures all sessions' messages |
| `promoteTargetSession()` | `buildQueues():377` | Reorder session list | Fresh relay per scenario → target session is naturally most recent |
| `ensureFallback` method | Line 402-410 | Helper | No callers remain |

---

## Task 1: Update recording script — fresh relay per scenario

**Files:**
- Modify: `test/e2e/scripts/record-snapshots.ts:460-628`

**Step 1: Move relay creation inside the scenario loop**

Currently the script creates ONE relay at line 473 and shares it across all scenarios. Move `createRelayStack` inside the `for` loop so each scenario gets a fresh relay with a fresh init sequence captured by the proxy.

The structure changes from:
```
proxy.start()
relayStack = createRelayStack(...)
switchModel(...)
for (scenario of scenarios) {
    record scenario
    proxy.reset()
}
relayStack.stop()
```

To:
```
proxy.start()
for (scenario of scenarios) {
    proxy.reset()
    try {
        relayStack = createRelayStack(...)
        switchModel(...)
        record scenario
        save recording          // BEFORE stop — stop generates teardown traffic
    } finally {
        await withTimeout(relayStack?.stop(), 10_000)  // prevent hang from lingering keep-alive
    }
}
```

Key changes:
- `proxy.reset()` moves to the START of each iteration (before relay creation)
- `createRelayStack(...)` moves inside the loop
- `switchModelViaWs(...)` moves inside the loop (must happen per-relay)
- Each iteration wrapped in `try/finally` — ensures relay cleanup even if `switchModel` or recording fails
- Save recording BEFORE `relayStack.stop()` — stop generates teardown HTTP traffic (SSE disconnect) that would pollute the recording
- Wrap `relayStack.stop()` in a timeout (`Promise.race`) to prevent hangs from lingering keep-alive connections
- Remove only the `if (relayStack) { ... relayStack.stop() }` block from the outer `finally`. Keep `proxy.stop()` and `opencode.stop()` in the outer `finally`

**Step 2: Verify recording still works for a single scenario**

Run: `SCENARIO=chat-simple pnpm test:record-snapshots`
Expected: Completes successfully, produces `chat-simple.opencode.json.gz`

**Step 3: Verify the recording includes init data**

```bash
node -e "
const zlib = require('zlib');
const fs = require('fs');
const r = JSON.parse(zlib.gunzipSync(fs.readFileSync('test/e2e/fixtures/recorded/chat-simple.opencode.json.gz')).toString());
const types = {};
for (const ix of r.interactions) {
  if (ix.kind === 'rest') {
    const key = ix.method + ' ' + ix.path.split('?')[0];
    types[key] = (types[key] || 0) + 1;
  }
}
console.log(JSON.stringify(types, null, 2));
"
```

Expected: Output includes `"GET /path"`, `"GET /command"`, `"GET /file"`, `"GET /config"`, `"GET /session"` entries.

**Step 4: Commit**

```bash
git add test/e2e/scripts/record-snapshots.ts
git commit -m "fix: create fresh relay per scenario in recording script

Each scenario now gets its own RelayStack so the recording captures the
full init sequence (GET /path, GET /command, GET /file, etc.). Previously,
only the first scenario included init data because the proxy was reset
between scenarios while sharing a single relay."
```

---

## Task 2: Remove all fallbacks and synthetics from MockOpenCodeServer

**Files:**
- Modify: `test/helpers/mock-opencode-server.ts:302-473`

**Step 1: Remove all ensureFallback calls from buildQueues**

Delete lines 353-374 (the `ensureFallback` calls for GET /path, GET /command, GET /file) and their comments.

**Step 2: Remove the message normalized override**

Delete lines 379-384 (the `normalizedQueues.set(msgNormKey, ...)` block) and its comment.

**Step 3: Remove promoteTargetSession call**

Delete line 377 (`this.promoteTargetSession();`) and the `promoteTargetSession` method (lines 440-473).

**Step 4: Remove the ensureFallback method**

Delete lines 402-410 (the `ensureFallback` private method). It has no remaining callers.

**Step 5: Remove findTargetSessionId and targetSessionId**

The `targetSessionId` property (line 135) and `findTargetSessionId` method (lines 425-433) are used by `promoteTargetSession` AND by the E2E spec `test/e2e/specs/notification-session-nav-replay.spec.ts:138` (`mockServer.targetSessionId`). Remove the property, method, and constructor call. Then update the E2E spec to extract the target session ID from the recording directly:

```typescript
// Replace mockServer.targetSessionId with:
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

Or inline it where needed in the spec. The spec should import the recording loader and extract the ID itself.

**Step 6: Verify compilation**

Run: `pnpm check`
Expected: Clean.

**Step 7: Verify unit tests**

The FIXTURE constant and all existing unit tests are self-contained and do not depend on fallbacks, `promoteTargetSession`, or `targetSessionId`. No unit test modifications needed — confirm all pass.

Run: `pnpm vitest run test/unit/helpers/mock-opencode-server.test.ts`
Expected: All tests pass without changes.

**Step 8: Commit**

```bash
git add test/helpers/mock-opencode-server.ts test/unit/helpers/mock-opencode-server.test.ts test/e2e/specs/notification-session-nav-replay.spec.ts
git commit -m "refactor: remove all synthetic fallbacks from MockOpenCodeServer

Remove ensureFallback calls (GET /path, GET /command, GET /file), the
message normalized override, promoteTargetSession, and associated helpers.
Recordings are now the sole source of truth — no synthetic data is injected.

The GET /file fallback was causing infinite recursive directory traversal
that blocked 4 E2E tests (permissions, multi-turn, advanced-ui file
history)."
```

---

## Task 3: Re-record all fixtures

**Step 1: Re-record all scenarios**

Run: `pnpm test:record-snapshots`
Expected: All 12 scenarios record successfully. Each `.opencode.json.gz` file includes init data.

Note: This requires a working OpenCode instance. The script spawns one automatically using `big-pickle` (free model). Ensure `OPENCODE_SERVER_PASSWORD` is set if required.

**Step 2: Verify all recordings have init data**

```bash
node -e "
const zlib = require('zlib');
const fs = require('fs');
const files = fs.readdirSync('test/e2e/fixtures/recorded').filter(f => f.endsWith('.gz'));
for (const f of files) {
  const r = JSON.parse(zlib.gunzipSync(fs.readFileSync('test/e2e/fixtures/recorded/' + f)).toString());
  const name = f.replace('.opencode.json.gz', '');
  const hasPath = r.interactions.some(ix => ix.kind === 'rest' && ix.method === 'GET' && ix.path === '/path');
  const hasCmd = r.interactions.some(ix => ix.kind === 'rest' && ix.method === 'GET' && ix.path === '/command');
  const hasFile = r.interactions.some(ix => ix.kind === 'rest' && ix.method === 'GET' && ix.path.startsWith('/file'));
  console.log(name.padEnd(30) + 'path=' + (hasPath ? 'Y' : 'N') + ' cmd=' + (hasCmd ? 'Y' : 'N') + ' file=' + (hasFile ? 'Y' : 'N'));
}
"
```

Expected: ALL recordings show `path=Y cmd=Y file=Y`.

**Step 3: Commit recordings**

```bash
git add test/e2e/fixtures/recorded/
git commit -m "chore: re-record all E2E fixtures with full init sequences

Each recording now captures the complete relay init sequence including
GET /path, GET /command, GET /file, GET /config, GET /session, and
GET /event. No synthetic fallbacks needed."
```

---

## Task 4: Full verification

**Step 1: Unit tests**

Run: `pnpm test:unit`
Expected: All 3739+ tests pass.

**Step 2: Type checking and lint**

Run: `pnpm check && pnpm lint`
Expected: Clean.

**Step 3: Run previously-failing E2E tests**

Run: `pnpm exec playwright test --config test/e2e/playwright-replay.config.ts test/e2e/specs/permissions.spec.ts test/e2e/specs/chat-lifecycle.spec.ts test/e2e/specs/advanced-ui.spec.ts --reporter=list`

Expected improvements:
- permissions.spec.ts: 2/2 pass (was 0/2 — blocked by file recursion)
- chat-lifecycle.spec.ts: 5/5 pass (was 4/5 — multi-turn blocked by file recursion)
- advanced-ui.spec.ts: File History passes; Split Diff View still skipped (component not wired up)

**Step 4: Run full replay E2E suite**

Run: `pnpm exec playwright test --config test/e2e/playwright-replay.config.ts --reporter=list`
Expected: No regressions. All non-skipped tests pass.

**Step 5: Final commit if adjustments needed**

```bash
git add -A
git commit -m "fix: resolve E2E test failures caused by mock file recursion

Removed all synthetic fallbacks from MockOpenCodeServer. Updated the
recording script to create a fresh relay per scenario so each recording
captures the full init sequence. Re-recorded all 12 fixtures.

Fixes: permissions (2 tests), chat-lifecycle multi-turn (1 test),
advanced-ui file history (1 test)."
```

---

## Risk Analysis

### What could go wrong

1. **Recording fails**: The ephemeral OpenCode instance might not start, or the free model might be unavailable. Mitigation: the script already handles retries and has configurable model/provider.

2. **Recordings differ from expectations**: New recordings capture more data (all init requests). The mock's queue will have more entries. If the replay request pattern differs from the recording pattern, some responses could be wrong. Mitigation: the queue system handles this via exact → normalized fallback. Monitor the E2E tests for unexpected 404s.

3. **promoteTargetSession removal breaks session selection**: The relay might not select the target session without synthetic promotion. Mitigation: with fresh relay per scenario, the target session is the most recent and naturally selected. If this breaks, re-add a minimal version.

4. **Message normalized override removal causes cross-session bleed**: Non-target sessions might get the target's messages from the normalized queue. Mitigation: with full init captured, the recordings include real message responses for all sessions. The exact queue handles most lookups. Monitor for session-related test failures.

### What stays unchanged

- SSE segment model (prompt-segmented emission)
- Stateful session endpoints (POST/DELETE/PATCH session)
- PTY WebSocket handling
- Recording types and format
- E2E test specs and page objects
