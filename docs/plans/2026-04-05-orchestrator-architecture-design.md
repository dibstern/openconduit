# Orchestrator Architecture Design

**Date:** 2026-04-05
**Status:** Proposed
**Supersedes:** `2026-03-31-dual-sdk-design.md`, `2026-03-31-dual-sdk-plan.md`

## Problem

Conduit is currently a relay — a proxy between OpenCode and the browser. All durable state lives in OpenCode's SQLite database. Conduit caches events in JSONL files for responsiveness but owns nothing.

This creates three problems:

1. **Single-provider lock-in.** The Anthropic Claude Agent SDK can't run through OpenCode — it needs direct integration. The existing dual-SDK plan adds Claude as a second backend but stores Claude session state in memory, losing it on crash or restart.

2. **Fragile caching.** The JSONL `MessageCache` has approximate byte tracking that drifts, a 200ms flush window where data can be lost, synchronous I/O on the flush timer, no indexed queries, no atomic writes, and heuristic stale-tail detection. These are acceptable for a cache but not for a source of truth.

3. **Architectural ceiling.** As long as OpenCode owns session state, conduit can't evolve beyond a relay. Adding features like cross-provider conversation continuity, turn-level cost tracking, durable approval history, or tool activity timelines requires owning the data.

## North Star

Conduit becomes an independent orchestrator that owns all session and message state, uses provider adapters for execution (Claude Agent SDK, OpenCode, eventually others), and eventually owns its own infrastructure (PTY, files, search, VCS — deferred from this design).

## Architectural Identity Shift

**Current principle** (from `docs/agent-guide/architecture.md`):
> "Source of truth: Durable conversation state lives in OpenCode, not relay-owned storage."

**New principle:**
> "Source of truth: Durable conversation state lives in conduit's event store. Provider adapters are execution engines that stream events into the store. OpenCode is one such adapter."

### What Changes

1. **Conduit becomes the orchestrator.** It owns sessions, messages, and event history. Crash recovery, session listing, history pagination — all read from conduit's store.

2. **Provider adapters become stateless execution engines.** An adapter's job: accept a prompt, stream events back, handle permissions/questions, report tool execution. It does not own sessions or messages.

3. **OpenCode's role narrows.** OpenCode is an execution engine that happens to also store data in its own SQLite. Conduit ignores OpenCode's storage and maintains its own. OpenCode's REST API is still used for sending messages and streaming SSE, but `listSessions()` and `getMessages()` read from conduit's store.

4. **The relay pipeline is transitional scaffolding.** It keeps everything working during the migration but is not the target architecture. By the time the Claude adapter lands, most of the relay layer will have been replaced by the event store + projection pipeline.

### What Doesn't Change

- The WebSocket protocol to browsers stays identical
- The frontend is unaffected — same `RelayMessage` types
- PTY, files, search, VCS still delegate to OpenCode (infra layer, deferred)
- The daemon, multi-project model, auth, and CLI stay the same

## SQLite Event Store Schema

Runtime: Node 22+ built-in `node:sqlite`. WAL mode for concurrent reads during writes.

### Event Store

```sql
CREATE TABLE events (
    sequence        INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id        TEXT    NOT NULL UNIQUE,
    session_id      TEXT    NOT NULL,
    stream_version  INTEGER NOT NULL,
    type            TEXT    NOT NULL,
    data            TEXT    NOT NULL,
    metadata        TEXT    NOT NULL DEFAULT '{}',
    provider        TEXT    NOT NULL,
    created_at      INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE UNIQUE INDEX idx_events_session_version
    ON events (session_id, stream_version);
CREATE INDEX idx_events_session_seq
    ON events (session_id, sequence);
CREATE INDEX idx_events_type
    ON events (type);
```

