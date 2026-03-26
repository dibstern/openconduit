# Scroll Controller & Chat Phase Refactor Design

## Problem

Two scroll bugs in the chat frontend:

1. **History replay scrolling:** When switching to a session with existing history, the message list visibly scrolls downward as messages are replayed in batches. Users see the chat "building up" instead of appearing at the final position.

2. **Streaming snap-back:** When the assistant is streaming and the user scrolls up, the viewport snaps back to the bottom on each update tick. A race condition between programmatic scroll and the scroll event handler that sets `isUserScrolledUp` means the guard fails.

Both stem from the same architectural issue: scroll logic is spread across three competing `$effect`s in `MessageList.svelte` that read ambiguous reactive state and fight each other.

## Design

### 1. Scroll Controller State Machine

Extract all scroll logic from `MessageList.svelte` into `src/lib/frontend/stores/scroll-controller.svelte.ts`.

Four states:

```
Loading  ->  Settling  ->  Following  <->  Detached
   |                           ^                |
   +------ (cache hit) --------+                |
                               +--- (scroll-to-bottom click)
```

| State | Meaning | Scroll behavior |
|-------|---------|----------------|
| Loading | Session switched, replay in progress | All scroll suppressed |
| Settling | Messages in DOM, deferred markdown rendering | rAF loop jumps to bottom until scrollHeight stabilizes (max 30 frames, 2 consecutive stable frames = done) |
| Following | User at/near bottom of active session | Auto-scroll on new content via rAF after DOM update |
| Detached | User scrolled up deliberately | No programmatic scrolling; show scroll-to-bottom button |

### 2. Decoupled Reactive Architecture

No direct coupling between chat pipeline and scroll controller. Communication via a shared reactive signal:

```typescript
// chat.svelte.ts
type LoadLifecycle = 'empty' | 'loading' | 'committed' | 'ready';
```

The scroll controller derives its state from `loadLifecycle` + its own user-input tracking:

```typescript
// scroll-controller.svelte.ts
const scrollPhase = $derived.by(() => {
  if (loadLifecycle === 'loading')   return 'loading';
  if (loadLifecycle === 'committed') return 'settling';
  if (userDetached)                  return 'detached';
  return 'following';
});
```

Factory function pattern for testability:

```typescript
export function createScrollController(
  getLifecycle: () => LoadLifecycle,
  getMessageCount: () => number,
): ScrollController;
```

### 3. Bug #1 Fix: Single-Commit Replay

Instead of committing messages in batches of 80 (each triggering DOM updates and scroll effects):

1. Process all replay events into a non-reactive buffer (plain array)
2. Slice the last 50 messages for initial render
3. Store the remainder in a session scroll-back buffer for HistoryLoader
4. Commit the 50 messages in one assignment to `chatState.messages`
5. Set `loadLifecycle = 'committed'`

During Loading, the scroll controller is a no-op. After commit, Settling jumps to bottom once and waits for deferred markdown to stabilize heights.

### 4. Bug #2 Fix: Input-Based Detach Detection

Replace `isUserScrolledUp` (set by async scroll event handler, race-prone) with user-input event detection:

```typescript
container.addEventListener('wheel', onUserScrollUp, { passive: true });
container.addEventListener('touchmove', onUserScrollUp, { passive: true });
```

A `wheel` event with `deltaY < 0` immediately transitions to Detached. No race condition -- we detect intent at the moment of input.

### 5. Phase Type Split

Separate orthogonal concerns in the chat store:

```typescript
// Before (mixed):
type ChatPhase = 'idle' | 'processing' | 'streaming' | 'replaying';

// After (separated):
type AssistantPhase = 'idle' | 'processing' | 'streaming';
type LoadLifecycle  = 'empty' | 'loading' | 'committed' | 'ready';
```

Key consequences:
- `_replayInnerStreaming` workaround variable is deleted (4 references)
- `phaseEndReplay()` reconciliation (16 lines) collapses to `chatState.loadLifecycle = 'ready'`
- `isProcessing()` internally gates on `loadLifecycle !== 'loading'` so UI behavior is unchanged
- Blast radius: 3 files must change (`chat.svelte.ts`, `ws-dispatch.ts`, `AssistantMessage.svelte`), UI components unaffected

### 6. isUserScrolledUp Removal

Remove `isUserScrolledUp` from `ui.svelte.ts` and `setUserScrolledUp()`. Replace with `scrollController.isDetached` (derived from user input events inside the controller). Single owner, single source of truth.

### 7. Unified Paging for All Load Paths

Cap initial render at 50 messages regardless of session size. Older messages load via scroll-up through HistoryLoader, reading from a local buffer (no server round-trip for recently-replayed events).

## Blast Radius

| Category | Files | Impact |
|----------|-------|--------|
| Must change | `chat.svelte.ts`, `ws-dispatch.ts`, `AssistantMessage.svelte` | 28 references, mostly mechanical |
| No change | All other UI components | `isProcessing()` semantics preserved via internal gating |

## Files Created/Modified

- **Create:** `src/lib/frontend/stores/scroll-controller.svelte.ts`
- **Modify:** `src/lib/frontend/stores/chat.svelte.ts` (phase split, single-commit replay, load lifecycle)
- **Modify:** `src/lib/frontend/stores/ws-dispatch.ts` (replay function, phase transition calls)
- **Modify:** `src/lib/frontend/stores/ui.svelte.ts` (remove isUserScrolledUp)
- **Modify:** `src/lib/frontend/components/chat/MessageList.svelte` (consume scroll controller, remove 3 $effects)
- **Modify:** `src/lib/frontend/components/chat/AssistantMessage.svelte` (isReplaying -> isLoading)
