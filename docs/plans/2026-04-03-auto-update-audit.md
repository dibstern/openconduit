# Auto-Update Plan — Audit Synthesis

> Dispatched 8 auditors across 8 tasks. Findings collected below.

---

## Amend Plan (25 findings)

### Task 1: Updater Module

1. **Shell injection risk** — `execSync([cmd, ...args].join(" "))` invokes a shell. Use `execFileSync(cmd, args)` instead.
2. **Missing tests for core functions** — `performUpdate()` and `checkAndUpdate()` have no test coverage. These are the most side-effect-heavy functions.
3. **`exactOptionalPropertyTypes` conflict** — `CheckAndUpdateOptions.skipUpdate?: boolean` will fail compilation under the project's strict tsconfig. Must use `skipUpdate?: boolean | undefined`.
4. **Race after `reExec()`** — `checkAndUpdate()` returns `true` after calling `reExec()`, but `reExec()` is async (child.on("exit")). The caller could continue executing between `reExec()` and `process.exit()`.
5. **Duplicated constants** — `DEFAULT_PACKAGE_NAME` and `DEFAULT_REGISTRY_URL` are copy-pasted from `version-check.ts`. Extract to a shared location.

### Task 2: CLI Startup Auto-Update

6. **Field name mismatch** — Plan uses `args.skipUpdate` but actual `ParsedArgs` uses `args.noUpdate`. Update check would never be skipped.
7. **No test code provided** — Plan says "add a test" but provides no implementation.
8. **Broad command coverage** — Plan only excludes `daemon` and `help`. Quick commands like `--status`, `--stop`, `--pin` would all incur a 5s npm fetch timeout.

### Task 3: IPC check_update

9. **`versionChecker` null dereference** — `this.versionChecker` is `VersionChecker | null`. Plan must specify a null guard.
10. **Wrong file for context assembly** — Plan says "daemon-lifecycle.ts" but context is assembled in `daemon.ts:startIPCServer()` (lines 1606-1680).
11. **No test code provided** — Inconsistent with Task 1 which provides complete tests.
12. **Dual type synchronization** — Both `createCommandRouter()` params and `IPCHandlerMap` must be updated in lockstep; plan doesn't flag this.

### Task 4: IPC trigger_update

13. **Commit omits `daemon.ts`** — `git add` command doesn't include the file that wires `triggerUpdate` into the IPC context.
14. **Compile-time problem** — Adding `triggerUpdate(): Promise<void>` to `DaemonIPCContext` without an implementation means the code won't compile. Need a stub.
15. **Test description too vague** — No actual test code; should reuse existing `daemon-ipc.test.ts` helpers.

### Task 5: Daemon Self-Replace

16. **Missing imports** — `join` (from `node:path`) not imported in updater.ts; `RELAY_ENV_KEYS` not imported in daemon.ts.
17. **Incomplete env var mirroring** — Only sets PORT and CONFIG_DIR. Missing HOST, PIN_HASH, KEEP_AWAKE, TLS, OC_URL. New daemon starts without auth/TLS.
18. **Task ordering dependency** — `broadcastToAll({ type: "update_started" })` requires the `RelayMessage` variant from Task 7.
19. **No `existsSync` guard** on resolved CLI path.
20. **No double-invocation guard** — Two clicks could spawn two daemons.
21. **`logFd` never closed** after spawn — fd leak.
22. **Wrong test function name** — Plan says `resolveUpdatedDaemonScript()` but function is `resolveUpdatedCliPath()`.

### Task 6: WS trigger_update Message

23. **Missing 4-file wiring chain** — Plan says "add triggerUpdate to HandlerDeps" but doesn't specify changes to `ProjectRelayConfig`, `handler-deps-wiring.ts`, `HandlerDeps`, and `daemon.ts:buildRelayFactory()`.
24. **Handler shouldn't broadcast directly** — The daemon should own the broadcast (via `registry.broadcastToAll()`), not the per-project handler.

### Task 7: WS update_started Message

25. **Fallthrough ambiguity** — `update_available` is in a fallthrough group (`banner`, `skip_permissions`, `update_available`). Plan must specify `update_started` as a standalone case, not a fallthrough.

### Task 8: Frontend Update UI

26. **Wrong CSS custom property names** — Plan uses `--bg-primary`, `--text-primary` but codebase uses `--color-bg`, `--color-text`. Overlay would render invisible. Use Tailwind utility classes instead.
27. **Missing imports** — `wsSendTyped` not imported in Banners.svelte. `setUpdateInProgress` import missing from ws.svelte.ts.
28. **Button insertion point unspecified** — Where exactly in the banner template does "Update now" go?

