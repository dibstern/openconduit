// src/lib/persistence/session-list-adapter.ts
// ─── Session List Adapter ────────────────────────────────────────────────────
// Converts SQLite SessionRow[] → SessionInfo[] for the frontend.
// Also provides comparison utilities for transition validation.

import type { SessionInfo } from "../shared-types.js";
import type { SessionRow } from "./read-query-service.js";

interface SessionStatus {
	type: string;
}

export interface SessionListAdapterOptions {
	statuses?: Record<string, SessionStatus>;
	pendingQuestionCounts?: ReadonlyMap<string, number>;
}

/**
 * Convert SQLite session rows to the SessionInfo format expected by the frontend.
 * Rows should already be sorted by the query (updated_at DESC).
 */
export function sessionRowsToSessionInfoList(
	rows: SessionRow[],
	opts?: SessionListAdapterOptions,
): SessionInfo[] {
	return rows.map((row) => {
		const info: SessionInfo = {
			id: row.id,
			title: row.title,
			updatedAt: row.updated_at,
			messageCount: 0,
		};

		if (row.parent_id) {
			info.parentID = row.parent_id;
		}
		if (row.fork_point_event) {
			info.forkMessageId = row.fork_point_event;
		}

		if (opts?.statuses) {
			const status = opts.statuses[row.id];
			if (status && (status.type === "busy" || status.type === "retry")) {
				info.processing = true;
			}
		}

		const qCount = opts?.pendingQuestionCounts?.get(row.id);
		if (qCount != null && qCount > 0) {
			info.pendingQuestionCount = qCount;
		}

		return info;
	});
}

export interface SessionListDiff {
	missingInSqlite: string[];
	missingInRest: string[];
	titleMismatches: Array<{ id: string; rest: string; sqlite: string }>;
}

/**
 * Compare REST-sourced and SQLite-sourced session lists for transition validation.
 * Identifies discrepancies to help diagnose projection gaps during Phase 4c rollout.
 */
export function compareSessionLists(
	restList: SessionInfo[],
	sqliteList: SessionInfo[],
): SessionListDiff {
	const restMap = new Map(restList.map((s) => [s.id, s]));
	const sqliteMap = new Map(sqliteList.map((s) => [s.id, s]));

	const missingInSqlite: string[] = [];
	const missingInRest: string[] = [];
	const titleMismatches: Array<{ id: string; rest: string; sqlite: string }> =
		[];

	for (const [id, restSession] of restMap) {
		const sqliteSession = sqliteMap.get(id);
		if (!sqliteSession) {
			missingInSqlite.push(id);
			continue;
		}
		if (restSession.title !== sqliteSession.title) {
			titleMismatches.push({
				id,
				rest: restSession.title,
				sqlite: sqliteSession.title,
			});
		}
	}

	for (const id of sqliteMap.keys()) {
		if (!restMap.has(id)) {
			missingInRest.push(id);
		}
	}

	return { missingInSqlite, missingInRest, titleMismatches };
}
