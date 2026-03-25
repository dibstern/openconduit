import { describe, expect, it, vi } from "vitest";
import type {
	SessionHistorySource,
	SessionSwitchDeps,
} from "../../../src/lib/session/session-switch.js";
import {
	buildSessionSwitchedMessage,
	classifyHistorySource,
	resolveSessionHistory,
} from "../../../src/lib/session/session-switch.js";
import type { RequestId } from "../../../src/lib/shared-types.js";
import type { RelayMessage } from "../../../src/lib/types.js";

describe("classifyHistorySource", () => {
	it('returns "needs-rest" when events is null', () => {
		expect(classifyHistorySource(null)).toBe("needs-rest");
	});

	it('returns "needs-rest" when events is undefined', () => {
		expect(classifyHistorySource(undefined)).toBe("needs-rest");
	});

	it('returns "needs-rest" when events is empty array', () => {
		expect(classifyHistorySource([])).toBe("needs-rest");
	});

	it('returns "needs-rest" when events have no chat content (only status/done)', () => {
		const events: RelayMessage[] = [
			{ type: "status", status: "processing" },
			{ type: "done", code: 0 },
		];
		expect(classifyHistorySource(events)).toBe("needs-rest");
	});

	it('returns "cached-events" when events contain user_message', () => {
		const events: RelayMessage[] = [{ type: "user_message", text: "hello" }];
		expect(classifyHistorySource(events)).toBe("cached-events");
	});

	it('returns "cached-events" when events contain delta', () => {
		const events: RelayMessage[] = [{ type: "delta", text: "response" }];
		expect(classifyHistorySource(events)).toBe("cached-events");
	});

	it('returns "cached-events" when events have mixed content with at least one user_message', () => {
		const events: RelayMessage[] = [
			{ type: "status", status: "processing" },
			{ type: "user_message", text: "hello" },
			{ type: "done", code: 0 },
		];
		expect(classifyHistorySource(events)).toBe("cached-events");
	});
});

describe("buildSessionSwitchedMessage", () => {
	it("builds message from cached-events source", () => {
		const events: RelayMessage[] = [{ type: "user_message", text: "hello" }];
		const source: SessionHistorySource = { kind: "cached-events", events };
		const msg = buildSessionSwitchedMessage("ses_1", source);

		expect(msg).toEqual({
			type: "session_switched",
			id: "ses_1",
			events,
		});
	});

	it("builds message from rest-history source", () => {
		const history = {
			messages: [{ id: "m1", role: "user" as const, parts: [] }],
			hasMore: true,
			total: 42,
		};
		const source: SessionHistorySource = { kind: "rest-history", history };
		const msg = buildSessionSwitchedMessage("ses_2", source);

		expect(msg).toEqual({
			type: "session_switched",
			id: "ses_2",
			history: { messages: history.messages, hasMore: true, total: 42 },
		});
	});

	it("omits total from history when undefined", () => {
		const history = {
			messages: [],
			hasMore: false,
		};
		const source: SessionHistorySource = { kind: "rest-history", history };
		const msg = buildSessionSwitchedMessage("ses_3", source);

		expect(msg.history).toEqual({ messages: [], hasMore: false });
		expect("total" in (msg.history ?? {})).toBe(false);
	});

	it("builds bare message from empty source", () => {
		const source: SessionHistorySource = { kind: "empty" };
		const msg = buildSessionSwitchedMessage("ses_4", source);

		expect(msg).toEqual({ type: "session_switched", id: "ses_4" });
	});

	it("includes inputText when draft is provided", () => {
		const source: SessionHistorySource = { kind: "empty" };
		const msg = buildSessionSwitchedMessage("ses_5", source, {
			draft: "work in progress",
		});

		expect(msg.inputText).toBe("work in progress");
	});

	it("omits inputText when draft is empty string", () => {
		const source: SessionHistorySource = { kind: "empty" };
		const msg = buildSessionSwitchedMessage("ses_6", source, { draft: "" });

		expect("inputText" in msg).toBe(false);
	});

	it("omits inputText when draft is undefined", () => {
		const source: SessionHistorySource = { kind: "empty" };
		const msg = buildSessionSwitchedMessage("ses_7", source, {});

		expect("inputText" in msg).toBe(false);
	});

	it("includes requestId when provided", () => {
		const source: SessionHistorySource = { kind: "empty" };
		const msg = buildSessionSwitchedMessage("ses_8", source, {
			requestId: "req-abc" as RequestId,
		});

		expect(msg.requestId).toBe("req-abc");
	});

	it("omits requestId when not provided (exactOptionalPropertyTypes safe)", () => {
		const source: SessionHistorySource = { kind: "empty" };
		const msg = buildSessionSwitchedMessage("ses_9", source);

		expect("requestId" in msg).toBe(false);
	});

	it("includes both draft and requestId with cached-events", () => {
		const events: RelayMessage[] = [{ type: "delta", text: "hi" }];
		const source: SessionHistorySource = { kind: "cached-events", events };
		const msg = buildSessionSwitchedMessage("ses_10", source, {
			draft: "draft text",
			requestId: "req-xyz" as RequestId,
		});

		expect(msg).toEqual({
			type: "session_switched",
			id: "ses_10",
			events,
			inputText: "draft text",
			requestId: "req-xyz",
		});
	});
});