---

## Ask User (4 findings)

1. **Task 1** — Should `reExec()` be terminal (claude-relay pattern, calls `process.exit()`) or return the child process for testability?

2. **Task 2** — Which CLI commands should trigger the update check? Only `default`? Or `default` + `foreground`? Quick commands like `--status` probably shouldn't incur a 5s timeout.

3. **Task 3** — Should `get_status` also return update info (avoids separate IPC roundtrip from CLI)?

4. **Task 8** — Are component tests needed for the update UI, or is compile-time + manual verification sufficient for v1?

---

## Accept (16 findings)

Various informational findings across all tasks — correct code patterns, minor edge cases, out-of-scope items. No action needed.

---

## User Decisions (resolved)

1. **reExec() behavior** → **Terminal** (calls `process.exit()`, matching claude-relay)
2. **Update check scope** → **Only `default` command** (not --status, --stop, --pin, --foreground)
3. **get_status includes update** → **Yes** (augment with `updateAvailable` and `latestVersion` fields)
4. **Component tests** → **Yes, add basic tests** for the overlay and button

---

## Amendments Applied

| # | Finding | Task | Amendment |
|---|---------|------|-----------|
| 1 | Shell injection | T1 | Changed `execSync` to `execFileSync` in `performUpdate()` |
| 2 | Missing tests | T1 | Added `performUpdate` and `checkAndUpdate` test cases |
| 3 | `exactOptionalPropertyTypes` | T1 | Added `\| undefined` to all optional fields in `CheckAndUpdateOptions` |
| 4 | Race after reExec | T1 | Documented reExec() as terminal; added comment that caller must return immediately |
| 5 | Duplicated constants | T1, T2 | Constants imported from `version-check.ts` (exported there); Task 2 adds the export |
| 6 | Field name mismatch | T2 | Changed `args.skipUpdate` → `args.noUpdate` throughout Task 2 |
| 7 | No test code | T2 | Added concrete test code for startup update check behavior |
| 8 | Broad command coverage | T2 | Changed to `args.command === "default"` only |
| 9 | Null dereference | T3 | Added null guard: `if (!this.versionChecker) return null;` |
| 10 | Wrong file location | T3 | Corrected to `daemon.ts:startIPCServer()` (lines ~1606-1680) |
| 11 | No test code | T3 | Added complete test code for checkUpdate handler |
| 12 | Dual type sync | T3 | Added explicit warning about lockstep updates |
| 13 | Commit omits daemon.ts | T4 | Added `src/lib/daemon/daemon.ts` to git add |
| 14 | Compile-time problem | T4 | Added stub implementation in daemon.ts IPC context |
| 15 | Test description vague | T4 | Added complete test code |
| 16 | Missing imports | T5 | Added `join` import in updater.ts (Task 1), `RELAY_ENV_KEYS` import in daemon.ts |
| 17 | Incomplete env vars | T5 | Added all env vars: HOST, PIN_HASH, KEEP_AWAKE, TLS, OC_URL, etc. |
| 18 | Task ordering | T5 | Added dependency note; recommend completing Task 7 first or adding variant inline |
| 19 | existsSync guard | T5 | Added in `resolveUpdatedCliPath()` (Task 1 implementation) |
| 20 | Double-invocation | T5 | Added `_updateInProgress` guard field |
| 21 | logFd leak | T5 | Added `closeSync(logFd)` after `child.unref()` |
| 22 | Wrong function name | T5 | Corrected test to use `resolveUpdatedCliPath` |
| 23 | Missing wiring chain | T6 | Specified full 4-file chain: HandlerDeps → relay-stack → daemon factory |
| 24 | Handler broadcasts | T6 | Handler calls `deps.triggerUpdate?.()` only; daemon owns broadcast |
| 25 | Fallthrough ambiguity | T7 | Explicitly stated standalone case, not fallthrough |
| 26 | Wrong CSS properties | T8 | Changed to Tailwind utility classes (`bg-bg`, `text-text`, etc.) with note to verify |
| 27 | Missing imports | T8 | Added `wsSendTyped` import to Banners.svelte, `setUpdateInProgress` to ws.svelte.ts |
| 28 | Button insertion | T8 | Added guidance to find dismiss button and insert before it |
| AU1 | reExec terminal | T1 | Documented as terminal function |
| AU2 | Update check scope | T2 | Limited to `args.command === "default"` |
| AU3 | get_status update info | T3 | Augmented `getStatus` handler to include updateAvailable/latestVersion |
| AU4 | Component tests | T8 | Added basic component test for UpdateOverlay |
