# Dual SDK Implementation Plan v2

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Refactor conduit to support both the OpenCode SDK and the Claude Agent SDK side-by-side, enabling Claude subscription account users to work through conduit via the Agent SDK while keeping OpenCode for all other providers.

**Architecture:** Four phases. Phase 1 migrates the hand-rolled client to `@opencode-ai/sdk`. Phase 2 extracts a `SessionBackend` interface from the session-centric methods. Phase 3 implements `ClaudeAgentBackend` using `@anthropic-ai/claude-agent-sdk`. Phase 4 wires model-level backend switching with BackendProxy into the relay and UI.

**Design doc:** `docs/plans/2026-03-31-dual-sdk-design.md`

**Reference impl:** `~/src/personal/opencode-relay/claude-relay/lib/sdk-bridge.js` (Clay)

**Tech Stack:** TypeScript, `@opencode-ai/sdk`, `@anthropic-ai/claude-agent-sdk`, Vitest

---

## Audit Amendments (v1 -> v2)

Key corrections incorporated from the 57-amendment audit:

1. **Permission return format**: `{ behavior: "allow" }` / `{ behavior: "deny", message }` — NOT `hookSpecificOutput`.
2. **AskUserQuestion**: Returns `{ behavior: "allow", updatedInput: { ...input, answers } }` — separate path from regular permissions.
3. **canUseTool signature**: 3 args — `(toolName, toolInput, options?)` where `options` has `signal?: AbortSignal`.
4. **Optional operations**: `forkSession`, `revertSession`, `unrevertSession` are optional on `SessionBackend`. Callers check before calling. Frontend hides buttons.
5. **BackendProxy pattern** (Phase 4): Components hold proxy reference. Swap updates proxy, all existing references see new backend. No component graph teardown.
6. **Message queue**: Async iterable prompt from Clay for multi-turn within a live `query()`. `pushMessage()` feeds messages into the queue.
7. **Session resume**: SDK-native `resume: cliSessionId` — never reconstruct history for same-backend turns.
8. **Cross-backend continuity**: Prepend history only on first message after backend switch.
9. **Provider-based routing**: Anthropic subscription -> Agent SDK, everything else -> OpenCode.
10. **Merged session list**: From all backends, tagged with `backendType`.
11. **Shutdown cleanup**: Reject all pending deferreds, abort active query, end message queue, close channel.
12. **No deferred timeout**: Permissions stay pending until explicitly resolved. Re-shown on reconnect.
13. **AsyncEventChannel**: Moved earlier (Task 2) — shared by both backends.

## Audit Amendments (v2 audit — 117 findings)

Synthesis: `docs/plans/2026-03-31-dual-sdk-v2-audit.md`
Individual reports: `docs/plans/audits/dual-sdk-v2-task-*.md`

### Cross-Cutting Directives (apply to ALL tasks)

**D1 — Phase 1 gating:** Every task's first step MUST be "Verify Phase 1 is complete: confirm `src/lib/instance/sdk-client.ts` and `src/lib/instance/relay-types.ts` exist. Run `pnpm check`." If Phase 1 is NOT complete, substitute `OpenCodeClient`/`opencode-client.ts` throughout.

**D2 — No `any` types:** All method parameters and returns must use actual types from `types.ts`/`relay-types.ts`. No `as any` casts in production code. `as unknown as T` in test mocks is acceptable. Type `activeQuery` as `import("@anthropic-ai/claude-agent-sdk").Query | null`. Use `SDKMessage` discriminated union for translator, not `Record<string, any>`.

**D3 — Import paths:** `Logger` from `"../logger.js"` (NOT `../logging.js`). `ServiceRegistry` from `"../daemon/service-registry.js"` (NOT `../relay/service-registry.js`). Static imports only — no dynamic `await import()` (no circular deps to break).

**D4 — AsyncEventChannel is single-consumer:** Add runtime guard in `next()`: if `this.resolver` is already set, throw `Error("AsyncEventChannel supports only one concurrent consumer")`. Document constraint with JSDoc. The `ClaudeAgentBackend`'s shared channel uses a per-subscriber wrapper pattern (see Task 9 amendments) — subscriber abort breaks iteration without closing the channel.

**D5 — MessageQueue wraps AsyncEventChannel:** Task 7's `MessageQueue` is a thin wrapper, NOT a copy-paste: `class MessageQueue { private ch = new AsyncEventChannel<SDKUserMessage>(); push(msg) { this.ch.push(msg); } end() { this.ch.close(); } ... }`.

**D6 — `undefined as any` elimination:** Replace all `value: undefined as any, done: true` with `value: undefined, done: true as const` in iterators. TS 5.x `IteratorResult<T>` discriminated union accepts this.

**D7 — Concurrent queries:** `ClaudeAgentBackend` supports concurrent per-session queries via `Map<sessionId, QueryState>` (NOT single `activeQuery`/`messageQueue` fields). Each session gets its own `QueryState { query, messageQueue, abortController, streamPromise, activeSessionId }`. See Task 9/10 amendments.

**D8 — `sessionID` not `sessionId`:** The existing `Message` type uses `sessionID` (capital ID). All translator output and helper functions must use `sessionID`.

### Design Decisions (from audit Ask User questions)

| Decision | Choice | Rationale |
|---|---|---|
| Channel consumers | Single-consumer with runtime guard | Matches relay-stack's single SSE consumer pattern |
| `getSSEConsumer()` | Keep on `OpenCodeBackend` | Accept coupling for simplicity. Relay-stack already knows concrete type. |
| PTY deps naming | Rename `client` to `infraClient` | Consistency |
| System/init events | Forward to frontend | Useful for model/tool display |
| SDK user messages | Drop | Relay tracks user messages via PendingUserMessages |
| Query concurrency | Per-session concurrent queries | Via `Map<sessionId, QueryState>` |
| Auth type detection | Server-side from env/config | Stored in `ProjectRelayConfig` |
| UI capability gating | Capabilities object | Server sends `{ fork, revert }` with session_list |
| Swap drain | Accept the race | Frontend refresh makes it non-issue |
| Poller wiring scope | OpenCode backend directly | Pollers are OpenCode-specific recovery |
| Task 12 factory | Remove, defer to Task 14 | Factory conflicts with BackendProxy pattern |
| Question rejection | Return `{ behavior: "deny" }` | Match Clay. Never throw from canUseTool. |
| Startup getConfig | Direct `client.getConfig()` | Backend not fully initialized at startup |

---

## Phase 1: OpenCode SDK Migration

Phase 1 is covered by the existing plan at `docs/plans/2026-03-12-sdk-migration-plan.md` (9 tasks, audited twice, ready for execution). That plan installs `@opencode-ai/sdk`, creates a composition-based `RelayClient` with the same 45-method flat API, swaps imports across 24 files, and deletes the hand-rolled `OpenCodeClient`.

**Execute that plan first.** The remainder of this plan assumes Phase 1 is complete and `RelayClient` (from `sdk-client.ts`) is the sole client class.

---

## Phase 2: Extract SessionBackend Interface

### Method Split

The 45 `RelayClient` methods split into two groups:

**SessionBackend (session-centric, swappable per model) — 26 methods:**
`getHealth`, `listSessions`, `getSession`, `createSession`, `deleteSession`, `updateSession`, `getSessionStatuses`, `getMessages`, `getMessage`, `getMessagesPage`, `sendMessageAsync`, `abortSession`, `listPendingPermissions`, `replyPermission`, `listPendingQuestions`, `replyQuestion`, `rejectQuestion`, `listAgents`, `listProviders`, `listCommands`, `listSkills`, `forkSession`*, `revertSession`*, `unrevertSession`*, `getConfig`, `updateConfig`

\* = optional on the interface (Claude Agent SDK has no equivalent)

**InfraClient (model-agnostic, always OpenCode) — 16 methods:**
`getPath`, `getVcs`, `getCurrentProject`, `listProjects`, `listDirectory`, `getFileContent`, `getFileStatus`, `findText`, `findFiles`, `findSymbols`, `createPty`, `deletePty`, `resizePty`, `listPtys`, `getBaseUrl`, `getAuthHeaders`

**Dropped (unused by relay) — 3 methods:**
`shareSession`, `summarizeSession`, `getSessionDiff`

### Handler Impact

| Handler file | Currently uses | After split |
|---|---|---|
| `session.ts` | `getSession`, `listPendingPermissions`, `listPendingQuestions`, `forkSession`, `getMessage`, `getMessagesPage` | `sessionBackend` only |
| `prompt.ts` | `sendMessageAsync`, `abortSession`, `revertSession` | `sessionBackend` only |
| `permissions.ts` | `replyPermission`, `getConfig`, `updateConfig`, `replyQuestion`, `listPendingQuestions`, `rejectQuestion` | `sessionBackend` only |
| `model.ts` | `listProviders`, `getSession`, `updateConfig` | `sessionBackend` only |
| `agent.ts` | `listAgents` | `sessionBackend` only |
| `settings.ts` | `listCommands`, `listProjects` | both (`listCommands` -> `sessionBackend`, `listProjects` -> `infraClient`) |
| `files.ts` | `getFileContent`, `listDirectory` | `infraClient` only |
| `terminal.ts` | `createPty`, `deletePty`, `listPtys`, `resizePty` | `infraClient` only |

---

### Task 1: Define SessionBackend Interface and InfraClient Type

**Files:**
- Create: `src/lib/backend/types.ts`
- Create: `src/lib/backend/types.test.ts`

**Step 1: Write the interface**

```typescript
// src/lib/backend/types.ts
import type {
    SessionDetail, SessionStatus, SessionCreateOptions, SessionListOptions,
    Message, PromptOptions, PermissionReplyOptions, QuestionReplyOptions,
    Agent, ProviderListResult, PtyCreateOptions, HealthResponse,
} from "../instance/relay-types.js";

/**
 * Session-centric operations that differ between backends.
 * OpenCode: wraps RelayClient REST calls + SSEConsumer.
 * Claude Agent SDK: wraps query() + async event channel.
 *
 * forkSession / revertSession / unrevertSession are OPTIONAL — the Claude
 * Agent SDK has no equivalent. Callers must check existence before calling.
 * Frontend hides the corresponding buttons when absent.
 */
export interface SessionBackend {
    readonly type: "opencode" | "claude-agent";

    // Lifecycle
    initialize(): Promise<void>;
    shutdown(): Promise<void>;
    getHealth(): Promise<HealthResponse>;

    // Sessions
    listSessions(options?: SessionListOptions): Promise<SessionDetail[]>;
    getSession(id: string): Promise<SessionDetail>;
    createSession(options?: SessionCreateOptions): Promise<SessionDetail>;
    deleteSession(id: string): Promise<void>;
    updateSession(id: string, updates: { title?: string; archived?: boolean }): Promise<SessionDetail>;
    getSessionStatuses(): Promise<Record<string, SessionStatus>>;

    // Messages
    getMessages(sessionId: string): Promise<Message[]>;
    getMessage(sessionId: string, messageId: string): Promise<Message>;
    getMessagesPage(sessionId: string, options?: { limit?: number; before?: string }): Promise<Message[]>;
    sendMessage(sessionId: string, prompt: PromptOptions): Promise<void>;
    abortSession(id: string): Promise<void>;

    // Permissions & Questions
    listPendingPermissions(): Promise<Array<{ id: string; [key: string]: unknown }>>;
    replyPermission(options: PermissionReplyOptions): Promise<void>;
    listPendingQuestions(): Promise<Array<{ id: string; [key: string]: unknown }>>;
    replyQuestion(options: QuestionReplyOptions): Promise<void>;
    rejectQuestion(id: string): Promise<void>;

    // Discovery
    listAgents(): Promise<Agent[]>;
    listProviders(): Promise<ProviderListResult>;
    listCommands(): Promise<Array<{ name: string; description?: string }>>;
    listSkills(): Promise<Array<{ name: string; description?: string }>>;
    getConfig(): Promise<Record<string, unknown>>;
    updateConfig(config: Record<string, unknown>): Promise<Record<string, unknown>>;

    // Session operations — OPTIONAL (not all backends support these)
    forkSession?(id: string, options: { messageID?: string; title?: string }): Promise<SessionDetail>;
    revertSession?(id: string, messageId: string): Promise<void>;
    unrevertSession?(id: string): Promise<void>;

    // Events
    subscribeEvents(signal: AbortSignal): AsyncIterable<BackendEvent>;
}

/**
 * Model-agnostic infrastructure operations — always OpenCode.
 * PTY, files, search, VCS, projects.
 */
export interface InfraClient {
    // Projects
    getPath(): Promise<{ cwd: string }>;
    getVcs(): Promise<{ branch?: string; dirty?: boolean }>;
    getCurrentProject(): Promise<{ id: string; name?: string; path?: string; worktree?: string }>;
    listProjects(): Promise<Array<{ id: string; name?: string; path?: string; worktree?: string }>>;

    // Files
    listDirectory(path?: string): Promise<Array<{ name: string; type: string; size?: number }>>;
    getFileContent(path: string): Promise<{ content: string; binary?: boolean }>;
    getFileStatus(): Promise<Array<{ path: string; status: string }>>;

    // Search
    findText(pattern: string): Promise<Array<{ path: string; line: number; text: string }>>;
    findFiles(query: string): Promise<string[]>;
    findSymbols(query: string): Promise<Array<{ name: string; path: string; kind: string }>>;

    // PTY
    createPty(options?: PtyCreateOptions): Promise<{ id: string }>;
    deletePty(ptyId: string): Promise<void>;
    resizePty(ptyId: string, cols: number, rows: number): Promise<void>;
    listPtys(): Promise<Array<{ id: string; [key: string]: unknown }>>;

    // Auth/URL for PTY upstream
    getBaseUrl(): string;
    getAuthHeaders(): Record<string, string>;
}

/**
 * Unified event type emitted by all backends.
 * Structurally matches OpenCodeEvent so existing EventTranslator works.
 */
export interface BackendEvent {
    type: string;
    properties: Record<string, unknown>;
}
```

**Step 2: Write a structural test**