- `sequence` (autoincrement) is the global monotonic order. Gap-free by construction.
- `event_id` (UUID) is a stable external identity, decoupled from sequence order.
- `stream_version` with unique index on `(session_id, stream_version)` provides per-session optimistic concurrency.
- `metadata` is a JSON column carrying causality and adapter context (`commandId`, `causationEventId`, `correlationId`, `adapterKey`, `providerTurnId`). All fields optional.

### Command Receipts

```sql
CREATE TABLE command_receipts (
    command_id      TEXT    PRIMARY KEY,
    session_id      TEXT    NOT NULL,
    status          TEXT    NOT NULL,
    result_sequence INTEGER NOT NULL,
    error           TEXT,
    created_at      INTEGER NOT NULL
);

CREATE INDEX idx_command_receipts_session
    ON command_receipts (session_id);
```

Idempotent command processing. Every command gets a unique ID. Before executing, check if a receipt exists — if accepted, return cached result; if rejected, return cached error. Transient failures don't write receipts, so retries work. Essential for the tRPC transition.

### Projection: Sessions

```sql
CREATE TABLE sessions (
    id              TEXT    PRIMARY KEY,
    provider        TEXT    NOT NULL,
    provider_sid    TEXT,
    title           TEXT    NOT NULL DEFAULT 'Untitled',
    status          TEXT    NOT NULL DEFAULT 'idle',
    parent_id       TEXT,
    fork_point_event TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    FOREIGN KEY (parent_id) REFERENCES sessions(id)
);

CREATE INDEX idx_sessions_updated ON sessions (updated_at DESC);
CREATE INDEX idx_sessions_parent ON sessions (parent_id);
CREATE INDEX idx_sessions_provider ON sessions (provider, provider_sid);
```

Eagerly maintained from events. Could be rebuilt from the event store if corrupted.

### Projection: Messages

```sql
CREATE TABLE messages (
    id              TEXT    PRIMARY KEY,
    session_id      TEXT    NOT NULL,
    turn_id         TEXT,
    role            TEXT    NOT NULL,
    text            TEXT    NOT NULL DEFAULT '',
    parts           TEXT    NOT NULL DEFAULT '[]',
    cost            REAL,
    tokens_in       INTEGER,
    tokens_out      INTEGER,
    tokens_cache_read  INTEGER,
    tokens_cache_write INTEGER,
    is_streaming    INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id),
    FOREIGN KEY (turn_id) REFERENCES turns(id)
);

CREATE INDEX idx_messages_session_created
    ON messages (session_id, created_at);
CREATE INDEX idx_messages_turn ON messages (turn_id);
```

Eliminates the O(events) fold on every session switch. `parts` is a JSON array of part objects (text, thinking, tool calls) — the same shape the frontend already consumes.

### Projection: Turns

```sql
CREATE TABLE turns (
    id              TEXT    PRIMARY KEY,
    session_id      TEXT    NOT NULL,
    state           TEXT    NOT NULL DEFAULT 'pending',
    user_message_id TEXT,
    assistant_message_id TEXT,
    cost            REAL,
    tokens_in       INTEGER,
    tokens_out      INTEGER,
    requested_at    INTEGER NOT NULL,
    started_at      INTEGER,
    completed_at    INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX idx_turns_session_requested
    ON turns (session_id, requested_at);
```

Turn states: `pending → running → completed | interrupted | error`.

### Projection: Session Providers

```sql
CREATE TABLE session_providers (
    id              TEXT    PRIMARY KEY,
    session_id      TEXT    NOT NULL,
    provider        TEXT    NOT NULL,
    provider_sid    TEXT,
    status          TEXT    NOT NULL DEFAULT 'active',
    activated_at    INTEGER NOT NULL,
    deactivated_at  INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX idx_session_providers_session
    ON session_providers (session_id, activated_at DESC);
CREATE INDEX idx_session_providers_active
    ON session_providers (session_id, status) WHERE status = 'active';
```

