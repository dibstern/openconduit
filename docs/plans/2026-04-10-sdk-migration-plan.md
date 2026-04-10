# OpenCode SDK Migration Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Replace the hand-rolled `OpenCodeClient` (691 lines) with `@opencode-ai/sdk`, adopt SDK types as canonical throughout the codebase, and migrate SSE consumption to the SDK's streaming API.

**Architecture:** A thin `OpenCodeAPI` adapter delegates to the SDK for ~35 endpoints and raw-fetch for ~5 gap endpoints. A custom `retryFetch` adapter provides exponential backoff. SDK types (`Session`, `Message`, `Part`, `Event`, `SessionStatus`) replace all hand-rolled equivalents. SSE consumption moves from manual stream parsing to `sdk.event.subscribe()` with a reconnection/health wrapper.

**Tech Stack:** TypeScript (ESM), `@opencode-ai/sdk` v1.3.0, Vitest, Biome

**Design Doc:** `docs/plans/2026-04-10-sdk-migration-design.md`

---

## Phase 1: Foundation

### Task 1: Add SDK dependency

**Files:**
- Modify: `package.json:71-82` (dependencies)

**Step 1: Install the SDK**

Run: `pnpm add @opencode-ai/sdk@^1.3.0`

**Step 2: Verify installation**

Run: `pnpm check`
Expected: PASS — no type errors from the new dependency

**Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add @opencode-ai/sdk dependency"
```

---

### Task 2: Create retryFetch adapter

**Files:**
- Create: `src/lib/instance/retry-fetch.ts`
- Create: `test/unit/instance/retry-fetch.test.ts`

The retry logic is extracted from `OpenCodeClient.request()` (lines 594-666) and adapted to the `fetch` API signature so it can be injected into `createOpencodeClient({ fetch: retryFetch })`.

**Step 1: Write the failing tests**

```typescript
// test/unit/instance/retry-fetch.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRetryFetch, type RetryFetchOptions } from "../../../src/lib/instance/retry-fetch.js";

describe("createRetryFetch", () => {
	let callCount: number;
	let mockFetch: typeof fetch;
	const defaultOpts: RetryFetchOptions = {
		retries: 2,
		retryDelay: 10, // fast for tests
		timeout: 5000,
	};

	beforeEach(() => {
		callCount = 0;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function makeFetch(responses: Array<Response | Error>): typeof fetch {
		return async (input: RequestInfo | URL, init?: RequestInit) => {
			const idx = callCount++;
			const r = responses[idx];
			if (!r) throw new Error(`Unexpected fetch call #${idx}`);
			if (r instanceof Error) throw r;
			return r;
		};
	}

	it("passes through a successful response on first try", async () => {
		const retryFetch = createRetryFetch({
			...defaultOpts,
			baseFetch: makeFetch([new Response("ok", { status: 200 })]),
		});
		const res = await retryFetch(new Request("http://localhost/test"));
		expect(res.status).toBe(200);
		expect(callCount).toBe(1);
	});

	it("retries on 5xx and succeeds on the second attempt", async () => {
		const retryFetch = createRetryFetch({
			...defaultOpts,
			baseFetch: makeFetch([
				new Response("fail", { status: 502 }),
				new Response("ok", { status: 200 }),
			]),
		});
		const res = await retryFetch(new Request("http://localhost/test"));
		expect(res.status).toBe(200);
		expect(callCount).toBe(2);
	});

	it("does NOT retry on 4xx errors", async () => {
		const retryFetch = createRetryFetch({
			...defaultOpts,
			baseFetch: makeFetch([
				new Response("bad request", { status: 400 }),
			]),
		});
		const res = await retryFetch(new Request("http://localhost/test"));
		expect(res.status).toBe(400);
		expect(callCount).toBe(1);
	});

	it("retries on network errors and succeeds", async () => {
		const retryFetch = createRetryFetch({
			...defaultOpts,
			baseFetch: makeFetch([
				new Error("ECONNREFUSED"),
				new Response("ok", { status: 200 }),
			]),
		});
		const res = await retryFetch(new Request("http://localhost/test"));
		expect(res.status).toBe(200);
		expect(callCount).toBe(2);
	});

	it("throws after exhausting all retries on persistent 5xx", async () => {
		const retryFetch = createRetryFetch({
			...defaultOpts,
			retries: 1,
			baseFetch: makeFetch([
				new Response("fail", { status: 500 }),
				new Response("fail", { status: 500 }),
			]),
		});
		// The last 5xx response is returned (not thrown) — caller sees it
		const res = await retryFetch(new Request("http://localhost/test"));
		expect(res.status).toBe(500);
		expect(callCount).toBe(2);
	});

	it("throws after exhausting all retries on persistent network error", async () => {
		const retryFetch = createRetryFetch({
			...defaultOpts,
			retries: 1,
			baseFetch: makeFetch([
				new Error("ECONNREFUSED"),
				new Error("ECONNREFUSED"),
			]),
		});
		await expect(retryFetch(new Request("http://localhost/test"))).rejects.toThrow("ECONNREFUSED");
		expect(callCount).toBe(2);
	});

	it("uses exponential backoff between retries", async () => {
		const delays: number[] = [];
		const originalSetTimeout = globalThis.setTimeout;
		vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, ms) => {
			if (typeof ms === "number" && ms > 0) delays.push(ms);
			return originalSetTimeout(fn, 0); // execute immediately in test
		});

		const retryFetch = createRetryFetch({
			...defaultOpts,
			retryDelay: 100,
			retries: 2,
			baseFetch: makeFetch([
				new Response("fail", { status: 500 }),
				new Response("fail", { status: 500 }),
				new Response("ok", { status: 200 }),
			]),
		});
		await retryFetch(new Request("http://localhost/test"));
		// Expect delays: 100 * 1 = 100, 100 * 2 = 200
		expect(delays).toContain(100);
		expect(delays).toContain(200);
	});

	it("aborts on timeout", async () => {
		const retryFetch = createRetryFetch({
			...defaultOpts,
			timeout: 50,
			retries: 0,
			baseFetch: async () => {
				await new Promise((r) => setTimeout(r, 200));
				return new Response("late", { status: 200 });
			},
		});
		await expect(retryFetch(new Request("http://localhost/test"))).rejects.toThrow();
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/instance/retry-fetch.test.ts`
Expected: FAIL — module `retry-fetch.js` does not exist

**Step 3: Write the implementation**

```typescript
// src/lib/instance/retry-fetch.ts
// Custom fetch adapter with retry logic for the OpenCode SDK.
// Injected via createOpencodeClient({ fetch: retryFetch }).

import { OpenCodeConnectionError } from "../errors.js";

export interface RetryFetchOptions {
	retries?: number;
	retryDelay?: number;
	timeout?: number;
	baseFetch?: typeof fetch;
}

/**
 * Create a fetch function with retry-on-failure semantics.
 *
 * - Retries on 5xx responses and network errors
 * - Does NOT retry on 4xx (client errors)
 * - Exponential backoff: retryDelay * (attempt + 1)
 * - Timeout via AbortController
 */
export function createRetryFetch(options: RetryFetchOptions = {}): typeof fetch {
	const {
		retries = 2,
		retryDelay = 1000,
		timeout = 10_000,
		baseFetch = globalThis.fetch,
	} = options;

	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		let lastError: Error | undefined;
		let lastResponse: Response | undefined;

		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), timeout);

				// Merge abort signals — respect both timeout and caller's signal
				const mergedInit: RequestInit = {
					...init,
					signal: controller.signal,
				};

				const response = await baseFetch(input, mergedInit);
				clearTimeout(timer);

				// 4xx — don't retry, return immediately
				if (response.status >= 400 && response.status < 500) {
					return response;
				}

				// 5xx — retry
				if (response.status >= 500) {
					lastResponse = response;
					if (attempt < retries) {
						await new Promise((r) => setTimeout(r, retryDelay * (attempt + 1)));
						continue;
					}
					return response;
				}

				// Success
				return response;
			} catch (err) {
				lastError = err instanceof Error ? err : new Error(String(err));

				// AbortError from timeout — wrap and throw
				if (lastError.name === "AbortError") {
					throw new OpenCodeConnectionError(
						`Request timed out after ${timeout}ms`,
						{ cause: lastError },
					);
				}

				// Network error — retry
				if (attempt < retries) {
					await new Promise((r) => setTimeout(r, retryDelay * (attempt + 1)));
					continue;
				}
			}
		}

		// Exhausted retries
		if (lastError) throw lastError;
		if (lastResponse) return lastResponse;

		throw new OpenCodeConnectionError("Unexpected: no response or error after retries");
	};
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/instance/retry-fetch.test.ts`
Expected: PASS — all 8 tests green

**Step 5: Run type check**

Run: `pnpm check`
Expected: PASS

**Step 6: Commit**

```bash
git add src/lib/instance/retry-fetch.ts test/unit/instance/retry-fetch.test.ts
git commit -m "feat: add retryFetch adapter for SDK with exponential backoff"
```

---

### Task 3: Create SDK factory

**Files:**
- Create: `src/lib/instance/sdk-factory.ts`
- Create: `test/unit/instance/sdk-factory.test.ts`

**Step 1: Write the failing tests**

```typescript
// test/unit/instance/sdk-factory.test.ts
import { describe, expect, it, vi } from "vitest";
import { createSdkClient, type SdkFactoryOptions } from "../../../src/lib/instance/sdk-factory.js";

