import { describe, expect, it, vi } from "vitest";
import type {
	SessionHistorySource,
	SessionSwitchDeps,
} from "../../../src/lib/session/session-switch.js";
import {
	buildSessionSwitchedMessage,
	classifyHistorySource,
	countUniqueMessages,
	resolveSessionHistory,
	switchClientToSession,
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
		const source: SessionHistorySource = {
			kind: "cached-events",
			events,
			hasMore: false,
		};
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
		const source: SessionHistorySource = {
			kind: "cached-events",
			events,
			hasMore: true,
		};
		const msg = buildSessionSwitchedMessage("ses_10", source, {
			draft: "draft text",
			requestId: "req-xyz" as RequestId,
		});

		expect(msg).toEqual({
			type: "session_switched",
			id: "ses_10",
			events,
			eventsHasMore: true,
			inputText: "draft text",
			requestId: "req-xyz",
		});
	});
});

function createMinimalDeps(
	overrides?: Partial<
		Pick<SessionSwitchDeps, "messageCache" | "sessionMgr" | "log" | "forkMeta">
	>,
): Pick<SessionSwitchDeps, "messageCache" | "sessionMgr" | "log" | "forkMeta"> {
	return {
		messageCache: { getEvents: vi.fn().mockReturnValue(null) },
		sessionMgr: {
			loadPreRenderedHistory: vi.fn().mockResolvedValue({
				messages: [],
				hasMore: false,
			}),
			seedPaginationCursor: vi.fn(),
		},
		log: { info: vi.fn(), warn: vi.fn() },
		...overrides,
	};
}

describe("countUniqueMessages", () => {
	it("counts user messages and unique assistant messageIds", () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "Turn 1" },
			{ type: "delta", text: "Response 1", messageId: "msg_asst1" },
			{ type: "delta", text: "Response 1 cont", messageId: "msg_asst1" },
			{ type: "user_message", text: "Turn 2" },
			{ type: "delta", text: "Response 2", messageId: "msg_asst2" },
		];
		// 2 user messages + 2 unique assistant messageIds = 4
		expect(countUniqueMessages(events)).toBe(4);
	});

	it("returns 0 for empty events", () => {
		expect(countUniqueMessages([])).toBe(0);
	});

	it("counts only user_messages when no messageIds present", () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "response without messageId" },
		];
		expect(countUniqueMessages(events)).toBe(1);
	});

	it("ignores non-chat events", () => {
		const events: RelayMessage[] = [
			{ type: "status", status: "processing" },
			{ type: "done", code: 0 },
		];
		expect(countUniqueMessages(events)).toBe(0);
	});

	// ── Conservative heuristic documentation ────────────────────────────
	// These tests document intentional undercounting. SSE-path events may
	// lack messageId (translator only includes it when props.messageID is
	// non-null). Undercounting triggers a harmless REST fallback — this is
	// the designed safety margin, NOT a bug to fix.

	it("undercounts SSE-path deltas without messageId (triggers safe REST fallback)", () => {
		// SSE-path: translator may omit messageId when props.messageID is null
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "response" }, // no messageId
		];
		// Only user_message counted — assistant turn invisible to heuristic
		expect(countUniqueMessages(events)).toBe(1);
		// If OpenCode has 2 messages (1 user + 1 assistant), 1 < 2 → REST
		// fallback. Cache was complete but we serve from REST anyway. Safe.
	});

	it("undercounts tool-only turns where tool events lack messageId", () => {
		// Session where LLM only used tools, no text deltas
		const events: RelayMessage[] = [
			{ type: "user_message", text: "run the build" },
			{ type: "tool_start", id: "t1", name: "bash" }, // no messageId
			{
				type: "tool_result",
				id: "t1",
				content: "ok",
				is_error: false,
			},
		];
		// Only user_message counted — tool_start without messageId is invisible
		expect(countUniqueMessages(events)).toBe(1);
		// OpenCode has 2 messages → 1 < 2 → REST fallback on complete cache
	});

	it("correctly counts tool-only turns when tool events have messageId (poller path)", () => {
		// Poller-synthesized events always include messageId
		const events: RelayMessage[] = [
			{ type: "user_message", text: "run the build" },
			{ type: "tool_start", id: "t1", name: "bash", messageId: "msg_a1" },
			{
				type: "tool_result",
				id: "t1",
				content: "ok",
				is_error: false,
			},
		];
		// user_message (1) + unique messageId "msg_a1" (1) = 2
		expect(countUniqueMessages(events)).toBe(2);
		// Matches OpenCode's 2 messages → cache served, no REST fallback
	});
});

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
				seedPaginationCursor: vi.fn(),
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
				seedPaginationCursor: vi.fn(),
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
				seedPaginationCursor: vi.fn(),
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
				seedPaginationCursor: vi.fn(),
			},
		});

		await resolveSessionHistory("ses_5", deps);

		const warnCall = vi.mocked(deps.log.warn).mock.calls[0]?.[0] as string;
		expect(warnCall).toContain("ses_5");
		expect(warnCall).toContain("timeout");
	});
});

