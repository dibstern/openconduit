# Scroll Controller & Chat Phase Refactor Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Fix visible scrolling on history replay and snap-back during streaming by extracting scroll logic into a dedicated controller with a state machine, splitting ChatPhase into orthogonal AssistantPhase + LoadLifecycle types, and implementing single-commit replay with 50-message paging.

**Architecture:** A new `scroll-controller.svelte.ts` module owns all scroll state and behavior. The chat store exposes a `loadLifecycle` reactive signal that the controller derives from. `MessageList.svelte` becomes a thin consumer that binds the DOM container and delegates to the controller. The replay path accumulates all events into a non-reactive buffer, then commits only the last 50 messages.

**Tech Stack:** Svelte 5 (runes: `$state`, `$derived`, `$effect`), TypeScript (strict), Vitest

---

### Task 1: Add LoadLifecycle type and state to chat store

**Files:**
- Modify: `src/lib/frontend/stores/chat.svelte.ts:45-86`

**Step 1: Write the failing test**

Add to `test/unit/stores/chat-phase.test.ts`:

```typescript
import {
  // existing imports...
  isLoading,
} from "../../../src/lib/frontend/stores/chat.svelte.js";

describe("LoadLifecycle", () => {
  it("defaults to 'empty'", () => {
    expect(chatState.loadLifecycle).toBe("empty");
  });

  it("isLoading() returns true only when loading", () => {
    chatState.loadLifecycle = "loading";
    expect(isLoading()).toBe(true);
    chatState.loadLifecycle = "empty";
    expect(isLoading()).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/stores/chat-phase.test.ts`
Expected: FAIL — `isLoading` not exported, `loadLifecycle` not a property

**Step 3: Write minimal implementation**

In `chat.svelte.ts`:

1. Add the type after `ChatPhase`:
```typescript
export type LoadLifecycle = "empty" | "loading" | "committed" | "ready";
```

2. Add `loadLifecycle` to `chatState`:
```typescript
export const chatState = $state({
  messages: [] as ChatMessage[],
  currentAssistantText: "",
  phase: "idle" as ChatPhase,
  loadLifecycle: "empty" as LoadLifecycle,
  queuedFlagsCleared: false,
  turnEpoch: 0,
});
```

3. Add derived flag and getter:
```typescript
const _isLoading = $derived(chatState.loadLifecycle === "loading");

export function isLoading(): boolean {
  return _isLoading;
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/stores/chat-phase.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: add LoadLifecycle type and state to chat store"
```

---

### Task 2: Split ChatPhase — remove 'replaying', gate isProcessing on loadLifecycle

**Files:**
- Modify: `src/lib/frontend/stores/chat.svelte.ts:45-149`
- Modify: `test/unit/stores/chat-phase.test.ts`

**Step 1: Write the failing tests**

Add to `test/unit/stores/chat-phase.test.ts`:

```typescript
describe("Phase split: replaying removed from ChatPhase", () => {
  it("isProcessing() returns false during loading even if phase is processing", () => {
    chatState.phase = "processing";
    chatState.loadLifecycle = "loading";
    expect(isProcessing()).toBe(false);
  });

  it("isProcessing() returns true when not loading and phase is processing", () => {
    chatState.phase = "processing";
    chatState.loadLifecycle = "ready";
    expect(isProcessing()).toBe(true);
  });

  it("phaseToStreaming sets phase directly (no _replayInnerStreaming)", () => {
    chatState.loadLifecycle = "loading";
    phaseToStreaming();
    expect(chatState.phase).toBe("streaming");
    expect(isStreaming()).toBe(false); // gated by loading
  });

  it("phaseToProcessing sets phase even during loading", () => {
    chatState.loadLifecycle = "loading";
    phaseToProcessing();
    expect(chatState.phase).toBe("processing");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/stores/chat-phase.test.ts`
Expected: FAIL — current code blocks phaseToProcessing during replaying, isProcessing doesn't gate on loadLifecycle

**Step 3: Implement the phase split**

In `chat.svelte.ts`:

1. Remove `"replaying"` from `ChatPhase`:
```typescript
export type ChatPhase = "idle" | "processing" | "streaming";
```

2. Gate derived flags on loadLifecycle:
```typescript
const _isProcessing = $derived(
  chatState.loadLifecycle !== "loading" &&
  (chatState.phase === "processing" || chatState.phase === "streaming"),
);
const _isStreaming = $derived(
  chatState.loadLifecycle !== "loading" && chatState.phase === "streaming",
);
const _isReplaying = $derived(chatState.loadLifecycle === "loading");
```

3. Simplify phase transition functions — remove all `replaying` guards:

```typescript
export function phaseToProcessing(): void {
  chatState.phase = "processing";
}

export function phaseToStreaming(): void {
  chatState.phase = "streaming";
}
```

4. Delete `_replayInnerStreaming` variable entirely.

5. Replace `phaseStartReplay`:
```typescript
export function phaseStartReplay(): void {
  chatState.loadLifecycle = "loading";
}
```

