// test/unit/provider/orchestration-engine.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	OrchestrationEngine,
	type SendTurnCommand,
} from "../../../src/lib/provider/orchestration-engine.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import type { ProviderAdapter } from "../../../src/lib/provider/types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeStubAdapter(providerId: string): ProviderAdapter & {
	sendTurn: ReturnType<typeof vi.fn>;
	interruptTurn: ReturnType<typeof vi.fn>;
	resolvePermission: ReturnType<typeof vi.fn>;
	resolveQuestion: ReturnType<typeof vi.fn>;
	discover: ReturnType<typeof vi.fn>;
	shutdown: ReturnType<typeof vi.fn>;
} {
	return {
		providerId,
		discover: vi.fn(async () => ({
			models: [],
			supportsTools: false,
			supportsThinking: false,
			supportsPermissions: false,
			supportsQuestions: false,
			supportsAttachments: false,
			supportsFork: false,
			supportsRevert: false,
			commands: [],
		})),
		sendTurn: vi.fn(async () => ({
			status: "completed" as const,
			cost: 0.01,
			tokens: { input: 100, output: 50 },
			durationMs: 500,
			providerStateUpdates: [],
		})),
		interruptTurn: vi.fn(async () => {}),
		resolvePermission: vi.fn(async () => {}),
		resolveQuestion: vi.fn(async () => {}),
		shutdown: vi.fn(async () => {}),
	};
}

function makeStubEventSink() {
	return {
		push: vi.fn(async () => {}),
		requestPermission: vi.fn(async () => ({
			decision: "once" as const,
		})),
		requestQuestion: vi.fn(async () => ({})),
	};
}