```typescript
// src/lib/backend/types.test.ts
import { describe, it, expectTypeOf } from "vitest";
import type { SessionBackend, InfraClient } from "./types.js";
import type { RelayClient } from "../instance/sdk-client.js";

describe("SessionBackend interface", () => {
    it("every required SessionBackend method exists on RelayClient", () => {
        // Excluded: type, initialize, shutdown, subscribeEvents (backend-only lifecycle),
        // sendMessage (renamed from sendMessageAsync), and the 3 optional methods
        // (forkSession, revertSession, unrevertSession — exist on RelayClient but
        // optional on interface).
        type BackendMethods = Exclude<
            keyof SessionBackend,
            "type" | "initialize" | "shutdown" | "subscribeEvents" | "sendMessage"
            | "forkSession" | "revertSession" | "unrevertSession"
        >;
        type ClientMethods = keyof RelayClient;
        expectTypeOf<BackendMethods>().toMatchTypeOf<ClientMethods>();
    });

    it("optional operations also exist on RelayClient", () => {
        // The optional methods DO exist on RelayClient (OpenCode supports them).
        type OptionalMethods = "forkSession" | "revertSession" | "unrevertSession";
        type ClientMethods = keyof RelayClient;
        expectTypeOf<OptionalMethods>().toMatchTypeOf<ClientMethods>();
    });

    it("every InfraClient method exists on RelayClient", () => {
        type InfraMethods = keyof InfraClient;
        type ClientMethods = keyof RelayClient;
        expectTypeOf<InfraMethods>().toMatchTypeOf<ClientMethods>();
    });
});
```

**Step 3: Run test to verify it passes**

```bash
pnpm vitest run src/lib/backend/types.test.ts
```

**Step 4: Commit**

```bash
git add src/lib/backend/types.ts src/lib/backend/types.test.ts
git commit -m "feat: define SessionBackend and InfraClient interfaces

Optional forkSession/revertSession/unrevertSession for backends
without equivalents (Claude Agent SDK)."
```

---

### Task 2: AsyncEventChannel and Deferred Utilities

Shared utilities used by both `OpenCodeBackend` (SSE -> AsyncIterable bridge) and `ClaudeAgentBackend` (query generator -> relay stream, permission bridging).

**Files:**
- Create: `src/lib/backend/async-event-channel.ts`
- Create: `src/lib/backend/async-event-channel.test.ts`
- Create: `src/lib/backend/deferred.ts`
- Create: `src/lib/backend/deferred.test.ts`

**Step 1: Write failing tests for AsyncEventChannel**

```typescript
// src/lib/backend/async-event-channel.test.ts
import { describe, it, expect } from "vitest";
import { AsyncEventChannel } from "./async-event-channel.js";

describe("AsyncEventChannel", () => {
    it("delivers pushed events in order", async () => {
        const ch = new AsyncEventChannel<number>();
        ch.push(1);
        ch.push(2);
        ch.push(3);
        ch.close();

        const results: number[] = [];
        for await (const n of ch) results.push(n);
        expect(results).toEqual([1, 2, 3]);
    });

    it("blocks consumer until event is pushed", async () => {
        const ch = new AsyncEventChannel<string>();
        const iter = ch[Symbol.asyncIterator]();

        // Push after a delay
        setTimeout(() => ch.push("hello"), 10);
        const { value, done } = await iter.next();
        expect(value).toBe("hello");
        expect(done).toBe(false);

        ch.close();
    });

    it("returns done after close", async () => {
        const ch = new AsyncEventChannel<string>();
        ch.close();

        const iter = ch[Symbol.asyncIterator]();
        const { done } = await iter.next();
        expect(done).toBe(true);
    });

    it("unblocks waiting consumer on close", async () => {
        const ch = new AsyncEventChannel<string>();
        const iter = ch[Symbol.asyncIterator]();

        // Consumer is waiting. Close should unblock it.
        setTimeout(() => ch.close(), 10);
        const { done } = await iter.next();
        expect(done).toBe(true);
    });

    it("ignores push after close", async () => {
        const ch = new AsyncEventChannel<number>();
        ch.push(1);
        ch.close();
        ch.push(2); // should be ignored

        const results: number[] = [];
        for await (const n of ch) results.push(n);
        expect(results).toEqual([1]);
    });

    it("return() closes the channel", async () => {
        const ch = new AsyncEventChannel<number>();
        ch.push(1);

        const iter = ch[Symbol.asyncIterator]();
        const { value } = await iter.next();
        expect(value).toBe(1);

        await iter.return!(undefined as any);
        const { done } = await iter.next();
        expect(done).toBe(true);
    });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm vitest run src/lib/backend/async-event-channel.test.ts
```

Expected: FAIL — module doesn't exist yet.

**Step 3: Implement AsyncEventChannel**

```typescript
// src/lib/backend/async-event-channel.ts

/**
 * Push-pull async channel bridging event producers to async iterable consumers.
 *
 * Used by:
 * - OpenCodeBackend: SSEConsumer EventEmitter -> AsyncIterable<BackendEvent>
 * - ClaudeAgentBackend: query() generator -> relay event stream
 *
 * Between queries on the Claude Agent SDK, the channel is empty and the
 * consumer awaits. No errors, no disconnection. When a new query() starts,
 * events flow again.
 */
export class AsyncEventChannel<T> {
    private queue: T[] = [];
    private resolver: ((value: IteratorResult<T>) => void) | null = null;
    private closed = false;

    push(event: T): void {
        if (this.closed) return;
        if (this.resolver) {
            const resolve = this.resolver;
            this.resolver = null;
            resolve({ value: event, done: false });
        } else {
            this.queue.push(event);
        }
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        if (this.resolver) {
            const resolve = this.resolver;
            this.resolver = null;
            resolve({ value: undefined as any, done: true });
        }
    }

    get isClosed(): boolean {
        return this.closed;
    }

    [Symbol.asyncIterator](): AsyncIterableIterator<T> {
        const self = this;
        return {
            next(): Promise<IteratorResult<T>> {
                if (self.queue.length > 0) {
                    return Promise.resolve({ value: self.queue.shift()!, done: false as const });
                }
                if (self.closed) {
                    return Promise.resolve({ value: undefined as any, done: true as const });
                }
                return new Promise(resolve => { self.resolver = resolve; });
            },
            return(): Promise<IteratorResult<T>> {
                self.close();
                return Promise.resolve({ value: undefined as any, done: true as const });
            },
            [Symbol.asyncIterator]() { return this; },
        };
    }
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm vitest run src/lib/backend/async-event-channel.test.ts
```

**Step 5: Write failing tests for Deferred**

```typescript
// src/lib/backend/deferred.test.ts
import { describe, it, expect } from "vitest";
import { createDeferred } from "./deferred.js";

describe("Deferred", () => {
    it("resolves with a value", async () => {
        const d = createDeferred<string>();
        d.resolve("hello");
        expect(await d.promise).toBe("hello");
    });

    it("rejects with a reason", async () => {
        const d = createDeferred<string>();
        d.reject(new Error("boom"));
        await expect(d.promise).rejects.toThrow("boom");
    });

    it("can be awaited before resolution", async () => {
        const d = createDeferred<number>();
        setTimeout(() => d.resolve(42), 10);
        expect(await d.promise).toBe(42);
    });
});
```

**Step 6: Implement Deferred**

```typescript
// src/lib/backend/deferred.ts

export interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
}

export function createDeferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}
```

**Step 7: Run all tests**

```bash
pnpm vitest run src/lib/backend/async-event-channel.test.ts src/lib/backend/deferred.test.ts
```

**Step 8: Commit**

```bash
git add src/lib/backend/async-event-channel.ts src/lib/backend/async-event-channel.test.ts \
        src/lib/backend/deferred.ts src/lib/backend/deferred.test.ts
git commit -m "feat: add AsyncEventChannel and Deferred utilities for backend bridging"
```

---

### Task 3: Implement OpenCodeBackend

The first `SessionBackend` implementation. Wraps `RelayClient` for session-centric methods and owns the `SSEConsumer` for event streaming. Pure delegation — no behavior change.

**Files:**
- Create: `src/lib/backend/opencode-backend.ts`
- Create: `src/lib/backend/opencode-backend.test.ts`

**Step 1: Write failing tests**

```typescript
// src/lib/backend/opencode-backend.test.ts
import { describe, it, expect, vi } from "vitest";
import { OpenCodeBackend } from "./opencode-backend.js";

function createMockRelayClient() {
    return {
        listSessions: vi.fn().mockResolvedValue([]),
        getSession: vi.fn().mockResolvedValue({ id: "s1" }),
        createSession: vi.fn().mockResolvedValue({ id: "s2" }),
        deleteSession: vi.fn().mockResolvedValue(undefined),
        updateSession: vi.fn().mockResolvedValue({ id: "s1" }),
        getSessionStatuses: vi.fn().mockResolvedValue({}),
        getMessages: vi.fn().mockResolvedValue([]),
        getMessage: vi.fn().mockResolvedValue({ id: "m1" }),
        getMessagesPage: vi.fn().mockResolvedValue([]),
        sendMessageAsync: vi.fn().mockResolvedValue(undefined),
        abortSession: vi.fn().mockResolvedValue(undefined),
        listPendingPermissions: vi.fn().mockResolvedValue([]),
        replyPermission: vi.fn().mockResolvedValue(undefined),
        listPendingQuestions: vi.fn().mockResolvedValue([]),
        replyQuestion: vi.fn().mockResolvedValue(undefined),
        rejectQuestion: vi.fn().mockResolvedValue(undefined),
        listAgents: vi.fn().mockResolvedValue([]),
        listProviders: vi.fn().mockResolvedValue({ providers: [], defaults: {}, connected: [] }),
        listCommands: vi.fn().mockResolvedValue([]),
        listSkills: vi.fn().mockResolvedValue([]),
        getConfig: vi.fn().mockResolvedValue({}),
        updateConfig: vi.fn().mockResolvedValue({}),
        forkSession: vi.fn().mockResolvedValue({ id: "s3" }),
        revertSession: vi.fn().mockResolvedValue(undefined),
        unrevertSession: vi.fn().mockResolvedValue(undefined),
        getHealth: vi.fn().mockResolvedValue({ ok: true }),
        getBaseUrl: vi.fn().mockReturnValue("http://localhost:4096"),
        getAuthHeaders: vi.fn().mockReturnValue({ Authorization: "Basic test" }),
    };
}

describe("OpenCodeBackend", () => {
    it("has type 'opencode'", () => {
        const client = createMockRelayClient();
        const backend = new OpenCodeBackend({ client: client as any });
        expect(backend.type).toBe("opencode");
    });

    it("delegates listSessions to RelayClient", async () => {
        const client = createMockRelayClient();
        const backend = new OpenCodeBackend({ client: client as any });
        await backend.listSessions({ roots: true });
        expect(client.listSessions).toHaveBeenCalledWith({ roots: true });
    });

    it("delegates sendMessage to sendMessageAsync", async () => {
        const client = createMockRelayClient();
        const backend = new OpenCodeBackend({ client: client as any });
        await backend.sendMessage("s1", { text: "hello" });
        expect(client.sendMessageAsync).toHaveBeenCalledWith("s1", { text: "hello" });
    });

    it("implements optional forkSession", async () => {
        const client = createMockRelayClient();
        const backend = new OpenCodeBackend({ client: client as any });
        expect(backend.forkSession).toBeDefined();
        await backend.forkSession!("s1", { title: "fork" });
        expect(client.forkSession).toHaveBeenCalledWith("s1", { title: "fork" });
    });

    it("implements optional revertSession", async () => {
        const client = createMockRelayClient();
        const backend = new OpenCodeBackend({ client: client as any });
        expect(backend.revertSession).toBeDefined();
        await backend.revertSession!("s1", "m1");
        expect(client.revertSession).toHaveBeenCalledWith("s1", "m1");
    });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm vitest run src/lib/backend/opencode-backend.test.ts
```

Expected: FAIL — `OpenCodeBackend` doesn't exist yet.

**Step 3: Implement OpenCodeBackend**

```typescript
// src/lib/backend/opencode-backend.ts
import type { SessionBackend, InfraClient, BackendEvent } from "./types.js";
import type { RelayClient } from "../instance/sdk-client.js";
import type { SSEConsumer } from "../relay/sse-consumer.js";
import type { ServiceRegistry } from "../relay/service-registry.js";
import type { Logger } from "../logging.js";
import { AsyncEventChannel } from "./async-event-channel.js";

export interface OpenCodeBackendOptions {
    client: RelayClient;
    sseConfig?: {
        registry: ServiceRegistry;
        baseUrl: string;
        authHeaders?: Record<string, string>;
        log?: Logger;
    };
}

/**
 * SessionBackend wrapping OpenCode's REST API + SSE event stream.
 * Every session-centric method delegates directly to RelayClient.
 * SSEConsumer events are bridged to AsyncIterable via AsyncEventChannel.
 *
 * OpenCode supports all operations including the optional ones
 * (forkSession, revertSession, unrevertSession).
 */
export class OpenCodeBackend implements SessionBackend {
    readonly type = "opencode" as const;
    private readonly client: RelayClient;
    private readonly sseConfig?: OpenCodeBackendOptions["sseConfig"];
    private sseConsumer?: SSEConsumer;

    constructor(options: OpenCodeBackendOptions) {
        this.client = options.client;
        this.sseConfig = options.sseConfig;
    }

    async initialize(): Promise<void> {
        if (this.sseConfig) {
            const { SSEConsumer: SSEConsumerClass } = await import("../relay/sse-consumer.js");
            this.sseConsumer = new SSEConsumerClass(this.sseConfig.registry, {
                baseUrl: this.sseConfig.baseUrl,
                authHeaders: this.sseConfig.authHeaders,
                log: this.sseConfig.log,
            });
            await this.sseConsumer.connect();
        }
    }

    async shutdown(): Promise<void> {
        await this.sseConsumer?.disconnect();
    }

    /** Expose SSEConsumer for relay-stack wiring that still needs direct access. */
    getSSEConsumer(): SSEConsumer | undefined {
        return this.sseConsumer;
    }

    // --- Direct delegation to RelayClient ---

    getHealth() { return this.client.getHealth(); }
    listSessions(options?: any) { return this.client.listSessions(options); }
    getSession(id: string) { return this.client.getSession(id); }
    createSession(options?: any) { return this.client.createSession(options); }
    deleteSession(id: string) { return this.client.deleteSession(id); }
    updateSession(id: string, updates: any) { return this.client.updateSession(id, updates); }
    getSessionStatuses() { return this.client.getSessionStatuses(); }
    getMessages(sessionId: string) { return this.client.getMessages(sessionId); }
    getMessage(sessionId: string, messageId: string) { return this.client.getMessage(sessionId, messageId); }
    getMessagesPage(sessionId: string, options?: any) { return this.client.getMessagesPage(sessionId, options); }
    sendMessage(sessionId: string, prompt: any) { return this.client.sendMessageAsync(sessionId, prompt); }
    abortSession(id: string) { return this.client.abortSession(id); }
    listPendingPermissions() { return this.client.listPendingPermissions(); }
    replyPermission(options: any) { return this.client.replyPermission(options); }
    listPendingQuestions() { return this.client.listPendingQuestions(); }
    replyQuestion(options: any) { return this.client.replyQuestion(options); }
    rejectQuestion(id: string) { return this.client.rejectQuestion(id); }
    listAgents() { return this.client.listAgents(); }
    listProviders() { return this.client.listProviders(); }
    listCommands() { return this.client.listCommands(); }
    listSkills() { return this.client.listSkills(); }
    getConfig() { return this.client.getConfig(); }
    updateConfig(config: any) { return this.client.updateConfig(config); }

    // --- Optional operations (OpenCode supports all of these) ---

    forkSession(id: string, options: any) { return this.client.forkSession(id, options); }
    revertSession(id: string, messageId: string) { return this.client.revertSession(id, messageId); }
    unrevertSession(id: string) { return this.client.unrevertSession(id); }

    // --- Event streaming ---

    async *subscribeEvents(signal: AbortSignal): AsyncIterable<BackendEvent> {
        if (!this.sseConsumer) return;

        const channel = new AsyncEventChannel<BackendEvent>();
        const handler = (event: { type: string; properties: Record<string, unknown> }) => {
            channel.push({ type: event.type, properties: event.properties });
        };
        this.sseConsumer.on("event", handler);

        signal.addEventListener("abort", () => {
            this.sseConsumer?.off("event", handler);
            channel.close();
        }, { once: true });

        yield* channel;
    }
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm vitest run src/lib/backend/opencode-backend.test.ts
```

