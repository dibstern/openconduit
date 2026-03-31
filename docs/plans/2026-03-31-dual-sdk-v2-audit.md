# Dual SDK Plan v2 — Audit Synthesis

**Plan:** `docs/plans/2026-03-31-dual-sdk-plan.md`
**Audits:** `docs/plans/audits/dual-sdk-v2-task-{1,2,3,9,10,11,12,13,14,15}.md`, `dual-sdk-v2-tasks-{4-5,7-8}.md`
**Auditors dispatched:** 12 (one per task or task group)
**Total findings:** ~117 Amend Plan, ~13 Ask User, ~23 Accept

---

## Cross-Cutting Themes

Many findings repeat across tasks. The fixer should address these as systemic amendments, not task-by-task patches.

### Theme A: Pervasive `any` Typing (Tasks 3, 9, 10, 11)

~30 findings across 4 tasks. Every `ClaudeAgentBackend` method returns `as any`. All delegation methods in `OpenCodeBackend` use `any` parameters. `activeQuery` is typed `any | null`.

**Fix:** Use actual interface types from `types.ts` for all parameters and returns. Type `activeQuery` as `import("@anthropic-ai/claude-agent-sdk").Query | null`. Import `SDKMessage` discriminated union for the translator instead of `Record<string, any>`.

### Theme B: Shared Channel Closure Bug (Tasks 2, 9, 10)

The `ClaudeAgentBackend` has one long-lived `AsyncEventChannel`. `subscribeEvents()` registers an abort handler that calls `channel.close()`. After close, ALL future events are silently dropped — the channel is permanently dead. This is the single most dangerous bug in the plan.

**Fix:** Don't close the shared channel on subscriber abort. Use a per-subscriber wrapper that breaks iteration without closing the underlying channel. Add single-consumer runtime guard.

### Theme C: SDKMessage Translator is Structurally Incompatible (Tasks 7-8)

3 critical findings: (1) No `done` event path — `result` maps to `session.updated` which is explicitly SKIPPED by EventTranslator. (2) `stream_event` mapped to `message.part.updated` fails the type guard (no `properties.part`). (3) `message.updated` lacks `cost/tokens/time` structure.

**Fix:** Complete rewrite of translator to produce events matching the exact property shapes validated by EventTranslator type guards. Decompose `stream_event` into `message.part.delta`. Map `result` to `session.status` with `idle` type for `done` path. Include usage data from `message.usage`.

### Theme D: Missing Files/Wiring Not Enumerated (Tasks 4-5, 12, 14)

Multiple files holding `client: OpenCodeClient` are not listed: `monitoring-wiring.ts`, `session-lifecycle-wiring.ts`, `handler-deps-wiring.ts`, `pty-upstream.ts`, `RelayStack` interface, `createMockProjectRelay()`. SSE wiring lambdas in relay-stack.ts need re-routing. `ProjectRelayConfig` lacks 4 required fields.

**Fix:** Add all missing files to Task 4-5 modification lists. Add `backendType`, `anthropicApiKey`, `defaultModel`, `allowedTools` to `ProjectRelayConfig`.

### Theme E: Permission/Question Format Mismatches (Task 11)

5 critical findings: (1) `replyPermission` checks `=== "deny"` but handler sends `"reject"`. (2) Question ID keyed by random UUID but handler sends `toolUseId`. (3) Answer format is `Record<string,string>` but handler sends `string[][]`. (4) `handleAskUserQuestion` try/catch converts shutdown rejection to `{ behavior: "deny" }` but test expects rejection. (5) Event types `permission.created`/`question.created` don't exist downstream.

**Fix:** Use OpenCode decision vocabulary (`"reject"` = deny). Key questions by `toolUseId`. Accept handler's answer format or convert. Remove try/catch or fix test. Use existing event types.

### Theme F: BackendProxy Constructor Doesn't Return Proxy (Task 13)

`new BackendProxy(oc)` returns the raw BackendProxy instance, not the JS Proxy. All tests call methods directly on BackendProxy which has no `listSessions`, etc. Tests will fail.

**Fix:** Add `return this.proxy;` at end of constructor. Remove dead convenience getters. Use prototype-based method detection instead of hardcoded strings.

### Theme G: Phase 4 Underspecified (Tasks 14, 15)

Task 14: `HandlerDeps` missing `backendProxy`/`backendRegistry`. `RelayMessage` missing `backend_switched`. `abortSession("*")` invalid. `authType` has no source. Swap handler is async in sync callback. Missing `oldBackend.shutdown()`.

Task 15: Wrong directory paths. Svelte 4 syntax in Svelte 5 codebase. Missing store definition. Missing `SessionInfo.backendType`. No dispatch wiring. No tests. Capabilities vs string comparison undecided.

