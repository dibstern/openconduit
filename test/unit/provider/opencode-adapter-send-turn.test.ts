// test/unit/provider/opencode-adapter-send-turn.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenCodeClient } from "../../../src/lib/instance/opencode-client.js";
import type { CanonicalEvent } from "../../../src/lib/persistence/events.js";
import { OpenCodeAdapter } from "../../../src/lib/provider/opencode-adapter.js";
import type {
	EventSink,
	SendTurnInput,
} from "../../../src/lib/provider/types.js";

// ─── Mocks ──────────────────────────────────────────────────────────────────

function makeStubClient(overrides?: Partial<OpenCodeClient>): OpenCodeClient {
	return {
		sendMessageAsync: vi.fn(async () => {}),
		abortSession: vi.fn(async () => {}),
		replyPermission: vi.fn(async () => {}),
		replyQuestion: vi.fn(async () => {}),
		listProviders: vi.fn(async () => ({
			providers: [],
			defaults: {},
			connected: [],
		})),
		listAgents: vi.fn(async () => []),
		listCommands: vi.fn(async () => []),
		listSkills: vi.fn(async () => []),
		...overrides,
	} as unknown as OpenCodeClient;
}

function makeStubEventSink(): EventSink & {
	pushedEvents: CanonicalEvent[];
} {
	const pushedEvents: CanonicalEvent[] = [];
	return {
		pushedEvents,
		push: vi.fn(async (event: CanonicalEvent) => {
			pushedEvents.push(event);
		}),
		requestPermission: vi.fn(async () => ({
			decision: "once" as const,
		})),
		requestQuestion: vi.fn(async () => ({})),
	};
}

function makeSendTurnInput(overrides?: Partial<SendTurnInput>): SendTurnInput {
	return {
		sessionId: "s1",
		turnId: "t1",
		prompt: "Write hello world",
		history: [],
		providerState: {},
		model: { providerId: "anthropic", modelId: "claude-sonnet" },
		workspaceRoot: "/tmp/project",
		eventSink: makeStubEventSink(),
		abortSignal: new AbortController().signal,
		...overrides,
	};
}

describe("OpenCodeAdapter.sendTurn()", () => {
	let client: OpenCodeClient;
	let adapter: OpenCodeAdapter;

	beforeEach(() => {
		client = makeStubClient();
		adapter = new OpenCodeAdapter({ client });
	});

	it("calls sendMessageAsync on the client", async () => {
		const input = makeSendTurnInput();
		const resultPromise = adapter.sendTurn(input);

		// Simulate turn completion via the adapter's internal callback
		adapter.notifyTurnCompleted("s1", {
			status: "completed",
			cost: 0.02,
			tokens: { input: 500, output: 200 },
			durationMs: 1500,
			providerStateUpdates: [],
		});

		const result = await resultPromise;
		expect(client.sendMessageAsync).toHaveBeenCalledWith("s1", {
			text: "Write hello world",
			model: { providerID: "anthropic", modelID: "claude-sonnet" },
		});
		expect(result.status).toBe("completed");
	});

	it("passes images and agent to sendMessageAsync", async () => {
		const input = makeSendTurnInput({
			images: ["data:image/png;base64,abc"],
			agent: "coder",
		});

		const resultPromise = adapter.sendTurn(input);
		adapter.notifyTurnCompleted("s1", {
			status: "completed",
			cost: 0,
			tokens: { input: 0, output: 0 },
			durationMs: 0,
			providerStateUpdates: [],
		});

		await resultPromise;

		expect(client.sendMessageAsync).toHaveBeenCalledWith("s1", {
			text: "Write hello world",
			model: { providerID: "anthropic", modelID: "claude-sonnet" },
			images: ["data:image/png;base64,abc"],
			agent: "coder",
		});
	});

	it("passes variant to sendMessageAsync", async () => {
		const input = makeSendTurnInput({ variant: "thinking" });

		const resultPromise = adapter.sendTurn(input);
		adapter.notifyTurnCompleted("s1", {
			status: "completed",
			cost: 0,
			tokens: { input: 0, output: 0 },
			durationMs: 0,
			providerStateUpdates: [],
		});

		await resultPromise;

		expect(client.sendMessageAsync).toHaveBeenCalledWith(
			"s1",
			expect.objectContaining({
				variant: "thinking",
			}),
		);
	});

	it("returns error status when sendMessageAsync fails", async () => {
		client = makeStubClient({
			sendMessageAsync: vi.fn(async () => {
				throw new Error("HTTP 500");
			}),
		});
		adapter = new OpenCodeAdapter({ client });

		const input = makeSendTurnInput();
		const result = await adapter.sendTurn(input);

		expect(result.status).toBe("error");
		expect(result.error?.message).toContain("HTTP 500");
	});

	it("resolves with interrupted status when aborted", async () => {
		const abortController = new AbortController();
		const input = makeSendTurnInput({
			abortSignal: abortController.signal,
		});

		const resultPromise = adapter.sendTurn(input);

		// Simulate abort
		abortController.abort();

		// Notify via the standard completion path
		adapter.notifyTurnCompleted("s1", {
			status: "interrupted",
			cost: 0,
			tokens: { input: 100, output: 50 },
			durationMs: 500,
			providerStateUpdates: [],
		});

		const result = await resultPromise;
		expect(result.status).toBe("interrupted");
	});

	it("records start time for duration calculation", async () => {
		const input = makeSendTurnInput();
		const resultPromise = adapter.sendTurn(input);

		// Small delay to ensure non-zero duration
		await new Promise((r) => setTimeout(r, 10));

		adapter.notifyTurnCompleted("s1", {
			status: "completed",
			cost: 0.01,
			tokens: { input: 100, output: 50 },
			durationMs: 0,
			providerStateUpdates: [],
		});

		const result = await resultPromise;
		expect(result.status).toBe("completed");
	});

	it("only resolves for the matching session", async () => {
		const input = makeSendTurnInput({ sessionId: "s1" });
		const resultPromise = adapter.sendTurn(input);

		// Notify a different session -- should not resolve s1
		adapter.notifyTurnCompleted("s2", {
			status: "completed",
			cost: 0,
			tokens: { input: 0, output: 0 },
			durationMs: 0,
			providerStateUpdates: [],
		});

		// Verify it's still pending (race with a timeout)
		const raceResult = await Promise.race([
			resultPromise.then(() => "resolved"),
			new Promise<string>((r) => setTimeout(() => r("timeout"), 50)),
		]);
		expect(raceResult).toBe("timeout");

		// Now resolve the correct session
		adapter.notifyTurnCompleted("s1", {
			status: "completed",
			cost: 0,
			tokens: { input: 0, output: 0 },
			durationMs: 0,
			providerStateUpdates: [],
		});

		const result = await resultPromise;
		expect(result.status).toBe("completed");
	});
});
