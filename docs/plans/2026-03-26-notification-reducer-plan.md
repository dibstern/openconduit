# Notification Reducer Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Replace scattered notification state mutations with a typed reducer, discriminated union per-session state, and server reconciliation.

**Architecture:** New `notification-reducer.ts` owns all cross-session indicator state (sidebar dots, AttentionBanner, done-not-viewed). Pure reducer function `(state, action) => newState` handles all transitions. Server provides `pendingQuestionCount` and `pendingPermissionCount` on `SessionInfo` for reconciliation. Existing `permissions.svelte.ts` keeps only local-session state (pendingQuestions, pendingPermissions for current view).

**Tech Stack:** TypeScript, Svelte 5 ($state), Vitest

---

### Task 1: Create notification-reducer.ts with types and pure reducer

**Files:**
- Create: `src/lib/frontend/stores/notification-reducer.ts`
- Create: `test/unit/stores/notification-reducer.test.ts`

**Step 1: Write types and reducer skeleton**

Create `src/lib/frontend/stores/notification-reducer.ts`:

```typescript
// ─── Notification Reducer ──────────────────────────────────────────────────
// Pure reducer for cross-session notification indicator state.
// Replaces the scattered mutation functions in permissions.svelte.ts.
//
// Three patterns combined:
// 1. Discriminated union per-session state (structurally safe)
// 2. Typed reducer (single dispatch, exhaustive handling)
// 3. Server reconciliation (drift self-corrects on session list refresh)

// ─── Per-Session State (discriminated union) ────────────────────────────────

export type SessionNotifState =
    | { kind: "none" }
    | { kind: "attention"; questions: number; permissions: number }
    | { kind: "done-unviewed" };

// ─── State Map ──────────────────────────────────────────────────────────────

export type NotifMap = ReadonlyMap<string, SessionNotifState>;

// ─── Actions ────────────────────────────────────────────────────────────────

export type NotifAction =
    | { type: "question_appeared"; sessionId: string }
    | { type: "question_resolved"; sessionId: string }
    | { type: "permission_appeared"; sessionId: string }
    | { type: "permission_resolved"; sessionId: string }
    | { type: "session_done"; sessionId: string }
    | { type: "session_viewed"; sessionId: string }
    | { type: "reconcile"; counts: ReadonlyMap<string, { questions: number; permissions: number }> }
    | { type: "reset" };

// ─── Reducer (pure function) ────────────────────────────────────────────────

const NONE: SessionNotifState = { kind: "none" };

function getAttention(state: NotifMap, sessionId: string): { questions: number; permissions: number } {
    const entry = state.get(sessionId);
    if (entry?.kind === "attention") return { questions: entry.questions, permissions: entry.permissions };
    return { questions: 0, permissions: 0 };
}

function setAttentionOrRemove(next: Map<string, SessionNotifState>, sessionId: string, q: number, p: number): void {
    if (q <= 0 && p <= 0) {
        next.delete(sessionId);
    } else {
        next.set(sessionId, { kind: "attention", questions: Math.max(0, q), permissions: Math.max(0, p) });
    }
}

export function reduce(state: NotifMap, action: NotifAction): NotifMap {
    switch (action.type) {
        case "question_appeared": {
            const { questions, permissions } = getAttention(state, action.sessionId);
            const next = new Map(state);
            next.set(action.sessionId, { kind: "attention", questions: questions + 1, permissions });
            return next;
        }
        case "question_resolved": {
            // Force-evict all question counts (resolved is authoritative)
            const { permissions } = getAttention(state, action.sessionId);
            const next = new Map(state);
            setAttentionOrRemove(next, action.sessionId, 0, permissions);
            return next;
        }
        case "permission_appeared": {
            const { questions, permissions } = getAttention(state, action.sessionId);
            const next = new Map(state);
            next.set(action.sessionId, { kind: "attention", questions, permissions: permissions + 1 });
            return next;
        }
        case "permission_resolved": {
            const { questions, permissions } = getAttention(state, action.sessionId);
            const next = new Map(state);
            setAttentionOrRemove(next, action.sessionId, questions, Math.max(0, permissions - 1));
            return next;
        }
        case "session_done": {
            // Done session can't have pending questions — evict attention, add done-unviewed
            const next = new Map(state);
            next.set(action.sessionId, { kind: "done-unviewed" });
            return next;
        }
        case "session_viewed": {
            // Clear all indicators for the viewed session
            const next = new Map(state);
            next.delete(action.sessionId);
            return next;
        }
        case "reconcile": {
            // Server truth overwrites attention states.
            // Preserve done-unviewed (client-local).
            const next = new Map<string, SessionNotifState>();
            // First, carry over done-unviewed entries
            for (const [sid, entry] of state) {
                if (entry.kind === "done-unviewed") {
                    next.set(sid, entry);
                }
            }
            // Then apply server counts
            for (const [sid, counts] of action.counts) {
                if (counts.questions > 0 || counts.permissions > 0) {
                    // Server says this session needs attention — overwrite even if done-unviewed
                    next.set(sid, { kind: "attention", questions: counts.questions, permissions: counts.permissions });
                }
            }
            return next;
        }
        case "reset": {
            return new Map();
        }
    }
    // TypeScript exhaustive check
    const _exhaustive: never = action;
    return state;
}
```

