import { describe, expect, it } from "vitest";
import {
	isLastTurnActive,
	LLM_CONTENT_START_TYPES,
} from "../../src/lib/event-classify.js";
import type { RelayMessage } from "../../src/lib/types.js";

describe("LLM_CONTENT_START_TYPES", () => {
	it("contains delta, thinking_start, and tool_start", () => {
		expect(LLM_CONTENT_START_TYPES.has("delta")).toBe(true);
		expect(LLM_CONTENT_START_TYPES.has("thinking_start")).toBe(true);
		expect(LLM_CONTENT_START_TYPES.has("tool_start")).toBe(true);
	});

	it("does not contain non-start types", () => {
		expect(LLM_CONTENT_START_TYPES.has("done")).toBe(false);
		expect(LLM_CONTENT_START_TYPES.has("result")).toBe(false);
		expect(LLM_CONTENT_START_TYPES.has("error")).toBe(false);
		expect(LLM_CONTENT_START_TYPES.has("user_message")).toBe(false);
		expect(LLM_CONTENT_START_TYPES.has("thinking_delta")).toBe(false);
		expect(LLM_CONTENT_START_TYPES.has("thinking_stop")).toBe(false);
		expect(LLM_CONTENT_START_TYPES.has("tool_result")).toBe(false);
		expect(LLM_CONTENT_START_TYPES.has("tool_executing")).toBe(false);
	});
});

describe("isLastTurnActive", () => {
	it("returns false for empty events", () => {
		expect(isLastTurnActive([])).toBe(false);
	});

	it("returns false for only user_message events", () => {
		const events: RelayMessage[] = [{ type: "user_message", text: "hello" }];
		expect(isLastTurnActive(events)).toBe(false);
	});

	it("returns true when last turn has delta but no done", () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "response" },
		];
		expect(isLastTurnActive(events)).toBe(true);
	});

	it("returns false when last turn ends with done", () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "response" },
			{ type: "done", code: 0 },
		];
		expect(isLastTurnActive(events)).toBe(false);
	});

	it("returns true when earlier turn has done but last turn has delta without done", () => {
		// THIS IS THE BUG CASE: patchMissingDone previously saw the old done
		// and bailed out, leaving the last turn without a done.
		const events: RelayMessage[] = [
			{ type: "user_message", text: "q1" },
			{ type: "delta", text: "a1" },
			{ type: "done", code: 0 },
			{ type: "user_message", text: "q2" },
			{ type: "delta", text: "a2 partial..." },
		];
		expect(isLastTurnActive(events)).toBe(true);
	});

	it("returns true when earlier turn has done but last turn has tool_start without done", () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "q1" },
			{ type: "delta", text: "a1" },
			{ type: "done", code: 0 },
			{ type: "user_message", text: "q2" },
			{ type: "tool_start", id: "t1", name: "bash" },
			{ type: "tool_executing", id: "t1", name: "bash", input: undefined },
			{ type: "tool_result", id: "t1", content: "ok", is_error: false },
		];
		expect(isLastTurnActive(events)).toBe(true);
	});

	it("returns false when non-retry error ends the turn", () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "partial" },
			{ type: "error", code: "STREAM_ERR", message: "fail" },
		];
		expect(isLastTurnActive(events)).toBe(false);
	});

	it("returns true when RETRY error does NOT end the turn", () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "partial" },
			{ type: "error", code: "RETRY", message: "retrying..." },
		];
		expect(isLastTurnActive(events)).toBe(true);
	});

	it("returns true when thinking_start without done", () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "think about this" },
			{ type: "thinking_start" },
			{ type: "thinking_delta", text: "hmm..." },
		];
		expect(isLastTurnActive(events)).toBe(true);
	});

	it("returns false when thinking completes with done", () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "think about this" },
			{ type: "thinking_start" },
			{ type: "thinking_delta", text: "hmm..." },
			{ type: "thinking_stop" },
			{ type: "delta", text: "here's my answer" },
			{ type: "done", code: 0 },
		];
		expect(isLastTurnActive(events)).toBe(false);
	});

	it("result event does NOT clear active state", () => {
		// result carries usage/cost metadata and can appear mid-turn.
		// This is the actual cache state from the bug report:
		// cache ends with result but no done.
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "response" },
			{
				type: "result",
				usage: { input: 10, output: 20, cache_read: 0, cache_creation: 0 },
				cost: 0.01,
				duration: 1000,
				sessionId: "s1",
			},
		];
		expect(isLastTurnActive(events)).toBe(true);
	});

	it("handles multi-turn with result events mid-turn (real bug scenario)", () => {
		// Simulates the actual bug: multiple turns, cache ends with results
		// after tool calls but no done.
		const events: RelayMessage[] = [
			// Turn 1 (complete)
			{ type: "user_message", text: "q1" },
			{ type: "delta", text: "a1" },
			{ type: "done", code: 0 },
			// Turn 2 (complete)
			{ type: "user_message", text: "q2" },
			{ type: "delta", text: "a2" },
			{ type: "done", code: 0 },
			// Turn 3 (incomplete — what the real cache looked like)
			{ type: "user_message", text: "q3" },
			{ type: "tool_start", id: "t1", name: "bash" },
			{ type: "tool_executing", id: "t1", name: "bash", input: undefined },
			{ type: "tool_result", id: "t1", content: "ok", is_error: false },
			{
				type: "result",
				usage: { input: 10, output: 20, cache_read: 0, cache_creation: 0 },
				cost: 0.01,
				duration: 1000,
				sessionId: "s1",
			},
			{
				type: "result",
				usage: { input: 10, output: 20, cache_read: 0, cache_creation: 0 },
				cost: 0.01,
				duration: 1000,
				sessionId: "s1",
			},
		];
		expect(isLastTurnActive(events)).toBe(true);
	});

	it("handles cache starting mid-stream (SSE connected late)", () => {
		// Cache doesn't start with user_message — SSE connected mid-conversation
		const events: RelayMessage[] = [
			{ type: "thinking_delta", text: "..." },
			{ type: "thinking_delta", text: "..." },
			{ type: "thinking_stop" },
			{ type: "delta", text: "answer" },
			{ type: "done", code: 0 },
			{ type: "user_message", text: "next question" },
			{ type: "delta", text: "partial..." },
		];
		expect(isLastTurnActive(events)).toBe(true);
	});
});
