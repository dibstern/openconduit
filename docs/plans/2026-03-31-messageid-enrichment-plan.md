# MessageId Enrichment Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Eliminate missing `messageId` on SSE-path relay messages by tracking the current message ID per session in the event translator and enriching output messages.

**Architecture:** The translator already maintains per-session state (`seenParts`). We add parallel per-session `currentMessageId` tracking, populated from any event carrying `properties.messageID`. A post-processing step enriches output messages that lack `messageId` with the tracked fallback. This normalizes the SSE path to match the poller path (which always includes `messageId`).

**Tech Stack:** TypeScript, Vitest, fast-check (for PBT extension)

---

### Task 1: Test file + `getCurrentMessageId` interface

**Files:**
- Create: `test/unit/relay/event-translator-messageid.test.ts`
- Modify: `src/lib/relay/event-translator.ts:559-577` (Translator interface)

**Step 1: Write the failing test**

Create the test file with the first red test — `getCurrentMessageId` doesn't exist yet.

```typescript
// test/unit/relay/event-translator-messageid.test.ts
import { describe, expect, it } from "vitest";
import { createTranslator } from "../../../src/lib/relay/event-translator.js";

describe("messageId enrichment", () => {
	describe("getCurrentMessageId", () => {
		it("returns undefined for a session with no tracked messageId", () => {
			const translator = createTranslator();
			expect(translator.getCurrentMessageId("s1")).toBeUndefined();
		});

		it("returns undefined when called with no sessionId", () => {
			const translator = createTranslator();
			expect(translator.getCurrentMessageId()).toBeUndefined();
		});
	});
});
```

**Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/unit/relay/event-translator-messageid.test.ts`
Expected: FAIL — `getCurrentMessageId` is not a function / does not exist on type `Translator`

**Step 3: Write minimal implementation**

Add `getCurrentMessageId` to the `Translator` interface and implement it in `createTranslator()`.

In `src/lib/relay/event-translator.ts`, add to the `Translator` interface (around line 559):

```typescript
export interface Translator {
	translate(event: OpenCodeEvent, context?: TranslateContext): TranslateResult;
	reset(sessionId?: string): void;
	getSeenParts(
		sessionId?: string,
	): ReadonlyMap<string, { type: PartType; status?: ToolStatus }> | undefined;
	/** Get the current tracked messageId for a session. */
	getCurrentMessageId(sessionId?: string): string | undefined;
	rebuildStateFromHistory(
		sessionId: string,
		messages: Array<{
			parts?: Array<{
				id: string;
				type: PartType;
				state?: { status?: ToolStatus };
			}>;
		}>,
	): void;
}
```

In `createTranslator()` (around line 580), add state and method:

```typescript
export function createTranslator(): Translator {
	const DEFAULT_SESSION = "__default__";
	const sessionParts = new Map<
		string,
		Map<string, { type: PartType; status?: ToolStatus }>
	>();
	const sessionMessageIds = new Map<string, string>();

	// ... existing getOrCreateSessionParts ...

	return {
		// ... existing methods ...

		getCurrentMessageId(sessionId?: string) {
			return sessionMessageIds.get(sessionId ?? DEFAULT_SESSION);
		},

		// ... rest unchanged ...
	};
}
```

**Step 3a: Update mock translator (audit fix)**

In `test/helpers/mock-factories.ts`, add `getCurrentMessageId` to `createMockTranslator()` (line 203-210):

```typescript
function createMockTranslator(): SSEWiringDeps["translator"] {
	return {
		translate: vi.fn().mockReturnValue({ ok: false, reason: "mock" }),
		reset: vi.fn(),
		getSeenParts: vi.fn().mockReturnValue(new Map()),
		getCurrentMessageId: vi.fn().mockReturnValue(undefined),
		rebuildStateFromHistory: vi.fn(),
	} as SSEWiringDeps["translator"];
}
```

This prevents compilation failures in `sse-wiring.test.ts`, `regression-user-message-echo.test.ts`, and `regression-question-session-scoping.test.ts`.

**Step 4: Run the test to verify it passes**

Run: `pnpm vitest run test/unit/relay/event-translator-messageid.test.ts`
Expected: PASS

**Step 4a: Run tests that use mock translator to verify no regressions**

Run: `pnpm vitest run test/unit/relay/sse-wiring.test.ts test/unit/relay/regression-user-message-echo.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat: add getCurrentMessageId to Translator interface
```

---

### Task 2: Track messageId from SSE events

**Files:**
- Modify: `src/lib/relay/event-translator.ts:599-770` (translate method)
- Modify: `test/unit/relay/event-translator-messageid.test.ts`

**Step 1: Write the failing tests**

Add to the test file:

```typescript
describe("messageId tracking from events", () => {
	it("tracks messageId from message.created events", () => {
		const translator = createTranslator();
		translator.translate(
			{
				type: "message.created",
				properties: {
					sessionID: "s1",
					messageID: "msg-1",
					info: { role: "assistant" },
				},
			},
			{ sessionId: "s1" },
		);
		expect(translator.getCurrentMessageId("s1")).toBe("msg-1");
	});

	it("tracks messageId from message.part.delta events", () => {
		const translator = createTranslator();
		translator.translate(
			{
				type: "message.part.delta",
				properties: {
					partID: "p1",
					messageID: "msg-2",
					field: "text",
					delta: "hello",
				},
			},
			{ sessionId: "s1" },
		);
		expect(translator.getCurrentMessageId("s1")).toBe("msg-2");
	});

	it("tracks messageId from message.part.updated events", () => {
		const translator = createTranslator();
		translator.translate(
			{
				type: "message.part.updated",
				properties: {
					partID: "p1",
					messageID: "msg-3",
					part: { type: "tool", tool: "bash", state: { status: "pending" } },
				},
			},
			{ sessionId: "s1" },
		);
		expect(translator.getCurrentMessageId("s1")).toBe("msg-3");
	});

	it("does NOT track messageId from message.removed events", () => {
		const translator = createTranslator();
		// First set a known messageId
		translator.translate(
			{
				type: "message.part.delta",
				properties: {
					partID: "p1",
					messageID: "msg-good",
					field: "text",
					delta: "hi",
				},
			},
			{ sessionId: "s1" },
		);
		// message.removed should NOT overwrite the tracker
		translator.translate(
			{
				type: "message.removed",
				properties: { messageID: "msg-removed" },
			},
			{ sessionId: "s1" },
		);
		expect(translator.getCurrentMessageId("s1")).toBe("msg-good");
	});

	it("does NOT track messageId from message.part.removed events", () => {
		const translator = createTranslator();
		translator.translate(
			{
				type: "message.part.delta",
				properties: {
					partID: "p1",
					messageID: "msg-good",
					field: "text",
					delta: "hi",
				},
			},
			{ sessionId: "s1" },
		);
		translator.translate(
			{
				type: "message.part.removed",
				properties: { partID: "p1", messageID: "msg-removed-part" },
			},
			{ sessionId: "s1" },
		);
		expect(translator.getCurrentMessageId("s1")).toBe("msg-good");
	});

	it("updates messageId when a newer event carries a different one", () => {
		const translator = createTranslator();
		translator.translate(
			{
				type: "message.part.delta",
				properties: {
					partID: "p1",
					messageID: "msg-1",
					field: "text",
					delta: "hi",
				},
			},
			{ sessionId: "s1" },
		);
		translator.translate(
			{
				type: "message.created",
				properties: {
					sessionID: "s1",
					messageID: "msg-2",
					info: { role: "assistant" },
				},
			},
			{ sessionId: "s1" },
		);
		expect(translator.getCurrentMessageId("s1")).toBe("msg-2");
	});

	it("does not track empty-string messageID", () => {
		const translator = createTranslator();
		translator.translate(
			{
				type: "message.part.delta",
				properties: {
					partID: "p1",
					messageID: "",
					field: "text",
					delta: "hi",
				},
			},
			{ sessionId: "s1" },
		);
		expect(translator.getCurrentMessageId("s1")).toBeUndefined();
	});

	it("does not track when messageID is absent from event", () => {
		const translator = createTranslator();
		translator.translate(
			{
				type: "message.part.delta",
				properties: { partID: "p1", field: "text", delta: "hi" },
			},
			{ sessionId: "s1" },
		);
		expect(translator.getCurrentMessageId("s1")).toBeUndefined();
	});

	it("does not track messageId from message.updated (nested at info.id, not top-level)", () => {
		const translator = createTranslator();
		translator.translate(
			{
				type: "message.updated",
				properties: {
					sessionID: "s1",
					info: { id: "msg-nested", role: "assistant" },
				},
			},
			{ sessionId: "s1" },
		);
		// message.updated stores messageId at info.id, not properties.messageID
		// The tracker only extracts top-level properties.messageID
		expect(translator.getCurrentMessageId("s1")).toBeUndefined();
	});

	it("does not track messageId from non-message events (session.status)", () => {
		const translator = createTranslator();
		translator.translate(
			{
				type: "session.status",
				properties: { sessionID: "s1", status: { type: "idle" } },
			},
			{ sessionId: "s1" },
		);
		expect(translator.getCurrentMessageId("s1")).toBeUndefined();
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/relay/event-translator-messageid.test.ts`
Expected: FAIL — `getCurrentMessageId` returns undefined after translating events

**Step 3: Write minimal implementation**

Add messageId extraction at the top of the `translate()` method (around line 600):

```typescript
translate(
	event: OpenCodeEvent,
	context?: TranslateContext,
): TranslateResult {
	const sessionKey = context?.sessionId ?? DEFAULT_SESSION;

	// ── Track messageId from any non-removal event ──────────────────
	if (
		event.type !== "message.removed" &&
		event.type !== "message.part.removed"
	) {
		const props = event.properties as Record<string, unknown>;
		const mid = props["messageID"];
		if (typeof mid === "string" && mid) {
			sessionMessageIds.set(sessionKey, mid);
		}
	}

	const eventType = event.type;
	const seenParts = getOrCreateSessionParts(context?.sessionId);

	// ... rest of dispatch unchanged ...
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/relay/event-translator-messageid.test.ts`
Expected: PASS

**Step 5: Run existing translator tests to verify no regressions**

Run: `pnpm vitest run test/unit/relay/event-translator`
Expected: All existing tests pass

**Step 6: Commit**

```
feat: track messageId per session from SSE events in translator
```

---

### Task 3: Enrich output messages with fallback messageId

**Files:**
- Modify: `src/lib/relay/event-translator.ts:599-770` (translate method)
- Modify: `test/unit/relay/event-translator-messageid.test.ts`

This is the core change. Output messages that lack `messageId` get the tracked fallback injected.

**Step 1: Write the failing tests**

Add to the test file:

```typescript
describe("messageId enrichment of output messages", () => {
	it("enriches tool_start with tracked messageId when event lacks it", () => {
		const translator = createTranslator();
		// Set up tracked messageId
		translator.translate(
			{
				type: "message.created",
				properties: { messageID: "msg-1", info: { role: "assistant" } },
			},
			{ sessionId: "s1" },
		);
		// Tool part event WITHOUT messageID
		const result = translator.translate(
			{
				type: "message.part.updated",
				properties: {
					partID: "tool-1",
					part: {
						type: "tool",
						callID: "call-1",
						tool: "bash",
						state: { status: "pending" },
					},
				},
			},
			{ sessionId: "s1" },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			const msg = result.messages[0]!;
			expect(msg.type).toBe("tool_start");
			expect((msg as { messageId?: string }).messageId).toBe("msg-1");
		}
	});

	it("enriches tool_executing with tracked messageId", () => {
		const translator = createTranslator();
		translator.translate(
			{
				type: "message.created",
				properties: { messageID: "msg-1", info: { role: "assistant" } },
			},
			{ sessionId: "s1" },
		);
		// First make the part known (pending)
		translator.translate(
			{
				type: "message.part.updated",
				properties: {
					partID: "tool-1",
					part: {
						type: "tool",
						callID: "call-1",
						tool: "bash",
						state: { status: "pending" },
					},
				},
			},
			{ sessionId: "s1" },
		);
		// Now running — no messageID
		const result = translator.translate(
			{
				type: "message.part.updated",
				properties: {
					partID: "tool-1",
					part: {
						type: "tool",
						callID: "call-1",
						tool: "bash",
						state: { status: "running", input: { cmd: "ls" } },
					},
				},
			},
			{ sessionId: "s1" },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages[0]!.type).toBe("tool_executing");
			expect((result.messages[0] as { messageId?: string }).messageId).toBe(
				"msg-1",
			);
		}
	});

	it("enriches tool_result with tracked messageId", () => {
		const translator = createTranslator();
		translator.translate(
			{
				type: "message.created",
				properties: { messageID: "msg-1", info: { role: "assistant" } },
			},
			{ sessionId: "s1" },
		);
		translator.translate(
			{
				type: "message.part.updated",
				properties: {
					partID: "tool-1",
					part: {
						type: "tool",
						callID: "call-1",
						tool: "bash",
						state: { status: "pending" },
					},
				},
			},
			{ sessionId: "s1" },
		);
		const result = translator.translate(
			{
				type: "message.part.updated",
				properties: {
					partID: "tool-1",
					part: {
						type: "tool",
						callID: "call-1",
						tool: "bash",
						state: { status: "completed", output: "done" },
					},
				},
			},
			{ sessionId: "s1" },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages[0]!.type).toBe("tool_result");
			expect((result.messages[0] as { messageId?: string }).messageId).toBe(
				"msg-1",
			);
		}
	});

	it("enriches thinking_start with tracked messageId", () => {
		const translator = createTranslator();
		translator.translate(
			{
				type: "message.created",
				properties: { messageID: "msg-1", info: { role: "assistant" } },
			},
			{ sessionId: "s1" },
		);
		const result = translator.translate(
			{
				type: "message.part.updated",
				properties: {
					partID: "reason-1",
					part: { type: "reasoning" },
				},
			},
			{ sessionId: "s1" },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages[0]!.type).toBe("thinking_start");
			expect((result.messages[0] as { messageId?: string }).messageId).toBe(
				"msg-1",
			);
		}
	});

	it("enriches thinking_stop with tracked messageId", () => {
		const translator = createTranslator();
		translator.translate(
			{
				type: "message.created",
				properties: { messageID: "msg-1", info: { role: "assistant" } },
			},
			{ sessionId: "s1" },
		);
		// First see the reasoning part
		translator.translate(
			{
				type: "message.part.updated",
				properties: {
					partID: "reason-1",
					part: { type: "reasoning" },
				},
			},
			{ sessionId: "s1" },
		);
		// Then finalize it
		const result = translator.translate(
			{
				type: "message.part.updated",
				properties: {
					partID: "reason-1",
					part: { type: "reasoning", time: { end: Date.now() } },
				},
			},
			{ sessionId: "s1" },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages[0]!.type).toBe("thinking_stop");
			expect((result.messages[0] as { messageId?: string }).messageId).toBe(
				"msg-1",
			);
		}
	});

	it("enriches delta with tracked messageId", () => {
		const translator = createTranslator();
		translator.translate(
			{
				type: "message.created",
				properties: { messageID: "msg-1", info: { role: "assistant" } },
			},
			{ sessionId: "s1" },
		);
		// Delta without messageID
		const result = translator.translate(
			{
				type: "message.part.delta",
				properties: { partID: "p1", field: "text", delta: "hello" },
			},
			{ sessionId: "s1" },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages[0]!.type).toBe("delta");
			expect((result.messages[0] as { messageId?: string }).messageId).toBe(
				"msg-1",
			);
		}
	});

	it("enriches thinking_delta with tracked messageId", () => {
		const translator = createTranslator();
		translator.translate(
			{
				type: "message.created",
				properties: { messageID: "msg-1", info: { role: "assistant" } },
			},
			{ sessionId: "s1" },
		);
		// Register reasoning part first
		translator.translate(
			{
				type: "message.part.updated",
				properties: {
					partID: "reason-1",
					part: { type: "reasoning" },
				},
			},
			{ sessionId: "s1" },
		);
		// Delta on reasoning part without messageID
		const result = translator.translate(
			{
				type: "message.part.delta",
				properties: {
					partID: "reason-1",
					field: "text",
					delta: "thinking...",
				},
			},
			{ sessionId: "s1" },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages[0]!.type).toBe("thinking_delta");
			expect((result.messages[0] as { messageId?: string }).messageId).toBe(
				"msg-1",
			);
		}
	});

	it("enriches both messages when tool first seen as running (tool_start + tool_executing)", () => {
		const translator = createTranslator();
		translator.translate(
			{
				type: "message.created",
				properties: { messageID: "msg-1", info: { role: "assistant" } },
			},
			{ sessionId: "s1" },
		);
		// Tool first seen as running — emits [tool_start, tool_executing]
		const result = translator.translate(
			{
				type: "message.part.updated",
				properties: {
					partID: "tool-1",
					part: {
						type: "tool",
						callID: "call-1",
						tool: "bash",
						state: { status: "running", input: { cmd: "ls" } },
					},
				},
			},
			{ sessionId: "s1" },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages).toHaveLength(2);
			for (const msg of result.messages) {
				expect((msg as { messageId?: string }).messageId).toBe("msg-1");
			}
		}
	});

	it("enriches result with tracked messageId when msg.id is absent", () => {
		const translator = createTranslator();
		translator.translate(
			{
				type: "message.created",
				properties: { messageID: "msg-1", info: { role: "assistant" } },
			},
			{ sessionId: "s1" },
		);
		// message.updated where nested info has no id → result without messageId
		const result = translator.translate(
			{
				type: "message.updated",
				properties: {
					sessionID: "s1",
					info: { role: "assistant", tokens: { input: 100, output: 50 } },
				},
			},
			{ sessionId: "s1" },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages[0]!.type).toBe("result");
			expect((result.messages[0] as { messageId?: string }).messageId).toBe(
				"msg-1",
			);
		}
	});

	it("does not enrich non-LLM event types (done, error, etc.)", () => {
		const translator = createTranslator();
		translator.translate(
			{
				type: "message.created",
				properties: { messageID: "msg-1", info: { role: "assistant" } },
			},
			{ sessionId: "s1" },
		);
		const result = translator.translate(
			{
				type: "session.status",
				properties: { sessionID: "s1", status: { type: "idle" } },
			},
			{ sessionId: "s1" },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages[0]!.type).toBe("done");
			expect("messageId" in result.messages[0]!).toBe(false);
		}
	});

	it("does not enrich when no messageId has been tracked", () => {
		const translator = createTranslator();
		// No message.created first — translate directly
		const result = translator.translate(
			{
				type: "message.part.updated",
				properties: {
					partID: "tool-1",
					part: {
						type: "tool",
						callID: "call-1",
						tool: "bash",
						state: { status: "pending" },
					},
				},
			},
			{ sessionId: "s1" },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages[0]!.type).toBe("tool_start");
			expect("messageId" in result.messages[0]!).toBe(false);
		}
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/relay/event-translator-messageid.test.ts`
Expected: FAIL — messages lack `messageId` (enrichment not yet implemented)

**Step 3: Write minimal implementation**

Add the enrichment helper and refactor `translate()` to use it. In `event-translator.ts`:

Add the helper outside `createTranslator()` (near `wrapResult`, around line 548):

```typescript
/**
 * Event types that should carry messageId (LLM streaming events).
 * Must stay in sync with the RelayMessage variants in shared-types.ts
 * that declare `messageId?: string`.
 */
const ENRICHABLE_TYPES = new Set([
	"delta",
	"thinking_start",
	"thinking_delta",
	"thinking_stop",
	"tool_start",
	"tool_executing",
	"tool_result",
	"result",
]);

/** Inject fallback messageId into output messages that lack one. */
function enrichResult(
	result: TranslateResult,
	fallbackMessageId: string | undefined,
): TranslateResult {
	if (!result.ok || !fallbackMessageId) return result;

	const needsEnrichment = result.messages.some(
		(m) => ENRICHABLE_TYPES.has(m.type) && !("messageId" in m),
	);
	if (!needsEnrichment) return result;

	return {
		ok: true,
		messages: result.messages.map((m) => {
			if (ENRICHABLE_TYPES.has(m.type) && !("messageId" in m)) {
				return { ...m, messageId: fallbackMessageId } as RelayMessage;
			}
			return m;
		}),
	};
}
```

Then refactor `translate()` to apply enrichment. Extract the existing dispatch logic to a local function `dispatchEvent` and wrap it:

```typescript
export function createTranslator(): Translator {
	const DEFAULT_SESSION = "__default__";
	const sessionParts = new Map<
		string,
		Map<string, { type: PartType; status?: ToolStatus }>
	>();
	const sessionMessageIds = new Map<string, string>();

	function getOrCreateSessionParts(
		sessionId: string | undefined,
	): Map<string, { type: PartType; status?: ToolStatus }> {
		const key = sessionId ?? DEFAULT_SESSION;
		let parts = sessionParts.get(key);
		if (!parts) {
			parts = new Map();
			sessionParts.set(key, parts);
		}
		return parts;
	}

	/** Core dispatch — all existing if/return branches, extracted unchanged. */
	function dispatchEvent(
		event: OpenCodeEvent,
		seenParts: Map<string, { type: PartType; status?: ToolStatus }>,
		context?: TranslateContext,
	): TranslateResult {
		const eventType = event.type;

		// ... ALL existing dispatch branches from the current translate() body,
		// starting from `if (eventType === "message.part.delta")` through
		// the final `return { ok: false, reason: ... }`, moved here UNCHANGED.
	}

	return {
		translate(
			event: OpenCodeEvent,
			context?: TranslateContext,
		): TranslateResult {
			const sessionKey = context?.sessionId ?? DEFAULT_SESSION;

			// ── Track messageId from any non-removal event ──────────────
			if (
				event.type !== "message.removed" &&
				event.type !== "message.part.removed"
			) {
				const props = event.properties as Record<string, unknown>;
				const mid = props["messageID"];
				if (typeof mid === "string" && mid) {
					sessionMessageIds.set(sessionKey, mid);
				}
			}

			// ── Dispatch ────────────────────────────────────────────────
			const seenParts = getOrCreateSessionParts(context?.sessionId);
			const result = dispatchEvent(event, seenParts, context);

			// ── Enrich output with fallback messageId ───────────────────
			return enrichResult(result, sessionMessageIds.get(sessionKey));
		},

		// ... rest of methods unchanged, plus getCurrentMessageId ...
	};
}
```

The key structural change: the body of the old `translate()` (the big if/return chain) moves into `dispatchEvent()`. The new `translate()` is a thin wrapper: track → dispatch → enrich.

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/relay/event-translator-messageid.test.ts`
Expected: PASS

**Step 5: Run ALL existing translator tests to verify no regressions**

Run: `pnpm vitest run test/unit/relay/event-translator`
Expected: All pass — the dispatch logic is unchanged, just extracted.

**Step 6: Commit**

```
feat: enrich relay messages with fallback messageId from translator tracking
```

---

### Task 4: Explicit messageId is NOT overridden

**Files:**
- Modify: `test/unit/relay/event-translator-messageid.test.ts`
- Export: `enrichResult` from `event-translator.ts` (for direct unit testing)

**Step 1: Export enrichResult for direct testing**

In `event-translator.ts`, change `enrichResult` from a module-private function to an exported function:

```typescript
export function enrichResult(
```

**Step 2: Write the tests**

The integration tests through `translate()` are inherently tautological for the override case (the tracker updates from the same event, so tracker and sub-translator always agree). To meaningfully test that enrichment preserves existing messageId, test `enrichResult` directly:

```typescript
import {
	createTranslator,
	enrichResult,
} from "../../../src/lib/relay/event-translator.js";
import type { TranslateResult } from "../../../src/lib/relay/event-translator.js";

describe("explicit messageId is preserved", () => {
	it("enrichResult does not override existing messageId on messages", () => {
		const input: TranslateResult = {
			ok: true,
			messages: [{ type: "delta", text: "hi", messageId: "msg-original" }],
		};
		const result = enrichResult(input, "msg-fallback");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect((result.messages[0] as { messageId?: string }).messageId).toBe(
				"msg-original",
			);
		}
	});

	it("enrichResult injects fallback only when messageId key is absent", () => {
		const input: TranslateResult = {
			ok: true,
			messages: [{ type: "tool_start", id: "call-1", name: "Bash" }],
		};
		const result = enrichResult(input, "msg-fallback");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect((result.messages[0] as { messageId?: string }).messageId).toBe(
				"msg-fallback",
			);
		}
	});

	it("enrichResult handles mixed messages (some with, some without messageId)", () => {
		const input: TranslateResult = {
			ok: true,
			messages: [
				{ type: "tool_start", id: "c1", name: "Bash", messageId: "msg-explicit" },
				{ type: "tool_executing", id: "c1", name: "Bash", input: {} },
			],
		};
		const result = enrichResult(input, "msg-fallback");
		expect(result.ok).toBe(true);
		if (result.ok) {
			// First message: already has messageId → preserved
			expect((result.messages[0] as { messageId?: string }).messageId).toBe(
				"msg-explicit",
			);
			// Second message: missing → gets fallback
			expect((result.messages[1] as { messageId?: string }).messageId).toBe(
				"msg-fallback",
			);
		}
	});

	it("integration: translate does not override event-provided messageId", () => {
		const translator = createTranslator();
		// Track msg-1
		translator.translate(
			{
				type: "message.created",
				properties: { messageID: "msg-1", info: { role: "assistant" } },
			},
			{ sessionId: "s1" },
		);
		// Delta WITH its own messageID (msg-2)
		const result = translator.translate(
			{
				type: "message.part.delta",
				properties: {
					partID: "p1",
					messageID: "msg-2",
					field: "text",
					delta: "hi",
				},
			},
			{ sessionId: "s1" },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			// Should have msg-2 (from the event), NOT msg-1 (from earlier tracker state)
			// Note: the tracker also updates to msg-2 from this event, so this test
			// primarily documents the contract rather than isolating enrichment behavior.
			expect((result.messages[0] as { messageId?: string }).messageId).toBe(
				"msg-2",
			);
		}
	});
});
```

**Step 3: Run test to verify it passes**

Run: `pnpm vitest run test/unit/relay/event-translator-messageid.test.ts`
Expected: PASS

**Step 4: Commit**

```
test: verify enrichResult preserves explicit messageId and add direct unit tests
```

---

### Task 5: Reset + session isolation

**Files:**
- Modify: `src/lib/relay/event-translator.ts:772-778` (reset method)
- Modify: `test/unit/relay/event-translator-messageid.test.ts`

**Step 1: Write the failing tests**

```typescript
describe("reset clears tracked messageId", () => {
	it("clears specific session messageId on reset(sessionId)", () => {
		const translator = createTranslator();
		translator.translate(
			{
				type: "message.part.delta",
				properties: {
					partID: "p1",
					messageID: "msg-1",
					field: "text",
					delta: "hi",
				},
			},
			{ sessionId: "s1" },
		);
		expect(translator.getCurrentMessageId("s1")).toBe("msg-1");
		translator.reset("s1");
		expect(translator.getCurrentMessageId("s1")).toBeUndefined();
	});

	it("enrichment stops producing messageId in output after reset", () => {
		const translator = createTranslator();
		// Populate tracker
		translator.translate(
			{
				type: "message.created",
				properties: { messageID: "msg-1", info: { role: "assistant" } },
			},
			{ sessionId: "s1" },
		);
		// Reset
		translator.reset("s1");
		// New tool event — should NOT get enriched
		const result = translator.translate(
			{
				type: "message.part.updated",
				properties: {
					partID: "tool-after-reset",
					part: {
						type: "tool",
						callID: "call-after-reset",
						tool: "bash",
						state: { status: "pending" },
					},
				},
			},
			{ sessionId: "s1" },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages[0]!.type).toBe("tool_start");
			expect("messageId" in result.messages[0]!).toBe(false);
		}
	});

	it("clears all session messageIds on reset() with no args", () => {
		const translator = createTranslator();
		translator.translate(
			{
				type: "message.part.delta",
				properties: {
					partID: "p1",
					messageID: "msg-1",
					field: "text",
					delta: "hi",
				},
			},
			{ sessionId: "s1" },
		);
		translator.translate(
			{
				type: "message.part.delta",
				properties: {
					partID: "p2",
					messageID: "msg-2",
					field: "text",
					delta: "hi",
				},
			},
			{ sessionId: "s2" },
		);
		translator.reset();
		expect(translator.getCurrentMessageId("s1")).toBeUndefined();
		expect(translator.getCurrentMessageId("s2")).toBeUndefined();
	});
});

describe("session isolation", () => {
	it("messageId tracked for session s1 does not affect session s2", () => {
		const translator = createTranslator();
		translator.translate(
			{
				type: "message.created",
				properties: { messageID: "msg-s1", info: { role: "assistant" } },
			},
			{ sessionId: "s1" },
		);
		// s2 has no tracked messageId — tool event should NOT get s1's messageId
		const result = translator.translate(
			{
				type: "message.part.updated",
				properties: {
					partID: "tool-1",
					part: {
						type: "tool",
						callID: "call-1",
						tool: "bash",
						state: { status: "pending" },
					},
				},
			},
			{ sessionId: "s2" },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect("messageId" in result.messages[0]!).toBe(false);
		}
	});

	it("enriches s2 events only with s2 tracked messageId", () => {
		const translator = createTranslator();
		translator.translate(
			{
				type: "message.created",
				properties: { messageID: "msg-s1", info: { role: "assistant" } },
			},
			{ sessionId: "s1" },
		);
		translator.translate(
			{
				type: "message.created",
				properties: { messageID: "msg-s2", info: { role: "assistant" } },
			},
			{ sessionId: "s2" },
		);
		const result = translator.translate(
			{
				type: "message.part.updated",
				properties: {
					partID: "tool-1",
					part: {
						type: "tool",
						callID: "call-1",
						tool: "bash",
						state: { status: "pending" },
					},
				},
			},
			{ sessionId: "s2" },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect((result.messages[0] as { messageId?: string }).messageId).toBe(
				"msg-s2",
			);
		}
	});
});
```

**Step 2: Run tests to verify reset tests fail**

Run: `pnpm vitest run test/unit/relay/event-translator-messageid.test.ts`
Expected: Reset tests FAIL (reset doesn't clear `sessionMessageIds` yet). Session isolation tests should PASS (per-session map keying).

**Step 3: Write minimal implementation**

Update `reset()` in `event-translator.ts` (around line 772):

```typescript
reset(sessionId?: string) {
	if (sessionId != null) {
		sessionParts.delete(sessionId);
		sessionMessageIds.delete(sessionId);
	} else {
		sessionParts.clear();
		sessionMessageIds.clear();
	}
},
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/relay/event-translator-messageid.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat: clear tracked messageId on translator reset
```

---

### Task 6: Rebuild from history sets messageId

**Files:**
- Modify: `src/lib/relay/event-translator.ts:559-577,784-804` (Translator interface + rebuildStateFromHistory)
- Modify: `test/unit/relay/event-translator-messageid.test.ts`

This ensures that after a session switch (which calls `rebuildStateFromHistory`), the translator knows the last message ID so subsequent SSE events can be enriched.

**Step 1: Write the failing test**

```typescript
describe("rebuildStateFromHistory sets messageId", () => {
	it("sets messageId from the last message in history", () => {
		const translator = createTranslator();
		translator.rebuildStateFromHistory("s1", [
			{
				id: "msg-1",
				parts: [{ id: "p1", type: "text" as const }],
			},
			{
				id: "msg-2",
				parts: [
					{
						id: "p2",
						type: "tool" as const,
						state: { status: "completed" as const },
					},
				],
			},
		]);
		expect(translator.getCurrentMessageId("s1")).toBe("msg-2");
	});

	it("does not set messageId when messages have no id", () => {
		const translator = createTranslator();
		translator.rebuildStateFromHistory("s1", [
			{ parts: [{ id: "p1", type: "text" as const }] },
		]);
		expect(translator.getCurrentMessageId("s1")).toBeUndefined();
	});

	it("enriches events after rebuild", () => {
		const translator = createTranslator();
		translator.rebuildStateFromHistory("s1", [
			{
				id: "msg-rebuild",
				parts: [
					{
						id: "tool-existing",
						type: "tool" as const,
						state: { status: "completed" as const },
					},
				],
			},
		]);
		// New tool event without messageID should get enriched
		const result = translator.translate(
			{
				type: "message.part.updated",
				properties: {
					partID: "tool-new",
					part: {
						type: "tool",
						callID: "call-new",
						tool: "bash",
						state: { status: "pending" },
					},
				},
			},
			{ sessionId: "s1" },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect((result.messages[0] as { messageId?: string }).messageId).toBe(
				"msg-rebuild",
			);
		}
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/relay/event-translator-messageid.test.ts`
Expected: FAIL — `rebuildStateFromHistory` doesn't accept `id` in its type, and doesn't set `sessionMessageIds`.

**Step 3: Write minimal implementation**

Update the `rebuildStateFromHistory` signature in the `Translator` interface and implementation to accept an optional `id` on each message:

In the interface (around line 568):

```typescript
rebuildStateFromHistory(
	sessionId: string,
	messages: Array<{
		id?: string;
		parts?: Array<{
			id: string;
			type: PartType;
			state?: { status?: ToolStatus };
		}>;
	}>,
): void;
```

In the implementation (around line 784):

```typescript
rebuildStateFromHistory(
	sessionId: string,
	messages: Array<{
		id?: string;
		parts?: Array<{
			id: string;
			type: PartType;
			state?: { status?: ToolStatus };
		}>;
	}>,
) {
	const parts = getOrCreateSessionParts(sessionId);
	parts.clear();
	// Track the last message's id for messageId enrichment
	let lastMessageId: string | undefined;
	for (const msg of messages) {
		if (msg.id) {
			lastMessageId = msg.id;
		}
		for (const part of msg.parts ?? []) {
			parts.set(part.id, {
				type: part.type,
				...(part.state?.status != null && {
					status: part.state.status,
				}),
			});
		}
	}
	if (lastMessageId) {
		sessionMessageIds.set(sessionId, lastMessageId);
	} else {
		sessionMessageIds.delete(sessionId);
	}
},
```

Also update `rebuildTranslatorFromHistory` (around line 826) to pass `id` through:

```typescript
const parts = messages.map((m) => {
	const rawParts = (m as { parts?: unknown[] }).parts as
		| Array<{
				id: string;
				type: PartType;
				state?: { status?: ToolStatus };
		  }>
		| undefined;
	const msgId = (m as { id?: string }).id;
	return {
		...(msgId != null && { id: msgId }),
		...(rawParts != null && { parts: rawParts }),
	};
});
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/relay/event-translator-messageid.test.ts`
Expected: PASS

**Step 5: Run all translator tests + the session-switch tests for regressions**

Run: `pnpm vitest run test/unit/relay/event-translator test/unit/session/session-switch`
Expected: All pass

**Step 6: Commit**

```
feat: set tracked messageId from history during translator rebuild
```

---

### Task 7: Frontend cleanup — remove debug warning

**Files:**
- Modify: `src/lib/frontend/stores/ws-dispatch.ts:263-283`

Now that the relay guarantees `messageId` enrichment on all LLM event types, the "LLM event has NO messageId" debug log serves no purpose and adds noise.

**Step 1: Remove the LLM_TYPES warning block**

In `ws-dispatch.ts`, replace the else-branch (lines 263-283) with nothing — just remove the dead diagnostic. The turn boundary detection (`if (hasMessageId && msgId != null)`) remains.

Before:
```typescript
if (hasMessageId && msgId != null) {
	advanceTurnIfNewMessage(msgId as string);
} else {
	const LLM_TYPES = new Set([
		"delta",
		"thinking_start",
		"thinking_delta",
		"thinking_stop",
		"tool_start",
		"tool_executing",
		"tool_result",
		"result",
	]);
	if (LLM_TYPES.has(event.type)) {
		log.debug(
			"LLM event %s has NO messageId (hasKey=%s val=%s) replay=%s",
			event.type,
			hasMessageId,
			msgId,
			ctx.isReplay,
		);
	}
}
```

After:
```typescript
if (hasMessageId && msgId != null) {
	advanceTurnIfNewMessage(msgId as string);
}
```

**Step 2: Verify the build still passes**

Run: `pnpm check`
Expected: PASS

**Step 3: Commit**

```
refactor: remove obsolete messageId debug warning from ws-dispatch

The relay's event translator now enriches all LLM events with a tracked
messageId fallback, making this diagnostic unnecessary.
```

---

### Task 8: Full verification

**Step 1: Run the full verification suite**

```bash
pnpm check && pnpm lint && pnpm test:unit
```

Expected: All pass.

**Step 2: Run the existing translator test suites specifically**

```bash
pnpm vitest run test/unit/relay/event-translator.pbt.test.ts
pnpm vitest run test/unit/relay/event-translator.stateful.test.ts
pnpm vitest run test/unit/relay/event-translator-result.test.ts
pnpm vitest run test/unit/relay/event-translator-messageid.test.ts
```

Expected: All pass.

**Step 3: Smoke check the relay pipeline test**

```bash
pnpm vitest run test/unit/relay/regression-server-cache-pipeline.test.ts
pnpm vitest run test/unit/relay/event-pipeline.test.ts
```

Expected: All pass — pipeline tests exercise the translator through the SSE wiring path.