**Step 2: Write comprehensive tests**

Create `test/unit/stores/notification-reducer.test.ts` with tests for every action type:
- `question_appeared` increments, creates attention from none
- `question_appeared` on done-unviewed transitions to attention
- `question_resolved` force-evicts questions, preserves permissions
- `question_resolved` on empty state is no-op
- `permission_appeared` / `permission_resolved` symmetric behavior
- `session_done` overwrites attention with done-unviewed
- `session_viewed` deletes entry entirely
- `reconcile` overwrites attention, preserves done-unviewed, adds new attention
- `reconcile` overwrites done-unviewed when server says attention
- `reset` returns empty map
- Exhaustive action handling (TypeScript compile-time check)

**Step 3: Run tests**

Run: `pnpm test:unit notification-reducer`
Expected: All pass.

**Step 4: Commit**

```
git add -A && git commit -m "feat: pure notification reducer with discriminated union state and reconciliation"
```

---

### Task 2: Add Svelte store wrapper with dispatch and derived getters

**Files:**
- Modify: `src/lib/frontend/stores/notification-reducer.ts` (add Svelte integration)

**Step 1: Add Svelte $state wrapper and dispatch**

Add to `notification-reducer.ts` below the pure reducer:

```typescript
// ─── Svelte Store Integration ───────────────────────────────────────────────

import { DEV } from "esm-env";

let _state = $state<NotifMap>(new Map());

/** Dispatch an action through the reducer. In dev mode, log all actions. */
export function dispatch(action: NotifAction): void {
    if (DEV) {
        console.debug("[notif]", action.type, action);
    }
    _state = reduce(_state, action);
}

/** Get the current notification state for a session. */
export function getNotifState(sessionId: string): SessionNotifState {
    return _state.get(sessionId) ?? NONE;
}

/** Get session indicator for sidebar dot rendering. Returns null for current session. */
export function getSessionIndicator(
    sessionId: string,
    currentSessionId: string | null,
): "attention" | "done-unviewed" | null {
    if (sessionId === currentSessionId) return null;
    const entry = _state.get(sessionId);
    if (!entry || entry.kind === "none") return null;
    if (entry.kind === "attention") return "attention";
    if (entry.kind === "done-unviewed") return "done-unviewed";
    return null;
}

/** Get all sessions needing attention (for AttentionBanner). Excludes current session and descendants. */
export function getAttentionSessions(
    currentSessionId: string | null,
    getDescendantIds: (sid: string) => Set<string>,
): Map<string, { questions: number; permissions: number }> {
    const result = new Map<string, { questions: number; permissions: number }>();
    const descendants = currentSessionId ? getDescendantIds(currentSessionId) : new Set<string>();
    for (const [sid, entry] of _state) {
        if (entry.kind !== "attention") continue;
        if (sid === currentSessionId || descendants.has(sid)) continue;
        result.set(sid, { questions: entry.questions, permissions: entry.permissions });
    }
    return result;
}

/** Reset internal state (for testing). */
export function resetNotifState(): void {
    _state = new Map();
}
```