describe("OrchestrationEngine", () => {
	let registry: ProviderRegistry;
	let engine: OrchestrationEngine;
	let opencode: ReturnType<typeof makeStubAdapter>;

	beforeEach(() => {
		registry = new ProviderRegistry();
		opencode = makeStubAdapter("opencode");
		registry.registerAdapter(opencode);
		engine = new OrchestrationEngine({ registry });
	});

	describe("dispatch: send_turn", () => {
		it("routes sendTurn to the correct adapter", async () => {
			const result = await engine.dispatch({
				type: "send_turn",
				providerId: "opencode",
				input: {
					sessionId: "s1",
					turnId: "t1",
					prompt: "hello",
					history: [],
					providerState: {},
					model: {
						providerId: "anthropic",
						modelId: "claude-sonnet",
					},
					workspaceRoot: "/tmp",
					eventSink: makeStubEventSink(),
					abortSignal: new AbortController().signal,
				},
			});

			expect(opencode.sendTurn).toHaveBeenCalledTimes(1);
			expect(result).toMatchObject({ status: "completed" });
		});

		it("throws for unknown provider", async () => {
			await expect(
				engine.dispatch({
					type: "send_turn",
					providerId: "unknown",
					input: {
						sessionId: "s1",
						turnId: "t1",
						prompt: "hello",
						history: [],
						providerState: {},
						model: { providerId: "x", modelId: "y" },
						workspaceRoot: "/tmp",
						eventSink: makeStubEventSink(),
						abortSignal: new AbortController().signal,
					},
				}),
			).rejects.toThrow("No adapter registered for provider: unknown");
		});

		it("records session-to-provider binding", async () => {
			await engine.dispatch({
				type: "send_turn",
				providerId: "opencode",
				input: {
					sessionId: "s1",
					turnId: "t1",
					prompt: "hello",
					history: [],
					providerState: {},
					model: {
						providerId: "anthropic",
						modelId: "claude-sonnet",
					},
					workspaceRoot: "/tmp",
					eventSink: makeStubEventSink(),
					abortSignal: new AbortController().signal,
				},
			});

			expect(engine.getProviderForSession("s1")).toBe("opencode");
		});
	});

	describe("dispatch: interrupt_turn", () => {
		it("routes interrupt to the correct adapter", async () => {
			// Establish binding first
			engine.bindSession("s1", "opencode");

			await engine.dispatch({
				type: "interrupt_turn",
				sessionId: "s1",
			});

			expect(opencode.interruptTurn).toHaveBeenCalledWith("s1");
		});

		it("throws when session has no provider binding", async () => {
			await expect(
				engine.dispatch({
					type: "interrupt_turn",
					sessionId: "unknown-session",
				}),
			).rejects.toThrow("No provider bound to session: unknown-session");
		});
	});

	describe("dispatch: resolve_permission", () => {
		it("routes permission resolution to the correct adapter", async () => {
			engine.bindSession("s1", "opencode");

			await engine.dispatch({
				type: "resolve_permission",
				sessionId: "s1",
				requestId: "perm-1",
				decision: "always",
			});

			expect(opencode.resolvePermission).toHaveBeenCalledWith(
				"s1",
				"perm-1",
				"always",
			);
		});
	});

	describe("dispatch: resolve_question", () => {
		it("routes question resolution to the correct adapter", async () => {
			engine.bindSession("s1", "opencode");

			await engine.dispatch({
				type: "resolve_question",
				sessionId: "s1",
				requestId: "q1",
				answers: { choice: "yes" },
			});

			expect(opencode.resolveQuestion).toHaveBeenCalledWith("s1", "q1", {
				choice: "yes",
			});
		});
	});

	describe("dispatch: discover", () => {
		it("calls discover on the specified adapter", async () => {
			const result = await engine.dispatch({
				type: "discover",
				providerId: "opencode",
			});

			expect(opencode.discover).toHaveBeenCalledTimes(1);
			expect(result).toMatchObject({ models: [] });
		});
	});

	describe("session binding", () => {
		it("bindSession creates a session-to-provider mapping", () => {
			engine.bindSession("s1", "opencode");
			expect(engine.getProviderForSession("s1")).toBe("opencode");
		});

		it("unbindSession removes the mapping", () => {
			engine.bindSession("s1", "opencode");
			engine.unbindSession("s1");
			expect(engine.getProviderForSession("s1")).toBeUndefined();
		});

		it("getProviderForSession returns undefined for unbound session", () => {
			expect(engine.getProviderForSession("unknown")).toBeUndefined();
		});

		it("rebinding a session to a different provider updates the mapping", () => {
			const claude = makeStubAdapter("claude");
			registry.registerAdapter(claude);

			engine.bindSession("s1", "opencode");
			engine.bindSession("s1", "claude");
			expect(engine.getProviderForSession("s1")).toBe("claude");
		});

		it("listBoundSessions returns all bound sessions", () => {
			engine.bindSession("s1", "opencode");
			engine.bindSession("s2", "opencode");

			const sessions = engine.listBoundSessions();
			expect(sessions).toEqual(
				expect.arrayContaining([
					{ sessionId: "s1", providerId: "opencode" },
					{ sessionId: "s2", providerId: "opencode" },
				]),
			);
		});
	});

	describe("idempotency", () => {
		it("rejects duplicate command IDs", async () => {
			const command: SendTurnCommand = {
				type: "send_turn",
				commandId: "cmd-1",
				providerId: "opencode",
				input: {
					sessionId: "s1",
					turnId: "t1",
					prompt: "hello",
					history: [],
					providerState: {},
					model: {
						providerId: "anthropic",
						modelId: "claude-sonnet",
					},
					workspaceRoot: "/tmp",
					eventSink: makeStubEventSink(),
					abortSignal: new AbortController().signal,
				},
			};

			await engine.dispatch(command);

			// Second dispatch with same commandId should be rejected
			await expect(engine.dispatch(command)).rejects.toThrow(
				"Duplicate command: cmd-1",
			);
		});

		it("allows commands without commandId (no idempotency check)", async () => {
			const makeCommand = (): SendTurnCommand => ({
				type: "send_turn",
				providerId: "opencode",
				input: {
					sessionId: "s1",
					turnId: "t1",
					prompt: "hello",
					history: [],
					providerState: {},
					model: {
						providerId: "anthropic",
						modelId: "claude-sonnet",
					},
					workspaceRoot: "/tmp",
					eventSink: makeStubEventSink(),
					abortSignal: new AbortController().signal,
				},
			});

			await engine.dispatch(makeCommand());
			await engine.dispatch(makeCommand()); // Should not throw

			expect(opencode.sendTurn).toHaveBeenCalledTimes(2);
		});
	});

	describe("shutdown", () => {
		it("delegates to registry.shutdownAll", async () => {
			const shutdownSpy = vi.spyOn(registry, "shutdownAll");

			await engine.shutdown();

			expect(shutdownSpy).toHaveBeenCalledTimes(1);
		});
	});
});
