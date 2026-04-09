// test/unit/session/session-list-sqlite.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadFlags } from "../../../src/lib/persistence/read-flags.js";
import { isActive } from "../../../src/lib/persistence/read-flags.js";
import type { SessionRow } from "../../../src/lib/persistence/read-query-service.js";
import { ReadQueryService } from "../../../src/lib/persistence/read-query-service.js";
import {
	compareSessionLists,
	sessionRowsToSessionInfoList,
} from "../../../src/lib/persistence/session-list-adapter.js";
import type { SessionInfo } from "../../../src/lib/shared-types.js";
import {
	createTestHarness,
	type TestHarness,
} from "../../helpers/persistence-factories.js";

// ─── Inline dual-list algorithm helper (mirrors SessionManager.listSessions) ─

async function dualListSessions(
	legacyList: () => Promise<SessionInfo[]>,
	readQuery: Pick<ReadQueryService, "listSessions">,
	readFlags: Pick<ReadFlags, "sessionList">,
	log: { warn: (...args: unknown[]) => void },
	opts?: { roots?: boolean },
): Promise<SessionInfo[]> {
	if (!isActive(readFlags.sessionList)) {
		return legacyList();
	}

	// SQLite path
	const sqOpts = opts?.roots !== undefined ? { roots: opts.roots } : undefined;
	const rows = readQuery.listSessions(sqOpts);
	const sqliteResult = sessionRowsToSessionInfoList(rows);

	// Fire-and-forget background comparison
	legacyList()
		.then((restResult) => {
			const diff = compareSessionLists(restResult, sqliteResult);
			if (
				diff.missingInSqlite.length > 0 ||
				diff.missingInRest.length > 0 ||
				diff.titleMismatches.length > 0
			) {
				log.warn(
					`session-list-diff: missing_in_sqlite=${diff.missingInSqlite.length}`,
				);
			}
		})
		.catch(() => {
			/* non-fatal */
		});

	return sqliteResult;
}

// ─── Algorithm spec (inline helper) ─────────────────────────────────────────

describe("Session list SQLite switchover algorithm (spec)", () => {
	const mockRows: SessionRow[] = [
		{
			id: "s1",
			provider: "opencode",
			provider_sid: null,
			title: "SQLite Session",
			status: "idle",
			parent_id: null,
			fork_point_event: null,
			last_message_at: null,
			created_at: 1000,
			updated_at: 3000,
		},
	];

	const mockLegacy = vi.fn(
		async (): Promise<SessionInfo[]> => [
			{ id: "s1", title: "REST Session", updatedAt: 3000 },
		],
	);

	const mockReadQuery = {
		listSessions: vi.fn((_opts?: { roots?: boolean }) => mockRows),
	};

	const log = { warn: vi.fn() };

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("uses legacy path when flag is off", async () => {
		const result = await dualListSessions(
			mockLegacy,
			mockReadQuery,
			{ sessionList: "legacy" },
			log,
		);
		expect(result[0]?.title).toBe("REST Session");
		expect(mockReadQuery.listSessions).not.toHaveBeenCalled();
	});

	it("uses SQLite path when flag is 'sqlite'", async () => {
		const result = await dualListSessions(
			mockLegacy,
			mockReadQuery,
			{ sessionList: "sqlite" },
			log,
		);
		expect(result[0]?.title).toBe("SQLite Session");
		expect(mockReadQuery.listSessions).toHaveBeenCalled();
	});

	it("uses SQLite path when flag is 'shadow'", async () => {
		const result = await dualListSessions(
			mockLegacy,
			mockReadQuery,
			{ sessionList: "shadow" },
			log,
		);
		expect(result[0]?.title).toBe("SQLite Session");
	});

	it("passes roots filter to SQLite query", async () => {
		await dualListSessions(
			mockLegacy,
			mockReadQuery,
			{ sessionList: "sqlite" },
			log,
			{ roots: true },
		);
		expect(mockReadQuery.listSessions).toHaveBeenCalledWith({ roots: true });
	});
});

// ─── Wiring test (F1) — integration with real SQLite ─────────────────────────

describe("session list wiring (F1)", () => {
	let harness: TestHarness;
	let readQuery: ReadQueryService;

	beforeEach(() => {
		harness = createTestHarness();
		harness.seedSession("s1", { title: "Alpha", updatedAt: 3000 });
		harness.seedSession("s2", { title: "Beta", updatedAt: 2000 });
		harness.seedSession("s3", { title: "Gamma", updatedAt: 1000 });
		readQuery = new ReadQueryService(harness.db);
	});

	afterEach(() => {
		harness.close();
	});

	it("listSessions returns all sessions from SQLite", () => {
		const rows = readQuery.listSessions();
		const result = sessionRowsToSessionInfoList(rows);
		expect(result).toHaveLength(3);
		const ids = result.map((s) => s.id);
		expect(ids).toContain("s1");
		expect(ids).toContain("s2");
		expect(ids).toContain("s3");
	});

	it("listSessions includes correct titles from SQLite", () => {
		const rows = readQuery.listSessions();
		const result = sessionRowsToSessionInfoList(rows);
		const titles = result.map((s) => s.title);
		expect(titles).toContain("Alpha");
		expect(titles).toContain("Beta");
		expect(titles).toContain("Gamma");
	});

	it("listSessions returns forked session with parentID", () => {
		harness.seedSession("fork-1", {
			parentId: "s1",
			forkPointEvent: "msg-5",
		});
		const rows = readQuery.listSessions();
		const result = sessionRowsToSessionInfoList(rows);
		const fork = result.find((s) => s.id === "fork-1");
		expect(fork?.parentID).toBe("s1");
		expect(fork?.forkMessageId).toBe("msg-5");
	});
});