function createMinimalDeps(
	overrides?: Partial<
		Pick<SessionSwitchDeps, "messageCache" | "sessionMgr" | "log">
	>,
): Pick<SessionSwitchDeps, "messageCache" | "sessionMgr" | "log"> {
	return {
		messageCache: { getEvents: vi.fn().mockReturnValue(null) },
		sessionMgr: {
			loadPreRenderedHistory: vi.fn().mockResolvedValue({
				messages: [],
				hasMore: false,
			}),
		},
		log: { info: vi.fn(), warn: vi.fn() },
		...overrides,
	};
}

describe("resolveSessionHistory", () => {
	it("returns cached-events when cache has chat content", async () => {
		const events: RelayMessage[] = [{ type: "user_message", text: "hello" }];
		const deps = createMinimalDeps({
			messageCache: { getEvents: vi.fn().mockReturnValue(events) },
		});

		const result = await resolveSessionHistory("ses_1", deps);

		expect(result.kind).toBe("cached-events");
		expect(result.kind === "cached-events" && result.events).toEqual(events);
		expect(deps.sessionMgr.loadPreRenderedHistory).not.toHaveBeenCalled();
	});

	it("returns rest-history when cache misses", async () => {
		const history = {
			messages: [{ id: "m1", role: "user" as const }],
			hasMore: true,
			total: 5,
		};
		const deps = createMinimalDeps({
			sessionMgr: {
				loadPreRenderedHistory: vi.fn().mockResolvedValue(history),
			},
		});

		const result = await resolveSessionHistory("ses_2", deps);

		expect(result.kind).toBe("rest-history");
		if (result.kind === "rest-history") {
			expect(result.history.messages).toEqual(history.messages);
			expect(result.history.hasMore).toBe(true);
			expect(result.history.total).toBe(5);
		}
	});

	it("returns rest-history when cache has events but no chat content", async () => {
		const events: RelayMessage[] = [{ type: "status", status: "idle" }];
		const history = { messages: [], hasMore: false };
		const deps = createMinimalDeps({
			messageCache: { getEvents: vi.fn().mockReturnValue(events) },
			sessionMgr: {
				loadPreRenderedHistory: vi.fn().mockResolvedValue(history),
			},
		});

		const result = await resolveSessionHistory("ses_3", deps);

		expect(result.kind).toBe("rest-history");
		expect(deps.sessionMgr.loadPreRenderedHistory).toHaveBeenCalledWith(
			"ses_3",
		);
	});

	it("returns empty when REST API fails", async () => {
		const deps = createMinimalDeps({
			sessionMgr: {
				loadPreRenderedHistory: vi
					.fn()
					.mockRejectedValue(new Error("API down")),
			},
		});

		const result = await resolveSessionHistory("ses_4", deps);

		expect(result.kind).toBe("empty");
		expect(deps.log.warn).toHaveBeenCalled();
	});

	it("logs the session ID and error when REST fails", async () => {
		const deps = createMinimalDeps({
			sessionMgr: {
				loadPreRenderedHistory: vi.fn().mockRejectedValue(new Error("timeout")),
			},
		});

		await resolveSessionHistory("ses_5", deps);

		const warnCall = vi.mocked(deps.log.warn).mock.calls[0]?.[0] as string;
		expect(warnCall).toContain("ses_5");
		expect(warnCall).toContain("timeout");
	});
});
