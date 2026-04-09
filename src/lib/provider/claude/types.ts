// src/lib/provider/claude/types.ts
/**
 * Types used by the Claude Agent SDK adapter.
 *
 * The SDK's `query()` returns a long-lived session: you feed it an
 * AsyncIterable of user messages and read back an AsyncIterable of SDK
 * messages. One `query()` runs for the entire conduit session (not per turn).
 * sendTurn() enqueues into the prompt queue; a background consumer drains
 * the output stream and translates events for EventSink.
 *
 * NOTE: The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) is not yet
 * available as a published npm package. All SDK types are defined here as
 * structural stubs that match the expected SDK surface. When the SDK becomes
 * available, these can be replaced with re-exports from the real package.
 */
import type { PermissionDecision } from "../types.js";

// ─── SDK Type Stubs ────────────────────────────────────────────────────────
// These mirror the expected Claude Agent SDK types. When the real SDK is
// available, replace these with imports from "@anthropic-ai/claude-agent-sdk".

/**
 * Permission mode controls how the SDK handles tool permissions.
 */
export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions";

/**
 * The result returned from a canUseTool callback to the SDK.
 */
export interface PermissionResult {
	readonly behavior: "allow" | "deny";
	readonly updatedInput?: Record<string, unknown>;
	readonly message?: string;
}

/**
 * Signature of the SDK's canUseTool callback.
 */
export type CanUseTool = (
	toolName: string,
	toolInput: Record<string, unknown>,
	options: { signal: AbortSignal; toolUseID: string },
) => Promise<PermissionResult>;

/**
 * A user message fed into the SDK's query() prompt queue.
 */
export interface SDKUserMessage {
	readonly type: "user";
	readonly session_id: string;
	readonly parent_tool_use_id: string | null;
	readonly message: {
		readonly role: "user";
		readonly content: ReadonlyArray<
			| { readonly type: "text"; readonly text: string }
			| {
					readonly type: "image";
					readonly source: {
						readonly type: "base64";
						readonly media_type: string;
						readonly data: string;
					};
			  }
		>;
	};
}

/**
 * Base message type for all SDK messages.
 */
export interface SDKMessageBase {
	readonly type: string;
	readonly session_id?: string;
}

/**
 * System message from the SDK (init, status, task_progress, etc.).
 */
export interface SDKSystemMessage extends SDKMessageBase {
	readonly type: "system";
	readonly subtype: string;
	readonly session_id: string;
	readonly cwd?: string;
	readonly tools?: readonly string[];
	readonly model?: string;
	readonly usage?: {
		readonly input_tokens?: number;
		readonly output_tokens?: number;
		readonly cache_read_input_tokens?: number;
		readonly cache_creation_input_tokens?: number;
	};
	readonly status?: string;
}

/**
 * Stream event message wrapping Anthropic API streaming events.
 */
export interface SDKStreamEventMessage extends SDKMessageBase {
	readonly type: "stream_event";
	readonly session_id: string;
	readonly event: {
		readonly type: string;
		readonly index?: number;
		readonly content_block?: Record<string, unknown>;
		readonly delta?: Record<string, unknown>;
	};
}

/**
 * Assistant message snapshot from the SDK.
 */
export interface SDKAssistantMessage extends SDKMessageBase {
	readonly type: "assistant";
	readonly session_id: string;
	readonly uuid?: string;
	readonly message?: {
		readonly role: "assistant";
		readonly content: ReadonlyArray<Record<string, unknown>>;
	};
}

/**
 * User message containing tool results from the SDK.
 */
export interface SDKUserToolResultMessage extends SDKMessageBase {
	readonly type: "user";
	readonly session_id: string;
	readonly parent_tool_use_id: string | null;
	readonly message: {
		readonly role: "user";
		readonly content: ReadonlyArray<{
			readonly type: string;
			readonly tool_use_id?: string;
			readonly content?: string;
			readonly is_error?: boolean;
		}>;
	};
}

/**
 * Result message indicating turn completion.
 */
export interface SDKResultMessage extends SDKMessageBase {
	readonly type: "result";
	readonly subtype: "success" | "error_during_execution" | "error";
	readonly session_id: string;
	readonly is_error: boolean;
	readonly duration_ms?: number;
	readonly duration_api_ms?: number;
	readonly num_turns?: number;
	readonly result?: string;
	readonly total_cost_usd?: number;
	readonly errors?: readonly string[];
	readonly usage?: {
		readonly input_tokens?: number;
		readonly output_tokens?: number;
		readonly cache_read_input_tokens?: number;
		readonly cache_creation_input_tokens?: number;
	};
}