**Step 5: Commit**

```bash
git add src/lib/backend/opencode-backend.ts src/lib/backend/opencode-backend.test.ts
git commit -m "feat: implement OpenCodeBackend wrapping RelayClient + SSEConsumer"
```

---

### Task 4: Split HandlerDeps into sessionBackend + infraClient

Replace the single `client: OpenCodeClient` (now `RelayClient`) field on `HandlerDeps` and `ClientInitDeps` with `sessionBackend: SessionBackend` and `infraClient: InfraClient`. Update all 8 handler files and the mock factory.

**Files:**
- Modify: `src/lib/handlers/types.ts:71` — split `client` field
- Modify: `src/lib/handlers/session.ts` — use `deps.sessionBackend`
- Modify: `src/lib/handlers/prompt.ts` — use `deps.sessionBackend`
- Modify: `src/lib/handlers/permissions.ts` — use `deps.sessionBackend`
- Modify: `src/lib/handlers/model.ts` — use `deps.sessionBackend`
- Modify: `src/lib/handlers/agent.ts` — use `deps.sessionBackend`
- Modify: `src/lib/handlers/settings.ts` — use both (`listCommands` -> `sessionBackend`, `listProjects` -> `infraClient`)
- Modify: `src/lib/handlers/files.ts` — use `deps.infraClient`
- Modify: `src/lib/handlers/terminal.ts` — use `deps.infraClient`
- Modify: `src/lib/bridges/client-init.ts:35` — split `client` field on `ClientInitDeps`
- Modify: `test/helpers/mock-factories.ts` — split `createMockClient()` into `createMockSessionBackend()` + `createMockInfraClient()`

**Step 1: Update `HandlerDeps` interface**

In `src/lib/handlers/types.ts`, replace:
```typescript
client: OpenCodeClient;
```
with:
```typescript
sessionBackend: SessionBackend;
infraClient: InfraClient;
```

Update imports from `../instance/opencode-client.js` (or post-Phase-1 `../instance/sdk-client.js`) to `../backend/types.js`.

**Step 2: Update `ClientInitDeps` interface**

In `src/lib/bridges/client-init.ts`, same split. Update `handleClientConnected` to use `deps.sessionBackend` for calls to `getSession`, `listPendingPermissions`, `listPendingQuestions`, `listAgents`, `listProviders`.

**Step 3: Update each handler file (mechanical replacements)**

Session-centric handlers:
- `deps.client.listSessions(...)` -> `deps.sessionBackend.listSessions(...)`
- `deps.client.sendMessageAsync(...)` -> `deps.sessionBackend.sendMessage(...)` (renamed)
- `deps.client.getSession(...)` -> `deps.sessionBackend.getSession(...)`
- etc.

Infra handlers:
- `deps.client.getFileContent(...)` -> `deps.infraClient.getFileContent(...)`
- `deps.client.createPty(...)` -> `deps.infraClient.createPty(...)`
- etc.

Mixed handler (`settings.ts`):
- `deps.client.listCommands()` -> `deps.sessionBackend.listCommands()`
- `deps.client.listProjects()` -> `deps.infraClient.listProjects()`

**Guarding optional operations in prompt.ts:**

For `revertSession` in `prompt.ts`, add a guard:

```typescript
// Before (v1)
await deps.client.revertSession(sessionId, messageId);

// After (v2)
if (!deps.sessionBackend.revertSession) {
    throw new Error("Revert not supported by current backend");
}
await deps.sessionBackend.revertSession(sessionId, messageId);
```

Same pattern for `forkSession` in `session.ts`.

**Step 4: Update mock factory**

Split `createMockClient()` into two functions:

```typescript
export function createMockSessionBackend(): SessionBackend {
    return {
        type: "opencode",
        initialize: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
        getHealth: vi.fn().mockResolvedValue({ ok: true }),
        listSessions: vi.fn().mockResolvedValue([]),
        getSession: vi.fn().mockResolvedValue({ id: "s1" }),
        createSession: vi.fn().mockResolvedValue({ id: "s2" }),
        // ... all required methods ...
        sendMessage: vi.fn().mockResolvedValue(undefined),
        // Optional operations present for OpenCode mock
        forkSession: vi.fn().mockResolvedValue({ id: "s3" }),
        revertSession: vi.fn().mockResolvedValue(undefined),
        unrevertSession: vi.fn().mockResolvedValue(undefined),
        subscribeEvents: vi.fn(),
    } as unknown as SessionBackend;
}

export function createMockInfraClient(): InfraClient {
    return {
        getPath: vi.fn().mockResolvedValue({ cwd: "/tmp" }),
        listDirectory: vi.fn().mockResolvedValue([]),
        getFileContent: vi.fn().mockResolvedValue({ content: "" }),
        createPty: vi.fn().mockResolvedValue({ id: "pty1" }),
        // ... all InfraClient methods ...
        getBaseUrl: vi.fn().mockReturnValue("http://localhost:4096"),
        getAuthHeaders: vi.fn().mockReturnValue({}),
    } as unknown as InfraClient;
}
```

Update `createMockHandlerDeps()` and `createMockClientInitDeps()` to use both.

**Step 5: Run verification**

```bash
pnpm check
pnpm lint
pnpm test:unit
```

All handler tests should pass since the mock factory provides the same method stubs, just under different field names.

**Step 6: Commit (split by risk)**

Commit 1 — types + mock factory:
```bash
git add src/lib/handlers/types.ts src/lib/bridges/client-init.ts test/helpers/mock-factories.ts
git commit -m "refactor: split HandlerDeps.client into sessionBackend + infraClient"
```

Commit 2 — handler files:
```bash
git add src/lib/handlers/session.ts src/lib/handlers/prompt.ts src/lib/handlers/permissions.ts \
        src/lib/handlers/model.ts src/lib/handlers/agent.ts src/lib/handlers/settings.ts \
        src/lib/handlers/files.ts src/lib/handlers/terminal.ts src/lib/bridges/client-init.ts
git commit -m "refactor: update all handlers to use sessionBackend/infraClient

Guard optional ops (forkSession, revertSession) behind existence check."
```

---

### Task 5: Refactor Relay Stack to Use SessionBackend + InfraClient

The relay stack currently constructs a single `RelayClient` and passes it everywhere. Refactor to construct `OpenCodeBackend` (wrapping `RelayClient` + SSEConsumer) for session-centric operations, and pass `RelayClient` directly as `InfraClient`.

**Files:**
- Modify: `src/lib/relay/relay-stack.ts:127-475` — construct `OpenCodeBackend`, pass `sessionBackend` + `infraClient`
- Modify: `src/lib/relay/handler-deps-wiring.ts` — accept `sessionBackend` + `infraClient`
- Modify: `src/lib/session/session-manager.ts:26,109` — change `client` to `backend: SessionBackend`
- Modify: `src/lib/session/session-status-poller.ts:39,60` — change `Pick<OpenCodeClient, ...>` to `Pick<SessionBackend, ...>`
- Modify: `src/lib/relay/message-poller.ts:441` — change `Pick<OpenCodeClient, "getMessages">` to `Pick<SessionBackend, "getMessages">`
- Modify: `src/lib/relay/message-poller-manager.ts:27` — same
- Modify: `src/lib/relay/session-lifecycle-wiring.ts` — use `SessionBackend`
- Modify: `src/lib/relay/monitoring-wiring.ts` — use `SessionBackend`

**Step 1: Update relay-stack.ts**

At line ~145, after constructing `RelayClient`:

```typescript
const client = new RelayClient({ baseUrl: config.opencodeUrl, ... });

// Backend wraps client for session-centric operations + owns SSE
const sessionBackend = new OpenCodeBackend({
    client,
    sseConfig: {
        registry: serviceRegistry,
        baseUrl: config.opencodeUrl,
        authHeaders: client.getAuthHeaders(),
        log: loggers.sse,
    },
});

// client also serves as infraClient (has all InfraClient methods)
const infraClient = client as unknown as InfraClient;
```

Pass `sessionBackend` to SessionManager, SessionStatusPoller, MessagePollerManager, handler deps wiring. Pass `infraClient` to handler deps wiring and PTY upstream.

Replace direct SSEConsumer construction (line ~327) with `await sessionBackend.initialize()`. Get the SSEConsumer reference via `sessionBackend.getSSEConsumer()` for sse-wiring that still needs direct access to connection health/events.

Update `ProjectRelay` interface to expose `sessionBackend: SessionBackend` and `infraClient: InfraClient` instead of (or alongside) `client: OpenCodeClient`.

**Step 2: Update SessionManager constructor**

Change `SessionManagerOptions.client: OpenCodeClient` to `SessionManagerOptions.backend: SessionBackend`. Update internal references:
- `this.client.listSessions()` -> `this.backend.listSessions()`
- `this.client.getMessagesPage()` -> `this.backend.getMessagesPage()`
- `this.client.createSession()` -> `this.backend.createSession()`
- `this.client.deleteSession()` -> `this.backend.deleteSession()`
- `this.client.updateSession()` -> `this.backend.updateSession()`

**Step 3: Update poller `Pick<>` types**

SessionStatusPoller: `Pick<SessionBackend, "getSessionStatuses" | "getSession">`
MessagePoller/Manager: `Pick<SessionBackend, "getMessages">`

These are mechanical — same method names, just different source type for the Pick.

**Step 4: Run verification**

```bash
pnpm check
pnpm lint
pnpm test:unit
pnpm test:integration
```

**Step 5: Commit**

```bash
git commit -am "refactor: relay stack uses SessionBackend + InfraClient

SessionManager, pollers, and handlers all program against the interface.
SSEConsumer owned by OpenCodeBackend."
```

---

### Task 6: Phase 2 Final Verification

**Step 1: Run full suite**

```bash
pnpm check
pnpm lint
pnpm test:unit
pnpm test:integration
pnpm test:e2e
```

**Step 2: Verify no direct RelayClient usage in handlers**

```bash
rg "deps\.client\." src/lib/handlers/
```

Should return zero results. All handler code should use `deps.sessionBackend` or `deps.infraClient`.

**Step 3: Verify SessionBackend is the abstraction point**

```bash
rg "RelayClient" src/lib/handlers/ src/lib/session/ src/lib/relay/message-poller
```

Should return zero results in these directories — they should only reference `SessionBackend` or `InfraClient`.

**Step 4: Smoke test**

Start relay, verify sessions, messaging, PTY, file browser, permissions all work identically.

**Step 5: Commit**

```bash
git commit -m "refactor: Phase 2 complete — SessionBackend abstraction in place"
```

---

## Phase 3: Claude Agent SDK Backend

### Task 7: Install Claude Agent SDK and Create MessageQueue Utility

**Files:**
- Modify: `package.json`
- Create: `src/lib/backend/message-queue.ts`
- Create: `src/lib/backend/message-queue.test.ts`

**Step 1: Install the SDK**

```bash
pnpm add @anthropic-ai/claude-agent-sdk
```

**Step 2: Write failing tests for MessageQueue**

The MessageQueue is an async iterable that Clay uses as the `prompt` parameter to `query()`. It allows feeding messages into a live query. The SDK consumes from it; the relay pushes into it.

```typescript
// src/lib/backend/message-queue.test.ts
import { describe, it, expect } from "vitest";
import { MessageQueue } from "./message-queue.js";

describe("MessageQueue", () => {
    it("yields pushed messages in order", async () => {
        const q = new MessageQueue();
        q.push({ type: "user", message: { role: "user", content: "first" } });
        q.push({ type: "user", message: { role: "user", content: "second" } });
        q.end();

        const msgs: any[] = [];
        for await (const m of q) msgs.push(m);
        expect(msgs).toHaveLength(2);
        expect(msgs[0].message.content).toBe("first");
        expect(msgs[1].message.content).toBe("second");
    });

    it("blocks consumer until message is pushed", async () => {
        const q = new MessageQueue();
        const iter = q[Symbol.asyncIterator]();

        setTimeout(() => q.push({ type: "user", message: { role: "user", content: "hello" } }), 10);
        const { value, done } = await iter.next();
        expect(value.message.content).toBe("hello");
        expect(done).toBe(false);

        q.end();
    });

    it("returns done after end()", async () => {
        const q = new MessageQueue();
        q.end();

        const iter = q[Symbol.asyncIterator]();
        const { done } = await iter.next();
        expect(done).toBe(true);
    });

    it("unblocks waiting consumer on end()", async () => {
        const q = new MessageQueue();
        const iter = q[Symbol.asyncIterator]();

        setTimeout(() => q.end(), 10);
        const { done } = await iter.next();
        expect(done).toBe(true);
    });
});
```

