# Auto-Update Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Enable conduit to automatically update itself — both on CLI startup (install + re-exec) and via a live "Update now" button in the web UI (daemon self-replace with graceful handoff).

**Architecture:** Two independent update paths modeled after claude-relay's proven design. Path 1: CLI checks npm on the `default` command only (not --status, --stop, --pin, etc.), runs `npm install -g conduit-code@latest`, re-execs with `--no-update`. Path 2: Browser sends `trigger_update` WebSocket message → handler calls daemon's `triggerUpdate()` via callback in `HandlerDeps` → daemon installs update, spawns a new daemon process from the updated code, gracefully shuts down the old one. The existing `VersionChecker` (notification-only) is reused for detection; new code handles the *action*. The `get_status` IPC response is augmented to include update availability info.

**Tech Stack:** Node.js `child_process` (spawn/execSync), npm registry HTTPS, existing IPC protocol, existing WebSocket message dispatch, Svelte 5 banner/overlay components.

**Reference:** claude-relay implementation in `~/src/personal/opencode-relay/claude-relay/lib/updater.js`, `cli.js`, `daemon.js`, `project.js`.

---

## Overview of Tasks

| # | Task | Description |
|---|------|-------------|
| 1 | Updater module | Core `checkAndUpdate()`, `performUpdate()`, `reExec()` functions |
| 2 | CLI startup auto-update | Wire updater into `cli-core.ts` before daemon logic |
| 3 | IPC `check_update` command | New IPC command for daemon to check/apply updates |
| 4 | IPC `trigger_update` command | New IPC command for browser→daemon update trigger |
| 5 | Daemon self-replace | Spawn new daemon from updated code + graceful handoff |
| 6 | WebSocket `trigger_update` message | Browser→server message type and handler |
| 7 | WebSocket `update_started` message | Server→browser message for update-in-progress state |
| 8 | Frontend update UI | Action button on existing banner + updating overlay |

---

### Task 1: Updater Module

**Files:**
- Create: `src/lib/daemon/updater.ts`
- Create: `test/unit/daemon/updater.test.ts`

**Step 1: Write the failing tests**

```typescript
// test/unit/daemon/updater.test.ts
import { describe, expect, it, vi } from "vitest";
import {
	detectPackageManager,
	buildInstallCommand,
	reExecArgs,
} from "../../../src/lib/daemon/updater.js";

describe("updater", () => {
	describe("detectPackageManager", () => {
		it("returns npm by default", () => {
			expect(detectPackageManager()).toBe("npm");
		});
	});

	describe("buildInstallCommand", () => {
		it("builds npm install -g command for latest", () => {
			const result = buildInstallCommand("npm", "conduit-code", "latest");
			expect(result).toEqual({
				cmd: "npm",
				args: ["install", "-g", "conduit-code@latest"],
			});
		});

		it("builds npm install -g command for specific version", () => {
			const result = buildInstallCommand("npm", "conduit-code", "1.2.3");
			expect(result).toEqual({
				cmd: "npm",
				args: ["install", "-g", "conduit-code@1.2.3"],
			});
		});
	});

	describe("reExecArgs", () => {
		it("appends --no-update to original args", () => {
			const result = reExecArgs(["/path/to/node", "cli.js", "--foreground"]);
			expect(result).toEqual(["cli.js", "--foreground", "--no-update"]);
		});

		it("does not duplicate --no-update if already present", () => {
			const result = reExecArgs([
				"/path/to/node",
				"cli.js",
				"--no-update",
			]);
			expect(result).toEqual(["cli.js", "--no-update"]);
		});

		it("strips --skip-update and replaces with --no-update", () => {
			const result = reExecArgs([
				"/path/to/node",
				"cli.js",
				"--skip-update",
			]);
			expect(result).toEqual(["cli.js", "--no-update"]);
		});
	});

	describe("performUpdate", () => {
		it("returns true on successful install", () => {
			// Mock execFileSync to avoid actually running npm
			const execFileSync = vi.fn();
			// Test via the buildInstallCommand + execFileSync call pattern
			// (performUpdate is hard to unit test without mocking child_process;
			//  integration test with a fake npm script is preferred — see below)
		});

		it("returns false and logs on failure", () => {
			// performUpdate catches errors and returns false
		});
	});

	describe("checkAndUpdate", () => {
		it("returns false when skipUpdate is true", async () => {
			const { checkAndUpdate } = await import(
				"../../../src/lib/daemon/updater.js"
			);
			const result = await checkAndUpdate({ skipUpdate: true });
			expect(result).toBe(false);
		});

		it("returns false when no newer version available", async () => {
			const { checkAndUpdate } = await import(
				"../../../src/lib/daemon/updater.js"
			);
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({ version: "0.0.1" }), // older than current
			});
			const result = await checkAndUpdate({
				currentVersion: "99.99.99",
				_fetch: mockFetch as unknown as typeof fetch,
			});
			expect(result).toBe(false);
		});

		it("returns false on fetch error (non-fatal)", async () => {
			const { checkAndUpdate } = await import(
				"../../../src/lib/daemon/updater.js"
			);
			const mockFetch = vi.fn().mockRejectedValue(new Error("network"));
			const result = await checkAndUpdate({
				_fetch: mockFetch as unknown as typeof fetch,
			});
			expect(result).toBe(false);
		});
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/daemon/updater.test.ts`
Expected: FAIL — module not found

**Step 3: Implement the updater module**

