// test/unit/persistence/session-list-adapter.test.ts
import { describe, expect, it } from "vitest";
import type { SessionRow } from "../../../src/lib/persistence/read-query-service.js";
import {
	compareSessionLists,
	sessionRowsToSessionInfoList,
} from "../../../src/lib/persistence/session-list-adapter.js";
import type { SessionInfo } from "../../../src/lib/shared-types.js";

// ─── Fixtures ──────────────────────────────────────────────────────────────

function makeRow(id: string, overrides?: Partial<SessionRow>): SessionRow {
	return {
		id,
		provider: "opencode",
		provider_sid: null,
		title: "Untitled",
		status: "idle",
		parent_id: null,
		fork_point_event: null,
		last_message_at: null,
		created_at: 1000,
		updated_at: 2000,
		...overrides,
	};
}

// ─── sessionRowsToSessionInfoList ─────────────────────────────────────────

describe("sessionRowsToSessionInfoList", () => {
	it("converts session rows to SessionInfo format", () => {
		const rows: SessionRow[] = [
			makeRow("s1", { title: "First", updated_at: 3000 }),
			makeRow("s2", { title: "Second", updated_at: 1000 }),
		];

		const result = sessionRowsToSessionInfoList(rows);

		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({
			id: "s1",
			title: "First",
			updatedAt: 3000,
			messageCount: 0,
		});
		expect(result[1]).toEqual({
			id: "s2",
			title: "Second",
			updatedAt: 1000,
			messageCount: 0,
		});
	});

	it("includes parentID and forkMessageId for forked sessions", () => {
		const rows: SessionRow[] = [
			makeRow("fork-1", {
				parent_id: "parent-1",
				fork_point_event: "msg-42",
			}),
		];

		const result = sessionRowsToSessionInfoList(rows);
		const [row] = result;
		expect(row?.parentID).toBe("parent-1");
		expect(row?.forkMessageId).toBe("msg-42");
	});

	it("omits parentID and forkMessageId when not a fork", () => {
		const rows: SessionRow[] = [makeRow("s1")];
		const result = sessionRowsToSessionInfoList(rows);
		const [row] = result;
		expect(row?.parentID).toBeUndefined();
		expect(row?.forkMessageId).toBeUndefined();
	});

	it("includes processing flag when session is busy", () => {
		const rows: SessionRow[] = [makeRow("s1"), makeRow("s2")];
		const statuses = {
			s1: { type: "busy" as const },
			s2: { type: "idle" as const },
		};

		const result = sessionRowsToSessionInfoList(rows, { statuses });
		expect(result[0]?.processing).toBe(true);
		expect(result[1]?.processing).toBeUndefined();
	});

	it("includes processing flag when session is in retry state", () => {
		const rows: SessionRow[] = [makeRow("s1")];
		const statuses = { s1: { type: "retry" as const } };

		const result = sessionRowsToSessionInfoList(rows, { statuses });
		expect(result[0]?.processing).toBe(true);
	});

	it("does not set processing for idle/error statuses", () => {
		const rows: SessionRow[] = [makeRow("s1"), makeRow("s2")];
		const statuses = {
			s1: { type: "error" },
			s2: { type: "idle" },
		};
		const result = sessionRowsToSessionInfoList(rows, { statuses });
		expect(result[0]?.processing).toBeUndefined();
		expect(result[1]?.processing).toBeUndefined();
	});

	it("includes pendingQuestionCount when present and > 0", () => {
		const rows: SessionRow[] = [makeRow("s1"), makeRow("s2")];
		const pendingQuestionCounts = new Map([
			["s1", 3],
			["s2", 0],
		]);

		const result = sessionRowsToSessionInfoList(rows, {
			pendingQuestionCounts,
		});
		expect(result[0]?.pendingQuestionCount).toBe(3);
		expect(result[1]?.pendingQuestionCount).toBeUndefined();
	});

	it("returns empty array for empty input", () => {
		expect(sessionRowsToSessionInfoList([])).toEqual([]);
	});
});

// ─── compareSessionLists ──────────────────────────────────────────────────

describe("compareSessionLists", () => {
	it("returns no differences for identical lists", () => {
		const a: SessionInfo[] = [{ id: "s1", title: "Test", updatedAt: 1000 }];
		const b: SessionInfo[] = [{ id: "s1", title: "Test", updatedAt: 1000 }];
		const diff = compareSessionLists(a, b);
		expect(diff.missingInSqlite).toEqual([]);
		expect(diff.missingInRest).toEqual([]);
		expect(diff.titleMismatches).toEqual([]);
	});

	it("detects sessions missing from SQLite", () => {
		const rest: SessionInfo[] = [
			{ id: "s1", title: "Test" },
			{ id: "s2", title: "Other" },
		];
		const sqlite: SessionInfo[] = [{ id: "s1", title: "Test" }];

		const diff = compareSessionLists(rest, sqlite);
		expect(diff.missingInSqlite).toEqual(["s2"]);
	});

	it("detects sessions missing from REST", () => {
		const rest: SessionInfo[] = [{ id: "s1", title: "Test" }];
		const sqlite: SessionInfo[] = [
			{ id: "s1", title: "Test" },
			{ id: "s2", title: "Extra" },
		];

		const diff = compareSessionLists(rest, sqlite);
		expect(diff.missingInRest).toEqual(["s2"]);
	});

	it("detects title mismatches", () => {
		const rest: SessionInfo[] = [{ id: "s1", title: "REST Title" }];
		const sqlite: SessionInfo[] = [{ id: "s1", title: "SQLite Title" }];

		const diff = compareSessionLists(rest, sqlite);
		expect(diff.titleMismatches).toEqual([
			{ id: "s1", rest: "REST Title", sqlite: "SQLite Title" },
		]);
	});

	it("handles empty lists without errors", () => {
		const diff = compareSessionLists([], []);
		expect(diff.missingInSqlite).toEqual([]);
		expect(diff.missingInRest).toEqual([]);
		expect(diff.titleMismatches).toEqual([]);
	});
});