6. Replace `phaseEndReplay`:
```typescript
export function phaseEndReplay(llmActive: boolean): void {
  chatState.loadLifecycle = "ready";
  // phase already holds the correct AssistantPhase from replayed events.
  // If the last replayed event was done, phase is already idle.
  // If still mid-stream, phase is already streaming.
  // Only need to handle the llmActive-but-phase-idle edge case
  // (all turns completed but server says LLM is still active).
  if (llmActive && chatState.phase === "idle") {
    chatState.phase = "processing";
  }
}
```

7. Update `phaseReset`:
```typescript
function phaseReset(): void {
  chatState.phase = "idle";
  chatState.loadLifecycle = "empty";
}
```

8. Update all handler guards that check `chatState.phase === "replaying"`:

- `flushAndFinalizeAssistant` (line 260): Remove `_replayInnerStreaming` check. Now just check `chatState.phase !== "streaming"`.
- `handleDelta` (line 347-348): Remove `_replayInnerStreaming`. `isCurrentlyStreaming` becomes just `chatState.phase === "streaming"`.
- `handleToolStart` (lines 432-438): Remove `_replayInnerStreaming` branch. Now: `if (chatState.phase === "streaming") { flushAndFinalizeAssistant(); phaseToProcessing(); }`.
- `handleDone` (lines 569-576): Remove replaying guard. Always call `phaseToIdle()`.
- `handleError` (lines 636-639): Remove replaying guard. Always call `phaseToIdle()`.
- `addUserMessage` (lines 689-693): Remove replaying guard. Always call `phaseToIdle()` after flush.
- `flushAssistantRender` (lines 901-903): Change `chatState.phase === "replaying"` to `chatState.loadLifecycle === "loading"`.

**Step 4: Update existing tests that reference "replaying"**

Specific assertions in `test/unit/stores/chat-phase.test.ts` that will break:
- Line ~109: `expect(chatState.phase).toBe("replaying")` — change to check `chatState.loadLifecycle === "loading"`
- Line ~137: `expect(chatState.phase).toBe("replaying")` — same change
- Line ~165: Any `ChatPhase[]` type literal including `"replaying"` — remove it
- Any test calling `phaseStartReplay()` and checking `chatState.phase` — now check `loadLifecycle`
- Update the `ChatPhase` type import to include `LoadLifecycle` where needed

**Step 5: Add mid-stream replay test**

This is the most important behavioral test — replay ending mid-stream:

```typescript
it("phaseEndReplay with streaming phase sets lifecycle to ready and preserves streaming", () => {
  phaseStartReplay();
  expect(chatState.loadLifecycle).toBe("loading");
  
  // Simulate replay ending mid-stream (delta without done)
  phaseToStreaming(); // now allowed during loading
  expect(chatState.phase).toBe("streaming");
  expect(isStreaming()).toBe(false); // gated by loading
  
  phaseEndReplay(true);
  expect(chatState.loadLifecycle).toBe("ready");
  expect(chatState.phase).toBe("streaming");
  expect(isStreaming()).toBe(true); // now visible
  expect(isProcessing()).toBe(true);
});
```

**Step 6: Run all tests**

Run: `pnpm check`
Expected: Type errors if any code references the removed "replaying" literal — fix all.

Run: `pnpm test:unit`
Expected: Full green.

**Step 7: Commit**

```bash
git add -A && git commit -m "refactor: split ChatPhase into AssistantPhase + LoadLifecycle, remove _replayInnerStreaming"
```

---

### Task 3: Update ws-dispatch.ts for new phase API

**Files:**
- Modify: `src/lib/frontend/stores/ws-dispatch.ts:614-672`

**Step 1: Verify no new test needed**

The ws-dispatch replay tests go through `replayEvents()` which calls chat store functions. The chat-phase tests already cover the new behavior. Run the existing tests to confirm they still pass after Task 2.

Run: `pnpm vitest run test/unit/stores/`
Expected: PASS (ws-dispatch test files should pass with the new function signatures)

If any fail, fix the specific assertions.

**Step 2: Update imports**

In `ws-dispatch.ts`, ensure imports match the renamed/changed exports. The function names `phaseStartReplay` and `phaseEndReplay` stay the same (just their implementation changed in Task 2).

**Step 3: Verify**

Run: `pnpm check && pnpm test:unit`
Expected: All green.

**Step 4: Commit**

```bash
git add -A && git commit -m "chore: update ws-dispatch imports for phase split"
```

---

### Task 4: Update AssistantMessage.svelte — isReplaying to isLoading

**Files:**
- Modify: `src/lib/frontend/components/chat/AssistantMessage.svelte`

**Step 1: Replace import and usage**

Change:
```typescript
import { isReplaying } from "../../stores/chat.svelte.js";
```
to:
```typescript
import { isLoading } from "../../stores/chat.svelte.js";
```

Change all `isReplaying()` calls to `isLoading()`. The semantics are identical — skip expensive hljs/mermaid work during bulk loading.

**Step 2: Verify**

Run: `pnpm check && pnpm test:unit`
Expected: All green.

**Step 3: Commit**

```bash
git add -A && git commit -m "refactor: AssistantMessage uses isLoading instead of isReplaying"
```

---

### Task 5: Create scroll-controller.svelte.ts

**Files:**
- Create: `src/lib/frontend/stores/scroll-controller.svelte.ts`
- Create: `test/unit/stores/scroll-controller.test.ts`