describe("resolveSessionHistory — fork session cache bypass", () => {
	it("bypasses SSE cache for fork sessions and uses REST", async () => {
		// SSE cache has events but this is a fork session — should use REST
		// because the SSE cache only has events from after the fork was opened,
		// not the inherited parent messages.
		const events: RelayMessage[] = [
			{ type: "delta", text: "response", messageId: "msg_1" },
			{ type: "done", code: 0 },
		];
		const history = {
			messages: [
				{ id: "m1", role: "user" as const },
				{ id: "m2", role: "assistant" as const },
			],
			hasMore: false,
		};
		const deps = createMinimalDeps({
			messageCache: { getEvents: vi.fn().mockReturnValue(events) },
			sessionMgr: {
				loadPreRenderedHistory: vi.fn().mockResolvedValue(history),
				seedPaginationCursor: vi.fn(),
			},
			forkMeta: {
				getForkEntry: vi.fn().mockReturnValue({
					forkMessageId: "msg_fork",
					parentID: "ses_parent",
				}),
			},
		});

		const result = await resolveSessionHistory("ses_fork", deps);

		expect(result.kind).toBe("rest-history");
		expect(deps.sessionMgr.loadPreRenderedHistory).toHaveBeenCalledWith(
			"ses_fork",
		);
	});

	it("uses SSE cache for non-fork sessions with cache hit", async () => {
		// Same cache content but no fork metadata — should use cache as normal.
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "response", messageId: "msg_1" },
			{ type: "done", code: 0 },
		];
		const deps = createMinimalDeps({
			messageCache: { getEvents: vi.fn().mockReturnValue(events) },
			forkMeta: {
				getForkEntry: vi.fn().mockReturnValue(undefined),
			},
		});

		const result = await resolveSessionHistory("ses_normal", deps);

		expect(result.kind).toBe("cached-events");
		expect(deps.sessionMgr.loadPreRenderedHistory).not.toHaveBeenCalled();
	});

	it("returns empty when fork session REST fallback fails", async () => {
		const events: RelayMessage[] = [
			{ type: "delta", text: "partial", messageId: "msg_1" },
		];
		const deps = createMinimalDeps({
			messageCache: { getEvents: vi.fn().mockReturnValue(events) },
			sessionMgr: {
				loadPreRenderedHistory: vi
					.fn()
					.mockRejectedValue(new Error("API down")),
				seedPaginationCursor: vi.fn(),
			},
			forkMeta: {
				getForkEntry: vi.fn().mockReturnValue({
					forkMessageId: "msg_fork",
					parentID: "ses_parent",
				}),
			},
		});

		const result = await resolveSessionHistory("ses_fork_fail", deps);

		expect(result.kind).toBe("empty");
		expect(deps.log.warn).toHaveBeenCalled();
	});

	it("uses SSE cache when forkMeta is not provided", async () => {
		// forkMeta is optional — when absent, fork bypass is skipped.
		const events: RelayMessage[] = [{ type: "user_message", text: "hello" }];
		const deps = createMinimalDeps({
			messageCache: { getEvents: vi.fn().mockReturnValue(events) },
			// no forkMeta
		});

		const result = await resolveSessionHistory("ses_no_meta", deps);

		expect(result.kind).toBe("cached-events");
	});
});

// ─── switchClientToSession (orchestrator) ──────────────────────────────────