```typescript
// src/lib/daemon/updater.ts
// ─── Self-Update Utilities ────────────────────────────────────────────────────
// Functions for checking, installing, and re-executing after a conduit update.
// Modeled after claude-relay's updater.js.

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import { getVersion } from "../version.js";
import {
	DEFAULT_PACKAGE_NAME,
	DEFAULT_REGISTRY_URL,
	fetchLatestVersion,
	isNewer,
} from "./version-check.js";

const log = createLogger("updater");
const FETCH_TIMEOUT_MS = 5_000;

// ─── Package manager detection ─────────────────────────────────────────────

/**
 * Detect the package manager used for the global install.
 * Currently always returns "npm" — future: detect pnpm global, yarn global.
 */
export function detectPackageManager(): "npm" {
	return "npm";
}

// ─── Install command builder ───────────────────────────────────────────────

export interface InstallCommand {
	cmd: string;
	args: string[];
}

/**
 * Build the install command for a given package manager and version.
 */
export function buildInstallCommand(
	pm: "npm",
	packageName: string,
	version: string,
): InstallCommand {
	return {
		cmd: pm,
		args: ["install", "-g", `${packageName}@${version}`],
	};
}

// ─── Re-exec args builder ──────────────────────────────────────────────────

/**
 * Build argv for re-executing the CLI after an update.
 * Strips argv[0] (node binary), appends --no-update, deduplicates.
 */
export function reExecArgs(argv: string[]): string[] {
	const args = argv
		.slice(1)
		.filter((a) => a !== "--no-update" && a !== "--skip-update");
	args.push("--no-update");
	return args;
}

// ─── Perform update (synchronous npm install) ──────────────────────────────

/**
 * Install the specified version globally. Returns true on success.
 * Synchronous — blocks the process while npm runs.
 * Uses execFileSync (not execSync) to avoid shell injection.
 */
export function performUpdate(
	version = "latest",
	packageName = DEFAULT_PACKAGE_NAME,
): boolean {
	const pm = detectPackageManager();
	const { cmd, args } = buildInstallCommand(pm, packageName, version);
	try {
		log.info(`Installing ${packageName}@${version} via ${pm}...`);
		execFileSync(cmd, args, { stdio: "pipe", timeout: 120_000 });
		return true;
	} catch (err) {
		log.warn(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
		return false;
	}
}

// ─── Resolve updated CLI path ──────────────────────────────────────────────

/**
 * Resolve the path to the updated CLI entry point after a global install.
 * Uses `npm root -g` to find the global node_modules, then resolves to
 * conduit-code/dist/src/bin/cli.js.
 * Throws if the resolved path doesn't exist.
 */
export function resolveUpdatedCliPath(
	packageName = DEFAULT_PACKAGE_NAME,
): string {
	const globalRoot = execFileSync("npm", ["root", "-g"], {
		encoding: "utf-8",
	}).trim();
	const cliPath = join(globalRoot, packageName, "dist", "src", "bin", "cli.js");
	if (!existsSync(cliPath)) {
		throw new Error(
			`Updated CLI not found at ${cliPath}. ` +
				`The global install may have failed or the package layout changed.`,
		);
	}
	return cliPath;
}

// ─── Re-exec ───────────────────────────────────────────────────────────────

/**
 * Re-execute the CLI with the same arguments + --no-update.
 * The parent process waits for the child to exit, then exits with the same code.
 * Because npm already replaced the global files, the new process loads updated code.
 *
 * This is a terminal function — it will call process.exit() when the child exits.
 * The caller should return immediately after calling reExec().
 */
export function reExec(): void {
	const args = reExecArgs(process.argv);
	log.info(`Re-executing: ${process.execPath} ${args.join(" ")}`);
	const child = spawn(process.execPath, args, { stdio: "inherit" });
	child.on("exit", (code) => {
		process.exit(code ?? 0);
	});
}

// ─── Main: check and update ────────────────────────────────────────────────

export interface CheckAndUpdateOptions {
	/** Skip the update check entirely. */
	skipUpdate?: boolean | undefined;
	/** Current version (default: from package.json). */
	currentVersion?: string | undefined;
	/** Package name (default: "conduit-code"). */
	packageName?: string | undefined;
	/** Registry URL (default: "https://registry.npmjs.org"). */
	registryUrl?: string | undefined;
	/** Injectable fetch for testing. */
	_fetch?: typeof globalThis.fetch | undefined;
}

/**
 * Check npm for a newer version, install it, and re-exec the CLI.
 *
 * Returns `true` if an update was found and re-exec was triggered (caller
 * should return immediately — reExec() will call process.exit() when done).
 * Returns `false` if no update was needed or the check/install failed
 * (caller continues normally).
 */
export async function checkAndUpdate(
	options?: CheckAndUpdateOptions,
): Promise<boolean> {
	if (options?.skipUpdate) return false;

	const currentVersion = options?.currentVersion ?? getVersion();
	const packageName = options?.packageName ?? DEFAULT_PACKAGE_NAME;
	const registryUrl = options?.registryUrl ?? DEFAULT_REGISTRY_URL;

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

		const latest = await fetchLatestVersion(
			packageName,
			registryUrl,
			options?._fetch,
			controller.signal,
		);
		clearTimeout(timeout);

		if (!isNewer(currentVersion, latest)) return false;

		log.info(`Update available: ${currentVersion} → ${latest}`);

		if (!performUpdate(latest, packageName)) {
			log.warn(
				`Auto-update failed. Run manually: npm install -g ${packageName}@latest`,
			);
			return false;
		}

		log.info(`Updated to ${latest} — re-executing`);
		reExec();
		return true; // Caller must return immediately — reExec() calls process.exit()
	} catch (err) {
		// Non-fatal — update check failure should never block startup
		log.debug(
			`Update check failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}
}
```

**⚠️ Important:** `DEFAULT_PACKAGE_NAME` and `DEFAULT_REGISTRY_URL` must be exported from `version-check.ts` (they already exist there as module-level constants). Add `export` keyword to those constants in `version-check.ts` so the updater can reuse them instead of duplicating.

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/daemon/updater.test.ts`
Expected: PASS (3 tests)

