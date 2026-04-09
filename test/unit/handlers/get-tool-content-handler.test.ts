import { describe, expect, it, vi } from "vitest";
import type { PayloadMap } from "../../../src/lib/handlers/payloads.js";
import { handleGetToolContent } from "../../../src/lib/handlers/tool-content.js";
import type { ReadAdapter } from "../../../src/lib/persistence/read-adapter.js";
import { ToolContentStore } from "../../../src/lib/relay/tool-content-store.js";
import { createMockHandlerDeps } from "../../helpers/mock-factories.js";

describe("handleGetToolContent", () => {
	it("returns stored content for a known toolId", async () => {
		const store = new ToolContentStore();
		store.store("tool-1", "full content here");
		const deps = createMockHandlerDeps({ toolContentStore: store });

		await handleGetToolContent(deps, "client-1", {
			toolId: "tool-1",
		});

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "tool_content",
			toolId: "tool-1",
			content: "full content here",
		});
	});

	it("returns NOT_FOUND error for unknown toolId", async () => {
		const store = new ToolContentStore();
		const deps = createMockHandlerDeps({ toolContentStore: store });

		await handleGetToolContent(deps, "client-1", {
			toolId: "nonexistent",
		});

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "error",
			code: "NOT_FOUND",
			message: "Full tool content not available",
		});
	});

	it("returns INVALID_PARAMS error when toolId is missing", async () => {
		const store = new ToolContentStore();
		const deps = createMockHandlerDeps({ toolContentStore: store });

		await handleGetToolContent(
			deps,
			"client-1",
			{} as unknown as PayloadMap["get_tool_content"],
		);

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "error",
			code: "INVALID_PARAMS",
			message: "Missing or invalid toolId parameter",
		});
	});

	it("returns INVALID_PARAMS error when toolId is not a string", async () => {
		const store = new ToolContentStore();
		const deps = createMockHandlerDeps({ toolContentStore: store });

		await handleGetToolContent(deps, "client-1", {
			toolId: 42,
		} as unknown as PayloadMap["get_tool_content"]);

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "error",
			code: "INVALID_PARAMS",
			message: "Missing or invalid toolId parameter",
		});
	});

	// ─── Phase 4a: SQLite read switchover tests ───────────────────────────────

	it("uses readAdapter.getToolContent when it returns a value (SQLite takes priority)", async () => {
		const readAdapter = {
			getToolContent: vi.fn().mockReturnValue("sqlite content"),
		} as unknown as ReadAdapter;
		const store = new ToolContentStore();
		store.store("tool-1", "legacy content");
		const deps = createMockHandlerDeps({
			toolContentStore: store,
			readAdapter,
		});

		await handleGetToolContent(deps, "client-1", { toolId: "tool-1" });

		expect(readAdapter.getToolContent).toHaveBeenCalledWith("tool-1");
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "tool_content",
			toolId: "tool-1",
			content: "sqlite content",
		});
	});

	it("falls through to toolContentStore when readAdapter returns undefined", async () => {
		const readAdapter = {
			getToolContent: vi.fn().mockReturnValue(undefined),
		} as unknown as ReadAdapter;
		const store = new ToolContentStore();
		store.store("tool-1", "legacy content");
		const deps = createMockHandlerDeps({
			toolContentStore: store,
			readAdapter,
		});

		await handleGetToolContent(deps, "client-1", { toolId: "tool-1" });

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "tool_content",
			toolId: "tool-1",
			content: "legacy content",
		});
	});

	it("returns NOT_FOUND when readAdapter and toolContentStore both have no content", async () => {
		const readAdapter = {
			getToolContent: vi.fn().mockReturnValue(undefined),
		} as unknown as ReadAdapter;
		const store = new ToolContentStore();
		const deps = createMockHandlerDeps({
			toolContentStore: store,
			readAdapter,
		});

		await handleGetToolContent(deps, "client-1", { toolId: "missing" });

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "error",
			code: "NOT_FOUND",
			message: "Full tool content not available",
		});
	});
});
