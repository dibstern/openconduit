// test/e2e/provider/claude-adapter-real-sdk.test.ts
/**
 * E2E test for ClaudeAdapter.sendTurn() against the real Claude Agent SDK.
 *
 * This test makes a real API call to Anthropic's API with a real API key.
 * It is gated behind the RUN_EXPENSIVE_E2E=1 environment variable and is
 * NEVER included in `pnpm test` or `pnpm test:unit`. Run it explicitly:
 *
 *   RUN_EXPENSIVE_E2E=1 pnpm vitest run test/e2e/provider/
 *
 * Or via the convenience script:
 *
 *   pnpm test:e2e:expensive-real-prompts
 */
import { describe, expect, it } from "vitest";
import type { CanonicalEvent } from "../../../src/lib/persistence/events.js";
import { ClaudeAdapter } from "../../../src/lib/provider/claude/claude-adapter.js";
import type {
	EventSink,
	PermissionRequest,
	PermissionResponse,
	QuestionRequest,
} from "../../../src/lib/provider/types.js";

const RUN_EXPENSIVE = process.env["RUN_EXPENSIVE_E2E"] === "1";

// ─── Collecting EventSink ──────────────────────────────────────────────────

/**
 * A minimal EventSink that collects all pushed canonical events into an
 * array for inspection. Permission and question requests auto-approve
 * so the test doesn't block.
 */
function createCollectingEventSink(): EventSink & {
	readonly events: CanonicalEvent[];
} {
	const events: CanonicalEvent[] = [];
	return {
		events,
		async push(event: CanonicalEvent): Promise<void> {
			events.push(event);
		},
		async requestPermission(
			_request: PermissionRequest,
		): Promise<PermissionResponse> {
			// Auto-approve any permission requests during the E2E test
			return { decision: "once" };
		},
		async requestQuestion(
			_request: QuestionRequest,
		): Promise<Record<string, unknown>> {
			return {};
		},
	};
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe.skipIf(!RUN_EXPENSIVE)("ClaudeAdapter E2E (real SDK)", () => {
	it(
		"full turn with Haiku: sendTurn() resolves with completed TurnResult and emits canonical events",
		async () => {
			const adapter = new ClaudeAdapter({
				workspaceRoot: process.cwd(),
				// No queryFactory override — uses the real SDK
			});

			const sink = createCollectingEventSink();
			const abortController = new AbortController();

			const result = await adapter.sendTurn({
				sessionId: "e2e-real-sdk-test",
				turnId: "turn-1",
				prompt: "Reply with exactly: hello world",
				history: [],
				providerState: {},
				model: { providerId: "claude", modelId: "claude-haiku-3-5" },
				workspaceRoot: process.cwd(),
				eventSink: sink,
				abortSignal: abortController.signal,
			});

			// ── TurnResult assertions ──────────────────────────────────────
			expect(result.status).toBe("completed");
			expect(result.tokens.input).toBeGreaterThan(0);
			expect(result.tokens.output).toBeGreaterThan(0);
			expect(result.cost).toBeLessThan(0.01);

			// ── Canonical event assertions ──────────────────────────────────
			const eventTypes = sink.events.map((e) => e.type);

			// Must include at least one text.delta event
			expect(eventTypes).toContain("text.delta");

			// Must include a turn.completed event
			expect(eventTypes).toContain("turn.completed");

			// Clean up the adapter
			await adapter.shutdown();
		},
		{ timeout: 60_000 },
	);
});