describe("createSdkClient", () => {
	it("creates an OpencodeClient with the given baseUrl", () => {
		const client = createSdkClient({ baseUrl: "http://localhost:4096" });
		expect(client).toBeDefined();
		// The SDK client has namespaced methods
		expect(client.session).toBeDefined();
		expect(client.event).toBeDefined();
	});

	it("applies directory header when provided", () => {
		const client = createSdkClient({
			baseUrl: "http://localhost:4096",
			directory: "/home/user/project",
		});
		expect(client).toBeDefined();
	});

	it("uses custom fetch when provided", () => {
		const customFetch = vi.fn(async () => new Response("ok"));
		const client = createSdkClient({
			baseUrl: "http://localhost:4096",
			fetch: customFetch,
		});
		expect(client).toBeDefined();
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/instance/sdk-factory.test.ts`
Expected: FAIL — module `sdk-factory.js` does not exist

**Step 3: Write the implementation**

```typescript
// src/lib/instance/sdk-factory.ts
// Single factory for SDK client creation.
// Handles auth, directory header, and custom fetch injection.

import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client";
import { ENV } from "../env.js";
import { createRetryFetch, type RetryFetchOptions } from "./retry-fetch.js";

export interface SdkFactoryOptions {
	baseUrl: string;
	directory?: string;
	auth?: { username: string; password: string };
	fetch?: typeof fetch;
	retry?: RetryFetchOptions;
}

/**
 * Create a configured OpencodeClient from the SDK.
 *
 * Wires up:
 * - retryFetch as the transport (unless a custom fetch is provided)
 * - Basic Auth headers from options or env vars
 * - x-opencode-directory header for project scoping
 */
export function createSdkClient(options: SdkFactoryOptions): OpencodeClient {
	const baseFetch = options.fetch ?? createRetryFetch({
		retries: options.retry?.retries,
		retryDelay: options.retry?.retryDelay,
		timeout: options.retry?.timeout,
	});

	// Wrap with auth headers if needed
	const password = options.auth?.password ?? ENV.opencodePassword;
	const username = options.auth?.username ?? ENV.opencodeUsername;

	const authFetch: typeof fetch = password
		? async (input, init) => {
				const encoded = Buffer.from(`${username}:${password}`).toString("base64");
				const headers = new Headers(init?.headers);
				headers.set("Authorization", `Basic ${encoded}`);
				return baseFetch(input, { ...init, headers });
			}
		: baseFetch;

	return createOpencodeClient({
		baseUrl: options.baseUrl,
		fetch: authFetch as any,
		directory: options.directory,
	});
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/instance/sdk-factory.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/instance/sdk-factory.ts test/unit/instance/sdk-factory.test.ts
git commit -m "feat: add SDK factory with auth and retry-fetch injection"
```

---

### Task 4: Create gap endpoints

**Files:**
- Create: `src/lib/instance/gap-endpoints.ts`
- Create: `test/unit/instance/gap-endpoints.test.ts`

These are the ~6 endpoints not in the SDK. They use the same retryFetch for consistency.

**Step 1: Write the failing tests**

```typescript
// test/unit/instance/gap-endpoints.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { GapEndpoints } from "../../../src/lib/instance/gap-endpoints.js";

describe("GapEndpoints", () => {
	function makeGap(responses: Array<{ status: number; body: unknown }>): GapEndpoints {
		let idx = 0;
		const mockFetch = async () => {
			const r = responses[idx++];
			return new Response(JSON.stringify(r.body), {
				status: r.status,
				headers: { "Content-Type": "application/json" },
			});
		};
		return new GapEndpoints({
			baseUrl: "http://localhost:4096",
			fetch: mockFetch as typeof fetch,
		});
	}

	it("listPendingPermissions returns array from GET /permission", async () => {
		const gap = makeGap([{ status: 200, body: [{ id: "p1", type: "bash" }] }]);
		const result = await gap.listPendingPermissions();
		expect(result).toEqual([{ id: "p1", type: "bash" }]);
	});

	it("listPendingPermissions returns empty array on non-array", async () => {
		const gap = makeGap([{ status: 200, body: {} }]);
		const result = await gap.listPendingPermissions();
		expect(result).toEqual([]);
	});

	it("listPendingQuestions returns array", async () => {
		const gap = makeGap([{ status: 200, body: [{ id: "q1" }] }]);
		const result = await gap.listPendingQuestions();
		expect(result).toEqual([{ id: "q1" }]);
	});

	it("replyQuestion sends POST /question/{id}/reply", async () => {
		let capturedUrl = "";
		let capturedBody: unknown;
		const gap = new GapEndpoints({
			baseUrl: "http://localhost:4096",
			fetch: async (input) => {
				const req = input instanceof Request ? input : new Request(input);
				capturedUrl = req.url;
				capturedBody = await req.json();
				return new Response(null, { status: 204 });
			},
		});
		await gap.replyQuestion("q1", [["yes"]]);
		expect(capturedUrl).toBe("http://localhost:4096/question/q1/reply");
		expect(capturedBody).toEqual({ answers: [["yes"]] });
	});

	it("rejectQuestion sends POST /question/{id}/reject", async () => {
		let capturedUrl = "";
		const gap = new GapEndpoints({
			baseUrl: "http://localhost:4096",
			fetch: async (input) => {
				const req = input instanceof Request ? input : new Request(input);
				capturedUrl = req.url;
				return new Response(null, { status: 204 });
			},
		});
		await gap.rejectQuestion("q1");
		expect(capturedUrl).toBe("http://localhost:4096/question/q1/reject");
	});

	it("listSkills returns array", async () => {
		const gap = makeGap([{ status: 200, body: [{ name: "s1" }] }]);
		const result = await gap.listSkills();
		expect(result).toEqual([{ name: "s1" }]);
	});

	it("getMessagesPage passes limit and before params", async () => {
		let capturedUrl = "";
		const gap = new GapEndpoints({
			baseUrl: "http://localhost:4096",
			fetch: async (input) => {
				const req = input instanceof Request ? input : new Request(input);
				capturedUrl = req.url;
				return new Response(JSON.stringify([]), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
		});
		await gap.getMessagesPage("s1", { limit: 10, before: "m5" });
		expect(capturedUrl).toContain("/session/s1/message");
		expect(capturedUrl).toContain("limit=10");
		expect(capturedUrl).toContain("before=m5");
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/instance/gap-endpoints.test.ts`
Expected: FAIL — module `gap-endpoints.js` does not exist

**Step 3: Write the implementation**

```typescript
// src/lib/instance/gap-endpoints.ts
// Raw-fetch helpers for endpoints not yet in the @opencode-ai/sdk.
// Uses the same retryFetch for consistency with SDK calls.

export interface GapEndpointsOptions {
	baseUrl: string;
	fetch?: typeof fetch;
	headers?: Record<string, string>;
}

/**
 * Wraps endpoints that the SDK doesn't cover yet.
 * When the SDK adds coverage, migrate each method to the SDK and delete it here.
 */
export class GapEndpoints {
	private readonly baseUrl: string;
	private readonly fetch: typeof globalThis.fetch;
	private readonly headers: Record<string, string>;

	constructor(options: GapEndpointsOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.fetch = options.fetch ?? globalThis.fetch;
		this.headers = {
			"Content-Type": "application/json",
			Accept: "application/json",
			...options.headers,
		};
	}

	// ─── Permissions ─────────────────────────────────────────────────────

	async listPendingPermissions(): Promise<unknown[]> {
		const res = await this.get("/permission");
		return Array.isArray(res) ? res : [];
	}

	// ─── Questions ───────────────────────────────────────────────────────

	async listPendingQuestions(): Promise<unknown[]> {
		const res = await this.get("/question");
		return Array.isArray(res) ? res : [];
	}

	async replyQuestion(id: string, answers: string[][]): Promise<void> {
		await this.post(`/question/${id}/reply`, { answers });
	}

	async rejectQuestion(id: string): Promise<void> {
		await this.post(`/question/${id}/reject`, {});
	}

	// ─── Skills ──────────────────────────────────────────────────────────

	async listSkills(directory?: string): Promise<Array<{ name: string; description?: string }>> {
		const path = directory
			? `/skill?directory=${encodeURIComponent(directory)}`
			: "/skill";
		const res = await this.get(path);
		return Array.isArray(res) ? res : [];
	}

	// ─── Paginated Messages ──────────────────────────────────────────────

	async getMessagesPage(
		sessionId: string,
		options?: { limit?: number; before?: string },
	): Promise<unknown[]> {
		const params = new URLSearchParams();
		if (options?.limit) params.set("limit", String(options.limit));
		if (options?.before) params.set("before", options.before);
		const query = params.toString();
		const path = `/session/${sessionId}/message${query ? `?${query}` : ""}`;
		const res = await this.get(path);
		return Array.isArray(res) ? res : [];
	}

	// ─── Internal ────────────────────────────────────────────────────────

	private async get(path: string): Promise<unknown> {
		const res = await this.fetch(
			new Request(`${this.baseUrl}${path}`, {
				method: "GET",
				headers: this.headers,
			}),
		);
		if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
		if (res.status === 204) return undefined;
		return res.json();
	}

	private async post(path: string, body: unknown): Promise<unknown> {
		const res = await this.fetch(
			new Request(`${this.baseUrl}${path}`, {
				method: "POST",
				headers: this.headers,
				body: JSON.stringify(body),
			}),
		);
		if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
		if (res.status === 204) return undefined;
		const ct = res.headers.get("content-type") ?? "";
		if (ct.includes("application/json")) return res.json();
		return undefined;
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/instance/gap-endpoints.test.ts`
Expected: PASS — all 7 tests green

**Step 5: Run full Phase 1 check**

Run: `pnpm check && pnpm test:unit`
Expected: PASS — all existing tests still pass, new tests pass

**Step 6: Commit**

```bash
git add src/lib/instance/gap-endpoints.ts test/unit/instance/gap-endpoints.test.ts
git commit -m "feat: add GapEndpoints for SDK-uncovered endpoints"
```

---

## Phase 2: Client Swap

### Task 5: Create OpenCodeAPI adapter

**Files:**
- Create: `src/lib/instance/opencode-api.ts`
- Create: `test/unit/instance/opencode-api.test.ts`

This is the core adapter that wraps the SDK + gap endpoints into a unified namespaced API. Callers will use `api.session.list()` instead of `client.listSessions()`.

**Step 1: Write the failing tests**

```typescript
// test/unit/instance/opencode-api.test.ts
import { describe, expect, it, vi } from "vitest";
import { OpenCodeAPI, type OpenCodeAPIOptions } from "../../../src/lib/instance/opencode-api.js";

// Stub SDK client — we only test that methods delegate correctly
function makeStubSdk() {
	return {
		session: {
			list: vi.fn(async () => ({ data: [{ id: "s1", title: "test" }] })),
			get: vi.fn(async () => ({ data: { id: "s1", title: "test" } })),
			create: vi.fn(async () => ({ data: { id: "s2", title: "new" } })),
			delete: vi.fn(async () => ({ data: undefined })),
			update: vi.fn(async () => ({ data: { id: "s1", title: "updated" } })),
			status: vi.fn(async () => ({ data: { s1: { type: "idle" } } })),
			messages: vi.fn(async () => ({ data: [] })),
			abort: vi.fn(async () => ({ data: undefined })),
			fork: vi.fn(async () => ({ data: { id: "s3" } })),
			revert: vi.fn(async () => ({ data: undefined })),
			unrevert: vi.fn(async () => ({ data: undefined })),
			share: vi.fn(async () => ({ data: { url: "https://share.test" } })),
			summarize: vi.fn(async () => ({ data: undefined })),
			diff: vi.fn(async () => ({ data: { diffs: [] } })),
			promptAsync: vi.fn(async () => ({ data: undefined })),
		},
		config: {
			get: vi.fn(async () => ({ data: {} })),
			update: vi.fn(async () => ({ data: {} })),
			providers: vi.fn(async () => ({ data: { all: [], default: {}, connected: [] } })),
		},
		pty: {
			list: vi.fn(async () => ({ data: [] })),
			create: vi.fn(async () => ({ data: { id: "pty1" } })),
			remove: vi.fn(async () => ({ data: undefined })),
			update: vi.fn(async () => ({ data: undefined })),
		},
		file: {
			list: vi.fn(async () => ({ data: [] })),
			read: vi.fn(async () => ({ data: { content: "hello" } })),
			status: vi.fn(async () => ({ data: [] })),
		},
		find: {
			text: vi.fn(async () => ({ data: [] })),
			files: vi.fn(async () => ({ data: [] })),
			symbols: vi.fn(async () => ({ data: [] })),
		},
		path: { get: vi.fn(async () => ({ data: { cwd: "/test" } })) },
		vcs: { get: vi.fn(async () => ({ data: { branch: "main" } })) },
		app: { agents: vi.fn(async () => ({ data: [] })) },
		command: { list: vi.fn(async () => ({ data: [] })) },
		event: { subscribe: vi.fn(async () => ({ stream: (async function* () {})() })) },
		postSessionIdPermissionsPermissionId: vi.fn(async () => ({ data: undefined })),
	} as any;
}

function makeStubGaps() {
	return {
		listPendingPermissions: vi.fn(async () => []),
		listPendingQuestions: vi.fn(async () => []),
		replyQuestion: vi.fn(async () => {}),
		rejectQuestion: vi.fn(async () => {}),
		listSkills: vi.fn(async () => []),
		getMessagesPage: vi.fn(async () => []),
	} as any;
}

describe("OpenCodeAPI", () => {
	it("session.list() delegates to sdk.session.list()", async () => {
		const sdk = makeStubSdk();
		const gaps = makeStubGaps();
		const api = new OpenCodeAPI({ sdk, gapEndpoints: gaps });
		const result = await api.session.list();
		expect(sdk.session.list).toHaveBeenCalled();
		expect(result).toEqual([{ id: "s1", title: "test" }]);
	});

	it("permission.list() delegates to gapEndpoints", async () => {
		const sdk = makeStubSdk();
		const gaps = makeStubGaps();
		gaps.listPendingPermissions.mockResolvedValue([{ id: "p1" }]);
		const api = new OpenCodeAPI({ sdk, gapEndpoints: gaps });
		const result = await api.permission.list();
		expect(gaps.listPendingPermissions).toHaveBeenCalled();
		expect(result).toEqual([{ id: "p1" }]);
	});

	it("question.reply() delegates to gapEndpoints", async () => {
		const sdk = makeStubSdk();
		const gaps = makeStubGaps();
		const api = new OpenCodeAPI({ sdk, gapEndpoints: gaps });
		await api.question.reply("q1", [["yes"]]);
		expect(gaps.replyQuestion).toHaveBeenCalledWith("q1", [["yes"]]);
	});

	it("session.prompt() builds parts array from text", async () => {
		const sdk = makeStubSdk();
		const gaps = makeStubGaps();
		const api = new OpenCodeAPI({ sdk, gapEndpoints: gaps });
		await api.session.prompt("s1", { text: "hello" });
		expect(sdk.session.promptAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				body: expect.objectContaining({
					parts: [{ type: "text", text: "hello" }],
				}),
			}),
		);
	});

	it("permission.reply() maps decision and delegates to SDK", async () => {
		const sdk = makeStubSdk();
		const gaps = makeStubGaps();
		const api = new OpenCodeAPI({ sdk, gapEndpoints: gaps });
		await api.permission.reply("s1", "perm1", "once");
		expect(sdk.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(
			expect.objectContaining({
				path: { id: "s1", permissionID: "perm1" },
				body: { response: "once" },
			}),
		);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/instance/opencode-api.test.ts`
Expected: FAIL — module `opencode-api.js` does not exist

**Step 3: Write the implementation**

```typescript
// src/lib/instance/opencode-api.ts
// Thin adapter wrapping @opencode-ai/sdk + GapEndpoints into unified namespaced API.
// Callers use api.session.list(), api.permission.reply(), etc.
// Internal gapEndpoints field is visible to maintainers — public API is unified.

import type { OpencodeClient } from "@opencode-ai/sdk/client";
import type { GapEndpoints } from "./gap-endpoints.js";

export interface OpenCodeAPIOptions {
	sdk: OpencodeClient;
	gapEndpoints: GapEndpoints;
}

export interface PromptInput {
	text: string;
	images?: string[];
	agent?: string;
	model?: { providerID: string; modelID: string };
	variant?: string;
}

/**
 * Unified API adapter for OpenCode.
 * Uses SDK for ~35 endpoints, raw-fetch GapEndpoints for ~6 uncovered ones.
 * Public namespaces (session, permission, question, etc.) are unified —
 * callers don't know which implementation backs each method.
 */
export class OpenCodeAPI {
	/** @internal SDK client — visible for maintainer clarity */
	private readonly sdk: OpencodeClient;
	/** @internal Gap endpoints — visible for maintainer clarity */
	private readonly gapEndpoints: GapEndpoints;

	constructor(options: OpenCodeAPIOptions) {
		this.sdk = options.sdk;
		this.gapEndpoints = options.gapEndpoints;
	}

	// ─── Session ──────────────────────────────────────────────────────────

	readonly session = {
		list: async (options?: { archived?: boolean; roots?: boolean; limit?: number }) => {
			const res = await this.sdk.session.list({ query: options });
			return this.unwrap(res);
		},
		get: async (id: string) => {
			const res = await this.sdk.session.get({ path: { id } });
			return this.unwrap(res);
		},
		create: async (options?: { title?: string; agentID?: string; providerID?: string; modelID?: string }) => {
			const res = await this.sdk.session.create({ body: options });
			return this.unwrap(res);
		},
		delete: async (id: string) => {
			await this.sdk.session.delete({ path: { id } });
		},
		update: async (id: string, updates: { title?: string }) => {
			const res = await this.sdk.session.update({ path: { id }, body: updates });
			return this.unwrap(res);
		},
		statuses: async () => {
			const res = await this.sdk.session.status();
			return this.unwrap(res) as Record<string, unknown>;
		},
		messages: async (id: string) => {
			const res = await this.sdk.session.messages({ path: { id } });
			return this.unwrap(res);
		},
		messagesPage: async (id: string, options?: { limit?: number; before?: string }) => {
			return this.gapEndpoints.getMessagesPage(id, options);
		},
		message: async (id: string, messageId: string) => {
			const res = await this.sdk.session.message({ path: { id, messageID: messageId } });
			return this.unwrap(res);
		},
		prompt: async (id: string, prompt: PromptInput) => {
			const parts: Array<Record<string, unknown>> = [];
			if (prompt.text) parts.push({ type: "text", text: prompt.text });
			if (prompt.images) {
				for (const img of prompt.images) {
					parts.push({ type: "file", url: img, mime: "image/png" });
				}
			}
			const body: Record<string, unknown> = { parts };
			if (prompt.agent) body["agent"] = prompt.agent;
			if (prompt.model) body["model"] = prompt.model;
			if (prompt.variant) body["variant"] = prompt.variant;
			await this.sdk.session.promptAsync({ path: { id }, body: body as any });
		},
		abort: async (id: string) => {
			await this.sdk.session.abort({ path: { id } });
		},
		fork: async (id: string, options: { messageID?: string; title?: string }) => {
			const res = await this.sdk.session.fork({ path: { id }, body: options });
			return this.unwrap(res);
		},
		revert: async (id: string, messageId: string) => {
			await this.sdk.session.revert({ path: { id }, body: { messageID: messageId } });
		},
		unrevert: async (id: string) => {
			await this.sdk.session.unrevert({ path: { id } });
		},
		share: async (id: string) => {
			const res = await this.sdk.session.share({ path: { id } });
			return this.unwrap(res);
		},
		summarize: async (id: string) => {
			await this.sdk.session.summarize({ path: { id } });
		},
		diff: async (id: string, messageId: string) => {
			const res = await this.sdk.session.diff({ path: { id }, query: { messageID: messageId } });
			return this.unwrap(res);
		},
	};

	// ─── Permission ───────────────────────────────────────────────────────

	readonly permission = {
		list: async () => {
			return this.gapEndpoints.listPendingPermissions();
		},
		reply: async (sessionId: string, permissionId: string, response: "once" | "always" | "reject") => {
			await this.sdk.postSessionIdPermissionsPermissionId({
				path: { id: sessionId, permissionID: permissionId },
				body: { response },
			});
		},
	};

	// ─── Question ─────────────────────────────────────────────────────────

	readonly question = {
		list: async () => {
			return this.gapEndpoints.listPendingQuestions();
		},
		reply: async (id: string, answers: string[][]) => {
			await this.gapEndpoints.replyQuestion(id, answers);
		},
		reject: async (id: string) => {
			await this.gapEndpoints.rejectQuestion(id);
		},
	};

	// ─── Config ───────────────────────────────────────────────────────────

	readonly config = {
		get: async () => {
			const res = await this.sdk.config.get();
			return this.unwrap(res);
		},
		update: async (config: Record<string, unknown>) => {
			const res = await this.sdk.config.update({ body: config as any });
			return this.unwrap(res);
		},
	};

	// ─── Provider ─────────────────────────────────────────────────────────

	readonly provider = {
		list: async () => {
			const res = await this.sdk.config.providers();
			return this.unwrap(res);
		},
	};

	// ─── PTY ──────────────────────────────────────────────────────────────

	readonly pty = {
		list: async () => {
			const res = await this.sdk.pty.list();
			return this.unwrap(res);
		},
		create: async (options?: { command?: string; args?: string[]; cwd?: string }) => {
			const res = await this.sdk.pty.create({ body: options as any });
			return this.unwrap(res);
		},
		delete: async (id: string) => {
			await this.sdk.pty.remove({ path: { id } });
		},
		resize: async (id: string, cols: number, rows: number) => {
			await this.sdk.pty.update({ path: { id }, body: { size: { cols, rows } } as any });
		},
	};

	// ─── File ─────────────────────────────────────────────────────────────

	readonly file = {
		list: async (path?: string) => {
			const res = await this.sdk.file.list({ query: { path: path || "." } });
			return this.unwrap(res);
		},
		read: async (path: string) => {
			const res = await this.sdk.file.read({ query: { path } });
			return this.unwrap(res);
		},
		status: async () => {
			const res = await this.sdk.file.status();
			return this.unwrap(res);
		},
	};

	// ─── Find ─────────────────────────────────────────────────────────────

	readonly find = {
		text: async (pattern: string) => {
			const res = await this.sdk.find.text({ query: { pattern } });
			return this.unwrap(res);
		},
		files: async (query: string) => {
			const res = await this.sdk.find.files({ query: { query } });
			return this.unwrap(res);
		},
		symbols: async (query: string) => {
			const res = await this.sdk.find.symbols({ query: { query } });
			return this.unwrap(res);
		},
	};

	// ─── App ──────────────────────────────────────────────────────────────

	readonly app = {
		health: async () => {
			await this.sdk.path.get();
			return { ok: true } as { ok: boolean; version?: string };
		},
		agents: async () => {
			const res = await this.sdk.app.agents();
			return this.unwrap(res);
		},
		commands: async (directory?: string) => {
			const res = await this.sdk.command.list({ query: directory ? { directory } : undefined });
			return this.unwrap(res);
		},
		skills: async (directory?: string) => {
			return this.gapEndpoints.listSkills(directory);
		},
		path: async () => {
			const res = await this.sdk.path.get();
			return this.unwrap(res);
		},
		vcs: async () => {
			const res = await this.sdk.vcs.get();
			return this.unwrap(res);
		},
		projects: async () => {
			const res = await this.sdk.project.list();
			return this.unwrap(res);
		},
		currentProject: async () => {
			const res = await this.sdk.project.current();
			return this.unwrap(res);
		},
	};

	// ─── Event (SSE) ──────────────────────────────────────────────────────

	readonly event = {
		subscribe: async () => {
			return this.sdk.event.subscribe();
		},
	};

	// ─── Utility ──────────────────────────────────────────────────────────

	/** Extract data from SDK response. SDK wraps responses as { data: T }. */
	private unwrap<T>(response: { data?: T } | T): T {
		if (response && typeof response === "object" && "data" in response) {
			return (response as { data: T }).data;
		}
		return response as T;
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/instance/opencode-api.test.ts`
Expected: PASS

**Step 5: Run type check and full tests**

Run: `pnpm check && pnpm test:unit`
Expected: PASS

**Step 6: Commit**

```bash
git add src/lib/instance/opencode-api.ts test/unit/instance/opencode-api.test.ts
git commit -m "feat: add OpenCodeAPI adapter wrapping SDK + gap endpoints"
```

---

### Task 6: Migrate relay-stack.ts to construct OpenCodeAPI

**Files:**
- Modify: `src/lib/relay/relay-stack.ts:15` (import) and construction site (~line 50-60)
- Modify: `src/lib/handlers/types.ts:7-9` (HandlerDeps.client type)

This task changes the central wiring to create `OpenCodeAPI` instead of `OpenCodeClient`. Both are available during migration — `OpenCodeClient` is kept temporarily for SSE consumer (which still uses `getBaseUrl()` and `getAuthHeaders()`).

**Step 1: Update HandlerDeps to accept OpenCodeAPI**

In `src/lib/handlers/types.ts`, change the `client` field type from `OpenCodeClient` to `OpenCodeAPI`. This requires updating the import.

**Step 2: Update relay-stack.ts construction**

Replace the `OpenCodeClient` construction with `OpenCodeAPI` construction using `createSdkClient` + `GapEndpoints`. Keep `OpenCodeClient` temporarily for SSE consumer.

**Step 3: Run type check**

Run: `pnpm check`
Expected: FAIL — all callers that use `client.listSessions()` etc. now fail because `OpenCodeAPI` uses `client.session.list()` instead.

This is expected — Task 7 will update all callers.

**Step 4: Commit (type errors expected, WIP)**

```bash
git add src/lib/relay/relay-stack.ts src/lib/handlers/types.ts
git commit -m "wip: wire OpenCodeAPI into relay-stack (callers not yet updated)"
```

---

### Task 7: Migrate all caller files to OpenCodeAPI namespaced methods

**Files to modify** (one at a time, with type check between each):
- `src/lib/handlers/agent.ts` — `client.listAgents()` → `client.app.agents()`
- `src/lib/handlers/prompt.ts` — `client.sendMessageAsync()` → `client.session.prompt()`, `client.abortSession()` → `client.session.abort()`, `client.revertSession()` → `client.session.revert()`
- `src/lib/handlers/session.ts` — `client.getSession()` → `client.session.get()`, `client.listPendingPermissions()` → `client.permission.list()`, `client.listPendingQuestions()` → `client.question.list()`, `client.forkSession()` → `client.session.fork()`, `client.getMessage()` → `client.session.message()`, `client.getMessagesPage()` → `client.session.messagesPage()`
- `src/lib/handlers/permissions.ts` — `client.replyPermission()` → `client.permission.reply()`, `client.getConfig()` → `client.config.get()`, `client.updateConfig()` → `client.config.update()`, `client.replyQuestion()` → `client.question.reply()`, `client.listPendingQuestions()` → `client.question.list()`, `client.rejectQuestion()` → `client.question.reject()`
- `src/lib/handlers/model.ts` — `client.listProviders()` → `client.provider.list()`, `client.getSession()` → `client.session.get()`, `client.updateConfig()` → `client.config.update()`
- `src/lib/handlers/files.ts` — `client.getFileContent()` → `client.file.read()`, `client.listDirectory()` → `client.file.list()`
- `src/lib/handlers/terminal.ts` — `client.createPty()` → `client.pty.create()`, `client.deletePty()` → `client.pty.delete()`, `client.listPtys()` → `client.pty.list()`, `client.resizePty()` → `client.pty.resize()`
- `src/lib/handlers/settings.ts` — `client.listCommands()` → `client.app.commands()`, `client.listProjects()` → `client.app.projects()`
- `src/lib/session/session-manager.ts` — `client.listSessions()` → `client.session.list()`, `client.getMessages()` → `client.session.messages()`, `client.createSession()` → `client.session.create()`, `client.deleteSession()` → `client.session.delete()`, `client.updateSession()` → `client.session.update()`, `client.getSession()` → `client.session.get()`
- `src/lib/session/session-status-poller.ts` — `client.getSessionStatuses()` → `client.session.statuses()`, `client.getSession()` → `client.session.get()`
- `src/lib/bridges/client-init.ts` — `client.getSession()` → `client.session.get()`, `client.listPendingPermissions()` → `client.permission.list()`, `client.listPendingQuestions()` → `client.question.list()`, `client.listAgents()` → `client.app.agents()`, `client.listProviders()` → `client.provider.list()`
- `src/lib/relay/message-poller.ts` — `client.getMessages()` → `client.session.messages()`
- `src/lib/relay/message-poller-manager.ts` — type import update
- `src/lib/provider/opencode-adapter.ts` — `client.sendMessageAsync()` → `client.session.prompt()`, `client.abortSession()` → `client.session.abort()`
- `src/lib/relay/monitoring-wiring.ts` — type import update
- `src/lib/relay/session-lifecycle-wiring.ts` — type import update
- `src/lib/relay/handler-deps-wiring.ts` — type import update
- `src/lib/relay/monitoring-reducer.ts` — type import update
- `src/lib/relay/monitoring-types.ts` — type import update
- `src/lib/session/session-status-sqlite.ts` — type import update
- `src/lib/session/status-augmentation.ts` — type import update

**Step 1: Update each file**

For each file above:
1. Change `import type { OpenCodeClient, ... } from "../instance/opencode-client.js"` to `import type { OpenCodeAPI } from "../instance/opencode-api.js"`
2. Change method calls from flat (e.g. `client.listSessions()`) to namespaced (e.g. `client.session.list()`)
3. Update any `Pick<OpenCodeClient, "getMessages">` patterns to `Pick<OpenCodeAPI["session"], "messages">`

**Step 2: Run type check after all files updated**

Run: `pnpm check`
Expected: PASS — no type errors

**Step 3: Run full test suite**

Run: `pnpm test:unit`
Expected: PASS — all tests pass (test stubs may need updating if they mock OpenCodeClient)

**Step 4: Fix any test stubs**

Update test files that create `OpenCodeClient` stubs to use the new namespaced API shape. Search for `makeStubClient` or `as unknown as OpenCodeClient` in test files.

**Step 5: Run full verification**

Run: `pnpm check && pnpm test:unit && pnpm lint`
Expected: PASS

**Step 6: Commit**

```bash
git add -A
git commit -m "refactor: migrate all callers from OpenCodeClient to OpenCodeAPI namespaced methods"
```

---

## Phase 3: Type Migration

### Task 8: Audit and map all type usages

**Files:**
- Read-only scan of all files importing from `shared-types.ts`, `types.ts`, and `opencode-client.ts`

This is a research task — no code changes. Read every file that imports types we're replacing and note exactly which SDK type replaces each usage.

**Step 1: Search for all imports of replaced types**

Run: `grep -rn "SessionDetail\|HistoryMessage\|HistoryMessagePart\|PartState\|OpenCodeEvent\|SessionStatus\|SessionInfo\|PartType\|ToolStatus" src/lib/ --include="*.ts" | grep -v node_modules | grep -v ".d.ts"`

Document which files use each type and what SDK type replaces it.

**Step 2: Document the mapping**

Create a checklist of every file + type to change. This informs Tasks 9-12.

**Step 3: No commit needed** — this is research.

---

### Task 9: Replace SessionStatus and SessionDetail types

**Files to modify:**
- `src/lib/instance/opencode-client.ts:37-40` — `SessionStatus` type (note: keep file for now, just update exports)
- `src/lib/instance/opencode-client.ts:98-117` — `SessionDetail` type
- `src/lib/session/session-status-poller.ts` — uses `SessionStatus`
- `src/lib/session/session-manager.ts` — uses `SessionDetail`, `SessionStatus`
- `src/lib/session/session-status-sqlite.ts` — uses `SessionStatus`
- `src/lib/session/status-augmentation.ts` — uses `SessionStatus`
- `src/lib/relay/monitoring-reducer.ts` — uses `SessionStatus`
- `src/lib/relay/monitoring-types.ts` — uses `SessionStatus`

The SDK `SessionStatus` is structurally identical: `{ type: "idle" } | { type: "busy" } | { type: "retry"; attempt: number; message: string; next: number }`.

The SDK `Session` replaces `SessionDetail` — it has more fields but the existing fields map directly.

**Step 1: Create a re-export bridge file**

Create `src/lib/instance/sdk-types.ts` that re-exports SDK types with any necessary aliases:

```typescript
// src/lib/instance/sdk-types.ts
// Re-export SDK types used throughout the codebase.
// Single import point for SDK types — when SDK types change, only this file updates.
export type {
	Session,
	SessionStatus,
	UserMessage,
	AssistantMessage,
	Message,
	Part,
	TextPart,
	ReasoningPart,
	FilePart,
	ToolPart,
	StepStartPart,
	StepFinishPart,
	SnapshotPart,
	PatchPart,
	AgentPart,
	RetryPart,
	CompactionPart,
	ToolState,
	ToolStatePending,
	ToolStateRunning,
	ToolStateCompleted,
	ToolStateError,
	Permission,
	Event,
	GlobalEvent,
	EventMessageUpdated,
	EventMessageRemoved,
	EventMessagePartUpdated,
	EventMessagePartRemoved,
	EventSessionStatus,
	EventPermissionUpdated,
	EventPermissionReplied,
	EventSessionCreated,
	EventSessionUpdated,
	EventSessionDeleted,
	EventFileEdited,
	EventTodoUpdated,
	EventPtyCreated,
	EventPtyExited,
	EventPtyDeleted,
} from "@opencode-ai/sdk/client";

// Alias for backward compatibility during migration
export type { Session as SessionDetail } from "@opencode-ai/sdk/client";
```

**Step 2: Update session files to import from sdk-types**

Update each file to import `SessionStatus` and `Session` from `../instance/sdk-types.js` instead of `../instance/opencode-client.js`.

**Step 3: Run type check**

Run: `pnpm check`
Expected: Some failures where `SessionDetail` fields don't match `Session` fields — fix field access (e.g. `session.time?.created` instead of `session.createdAt`).

**Step 4: Fix field access mismatches**

Key differences:
- `SessionDetail.createdAt` → `Session.time.created`
- `SessionDetail.updatedAt` → `Session.time.updated`
- `SessionDetail.archived` → `Session.time.archived` (check SDK)
- `SessionDetail.slug` → not in SDK Session (relay-specific, keep if needed)

**Step 5: Run type check and tests**

Run: `pnpm check && pnpm test:unit`
Expected: PASS

**Step 6: Commit**

```bash
git add -A
git commit -m "refactor: replace SessionDetail and SessionStatus with SDK types"
```

---

### Task 10: Replace Message and Part types

**Files to modify:**
- `src/lib/instance/opencode-client.ts:119-135` — `Message` type
- `src/lib/shared-types.ts` — `HistoryMessage`, `HistoryMessagePart`, `PartType`, `ToolStatus`
- All files importing these types (event-translator.ts, session-manager.ts, message-poller.ts, etc.)

The SDK uses discriminated unions: `Message = UserMessage | AssistantMessage`, `Part = TextPart | ToolPart | ReasoningPart | ...`.

**Step 1: Update imports in event-translator.ts**

This is the most complex file — it accesses part fields heavily. Replace `HistoryMessagePart` access patterns with SDK `Part` discriminated union access using type guards.

**Step 2: Update imports in message-poller.ts**

Replace `Message` references with SDK `Message` (which is `UserMessage | AssistantMessage`).

**Step 3: Update imports in session-manager.ts**

Replace `Message` references.

**Step 4: Update shared-types.ts**

Remove `HistoryMessage`, `HistoryMessagePart`, `PartType`, `ToolStatus` definitions. Keep relay-specific types.

**Step 5: Run type check iteratively**

Run: `pnpm check`
Fix errors one file at a time. The main change pattern is:
- `part.type === "tool"` → works (discriminated union)
- `part.state?.status` → `(part as ToolPart).state.status` (or type guard)
- `part.text` → `(part as TextPart).text` (or type guard)

**Step 6: Run tests**

Run: `pnpm test:unit`
Expected: PASS

**Step 7: Commit**

```bash
git add -A
git commit -m "refactor: replace Message and Part types with SDK discriminated unions"
```

---

### Task 11: Replace OpenCodeEvent with SDK Event type

**Files to modify:**
- `src/lib/types.ts` — `BaseOpenCodeEvent`, `OpenCodeEvent`, `GlobalEvent`, `KnownOpenCodeEvent`
- `src/lib/relay/opencode-events.ts` — all typed event interfaces and type guards
- `src/lib/relay/sse-consumer.ts` — emits `OpenCodeEvent`
- `src/lib/relay/sse-wiring.ts` — receives `OpenCodeEvent`
- `src/lib/relay/sse-backoff.ts` — parses into `OpenCodeEvent`
- `src/lib/relay/event-translator.ts` — receives `OpenCodeEvent`

The SDK provides `Event` as a discriminated union of 20+ typed event variants (e.g. `EventMessagePartUpdated`, `EventSessionStatus`). This replaces the generic `{ type: string; properties: Record<string, unknown> }` pattern.

**Step 1: Update sse-wiring.ts event handler**

Change `handleSSEEvent(event: OpenCodeEvent)` to `handleSSEEvent(event: Event)` (from SDK). Replace `event.properties.foo` with type-narrowed access: `if (event.type === "message.part.updated") { event.properties.part... }`.

**Step 2: Update event-translator.ts**

Replace `OpenCodeEvent` parameter types. The translator already switches on `event.type` — but currently uses `event.properties` as `Record<string, unknown>`. With SDK types, it gets full type narrowing.

**Step 3: Update opencode-events.ts**

The typed event interfaces and type guards can be simplified or deleted — the SDK types provide the same discrimination. Keep any type guards that add value beyond what the SDK provides.

**Step 4: Update types.ts**

Remove `BaseOpenCodeEvent`, `OpenCodeEvent`, `GlobalEvent` — replaced by SDK equivalents.

**Step 5: Run type check and fix**

Run: `pnpm check`
Expected: Multiple errors — fix each by using SDK event type narrowing.

**Step 6: Run tests**

Run: `pnpm test:unit`
Expected: PASS

**Step 7: Commit**

```bash
git add -A
git commit -m "refactor: replace OpenCodeEvent with SDK Event discriminated union"
```

---

### Task 12: Clean up remaining type references

**Files to modify:**
- `src/lib/shared-types.ts` — remove types now in SDK, keep relay-specific ones
- `src/lib/types.ts` — remove replaced types
- `src/lib/instance/opencode-client.ts` — remove type exports that are now in sdk-types.ts
- Any remaining files still importing old types

**Step 1: Audit remaining imports from old type sources**

Run: `grep -rn "from.*opencode-client" src/lib/ --include="*.ts" | grep -v node_modules`
Run: `grep -rn "from.*shared-types" src/lib/ --include="*.ts" | grep -v node_modules`

**Step 2: Remove unused type definitions**

From `shared-types.ts`, remove:
- `PartType` (replaced by `Part["type"]` discriminated union)
- `ToolStatus` (replaced by `ToolState["status"]`)
- `HistoryMessage`, `HistoryMessagePart` (replaced by SDK Message/Part)
- `SessionInfo` (replaced by SDK `Session`)

Keep: `RelayMessage`, `ToolName`, `Base16Theme`, `TodoItem`, `PtyInfo`, `FileEntry`, `ProviderInfo`, `ModelInfo`, `AgentInfo`, `CommandInfo`, and all relay-specific types.

**Step 3: Run type check and tests**

Run: `pnpm check && pnpm test:unit && pnpm lint`
Expected: PASS

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor: clean up replaced type definitions from shared-types and types"
```

---

## Phase 4: SSE Migration

### Task 13: Create SSEStream class

**Files:**
- Create: `src/lib/relay/sse-stream.ts`
- Create: `test/unit/relay/sse-stream.test.ts`

Replaces `SSEConsumer` with an SDK-backed implementation that wraps `api.event.subscribe()`.

**Step 1: Write the failing tests**

```typescript
// test/unit/relay/sse-stream.test.ts
import { describe, expect, it, vi } from "vitest";
import { ServiceRegistry } from "../../../src/lib/daemon/service-registry.js";
import { SSEStream } from "../../../src/lib/relay/sse-stream.js";

function makeStubApi(events: Array<{ type: string; properties?: unknown }>) {
	return {
		event: {
			subscribe: vi.fn(async () => ({
				stream: (async function* () {
					for (const e of events) {
						yield e;
					}
				})(),
			})),
		},
	} as any;
}

describe("SSEStream", () => {
	it("registers itself with ServiceRegistry", () => {
		const registry = new ServiceRegistry();
		const api = makeStubApi([]);
		expect(registry.size).toBe(0);
		new SSEStream(registry, { api });
		expect(registry.size).toBe(1);
	});

	it("emits 'connected' when stream starts", async () => {
		const registry = new ServiceRegistry();
		const api = makeStubApi([]);
		const stream = new SSEStream(registry, { api });

		const connected = new Promise<void>((resolve) => {
			stream.on("connected", () => resolve());
		});

		// Connect and immediately disconnect after connected event
		stream.connect().catch(() => {});
		await connected;
		await stream.disconnect();
	});

	it("emits events from the SDK stream", async () => {
		const registry = new ServiceRegistry();
		const events = [
			{ type: "message.part.updated", properties: { part: { id: "p1" } } },
			{ type: "session.status", properties: { sessionID: "s1", status: { type: "idle" } } },
		];
		const api = makeStubApi(events);
		const stream = new SSEStream(registry, { api });

		const received: unknown[] = [];
		stream.on("event", (e) => received.push(e));

		const connected = new Promise<void>((resolve) => {
			stream.on("connected", () => resolve());
		});

		stream.connect().catch(() => {});
		await connected;

		// Wait for events to propagate
		await new Promise((r) => setTimeout(r, 50));
		await stream.disconnect();

		expect(received).toHaveLength(2);
		expect(received[0]).toEqual(events[0]);
	});

	it("emits heartbeat for server.heartbeat events", async () => {
		const registry = new ServiceRegistry();
		const api = makeStubApi([{ type: "server.heartbeat" }]);
		const stream = new SSEStream(registry, { api });

		let heartbeatSeen = false;
		stream.on("heartbeat", () => { heartbeatSeen = true; });

		const connected = new Promise<void>((resolve) => {
			stream.on("connected", () => resolve());
		});

		stream.connect().catch(() => {});
		await connected;
		await new Promise((r) => setTimeout(r, 50));
		await stream.disconnect();

		expect(heartbeatSeen).toBe(true);
	});

	it("reports health state", () => {
		const registry = new ServiceRegistry();
		const api = makeStubApi([]);
		const stream = new SSEStream(registry, { api });
		const health = stream.getHealth();
		expect(health).toHaveProperty("connected");
		expect(health).toHaveProperty("lastEventAt");
		expect(health).toHaveProperty("reconnectCount");
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/relay/sse-stream.test.ts`
Expected: FAIL — module does not exist

**Step 3: Write the implementation**

```typescript
// src/lib/relay/sse-stream.ts
// SSE consumer backed by @opencode-ai/sdk's event.subscribe().
// Replaces the manual SSE parser with SDK streaming + reconnection/health wrapper.

import type { ServiceRegistry } from "../daemon/service-registry.js";
import { TrackedService } from "../daemon/tracked-service.js";
import { createSilentLogger, type Logger } from "../logger.js";
import type { ConnectionHealth } from "../types.js";
import {
	type BackoffConfig,
	calculateBackoffDelay,
	createHealthTracker,
	type HealthTracker,
} from "./sse-backoff.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SSEStreamOptions {
	api: { event: { subscribe(): Promise<{ stream: AsyncGenerator<unknown> }> } };
	backoff?: Partial<BackoffConfig>;
	staleThreshold?: number;
	log?: Logger;
}

export type SSEStreamEvents = {
	event: [unknown]; // SDK Event type — consumers cast as needed
	connected: [];
	disconnected: [Error | undefined];
	reconnecting: [{ attempt: number; delay: number }];
	error: [Error];
	heartbeat: [];
};

// ─── SSE Stream ──────────────────────────────────────────────────────────────

export class SSEStream extends TrackedService<SSEStreamEvents> {
	private readonly api: SSEStreamOptions["api"];
	private readonly backoffConfig: BackoffConfig;
	private readonly healthTracker: HealthTracker;
	private readonly log: Logger;

	private running = false;
	private abortController: AbortController | null = null;
	private reconnectAttempt = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(registry: ServiceRegistry, options: SSEStreamOptions) {
		super(registry);
		this.api = options.api;
		this.log = options.log ?? createSilentLogger();

		this.backoffConfig = {
			baseDelay: options.backoff?.baseDelay ?? 1000,
			maxDelay: options.backoff?.maxDelay ?? 30000,
			multiplier: options.backoff?.multiplier ?? 2,
		};

		this.healthTracker = createHealthTracker({
			staleThreshold: options.staleThreshold ?? 60_000,
		});
	}

	/** Start consuming SSE events via SDK. Does not throw — errors are emitted. */
	async connect(): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.reconnectAttempt = 0;
		this.tracked(this.consumeLoop().catch((err) => {
			if (!this.running) return;
			const error = err instanceof Error ? err : new Error(String(err));
			this.emit("error", error);
		}));
	}

	/** Stop consuming and clean up */
	async disconnect(): Promise<void> {
		this.running = false;
		if (this.reconnectTimer) {
			this.clearTrackedTimer(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}
		this.healthTracker.onDisconnected();
	}

	/** Get connection health snapshot */
	getHealth(): ConnectionHealth & { stale: boolean } {
		return this.healthTracker.getHealth();
	}

	/** Check if actively connected and consuming */
	isConnected(): boolean {
		return this.running && this.healthTracker.getHealth().connected;
	}

	/** Kill stream and drain tracked work. */
	override async drain(): Promise<void> {
		await this.disconnect();
		await super.drain();
	}

	// ─── Internal ──────────────────────────────────────────────────────────

	private async consumeLoop(): Promise<void> {
		while (this.running) {
			try {
				const { stream } = await this.api.event.subscribe();

				// Connected
				this.reconnectAttempt = 0;
				this.healthTracker.onConnected();
				this.emit("connected");

				for await (const event of stream) {
					if (!this.running) break;

					const evt = event as { type?: string; [key: string]: unknown };

					// Track health
					this.healthTracker.onEvent();

					// Handle heartbeat/connected events
					if (evt.type === "server.heartbeat" || evt.type === "server.connected") {
						this.emit("heartbeat");
						continue;
					}

					// Emit data event
					this.emit("event", event);
				}

				// Stream ended normally — reconnect if still running
				if (this.running) {
					this.healthTracker.onDisconnected();
					this.emit("disconnected", undefined);
				}
			} catch (err) {
				if (!this.running) return;

				const error = err instanceof Error ? err : new Error(String(err));
				if (error.name === "AbortError") return;

				this.healthTracker.onDisconnected();
				this.emit("disconnected", error);
				this.emit("error", error);
			}

			// Reconnect with backoff
			if (this.running) {
				const delay = calculateBackoffDelay(this.reconnectAttempt, this.backoffConfig);
				this.reconnectAttempt++;
				this.healthTracker.onReconnect();
				this.emit("reconnecting", { attempt: this.reconnectAttempt, delay });

				await new Promise<void>((resolve) => {
					this.reconnectTimer = this.delayed(() => {
						this.reconnectTimer = null;
						resolve();
					}, delay);
				});
			}
		}
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/relay/sse-stream.test.ts`
Expected: PASS

**Step 5: Run type check**

Run: `pnpm check`
Expected: PASS

**Step 6: Commit**

```bash
git add src/lib/relay/sse-stream.ts test/unit/relay/sse-stream.test.ts
git commit -m "feat: add SSEStream backed by SDK event.subscribe() with reconnection"
```

---

### Task 14: Wire SSEStream into relay-stack and sse-wiring

**Files:**
- Modify: `src/lib/relay/relay-stack.ts` — replace `SSEConsumer` construction with `SSEStream`
- Modify: `src/lib/relay/sse-wiring.ts` — update event type from `OpenCodeEvent` to SDK `Event`

**Step 1: Update relay-stack.ts**

Replace `new SSEConsumer(registry, { baseUrl, authHeaders })` with `new SSEStream(registry, { api })`. Remove the `baseUrl`/`authHeaders` extraction from `OpenCodeClient`.

**Step 2: Update sse-wiring.ts**

Change the event handler to receive SDK `Event` type. Update field access from `event.properties.*` to direct property access on the typed event variants.

**Step 3: Run type check**

Run: `pnpm check`
Expected: Fix any remaining type mismatches in wiring code.

**Step 4: Run full test suite**

Run: `pnpm test:unit`
Expected: PASS — SSE wiring tests may need stub updates

**Step 5: Commit**

```bash
git add src/lib/relay/relay-stack.ts src/lib/relay/sse-wiring.ts
git commit -m "refactor: wire SSEStream into relay-stack replacing SSEConsumer"
```

---

## Phase 5: Cleanup

### Task 15: Delete OpenCodeClient and old SSE consumer

**Files:**
- Delete: `src/lib/instance/opencode-client.ts` (691 lines)
- Delete: `src/lib/relay/sse-consumer.ts` (284 lines)
- Possibly delete: `test/unit/relay/sse-consumer.test.ts` (if fully replaced by sse-stream tests)

**Step 1: Verify no remaining imports**

Run: `grep -rn "from.*opencode-client" src/ --include="*.ts" | grep -v node_modules`
Run: `grep -rn "from.*sse-consumer" src/ --include="*.ts" | grep -v node_modules`

Expected: Zero matches (or only test files)

**Step 2: Delete the files**

```bash
rm src/lib/instance/opencode-client.ts
rm src/lib/relay/sse-consumer.ts
```

**Step 3: Run type check and tests**

Run: `pnpm check && pnpm test:unit`
Expected: PASS — if any test files reference deleted modules, update or delete them.

**Step 4: Commit**

```bash
git add -A
git commit -m "cleanup: delete OpenCodeClient (691 lines) and SSEConsumer (284 lines)"
```

---

### Task 16: Clean up unused SSE utilities and type files

**Files to audit:**
- `src/lib/relay/sse-backoff.ts` — check if SSEStream still uses `calculateBackoffDelay`, `createHealthTracker`. Delete unused functions (`parseSSEData`, `parseSSEDataAuto`, `parseGlobalSSEData`, `isKnownEventType`, `classifyEventType`, `eventBelongsToSession`, `filterEventsBySession`, `getSessionIds`).
- `src/lib/relay/opencode-events.ts` — check if type guards are still used. If SDK Event union replaces all, delete.
- `src/lib/types.ts` — remove any remaining dead type exports.
- `src/lib/shared-types.ts` — final cleanup of replaced types.

**Step 1: Check what's still imported from sse-backoff.ts**

Run: `grep -rn "from.*sse-backoff" src/ --include="*.ts" | grep -v node_modules`

**Step 2: Delete unused exports**

Remove functions no longer needed. Keep `calculateBackoffDelay`, `createHealthTracker`, `BackoffConfig`, `HealthTracker` if still used by `SSEStream`.

**Step 3: Check opencode-events.ts**

Run: `grep -rn "from.*opencode-events" src/ --include="*.ts" | grep -v node_modules`

If no imports remain, delete the file.

**Step 4: Run type check, lint, and tests**

Run: `pnpm check && pnpm test:unit && pnpm lint`
Expected: PASS

**Step 5: Commit**

```bash
git add -A
git commit -m "cleanup: remove unused SSE parsing utilities and dead type definitions"
```

---

### Task 17: Final verification and lint

**Step 1: Run full build**

Run: `pnpm build`
Expected: PASS — TypeScript compiles cleanly

**Step 2: Run all tests**

Run: `pnpm test`
Expected: PASS — all unit + fixture tests green

**Step 3: Run lint**

Run: `pnpm lint`
Expected: PASS — no lint/format issues

**Step 4: Run type check**

Run: `pnpm check`
Expected: PASS

**Step 5: Review deleted line count**

Run: `git diff --stat main...HEAD` (or since the first commit of this plan)
Expected: Net reduction of ~800+ lines (691 from OpenCodeClient + 284 from SSEConsumer - new code)

**Step 6: Commit any final fixes**

```bash
git add -A
git commit -m "chore: final verification — SDK migration complete"
```

---

## Summary

| Phase | Tasks | Key outcome |
|-------|-------|-------------|
| 1. Foundation | 1-4 | SDK dep, retryFetch, sdk-factory, gap-endpoints |
| 2. Client Swap | 5-7 | OpenCodeAPI adapter, relay-stack wiring, all callers migrated |
| 3. Type Migration | 8-12 | SDK types canonical, sdk-types.ts re-export bridge, shared-types gutted |
| 4. SSE Migration | 13-14 | SSEStream replaces SSEConsumer, wiring updated |
| 5. Cleanup | 15-17 | Delete old files, remove dead code, final verification |

**Total tasks:** 17
**Estimated net line change:** -800+ lines deleted (simpler codebase)
**Risk mitigation:** System works at every phase boundary. Each commit is independently revertable.