**Step 1: Write the failing tests**

Create `test/unit/stores/scroll-controller.test.ts`.

NOTE: The scroll controller uses browser APIs (requestAnimationFrame, HTMLElement, events).
Tests must either:
- Use `// @vitest-environment jsdom` directive at the top of the file, OR
- Test only the pure state derivation logic (no DOM) by mocking rAF

Approach: Use jsdom environment + mock requestAnimationFrame:

```typescript
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock localStorage (required by transitive chat.svelte.ts import)
vi.hoisted(() => {
  let store: Record<string, string> = {};
  const mock = {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
    get length() { return Object.keys(store).length; },
    key: vi.fn((_: number) => null),
  };
  Object.defineProperty(globalThis, "localStorage", { value: mock, writable: true, configurable: true });
});

vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));

import { createScrollController, type ScrollState } from "../../../src/lib/frontend/stores/scroll-controller.svelte.js";
import type { LoadLifecycle } from "../../../src/lib/frontend/stores/chat.svelte.js";

describe("ScrollController", () => {
  let lifecycle: LoadLifecycle;

  function makeController() {
    lifecycle = "empty";
    return createScrollController(() => lifecycle);
  }

  it("starts in 'loading' state when lifecycle is 'empty'", () => {
    const ctrl = makeController();
    expect(ctrl.state).toBe("loading");
  });

  it("transitions to 'settling' when lifecycle becomes 'committed'", () => {
    const ctrl = makeController();
    lifecycle = "committed";
    expect(ctrl.state).toBe("settling");
  });

  it("transitions to 'following' when lifecycle becomes 'ready'", () => {
    const ctrl = makeController();
    lifecycle = "ready";
    expect(ctrl.state).toBe("following");
  });

  it("isDetached is false initially", () => {
    const ctrl = makeController();
    expect(ctrl.isDetached).toBe(false);
  });

  it("isLoading is true when lifecycle is loading or empty", () => {
    const ctrl = makeController();
    lifecycle = "loading";
    expect(ctrl.isLoading).toBe(true);
  });

  it("resetForSession clears detached state", () => {
    const ctrl = makeController();
    lifecycle = "ready";
    // Simulate detach via attach + wheel event
    const div = document.createElement("div");
    ctrl.attach(div);
    div.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    expect(ctrl.isDetached).toBe(true);
    ctrl.resetForSession();
    expect(ctrl.isDetached).toBe(false);
    ctrl.detach();
  });

  it("wheel up in following state transitions to detached", () => {
    const ctrl = makeController();
    lifecycle = "ready";
    const div = document.createElement("div");
    ctrl.attach(div);
    div.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    expect(ctrl.isDetached).toBe(true);
    ctrl.detach();
  });

  it("wheel down in following state stays following", () => {
    const ctrl = makeController();
    lifecycle = "ready";
    const div = document.createElement("div");
    ctrl.attach(div);
    div.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 }));
    expect(ctrl.isDetached).toBe(false);
    ctrl.detach();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/stores/scroll-controller.test.ts`
Expected: FAIL — module doesn't exist

**Step 3: Write the scroll controller**

Create `src/lib/frontend/stores/scroll-controller.svelte.ts`:

```typescript
// ─── Scroll Controller ───────────────────────────────────────────────────────
// State machine for chat scroll behavior. Derives scroll state from the chat
// store's LoadLifecycle signal and user input events. No direct coupling to
// the chat pipeline — communicates via reactive getters.

import type { LoadLifecycle } from "./chat.svelte.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ScrollState = "loading" | "settling" | "following" | "detached";

export interface ScrollController {
  /** Current scroll state. */
  readonly state: ScrollState;
  /** True when user has scrolled up (state === 'detached'). */
  readonly isDetached: boolean;
  /** True when content is loading (state === 'loading'). */
  readonly isLoading: boolean;

  /** Bind the scroll container element. Call on mount. */
  attach(container: HTMLElement): void;
  /** Unbind and clean up listeners. Call on unmount. */
  detach(): void;
  /** Reset for session switch — clears detached state and stops settle. */
  resetForSession(): void;
  /** User clicked scroll-to-bottom button. Detached -> Following. */
  requestFollow(): void;
  /** Notify that new content was added (for Following state auto-scroll). */
  onNewContent(): void;
  /** Notify that a prepend occurred — preserve scroll position. */
  onPrepend(prevScrollHeight: number, prevScrollTop: number): void;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const SETTLE_MAX_FRAMES = 60; // ~1s at 60fps — matches original settle duration
const SETTLE_STABLE_THRESHOLD = 2; // consecutive frames with same scrollHeight
const SCROLL_THRESHOLD = 100; // px from bottom to re-follow (matches original)

// ─── Factory ────────────────────────────────────────────────────────────────

export function createScrollController(
  getLifecycle: () => LoadLifecycle,
): ScrollController {
  let container: HTMLElement | null = null;
  let userDetached = false;
  let settleRafId: number | null = null;
  let settleFrameCount = 0; // persistent across onNewContent calls during settling

  // ── Derived state ─────────────────────────────────────────────────────

  function getState(): ScrollState {
    const lc = getLifecycle();
    if (lc === "empty" || lc === "loading") return "loading";
    if (lc === "committed") return "settling";
    if (userDetached) return "detached";
    return "following";
  }

  // ── Internal scroll helpers ───────────────────────────────────────────

  function scrollToBottom(): void {
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }

  function startSettle(): void {
    // Don't restart from frame 0 — continue where we left off.
    // This prevents deferred markdown renders from endlessly restarting settle.
    if (settleRafId !== null) return; // already settling
    settleFrameCount = 0;
    let lastHeight = 0;
    let stableCount = 0;

    function tick() {
      if (!container || settleFrameCount++ > SETTLE_MAX_FRAMES) {
        stopSettle();
        return;
      }

      // If lifecycle changed away from "committed", stop settling
      const lc = getLifecycle();
      if (lc !== "committed") {
        stopSettle();
        return;
      }

      scrollToBottom();

      // Check if height has stabilized
      const h = container.scrollHeight;
      if (h === lastHeight) {
        stableCount++;
        if (stableCount >= SETTLE_STABLE_THRESHOLD) {
          stopSettle();
          return;
        }
      } else {
        stableCount = 0;
      }
      lastHeight = h;
      settleRafId = requestAnimationFrame(tick);
    }

    settleRafId = requestAnimationFrame(tick);
  }

  function stopSettle(): void {
    if (settleRafId !== null) {
      cancelAnimationFrame(settleRafId);
      settleRafId = null;
    }
  }

  // ── Touch tracking for scroll-up detection ────────────────────────────
  let lastTouchY = 0;

  function onTouchStart(e: TouchEvent): void {
    if (e.touches.length > 0 && e.touches[0]) {
      lastTouchY = e.touches[0].clientY;
    }
  }

  function onTouchMove(e: TouchEvent): void {
    if (e.touches.length > 0 && e.touches[0] && getState() === "following") {
      const currentY = e.touches[0].clientY;
      if (currentY > lastTouchY + 5) {
        // Finger moved down on screen = scrolling UP through content
        userDetached = true;
      }
      lastTouchY = currentY;
    }
  }

  // ── User input detection (not scroll position) ────────────────────────

  function onWheel(e: WheelEvent): void {
    if (e.deltaY < 0 && getState() === "following") {
      // User scrolled up while following — detach
      userDetached = true;
    }
  }

  function onScroll(): void {
    if (!container) return;
    const distFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    // Re-follow when user scrolls back to bottom (matching original SCROLL_THRESHOLD of 100px)
    if (distFromBottom < SCROLL_THRESHOLD && userDetached) {
      userDetached = false;
    }
  }

  // ── Public API ────────────────────────────────────────────────────────

  return {
    get state(): ScrollState {
      return getState();
    },

    get isDetached(): boolean {
      return getState() === "detached";
    },

    get isLoading(): boolean {
      return getState() === "loading";
    },

    attach(el: HTMLElement): void {
      container = el;
      el.addEventListener("wheel", onWheel, { passive: true });
      el.addEventListener("touchstart", onTouchStart, { passive: true });
      el.addEventListener("touchmove", onTouchMove, { passive: true });
      el.addEventListener("scroll", onScroll, { passive: true });
    },

    detach(): void {
      stopSettle();
      if (container) {
        container.removeEventListener("wheel", onWheel);
        container.removeEventListener("touchstart", onTouchStart);
        container.removeEventListener("touchmove", onTouchMove);
        container.removeEventListener("scroll", onScroll);
        container = null;
      }
    },

    /** Reset scroll state for session switch. Clears detached flag. */
    resetForSession(): void {
      userDetached = false;
      stopSettle();
    },

    requestFollow(): void {
      userDetached = false;
      scrollToBottom();
    },

    onNewContent(): void {
      const s = getState();
      if (s === "following") {
        requestAnimationFrame(() => scrollToBottom());
      } else if (s === "settling") {
        // Don't restart settle — let the running loop continue.
        // If no loop is running yet, start one.
        startSettle();
      }
      // loading, detached: no-op
    },

    onPrepend(prevScrollHeight: number, prevScrollTop: number): void {
      if (!container) return;
      requestAnimationFrame(() => {
        if (!container) return;
        const newScrollHeight = container.scrollHeight;
        container.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
      });
    },
  };
}
```

**Step 4: Run tests**

Run: `pnpm vitest run test/unit/stores/scroll-controller.test.ts`
Expected: PASS

Run: `pnpm check`
Expected: PASS

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: create scroll-controller with state machine (Loading/Settling/Following/Detached)"
```

---

### Task 6: Write regression tests for scroll behavior BEFORE wiring

**Files:**
- Create: `test/unit/stores/scroll-regression.test.ts`

These tests verify the behaviors that MUST survive the refactor. Write them against
the OLD code first, confirm they pass, then proceed with the wiring (Task 7).

**Step 1: Write regression tests**

Create `test/unit/stores/scroll-regression.test.ts`:

```typescript
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// ... standard localStorage/dompurify mocks ...

import { createScrollController } from "../../../src/lib/frontend/stores/scroll-controller.svelte.js";
import type { LoadLifecycle } from "../../../src/lib/frontend/stores/chat.svelte.js";

