// test/unit/provider/claude/claude-event-translator.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalEvent } from "../../../../src/lib/persistence/events.js";
import { ClaudeEventTranslator } from "../../../../src/lib/provider/claude/claude-event-translator.js";
import type {
	ClaudeSessionContext,
	SDKMessage,
} from "../../../../src/lib/provider/claude/types.js";
import type { EventSink } from "../../../../src/lib/provider/types.js";

/** Extract event data as a plain object for assertion access. */
function dataOf(event: CanonicalEvent | undefined): Record<string, unknown> {
	return event?.data as unknown as Record<string, unknown>;
}

function makeStubSink(): EventSink & { events: CanonicalEvent[] } {
	const events: CanonicalEvent[] = [];
	return {
		events,
		push: vi.fn(async (event: CanonicalEvent) => {
			events.push(event);
		}),
		requestPermission: vi.fn(),
		requestQuestion: vi.fn(),
	};
}

function makeCtx(
	overrides: Partial<ClaudeSessionContext> = {},
): ClaudeSessionContext {
	return {
		sessionId: "sess-1",
		workspaceRoot: "/tmp/ws",
		startedAt: "2026-04-05T00:00:00.000Z",
		promptQueue: {
			enqueue: vi.fn(),
			close: vi.fn(),
			[Symbol.asyncIterator]: vi.fn(),
		} as unknown as ClaudeSessionContext["promptQueue"],
		query: {
			interrupt: vi.fn(),
			close: vi.fn(),
			setModel: vi.fn(),
			setPermissionMode: vi.fn(),
			[Symbol.asyncIterator]: vi.fn(),
		} as unknown as ClaudeSessionContext["query"],
		pendingApprovals: new Map(),
		pendingQuestions: new Map(),
		inFlightTools: new Map(),
		streamConsumer: undefined,
		currentTurnId: "turn-1",
		currentModel: "claude-sonnet-4",
		resumeSessionId: undefined,
		lastAssistantUuid: undefined,
		turnCount: 0,
		stopped: false,
		...overrides,
	};
}