**Step 2: Run type check**

Run: `pnpm check`
Expected: Pass.

**Step 3: Commit**

```
git add -A && git commit -m "feat: add Svelte store wrapper with dispatch and derived getters for notification reducer"
```

---

### Task 3: Add `pendingQuestionCount` to SessionInfo (server side)

**Files:**
- Modify: `src/lib/shared-types.ts:139-150` (add field to SessionInfo)
- Modify: `src/lib/session/session-manager.ts:133-174` (pass counts to builder)
- Modify: `src/lib/session/session-manager.ts:410-444` (add counts in toSessionInfoList)

**Step 1: Add fields to SessionInfo**

In `src/lib/shared-types.ts`, add to `SessionInfo`:
```typescript
/** Number of pending questions on this session (from server). */
pendingQuestionCount?: number;
```

Note: permissions are relay-side state (not from OpenCode API), so we'll add `pendingPermissionCount` in a later task when we wire up the relay's permission tracking.

**Step 2: Cache pending question counts in SessionManager**

Add to `SessionManager`:
```typescript
private pendingQuestionCounts = new Map<string, number>();

/** Update pending question counts (called from SSE wiring on rehydrate, ask_user, ask_user_resolved). */
updatePendingQuestionCount(sessionId: string, count: number): void {
    if (count <= 0) {
        this.pendingQuestionCounts.delete(sessionId);
    } else {
        this.pendingQuestionCounts.set(sessionId, count);
    }
}

/** Bulk-set pending question counts (called on SSE reconnect from listPendingQuestions). */
setPendingQuestionCounts(counts: Map<string, number>): void {
    this.pendingQuestionCounts = counts;
}
```

**Step 3: Include counts in toSessionInfoList**

Pass `this.pendingQuestionCounts` to `toSessionInfoList`. In the builder:
```typescript
const qCount = pendingQuestionCounts?.get(s.id);
if (qCount != null && qCount > 0) {
    info.pendingQuestionCount = qCount;
}
```

**Step 4: Wire up SSE events to update counts**

In `src/lib/relay/sse-wiring.ts`:
- On `ask_user` event: `sessionMgr.updatePendingQuestionCount(sessionId, (current + 1))`
- On rehydration (`listPendingQuestions` response): rebuild counts Map from the API response, call `sessionMgr.setPendingQuestionCounts(counts)`

In `src/lib/handlers/permissions.ts`:
- On `handleAskUserResponse` / `handleQuestionReject`: `sessionMgr.updatePendingQuestionCount(sessionId, Math.max(0, current - 1))`

**Step 5: Run type check + existing tests**

Run: `pnpm check && pnpm test:unit`
Expected: Pass (new fields are optional, no breaking changes).

**Step 6: Commit**

```
git add -A && git commit -m "feat: add pendingQuestionCount to SessionInfo with server-side tracking"
```

---

### Task 4: Wire frontend to use reducer + reconciliation

**Files:**
- Modify: `src/lib/frontend/stores/ws-dispatch.ts` (dispatch actions instead of mutation functions)
- Modify: `src/lib/frontend/stores/permissions.svelte.ts` (remove cross-session tracking state)
- Modify: `src/lib/frontend/components/session/SessionItem.svelte` (import from reducer)
- Modify: `src/lib/frontend/components/permissions/AttentionBanner.svelte` (read from reducer)

**Step 1: Update ws-dispatch.ts**

Replace mutation function calls with `dispatch()`:

- `notification_event` with `ask_user` → `dispatch({ type: "question_appeared", sessionId })`
- `notification_event` with `ask_user_resolved` → `dispatch({ type: "question_resolved", sessionId })`
- `notification_event` with `done` → `dispatch({ type: "session_done", sessionId })`
- `session_switched` → `dispatch({ type: "session_viewed", sessionId: msg.id })`
- `session_list` / `session_list_all` → extract `pendingQuestionCount` from each session, build reconcile counts Map, `dispatch({ type: "reconcile", counts })`
- Disconnect/project switch → `dispatch({ type: "reset" })`