describe("Scroll behavior regression suite", () => {
  let lifecycle: LoadLifecycle;
  function makeCtrl() {
    lifecycle = "ready";
    return createScrollController(() => lifecycle);
  }

  describe("Scroll-to-bottom button visibility", () => {
    it("isDetached is false when no user scroll-up has occurred", () => {
      const ctrl = makeCtrl();
      const div = document.createElement("div");
      ctrl.attach(div);
      expect(ctrl.isDetached).toBe(false);
      ctrl.detach();
    });

    it("isDetached becomes true after wheel-up event", () => {
      const ctrl = makeCtrl();
      const div = document.createElement("div");
      ctrl.attach(div);
      div.dispatchEvent(new WheelEvent("wheel", { deltaY: -50 }));
      expect(ctrl.isDetached).toBe(true);
      ctrl.detach();
    });

    it("isDetached becomes false after requestFollow()", () => {
      const ctrl = makeCtrl();
      const div = document.createElement("div");
      ctrl.attach(div);
      div.dispatchEvent(new WheelEvent("wheel", { deltaY: -50 }));
      expect(ctrl.isDetached).toBe(true);
      ctrl.requestFollow();
      expect(ctrl.isDetached).toBe(false);
      ctrl.detach();
    });
  });

  describe("Session switch clears detached state", () => {
    it("resetForSession clears userDetached", () => {
      const ctrl = makeCtrl();
      const div = document.createElement("div");
      ctrl.attach(div);
      div.dispatchEvent(new WheelEvent("wheel", { deltaY: -50 }));
      expect(ctrl.isDetached).toBe(true);
      ctrl.resetForSession();
      expect(ctrl.isDetached).toBe(false);
      ctrl.detach();
    });

    it("resetForSession stops any active settle loop", () => {
      const ctrl = makeCtrl();
      lifecycle = "committed"; // settling state
      const div = document.createElement("div");
      ctrl.attach(div);
      ctrl.onNewContent(); // starts settle
      ctrl.resetForSession(); // should stop it
      // No assertion for rAF cancellation — just verify no error
      ctrl.detach();
    });
  });

  describe("Loading state suppresses scroll", () => {
    it("onNewContent is no-op during loading", () => {
      const ctrl = makeCtrl();
      lifecycle = "loading";
      const div = document.createElement("div");
      Object.defineProperty(div, "scrollHeight", { value: 1000, writable: true });
      Object.defineProperty(div, "scrollTop", { value: 0, writable: true });
      ctrl.attach(div);
      ctrl.onNewContent();
      expect(div.scrollTop).toBe(0); // should NOT have scrolled
      ctrl.detach();
    });
  });

  describe("Detached state prevents auto-scroll", () => {
    it("onNewContent does not scroll when detached", () => {
      const ctrl = makeCtrl();
      const div = document.createElement("div");
      Object.defineProperty(div, "scrollHeight", { value: 1000, writable: true });
      Object.defineProperty(div, "scrollTop", { value: 0, writable: true });
      ctrl.attach(div);
      div.dispatchEvent(new WheelEvent("wheel", { deltaY: -50 }));
      expect(ctrl.isDetached).toBe(true);
      ctrl.onNewContent();
      // rAF would scroll — but since detached, nothing should be queued
      expect(div.scrollTop).toBe(0);
      ctrl.detach();
    });
  });
});
```

**Step 2: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/stores/scroll-regression.test.ts`
Expected: PASS (these test the scroll controller from Task 5)

**Step 3: Commit**

```bash
git add -A && git commit -m "test: add scroll behavior regression test suite"
```

---

### Task 7: Wire scroll controller into MessageList.svelte

**Files:**
- Modify: `src/lib/frontend/components/chat/MessageList.svelte`
- Modify: `src/lib/frontend/stores/ui.svelte.ts` (remove isUserScrolledUp)

**Step 1: Replace MessageList scroll logic**

In `MessageList.svelte`:

1. Import the controller factory and chat store:
```typescript
import { createScrollController } from "../../stores/scroll-controller.svelte.js";
import { chatState, isProcessing } from "../../stores/chat.svelte.js";
```

2. Create the controller instance:
```typescript
const scrollCtrl = createScrollController(
  () => chatState.loadLifecycle,
);
```

3. Replace `messagesEl` bind with controller attach/detach:
```typescript
$effect(() => {
  if (messagesEl) {
    scrollCtrl.attach(messagesEl);
    return () => scrollCtrl.detach();
  }
});
```

4. **Delete** the three old scroll `$effect`s:
   - Session-change settle loop (lines 71-105)
   - Auto-scroll on message changes (lines 184-201)
   - `scrollToBottom()` and `forceScrollToBottom()` functions (lines 48-57)

5. **Add session-switch reset** (replaces the old settle loop):
```typescript
$effect(() => {
  const _sid = sessionState.currentId; // track session changes
  scrollCtrl.resetForSession();
});
```

6. **Replace** with one auto-scroll effect:
```typescript
$effect(() => {
  const _len = chatState.messages.length;
  const _permLen = permissionsState.pendingPermissions.length;
  const _qLen = permissionsState.pendingQuestions.length;
  scrollCtrl.onNewContent();
});
```