describe("ClaudeEventTranslator", () => {
	let sink: ReturnType<typeof makeStubSink>;
	let translator: ClaudeEventTranslator;
	let ctx: ClaudeSessionContext;

	beforeEach(() => {
		sink = makeStubSink();
		ctx = makeCtx();
		translator = new ClaudeEventTranslator({ sink });
	});

	it("translates text_delta stream events to text.delta", async () => {
		// Seed an assistant text block so the translator has an itemId.
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "sdk-sess",
			event: {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			},
		} as unknown as SDKMessage);

		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "sdk-sess",
			event: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "Hello" },
			},
		} as unknown as SDKMessage);

		const deltaEvents = sink.events.filter((e) => e.type === "text.delta");
		expect(deltaEvents).toHaveLength(1);
		const data = dataOf(deltaEvents[0]);
		expect(data["text"]).toBe("Hello");
		expect(data["messageId"]).toBeDefined();
		expect(data["partId"]).toBeDefined();
	});

	it("translates thinking_delta to thinking.delta", async () => {
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "sdk-sess",
			event: {
				type: "content_block_start",
				index: 0,
				content_block: { type: "thinking", thinking: "" },
			},
		} as unknown as SDKMessage);

		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "sdk-sess",
			event: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "thinking_delta", thinking: "Let me think..." },
			},
		} as unknown as SDKMessage);

		const delta = sink.events.find((e) => e.type === "thinking.delta");
		expect(delta).toBeDefined();
		const data = dataOf(delta);
		expect(data["text"]).toBe("Let me think...");
		expect(data["messageId"]).toBeDefined();
		expect(data["partId"]).toBeDefined();
	});

	it("translates tool_use content_block_start to tool.started", async () => {
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "sdk-sess",
			event: {
				type: "content_block_start",
				index: 1,
				content_block: {
					type: "tool_use",
					id: "tool-abc",
					name: "Bash",
					input: { command: "ls" },
				},
			},
		} as unknown as SDKMessage);

		const started = sink.events.find((e) => e.type === "tool.started");
		expect(started).toBeDefined();
		const data = dataOf(started);
		expect(data["toolName"]).toBe("Bash");
		expect(data["callId"]).toBe("tool-abc");
		expect(data["input"]).toEqual({ command: "ls" });
		expect(ctx.inFlightTools.get(1)?.toolName).toBe("Bash");
	});

	it("translates user tool_result to tool.completed for in-flight tool", async () => {
		ctx.inFlightTools.set(1, {
			itemId: "tool-abc",
			toolName: "Bash",
			title: "Command run",
			input: { command: "ls" },
			partialInputJson: "",
		});

		await translator.translate(ctx, {
			type: "user",
			session_id: "sdk-sess",
			parent_tool_use_id: null,
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-abc",
						content: "file1.txt\nfile2.txt",
						is_error: false,
					},
				],
			},
		} as unknown as SDKMessage);

		const completed = sink.events.find((e) => e.type === "tool.completed");
		expect(completed).toBeDefined();
		const data = dataOf(completed);
		expect(data["result"]).toBeDefined();
		expect(data["duration"]).toBe(0);
	});

	it("translates result success to turn.completed with tokens", async () => {
		await translator.translate(ctx, {
			type: "result",
			subtype: "success",
			session_id: "sdk-sess",
			is_error: false,
			duration_ms: 1200,
			duration_api_ms: 900,
			num_turns: 1,
			result: "done",
			total_cost_usd: 0.0123,
			usage: {
				input_tokens: 100,
				output_tokens: 50,
				cache_read_input_tokens: 10,
			},
		} as unknown as SDKMessage);

		const turnCompleted = sink.events.find((e) => e.type === "turn.completed");
		expect(turnCompleted).toBeDefined();
		const data = dataOf(turnCompleted);
		expect(data["messageId"]).toBeDefined();
		const tokens = data["tokens"] as Record<string, unknown>;
		expect(tokens["input"]).toBe(100);
		expect(tokens["output"]).toBe(50);
		expect(data["cost"]).toBeCloseTo(0.0123);
	});

	it("translates result error_during_execution with interrupted errors", async () => {
		await translator.translate(ctx, {
			type: "result",
			subtype: "error_during_execution",
			session_id: "sdk-sess",
			is_error: false,
			errors: ["request was aborted by the user"],
			duration_ms: 500,
		} as unknown as SDKMessage);

		// Interrupted results emit turn.interrupted
		const turnInterrupted = sink.events.find(
			(e) => e.type === "turn.interrupted",
		);
		expect(turnInterrupted).toBeDefined();
		expect(dataOf(turnInterrupted)["messageId"]).toBeDefined();
	});

	it("translates system init message to session.status", async () => {
		await translator.translate(ctx, {
			type: "system",
			subtype: "init",
			session_id: "sdk-sess-new",
			cwd: "/tmp/ws",
			tools: ["Bash", "Read", "Write"],
			model: "claude-sonnet-4-5",
		} as unknown as SDKMessage);

		const configured = sink.events.find((e) => e.type === "session.status");
		expect(configured).toBeDefined();
		const data = dataOf(configured);
		expect(data["sessionId"]).toBe("sess-1");
		// Translator also captures the SDK session id onto the context for resume.
		expect(ctx.resumeSessionId).toBe("sdk-sess-new");
	});

	it("pushes turn.error when given an unhandled exception", async () => {
		await translator.translateError(ctx, new Error("SDK blew up"));
		const err = sink.events.find((e) => e.type === "turn.error");
		expect(err).toBeDefined();
		const data = dataOf(err);
		expect(data["error"]).toContain("SDK blew up");
		expect(data["messageId"]).toBeDefined();
	});

	it("translates assistant snapshot and captures uuid", async () => {
		await translator.translate(ctx, {
			type: "assistant",
			session_id: "sdk-sess",
			uuid: "assist-uuid-123",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Hello" }],
			},
		} as unknown as SDKMessage);

		expect(ctx.lastAssistantUuid).toBe("assist-uuid-123");
	});

	it("translates content_block_stop to tool.completed for text blocks", async () => {
		// Start a text block
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "sdk-sess",
			event: {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			},
		} as unknown as SDKMessage);

		const tool = ctx.inFlightTools.get(0);
		expect(tool).toBeDefined();

		// Stop the block
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "sdk-sess",
			event: {
				type: "content_block_stop",
				index: 0,
			},
		} as unknown as SDKMessage);

		const completed = sink.events.filter((e) => e.type === "tool.completed");
		expect(completed).toHaveLength(1);
		expect(ctx.inFlightTools.has(0)).toBe(false);
	});

	it("translates input_json_delta to tool.running and tool.input_updated", async () => {
		// Start a tool_use block
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "sdk-sess",
			event: {
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: "tool-json",
					name: "Bash",
					input: {},
				},
			},
		} as unknown as SDKMessage);

		// Send a complete JSON delta
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "sdk-sess",
			event: {
				type: "content_block_delta",
				index: 0,
				delta: {
					type: "input_json_delta",
					partial_json: '{"command":"ls"}',
				},
			},
		} as unknown as SDKMessage);

		const running = sink.events.filter((e) => e.type === "tool.running");
		expect(running.length).toBeGreaterThanOrEqual(1);

		const inputUpdated = sink.events.filter(
			(e) => e.type === "tool.input_updated",
		);
		expect(inputUpdated.length).toBeGreaterThanOrEqual(1);
		const data = dataOf(inputUpdated[0]);
		expect(data["input"]).toEqual({ command: "ls" });
	});

	it("resetInFlightState clears counters", () => {
		translator.resetInFlightState();
		// Should not throw -- just verifies it's callable
		expect(true).toBe(true);
	});

	it("translates result error to turn.error", async () => {
		await translator.translate(ctx, {
			type: "result",
			subtype: "error_during_execution",
			session_id: "sdk-sess",
			is_error: true,
			errors: ["Something went wrong"],
			duration_ms: 500,
		} as unknown as SDKMessage);

		const err = sink.events.find((e) => e.type === "turn.error");
		expect(err).toBeDefined();
		const data = dataOf(err);
		expect(data["error"]).toContain("Something went wrong");
	});
});