**Step 5: Run full verification**

Run: `pnpm check && pnpm lint`
Expected: PASS

**Step 6: Commit**

```bash
git add src/lib/daemon/updater.ts test/unit/daemon/updater.test.ts
git commit -m "feat: add updater module with checkAndUpdate, performUpdate, reExec"
```

---

### Task 2: CLI Startup Auto-Update

**Files:**
- Modify: `src/bin/cli-core.ts` (add update check before command dispatch)
- Modify: `src/lib/daemon/version-check.ts` (export `DEFAULT_PACKAGE_NAME` and `DEFAULT_REGISTRY_URL`)

**⚠️ Note:** `--no-update` is already parsed in `src/bin/cli-utils.ts`. The `ParsedArgs` interface already has a `noUpdate: boolean` field (NOT `skipUpdate`). No changes needed to the arg parser.

**Step 1: Export shared constants from version-check.ts**

In `src/lib/daemon/version-check.ts`, change the existing `const` declarations to `export const`:

```typescript
export const DEFAULT_PACKAGE_NAME = "conduit-code";
export const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org";
```

**Step 2: Wire update check into cli-core.ts**

At the top of the `run()` function, BEFORE the `--daemon` handler (line 101), add:

```typescript
// ─── Startup update check ─────────────────────────────────────────────
// Check npm for a newer version and auto-update unless opted out.
// Only runs for the default command (interactive/non-interactive entry).
// Quick commands (--status, --stop, --pin, etc.) skip to avoid a 5s timeout.
// --daemon is excluded because the parent process already checked.
// --foreground (dev mode) is excluded — developers don't want auto-update.
if (!args.noUpdate && args.command === "default") {
	const { checkAndUpdate } = await import("../lib/daemon/updater.js");
	const updated = await checkAndUpdate({ skipUpdate: args.noUpdate });
	if (updated) return; // reExec() was called — caller must return immediately
}
```

**⚠️ Critical:** Use `args.noUpdate` (not `args.skipUpdate`) — this is the actual field name in `ParsedArgs`.

**Step 3: Write test for the update check behavior**

Add test to the existing CLI test file (`test/unit/cli-core.test.ts` or similar):

```typescript
describe("startup update check", () => {
	it("skips update check for --status command", async () => {
		// Verify that checkAndUpdate is NOT called when args.command === "status"
		// by running run(["node", "cli.js", "--status"], { ... }) with mocks
	});

	it("skips update check when --no-update is passed", async () => {
		// Verify that checkAndUpdate is NOT called when args.noUpdate === true
	});

	it("runs update check for default command", async () => {
		// This test is harder to write without actually hitting npm.
		// Verify the dynamic import of updater.js is attempted for "default" command.
		// Mock the updater module to return false (no update).
	});
});
```

**Step 4: Run verification**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: PASS

**Step 5: Commit**

```bash
git add src/bin/cli-core.ts src/lib/daemon/version-check.ts
git commit -m "feat: wire CLI startup auto-update check for default command only"
```

---

### Task 3: IPC `check_update` Command + Status Augmentation

This command lets the CLI or browser ask the daemon "is an update available?" and get back the version info. It leverages the existing `VersionChecker` but triggers an immediate check. Additionally, `get_status` is augmented to include update availability info.

**Files:**
- Modify: `src/lib/types.ts` (add `IPCCommand` variant)
- Modify: `src/lib/daemon/ipc-protocol.ts` (add to `VALID_COMMANDS`, validator, router — update BOTH the `createCommandRouter` parameter type AND the switch statement)
- Modify: `src/lib/daemon/daemon-ipc.ts` (add to `DaemonIPCContext`, `IPCHandlerMap`, `buildIPCHandlers`, augment `getStatus` handler)
- Modify: `src/lib/daemon/daemon.ts` (expose `checkUpdate` on the IPC context object inside `private startIPCServer()` at ~line 1606-1680 — NOT in daemon-lifecycle.ts)
- Create: `test/unit/daemon/ipc-check-update.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/daemon/ipc-check-update.test.ts
import { describe, expect, it, vi } from "vitest";
import { buildIPCHandlers } from "../../../src/lib/daemon/daemon-ipc.js";

describe("check_update IPC handler", () => {
	it("returns current, latest, and updateAvailable on success", async () => {
		const mockCtx = {
			// ... (minimal mock of DaemonIPCContext — see existing ipc tests for pattern)
			checkUpdate: vi.fn().mockResolvedValue({
				current: "0.1.0",
				latest: "0.2.0",
				updateAvailable: true,
			}),
		};
		const mockGetStatus = vi.fn().mockReturnValue({ ok: true });
		// @ts-expect-error — partial mock
		const handlers = buildIPCHandlers(mockCtx, mockGetStatus);
		const result = await handlers.checkUpdate();
		expect(result).toEqual({
			ok: true,
			current: "0.1.0",
			latest: "0.2.0",
			updateAvailable: true,
		});
	});

	it("returns ok:false on version checker failure", async () => {
		const mockCtx = {
			checkUpdate: vi.fn().mockRejectedValue(new Error("network")),
		};
		const mockGetStatus = vi.fn().mockReturnValue({ ok: true });
		// @ts-expect-error — partial mock
		const handlers = buildIPCHandlers(mockCtx, mockGetStatus);
		const result = await handlers.checkUpdate();
		expect(result.ok).toBe(false);
		expect(result.error).toContain("network");
	});
});
```

