// test/unit/session/fork-metadata-sqlite.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ForkEntry } from "../../../src/lib/daemon/fork-metadata.js";
import type { ReadFlags } from "../../../src/lib/persistence/read-flags.js";
import {
	createReadFlags,
	isActive,
} from "../../../src/lib/persistence/read-flags.js";
import type { ForkMetadata } from "../../../src/lib/persistence/read-query-service.js";
import { ReadQueryService } from "../../../src/lib/persistence/read-query-service.js";
import { SessionManager } from "../../../src/lib/session/session-manager.js";
import {
	createTestHarness,
	type TestHarness,
} from "../../helpers/persistence-factories.js";

// ─── Inline algorithm helper (mirrors what SessionManager.getForkEntry does) ──

function resolveForkEntry(
	sessionId: string,
	forkMeta: Map<string, ForkEntry>,
	readQuery: Pick<ReadQueryService, "getForkMetadata"> | undefined,
	readFlags: Pick<ReadFlags, "forkMetadata"> | undefined,
): ForkEntry | undefined {
	// SQLite path — (C1) use isActive() not truthy check
	if (isActive(readFlags?.forkMetadata) && readQuery) {
		const meta = readQuery.getForkMetadata(sessionId);
		if (meta) {
			return {
				forkMessageId: meta.forkPointEvent ?? "",
				parentID: meta.parentId,
			};
		}
		// Fall through to in-memory on SQLite miss
	}
	// Legacy path
	return forkMeta.get(sessionId);
}

// ─── Algorithm spec (pure logic, no I/O) ─────────────────────────────────────

describe("Fork metadata read switchover algorithm (spec)", () => {
	const forkMeta = new Map([
		[
			"fork-1",
			{
				forkMessageId: "msg-10",
				parentID: "parent-1",
				forkPointTimestamp: 1000,
			},
		],
	]);

	const mockReadQuery = {
		getForkMetadata: vi.fn((sessionId: string): ForkMetadata | undefined => {
			if (sessionId === "fork-1") {
				return { parentId: "parent-1", forkPointEvent: "msg-10-sqlite" };
			}
			return undefined;
		}),
	};

	it("uses in-memory map when flag is off (legacy mode)", () => {
		const result = resolveForkEntry("fork-1", forkMeta, mockReadQuery, {
			forkMetadata: "legacy",
		});
		expect(result).toEqual({
			forkMessageId: "msg-10",
			parentID: "parent-1",
			forkPointTimestamp: 1000,
		});
		expect(mockReadQuery.getForkMetadata).not.toHaveBeenCalled();
	});

	it("uses SQLite when flag is 'sqlite'", () => {
		mockReadQuery.getForkMetadata.mockClear();
		const result = resolveForkEntry("fork-1", forkMeta, mockReadQuery, {
			forkMetadata: "sqlite",
		});
		expect(result).toEqual({
			forkMessageId: "msg-10-sqlite",
			parentID: "parent-1",
		});
		expect(mockReadQuery.getForkMetadata).toHaveBeenCalledWith("fork-1");
	});

	it("uses SQLite when flag is 'shadow'", () => {
		mockReadQuery.getForkMetadata.mockClear();
		const result = resolveForkEntry("fork-1", forkMeta, mockReadQuery, {
			forkMetadata: "shadow",
		});
		expect(result).toEqual({
			forkMessageId: "msg-10-sqlite",
			parentID: "parent-1",
		});
		expect(mockReadQuery.getForkMetadata).toHaveBeenCalledWith("fork-1");
	});

	it("falls back to in-memory when SQLite returns nothing", () => {
		mockReadQuery.getForkMetadata.mockClear();
		mockReadQuery.getForkMetadata.mockReturnValueOnce(undefined);
		const result = resolveForkEntry("fork-1", forkMeta, mockReadQuery, {
			forkMetadata: "sqlite",
		});
		expect(result).toEqual({
			forkMessageId: "msg-10",
			parentID: "parent-1",
			forkPointTimestamp: 1000,
		});
	});

	it("returns undefined when session is not a fork in either path", () => {
		mockReadQuery.getForkMetadata.mockClear();
		const result = resolveForkEntry("not-a-fork", forkMeta, mockReadQuery, {
			forkMetadata: "sqlite",
		});
		expect(result).toBeUndefined();
	});

	it("returns undefined when readQuery is absent (flag on but no query)", () => {
		const result = resolveForkEntry("fork-1", forkMeta, undefined, {
			forkMetadata: "sqlite",
		});
		// No query — falls through to legacy
		expect(result).toEqual({
			forkMessageId: "msg-10",
			parentID: "parent-1",
			forkPointTimestamp: 1000,
		});
	});
});

// ─── Wiring tests (F1) — production SessionManager against real SQLite ────────

describe("fork resolution wiring (F1)", () => {
	let harness: TestHarness;
	let sessionMgr: SessionManager;

	beforeEach(() => {
		harness = createTestHarness();
		harness.seedSession("parent-1");
		harness.seedSession("fork-1", {
			parentId: "parent-1",
			forkPointEvent: "msg-10-sqlite",
		});
		const readQuery = new ReadQueryService(harness.db);
		// SessionManager requires `client` — pass a minimal stub; none of the
		// tested methods make API calls.
		sessionMgr = new SessionManager({
			client: {} as SessionManager["client" & never],
			readQuery,
			readFlags: createReadFlags({ forkMetadata: "sqlite" }),
		} as ConstructorParameters<typeof SessionManager>[0]);
	});

	afterEach(() => {
		harness.close();
	});

	it("production getForkEntry() returns correct entry from SQLite", () => {
		const entry = sessionMgr.getForkEntry("fork-1");
		expect(entry).toEqual({
			forkMessageId: "msg-10-sqlite",
			parentID: "parent-1",
		});
	});

	it("production getForkEntry() returns undefined for non-fork session", () => {
		expect(sessionMgr.getForkEntry("parent-1")).toBeUndefined();
	});

	it("production getForkEntry() returns undefined for unknown session", () => {
		expect(sessionMgr.getForkEntry("nonexistent")).toBeUndefined();
	});
});