**Step 3: Run test to verify it fails**

```bash
pnpm vitest run src/lib/backend/message-queue.test.ts
```

**Step 4: Implement MessageQueue**

```typescript
// src/lib/backend/message-queue.ts

/**
 * Async iterable message queue used as the `prompt` parameter to the
 * Claude Agent SDK's query() function. Follows the pattern from Clay's
 * sdk-bridge.js createMessageQueue().
 *
 * - push(): feeds a user message into the live query
 * - end(): signals no more messages (terminates the query's input)
 *
 * The SDK's query() iterates this to get user messages. Between messages,
 * the SDK finishes the current agentic turn. When a new message arrives
 * via push(), the SDK starts a new turn.
 */
export interface SDKUserMessage {
    type: "user";
    message: {
        role: "user";
        content: string | Array<{ type: string; [key: string]: unknown }>;
    };
}

export class MessageQueue {
    private queue: SDKUserMessage[] = [];
    private resolver: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;
    private ended = false;

    push(msg: SDKUserMessage): void {
        if (this.ended) return;
        if (this.resolver) {
            const resolve = this.resolver;
            this.resolver = null;
            resolve({ value: msg, done: false });
        } else {
            this.queue.push(msg);
        }
    }

    end(): void {
        if (this.ended) return;
        this.ended = true;
        if (this.resolver) {
            const resolve = this.resolver;
            this.resolver = null;
            resolve({ value: undefined as any, done: true });
        }
    }

    get isEnded(): boolean {
        return this.ended;
    }

    [Symbol.asyncIterator](): AsyncIterableIterator<SDKUserMessage> {
        const self = this;
        return {
            next(): Promise<IteratorResult<SDKUserMessage>> {
                if (self.queue.length > 0) {
                    return Promise.resolve({ value: self.queue.shift()!, done: false as const });
                }
                if (self.ended) {
                    return Promise.resolve({ value: undefined as any, done: true as const });
                }
                return new Promise(resolve => { self.resolver = resolve; });
            },
            return(): Promise<IteratorResult<SDKUserMessage>> {
                self.end();
                return Promise.resolve({ value: undefined as any, done: true as const });
            },
            [Symbol.asyncIterator]() { return this; },
        };
    }
}
```

**Step 5: Run test to verify it passes**

```bash
pnpm vitest run src/lib/backend/message-queue.test.ts
```

**Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml \
        src/lib/backend/message-queue.ts src/lib/backend/message-queue.test.ts
git commit -m "feat: add Claude Agent SDK and MessageQueue for multi-turn queries"
```

---

### Task 8: SDKMessage Translator

Translates Claude Agent SDK message types into `BackendEvent` matching the existing OpenCode event structure, so the downstream EventTranslator and relay caches work without modification.

**Files:**
- Create: `src/lib/backend/sdk-message-translator.ts`
- Create: `src/lib/backend/sdk-message-translator.test.ts`

**Step 1: Write failing tests**

```typescript
// src/lib/backend/sdk-message-translator.test.ts
import { describe, it, expect } from "vitest";
import { translateSdkMessage } from "./sdk-message-translator.js";

describe("translateSdkMessage", () => {
    it("translates assistant message to message.updated", () => {
        const event = translateSdkMessage({
            type: "assistant",
            uuid: "uuid-1",
            session_id: "sess-1",
            message: { id: "msg-1", role: "assistant", content: [{ type: "text", text: "hello" }] },
            parent_tool_use_id: null,
        });
        expect(event).not.toBeNull();
        expect(event!.type).toBe("message.updated");
        expect(event!.properties.sessionID).toBe("sess-1");
    });

    it("translates user message to message.updated", () => {
        const event = translateSdkMessage({
            type: "user",
            session_id: "sess-1",
            message: { role: "user", content: "hello" },
        });
        expect(event).not.toBeNull();
        expect(event!.type).toBe("message.updated");
    });

    it("translates stream_event to message.part.updated", () => {
        const event = translateSdkMessage({
            type: "stream_event",
            session_id: "sess-1",
            event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
            parent_tool_use_id: null,
            uuid: "uuid-1",
        });
        expect(event).not.toBeNull();
        expect(event!.type).toBe("message.part.updated");
    });

    it("translates result to session.updated", () => {
        const event = translateSdkMessage({
            type: "result",
            subtype: "success",
            session_id: "sess-1",
            result: "done",
            total_cost_usd: 0.01,
            usage: {},
        });
        expect(event).not.toBeNull();
        expect(event!.type).toBe("session.updated");
        expect(event!.properties.status).toBe("completed");
    });

    it("translates result with error subtype to session.updated with error status", () => {
        const event = translateSdkMessage({
            type: "result",
            subtype: "error_during_execution",
            session_id: "sess-1",
            result: "failed",
            total_cost_usd: 0.005,
            usage: {},
        });
        expect(event).not.toBeNull();
        expect(event!.type).toBe("session.updated");
        expect(event!.properties.status).toBe("error");
    });

    it("translates system init to session.initialized", () => {
        const event = translateSdkMessage({
            type: "system",
            subtype: "init",
            session_id: "sess-1",
            tools: [],
            model: "claude-sonnet-4-20250514",
            mcp_servers: [],
        });
        expect(event).not.toBeNull();
        expect(event!.type).toBe("session.initialized");
    });

    it("returns null for unknown message types", () => {
        const event = translateSdkMessage({ type: "unknown_type" });
        expect(event).toBeNull();
    });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm vitest run src/lib/backend/sdk-message-translator.test.ts
```

**Step 3: Implement translator**

```typescript
// src/lib/backend/sdk-message-translator.ts
import type { BackendEvent } from "./types.js";

/**
 * Translates Claude Agent SDK messages into BackendEvent objects matching
 * the OpenCode SSE event structure. This lets the downstream EventTranslator,
 * caches, and pollers work unchanged.
 *
 * SDK message types (from docs/claude-agent-sdk/):
 * - assistant: complete assistant message (after tool execution)
 * - user: complete user message (including tool_result blocks)
 * - stream_event: raw Anthropic API streaming delta
 * - result: query completed (success or error)
 * - system: init metadata, status changes
 */
export function translateSdkMessage(msg: Record<string, any>): BackendEvent | null {
    switch (msg.type) {
        case "assistant":
            return {
                type: "message.updated",
                properties: {
                    sessionID: msg.session_id,
                    message: normalizeAssistantMessage(msg),
                },
            };

        case "user":
            return {
                type: "message.updated",
                properties: {
                    sessionID: msg.session_id,
                    message: normalizeUserMessage(msg),
                },
            };

        case "stream_event":
            return {
                type: "message.part.updated",
                properties: {
                    sessionID: msg.session_id,
                    event: msg.event,
                    parentToolUseId: msg.parent_tool_use_id ?? undefined,
                    uuid: msg.uuid,
                },
            };

        case "result":
            return {
                type: "session.updated",
                properties: {
                    sessionID: msg.session_id,
                    status: msg.subtype === "success" ? "completed" : "error",
                    result: msg.result,
                    cost: msg.total_cost_usd,
                    usage: msg.usage,
                    modelUsage: msg.modelUsage,
                    subtype: msg.subtype,
                },
            };

        case "system":
            if (msg.subtype === "init") {
                return {
                    type: "session.initialized",
                    properties: {
                        sessionID: msg.session_id,
                        tools: msg.tools,
                        model: msg.model,
                        mcpServers: msg.mcp_servers,
                    },
                };
            }
            // Other system subtypes (status changes, compacting, etc.)
            return {
                type: "session.updated",
                properties: {
                    sessionID: msg.session_id,
                    subtype: msg.subtype,
                    ...msg,
                },
            };

        default:
            return null;
    }
}

function normalizeAssistantMessage(msg: Record<string, any>) {
    return {
        id: msg.uuid ?? msg.message?.id,
        role: "assistant",
        content: msg.message?.content,
        sessionId: msg.session_id,
        parentToolUseId: msg.parent_tool_use_id ?? undefined,
    };
}

function normalizeUserMessage(msg: Record<string, any>) {
    return {
        id: msg.uuid,
        role: "user",
        content: msg.message?.content,
        sessionId: msg.session_id,
    };
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm vitest run src/lib/backend/sdk-message-translator.test.ts
```

**Step 5: Commit**

```bash
git add src/lib/backend/sdk-message-translator.ts src/lib/backend/sdk-message-translator.test.ts
git commit -m "feat: SDKMessage to BackendEvent translator for Claude Agent SDK"
```

---

### Task 9: Implement ClaudeAgentBackend — Session Management

The first slice: session CRUD, discovery, and lazy session creation. No messaging yet.

**Files:**
- Create: `src/lib/backend/claude-agent-backend.ts`
- Create: `src/lib/backend/claude-agent-backend.test.ts`

**Step 1: Write failing tests**

```typescript
// src/lib/backend/claude-agent-backend.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the SDK module
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
    listSessions: vi.fn(),
    getSessionMessages: vi.fn(),
    getSessionInfo: vi.fn(),
    query: vi.fn(),
}));