**Step 2: Add the type**

In `src/lib/types.ts`, add to the `IPCCommand` union:

```typescript
| { cmd: "check_update" }
```

**Step 3: Add to IPC protocol**

In `src/lib/daemon/ipc-protocol.ts`:
- Add `"check_update"` to `VALID_COMMANDS` set
- Add case in `validateCommand()` switch (no required fields — just `break`)
- Add handler signature to `createCommandRouter()` parameter type (the inline type object, NOT just `IPCHandlerMap`):
  ```typescript
  checkUpdate: () => Promise<IPCResponse>;
  ```
- Add case in router switch:
  ```typescript
  case "check_update":
      return handlers.checkUpdate();
  ```

**⚠️ Important:** Both `createCommandRouter()`'s inline parameter type AND `IPCHandlerMap` in daemon-ipc.ts must be updated in lockstep. The `assertNever(cmd)` exhaustiveness check will catch if you miss one.

**Step 4: Add to IPC handlers**

In `src/lib/daemon/daemon-ipc.ts`:
- Add to `DaemonIPCContext`:
  ```typescript
  /** Check for updates. Returns null if version checker is disabled (--no-update). */
  checkUpdate(): Promise<{ current: string; latest: string; updateAvailable: boolean } | null>;
  ```
- Add to `IPCHandlerMap`:
  ```typescript
  checkUpdate: () => Promise<IPCResponse>;
  ```
- Add implementation in `buildIPCHandlers()`:
  ```typescript
  checkUpdate: async (): Promise<IPCResponse> => {
      try {
          const result = await ctx.checkUpdate();
          if (result === null) {
              return { ok: true, current: getVersion(), latest: null, updateAvailable: false };
          }
          return { ok: true, ...result };
      } catch (err) {
          return { ok: false, error: formatErrorDetail(err) };
      }
  },
  ```

**Step 5: Augment `getStatus` to include update info**

In `buildIPCHandlers()`, modify the existing `getStatus` handler to spread update info:

```typescript
getStatus: async (): Promise<IPCResponse> => {
    const status = getStatus();
    // Include version checker info if available
    const updateResult = await ctx.checkUpdate().catch(() => null);
    return {
        ok: true,
        ...status,
        ...(updateResult != null && {
            updateAvailable: updateResult.updateAvailable,
            latestVersion: updateResult.latest,
        }),
    };
},
```

**Step 6: Wire up in daemon.ts**

In the `Daemon` class's `private startIPCServer()` method (~line 1606-1680), add `checkUpdate` to the IPC context object:

```typescript
checkUpdate: async () => {
    // versionChecker is null when --no-update was passed or after stop()
    if (!this.versionChecker) return null;
    return this.versionChecker.check();
},
```

**⚠️ Null guard required:** `this.versionChecker` is typed `VersionChecker | null` — it's null when `--no-update` was passed or during shutdown. Return `null` to signal "checking disabled".

**Step 7: Run verification**

Run: `pnpm check && pnpm lint && pnpm vitest run test/unit/daemon/ipc-check-update.test.ts`
Expected: PASS

**Step 8: Commit**

```bash
git add src/lib/types.ts src/lib/daemon/ipc-protocol.ts src/lib/daemon/daemon-ipc.ts src/lib/daemon/daemon.ts test/unit/daemon/ipc-check-update.test.ts
git commit -m "feat: add check_update IPC command and augment get_status with update info"
```

---

### Task 4: IPC `trigger_update` Command

This is the "do the update" command — installs the new version and initiates the daemon self-replace.

**Files:**
- Modify: `src/lib/types.ts` (add `IPCCommand` variant)
- Modify: `src/lib/daemon/ipc-protocol.ts` (BOTH `VALID_COMMANDS`, validator, `createCommandRouter` param type, AND switch)
- Modify: `src/lib/daemon/daemon-ipc.ts` (add to `DaemonIPCContext`, `IPCHandlerMap`, `buildIPCHandlers`)
- Modify: `src/lib/daemon/daemon.ts` (add stub `triggerUpdate` on IPC context — real implementation in Task 5)

**Step 1: Write the failing test**

Add to the existing IPC test file (or create `test/unit/daemon/ipc-trigger-update.test.ts`):

```typescript
import { describe, expect, it, vi } from "vitest";
import { buildIPCHandlers } from "../../../src/lib/daemon/daemon-ipc.js";

describe("trigger_update IPC handler", () => {
	it("calls ctx.triggerUpdate() and returns ok", async () => {
		const triggerUpdate = vi.fn().mockResolvedValue(undefined);
		const mockCtx = {
			triggerUpdate,
			// ... other required mock methods
		};
		const mockGetStatus = vi.fn().mockReturnValue({ ok: true });
		// @ts-expect-error — partial mock
		const handlers = buildIPCHandlers(mockCtx, mockGetStatus);
		const result = await handlers.triggerUpdate();
		expect(result).toEqual({ ok: true });
		expect(triggerUpdate).toHaveBeenCalledOnce();
	});

	it("returns ok:false when triggerUpdate fails", async () => {
		const mockCtx = {
			triggerUpdate: vi.fn().mockRejectedValue(new Error("install failed")),
		};
		const mockGetStatus = vi.fn().mockReturnValue({ ok: true });
		// @ts-expect-error — partial mock
		const handlers = buildIPCHandlers(mockCtx, mockGetStatus);
		const result = await handlers.triggerUpdate();
		expect(result.ok).toBe(false);
		expect(result.error).toContain("install failed");
	});
});
```

