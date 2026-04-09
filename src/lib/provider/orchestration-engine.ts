// src/lib/provider/orchestration-engine.ts
// ─── Orchestration Engine ───────────────────────────────────────────────────
// Central command processor for the provider adapter layer (CQRS core loop).
// Routes commands to the correct adapter via ProviderRegistry.
// Manages session-to-provider mapping.

import { createLogger } from "../logger.js";
import type { ProviderRegistry } from "./provider-registry.js";
import type {
	AdapterCapabilities,
	PermissionDecision,
	SendTurnInput,
	TurnResult,
} from "./types.js";

const log = createLogger("orchestration-engine");

// ─── Command Types ──────────────────────────────────────────────────────────

export interface SendTurnCommand {
	readonly type: "send_turn";
	readonly commandId?: string;
	readonly providerId: string;
	readonly input: SendTurnInput;
}

export interface InterruptTurnCommand {
	readonly type: "interrupt_turn";
	readonly commandId?: string;
	readonly sessionId: string;
}

export interface ResolvePermissionCommand {
	readonly type: "resolve_permission";
	readonly commandId?: string;
	readonly sessionId: string;
	readonly requestId: string;
	readonly decision: PermissionDecision;
}

export interface ResolveQuestionCommand {
	readonly type: "resolve_question";
	readonly commandId?: string;
	readonly sessionId: string;
	readonly requestId: string;
	readonly answers: Record<string, unknown>;
}

export interface DiscoverCommand {
	readonly type: "discover";
	readonly commandId?: string;
	readonly providerId: string;
}

export type OrchestrationCommand =
	| SendTurnCommand
	| InterruptTurnCommand
	| ResolvePermissionCommand
	| ResolveQuestionCommand
	| DiscoverCommand;

// biome-ignore lint/suspicious/noConfusingVoidType: void is needed for Promise<void> overloads
export type OrchestrationResult = TurnResult | AdapterCapabilities | void;

// ─── Session Binding ────────────────────────────────────────────────────────

export interface SessionBinding {
	readonly sessionId: string;
	readonly providerId: string;
}

// ─── Engine Options ─────────────────────────────────────────────────────────

export interface OrchestrationEngineOptions {
	readonly registry: ProviderRegistry;
}

// ─── OrchestrationEngine ────────────────────────────────────────────────────

export class OrchestrationEngine {
	private readonly registry: ProviderRegistry;
	private readonly sessionBindings = new Map<string, string>();
	private readonly processedCommands = new Set<string>();

	constructor(options: OrchestrationEngineOptions) {
		this.registry = options.registry;
	}

	/**
	 * Dispatch a command to the appropriate provider adapter.
	 * Overloaded for typed results.
	 */
	async dispatch(command: SendTurnCommand): Promise<TurnResult>;
	async dispatch(command: DiscoverCommand): Promise<AdapterCapabilities>;
	async dispatch(command: InterruptTurnCommand): Promise<void>;
	async dispatch(command: ResolvePermissionCommand): Promise<void>;
	async dispatch(command: ResolveQuestionCommand): Promise<void>;
	async dispatch(command: OrchestrationCommand): Promise<OrchestrationResult> {
		// Idempotency check
		if (command.commandId) {
			if (this.processedCommands.has(command.commandId)) {
				throw new Error(`Duplicate command: ${command.commandId}`);
			}
		}

		let result: OrchestrationResult;

		switch (command.type) {
			case "send_turn":
				result = await this.handleSendTurn(command);
				break;
			case "interrupt_turn":
				result = await this.handleInterruptTurn(command);
				break;
			case "resolve_permission":
				result = await this.handleResolvePermission(command);
				break;
			case "resolve_question":
				result = await this.handleResolveQuestion(command);
				break;
			case "discover":
				result = await this.handleDiscover(command);
				break;
			default: {
				const _exhaustive: never = command;
				throw new Error(
					`Unknown command type: ${(_exhaustive as { type: string }).type}`,
				);
			}
		}

		// Record the command as processed (after successful execution)
		if (command.commandId) {
			this.processedCommands.add(command.commandId);
		}

		return result;
	}

	// ─── Command Handlers ─────────────────────────────────────────────────

	private async handleSendTurn(command: SendTurnCommand): Promise<TurnResult> {
		const adapter = this.registry.getAdapterOrThrow(command.providerId);

		// Record session-to-provider binding
		this.sessionBindings.set(command.input.sessionId, command.providerId);

		log.info(
			`Dispatching sendTurn: session=${command.input.sessionId} provider=${command.providerId}`,
		);

		return adapter.sendTurn(command.input);
	}

	private async handleInterruptTurn(
		command: InterruptTurnCommand,
	): Promise<void> {
		const providerId = this.getProviderForSessionOrThrow(command.sessionId);
		const adapter = this.registry.getAdapterOrThrow(providerId);

		log.info(`Dispatching interruptTurn: session=${command.sessionId}`);

		return adapter.interruptTurn(command.sessionId);
	}

	private async handleResolvePermission(
		command: ResolvePermissionCommand,
	): Promise<void> {
		const providerId = this.getProviderForSessionOrThrow(command.sessionId);
		const adapter = this.registry.getAdapterOrThrow(providerId);

		return adapter.resolvePermission(
			command.sessionId,
			command.requestId,
			command.decision,
		);
	}

	private async handleResolveQuestion(
		command: ResolveQuestionCommand,
	): Promise<void> {
		const providerId = this.getProviderForSessionOrThrow(command.sessionId);
		const adapter = this.registry.getAdapterOrThrow(providerId);

		return adapter.resolveQuestion(
			command.sessionId,
			command.requestId,
			command.answers,
		);
	}

	private async handleDiscover(
		command: DiscoverCommand,
	): Promise<AdapterCapabilities> {
		const adapter = this.registry.getAdapterOrThrow(command.providerId);
		return adapter.discover();
	}

	// ─── Session Binding Management ───────────────────────────────────────

	/** Bind a session to a provider. */
	bindSession(sessionId: string, providerId: string): void {
		this.sessionBindings.set(sessionId, providerId);
	}

	/** Unbind a session from its provider. */
	unbindSession(sessionId: string): void {
		this.sessionBindings.delete(sessionId);
	}

	/** Get the provider ID for a session, or undefined if not bound. */
	getProviderForSession(sessionId: string): string | undefined {
		return this.sessionBindings.get(sessionId);
	}

	/** List all bound sessions with their provider IDs. */
	listBoundSessions(): SessionBinding[] {
		return [...this.sessionBindings.entries()].map(
			([sessionId, providerId]) => ({ sessionId, providerId }),
		);
	}

	/** Shutdown the engine and all adapters. */
	async shutdown(): Promise<void> {
		log.info("OrchestrationEngine shutting down");
		await this.registry.shutdownAll();
		this.sessionBindings.clear();
		this.processedCommands.clear();
	}

	// ─── Internal ─────────────────────────────────────────────────────────

	private getProviderForSessionOrThrow(sessionId: string): string {
		const providerId = this.sessionBindings.get(sessionId);
		if (!providerId) {
			throw new Error(`No provider bound to session: ${sessionId}`);
		}
		return providerId;
	}
}