Tracks provider binding history. Sessions can switch providers mid-conversation. On switch, the current binding is marked `stopped` and a new one is inserted as `active`. `sessions.provider` is denormalized from the active binding.

### Projection: Pending Approvals

```sql
CREATE TABLE pending_approvals (
    id              TEXT    PRIMARY KEY,
    session_id      TEXT    NOT NULL,
    turn_id         TEXT,
    type            TEXT    NOT NULL,
    status          TEXT    NOT NULL DEFAULT 'pending',
    tool_name       TEXT,
    input           TEXT,
    decision        TEXT,
    created_at      INTEGER NOT NULL,
    resolved_at     INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id),
    FOREIGN KEY (turn_id) REFERENCES turns(id)
);

CREATE INDEX idx_pending_approvals_session_status
    ON pending_approvals (session_id, status);
CREATE INDEX idx_pending_approvals_pending
    ON pending_approvals (status) WHERE status = 'pending';
```

Permissions and questions survive restarts. Historically queryable.

### Projection: Activities

```sql
CREATE TABLE activities (
    id              TEXT    PRIMARY KEY,
    session_id      TEXT    NOT NULL,
    turn_id         TEXT,
    tone            TEXT    NOT NULL,
    kind            TEXT    NOT NULL,
    summary         TEXT    NOT NULL,
    payload         TEXT    NOT NULL DEFAULT '{}',
    sequence        INTEGER,
    created_at      INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id),
    FOREIGN KEY (turn_id) REFERENCES turns(id)
);

CREATE INDEX idx_activities_session_created
    ON activities (session_id, created_at);
CREATE INDEX idx_activities_turn ON activities (turn_id);
CREATE INDEX idx_activities_tone ON activities (session_id, tone);
```

Tool invocations, file changes, permission decisions, errors as first-class queryable entities. Tones: `tool`, `approval`, `error`, `info`. Kinds: `file.read`, `file.write`, `bash`, `permission.asked`, `question.asked`, `error.execution`, etc.

### Projector Cursors

```sql
CREATE TABLE projector_cursors (
    projector_name      TEXT    PRIMARY KEY,
    last_applied_seq    INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
);
```

### Storage: Tool Content

```sql
CREATE TABLE tool_content (
    tool_id         TEXT    PRIMARY KEY,
    session_id      TEXT    NOT NULL,
    content         TEXT    NOT NULL,
    created_at      INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX idx_tool_content_session ON tool_content (session_id);
```

Replaces in-memory `ToolContentStore` (500-entry LRU, lost on restart). Now durable and unbounded.

### Storage: Provider State

```sql
CREATE TABLE provider_state (
    session_id      TEXT    NOT NULL,
    key             TEXT    NOT NULL,
    value           TEXT    NOT NULL,
    PRIMARY KEY (session_id, key),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);
```

Per-session provider-specific KV. Stores opaque adapter state (resume cursors, always-allowed tools, CLI session IDs).

### Canonical Event Types

| Event type | Key payload fields |
|---|---|
| `message.created` | messageId, role, sessionId |
| `text.delta` | messageId, partId, text |
| `thinking.delta` | messageId, partId, text |
| `thinking.end` | messageId, partId |
| `tool.started` | messageId, partId, toolName, callId, input |
| `tool.running` | messageId, partId |
| `tool.completed` | messageId, partId, result, duration |
| `turn.completed` | messageId, cost, tokens, duration |
| `turn.error` | messageId, error, code |
| `turn.interrupted` | messageId |
| `session.created` | sessionId, title, provider |
| `session.renamed` | sessionId, title |
| `session.status` | sessionId, status |
| `session.provider_changed` | sessionId, oldProvider, newProvider |
| `permission.asked` | id, sessionId, toolName, input |
| `permission.resolved` | id, decision |
| `question.asked` | id, sessionId, questions |
| `question.resolved` | id, answers |

Each adapter translates its native events into these types before they enter the event store.