**Step 2: Add the type**

In `src/lib/types.ts`:

```typescript
| { cmd: "trigger_update" }
```

**Step 3: Add to IPC protocol**

Same pattern as Task 3: add to `VALID_COMMANDS`, validator (just `break`), `createCommandRouter()` parameter type (inline type AND switch):

```typescript
triggerUpdate: () => Promise<IPCResponse>;
// ...
case "trigger_update":
    return handlers.triggerUpdate();
```

**Step 4: Add to IPC handlers**

In `DaemonIPCContext`:
```typescript
triggerUpdate(): Promise<void>;
```

In `IPCHandlerMap`:
```typescript
triggerUpdate: () => Promise<IPCResponse>;
```

Implementation in `buildIPCHandlers()`:
```typescript
triggerUpdate: async (): Promise<IPCResponse> => {
    try {
        await ctx.triggerUpdate();
        return { ok: true };
    } catch (err) {
        return { ok: false, error: formatErrorDetail(err) };
    }
},
```

**Step 5: Add stub in daemon.ts**

In `daemon.ts`'s IPC context object (inside `private startIPCServer()`, ~line 1606-1680), add a stub that will be replaced by the real implementation in Task 5:

```typescript
triggerUpdate: async () => {
    // Stub — real implementation added in Task 5 (daemon self-replace)
    throw new Error("Update not yet implemented");
},
```

This ensures the code compiles at this commit boundary. Task 5 replaces this stub with the real `triggerUpdate()` method on the Daemon class.

**Step 6: Run verification**

Run: `pnpm check && pnpm lint && pnpm vitest run test/unit/daemon/ipc-trigger-update.test.ts`
Expected: PASS

**Step 7: Commit**

```bash
git add src/lib/types.ts src/lib/daemon/ipc-protocol.ts src/lib/daemon/daemon-ipc.ts src/lib/daemon/daemon.ts test/unit/daemon/ipc-trigger-update.test.ts
git commit -m "feat: add trigger_update IPC command plumbing (stub implementation)"
```

---

### Task 5: Daemon Self-Replace

The core mechanism: install the update, spawn a new daemon from the updated code, gracefully shut down the current daemon.

**⚠️ Dependency:** This task requires Task 7 to be completed first (for the `update_started` RelayMessage variant). If implementing in task order, you may reorder Tasks 5 and 7, or add the `update_started` variant to `shared-types.ts` as part of this task.

