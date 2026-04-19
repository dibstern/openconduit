import { describe, expect, it } from "vitest";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import {
	createRelayEventSink,
	type RelayEventSinkDeps,
} from "../../../src/lib/provider/relay-event-sink.js";
import type { RelayMessage } from "../../../src/lib/types.js";

const SESSION_ID = "ses-snap-1";

function createCaptureSink(overrides?: Partial<RelayEventSinkDeps>) {
	const sent: RelayMessage[] = [];
	const sink = createRelayEventSink({
		sessionId: SESSION_ID,
		send: (msg) => sent.push(msg),
		...overrides,
	});
	return { sink, sent };
}

describe("Event translation snapshots — thinking lifecycle", () => {
	it("thinking.start → thinking_start RelayMessage", async () => {
		const { sink, sent } = createCaptureSink();
		await sink.push(
			canonicalEvent("thinking.start", SESSION_ID, {
				messageId: "msg-1",
				partId: "part-1",
			}),
		);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toEqual({
			type: "thinking_start",
			messageId: "msg-1",
		});
	});

	it("thinking.delta → thinking_delta RelayMessage", async () => {
		const { sink, sent } = createCaptureSink();
		await sink.push(
			canonicalEvent("thinking.delta", SESSION_ID, {
				messageId: "msg-1",
				partId: "part-1",
				text: "reasoning text",
			}),
		);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toEqual({
			type: "thinking_delta",
			text: "reasoning text",
			messageId: "msg-1",
		});
	});

	it("thinking.end → thinking_stop RelayMessage", async () => {
		const { sink, sent } = createCaptureSink();
		await sink.push(
			canonicalEvent("thinking.end", SESSION_ID, {
				messageId: "msg-1",
				partId: "part-1",
			}),
		);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toEqual({
			type: "thinking_stop",
			messageId: "msg-1",
		});
	});

	it("full thinking lifecycle → correct RelayMessage sequence", async () => {
		const { sink, sent } = createCaptureSink();

		await sink.push(
			canonicalEvent("thinking.start", SESSION_ID, {
				messageId: "msg-1",
				partId: "part-1",
			}),
		);
		await sink.push(
			canonicalEvent("thinking.delta", SESSION_ID, {
				messageId: "msg-1",
				partId: "part-1",
				text: "deep thought",
			}),
		);
		await sink.push(
			canonicalEvent("thinking.end", SESSION_ID, {
				messageId: "msg-1",
				partId: "part-1",
			}),
		);

		const types = sent.map((m) => m.type);
		expect(types).toEqual([
			"thinking_start",
			"thinking_delta",
			"thinking_stop",
		]);
	});

	it("message.created produces no relay messages", async () => {
		const { sink, sent } = createCaptureSink();
		await sink.push(
			canonicalEvent("message.created", SESSION_ID, {
				messageId: "msg-1",
				role: "assistant",
				sessionId: SESSION_ID,
			}),
		);
		expect(sent).toHaveLength(0);
	});
});

describe("RelayEventSink lifecycle", () => {
	it("pending permission cleaned up after resolution via bridge", async () => {
		let trackedId: string | undefined;
		let repliedId: string | undefined;

		const { sink } = createCaptureSink({
			permissionBridge: {
				trackPending(entry) {
					trackedId = entry.requestId;
				},
				onPermissionReplied(requestId) {
					repliedId = requestId;
					return true;
				},
			},
		});

		// Request permission — creates pending deferred + bridge entry
		const permissionPromise = sink.requestPermission({
			requestId: "perm-1",
			sessionId: SESSION_ID,
			toolName: "bash",
			toolInput: { command: "echo test" },
			turnId: "turn-1",
			providerItemId: "item-1",
			always: [],
		});

		expect(trackedId).toBe("perm-1");

		// Resolve it
		sink.resolvePermission("perm-1", { decision: "reject" });

		const result = await permissionPromise;
		expect(result.decision).toBe("reject");
		expect(repliedId).toBe("perm-1");
	});

	it("DESIGN GAP: no explicit teardown — unresolved permissions leak", () => {
		// Documents that RelayEventSink has no dispose/cleanup method.
		// Pending promises hang forever if the sink is GC'd without resolution.
		// When a teardown method is added, replace this with a real test.
		const { sink } = createCaptureSink();

		// Verify no dispose method exists
		expect("dispose" in sink).toBe(false);
		expect("close" in sink).toBe(false);
		expect("destroy" in sink).toBe(false);
	});
});