## CQRS-Lite Projections

### The Core Loop

```
Command → Receipt Check → Append Event(s) → Run Projectors → Broadcast to WS
```

### Six Projectors

1. **SessionProjector** — handles: `session.created`, `session.renamed`, `session.status`, `session.provider_changed`, `turn.completed`, `turn.error`
2. **MessageProjector** — handles: `message.created`, `text.delta`, `thinking.delta`, `thinking.end`, `tool.started`, `tool.running`, `tool.completed`, `turn.completed`, `turn.error`
3. **TurnProjector** — handles: `message.created` (user), `session.status` (busy), `message.created` (assistant), `turn.completed`, `turn.error`, `turn.interrupted`
4. **ProviderProjector** — handles: `session.created`, `session.provider_changed`, `session.status`
5. **ApprovalProjector** — handles: `permission.asked`, `permission.resolved`, `question.asked`, `question.resolved`
6. **ActivityProjector** — handles: `tool.started`, `tool.running`, `tool.completed`, `permission.asked`, `permission.resolved`, `question.asked`, `question.resolved`, `turn.error`

### Transaction Strategy

Same-transaction (Option A): event insert + all projector updates in one transaction. Consistent by construction. If a projector bugs out, the event is not stored — we know immediately.

### Startup Recovery

1. Read `projector_cursors` → find min `last_applied_seq`
2. Replay events after that sequence through affected projectors
3. Update cursors

### Read Paths

| Query | Source |
|---|---|
| List sessions | `SELECT * FROM sessions ORDER BY updated_at DESC` |
| Get messages | `SELECT * FROM messages WHERE session_id = ? ORDER BY created_at` |
| Paginate messages | `SELECT * FROM messages WHERE session_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?` |
| Session status | `sessions.status` column |
| Pending permissions | `SELECT * FROM pending_approvals WHERE status = 'pending'` |
| Tool content | `SELECT content FROM tool_content WHERE tool_id = ?` |
| Fork metadata | `sessions.parent_id` + `fork_point_event` |

## State Ownership Changes

### Eliminated (code + files deleted)

| Component | Replaced by |
|---|---|
| `MessageCache` class + JSONL files + cache-meta.json | `events` + `messages` tables |
| `ToolContentStore` (in-memory, 500 cap) | `tool_content` table |
| `PendingUserMessages` (30s TTL dedup) | Eliminated — no upstream echo to dedup |
| `cold-cache-repair.ts` | Eliminated — projectors handle incomplete turns |
| `fork-metadata.json` | `sessions.parent_id` + `fork_point_event` |
| Stale-tail detection | Eliminated — conduit is the store |

### Moves to SQLite

| Concern | Old location | New location |
|---|---|---|
| Session records | OpenCode REST | `sessions` table |
| Message history | OpenCode REST + JSONL cache | `messages` table |
| Turn lifecycle | Not tracked | `turns` table |
| Provider bindings | Not tracked | `session_providers` table |
| Pending approvals | In-memory `PermissionBridge` | `pending_approvals` table |
| Tool activities | Embedded in message parts | `activities` table |
| Tool full content | In-memory LRU (500 cap) | `tool_content` table |
| Fork metadata | `fork-metadata.json` | `sessions` columns |
| Provider-specific state | In-memory Maps | `provider_state` KV |
| Parent-child relationships | In-memory `cachedParentMap` | `sessions.parent_id` |

### Stays In-Memory (ephemeral runtime state)

| State | Why |
|---|---|
| `SessionRegistry` (clientId → sessionId) | Live WS connection mapping |
| Pagination cursors | Active scroll state |
| Poller diff baselines, SSE tracking | Adapter-internal, rebuilt on reconnect |
| WS handles, rate limiter, message queues | Connection-level state |
| PTY sessions + scrollback | Inherently ephemeral (deferred with infra) |
| Processing timers | Runtime UI signal |
| `Deferred` handles for approvals | Runtime promise handles, not serializable |