function createFullDeps(
	overrides?: Partial<SessionSwitchDeps>,
): SessionSwitchDeps {
	return {
		messageCache: { getEvents: vi.fn().mockReturnValue(null) },
		sessionMgr: {
			loadPreRenderedHistory: vi.fn().mockResolvedValue({
				messages: [],
				hasMore: false,
			}),
			seedPaginationCursor: vi.fn(),
		},
		wsHandler: {
			sendTo: vi.fn(),
			setClientSession: vi.fn(),
		},
		statusPoller: { isProcessing: vi.fn().mockReturnValue(false) },
		pollerManager: {
			isPolling: vi.fn().mockReturnValue(true),
			startPolling: vi.fn(),
		},
		log: { info: vi.fn(), warn: vi.fn() },
		getInputDraft: vi.fn().mockReturnValue(undefined),
		...overrides,
	};
}

describe("switchClientToSession", () => {
	it("does nothing when sessionId is empty", async () => {
		const deps = createFullDeps();
		await switchClientToSession(deps, "c1", "");
		expect(deps.wsHandler.setClientSession).not.toHaveBeenCalled();
		expect(deps.wsHandler.sendTo).not.toHaveBeenCalled();
	});

	it("sets client session in registry", async () => {
		const deps = createFullDeps();
		await switchClientToSession(deps, "c1", "ses_1");
		expect(deps.wsHandler.setClientSession).toHaveBeenCalledWith("c1", "ses_1");
	});

	it("sends session_switched with cache-hit events", async () => {
		const events: RelayMessage[] = [{ type: "user_message", text: "hi" }];
		const deps = createFullDeps({
			messageCache: { getEvents: vi.fn().mockReturnValue(events) },
		});
		await switchClientToSession(deps, "c1", "ses_1");
		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "session_switched",
		);
		expect(switchMsg).toBeDefined();
		// Session is idle and cache has only user_message (no LLM content started)
		// — no synthetic done needed since the last turn is not active.
		const sentEvents = (switchMsg?.[1] as { events?: RelayMessage[] }).events;
		expect(sentEvents).toEqual(events);
	});

	it("sends session_switched with REST history on cache miss", async () => {
		const history = {
			messages: [{ id: "m1", role: "user" as const }],
			hasMore: true,
		};
		const deps = createFullDeps({
			sessionMgr: {
				loadPreRenderedHistory: vi.fn().mockResolvedValue(history),
				seedPaginationCursor: vi.fn(),
			},
		});
		await switchClientToSession(deps, "c1", "ses_2");
		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "session_switched",
		);
		expect(switchMsg).toBeDefined();
		expect((switchMsg?.[1] as { history?: unknown }).history).toEqual({
			messages: history.messages,
			hasMore: true,
		});
	});

	it("sends session_switched with empty payload when REST fails", async () => {
		const deps = createFullDeps({
			sessionMgr: {
				loadPreRenderedHistory: vi.fn().mockRejectedValue(new Error("fail")),
				seedPaginationCursor: vi.fn(),
			},
		});
		await switchClientToSession(deps, "c1", "ses_3");
		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "session_switched",
		);
		expect(switchMsg).toBeDefined();
		const payload = switchMsg?.[1] as Record<string, unknown>;
		expect(payload["id"]).toBe("ses_3");
		expect(payload["events"]).toBeUndefined();
		expect(payload["history"]).toBeUndefined();
	});

	it("sends status message (idle) after session_switched", async () => {
		const deps = createFullDeps();
		await switchClientToSession(deps, "c1", "ses_1");
		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const statusMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "status",
		);
		expect(statusMsg).toBeDefined();
		expect((statusMsg?.[1] as { status: string }).status).toBe("idle");
	});

	it("sends status 'processing' when session is busy", async () => {
		const deps = createFullDeps({
			statusPoller: { isProcessing: vi.fn().mockReturnValue(true) },
		});
		await switchClientToSession(deps, "c1", "ses_1");
		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const statusMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "status",
		);
		expect((statusMsg?.[1] as { status: string }).status).toBe("processing");
	});

	it("defaults to idle when statusPoller is undefined", async () => {
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const { statusPoller, ...rest } = createFullDeps();
		const deps = rest as SessionSwitchDeps;
		await switchClientToSession(deps, "c1", "ses_1");
		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const statusMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "status",
		);
		expect((statusMsg?.[1] as { status: string }).status).toBe("idle");
	});

	it("includes inputText from draft", async () => {
		const deps = createFullDeps({
			getInputDraft: vi.fn().mockReturnValue("my draft"),
		});
		await switchClientToSession(deps, "c1", "ses_1");
		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "session_switched",
		);
		expect((switchMsg?.[1] as { inputText?: string }).inputText).toBe(
			"my draft",
		);
	});

	it("includes requestId when provided", async () => {
		const deps = createFullDeps();
		await switchClientToSession(deps, "c1", "ses_1", {
			requestId: "req-abc" as RequestId,
		});
		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "session_switched",
		);
		expect((switchMsg?.[1] as { requestId?: string }).requestId).toBe(
			"req-abc",
		);
	});

	it("skips history lookup when skipHistory is true", async () => {
		const deps = createFullDeps();
		await switchClientToSession(deps, "c1", "ses_1", { skipHistory: true });
		expect(deps.messageCache.getEvents).not.toHaveBeenCalled();
		expect(deps.sessionMgr.loadPreRenderedHistory).not.toHaveBeenCalled();
		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "session_switched",
		);
		expect(switchMsg).toBeDefined();
		const payload = switchMsg?.[1] as Record<string, unknown>;
		expect(payload["events"]).toBeUndefined();
		expect(payload["history"]).toBeUndefined();
	});

	it("starts poller when pollerManager is not polling", async () => {
		const deps = createFullDeps({
			pollerManager: {
				isPolling: vi.fn().mockReturnValue(false),
				startPolling: vi.fn(),
			},
		});
		await switchClientToSession(deps, "c1", "ses_1");
		expect(deps.pollerManager?.startPolling).toHaveBeenCalledWith("ses_1");
	});

	it("skips poller start when skipPollerSeed is true", async () => {
		const deps = createFullDeps({
			pollerManager: {
				isPolling: vi.fn().mockReturnValue(false),
				startPolling: vi.fn(),
			},
		});
		await switchClientToSession(deps, "c1", "ses_1", {
			skipPollerSeed: true,
		});
		expect(deps.pollerManager?.startPolling).not.toHaveBeenCalled();
	});

	it("skips poller start when pollerManager is undefined", async () => {
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const { pollerManager, ...rest } = createFullDeps();
		const deps = rest as SessionSwitchDeps;
		await switchClientToSession(deps, "c1", "ses_1");
	});

	// ─── Ordering and argument correctness ──────────────────────────────

	it("sends session_switched before status", async () => {
		const deps = createFullDeps();
		await switchClientToSession(deps, "c1", "ses_1");
		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchIdx = calls.findIndex(
			([, m]) => (m as { type: string }).type === "session_switched",
		);
		const statusIdx = calls.findIndex(
			([, m]) => (m as { type: string }).type === "status",
		);
		expect(switchIdx).toBeGreaterThanOrEqual(0);
		expect(statusIdx).toBeGreaterThanOrEqual(0);
		expect(switchIdx).toBeLessThan(statusIdx);
	});

	it("sets client session before sending any messages", async () => {
		const callOrder: string[] = [];
		const deps = createFullDeps({
			wsHandler: {
				setClientSession: vi.fn(() => callOrder.push("setClient")),
				sendTo: vi.fn(() => callOrder.push("sendTo")),
			},
		});
		await switchClientToSession(deps, "c1", "ses_1");
		expect(callOrder[0]).toBe("setClient");
		expect(callOrder.filter((c) => c === "sendTo").length).toBeGreaterThan(0);
	});

	it("calls getInputDraft with the target sessionId", async () => {
		const deps = createFullDeps();
		await switchClientToSession(deps, "c1", "ses_42");
		expect(deps.getInputDraft).toHaveBeenCalledWith("ses_42");
	});

	it("omits inputText when getInputDraft returns empty string", async () => {
		const deps = createFullDeps({
			getInputDraft: vi.fn().mockReturnValue(""),
		});
		await switchClientToSession(deps, "c1", "ses_1");
		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchMsg = calls.find(
			([, m]) => (m as { type: string }).type === "session_switched",
		);
		expect(switchMsg).toBeDefined();
		expect("inputText" in (switchMsg?.[1] ?? {})).toBe(false);
	});

	it("appends synthetic done to cached-events when session is idle and cache lacks done", async () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "hi" },
		];
		const deps = createFullDeps({
			messageCache: { getEvents: vi.fn().mockReturnValue(events) },
			statusPoller: { isProcessing: vi.fn().mockReturnValue(false) },
		});

		await switchClientToSession(deps, "c1", "ses_1");

		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "session_switched",
		);
		expect(switchMsg).toBeDefined();
		const payload = switchMsg?.[1] as { events?: RelayMessage[] };
		// Last event should be synthetic done
		const lastEvent = payload.events?.[payload.events.length - 1];
		expect(lastEvent).toEqual({ type: "done", code: 0 });
	});

	it("does NOT append done when session is processing", async () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "thinking..." },
		];
		const deps = createFullDeps({
			messageCache: { getEvents: vi.fn().mockReturnValue(events) },
			statusPoller: { isProcessing: vi.fn().mockReturnValue(true) },
		});

		await switchClientToSession(deps, "c1", "ses_1");

		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "session_switched",
		);
		const payload = switchMsg?.[1] as { events?: RelayMessage[] };
		const doneEvents = payload.events?.filter((e) => e.type === "done") ?? [];
		expect(doneEvents).toHaveLength(0);
	});

	it("does NOT append done when last turn already ended with done", async () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "hi" },
			{ type: "done", code: 0 },
		];
		const deps = createFullDeps({
			messageCache: { getEvents: vi.fn().mockReturnValue(events) },
			statusPoller: { isProcessing: vi.fn().mockReturnValue(false) },
		});

		await switchClientToSession(deps, "c1", "ses_1");

		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "session_switched",
		);
		const payload = switchMsg?.[1] as { events?: RelayMessage[] };
		const doneEvents = payload.events?.filter((e) => e.type === "done") ?? [];
		expect(doneEvents).toHaveLength(1); // Original only, no duplicate
	});

	it("appends synthetic done when earlier turn has done but last turn is active", async () => {
		// This is the key bug fix: cache has done from turn 1, but turn 2
		// ends mid-stream. patchMissingDone must use per-turn tracking.
		const events: RelayMessage[] = [
			{ type: "user_message", text: "q1" },
			{ type: "delta", text: "a1" },
			{ type: "done", code: 0 },
			{ type: "user_message", text: "q2" },
			{ type: "delta", text: "a2 partial..." },
		];
		const deps = createFullDeps({
			messageCache: { getEvents: vi.fn().mockReturnValue(events) },
			statusPoller: { isProcessing: vi.fn().mockReturnValue(false) },
		});

		await switchClientToSession(deps, "c1", "ses_1");

		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "session_switched",
		);
		const payload = switchMsg?.[1] as { events?: RelayMessage[] };
		const lastEvent = payload.events?.[payload.events.length - 1];
		expect(lastEvent).toEqual({ type: "done", code: 0 });
		const doneEvents = payload.events?.filter((e) => e.type === "done") ?? [];
		expect(doneEvents).toHaveLength(2); // Original turn 1 done + synthetic turn 2 done
	});

	it("appends synthetic done when statusPoller is undefined (assumes idle)", async () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "hi" },
		];
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const { statusPoller, ...rest } = createFullDeps({
			messageCache: { getEvents: vi.fn().mockReturnValue(events) },
		});
		const deps = rest as SessionSwitchDeps;

		await switchClientToSession(deps, "c1", "ses_1");

		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "session_switched",
		);
		const payload = switchMsg?.[1] as { events?: RelayMessage[] };
		const lastEvent = payload.events?.[payload.events.length - 1];
		expect(lastEvent).toEqual({ type: "done", code: 0 });
	});
});