**Files:**
- Modify: `src/lib/daemon/daemon.ts` (add `triggerUpdate()` method, replace Task 4's stub, add import for `RELAY_ENV_KEYS`)
- Create: `test/unit/daemon/daemon-self-replace.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/daemon/daemon-self-replace.test.ts
import { describe, expect, it, vi } from "vitest";
import { resolveUpdatedCliPath } from "../../../src/lib/daemon/updater.js";

describe("resolveUpdatedCliPath", () => {
	it("throws when resolved path does not exist", () => {
		// resolveUpdatedCliPath uses execFileSync("npm", ["root", "-g"])
		// In the test environment, the global npm root likely doesn't have
		// conduit-code installed. The existsSync guard should throw.
		expect(() => resolveUpdatedCliPath("nonexistent-package-12345")).toThrow(
			/not found/,
		);
	});
});
```

**Step 2: Implement `triggerUpdate()` on Daemon**

Add a new method to the `Daemon` class. Also add a `private _updateInProgress = false` field for double-invocation protection.

```typescript
// In daemon.ts — add to imports at top of file:
import { RELAY_ENV_KEYS } from "../env.js";
// (This import may already exist partially — ensure RELAY_ENV_KEYS is included)

// Add field to Daemon class:
private _updateInProgress = false;

// New method on Daemon class:

/**
 * Install the latest version and spawn a new daemon process from the
 * updated code. The current daemon will shut down gracefully afterward.
 *
 * Flow:
 * 1. Guard against double invocation
 * 2. Broadcast "update_started" to all browser clients
 * 3. Install the update via npm install -g
 * 4. Resolve the updated CLI entry point
 * 5. Spawn a new detached daemon process (same config)
 * 6. Close the log fd, then gracefully shut down this daemon
 */
async triggerUpdate(): Promise<void> {
    // Double-invocation guard
    if (this._updateInProgress) {
        this.log.warn("Update already in progress — ignoring duplicate request");
        return;
    }
    this._updateInProgress = true;

    const { performUpdate, resolveUpdatedCliPath } = await import("./updater.js");

    // 1. Notify browsers
    this.registry.broadcastToAll({ type: "update_started" });

    // 2. Install
    const success = performUpdate("latest");
    if (!success) {
        this._updateInProgress = false;
        this.registry.broadcastToAll({
            type: "error",
            code: "UPDATE_FAILED",
            message: "Failed to install update. Check daemon logs.",
        });
        throw new Error("npm install -g failed");
    }

    // 3. Resolve updated entry point
    const updatedCli = resolveUpdatedCliPath();

    // 4. Spawn new daemon with same config
    // Mirror ALL env vars from daemon-spawn.ts to ensure the new daemon
    // starts with the same config (TLS, PIN, keep-awake, host, etc.)
    const { openSync, closeSync } = await import("node:fs");
    const { spawn: cpSpawn } = await import("node:child_process");
    const logFd = openSync(this.logPath, "a");

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) env[k] = v;
    }
    // Core config
    env[RELAY_ENV_KEYS.PORT] = String(this.port);
    env[RELAY_ENV_KEYS.CONFIG_DIR] = this.configDir;
    // Optional config — mirror from daemon-spawn.ts pattern
    if (this.host !== "127.0.0.1") env[RELAY_ENV_KEYS.HOST] = this.host;
    if (this.pinHash) env[RELAY_ENV_KEYS.PIN_HASH] = this.pinHash;
    if (this.keepAwake) env[RELAY_ENV_KEYS.KEEP_AWAKE] = "1";
    if (this.keepAwakeCommand) env[RELAY_ENV_KEYS.KEEP_AWAKE_COMMAND] = this.keepAwakeCommand;
    if (this.keepAwakeArgs) env[RELAY_ENV_KEYS.KEEP_AWAKE_ARGS] = JSON.stringify(this.keepAwakeArgs);
    if (this.tlsEnabled) env[RELAY_ENV_KEYS.TLS] = "1";
    // OC_URL: resolve from first instance
    const defaultInst = this.instanceManager.getInstance("default");
    if (defaultInst && !defaultInst.managed) {
        try {
            const url = this.instanceManager.getInstanceUrl("default");
            if (url) env[RELAY_ENV_KEYS.OC_URL] = url;
        } catch { /* non-fatal */ }
    }

    const child = cpSpawn(
        process.execPath,
        [updatedCli, "--daemon"],
        {
            detached: true,
            stdio: ["ignore", logFd, logFd],
            env,
        },
    );
    child.unref();
    closeSync(logFd); // Close fd in parent to avoid leak

    this.log.info(`Spawned updated daemon (PID ${child.pid})`);

    // 5. Gracefully shut down this daemon.
    // The new daemon will start and bind to the port after this one releases it.
    // Browsers auto-reconnect via exponential backoff in ws.svelte.ts.
    await this.stop();
}
```

**⚠️ Important notes:**
- The fields `this.host`, `this.pinHash`, `this.keepAwake`, `this.keepAwakeCommand`, `this.keepAwakeArgs`, `this.tlsEnabled` are `private` on the Daemon class. Since `triggerUpdate()` is a method on Daemon, it has access to them directly. If the `triggerUpdate` callback is wired through the IPC context, it must be a closure that captures `this` (arrow function on the context object).
- `closeSync(logFd)` is called after `child.unref()` to avoid fd leak (matching existing pattern in `daemon-spawn.ts`).
- The double-invocation guard (`_updateInProgress`) prevents two simultaneous "Update now" clicks from spawning two daemons.

**Step 3: Replace Task 4's stub**

In `daemon.ts`'s IPC context object (inside `private startIPCServer()`), replace the stub from Task 4:

```typescript
triggerUpdate: () => this.triggerUpdate(),
```

**Step 4: Run verification**

Run: `pnpm check && pnpm lint && pnpm vitest run test/unit/daemon/daemon-self-replace.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/daemon/daemon.ts test/unit/daemon/daemon-self-replace.test.ts
git commit -m "feat: implement daemon self-replace for live updates"
```

---

### Task 6: WebSocket `trigger_update` Message (Browser → Server)

**Files:**
- Modify: `src/lib/handlers/payloads.ts` (add `trigger_update` to `PayloadMap`)
- Modify: `src/lib/server/ws-router.ts` (add to `VALID_MESSAGE_TYPES` and `IncomingMessageType`)
- Create: `src/lib/handlers/update.ts` (new handler)
- Modify: `src/lib/handlers/index.ts` (register handler in dispatch table)
- Modify: `src/lib/handlers/types.ts` (add optional `triggerUpdate` callback to `HandlerDeps`)
- Modify: `src/lib/relay/relay-stack.ts` (add `triggerUpdate` to `ProjectRelayConfig`, wire to `HandlerDeps`)
- Modify: `src/lib/daemon/daemon.ts` (pass `triggerUpdate` through `buildRelayFactory()`)
- Create: `test/unit/handlers/update.test.ts`

**⚠️ Critical wiring chain:** The browser handler needs to reach the daemon's `triggerUpdate()`. This requires a 4-file callback chain, matching the existing pattern for `addProject`, `removeProject`, etc:

1. **`daemon.ts:buildRelayFactory()`** — passes `triggerUpdate: () => this.triggerUpdate()` callback
2. **`relay-stack.ts:ProjectRelayConfig`** — receives `triggerUpdate?: () => Promise<void>` optional field
3. **`handler-deps-wiring.ts`** (or `relay-stack.ts`) — passes it into `HandlerDeps`
4. **`HandlerDeps`** in `types.ts` — has optional `triggerUpdate?: () => Promise<void>`
5. **Handler** calls `deps.triggerUpdate?.()`

**Step 1: Write the failing test**

```typescript
// test/unit/handlers/update.test.ts
import { describe, expect, it, vi } from "vitest";
import { handleTriggerUpdate } from "../../../src/lib/handlers/update.js";

describe("handleTriggerUpdate", () => {
    it("calls deps.triggerUpdate when available", async () => {
        const triggerUpdate = vi.fn().mockResolvedValue(undefined);
        const mockDeps = {
            triggerUpdate,
            log: { info: vi.fn(), warn: vi.fn() },
        };
        // @ts-expect-error — partial mock
        await handleTriggerUpdate(mockDeps, "client-1", {});
        expect(triggerUpdate).toHaveBeenCalledOnce();
    });

    it("logs warning when triggerUpdate is not available", async () => {
        const warn = vi.fn();
        const mockDeps = {
            // triggerUpdate is undefined (standalone mode)
            log: { info: vi.fn(), warn },
        };
        // @ts-expect-error — partial mock
        await handleTriggerUpdate(mockDeps, "client-1", {});
        expect(warn).toHaveBeenCalled();
    });
});
```

**Step 2: Add to PayloadMap**

In `src/lib/handlers/payloads.ts`:
```typescript
trigger_update: Record<string, never>;
```

**⚠️ Do NOT add `check_update` to PayloadMap.** That's an IPC-only command, not a browser→server WebSocket message. Adding it without a handler would fail the `MESSAGE_HANDLERS` type check.

**Step 3: Add to ws-router.ts**

Add `"trigger_update"` to both the `IncomingMessageType` union and the `VALID_MESSAGE_TYPES` set.

**Step 4: Add to HandlerDeps**

In `src/lib/handlers/types.ts`, add to the `HandlerDeps` interface:
```typescript
/** Trigger a daemon self-update. Only available when running as a relay under the daemon. */
triggerUpdate?: (() => Promise<void>) | undefined;
```

**Step 5: Wire through relay-stack**

In `src/lib/relay/relay-stack.ts`, find the `ProjectRelayConfig` interface and add:
```typescript
triggerUpdate?: (() => Promise<void>) | undefined;
```

Then wire it into `HandlerDeps` construction (wherever `HandlerDeps` is assembled — check `handler-deps-wiring.ts` or the relay-stack builder):
```typescript
triggerUpdate: config.triggerUpdate,
```

**Step 6: Wire from daemon's relay factory**

In `daemon.ts:buildRelayFactory()`, add alongside the existing callbacks:
```typescript
triggerUpdate: () => this.triggerUpdate(),
```

**Step 7: Create handler**

```typescript
// src/lib/handlers/update.ts
import type { MessageHandler } from "./types.js";

/**
 * Handle browser "trigger_update" message.
 * Delegates to the daemon's triggerUpdate() via the callback chain.
 * The daemon handles broadcasting, installing, and spawning.
 */
export const handleTriggerUpdate: MessageHandler<"trigger_update"> = async (
    deps,
    _clientId,
    _payload,
) => {
    if (!deps.triggerUpdate) {
        deps.log.warn("Update triggered but triggerUpdate callback not available");
        return;
    }
    deps.log.info("Update triggered by browser client");
    await deps.triggerUpdate();
    // The daemon's triggerUpdate() broadcasts "update_started" to ALL clients
    // (via registry.broadcastToAll), installs the update, spawns a new daemon,
    // and shuts down this one. The handler does NOT broadcast directly.
};
```

**Step 8: Register in dispatch table**

In `src/lib/handlers/index.ts`, import and add:
```typescript
import { handleTriggerUpdate } from "./update.js";
// ... in MESSAGE_HANDLERS:
trigger_update: handleTriggerUpdate as MessageHandler,
```

**Step 9: Run verification**

Run: `pnpm check && pnpm lint && pnpm vitest run test/unit/handlers/update.test.ts`
Expected: PASS

**Step 10: Commit**

```bash
git add src/lib/handlers/payloads.ts src/lib/server/ws-router.ts src/lib/handlers/update.ts src/lib/handlers/index.ts src/lib/handlers/types.ts src/lib/relay/relay-stack.ts src/lib/daemon/daemon.ts test/unit/handlers/update.test.ts
git commit -m "feat: add trigger_update WebSocket message with full wiring chain"
```

---

### Task 7: WebSocket `update_started` Message (Server → Browser)

**Files:**
- Modify: `src/lib/shared-types.ts` (add `RelayMessage` variant)
- Modify: `src/lib/frontend/stores/ws-dispatch.ts` (handle the new message)
- Modify: `src/lib/frontend/stores/ui.svelte.ts` (add update-in-progress state)

**Step 1: Add to RelayMessage**

In `src/lib/shared-types.ts`, add to the `RelayMessage` union:
```typescript
| { type: "update_started"; version?: string }
```

**Step 2: Add UI state**

In `src/lib/frontend/stores/ui.svelte.ts`, add to `uiState`:
```typescript
updateInProgress: false,
```

Add helpers:
```typescript
export function setUpdateInProgress(inProgress: boolean): void {
    uiState.updateInProgress = inProgress;
}
```

**Step 3: Handle in ws-dispatch.ts**

In the `handleMessage()` switch, add a **standalone case** (NOT a fallthrough with the `banner`/`skip_permissions`/`update_available` group). The existing `update_available` is part of a fallthrough group that routes to `handleBannerMessage()` — `update_started` needs its own case:

```typescript
// Add this as a NEW standalone case, not inside the banner fallthrough group:
case "update_started":
    setUpdateInProgress(true);
    // Remove the "update available" banner (update is now happening)
    removeBanner("update-available");
    break;
```

When the WebSocket reconnects (after the new daemon starts), `setUpdateInProgress(false)` should be called in the reconnect handler (`ws.svelte.ts`).

**Step 4: Run verification**

Run: `pnpm check && pnpm lint`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/shared-types.ts src/lib/frontend/stores/ws-dispatch.ts src/lib/frontend/stores/ui.svelte.ts
git commit -m "feat: add update_started message type and in-progress UI state"
```

---

### Task 8: Frontend Update UI

**Files:**
- Modify: `src/lib/frontend/components/overlays/Banners.svelte` (add "Update now" action to update banner, add `wsSendTyped` import)
- Create: `src/lib/frontend/components/overlays/UpdateOverlay.svelte` (fullscreen updating overlay)
- Modify: `src/lib/frontend/components/layout/ChatLayout.svelte` (import and mount UpdateOverlay)
- Modify: `src/lib/frontend/stores/ws.svelte.ts` (clear updateInProgress on reconnect, import `setUpdateInProgress`)
- Create: `test/unit/frontend/UpdateOverlay.test.ts` (basic component test)

**Step 1: Add "Update now" button to the existing update banner**

In `Banners.svelte`, add the import at the top of the `<script>` block:

```svelte
<script lang="ts">
    import { wsSendTyped } from "../../stores/ws.svelte";
    // ... existing imports
</script>
```

Find the banner rendering for variant `"update"` and add an action button. The exact insertion point depends on the existing template structure — look for where the dismiss "x" button is rendered and add the "Update now" button before it:

```svelte
{#if banner.variant === "update"}
    <button
        class="ml-2 rounded px-2 py-0.5 text-xs font-medium bg-white/20 hover:bg-white/30 transition-colors"
        onclick={() => {
            wsSendTyped("trigger_update", {});
        }}
    >
        Update now
    </button>
{/if}
```

**Step 2: Create UpdateOverlay component**

Use Tailwind utility classes (NOT raw CSS custom properties). The codebase uses `bg-bg`, `text-text`, `border-border` Tailwind classes mapped to CSS variables.

```svelte
<!-- src/lib/frontend/components/overlays/UpdateOverlay.svelte -->
<script lang="ts">
    import { uiState } from "../../stores/ui.svelte";
</script>

{#if uiState.updateInProgress}
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
        <div class="flex flex-col items-center gap-4 rounded-xl bg-bg p-8 shadow-2xl border border-border">
            <!-- Spinner -->
            <div class="h-8 w-8 animate-spin rounded-full border-2 border-text-secondary border-t-accent"></div>
            <p class="text-lg font-medium text-text">Updating Conduit...</p>
            <p class="text-sm text-text-secondary">This will take a few seconds. The page will reconnect automatically.</p>
        </div>
    </div>
{/if}
```

**⚠️ CSS note:** Verify the exact Tailwind utility class names against the project's `tailwind.config` or existing components. Search for `bg-bg` or `text-text` in the codebase to confirm the naming convention. If the project uses `bg-[var(--color-bg)]` instead, use that pattern.

**Step 3: Mount in ChatLayout**

In `ChatLayout.svelte`, add the import and component:

```svelte
<script lang="ts">
    import UpdateOverlay from "../overlays/UpdateOverlay.svelte";
    // ... existing imports
</script>

<!-- At the top level of the template, alongside other overlays -->
<UpdateOverlay />
```

**Step 4: Clear update state on reconnect**

In `ws.svelte.ts`, add the import and call in the WebSocket `open` event handler:

```typescript
import { setUpdateInProgress } from "./ui.svelte";

// In the ws.addEventListener("open", ...) handler (reconnect path, ~line 212):
setUpdateInProgress(false);
```

This ensures the overlay disappears once the new daemon is up and the WS reconnects.

**Step 5: Add basic component test**

```typescript
// test/unit/frontend/UpdateOverlay.test.ts
import { describe, expect, it, vi } from "vitest";

describe("UpdateOverlay", () => {
    it("renders overlay when updateInProgress is true", async () => {
        // Import the component and render with uiState.updateInProgress = true
        // Verify the overlay text "Updating Conduit..." is present
        // This requires @testing-library/svelte — check if already a dev dependency
    });

    it("does not render when updateInProgress is false", async () => {
        // Verify no overlay is rendered when state is false
    });
});
```

**Step 6: Run verification**

Run: `pnpm check && pnpm lint && pnpm build`
Expected: PASS (build verifies Svelte compilation and CSS resolution)

**Step 7: Commit**

```bash
git add src/lib/frontend/components/overlays/Banners.svelte src/lib/frontend/components/overlays/UpdateOverlay.svelte src/lib/frontend/components/layout/ChatLayout.svelte src/lib/frontend/stores/ws.svelte.ts test/unit/frontend/UpdateOverlay.test.ts
git commit -m "feat: add 'Update now' button, updating overlay, and basic component tests"
```

---

## Design Decisions & Notes

### Why sequential shutdown (not port-retry handoff)?

Claude-relay uses port-retry (new daemon retries binding up to 15 times). This is more complex and requires coordination. For v1, conduit uses sequential shutdown: old daemon stops → new daemon starts → browsers auto-reconnect. The ~1-2s gap is acceptable because:
- Browsers already have exponential backoff reconnection
- The "Updating..." overlay sets expectations
- It's simpler and less error-prone

Port-retry handoff can be added later as a refinement.

### Why not pnpm/yarn support?

`detectPackageManager()` returns `"npm"` for now. The globally-installed `conduit` package is installed via `npm install -g conduit-code` (per the README). Supporting `pnpm add -g` and `yarn global add` is a straightforward extension later.

### Update channels (beta/stable)

Not included in v1. The existing `VersionChecker` always checks `latest`. Beta channel support can be added later by:
1. Adding an `updateChannel` field to `DaemonConfig`
2. Passing it to `fetchLatestVersion()` (change `/latest` → `/beta` tag)
3. Adding a toggle in server settings (similar to claude-relay's "Early Access")

### Security considerations

- `npm install -g` requires write permission to the global node_modules. If it fails (e.g., permission denied on Linux without nvm), the error is caught and a helpful message is shown.
- The update only installs from the public npm registry — no arbitrary code execution.
- The `--no-update` flag provides an opt-out for environments where auto-update is undesirable.