### Stays In Files (daemon config)

| File | Why |
|---|---|
| `daemon.json` | Process lifecycle, project registry, instance config |
| `settings.jsonc` | Global user preferences |
| `recent.json` | Recently used projects list |
| `vapid.json` + `push-subs.json` | Push notification infra (orthogonal to conversation state) |

### Becomes Adapter-Internal

| State | Current location | New location |
|---|---|---|
| `EventTranslator.sessionParts` | Core relay closure | OpenCode adapter |
| `MonitoringState` + `doneDeliveredByPrimary` | Core relay closure | OpenCode adapter |
| Message poller state | Core relay | OpenCode adapter |

## Migration Strategy

### Three Stages

**Stage 1: Dual-Write.** Events flow into both JSONL and SQLite. Nothing reads from SQLite. Validates correctness.

**Stage 2: Read Switchover.** Read paths move from JSONL/REST to SQLite one at a time, in order of increasing risk:
1. Tool content reads (one handler, one caller)
2. Fork metadata reads (simple column query)
3. Session list reads (compare against REST during transition)
4. Session status reads (projector replaces poller)
5. Session switch history (biggest change — `resolveSessionHistory()` becomes a single query)
6. Pending permissions reads (projection replaces in-memory Map + REST)

Each sub-phase is independently deployable and revertable.

**Stage 3: Cleanup.** Delete MessageCache, JSONL files, ToolContentStore, PendingUserMessages, stale-tail detection, cold-cache repair.

### Seeding

On first startup with empty SQLite:
1. Import existing JSONL cache files (convert `RelayMessage` → canonical events)
2. Seed from OpenCode REST for sessions not in cache
3. On subsequent restarts, incremental seed for sessions created via CLI while conduit was down

## Provider Adapter Interface

```typescript
interface ProviderAdapter {
    readonly providerId: string;
    discover(): Promise<AdapterCapabilities>;
    sendTurn(input: SendTurnInput): Promise<TurnResult>;
    interruptTurn(sessionId: string): Promise<void>;
    resolvePermission(sessionId: string, requestId: string,
        decision: PermissionDecision): Promise<void>;
    resolveQuestion(sessionId: string, requestId: string,
        answers: Record<string, unknown>): Promise<void>;
    shutdown(): Promise<void>;
}
```

Seven methods. Down from ~30 in the old `SessionBackend` design. Adapters are execution-only — they don't own sessions, messages, or history. Conduit owns all state. Adapters turn prompts into event streams.

### Key Types

- **`SendTurnInput`**: sessionId, turnId, prompt, history (full prior conversation in canonical form), providerState (opaque KV from `provider_state`), model, variant, workspaceRoot, eventSink, abortSignal.
- **`TurnResult`**: status, cost, tokens, durationMs, error, providerStateUpdates (KV entries to persist).
- **`EventSink`**: `push(event)` writes to event store. `requestPermission(request)` blocks until user decides. `requestQuestion(request)` blocks until user answers.
- **`AdapterCapabilities`**: models, supportsTools, supportsThinking, supportsPermissions, supportsQuestions, supportsAttachments, supportsFork, supportsRevert, commands.
- **`CommandInfo`**: name, description, source (builtin | user-command | project-command | user-skill | project-skill).

### Provider Switching

When a user switches from OpenCode to Claude mid-conversation:

1. Conduit emits `session.provider_changed` event
2. ProviderProjector marks old binding stopped, inserts new active binding
3. SessionProjector updates `sessions.provider` (denormalized)
4. Next `sendTurn` goes to the Claude adapter with full prior history in canonical form
5. The Claude adapter formats history as Claude SDK input and starts the turn

The adapter doesn't know or care that previous turns came from a different provider.

## Claude Agent SDK Adapter

### SDK Architecture

