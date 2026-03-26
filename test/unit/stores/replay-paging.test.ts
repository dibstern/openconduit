// ─── Replay Paging ───────────────────────────────────────────────────────────
// Verifies that commitReplayFinal pages large replays: only the last 50
// messages are committed to chatState.messages, with the rest stored in a
// replay buffer that can be consumed page-by-page.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Must mock localStorage BEFORE any store modules are loaded.
vi.hoisted(() => {
	let store: Record<string, string> = {};
	const mock = {
		getItem: vi.fn((key: string) => store[key] ?? null),
		setItem: vi.fn((key: string, value: string) => {
			store[key] = value;
		}),
		removeItem: vi.fn((key: string) => {
			delete store[key];
		}),
		clear: vi.fn(() => {
			store = {};
		}),
		get length() {
			return Object.keys(store).length;
		},
		key: vi.fn((_: number) => null),
	};
	Object.defineProperty(globalThis, "localStorage", {
		value: mock,
		writable: true,
		configurable: true,
	});
});

// Mock DOMPurify (browser-only) before importing stores
vi.mock("dompurify", () => ({
	default: {
		sanitize: (html: string) => html,
	},
}));

import {
	beginReplayBatch,
	chatState,
	clearMessages,
	commitReplayFinal,
	consumeReplayBuffer,
	getMessages,
	getReplayBuffer,
	historyState,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import type { ChatMessage } from "../../../src/lib/frontend/types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create N user messages for test fixtures. */
function makeUserMessages(count: number): ChatMessage[] {
	return Array.from({ length: count }, (_, i) => ({
		type: "user" as const,
		uuid: `uuid-${i}`,
		text: `message-${i}`,
	}));
}

// ─── Reset state before each test ───────────────────────────────────────────

beforeEach(() => {
	clearMessages();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("commitReplayFinal paging", () => {
	it("commits all messages when <= 50", () => {
		beginReplayBatch();

		// Manually populate the replay batch with 30 messages
		const msgs = makeUserMessages(30);
		for (const m of msgs) {
			// Use getMessages + setMessages pattern via direct batch manipulation
			const current = getMessages();
			current.push(m);
		}

		commitReplayFinal("session-1");

		expect(chatState.messages).toHaveLength(30);
		expect(chatState.loadLifecycle).toBe("committed");
		expect(getReplayBuffer("session-1")).toBeUndefined();
		expect(historyState.hasMore).toBe(false);
	});

	it("commits only last 50 messages when > 50, stores rest in buffer", () => {
		beginReplayBatch();

		const msgs = makeUserMessages(120);
		for (const m of msgs) {
			getMessages().push(m);
		}

		commitReplayFinal("session-2");

		// chatState.messages should have the last 50
		expect(chatState.messages).toHaveLength(50);
		expect((chatState.messages[0] as { text: string }).text).toBe("message-70");
		expect((chatState.messages[49] as { text: string }).text).toBe(
			"message-119",
		);

		// Buffer should have the first 70
		const buffer = getReplayBuffer("session-2");
		expect(buffer).toBeDefined();
		expect(buffer).toHaveLength(70);
		expect((buffer?.[0] as { text: string }).text).toBe("message-0");
		expect((buffer?.[69] as { text: string }).text).toBe("message-69");

		expect(chatState.loadLifecycle).toBe("committed");
		expect(historyState.hasMore).toBe(true);
	});

	it("exactly 50 messages commits all without buffer", () => {
		beginReplayBatch();

		const msgs = makeUserMessages(50);
		for (const m of msgs) {
			getMessages().push(m);
		}

		commitReplayFinal("session-exact");

		expect(chatState.messages).toHaveLength(50);
		expect(getReplayBuffer("session-exact")).toBeUndefined();
		expect(historyState.hasMore).toBe(false);
	});

	it("no-ops when replay batch is null", () => {
		// No beginReplayBatch — batch is null
		commitReplayFinal("session-noop");

		expect(chatState.messages).toHaveLength(0);
		expect(getReplayBuffer("session-noop")).toBeUndefined();
	});
});

describe("getReplayBuffer", () => {
	it("returns undefined for unknown session", () => {
		expect(getReplayBuffer("unknown-session")).toBeUndefined();
	});

	it("returns the stored buffer", () => {
		beginReplayBatch();

		const msgs = makeUserMessages(80);
		for (const m of msgs) {
			getMessages().push(m);
		}

		commitReplayFinal("session-buf");

		const buffer = getReplayBuffer("session-buf");
		expect(buffer).toBeDefined();
		expect(buffer).toHaveLength(30); // 80 - 50 = 30
	});
});

describe("consumeReplayBuffer", () => {
	it("returns messages from the end (most recent) and reduces buffer", () => {
		beginReplayBatch();

		const msgs = makeUserMessages(100);
		for (const m of msgs) {
			getMessages().push(m);
		}

		commitReplayFinal("session-consume");

		// Buffer has 50 messages (100 - 50 = 50), messages 0..49
		const buffer = getReplayBuffer("session-consume");
		expect(buffer).toHaveLength(50);

		// Consume 20 from the end of the buffer
		const page = consumeReplayBuffer("session-consume", 20);
		expect(page).toHaveLength(20);
		// Should be the most recent 20 from the buffer (messages 30..49)
		expect((page[0] as { text: string }).text).toBe("message-30");
		expect((page[19] as { text: string }).text).toBe("message-49");

		// Buffer should now have 30 remaining
		const remaining = getReplayBuffer("session-consume");
		expect(remaining).toHaveLength(30);
		expect((remaining?.[0] as { text: string }).text).toBe("message-0");
		expect((remaining?.[29] as { text: string }).text).toBe("message-29");
	});

	it("deletes buffer when fully consumed", () => {
		beginReplayBatch();

		const msgs = makeUserMessages(60);
		for (const m of msgs) {
			getMessages().push(m);
		}

		commitReplayFinal("session-full");

		// Buffer has 10 messages (60 - 50 = 10)
		expect(getReplayBuffer("session-full")).toHaveLength(10);

		// Consume all 10
		const page = consumeReplayBuffer("session-full", 10);
		expect(page).toHaveLength(10);

		// Buffer should be deleted
		expect(getReplayBuffer("session-full")).toBeUndefined();
	});

	it("returns empty array for unknown session", () => {
		const page = consumeReplayBuffer("nonexistent", 10);
		expect(page).toHaveLength(0);
	});

	it("returns empty array when buffer is empty", () => {
		beginReplayBatch();

		const msgs = makeUserMessages(60);
		for (const m of msgs) {
			getMessages().push(m);
		}

		commitReplayFinal("session-empty");

		// Consume all
		consumeReplayBuffer("session-empty", 10);
		expect(getReplayBuffer("session-empty")).toBeUndefined();

		// Try consuming again
		const page = consumeReplayBuffer("session-empty", 5);
		expect(page).toHaveLength(0);
	});

	it("clearMessages clears the replay buffer for the current session", () => {
		beginReplayBatch();

		const msgs = makeUserMessages(80);
		for (const m of msgs) {
			getMessages().push(m);
		}

		commitReplayFinal("session-clear");

		// Buffer exists
		expect(getReplayBuffer("session-clear")).toBeDefined();

		// clearMessages should clean up
		clearMessages();

		// Buffer should be gone (clearMessages clears all buffers)
		expect(getReplayBuffer("session-clear")).toBeUndefined();
	});
});