Remove imports of `addRemoteQuestion`, `removeRemoteQuestion`, `evictRemoteQuestions`, `handleNotificationEvent`, `onSessionSwitch` from permissions store. Replace `onSessionSwitch` calls with: `clearSessionLocal(previousSessionId)` (for local permission cleanup) + `dispatch({ type: "session_viewed", sessionId })`.

**Step 2: Update permissions.svelte.ts**

Remove:
- `remoteQuestionCounts` from `permissionsState`
- `doneNotViewedSessions` from `permissionsState`
- `addRemoteQuestion`, `removeRemoteQuestion`, `evictRemoteQuestions`
- `handleNotificationEvent`, `NotificationEventParams`
- `onSessionSwitch`
- `getSessionIndicator`
- `getRemoteQuestionSessions`, `getRemoteQuestionCount`

Keep:
- `pendingPermissions`, `pendingQuestions`, `questionErrors`
- `handleAskUser`, `handleAskUserResolved` (for local QuestionCard state — but remove the `evictRemoteQuestions` call from `handleAskUserResolved`)
- `handlePermissionRequest`, `handlePermissionResolved`
- `clearSessionLocal`, `clearAll`, `clearAllPermissions`
- `getLocalPermissions`, `getRemotePermissions`
- All pure helpers

**Step 3: Update SessionItem.svelte**

Change import from `../../stores/permissions.svelte.js` to `../../stores/notification-reducer.js`:
```typescript
import { getSessionIndicator } from "../../stores/notification-reducer.js";
```

The derived and template remain the same — `getSessionIndicator` has the same signature.

**Step 4: Update AttentionBanner.svelte**

Replace:
- `getRemoteQuestionSessions` → `getAttentionSessions` from reducer
- `getRemoteQuestionCount` → read from the Map returned by `getAttentionSessions`
- Remove `removeRemoteQuestion` import (the `goToSession` function should dispatch `session_viewed` instead)

**Step 5: Run full verification**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: Pass (may need test updates for removed exports).

**Step 6: Commit**

```
git add -A && git commit -m "refactor: wire frontend to notification reducer, remove scattered mutation functions"
```

---

### Task 5: Update existing tests

**Files:**
- Modify: `test/unit/stores/permissions-store.test.ts` (remove tests for deleted functions)
- Modify: `test/unit/frontend/dispatch-notifications.test.ts` (if affected)
- Modify: story files (if they reference deleted state)

**Step 1: Remove tests for deleted functions**

In `permissions-store.test.ts`, remove test sections for:
- `handleAskUserResolved — remoteQuestionCounts cleanup`
- `handleNotificationEvent`
- `onSessionSwitch` (the `doneNotViewedSessions` parts)
- `ref-counting for remoteQuestionCounts`
- `getSessionIndicator`

Keep tests for: `handleAskUser`, `handleAskUserResolved` (local pendingQuestions cleanup only), permissions, pure helpers.

Update `beforeEach` to remove `remoteQuestionCounts` and `doneNotViewedSessions` resets.

**Step 2: Run full verification**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: All pass.

**Step 3: Commit**

```
git add -A && git commit -m "chore: update tests for notification reducer migration"
```

---

### Task 6: Final verification and cleanup

**Step 1: Run full verification**

```
pnpm check && pnpm lint && pnpm test:unit
```

**Step 2: Verify no references to deleted functions remain**

Search for: `addRemoteQuestion`, `removeRemoteQuestion`, `evictRemoteQuestions`, `remoteQuestionCounts`, `doneNotViewedSessions`, `handleNotificationEvent` (from permissions store — the reducer has its own version).

**Step 3: Commit cleanup if needed**

```
git add -A && git commit -m "chore: remove stale references after notification reducer migration"
```