import { ClaudeAgentBackend } from "./claude-agent-backend.js";
import { listSessions, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";

describe("ClaudeAgentBackend — session management", () => {
    let backend: ClaudeAgentBackend;

    beforeEach(() => {
        vi.clearAllMocks();
        backend = new ClaudeAgentBackend({ cwd: "/tmp/project" });
    });

    it("has type 'claude-agent'", () => {
        expect(backend.type).toBe("claude-agent");
    });

    it("listSessions delegates to SDK listSessions", async () => {
        vi.mocked(listSessions).mockResolvedValue([
            { id: "sdk-sess-1", cwd: "/tmp/project" },
        ] as any);

        const sessions = await backend.listSessions();
        expect(listSessions).toHaveBeenCalledWith({ dir: "/tmp/project", limit: 50 });
        expect(sessions).toHaveLength(1);
        expect(sessions[0].id).toBe("sdk-sess-1");
    });

    it("createSession creates a local placeholder (lazy)", async () => {
        const session = await backend.createSession();
        expect(session.id).toMatch(/^local-/);
        // No SDK call — session materializes on first message
        expect(listSessions).not.toHaveBeenCalled();
    });

    it("getMessages for a local session returns empty", async () => {
        const session = await backend.createSession();
        const msgs = await backend.getMessages(session.id);
        expect(msgs).toEqual([]);
    });

    it("getMessages for an SDK session delegates to getSessionMessages", async () => {
        vi.mocked(getSessionMessages).mockResolvedValue([
            { type: "user", message: { role: "user", content: "hi" } },
        ] as any);

        const msgs = await backend.getMessages("sdk-sess-1");
        expect(getSessionMessages).toHaveBeenCalledWith("sdk-sess-1", expect.objectContaining({ dir: "/tmp/project" }));
    });

    it("does NOT implement forkSession", () => {
        expect(backend.forkSession).toBeUndefined();
    });

    it("does NOT implement revertSession", () => {
        expect(backend.revertSession).toBeUndefined();
    });

    it("does NOT implement unrevertSession", () => {
        expect(backend.unrevertSession).toBeUndefined();
    });

    it("shutdown rejects pending deferreds", async () => {
        // Will be tested more in Task 11 (permissions)
        await expect(backend.shutdown()).resolves.toBeUndefined();
    });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm vitest run src/lib/backend/claude-agent-backend.test.ts
```

**Step 3: Implement ClaudeAgentBackend (session management slice)**

```typescript
// src/lib/backend/claude-agent-backend.ts
import { listSessions, getSessionMessages, getSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import type { SessionBackend, BackendEvent } from "./types.js";
import { AsyncEventChannel } from "./async-event-channel.js";
import { MessageQueue, type SDKUserMessage } from "./message-queue.js";
import { createDeferred, type Deferred } from "./deferred.js";
import { translateSdkMessage } from "./sdk-message-translator.js";
import type { Logger } from "../logging.js";

export interface ClaudeAgentBackendOptions {
    cwd: string;
    apiKey?: string;
    model?: string;
    allowedTools?: string[];
    log?: Logger;
}

interface PermissionEntry {
    deferred: Deferred<PermissionDecision>;
    metadata: { id: string; tool: string; input: unknown; timestamp: number };
}

interface QuestionEntry {
    deferred: Deferred<QuestionAnswer>;
    metadata: { id: string; toolUseId: string; input: unknown; timestamp: number };
}

interface PermissionDecision {
    decision: "allow" | "deny";
    feedback?: string;
}

interface QuestionAnswer {
    answers: Record<string, string>;
}

interface LocalSession {
    id: string;
    title: string;
    created: number;
}

/**
 * SessionBackend wrapping the Claude Agent SDK's query() API.
 *
 * Key patterns (from Clay reference impl):
 * - MessageQueue as async iterable prompt for multi-turn within a live query
 * - Deferred promise bridge for canUseTool permission/question callbacks
 * - AsyncEventChannel bridging per-query events to continuous relay stream
 * - SDK-native resume via cliSessionId (never reconstruct history)
 * - Lazy session creation (local placeholder until first message)
 *
 * Does NOT implement forkSession, revertSession, unrevertSession
 * (no Claude Agent SDK equivalent).
 */
export class ClaudeAgentBackend implements SessionBackend {
    readonly type = "claude-agent" as const;

    private readonly cwd: string;
    private readonly apiKey: string | undefined;
    private model: string;
    private readonly allowedTools: string[];
    private readonly log?: Logger;

    // Active query state (one per project, from design doc constraint)
    private activeQuery: any | null = null;
    private messageQueue: MessageQueue | null = null;
    private abortController: AbortController | null = null;
    private streamPromise: Promise<void> | null = null;

    // Event channel — continuous stream consumed by relay
    private readonly channel = new AsyncEventChannel<BackendEvent>();

    // Permission and question bridging
    private readonly pendingPermissions = new Map<string, PermissionEntry>();
    private readonly pendingQuestions = new Map<string, QuestionEntry>();

    // Session tracking
    private readonly localSessions = new Map<string, LocalSession>();
    private readonly sessionIdMap = new Map<string, string>(); // localId -> cliSessionId
    private readonly cliSessionIds = new Map<string, string>(); // relaySessionId -> cliSessionId

    constructor(options: ClaudeAgentBackendOptions) {
        this.cwd = options.cwd;
        this.apiKey = options.apiKey;
        this.model = options.model ?? "claude-sonnet-4-20250514";
        this.allowedTools = options.allowedTools ?? ["Read", "Glob", "Grep", "WebFetch"];
        this.log = options.log;
    }

    async initialize(): Promise<void> {
        // Validate cwd exists, API key available via env or option
        this.log?.info("ClaudeAgentBackend initialized", { cwd: this.cwd });
    }

    async shutdown(): Promise<void> {
        // 1. Abort active query
        this.abortController?.abort();
        this.messageQueue?.end();

        // 2. Reject all pending deferreds to unblock blocked canUseTool callbacks
        for (const [id, entry] of this.pendingPermissions) {
            entry.deferred.reject(new Error("Backend shutting down"));
            this.pendingPermissions.delete(id);
        }
        for (const [id, entry] of this.pendingQuestions) {
            entry.deferred.reject(new Error("Backend shutting down"));
            this.pendingQuestions.delete(id);
        }

        // 3. Close event channel
        this.channel.close();

        // 4. Wait for stream to finish
        await this.streamPromise?.catch(() => {});
        this.activeQuery = null;
        this.messageQueue = null;
        this.abortController = null;
    }

    async getHealth() {
        return { ok: true } as any;
    }

    // --- Session CRUD ---

    async listSessions(options?: any) {
        const sdkSessions = await listSessions({ dir: this.cwd, limit: options?.limit ?? 50 });
        const sdkMapped = (sdkSessions as any[]).map((s: any) => this.toSessionDetail(s));

        // Include local placeholders that haven't materialized yet
        const locals = [...this.localSessions.values()].map((s) => this.localToSessionDetail(s));

        return [...locals, ...sdkMapped];
    }

    async getSession(id: string) {
        const local = this.localSessions.get(id);
        if (local) return this.localToSessionDetail(local);

        const cliId = this.cliSessionIds.get(id) ?? id;
        const info = await getSessionInfo(cliId);
        return this.toSessionDetail(info as any);
    }

    async createSession(options?: any) {
        // Lazy — create local placeholder, real SDK session on first message
        const id = `local-${crypto.randomUUID()}`;
        const session: LocalSession = {
            id,
            title: options?.title ?? "New Session",
            created: Date.now(),
        };
        this.localSessions.set(id, session);
        return this.localToSessionDetail(session);
    }

    async deleteSession(id: string) {
        this.localSessions.delete(id);
        this.sessionIdMap.delete(id);
        this.cliSessionIds.delete(id);
        // SDK sessions are file-based JSONL — deletion would be filesystem op
        // For now, just remove from tracking
    }

    async updateSession(id: string, updates: { title?: string }) {
        const local = this.localSessions.get(id);
        if (local && updates.title) {
            local.title = updates.title;
        }
        return this.getSession(id);
    }

    async getSessionStatuses() {
        const statuses: Record<string, any> = {};
        // Active query session is "processing"
        if (this.activeQuery) {
            // Find which session is active — the one with the active query
            for (const [relayId, cliId] of this.cliSessionIds) {
                if (this.activeQuery) {
                    statuses[relayId] = { status: "processing" };
                    break;
                }
            }
        }
        return statuses;
    }

    // --- Messages ---

    async getMessages(sessionId: string) {
        if (this.localSessions.has(sessionId)) return [];
        const cliId = this.cliSessionIds.get(sessionId) ?? sessionId;
        const msgs = await getSessionMessages(cliId, { dir: this.cwd });
        return (msgs as any[]).map((m: any) => this.toMessage(m));
    }

    async getMessage(sessionId: string, messageId: string) {
        const msgs = await this.getMessages(sessionId);
        const found = msgs.find((m: any) => m.id === messageId);
        if (!found) throw new Error(`Message ${messageId} not found`);
        return found;
    }

    async getMessagesPage(sessionId: string, options?: { limit?: number; before?: string }) {
        // SDK doesn't have native pagination — fetch all and slice
        const all = await this.getMessages(sessionId);
        const limit = options?.limit ?? 50;
        if (options?.before) {
            const idx = all.findIndex((m: any) => m.id === options.before);
            if (idx > 0) return all.slice(Math.max(0, idx - limit), idx);
        }
        return all.slice(-limit);
    }

    // sendMessage, abortSession — implemented in Task 10

    // --- Permissions & Questions ---
    // listPendingPermissions, replyPermission, etc. — implemented in Task 11

    // --- Discovery ---

    async listAgents() {
        // Agent discovery requires an active query. Return empty if none.
        if (this.activeQuery) {
            const agents = await this.activeQuery.supportedAgents();
            return agents as any[];
        }
        return [];
    }

    async listProviders() {
        // Claude Agent SDK is single-provider (Anthropic)
        return {
            providers: [{ id: "anthropic", name: "Anthropic" }],
            defaults: { provider: "anthropic", model: this.model },
            connected: ["anthropic"],
        } as any;
    }

    async listCommands() {
        if (this.activeQuery) {
            return await this.activeQuery.supportedCommands() as any[];
        }
        return [];
    }

    async listSkills() {
        return []; // Skills discovery not available in Agent SDK
    }

    async getConfig() {
        return { model: this.model, provider: "anthropic" };
    }

    async updateConfig(config: Record<string, unknown>) {
        if (config.model && typeof config.model === "string") {
            this.model = config.model;
            // If we have an active query, use setModel() for live switching
            if (this.activeQuery) {
                await this.activeQuery.setModel(config.model);
            }
        }
        return this.getConfig();
    }

    // forkSession, revertSession, unrevertSession — intentionally NOT implemented
    // (optional on SessionBackend interface, Claude Agent SDK has no equivalent)

    // --- Events ---

    async *subscribeEvents(signal: AbortSignal): AsyncIterable<BackendEvent> {
        signal.addEventListener("abort", () => this.channel.close(), { once: true });
        yield* this.channel;
    }

    // --- Helpers ---

    private toSessionDetail(sdkSession: any) {
        return {
            id: sdkSession.id ?? sdkSession.session_id,
            title: sdkSession.title ?? sdkSession.name ?? "Untitled",
            created: sdkSession.created ?? sdkSession.createdAt ?? Date.now(),
            updated: sdkSession.updated ?? sdkSession.lastActivity ?? Date.now(),
            backendType: "claude-agent" as const,
        } as any;
    }

    private localToSessionDetail(local: LocalSession) {
        return {
            id: local.id,
            title: local.title,
            created: local.created,
            updated: local.created,
            backendType: "claude-agent" as const,
            isPlaceholder: true,
        } as any;
    }

    private toMessage(sdkMsg: any) {
        return {
            id: sdkMsg.uuid ?? sdkMsg.id ?? crypto.randomUUID(),
            role: sdkMsg.type === "assistant" ? "assistant" : "user",
            content: sdkMsg.message?.content,
            sessionId: sdkMsg.session_id,
        } as any;
    }
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm vitest run src/lib/backend/claude-agent-backend.test.ts
```

**Step 5: Commit**

```bash
git add src/lib/backend/claude-agent-backend.ts src/lib/backend/claude-agent-backend.test.ts
git commit -m "feat: ClaudeAgentBackend session management with lazy creation

No forkSession/revertSession/unrevertSession (optional on interface).
Local placeholders materialize on first message."
```

---

### Task 10: Implement ClaudeAgentBackend — Messaging + Event Streaming

The core: `sendMessage()` starts a `query()` or pushes into the message queue, pipes `SDKMessage` events through the channel, captures `cliSessionId` from the first message.

**Files:**
- Modify: `src/lib/backend/claude-agent-backend.ts`
- Create: `src/lib/backend/claude-agent-messaging.test.ts`

**Step 1: Write failing tests**

```typescript
// src/lib/backend/claude-agent-messaging.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQueryInstance = {
    [Symbol.asyncIterator]: vi.fn(),
    interrupt: vi.fn(),
    close: vi.fn(),
    setModel: vi.fn(),
    supportedModels: vi.fn().mockResolvedValue([]),
    supportedAgents: vi.fn().mockResolvedValue([]),
    supportedCommands: vi.fn().mockResolvedValue([]),
};

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
    query: vi.fn().mockReturnValue(mockQueryInstance),
    listSessions: vi.fn().mockResolvedValue([]),
    getSessionMessages: vi.fn().mockResolvedValue([]),
    getSessionInfo: vi.fn().mockResolvedValue({}),
}));

import { ClaudeAgentBackend } from "./claude-agent-backend.js";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

describe("ClaudeAgentBackend — messaging", () => {
    let backend: ClaudeAgentBackend;

    beforeEach(() => {
        vi.clearAllMocks();
        backend = new ClaudeAgentBackend({ cwd: "/tmp/project" });
    });

    it("sendMessage on local session starts query without resume", async () => {
        // Make the async iterator return immediately
        mockQueryInstance[Symbol.asyncIterator].mockReturnValue({
            async next() { return { done: true, value: undefined }; },
        });

        const session = await backend.createSession();
        await backend.sendMessage(session.id, { text: "hello" } as any);

        expect(sdkQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                prompt: expect.any(Object), // MessageQueue
                options: expect.objectContaining({
                    cwd: "/tmp/project",
                    // resume should NOT be set for local sessions
                    includePartialMessages: true,
                }),
            }),
        );

        // Verify resume is NOT set
        const callArgs = vi.mocked(sdkQuery).mock.calls[0][0] as any;
        expect(callArgs.options.resume).toBeUndefined();
    });

    it("sendMessage on existing session uses resume", async () => {
        mockQueryInstance[Symbol.asyncIterator].mockReturnValue({
            async next() { return { done: true, value: undefined }; },
        });

        // Simulate a session with known cliSessionId
        await backend.sendMessage("known-cli-session-id", { text: "follow up" } as any);

        const callArgs = vi.mocked(sdkQuery).mock.calls[0][0] as any;
        expect(callArgs.options.resume).toBe("known-cli-session-id");
    });

    it("abortSession calls abort on active query", async () => {
        mockQueryInstance[Symbol.asyncIterator].mockReturnValue({
            next: () => new Promise(() => {}), // Block forever
        });

        const session = await backend.createSession();
        // Start but don't await (it blocks)
        backend.sendMessage(session.id, { text: "hello" } as any);

        // Give it a tick to start
        await new Promise(r => setTimeout(r, 10));

        await backend.abortSession(session.id);
        // Should have aborted without error
    });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm vitest run src/lib/backend/claude-agent-messaging.test.ts
```

**Step 3: Add sendMessage and abortSession to ClaudeAgentBackend**

Add these methods to the class in `claude-agent-backend.ts`:

```typescript
    // --- Messaging ---

    async sendMessage(sessionId: string, prompt: any): Promise<void> {
        const text = prompt.text ?? prompt.content ?? "";
        const isLocal = this.localSessions.has(sessionId);
        const cliId = isLocal ? undefined : (this.cliSessionIds.get(sessionId) ?? sessionId);

        // If query is already running, push message into the queue (multi-turn)
        if (this.activeQuery && this.messageQueue && !this.messageQueue.isEnded) {
            this.pushMessage(text, prompt.images);
            return;
        }

        // Start a new query
        await this.startQuery(sessionId, text, prompt.images, cliId);
    }

    async abortSession(_id: string): Promise<void> {
        if (this.abortController) {
            this.abortController.abort();
        }
    }

    /**
     * Start a new SDK query. Follows Clay's sdk-bridge.js startQuery() pattern.
     */
    private async startQuery(
        relaySessionId: string,
        text: string,
        images?: any[],
        resumeId?: string,
    ): Promise<void> {
        const { query: sdkQuery } = await import("@anthropic-ai/claude-agent-sdk");

        // Create message queue and push initial user message
        this.messageQueue = new MessageQueue();
        this.messageQueue.push(this.buildUserMessage(text, images));

        // Create abort controller
        this.abortController = new AbortController();

        // Build query options
        const queryOptions: Record<string, any> = {
            cwd: this.cwd,
            model: this.model,
            allowedTools: this.allowedTools,
            canUseTool: this.handleCanUseTool,
            includePartialMessages: true,
            enableFileCheckpointing: true,
            systemPrompt: { type: "preset", preset: "claude_code" },
            settingSources: ["user", "project"],
            abortController: this.abortController,
        };

        if (this.apiKey) {
            queryOptions.env = { ANTHROPIC_API_KEY: this.apiKey };
        }

        // Resume existing session (SDK-native, not history reconstruction)
        if (resumeId) {
            queryOptions.resume = resumeId;
        }

        // Start the query
        this.activeQuery = sdkQuery({
            prompt: this.messageQueue,
            options: queryOptions,
        });

        // Consume the stream in the background
        const isLocal = this.localSessions.has(relaySessionId);
        this.streamPromise = this.processQueryStream(relaySessionId, isLocal);
    }

    /**
     * Push a follow-up message into the live query's message queue.
     * From Clay's sdk-bridge.js pushMessage() pattern.
     */
    private pushMessage(text: string, images?: any[]): void {
        if (!this.messageQueue || this.messageQueue.isEnded) return;
        this.messageQueue.push(this.buildUserMessage(text, images));
    }

    private buildUserMessage(text: string, images?: any[]): SDKUserMessage {
        const content: any[] = [];
        if (images?.length) {
            for (const img of images) {
                content.push({
                    type: "image",
                    source: { type: "base64", media_type: img.mediaType, data: img.data },
                });
            }
        }
        if (text) {
            content.push({ type: "text", text });
        }
        return {
            type: "user",
            message: { role: "user", content: content.length === 1 && typeof content[0] === "object" && content[0].type === "text" ? text : content },
        };
    }

    /**
     * Consume the SDK query's async generator and pipe translated events
     * to the relay channel. Follows Clay's processQueryStream() pattern.
     */
    private async processQueryStream(relaySessionId: string, isLocal: boolean): Promise<void> {
        try {
            for await (const msg of this.activeQuery!) {
                // Capture cliSessionId on first message (lazy session materialization)
                if (msg.session_id && isLocal) {
                    const localId = relaySessionId;
                    this.cliSessionIds.set(localId, msg.session_id);
                    this.sessionIdMap.set(localId, msg.session_id);
                    this.localSessions.delete(localId);
                    isLocal = false;
                    this.log?.info("Session materialized", { localId, cliSessionId: msg.session_id });
                } else if (msg.session_id) {
                    // Update mapping for non-local sessions
                    this.cliSessionIds.set(relaySessionId, msg.session_id);
                }

                // Translate and push to channel
                const event = translateSdkMessage(msg);
                if (event) {
                    this.channel.push(event);
                }
            }
        } catch (err: any) {
            if (err?.name === "AbortError") {
                this.log?.info("Query aborted");
                // Push a session.updated event so relay knows query ended
                this.channel.push({
                    type: "session.updated",
                    properties: {
                        sessionID: relaySessionId,
                        status: "interrupted",
                    },
                });
            } else {
                this.log?.error("Query stream error", { error: err?.message });
                this.channel.push({
                    type: "session.updated",
                    properties: {
                        sessionID: relaySessionId,
                        status: "error",
                        error: err?.message,
                    },
                });
            }
        } finally {
            // Clean up query state but NOT the channel (it persists between queries)
            this.activeQuery = null;
            this.messageQueue = null;
            this.abortController = null;
        }
    }
```

**Step 4: Run test to verify it passes**

```bash
pnpm vitest run src/lib/backend/claude-agent-messaging.test.ts
```

**Step 5: Run full backend tests**

```bash
pnpm vitest run src/lib/backend/
```

**Step 6: Commit**

```bash
git add src/lib/backend/claude-agent-backend.ts src/lib/backend/claude-agent-messaging.test.ts
git commit -m "feat: ClaudeAgentBackend messaging with MessageQueue multi-turn

SDK-native resume via cliSessionId. pushMessage() for follow-ups
during active query. Session materializes on first SDK message."
```

---

### Task 11: Implement ClaudeAgentBackend — Permission + Question Bridging

**CRITICAL v2 CORRECTION:** The `canUseTool` callback returns `{ behavior: "allow" | "deny" }`, NOT `hookSpecificOutput`. AskUserQuestion returns `{ behavior: "allow", updatedInput: { ...input, answers } }`.

**Files:**
- Modify: `src/lib/backend/claude-agent-backend.ts`
- Create: `src/lib/backend/permission-bridge.test.ts`

**Step 1: Write failing tests**

```typescript
// src/lib/backend/permission-bridge.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
    query: vi.fn(),
    listSessions: vi.fn().mockResolvedValue([]),
    getSessionMessages: vi.fn().mockResolvedValue([]),
    getSessionInfo: vi.fn().mockResolvedValue({}),
}));

