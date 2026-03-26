# Notification State Reducer + Server Reconciliation

Date: 2026-03-26

## Problem

The current notification tracking (`remoteQuestionCounts`, `doneNotViewedSessions`) is a client-side cache with no self-correction. We've patched it with ref-counting, force-eviction, and done-eviction, but the fundamental drift problem remains. State is mutated by 6+ functions from different call sites, making it hard to trace why a session shows a stale indicator.

## Design

Replace the scattered mutation functions with three interlocking patterns:

### 1. Discriminated Union Per-Session State

Each session's indicator state is exactly one of:

```typescript
type SessionNotifState =
  | { kind: "none" }
  | { kind: "attention"; questions: number; permissions: number }
  | { kind: "done-unviewed" };
```

- `"attention"` always has `questions + permissions > 0` (reducer enforces this)
- `"attention"` and `"done-unviewed"` are mutually exclusive (one union variant, not both)
- Consumption code pattern-matches on `kind`

### 2. Typed Reducer

All state transitions go through a single pure function:

```typescript
type NotifAction =
  | { type: "question_appeared"; sessionId: string }
  | { type: "question_resolved"; sessionId: string }
  | { type: "permission_appeared"; sessionId: string }
  | { type: "permission_resolved"; sessionId: string }
  | { type: "session_done"; sessionId: string }
  | { type: "session_viewed"; sessionId: string }
  | { type: "reconcile"; counts: Map<string, { questions: number; permissions: number }> }
  | { type: "reset" };

function reduce(state: NotifMap, action: NotifAction): NotifMap { ... }
```

A single `dispatch(action)` replaces `addRemoteQuestion`, `removeRemoteQuestion`, `evictRemoteQuestions`, etc. In dev mode, log every action.

### 3. Server Reconciliation

**Server change:** Add `pendingQuestionCount` and `pendingPermissionCount` to `SessionInfo`. The `toSessionInfoList` builder calls `listPendingQuestions()` (one lightweight API call, returns all pending questions) and counts per session. Permissions are already tracked in-memory by the relay.

**Frontend:** Every session list refresh fires `dispatch({ type: "reconcile", counts })`. The reducer rebuilds the `"attention"` states from server truth, preserving `"done-unviewed"` entries (client-local). Between reconciliations, `notification_event` messages fire optimistic actions for instant UI updates. Drift self-corrects every 1-3 seconds.

## State Ownership

| State | Owner | Location |
|-------|-------|----------|
| Cross-session indicators (sidebar dots, banner) | **New reducer** | `notification-reducer.ts` |
| Current session's pending questions (QuestionCards) | `permissionsState.pendingQuestions` (unchanged) | `permissions.svelte.ts` |
| Current session's pending permissions (PermissionCards) | `permissionsState.pendingPermissions` (unchanged) | `permissions.svelte.ts` |
| Done-not-viewed | **New reducer** (`session_done` action) | `notification-reducer.ts` |

The permissions store keeps its existing role for local session state. The new reducer owns only cross-session indicator state.

## Files Changed

| File | Change |
|------|--------|
| New: `src/lib/frontend/stores/notification-reducer.ts` | Pure reducer, types, dispatch, derived getters |
| `src/lib/shared-types.ts` | Add `pendingQuestionCount?`, `pendingPermissionCount?` to `SessionInfo` |
| `src/lib/session/session-manager.ts` | Pass pending question counts to `toSessionInfoList` |
| `src/lib/frontend/stores/permissions.svelte.ts` | Remove `remoteQuestionCounts`, `doneNotViewedSessions`, `addRemoteQuestion`, `removeRemoteQuestion`, `evictRemoteQuestions`, `getSessionIndicator`, `handleNotificationEvent` (moved to reducer) |
| `src/lib/frontend/stores/ws-dispatch.ts` | Call `dispatch()` instead of mutation functions |
| `src/lib/frontend/components/session/SessionItem.svelte` | Read from reducer's `getSessionIndicator` |
| `src/lib/frontend/components/permissions/AttentionBanner.svelte` | Read from reducer's getters |
| Tests | New reducer unit tests (pure function — trivial to test) |

## Key Property

The reducer is a **pure function**: `(state, action) => newState`. No side effects, no async, no imports of other stores. Testing is: given state X and action Y, assert state Z. Debugging is: print the action log.
