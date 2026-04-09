// test/unit/provider/opencode-adapter-actions.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenCodeClient } from "../../../src/lib/instance/opencode-client.js";
import { OpenCodeAdapter } from "../../../src/lib/provider/opencode-adapter.js";

function makeStubClient(overrides?: Partial<OpenCodeClient>): OpenCodeClient {
	return {
		abortSession: vi.fn(async () => {}),
		replyPermission: vi.fn(async () => {}),
		replyQuestion: vi.fn(async () => {}),
		sendMessageAsync: vi.fn(async () => {}),
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

describe("OpenCodeAdapter action methods", () => {
	let client: OpenCodeClient;
	let adapter: OpenCodeAdapter;

	beforeEach(() => {
		client = makeStubClient();
		adapter = new OpenCodeAdapter({ client });
	});

	describe("interruptTurn", () => {
		it("calls client.abortSession with the session ID", async () => {
			await adapter.interruptTurn("session-123");

			expect(client.abortSession).toHaveBeenCalledWith("session-123");
		});

		it("propagates errors from client", async () => {
			client = makeStubClient({
				abortSession: vi.fn(async () => {
					throw new Error("session not found");
				}),
			});
			adapter = new OpenCodeAdapter({ client });

			await expect(adapter.interruptTurn("bad-session")).rejects.toThrow(
				"session not found",
			);
		});
	});

	describe("resolvePermission", () => {
		it("calls client.replyPermission with id and decision", async () => {
			await adapter.resolvePermission("s1", "perm-1", "once");

			expect(client.replyPermission).toHaveBeenCalledWith({
				id: "perm-1",
				decision: "once",
			});
		});

		it("handles 'always' decision", async () => {
			await adapter.resolvePermission("s1", "perm-2", "always");

			expect(client.replyPermission).toHaveBeenCalledWith({
				id: "perm-2",
				decision: "always",
			});
		});

		it("handles 'reject' decision", async () => {
			await adapter.resolvePermission("s1", "perm-3", "reject");

			expect(client.replyPermission).toHaveBeenCalledWith({
				id: "perm-3",
				decision: "reject",
			});
		});

		it("propagates errors from client", async () => {
			client = makeStubClient({
				replyPermission: vi.fn(async () => {
					throw new Error("permission expired");
				}),
			});
			adapter = new OpenCodeAdapter({ client });

			await expect(
				adapter.resolvePermission("s1", "bad-perm", "once"),
			).rejects.toThrow("permission expired");
		});
	});

	describe("resolveQuestion", () => {
		it("calls client.replyQuestion with id and converted answers", async () => {
			await adapter.resolveQuestion("s1", "q1", {
				choice: "yes",
			});

			expect(client.replyQuestion).toHaveBeenCalledWith({
				id: "q1",
				answers: [["yes"]],
			});
		});

		it("converts array answers to string arrays", async () => {
			await adapter.resolveQuestion("s1", "q2", {
				multi: ["a", "b", "c"],
			});

			expect(client.replyQuestion).toHaveBeenCalledWith({
				id: "q2",
				answers: [["a", "b", "c"]],
			});
		});

		it("handles multiple answer fields", async () => {
			await adapter.resolveQuestion("s1", "q3", {
				field1: "value1",
				field2: ["x", "y"],
			});

			expect(client.replyQuestion).toHaveBeenCalledWith({
				id: "q3",
				answers: [["value1"], ["x", "y"]],
			});
		});

		it("propagates errors from client", async () => {
			client = makeStubClient({
				replyQuestion: vi.fn(async () => {
					throw new Error("question expired");
				}),
			});
			adapter = new OpenCodeAdapter({ client });

			await expect(
				adapter.resolveQuestion("s1", "bad-q", { answer: "yes" }),
			).rejects.toThrow("question expired");
		});
	});

	describe("shutdown", () => {
		it("resolves cleanly when no pending turns", async () => {
			await expect(adapter.shutdown()).resolves.not.toThrow();
		});

		it("rejects pending turns on shutdown", async () => {
			// Start a turn that won't be completed
			const turnPromise = adapter.sendTurn({
				sessionId: "s1",
				turnId: "t1",
				prompt: "hello",
				history: [],
				providerState: {},
				model: { providerId: "anthropic", modelId: "claude-sonnet" },
				workspaceRoot: "/tmp",
				eventSink: {
					push: vi.fn(),
					requestPermission: vi.fn(),
					requestQuestion: vi.fn(),
				},
				abortSignal: new AbortController().signal,
			});

			// Shutdown while turn is pending
			await adapter.shutdown();

			await expect(turnPromise).rejects.toThrow("shutdown");
		});
	});
});