import { ClaudeAgentBackend } from "./claude-agent-backend.js";

describe("ClaudeAgentBackend — permission bridge", () => {
    let backend: ClaudeAgentBackend;

    beforeEach(() => {
        vi.clearAllMocks();
        backend = new ClaudeAgentBackend({ cwd: "/tmp/project" });
    });

    it("canUseTool creates a pending permission", async () => {
        // Access the private handler via the exposed test helper
        const handler = (backend as any).handleCanUseTool;
        const opts = { signal: new AbortController().signal };

        // Start the canUseTool promise (it will block)
        const promise = handler("Bash", { command: "ls" }, opts);

        // Should now have a pending permission
        const pending = await backend.listPendingPermissions();
        expect(pending).toHaveLength(1);
        expect(pending[0].tool).toBe("Bash");

        // Resolve it
        await backend.replyPermission({ id: pending[0].id, decision: "allow" } as any);

        // canUseTool should return { behavior: "allow" }
        const result = await promise;
        expect(result).toEqual({ behavior: "allow", updatedInput: { command: "ls" } });
    });

    it("canUseTool returns deny with message", async () => {
        const handler = (backend as any).handleCanUseTool;
        const promise = handler("Write", { path: "/etc/passwd" }, {});

        const pending = await backend.listPendingPermissions();
        await backend.replyPermission({ id: pending[0].id, decision: "deny" } as any);

        const result = await promise;
        expect(result).toEqual({ behavior: "deny", message: "User denied permission" });
    });

    it("AskUserQuestion is handled separately from permissions", async () => {
        const handler = (backend as any).handleCanUseTool;
        const input = {
            question: "How should I format the output?",
            header: "Format",
            options: [{ label: "JSON", description: "Format as JSON" }],
        };
        const opts = { toolUseID: "tu-123", signal: new AbortController().signal };

        const promise = handler("AskUserQuestion", input, opts);

        // Should appear in pending questions, NOT permissions
        const perms = await backend.listPendingPermissions();
        expect(perms).toHaveLength(0);

        const questions = await backend.listPendingQuestions();
        expect(questions).toHaveLength(1);
        expect(questions[0].input).toEqual(input);

        // Answer the question
        await backend.replyQuestion({
            id: questions[0].id,
            answers: { "How should I format the output?": "JSON" },
        } as any);

        // canUseTool returns allow with updatedInput containing answers
        const result = await promise;
        expect(result).toEqual({
            behavior: "allow",
            updatedInput: {
                ...input,
                answers: { "How should I format the output?": "JSON" },
            },
        });
    });

    it("rejectQuestion returns deny", async () => {
        const handler = (backend as any).handleCanUseTool;
        const promise = handler("AskUserQuestion", { question: "What?" }, { toolUseID: "tu-456" });

        const questions = await backend.listPendingQuestions();
        await backend.rejectQuestion(questions[0].id);

        const result = await promise;
        expect(result).toEqual({ behavior: "deny", message: "User rejected question" });
    });

    it("shutdown rejects all pending deferreds", async () => {
        const handler = (backend as any).handleCanUseTool;

        // Create pending permission and question
        const permPromise = handler("Bash", { command: "rm -rf" }, {});
        const questionPromise = handler("AskUserQuestion", { question: "Sure?" }, { toolUseID: "tu-789" });

        // Shutdown
        await backend.shutdown();

        // Both should reject
        await expect(permPromise).rejects.toThrow("Backend shutting down");
        await expect(questionPromise).rejects.toThrow("Backend shutting down");
    });

    it("pending permissions survive and are re-listed on reconnect", async () => {
        const handler = (backend as any).handleCanUseTool;
        handler("Bash", { command: "echo test" }, {});

        // First list
        const pending1 = await backend.listPendingPermissions();
        expect(pending1).toHaveLength(1);

        // Second list (simulating browser reconnect)
        const pending2 = await backend.listPendingPermissions();
        expect(pending2).toHaveLength(1);
        expect(pending2[0].id).toBe(pending1[0].id);
    });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm vitest run src/lib/backend/permission-bridge.test.ts
```

**Step 3: Add permission and question bridging to ClaudeAgentBackend**

```typescript
    // --- Permission & Question Bridging ---

    /**
     * canUseTool callback for the Claude Agent SDK.
     *
     * CRITICAL: Returns { behavior: "allow" | "deny" }, NOT hookSpecificOutput.
     * AskUserQuestion gets special handling — answers are returned via updatedInput.
     *
     * Signature: (toolName, toolInput, options?) where options has signal?: AbortSignal.
     * See design doc "Permission & Question Bridging" section.
     */
    private handleCanUseTool = async (
        toolName: string,
        toolInput: unknown,
        options?: { toolUseID?: string; signal?: AbortSignal },
    ): Promise<{ behavior: "allow" | "deny"; updatedInput?: unknown; message?: string }> => {
        // AskUserQuestion: route to question handling
        if (toolName === "AskUserQuestion") {
            return this.handleAskUserQuestion(toolInput, options);
        }

        // Regular permission request
        const id = crypto.randomUUID();
        const deferred = createDeferred<PermissionDecision>();

        this.pendingPermissions.set(id, {
            deferred,
            metadata: { id, tool: toolName, input: toolInput, timestamp: Date.now() },
        });

        // Notify relay of new permission request
        this.channel.push({
            type: "permission.created",
            properties: { id, tool: toolName, input: toolInput },
        });

        // Handle abort signal (tool use cancelled by SDK)
        if (options?.signal) {
            options.signal.addEventListener("abort", () => {
                const entry = this.pendingPermissions.get(id);
                if (entry) {
                    entry.deferred.reject(new Error("Tool use cancelled"));
                    this.pendingPermissions.delete(id);
                }
            }, { once: true });
        }

        // Block until browser responds — NO TIMEOUT (design doc: deferred stays
        // pending until explicitly resolved, re-shown on reconnect)
        const decision = await deferred.promise;

        if (decision.decision === "allow") {
            return { behavior: "allow", updatedInput: toolInput };
        }
        return { behavior: "deny", message: decision.feedback ?? "User denied permission" };
    };

    /**
     * Handle AskUserQuestion tool — separate from regular permissions.
     * Returns { behavior: "allow", updatedInput: { ...input, answers } }.
     */
    private async handleAskUserQuestion(
        toolInput: unknown,
        options?: { toolUseID?: string; signal?: AbortSignal },
    ): Promise<{ behavior: "allow" | "deny"; updatedInput?: unknown; message?: string }> {
        const id = crypto.randomUUID();
        const toolUseId = options?.toolUseID ?? id;
        const deferred = createDeferred<QuestionAnswer>();

        this.pendingQuestions.set(id, {
            deferred,
            metadata: { id, toolUseId, input: toolInput, timestamp: Date.now() },
        });

        // Push question event — frontend renders question UI
        this.channel.push({
            type: "question.created",
            properties: { id, toolUseId, input: toolInput },
        });

        if (options?.signal) {
            options.signal.addEventListener("abort", () => {
                const entry = this.pendingQuestions.get(id);
                if (entry) {
                    entry.deferred.reject(new Error("Question cancelled"));
                    this.pendingQuestions.delete(id);
                }
            }, { once: true });
        }

        try {
            const answer = await deferred.promise;
            return {
                behavior: "allow",
                updatedInput: { ...(toolInput as object), answers: answer.answers },
            };
        } catch {
            return { behavior: "deny", message: "User rejected question" };
        }
    }

    async listPendingPermissions() {
        return [...this.pendingPermissions.values()].map((p) => p.metadata);
    }

    async replyPermission(options: { id: string; decision: string; feedback?: string }) {
        const entry = this.pendingPermissions.get(options.id);
        if (entry) {
            entry.deferred.resolve({
                decision: options.decision === "deny" ? "deny" : "allow",
                feedback: options.feedback,
            });
            this.pendingPermissions.delete(options.id);
        }
    }

    async listPendingQuestions() {
        return [...this.pendingQuestions.values()].map((q) => q.metadata);
    }

    async replyQuestion(options: { id: string; answers: Record<string, string> }) {
        const entry = this.pendingQuestions.get(options.id);
        if (entry) {
            entry.deferred.resolve({ answers: options.answers });
            this.pendingQuestions.delete(options.id);
        }
    }

    async rejectQuestion(id: string) {
        const entry = this.pendingQuestions.get(id);
        if (entry) {
            entry.deferred.reject(new Error("User rejected question"));
            this.pendingQuestions.delete(id);
        }
    }
```

**Step 4: Run test to verify it passes**

```bash
pnpm vitest run src/lib/backend/permission-bridge.test.ts
```

**Step 5: Run all backend tests**

```bash
pnpm vitest run src/lib/backend/
```

**Step 6: Commit**

```bash
git add src/lib/backend/claude-agent-backend.ts src/lib/backend/permission-bridge.test.ts
git commit -m "feat: ClaudeAgentBackend permission and question bridging

canUseTool returns { behavior: 'allow'|'deny' } (v2 audit fix).
AskUserQuestion: { behavior: 'allow', updatedInput: { answers } }.
No timeout on deferreds. Rejected on shutdown. Re-shown on reconnect."
```

---

### Task 12: Phase 3 Integration and Verification

**Files:**
- Modify: `src/lib/relay/relay-stack.ts` — add backend factory
- Modify: `src/lib/backend/index.ts` — barrel export
- Create: `test/integration/flows/claude-agent-backend.integration.ts`

**Step 1: Create barrel export**

```typescript
// src/lib/backend/index.ts
export type { SessionBackend, InfraClient, BackendEvent } from "./types.js";
export { OpenCodeBackend } from "./opencode-backend.js";
export { ClaudeAgentBackend } from "./claude-agent-backend.js";
export { AsyncEventChannel } from "./async-event-channel.js";
export { MessageQueue } from "./message-queue.js";
export { createDeferred } from "./deferred.js";
export type { Deferred } from "./deferred.js";
```

**Step 2: Add backend factory to relay stack**

```typescript
// In relay-stack.ts, add a factory function:
import { OpenCodeBackend, ClaudeAgentBackend, type SessionBackend } from "../backend/index.js";

function createSessionBackend(
    config: ProjectRelayConfig,
    client: RelayClient,
    registry: ServiceRegistry,
    log: Logger,
): SessionBackend {
    if (config.backendType === "claude-agent") {
        return new ClaudeAgentBackend({
            cwd: config.projectDir,
            apiKey: config.anthropicApiKey,
            model: config.defaultModel,
            allowedTools: config.allowedTools,
            log,
        });
    }
    return new OpenCodeBackend({
        client,
        sseConfig: {
            registry,
            baseUrl: config.opencodeUrl,
            authHeaders: client.getAuthHeaders(),
            log,
        },
    });
}
```

**Step 3: Write integration tests (conditional on API key)**

```typescript
// test/integration/flows/claude-agent-backend.integration.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ClaudeAgentBackend } from "../../../src/lib/backend/claude-agent-backend.js";

const API_KEY = process.env.ANTHROPIC_API_KEY;

describe.skipIf(!API_KEY)("ClaudeAgentBackend integration", () => {
    let backend: ClaudeAgentBackend;

    beforeAll(async () => {
        backend = new ClaudeAgentBackend({
            cwd: process.cwd(),
            apiKey: API_KEY,
            model: "claude-sonnet-4-20250514",
            allowedTools: ["Read", "Glob", "Grep"],
        });
        await backend.initialize();
    });

    afterAll(async () => {
        await backend.shutdown();
    });

    it("can list sessions", async () => {
        const sessions = await backend.listSessions();
        expect(Array.isArray(sessions)).toBe(true);
    });

    it("can create a local session placeholder", async () => {
        const session = await backend.createSession();
        expect(session.id).toMatch(/^local-/);
    });
});
```

**Step 4: Run verification**

```bash
pnpm check
pnpm lint
pnpm test:unit
```

**Step 5: Commit**

```bash
git commit -am "feat: Phase 3 complete — ClaudeAgentBackend with backend factory

Integration tests conditional on ANTHROPIC_API_KEY."
```

---

## Phase 4: Model-Level Backend Switching

### Task 13: BackendProxy Pattern

Instead of swapping a field on every component when the backend changes, all components hold a reference to a `BackendProxy` that indirects through the currently active backend. Swapping updates the proxy target; existing references see the new backend immediately.

**Files:**
- Create: `src/lib/backend/backend-proxy.ts`
- Create: `src/lib/backend/backend-proxy.test.ts`

**Step 1: Write failing tests**

```typescript
// src/lib/backend/backend-proxy.test.ts
import { describe, it, expect, vi } from "vitest";
import { BackendProxy } from "./backend-proxy.js";
import type { SessionBackend } from "./types.js";

function mockBackend(type: "opencode" | "claude-agent"): SessionBackend {
    return {
        type,
        initialize: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
        getHealth: vi.fn().mockResolvedValue({ ok: true }),
        listSessions: vi.fn().mockResolvedValue([{ id: `${type}-s1` }]),
        getSession: vi.fn().mockResolvedValue({ id: `${type}-s1` }),
        createSession: vi.fn().mockResolvedValue({ id: `${type}-s2` }),
        deleteSession: vi.fn().mockResolvedValue(undefined),
        updateSession: vi.fn().mockResolvedValue({ id: `${type}-s1` }),
        getSessionStatuses: vi.fn().mockResolvedValue({}),
        getMessages: vi.fn().mockResolvedValue([]),
        getMessage: vi.fn().mockResolvedValue({ id: "m1" }),
        getMessagesPage: vi.fn().mockResolvedValue([]),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        abortSession: vi.fn().mockResolvedValue(undefined),
        listPendingPermissions: vi.fn().mockResolvedValue([]),
        replyPermission: vi.fn().mockResolvedValue(undefined),
        listPendingQuestions: vi.fn().mockResolvedValue([]),
        replyQuestion: vi.fn().mockResolvedValue(undefined),
        rejectQuestion: vi.fn().mockResolvedValue(undefined),
        listAgents: vi.fn().mockResolvedValue([]),
        listProviders: vi.fn().mockResolvedValue({ providers: [] }),
        listCommands: vi.fn().mockResolvedValue([]),
        listSkills: vi.fn().mockResolvedValue([]),
        getConfig: vi.fn().mockResolvedValue({}),
        updateConfig: vi.fn().mockResolvedValue({}),
        subscribeEvents: vi.fn(),
        // OpenCode backend has optional methods
        ...(type === "opencode" ? {
            forkSession: vi.fn().mockResolvedValue({ id: "fork" }),
            revertSession: vi.fn().mockResolvedValue(undefined),
            unrevertSession: vi.fn().mockResolvedValue(undefined),
        } : {}),
    } as unknown as SessionBackend;
}

describe("BackendProxy", () => {
    it("delegates to the active backend", async () => {
        const oc = mockBackend("opencode");
        const proxy = new BackendProxy(oc);

        await proxy.listSessions();
        expect(oc.listSessions).toHaveBeenCalled();
    });

    it("type reflects the active backend", () => {
        const oc = mockBackend("opencode");
        const proxy = new BackendProxy(oc);
        expect(proxy.type).toBe("opencode");
    });

    it("swap changes the active backend", async () => {
        const oc = mockBackend("opencode");
        const ca = mockBackend("claude-agent");
        const proxy = new BackendProxy(oc);

        proxy.swap(ca);

        expect(proxy.type).toBe("claude-agent");
        await proxy.listSessions();
        expect(ca.listSessions).toHaveBeenCalled();
        expect(oc.listSessions).not.toHaveBeenCalled();
    });

    it("existing references see the new backend after swap", async () => {
        const oc = mockBackend("opencode");
        const ca = mockBackend("claude-agent");
        const proxy = new BackendProxy(oc);

        // Simulate a handler holding a reference
        const handler = { backend: proxy as SessionBackend };

        proxy.swap(ca);

        // The handler's reference now sees the new backend
        await handler.backend.listSessions();
        expect(ca.listSessions).toHaveBeenCalled();
    });

    it("optional methods are present when active backend has them", () => {
        const oc = mockBackend("opencode");
        const proxy = new BackendProxy(oc);
        expect(proxy.forkSession).toBeDefined();
    });

    it("optional methods are absent when active backend lacks them", () => {
        const ca = mockBackend("claude-agent");
        const proxy = new BackendProxy(ca);
        expect(proxy.forkSession).toBeUndefined();
    });

    it("optional methods update after swap", () => {
        const oc = mockBackend("opencode");
        const ca = mockBackend("claude-agent");
        const proxy = new BackendProxy(oc);

        expect(proxy.forkSession).toBeDefined();
        proxy.swap(ca);
        expect(proxy.forkSession).toBeUndefined();
    });

    it("emits swap event", () => {
        const oc = mockBackend("opencode");
        const ca = mockBackend("claude-agent");
        const proxy = new BackendProxy(oc);

        const handler = vi.fn();
        proxy.onSwap(handler);
        proxy.swap(ca);

        expect(handler).toHaveBeenCalledWith(ca, oc);
    });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm vitest run src/lib/backend/backend-proxy.test.ts
```

**Step 3: Implement BackendProxy**

```typescript
// src/lib/backend/backend-proxy.ts
import type { SessionBackend, BackendEvent } from "./types.js";

type SwapHandler = (newBackend: SessionBackend, oldBackend: SessionBackend) => void;

/**
 * Proxy that indirects through the currently active SessionBackend.
 * All components (SessionManager, pollers, handlers) hold a reference
 * to the proxy. Swapping the active backend updates the proxy target,
 * and all existing references see the new backend immediately.
 *
 * This avoids tearing down and rebuilding the component graph on
 * backend switch (design doc Phase 4: BackendProxy pattern).
 *
 * Uses a JavaScript Proxy for transparent delegation. The proxy
 * intercepts property access and delegates to the current target.
 */
export class BackendProxy {
    private target: SessionBackend;
    private swapHandlers: SwapHandler[] = [];
    private readonly proxy: SessionBackend;

    constructor(initial: SessionBackend) {
        this.target = initial;

        // Create a JS Proxy that delegates all property access to this.target
        this.proxy = new Proxy(this as unknown as SessionBackend, {
            get: (_, prop: string | symbol) => {
                // BackendProxy's own methods
                if (prop === "swap" || prop === "onSwap" || prop === "getTarget" || prop === "getProxy") {
                    return (this as any)[prop].bind(this);
                }
                // Delegate to active backend
                const value = (this.target as any)[prop];
                if (typeof value === "function") {
                    return value.bind(this.target);
                }
                return value;
            },
            has: (_, prop: string | symbol) => {
                return prop in this.target;
            },
        });
    }

    /** Get the transparent proxy that implements SessionBackend. */
    getProxy(): SessionBackend {
        return this.proxy;
    }

    /** Get the current underlying backend (for direct access). */
    getTarget(): SessionBackend {
        return this.target;
    }

    /** Swap the active backend. All existing proxy references see the new backend. */
    swap(newBackend: SessionBackend): void {
        const old = this.target;
        this.target = newBackend;
        for (const handler of this.swapHandlers) {
            handler(newBackend, old);
        }
    }

    /** Register a handler called on every backend swap. */
    onSwap(handler: SwapHandler): void {
        this.swapHandlers.push(handler);
    }

    // Convenience accessors that forward to the proxy
    get type() { return this.target.type; }
    get forkSession() { return this.target.forkSession; }
    get revertSession() { return this.target.revertSession; }
    get unrevertSession() { return this.target.unrevertSession; }
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm vitest run src/lib/backend/backend-proxy.test.ts
```

**Step 5: Commit**

```bash
git add src/lib/backend/backend-proxy.ts src/lib/backend/backend-proxy.test.ts
git commit -m "feat: BackendProxy for non-disruptive backend switching

Components hold proxy reference. Swap updates target, all existing
references see new backend immediately. Emits swap event."
```

---

### Task 14: Backend Switching Logic + Provider Routing

Wire the BackendProxy into the relay stack. Implement provider-based backend routing. Handle active query abort, pending permission rejection, and `backend_switched` event on switch. Cross-backend history prepending on first message.

**Files:**
- Modify: `src/lib/relay/relay-stack.ts` — hold both backends + BackendProxy, switch on model change
- Modify: `src/lib/handlers/model.ts` — trigger backend switch based on provider detection
- Create: `src/lib/backend/backend-router.ts` — provider-based backend selection
- Create: `src/lib/backend/backend-router.test.ts`

**Step 1: Write failing tests for backend router**

```typescript
// src/lib/backend/backend-router.test.ts
import { describe, it, expect } from "vitest";
import { selectBackendType } from "./backend-router.js";

describe("selectBackendType", () => {
    it("returns claude-agent for anthropic subscription", () => {
        expect(selectBackendType({ provider: "anthropic", authType: "subscription" }))
            .toBe("claude-agent");
    });

    it("returns opencode for anthropic with API key", () => {
        expect(selectBackendType({ provider: "anthropic", authType: "api-key" }))
            .toBe("opencode");
    });

    it("returns opencode for non-anthropic providers", () => {
        expect(selectBackendType({ provider: "openai" })).toBe("opencode");
        expect(selectBackendType({ provider: "google" })).toBe("opencode");
        expect(selectBackendType({ provider: "ollama" })).toBe("opencode");
    });

    it("returns opencode when provider is unknown", () => {
        expect(selectBackendType({})).toBe("opencode");
    });
});
```

**Step 2: Implement backend router**

```typescript
// src/lib/backend/backend-router.ts

/**
 * Provider-based backend selection.
 * Anthropic subscription accounts -> Claude Agent SDK backend.
 * Everything else -> OpenCode backend.
 *
 * See design doc "Backend routing: Provider-based detection".
 */
export function selectBackendType(
    context: { provider?: string; authType?: string },
): "opencode" | "claude-agent" {
    if (context.provider === "anthropic" && context.authType === "subscription") {
        return "claude-agent";
    }
    return "opencode";
}
```

**Step 3: Wire BackendProxy into relay stack**

In `relay-stack.ts`, construct both backends and the proxy:

```typescript
// Construct both backends
const opencodeBackend = new OpenCodeBackend({ client, sseConfig: { ... } });

const claudeAgentBackend = new ClaudeAgentBackend({
    cwd: config.projectDir,
    apiKey: config.anthropicApiKey,
    model: config.defaultModel,
    log: loggers.session,
});

// BackendProxy starts with OpenCode as default
const backendProxy = new BackendProxy(opencodeBackend);
const sessionBackend = backendProxy.getProxy();

// Pass proxy to all consumers — they hold this reference permanently
const sessionMgr = new SessionManager({ backend: sessionBackend, log: loggers.session, ... });
// handler deps, pollers, etc. all receive sessionBackend (the proxy)
```

Register swap handler to broadcast `backend_switched`:

```typescript
backendProxy.onSwap(async (newBackend, oldBackend) => {
    // 1. Abort active query on old backend
    await oldBackend.abortSession("*").catch(() => {});

    // 2. Shut down old backend's event stream
    // (new backend's events will flow through the proxy)

    // 3. Initialize new backend if needed
    await newBackend.initialize();

    // 4. Broadcast backend_switched to all connected browsers
    wsHandler.broadcast({
        type: "backend_switched",
        backendType: newBackend.type,
    });
});
```

**Step 4: Add backend switch to model handler**

In `src/lib/handlers/model.ts`, when the user selects a model:

```typescript
// After determining the new model's provider:
const requiredBackend = selectBackendType({ provider, authType });
if (requiredBackend !== deps.sessionBackend.type) {
    // Backend switch needed
    const backends = deps.backendRegistry; // Map of available backends
    const target = backends.get(requiredBackend);
    if (target) {
        deps.backendProxy.swap(target);
    }
}
```

**Step 5: Run verification**

```bash
pnpm check
pnpm lint
pnpm test:unit
```

**Step 6: Commit**

```bash
git commit -am "feat: provider-based backend switching via BackendProxy

Anthropic subscription -> Claude Agent SDK, all else -> OpenCode.
Aborts old backend, broadcasts backend_switched to frontends."
```

---

### Task 15: Frontend Backend Awareness

Handle `backend_switched` message. Merge session lists from all backends. Tag sessions with backend type. Hide unsupported operations.

**Files:**
- Modify: `src/lib/frontend/src/stores/` — handle `backend_switched`, refresh sessions
- Modify: `src/lib/frontend/src/components/` — hide fork/revert buttons when backend doesn't support them

**Step 1: Handle backend_switched in WebSocket message store**

When the frontend receives `backend_switched`:
1. Clear the current session list cache
2. Request a fresh session list from the server
3. Update the active backend type in the store

```typescript
// In the message handler switch:
case "backend_switched":
    activeBackendType.set(msg.backendType);
    // Clear stale caches
    sessions.set([]);
    // Re-request session list
    ws.send(JSON.stringify({ type: "get_sessions" }));
    break;
```

**Step 2: Tag sessions with backend type**

Sessions from the server should include a `backendType` field. The session list merges sessions from all backends. Display a subtle indicator (e.g., "via Claude" or "via OpenCode") on each session.

**Step 3: Hide unsupported operations**

```svelte
<!-- In session actions component -->
{#if activeBackendType !== "claude-agent"}
    <button on:click={handleFork}>Fork</button>
    <button on:click={handleRevert}>Revert</button>
{/if}
```

Or more robustly, the server can send a `capabilities` object with the session list:
```typescript
{
    type: "session_list",
    sessions: [...],
    capabilities: {
        fork: true,
        revert: true,
        unrevert: true,
    }
}
```

**Step 4: Run verification**

```bash
pnpm check
pnpm lint
pnpm test:unit
```

**Step 5: Commit**

```bash
git commit -am "feat: frontend handles backend switching

Merged session list, backend type tags, hide unsupported ops."
```

---

---

## Task-Specific Audit Amendments

> **For Agent:** Read these amendments BEFORE implementing each task. They override the task code where they conflict.

### Task 1 Amendments

1. **BackendEvent must be typed.** Replace `{ type: string; properties: Record<string, unknown> }` with `type BackendEvent = KnownOpenCodeEvent | BaseOpenCodeEvent` (from `src/lib/types.ts`). This preserves the discriminated union for downstream EventTranslator.
2. **`listPendingPermissions` must include `permission` field.** Change return to `Promise<Array<{ id: string; permission: string; [key: string]: unknown }>>`.
3. **Structural test must check signatures, not just names.** Use `Pick<>`-based assignability: `expectTypeOf<Pick<RelayClient, BackendMethods>>().toMatchTypeOf<Omit<SessionBackend, ...>>()`.

### Task 2 Amendments

1. **Add single-consumer runtime guard** to `next()`: `if (this.resolver) throw new Error("AsyncEventChannel supports only one concurrent consumer");`.
2. **Add test** for double-consume detection.
3. **Add test** for push-then-close interleaving (buffered items delivered before done).
4. **Replace `undefined as any`** with `undefined` + `done: true as const`.

### Task 3 Amendments

1. **Fix import paths:** `Logger` from `"../logger.js"`, `ServiceRegistry` from `"../daemon/service-registry.js"`.
2. **Use static import** for SSEConsumer. No dynamic `await import()`.
3. **Type all delegation methods** with actual interface types, not `any`.
4. **Guard multiple `subscribeEvents()` calls:** Document single-consumer constraint. If called while previous subscription is active, the previous must be aborted first.

### Tasks 4-5 Amendments

1. **Additional files to modify (Task 4/5):**
   - `src/lib/relay/handler-deps-wiring.ts:37` — change `HandlerDepsWiringDeps.client` to `sessionBackend: SessionBackend` + `infraClient: InfraClient`. Update `clientInitDeps` (line 89-91) and `handlerDeps` (line 120-122).
   - `src/lib/relay/monitoring-wiring.ts:44,128` — change `MonitoringWiringDeps.client` to `sessionBackend: Pick<SessionBackend, "getMessages">`.
   - `src/lib/relay/session-lifecycle-wiring.ts:24,68` — same pattern.
   - `src/lib/relay/pty-upstream.ts:21-23` — rename `client` to `infraClient`.
   - `src/lib/relay/relay-stack.ts:355-356` — update SSE wiring lambdas to `sessionBackend.listPendingQuestions()` / `sessionBackend.listPendingPermissions()`.
   - `src/lib/relay/relay-stack.ts:299` — update `ptyDeps` to pass `infraClient`.
   - `src/lib/relay/relay-stack.ts:96-113` — update `RelayStack` interface to expose `sessionBackend`/`infraClient`.
   - `test/helpers/mock-factories.ts:302-323` — update `createMockProjectRelay()`.
2. **`ClientInitDeps` needs only `sessionBackend`** (no `infraClient` needed — all 5 calls are session-backend methods).
3. **Replace `client as unknown as InfraClient`** with `client satisfies InfraClient` or a helper function for compile-time safety.
4. **Startup `client.getConfig()` (line 252) stays as direct `client.getConfig()`** — backend not initialized yet.
5. **SessionManager method list is incomplete.** Also update: `renameSession()` (calls `updateSession`), `loadHistoryByCursorScan()` (calls `getMessagesPage` with limit: 10000).

### Tasks 7-8 Amendments (CRITICAL — translator rewrite needed)

**Task 7:** MessageQueue wraps AsyncEventChannel per directive D5. Import `SDKUserMessage` from SDK instead of hand-rolling.

**Task 8 — Translator must produce events matching EventTranslator type guards:**

1. **`stream_event` (text deltas):** Map `content_block_delta` with `text_delta` to `message.part.delta` with `{ partID, field: "text", delta: text, messageID }`. NOT `message.part.updated`.
2. **`stream_event` (tool use):** Map `content_block_start` with `tool_use` to `message.part.updated` with proper `part` structure including `type`, `callID`, `tool`, `state`.
3. **`assistant` messages:** Must include `cost`, `tokens: { input, output, cache: { read, write } }`, `time: { created, completed }` from `message.usage`. Use `sessionID` not `sessionId`.
4. **`result` messages:** Map to BOTH: (a) `session.status` with `{ status: { type: "idle" } }` for the `done` event path, AND (b) `message.updated` with cost/token data.
5. **`system/init`:** Map to a new relay message type for frontend (tools, model, MCP servers). Forward to frontend per design decision.
6. **`user` messages:** Drop. Relay tracks via PendingUserMessages.
7. **Result subtypes:** `"success"` -> completed. `"error_max_turns"`, `"error_max_budget_usd"` -> completed (with note). `"error_during_execution"` -> error.
8. **System non-init:** Remove `...msg` spread. Extract only specific fields.
9. **Add integration test:** Pipe translator output through `createTranslator().translate()` and verify `RelayMessage` output.
10. **Use `SDKMessage` discriminated union** type, not `Record<string, any>`.

### Task 9 Amendments (MAJOR — concurrent query support)

1. **Per-session query state via `Map<string, QueryState>`:**
   ```typescript
   interface QueryState {
       query: Query;
       messageQueue: MessageQueue;
       abortController: AbortController;
       streamPromise: Promise<void>;
       cliSessionId: string | null;
   }
   private readonly queries = new Map<string, QueryState>();
   ```
2. **Add method stubs** for `sendMessage`, `abortSession`, and all 5 permission methods (throw "Not yet implemented — see Task 10/11") so the class compiles.
3. **Type `activeQuery` properly:** `import type { Query } from "@anthropic-ai/claude-agent-sdk"`.
4. **Fix `getSessionStatuses()`:** Iterate `this.queries` map, return processing status for each active query's session.
5. **Fix `getSessionInfo` call:** Add `{ dir: this.cwd }` option.
6. **Fix `getMessagesPage`:** Use SDK's native `{ limit, offset }` in `getSessionMessages`.
7. **Fix `toMessage`:** Filter to only `"assistant"` and `"user"` types. Use `sessionID` (capital ID).
8. **`subscribeEvents` must NOT close the shared channel:** Use per-subscriber wrapper that breaks iteration on abort without calling `channel.close()`. The shared channel lives for the backend's lifetime.
9. **Add `decisionReason?: string`** to `canUseTool` options type.

### Task 10 Amendments

1. **Use per-session query state.** `sendMessage` looks up or creates `QueryState` for the given session ID.
2. **Remove `buildUserMessage` ternary optimization.** Always return content as array. Match Clay pattern.
3. **Add empty-message guard:** Reject if both `text` and `images` are empty.
4. **Fix `prompt.images` conversion:** `PromptOptions.images` is `string[]` (base64 data URLs). Convert to `{ mediaType, data }` format the SDK expects. Parse data URL: `const [header, data] = img.split(","); const mediaType = header.match(/data:(.*?);/)?.[1] ?? "image/png";`.
5. **Add try/catch around `sdkQuery()` call.** On failure: clean up state, push error event, return.
6. **Remove `systemPrompt` from default options.** Let SDK use its default (Clay pattern).
7. **Clean up pending deferreds in `processQueryStream` finally block:** Reject all pending permissions/questions for this session (same as shutdown pattern).
8. **Add query lifecycle events:** Push `session.updated` with `status: "processing"` at start, `status: "idle"` on normal completion.
9. **Track which session owns each query** via `this.queries` map. `abortSession(id)` only aborts the matching session.
10. **Stub `handleCanUseTool`** in Task 10 as `canUseTool: this.handleCanUseTool ?? undefined` — conditionally included, SDK runs with default permission mode if callback absent.

### Task 11 Amendments (CRITICAL — permission format fixes)

1. **Key questions by `toolUseId`**, not random UUID. The existing handler sends `toolId` (the `toolUseID`). The backend must store and look up by this key.
2. **Handle OpenCode decision vocabulary:** `replyPermission` must map `"reject"` -> deny, `"once"/"always"` -> allow (not check `=== "deny"`).
3. **Accept handler's answer format (`string[][]`)** in `replyQuestion`, or convert at the interface boundary. Define canonical format in `SessionBackend.replyQuestion`.
4. **Never throw from `canUseTool`.** On abort signal: resolve with `{ behavior: "deny", message: "Request cancelled" }`. NOT reject. Match Clay pattern.
5. **Remove try/catch in `handleAskUserQuestion`.** Let `{ behavior: "deny" }` be returned explicitly via `rejectQuestion`, not via catch-all. Fix test to expect resolution, not rejection.
6. **Use existing event types** for permission/question notifications: match the format the existing frontend/EventTranslator expects (e.g., existing permission relay message format), or document that new handling is needed in Task 15.
7. **Add test for concurrent permissions** (SDK calls `canUseTool` in parallel for parallel tool execution).

### Task 12 Amendments

1. **Remove backend factory function.** It conflicts with Task 14's dual-construction + BackendProxy pattern. Task 12 keeps: barrel export + integration test only.
2. **Add `ProjectRelayConfig` fields:** `backendType?: "opencode" | "claude-agent"`, `anthropicApiKey?: string`, `allowedTools?: string[]` to `src/lib/types.ts`.

### Task 13 Amendments (BackendProxy)

1. **Constructor must return the proxy:** Add `return this.proxy as unknown as BackendProxy;` at end of constructor. Or restructure so `new BackendProxy(oc)` IS the proxy.
2. **Remove dead convenience getters** (`get type()`, `get forkSession()`, etc.) — unreachable through the Proxy trap.
3. **Use prototype-based method detection** instead of hardcoded string list: `if (prop in BackendProxy.prototype) return (this as any)[prop].bind(this);`.
4. **Make `SwapHandler` async:** `type SwapHandler = (newBackend, oldBackend) => Promise<void>`. Make `swap()` async and await each handler.
5. **Document: `subscribeEvents` consumers must re-subscribe on swap.** Long-lived async iterables are bound at call time. The `onSwap` handler should restart event subscription on the new backend.
6. **Add `onSwap` unsubscribe:** Return a cleanup function from `onSwap()`.
7. **Clarify dual-reference pattern:** `BackendProxy` for swap-aware consumers (model handler, relay-stack), `getProxy()` as `SessionBackend` for operation-only consumers (SessionManager, pollers, handlers).

### Task 14 Amendments

1. **Add to `HandlerDeps`:** `backendProxy: BackendProxy` and `backendRegistry: Map<string, SessionBackend>`.
2. **Add to `RelayMessage` union:** `{ type: "backend_switched"; backendType: "opencode" | "claude-agent" }` in `src/lib/shared-types.ts`.
3. **Replace `abortSession("*")`** with `await oldBackend.shutdown()` (handles abort + deferred cleanup + channel close).
4. **Add `authType` to `ProjectRelayConfig`:** Detected server-side from env/config. `ANTHROPIC_API_KEY` present + no `OPENCODE_*` config = subscription.
5. **Swap handler must call `oldBackend.shutdown()`** before `newBackend.initialize()`.
6. **Add backend-switch logic to `handleSetDefaultModel`** as well (not just `handleSwitchModel`). Extract shared helper `maybeSwapBackend()`.
7. **Monitoring/lifecycle wiring uses OpenCode backend directly** (not proxy) for poller seeding. Pollers are OpenCode-specific.
8. **Add `capabilities` to session_list response:** `{ fork: boolean; revert: boolean; unrevert: boolean }`. Derived from `typeof backend.forkSession === "function"`.

### Task 15 Amendments (MAJOR — near-complete rewrite needed)

1. **Fix directory paths:** `src/lib/frontend/stores/` (NOT `src/lib/frontend/src/stores/`).
2. **Add `backend_switched` to `RelayMessage` union** in `src/lib/shared-types.ts`.
3. **Add `backendType` to `SessionInfo`** in `src/lib/shared-types.ts`.
4. **Add dispatch case** in `src/lib/frontend/stores/ws-dispatch.ts` `handleMessage()` switch.
5. **Use Svelte 5 `$state` pattern:** Add `backendType` field to existing `discoveryState` (or new backend store). NOT `writable` store.
6. **Use `wsSend()`** (from `ws-send.svelte.ts`), NOT raw `ws.send()`.
7. **Use Svelte 5 `onclick`** syntax, NOT `on:click`.
8. **Use capabilities object** (per design decision): `{#if capabilities.fork}` not `{#if backendType !== "claude-agent"}`.
9. **Enumerate all fork/revert UI touchpoints:** `AssistantMessage.svelte:393-401` (fork-from-here), `SessionContextMenu.svelte:112-122` (Fork menu), `SessionList.svelte:186` (fork handler), `RewindBanner.svelte:46-54` (revert/rewind).
10. **Merged session list:** Server-side merge in session handler (via BackendProxy which delegates to active backend's `listSessions`). No frontend merge.
11. **Add tests** for `backend_switched` handler, session clearing, capability-based UI gating.

---

### Task 16: Phase 4 Final Verification

**Step 1: Full verification**

```bash
pnpm check
pnpm lint
pnpm test:unit
pnpm test:integration
pnpm test:e2e
```

**Step 2: Verify BackendProxy is used everywhere**

```bash
rg "sessionBackend" src/lib/handlers/ src/lib/session/ src/lib/relay/
```

All references should be to the proxy, not direct backend instances.

**Step 3: Manual smoke test**

- Start with OpenCode backend, create sessions, send messages
- Switch to Claude model (Anthropic subscription) -> verify backend switches, session list changes
- Send message through Claude Agent SDK -> verify streaming, permissions work
- AskUserQuestion flows correctly (answers returned via updatedInput)
- Switch back to OpenCode -> verify original sessions are still there
- PTY works throughout regardless of backend
- Fork/revert buttons hidden on Claude Agent SDK sessions
- Reconnecting browser re-shows pending permissions
- Abort during Claude Agent SDK query works

**Step 4: Commit**

```bash
git commit -m "feat: Phase 4 complete — dual SDK with model-level switching

BackendProxy pattern for non-disruptive switching.
Provider-based routing (Anthropic subscription -> Agent SDK).
Merged session list. Frontend hides unsupported ops."
```