### Theme H: Phase 1 Prerequisite Not Gated (Tasks 1, 3, 4-5, 12)

Every task imports from `relay-types.ts` and `sdk-client.ts` which don't exist yet. Need explicit verification step.

### Theme I: MessageQueue Duplicates AsyncEventChannel (Tasks 2, 7)

`MessageQueue` is near-identical to `AsyncEventChannel`. Should wrap it.

### Theme J: Task 12 vs Task 14 Architecture Conflict

Task 12 creates a factory that picks one backend based on config. Task 14 pre-constructs both and swaps via BackendProxy. These are contradictory.

**Fix:** Remove factory from Task 12. Defer to Task 14's dual-construction approach.

---

## Ask User (13 findings)

| # | Task | Question |
|---|------|----------|
| 1 | T2 | Single-consumer on ClaudeAgentBackend channel acceptable, or need fan-out? |
| 2 | T3 | Should `getSSEConsumer()` accessor exist (coupling), or internalize SSE wiring? |
| 3 | T4-5 | Should `PtyUpstreamDeps.client` be renamed to `infraClient`? |
| 4 | T4-5 | Should `client.getConfig()` at relay startup go through `sessionBackend` or stay as `client`? |
| 5 | T7-8 | Does the frontend need `system/init` data (tools, model, MCP servers)? |
| 6 | T7-8 | Should SDK `user` messages map to `message.created` or be dropped? |
| 7 | T9 | Is one concurrent query per project acceptable? |
| 8 | T11 | Should `rejectQuestion` return `{ behavior: "deny" }` to SDK? |
| 9 | T12 | Remove Task 12 factory (conflicts with Task 14 architecture)? |
| 10 | T13 | Should `swap()` drain in-flight operations or is the race acceptable? |
| 11 | T13 | Should monitoring/lifecycle wiring capture the proxy or always use OpenCode? |
| 12 | T14 | How should `authType` be detected (frontend sends it, server-side detection, or config)? |
| 13 | T15 | Capabilities object vs backend-type string for hiding buttons? |

---

## Amend Plan — Priority-Ordered

### P0: Will Cause Silent Data Loss or Broken Functionality

1. **Shared channel closure** (Theme B) — subscriber disconnect permanently kills events
2. **Translator incompatibility** (Theme C) — no done event, dropped streaming, missing cost data
3. **Permission ID mismatch** (T11 #8) — questions never resolve
4. **Permission decision vocabulary** (T11 #2) — denials treated as approvals
5. **BackendProxy constructor** (T13 #2) — tests and runtime fail

### P1: Will Cause Compile Failures

6. **Missing method stubs** (T9 #6,7) — `sendMessage`, `abortSession`, permission methods
7. **Missing config fields** (T12 #1, T14 #5) — `ProjectRelayConfig` lacks 4 fields
8. **Missing `RelayMessage` variant** (T14 #2) — `backend_switched`
9. **Missing `HandlerDeps` fields** (T14 #1) — `backendProxy`, `backendRegistry`
10. **Wrong import paths** (T3 #1,2) — `Logger`, `ServiceRegistry`

### P2: Will Cause Incorrect Behavior

11. **Pervasive `any` typing** (Theme A)
12. **Answer format mismatch** (T11 #3) — `Record<string,string>` vs `string[][]`
13. **Session field name** (T9 #18) — `sessionId` vs `sessionID`
14. **`abortSession("*")` invalid** (T14 #3)
15. **Missing `oldBackend.shutdown()`** (T14 #7)
16. **Async swap handler in sync callback** (T14 #8)
17. **Active session tracking missing** (T10 #7,18) — messages/abort go to wrong session
18. **Pending deferred cleanup on query end** (T10 #8)
19. **`prompt.images` type mismatch** (T10 #10) — `string[]` vs `{mediaType,data}`
20. **No try/catch around `sdkQuery()`** (T10 #11)

### P3: Should Fix for Quality

21. **MessageQueue should wrap AsyncEventChannel** (Theme I)
22. **Task 12 factory conflicts with Task 14** (Theme J)
23. **Missing files in Tasks 4-5** (Theme D)
24. **Phase 1 prerequisite gating** (Theme H)
25. **Structural test improvements** (T1 #2) — signature-level checks
26. **Frontend Svelte 5 patterns** (T15) — wrong syntax, paths, store patterns
27. **Test coverage gaps** (T10 #15-17, T11 #14, T15 #13) — multi-turn, materialization, events
28. **`buildUserMessage` fragile ternary** (T10 #2) — remove optimization
29. **Dynamic imports** (T3 #3, T10 #12) — use static imports
30. **BackendEvent typing** (T1 #1) — too generic, should use discriminated union

---

Handing off to plan-audit-fixer to resolve.