6. **Keep** the prepend scroll-preservation, but delegate to controller:
```typescript
$effect.pre(() => {
  // ... existing prepend detection logic stays ...
  if (detected prepend) {
    awaitingPrepend = true;
    prevScrollHeight = messagesEl.scrollHeight;
    prevScrollTop = messagesEl.scrollTop;
  }
});

$effect(() => {
  if (awaitingPrepend && messagesEl) {
    scrollCtrl.onPrepend(prevScrollHeight, prevScrollTop);
    awaitingPrepend = false;
  }
});
```

7. **Delete** the `handleScroll` function (scroll detection now in controller).

8. **Replace** scroll-to-bottom button:
```svelte
<button
  id="scroll-btn"
  class="sticky bottom-3 ..."
  class:hidden={!scrollCtrl.isDetached}
  title="Scroll to bottom"
  onclick={() => scrollCtrl.requestFollow()}
>
  {scrollButtonText}
</button>
```

9. Remove `onscroll={handleScroll}` from the `#messages` div.

**Step 2: Remove isUserScrolledUp from ui.svelte.ts**

In `ui.svelte.ts`:
- Remove `isUserScrolledUp: false` from `uiState` (line 45)
- Remove `setUserScrolledUp` function (lines 331-333)
- Remove `uiState.isUserScrolledUp = false` from `resetProjectUI` (line 347)
- Remove `SCROLL_THRESHOLD` export if no longer needed elsewhere

**Step 3: Verify**

Run: `pnpm check`
Expected: May surface type errors in tests or other files that reference `isUserScrolledUp`. Fix each one.

Run: `pnpm test:unit`
Expected: All green.

**Step 4: Commit**

```bash
git add -A && git commit -m "refactor: wire scroll controller into MessageList, remove isUserScrolledUp from uiState"
```

---

### Task 7: Single-commit replay with 50-message paging

**Files:**
- Modify: `src/lib/frontend/stores/ws-dispatch.ts:614-672`
- Modify: `src/lib/frontend/stores/chat.svelte.ts` (replay buffer, paging)
- Create: `test/unit/stores/replay-paging.test.ts`

**Step 1: Write failing tests**

Create `test/unit/stores/replay-paging.test.ts`:

```typescript
describe("Replay paging", () => {
  it("commits only last 50 messages after replay of 200 events", async () => {
    // Setup: create 200 delta+done event pairs
    // Call replayEvents(events)
    // Assert: chatState.messages.length <= 50
    // Assert: replayBuffer has the remaining messages
  });

  it("loads more messages from replay buffer on loadMoreFromBuffer", () => {
    // Setup: replay buffer has 150 messages
    // Call loadMoreFromBuffer(sessionId)
    // Assert: chatState.messages grows by PAGE_SIZE
  });

  it("commits all messages when total <= 50", async () => {
    // Setup: 30 events
    // Call replayEvents(events)
    // Assert: chatState.messages.length === expected count
    // Assert: no replay buffer created
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/stores/replay-paging.test.ts`

**Step 3: Implement single-commit replay**

In `chat.svelte.ts`:

1. Add replay buffer storage:
```typescript
const INITIAL_PAGE_SIZE = 50;
const replayBuffers = new Map<string, ChatMessage[]>();

export function getReplayBuffer(sessionId: string): ChatMessage[] | undefined {
  return replayBuffers.get(sessionId);
}

export function consumeReplayBuffer(sessionId: string, count: number): ChatMessage[] {
  const buffer = replayBuffers.get(sessionId);
  if (!buffer || buffer.length === 0) return [];
  const page = buffer.splice(buffer.length - count, count);
  if (buffer.length === 0) replayBuffers.delete(sessionId);
  return page;
}
```

2. Modify `commitReplayBatch` to support final single commit:
```typescript
export function commitReplayFinal(sessionId: string): void {
  if (replayBatch === null) return;
  const all = replayBatch;
  replayBatch = null;

  if (all.length <= INITIAL_PAGE_SIZE) {
    chatState.messages = all;
  } else {
    // Store older messages in buffer, commit only the latest page
    const cutoff = all.length - INITIAL_PAGE_SIZE;
    replayBuffers.set(sessionId, all.slice(0, cutoff));
    chatState.messages = all.slice(cutoff);
    historyState.hasMore = true;
  }
  chatState.loadLifecycle = "committed";
}
```

In `ws-dispatch.ts`:

1. Modify `replayEvents` to NOT commit between chunks — only commit once at end:
```typescript
export async function replayEvents(events: RelayMessage[], sessionId: string): Promise<void> {
  phaseStartReplay();
  const generation = ++replayGeneration;
  beginReplayBatch();

  let llmActive = false;

  for (let i = 0; i < events.length; i++) {
    if (generation !== replayGeneration) {
      discardReplayBatch();
      return;
    }

    const event = events[i]!;
    if (isLlmContentStart(event.type)) llmActive = true;
    else if (event.type === "done") llmActive = false;
    else if (event.type === "error" && event.code !== "RETRY") llmActive = false;

    const ctx: DispatchContext = { isReplay: true, isQueued: llmActive };
    dispatchChatEvent(event, ctx);

    if (isLlmContentStart(event.type) && shouldClearQueuedOnContent())
      clearQueuedFlags();

    // Yield between chunks for main thread responsiveness
    // BUT don't commit — stay in the replay batch
    if ((i + 1) % REPLAY_CHUNK_SIZE === 0) {
      await yieldToEventLoop();
      if (generation !== replayGeneration) return;
    }
  }

  flushPendingRender();
  commitReplayFinal(sessionId); // single commit with paging
  phaseEndReplay(llmActive);
  renderDeferredMarkdown();
}
```