/**
 * Union of all SDK message types.
 */
export type SDKMessage =
	| SDKSystemMessage
	| SDKStreamEventMessage
	| SDKAssistantMessage
	| SDKUserToolResultMessage
	| SDKResultMessage;

// ─── Prompt Queue ──────────────────────────────────────────────────────────

/**
 * Items placed into the PromptQueue and consumed as an AsyncIterable by
 * the SDK's `query()`. "terminate" ends the iteration and shuts down the
 * SDK session cleanly.
 */
export type PromptQueueItem =
	| { readonly type: "message"; readonly message: SDKUserMessage }
	| { readonly type: "terminate" };

// ─── SDK Query Runtime ─────────────────────────────────────────────────────

/**
 * The runtime object returned by the SDK's `query()` call. It is both an
 * AsyncIterable of SDKMessages (the output stream) and exposes control
 * methods for interrupts, model switching, and clean shutdown.
 */
export interface ClaudeQueryRuntime extends AsyncIterable<SDKMessage> {
	readonly interrupt: () => Promise<void>;
	readonly setModel: (model?: string) => Promise<void>;
	readonly setPermissionMode: (mode: PermissionMode) => Promise<void>;
	readonly close: () => void;
}

// ─── Resume Cursor ─────────────────────────────────────────────────────────

/**
 * Stored in a session's `provider_state` under the `claude` namespace.
 * Written on every turn completion, read on session reopen to resume the
 * SDK session in place.
 */
export interface ClaudeResumeCursor {
	readonly resumeSessionId?: string;
	readonly lastAssistantUuid?: string;
	readonly turnCount: number;
}

// ─── Pending Approval / Question ───────────────────────────────────────────

/**
 * An in-flight `canUseTool` callback waiting for a user decision. The
 * permission bridge creates one, emits permission.asked via EventSink, and
 * blocks by awaiting the deferred until the UI calls resolvePermission().
 */
export interface PendingApproval {
	readonly requestId: string;
	readonly toolName: string;
	readonly toolInput: Record<string, unknown>;
	readonly createdAt: string;
	resolve(decision: PermissionDecision): void;
	reject(error: Error): void;
}

export interface PendingQuestion {
	readonly requestId: string;
	readonly createdAt: string;
	resolve(answers: Record<string, unknown>): void;
	reject(error: Error): void;
}

// ─── Tool In Flight ────────────────────────────────────────────────────────

/**
 * Tracks a tool_use content block while it streams so that tool.running
 * events can be emitted as input_json deltas arrive.
 */
export interface ToolInFlight {
	readonly itemId: string;
	readonly toolName: string;
	readonly title: string;
	input: Record<string, unknown>;
	partialInputJson: string;
	lastEmittedFingerprint?: string;
}

// ─── Session Context ───────────────────────────────────────────────────────

/**
 * All state for a single Claude session. Owned by ClaudeAdapter and keyed
 * by conduit sessionId. One instance per live SDK `query()`.
 */
export interface ClaudeSessionContext {
	readonly sessionId: string;
	readonly workspaceRoot: string;
	readonly startedAt: string;
	readonly promptQueue: PromptQueueController;
	readonly query: ClaudeQueryRuntime;
	readonly pendingApprovals: Map<string, PendingApproval>;
	readonly pendingQuestions: Map<string, PendingQuestion>;
	readonly inFlightTools: Map<number, ToolInFlight>;
	streamConsumer: Promise<void> | undefined;
	currentTurnId: string | undefined;
	currentModel: string | undefined;
	resumeSessionId: string | undefined;
	lastAssistantUuid: string | undefined;
	turnCount: number;
	stopped: boolean;
}

/**
 * Minimal interface the PromptQueue implementation must satisfy. Defined
 * here to decouple ClaudeSessionContext from the concrete class.
 */
export interface PromptQueueController extends AsyncIterable<SDKUserMessage> {
	enqueue(message: SDKUserMessage): void;
	close(): void;
}

// ─── Claude Adapter Config ─────────────────────────────────────────────────

/**
 * Configuration for the Claude adapter.
 */
export interface ClaudeAdapterConfig {
	readonly apiKey?: string;
	readonly model?: string;
	readonly maxTurns?: number;
	readonly workspaceRoot: string;
}
