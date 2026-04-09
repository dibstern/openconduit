// test/unit/provider/claude/provider-wiring.test.ts
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../../../../src/lib/provider/claude/claude-adapter.js";
import { OrchestrationEngine } from "../../../../src/lib/provider/orchestration-engine.js";
import { ProviderRegistry } from "../../../../src/lib/provider/provider-registry.js";

describe("Provider wiring with Claude adapter", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = join(tmpdir(), `conduit-wiring-test-${Date.now()}`);
		mkdirSync(workspace, { recursive: true });
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	it("registers Claude adapter in ProviderRegistry", () => {
		const registry = new ProviderRegistry();
		const adapter = new ClaudeAdapter({ workspaceRoot: workspace });

		registry.registerAdapter(adapter);

		expect(registry.hasAdapter("claude")).toBe(true);
		expect(registry.getAdapter("claude")).toBe(adapter);
	});

	it("lists both providers when both registered", () => {
		const registry = new ProviderRegistry();
		const claude = new ClaudeAdapter({ workspaceRoot: workspace });

		// Create a minimal mock for opencode adapter
		const opencode = {
			providerId: "opencode",
			discover: async () => ({
				models: [],
				supportsTools: true,
				supportsThinking: true,
				supportsPermissions: true,
				supportsQuestions: true,
				supportsAttachments: true,
				supportsFork: true,
				supportsRevert: true,
				commands: [],
			}),
			sendTurn: async () => {
				throw new Error("not implemented");
			},
			interruptTurn: async () => {},
			resolvePermission: async () => {},
			resolveQuestion: async () => {},
			shutdown: async () => {},
		};

		registry.registerAdapter(opencode);
		registry.registerAdapter(claude);

		const providers = registry.listProviders();
		expect(providers).toContain("opencode");
		expect(providers).toContain("claude");
		expect(providers).toHaveLength(2);
	});

	it("OrchestrationEngine dispatches discover to Claude adapter", async () => {
		const registry = new ProviderRegistry();
		const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
		registry.registerAdapter(adapter);

		const engine = new OrchestrationEngine({ registry });
		const caps = await engine.dispatch({
			type: "discover",
			providerId: "claude",
		});

		expect(caps.models.length).toBeGreaterThan(0);
		expect(caps.supportsTools).toBe(true);
		expect(caps.supportsFork).toBe(false);
	});

	it("OrchestrationEngine throws for unregistered provider", async () => {
		const registry = new ProviderRegistry();
		const engine = new OrchestrationEngine({ registry });

		await expect(
			engine.dispatch({ type: "discover", providerId: "nonexistent" }),
		).rejects.toThrow("No adapter registered");
	});

	it("shutdownAll shuts down Claude adapter", async () => {
		const registry = new ProviderRegistry();
		const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
		registry.registerAdapter(adapter);

		// Should not throw
		await registry.shutdownAll();
	});

	it("session binding tracks provider for session", () => {
		const registry = new ProviderRegistry();
		const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
		registry.registerAdapter(adapter);

		const engine = new OrchestrationEngine({ registry });
		engine.bindSession("sess-1", "claude");

		expect(engine.getProviderForSession("sess-1")).toBe("claude");
	});

	it("session binding can switch provider", () => {
		const registry = new ProviderRegistry();
		const engine = new OrchestrationEngine({ registry });

		engine.bindSession("sess-1", "opencode");
		expect(engine.getProviderForSession("sess-1")).toBe("opencode");

		engine.bindSession("sess-1", "claude");
		expect(engine.getProviderForSession("sess-1")).toBe("claude");
	});

	it("listBoundSessions includes claude-bound sessions", () => {
		const registry = new ProviderRegistry();
		const engine = new OrchestrationEngine({ registry });

		engine.bindSession("sess-1", "claude");
		engine.bindSession("sess-2", "opencode");

		const bindings = engine.listBoundSessions();
		expect(bindings).toHaveLength(2);
		expect(bindings.find((b) => b.sessionId === "sess-1")?.providerId).toBe(
			"claude",
		);
		expect(bindings.find((b) => b.sessionId === "sess-2")?.providerId).toBe(
			"opencode",
		);
	});
});