2. Update the HistoryLoader to check replay buffer before requesting from server.

**Step 4: Verify**

Run: `pnpm vitest run test/unit/stores/replay-paging.test.ts`
Expected: PASS

Run: `pnpm check && pnpm test:unit`
Expected: All green.

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: single-commit replay with 50-message paging and local replay buffer"
```

---

### Task 9: Wire HistoryLoader to use replay buffer

**Files:**
- Modify: `src/lib/frontend/components/chat/HistoryLoader.svelte`
- Modify: `src/lib/frontend/stores/ws-dispatch.ts` (load_more_history handler)
- Modify: `test/unit/stores/replay-paging.test.ts`

**Step 1: Write the failing test**

Add to `test/unit/stores/replay-paging.test.ts`:

```typescript
describe("HistoryLoader buffer integration", () => {
  it("consumeReplayBuffer returns messages from end of buffer (most recent first)", () => {
    // Setup: populate buffer with 100 messages
    // Consume 20 from it
    // Assert: returned messages are the 20 most-recent-first from the buffer
    // Assert: buffer now has 80 remaining
  });

  it("consumeReplayBuffer empties and deletes buffer when fully consumed", () => {
    // Setup: buffer with 10 messages
    // Consume 10
    // Assert: getReplayBuffer returns undefined
  });

  it("historyState.hasMore reflects buffer + server state", () => {
    // Setup: buffer has messages, server also has more
    // Consume all buffer messages
    // Assert: historyState.hasMore still true (server has more)
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/stores/replay-paging.test.ts`

**Step 3: Implement buffer-first loading**

When HistoryLoader triggers, check if there's a replay buffer for the current session first. If so, consume a page from it (instant, no server round-trip). Only fall back to server when the buffer is empty.

In the `load_more_history` response handler (or a new local handler):
```typescript
// Check replay buffer first
const buffer = getReplayBuffer(sessionId);
if (buffer && buffer.length > 0) {
  const page = consumeReplayBuffer(sessionId, HISTORY_PAGE_SIZE);
  prependMessages(page);
  historyState.hasMore = (getReplayBuffer(sessionId)?.length ?? 0) > 0 || serverHasMore;
  return;
}
// Fall back to server request
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/stores/replay-paging.test.ts`
Expected: PASS

**Step 5: Refactor** — review the buffer consumption code. Is the slice direction correct?
`consumeReplayBuffer` splices from the end (most recent). Verify this matches what
HistoryLoader expects (it prepends, so it wants the messages just before the current
first message — which is the END of the buffer). Confirm ordering.

Run: `pnpm check && pnpm test:unit`
Expected: All green.

**Step 6: Commit**

```bash
git add -A && git commit -m "feat: HistoryLoader consumes local replay buffer before server requests"
```

---

### Task 10: Add LoadLifecycle 'ready' transition after deferred markdown

**Files:**
- Modify: `src/lib/frontend/stores/chat.svelte.ts` (renderDeferredMarkdown)
- Modify: `test/unit/stores/chat-phase.test.ts`

**Step 1: Write the failing test**

Add to `test/unit/stores/chat-phase.test.ts`:

```typescript
describe("LoadLifecycle 'ready' transition", () => {
  it("renderDeferredMarkdown sets loadLifecycle to 'ready' after all messages rendered", () => {
    // Setup: create messages with needsRender: true
    chatState.loadLifecycle = "committed";
    chatState.messages = [
      { type: "assistant", uuid: "1", rawText: "hello", html: "hello", needsRender: true, finalized: true },
    ];
    
    // Act: call renderDeferredMarkdown (may need to flush timers)
    renderDeferredMarkdown();
    // Flush requestIdleCallback/setTimeout
    vi.runAllTimers();
    
    // Assert
    expect(chatState.loadLifecycle).toBe("ready");
  });

  it("loadLifecycle stays 'committed' while deferred markdown is still processing", () => {
    chatState.loadLifecycle = "committed";
    // Create 10+ messages with needsRender (batch size is 5, so needs 2+ batches)
    chatState.messages = Array.from({ length: 10 }, (_, i) => ({
      type: "assistant" as const,
      uuid: String(i),
      rawText: `msg ${i}`,
      html: `msg ${i}`,
      needsRender: true as const,
      finalized: true,
    }));
    
    renderDeferredMarkdown();
    vi.runOnlyPendingTimers(); // first batch only
    
    // Still has more to render
    expect(chatState.loadLifecycle).toBe("committed");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/stores/chat-phase.test.ts`
Expected: FAIL — renderDeferredMarkdown doesn't set loadLifecycle yet

**Step 3: Implement**

In `renderDeferredMarkdown()`, after the last batch processes and `hasMore` is false:

```typescript
if (!hasMore) {
  chatState.loadLifecycle = "ready";
}
```

This transitions the scroll controller from Settling to Following.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/stores/chat-phase.test.ts`
Expected: PASS

**Step 5: Refactor** — verify that `chatState.loadLifecycle = "ready"` only fires once,
not on every subsequent `renderDeferredMarkdown` call. Consider guarding:
```typescript
if (!hasMore && chatState.loadLifecycle === "committed") {
  chatState.loadLifecycle = "ready";
}
```

Run: `pnpm check && pnpm test:unit`
Expected: All green.

**Step 6: Commit**

```bash
git add -A && git commit -m "feat: transition loadLifecycle to 'ready' after deferred markdown completes"
```

---

### Task 11: Integration test — full lifecycle flow

**Files:**
- Create: `test/unit/stores/scroll-lifecycle-integration.test.ts`

**Step 1: Write the integration test**

This test wires the REAL `chatState.loadLifecycle` to the scroll controller and verifies
the full flow without mocking the lifecycle getter:

```typescript
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// ... standard mocks ...

import { createScrollController } from "../../../src/lib/frontend/stores/scroll-controller.svelte.js";
import { chatState, clearMessages, phaseStartReplay, phaseEndReplay } from "../../../src/lib/frontend/stores/chat.svelte.js";

describe("Scroll lifecycle integration", () => {
  beforeEach(() => {
    clearMessages();
  });

  it("full flow: empty -> loading -> committed -> ready -> detach -> follow", () => {
    const ctrl = createScrollController(() => chatState.loadLifecycle);
    const div = document.createElement("div");
    ctrl.attach(div);

    // 1. Start: empty
    expect(ctrl.state).toBe("loading"); // empty = loading

    // 2. Start replay
    phaseStartReplay();
    expect(chatState.loadLifecycle).toBe("loading");
    expect(ctrl.state).toBe("loading");

    // 3. Commit messages (simulate commitReplayFinal)
    chatState.loadLifecycle = "committed";
    expect(ctrl.state).toBe("settling");

    // 4. Deferred markdown completes
    chatState.loadLifecycle = "ready";
    expect(ctrl.state).toBe("following");

    // 5. User scrolls up
    div.dispatchEvent(new WheelEvent("wheel", { deltaY: -50 }));
    expect(ctrl.state).toBe("detached");
    expect(ctrl.isDetached).toBe(true);

    // 6. User clicks scroll-to-bottom
    ctrl.requestFollow();
    expect(ctrl.state).toBe("following");
    expect(ctrl.isDetached).toBe(false);

    ctrl.detach();
  });

  it("session switch resets state correctly", () => {
    const ctrl = createScrollController(() => chatState.loadLifecycle);
    const div = document.createElement("div");
    ctrl.attach(div);

    // Get to following + detached
    chatState.loadLifecycle = "ready";
    div.dispatchEvent(new WheelEvent("wheel", { deltaY: -50 }));
    expect(ctrl.isDetached).toBe(true);

    // Session switch
    ctrl.resetForSession();
    chatState.loadLifecycle = "loading";
    expect(ctrl.state).toBe("loading");
    expect(ctrl.isDetached).toBe(false);

    ctrl.detach();
  });
});
```

**Step 2: Run test**

Run: `pnpm vitest run test/unit/stores/scroll-lifecycle-integration.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add -A && git commit -m "test: add scroll lifecycle integration test"
```

---

### Task 12: Clean up — remove dead code and verify full suite

**Files:**
- Modify: `src/lib/frontend/stores/chat.svelte.ts` (remove old batch commit functions if unused)
- Modify: `src/lib/frontend/stores/ui.svelte.ts` (confirm isUserScrolledUp fully removed)

**Step 1: Remove dead exports**

If `beginReplayBatch`, `commitReplayBatch`, `discardReplayBatch` are no longer called from ws-dispatch (replaced by `commitReplayFinal`), remove them. Check for any other callers first.

Also remove `SCROLL_THRESHOLD` from `ui.svelte.ts` if no longer referenced.

**Step 2: Full verification**

```bash
pnpm check && pnpm lint && pnpm test:unit
```

Expected: All green with no lint warnings about unused exports.

**Step 3: Commit**

```bash
git add -A && git commit -m "chore: remove dead scroll and replay batch code"
```

---

### Task 13: Update E2E scroll tests

**Files:**
- Modify: `test/e2e/specs/scroll-stability.spec.ts`

**Step 1: Review existing E2E scroll tests**

Read the scroll-stability spec. Update any assertions that rely on `isUserScrolledUp` or the old scroll behavior. The E2E tests likely check that:
- Scroll-to-bottom button appears/disappears correctly
- Auto-scroll works during streaming
- User can scroll up without snap-back

These should still pass with the new controller, but the mechanism is different.

**Step 2: Run E2E tests (if environment supports it)**

```bash
pnpm test:e2e -- --grep scroll
```

**Step 3: Fix any failing assertions**

**Step 4: Commit**

```bash
git add -A && git commit -m "test: update E2E scroll tests for scroll controller"
```