describe("resolveSessionHistory — repaired cold cache regression", () => {
	it("serves repaired cache with complete turns and trailing user_message", async () => {
		// After repair: 2 complete turns + 1 user_message (incomplete turn removed).
		// Cache has chat content → served directly. Users can paginate for older messages.
		const repairedEvents: RelayMessage[] = [
			{ type: "user_message", text: "q1" },
			{ type: "delta", text: "a1", messageId: "msg_1" },
			{ type: "done", code: 0 },
			{ type: "user_message", text: "q2" },
			{ type: "delta", text: "a2", messageId: "msg_2" },
			{ type: "done", code: 0 },
			{ type: "user_message", text: "q3" },
			// repair removed: delta "partial-a3" with messageId "msg_3"
		];

		const deps = createMinimalDeps({
			messageCache: {
				getEvents: vi.fn().mockReturnValue(repairedEvents),
			},
		});

		const result = await resolveSessionHistory("ses_repaired", deps);

		// Cache has user_message + delta → classifyHistorySource → "cached-events"
		expect(result.kind).toBe("cached-events");
		if (result.kind === "cached-events") {
			expect(result.events).toEqual(repairedEvents);
		}
	});

	it("serves repaired cache even when only user_messages remain", async () => {
		// Scenario: all assistant turns were interrupted before any terminal event.
		// Repair keeps only user_messages — still valid chat content.
		const repairedEvents: RelayMessage[] = [
			{ type: "user_message", text: "q1" },
			// repair removed: delta "partial-a1" (no terminal ever arrived)
			{ type: "user_message", text: "q2" },
			// repair removed: delta "partial-a2"
		];

		const deps = createMinimalDeps({
			messageCache: {
				getEvents: vi.fn().mockReturnValue(repairedEvents),
			},
		});

		const result = await resolveSessionHistory("ses_user_only", deps);

		// user_message is chat content → cache is served
		expect(result.kind).toBe("cached-events");
		if (result.kind === "cached-events") {
			expect(result.events).toEqual(repairedEvents);
		}
	});

	it("falls back to REST when repair empties the cache entirely", async () => {
		// Scenario: session had only streaming events with no user_messages.
		// repairColdSessions removes the session from the Map → getEvents returns null.
		const deps = createMinimalDeps({
			messageCache: {
				getEvents: vi.fn().mockReturnValue(null),
			},
		});

		const result = await resolveSessionHistory("ses_empty", deps);

		// null cache → REST fallback
		expect(result.kind).toBe("rest-history");
	});
});