The SDK's `query()` function is a long-lived session. Called once per session, it takes an `AsyncIterable<SDKUserMessage>` as input and returns an `AsyncIterable<SDKMessage>` as output. Multi-turn works by feeding new messages into the input iterable.

### Adapter Implementation

- One `query()` per conduit session (not per turn)
- `sendTurn()` enqueues a message into the existing prompt queue
- A background consumer reads SDK output events and calls `eventSink.push()` for each
- Permission bridging: SDK `canUseTool` callback → `eventSink.requestPermission()` → blocks until user decides
- Session resume: `query({ options: { resume: sessionId } })` using cursor from `provider_state`
- Fallback: if resume cursor is invalid (session expired), start fresh with history preamble

### Tool Handling

The Claude Agent SDK manages its own tool set (Bash, Read, Write, Edit, etc.). The adapter does not define tools. It receives tool invocations as events and maps them to canonical types. Tool permissions are controlled via the `canUseTool` callback or `permissionMode: 'bypassPermissions'`.

### Command & Skill Discovery

Claude commands come from multiple sources via `settingSources`:
- Built-in commands (`/init`, `/memory`, `/compact`, `/cost`, etc.)
- User commands (`~/.claude/commands/*.md`)
- Project commands (`<project>/.claude/commands/*.md`)
- User skills (`~/.claude/skills/*/SKILL.md`)
- Project skills (`<project>/.claude/skills/*/SKILL.md`)

The adapter's `discover()` enumerates all sources. Conduit's command autocomplete merges conduit-native commands + active provider commands.

### Capabilities

| Feature | Supported |
|---|---|
| Models | Opus, Sonnet, Haiku (varies by subscription) |
| Thinking / effort | low, medium, high, max, ultrathink (prompt-injected) |
| Permissions | canUseTool callback, bypassPermissions mode |
| Questions | Via AskUserQuestion tool |
| Mid-session model switch | `query.setModel()` |
| Fork | Not supported |
| Revert | Not supported |

## Phasing and Delivery Order

| Phase | Goal | Effort | Risk |
|---|---|---|---|
| 1. Foundation | SQLite, schema, event store primitives | 1-2 days | Low |
| 2. Dual-Write | Events flow to both JSONL and SQLite | 2-3 days | Low |
| 3. Projections | All 6 projectors running | 4-5 days | Medium |
| 4. Read Switchover | Reads migrate to SQLite (6 sub-phases) | 5-7 days | Medium-high |
| 5. Provider Adapter | Extract interface, OpenCode adapter | 4-6 days | Medium |
| 6. Claude Adapter | Claude Agent SDK integration | 5-8 days | Medium |
| 7. Cleanup | Delete transitional code | 1-2 days | Low |

**Total:** 3-5 weeks. Each phase is independently valuable and shippable.

### Go/No-Go Checkpoints

1. **After Phase 3:** Is projection data consistent with JSONL data?
2. **After Phase 4e:** Is session switch performance acceptable?
3. **After Phase 6:** Does Claude adapter work reliably?

### Rollback Strategy

- Phases 1-2: Disable SQLite writes via feature flag
- Phase 3: Disable projectors
- Phase 4: Each sub-phase has its own revert
- Phase 5: Revert adapter refactor PR
- Phase 6: Disable Claude adapter registration
- Phase 7: Point of no return — enter only when Phases 1-6 are stable

## Schema Summary

11 tables total:

| Table | Role |
|---|---|
| `events` | Event store (source of truth) |
| `command_receipts` | Command deduplication |
| `sessions` | Projection: session list |
| `messages` | Projection: assembled messages |
| `turns` | Projection: turn lifecycle |
| `session_providers` | Projection: provider bindings |
| `pending_approvals` | Projection: live approval state |
| `activities` | Projection: tool/approval/error timeline |
| `projector_cursors` | Projection recovery |
| `tool_content` | Storage: full truncated content |
| `provider_state` | Storage: provider-specific KV |