describe("resolveSessionHistory — stale cache tail detection", () => {
	it("falls through to REST when OpenCode updated session after cache's stored timestamp", async () => {
		// Cache stored session.time.updated=1000 (from previous conduit run).
		// Fresh sessionMgr says session.time.updated=2000.
		// The gap means events happened while conduit was down → cache is stale.
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "response" },
			{ type: "done", code: 0 },
		];
		const history = {
			messages: [
				{ id: "m1", role: "user" as const, parts: [] },
				{ id: "m2", role: "assistant" as const, parts: [] },
				{ id: "m3", role: "user" as const, parts: [] },
				{ id: "m4", role: "assistant" as const, parts: [] },
			],
			hasMore: false,
		};
		const deps = createMinimalDeps({
			messageCache: {
				getEvents: vi.fn().mockReturnValue(events),
				getOpenCodeUpdatedAt: vi.fn().mockReturnValue(1000),
			},
			sessionMgr: {
				loadPreRenderedHistory: vi.fn().mockResolvedValue(history),
				seedPaginationCursor: vi.fn(),
				getLastMessageAtMap: vi
					.fn()
					.mockReturnValue(new Map([["ses_stale", 2000]])),
			},
		});

		const result = await resolveSessionHistory("ses_stale", deps);

		expect(result.kind).toBe("rest-history");
		expect(deps.sessionMgr.loadPreRenderedHistory).toHaveBeenCalledWith(
			"ses_stale",
		);
	});

	it("serves cache when stored timestamp is newer than OpenCode (normal live operation)", async () => {
		// During live operation, setOpenCodeUpdatedAt is called as events arrive,
		// so the cache's timestamp may be equal to or ahead of the session list's.
		// This is the normal case — serve cache.
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "response" },
			{ type: "done", code: 0 },
		];
		const deps = createMinimalDeps({
			messageCache: {
				getEvents: vi.fn().mockReturnValue(events),
				getOpenCodeUpdatedAt: vi.fn().mockReturnValue(2000),
			},
			sessionMgr: {
				loadPreRenderedHistory: vi.fn(),
				seedPaginationCursor: vi.fn(),
				getLastMessageAtMap: vi
					.fn()
					.mockReturnValue(new Map([["ses_fresh", 1000]])),
			},
		});

		const result = await resolveSessionHistory("ses_fresh", deps);

		expect(result.kind).toBe("cached-events");
		expect(deps.sessionMgr.loadPreRenderedHistory).not.toHaveBeenCalled();
	});

	it("serves cache when stored timestamp matches current OpenCode timestamp", async () => {
		const events: RelayMessage[] = [{ type: "user_message", text: "hello" }];
		const deps = createMinimalDeps({
			messageCache: {
				getEvents: vi.fn().mockReturnValue(events),
				getOpenCodeUpdatedAt: vi.fn().mockReturnValue(1000),
			},
			sessionMgr: {
				loadPreRenderedHistory: vi.fn(),
				seedPaginationCursor: vi.fn(),
				getLastMessageAtMap: vi
					.fn()
					.mockReturnValue(new Map([["ses_exact", 1000]])),
			},
		});

		const result = await resolveSessionHistory("ses_exact", deps);

		expect(result.kind).toBe("cached-events");
	});

	it("falls through to REST when no stored timestamp exists (bootstrap)", async () => {
		// First run with this feature — no stored openCodeUpdatedAt.
		// One-time REST validation to establish the baseline.
		const events: RelayMessage[] = [{ type: "user_message", text: "hello" }];
		const history = {
			messages: [{ id: "m1", role: "user" as const, parts: [] }],
			hasMore: false,
		};
		const deps = createMinimalDeps({
			messageCache: {
				getEvents: vi.fn().mockReturnValue(events),
				getOpenCodeUpdatedAt: vi.fn().mockReturnValue(undefined),
				setOpenCodeUpdatedAt: vi.fn(),
			},
			sessionMgr: {
				loadPreRenderedHistory: vi.fn().mockResolvedValue(history),
				seedPaginationCursor: vi.fn(),
				getLastMessageAtMap: vi
					.fn()
					.mockReturnValue(new Map([["ses_bootstrap", 2000]])),
			},
		});

		const result = await resolveSessionHistory("ses_bootstrap", deps);

		expect(result.kind).toBe("rest-history");
		expect(deps.sessionMgr.loadPreRenderedHistory).toHaveBeenCalledWith(
			"ses_bootstrap",
		);
	});

	it("serves cache when getLastMessageAtMap is not available", async () => {
		const events: RelayMessage[] = [{ type: "user_message", text: "hello" }];
		const deps = createMinimalDeps({
			messageCache: {
				getEvents: vi.fn().mockReturnValue(events),
				getOpenCodeUpdatedAt: vi.fn().mockReturnValue(1000),
			},
			sessionMgr: {
				loadPreRenderedHistory: vi.fn(),
				seedPaginationCursor: vi.fn(),
				// No getLastMessageAtMap
			},
		});

		const result = await resolveSessionHistory("ses_no_map", deps);

		expect(result.kind).toBe("cached-events");
	});

	it("serves cache when session has no entry in lastMessageAtMap", async () => {
		const events: RelayMessage[] = [{ type: "user_message", text: "hello" }];
		const deps = createMinimalDeps({
			messageCache: {
				getEvents: vi.fn().mockReturnValue(events),
				getOpenCodeUpdatedAt: vi.fn().mockReturnValue(1000),
			},
			sessionMgr: {
				loadPreRenderedHistory: vi.fn(),
				seedPaginationCursor: vi.fn(),
				getLastMessageAtMap: vi.fn().mockReturnValue(
					new Map(), // Empty — no entry for this session
				),
			},
		});

		const result = await resolveSessionHistory("ses_unknown", deps);

		expect(result.kind).toBe("cached-events");
	});

	it("falls back to stale cache when REST fails for stale session", async () => {
		// Cache is stale but REST also fails — serve stale cache rather than nothing.
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "response" },
		];
		const deps = createMinimalDeps({
			messageCache: {
				getEvents: vi.fn().mockReturnValue(events),
				getOpenCodeUpdatedAt: vi.fn().mockReturnValue(1000),
			},
			sessionMgr: {
				loadPreRenderedHistory: vi
					.fn()
					.mockRejectedValue(new Error("API down")),
				seedPaginationCursor: vi.fn(),
				getLastMessageAtMap: vi
					.fn()
					.mockReturnValue(new Map([["ses_stale_fail", 2000]])),
			},
		});

		const result = await resolveSessionHistory("ses_stale_fail", deps);

		// Should fall back to stale cache, not empty
		expect(result.kind).toBe("cached-events");
		if (result.kind === "cached-events") {
			expect(result.events).toEqual(events);
		}
		expect(deps.log.warn).toHaveBeenCalled();
	});
});
