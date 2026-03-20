# Storybook Visual Regression Fixes Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Fix all 84 failing Storybook visual regression stories so every story generates a valid golden snapshot, plus add a Storybook render health check script.

**Architecture:** Three work streams — (1) fix the test spec to handle fixed-position and intentionally-empty stories, (2) fix broken story decorators that discard args, (3) add a Storybook health check script. These are independent and can run in parallel by file.

**Tech Stack:** Storybook 10, Playwright, Svelte 5

---

## Task 1: Make test spec resilient to zero-height root

**Files:**
- Modify: `test/visual/components.spec.ts`

**Step 1:** Replace the screenshot logic to handle three cases:
1. Normal stories: screenshot `#storybook-root` (current behavior)
2. Fixed-position stories where root is zero-height: screenshot the full page
3. Intentionally empty stories: skip with a tag

Add a `SKIP_STORIES` set for intentionally-empty stories. For the rest, detect zero-height and fall back to full-page screenshot:

```typescript
// Stories that intentionally render nothing (hidden/empty states)
const SKIP_STORIES = new Set([
	"features-agentselector--single-agent",
	"features-agentselector--no-agents",
	"overlays-confirmmodal--hidden",
	"overlays-imagelightbox--hidden",
	"overlays-qrmodal--hidden",
	"overlays-notifsettings--closed",
	"overlays-rewindbanner--inactive",
	"overlays-connectoverlay--connected",
]);
```

In the test body, after waiting and freezing animations:
```typescript
if (SKIP_STORIES.has(story.id)) {
	test.skip(true, "Intentionally empty/hidden story");
	return;
}

const root = page.locator("#storybook-root");
const box = await root.boundingBox();
if (box && box.height > 0) {
	await expect(root).toHaveScreenshot(`${story.id}.png`);
} else {
	// Fixed-position content escapes root — use full page
	await expect(page).toHaveScreenshot(`${story.id}.png`);
}
```

**Step 2: Verify**
Run: `pnpm check`

---

## Task 2: Fix CommandMenu.stories.ts decorator

**Files:**
- Modify: `src/lib/frontend/components/features/CommandMenu.stories.ts:53-61`

**Step 1:** The decorator creates a bare `CommandMenu` instance discarding all args. Replace with a wrapper div that provides the positioning context, and let Storybook handle component rendering normally:

Replace lines 53-61:
```typescript
decorators: [
	() => ({
		Component: CommandMenu,
		props: {
			style: "position: relative; height: 350px; display: flex; align-items: flex-end;",
		},
	}),
],
```

With a decorator that wraps the story in a positioned container:
```typescript
decorators: [
	(story) => ({
		...story(),
		props: {
			...story().props,
			style: "position: relative; height: 350px; display: flex; align-items: flex-end;",
		},
	}),
],
```

However, Storybook 10 Svelte decorators work differently. The correct pattern for Storybook 10 + Svelte is to use a wrapper component or the `template` approach. The simplest fix: remove the decorator entirely and add inline styles via `parameters.layout` or a wrapper `<div>` in a separate decorator Svelte component.

Actually, the simplest reliable fix: change the meta to NOT use a decorator, and instead set `parameters.layout: 'padded'` and let each story provide its own wrapper via a `render` function:

Replace the `decorators` array entirely with nothing. Add a `render` function to each story that wraps in the positioning div. Or simpler: just add `style` to the component's own args since CommandMenu accepts `class` and style props via Svelte's `{...$$restProps}`.

Safest approach — use the Storybook 10 `decorators` Svelte snippet pattern. If that's not available, the simplest working fix is to just remove the decorator and accept the slightly different layout in Storybook.

**Best approach:** Remove the broken decorator, wrap the component in each story via the `render` function or just accept the default Storybook layout. The decorator was only providing a `position: relative; height: 350px` container. The stories will render correctly without it — the menu just won't have a specific height context.

Change to:
```typescript
const meta = {
	title: "Features/CommandMenu",
	component: CommandMenu,
	tags: ["autodocs"],
	// Remove decorators entirely
} satisfies Meta<typeof CommandMenu>;
```

**Step 2: Verify**
Run: `pnpm check && pnpm storybook:build`

---

## Task 3: Fix FileMenu.stories.ts decorator

**Files:**
- Modify: `src/lib/frontend/components/features/FileMenu.stories.ts:27-35`

**Step 1:** Same issue as CommandMenu. Remove the broken decorator:

Change to:
```typescript
const meta = {
	title: "Features/FileMenu",
	component: FileMenu,
	tags: ["autodocs"],
	// Remove decorators entirely
} satisfies Meta<typeof FileMenu>;
```

**Step 2: Verify**
Run: `pnpm check`

---

## Task 4: Fix SessionItem.stories.ts decorator

**Files:**
- Modify: `src/lib/frontend/components/features/SessionItem.stories.ts:13-20`

**Step 1:** Remove the broken decorator. The width constraint can be applied via args or inline:

Change to:
```typescript
const meta = {
	title: "Features/SessionItem",
	component: SessionItem,
	tags: ["autodocs"],
	// Remove broken decorator, apply width constraint globally
	parameters: {
		layout: "padded",
	},
} satisfies Meta<typeof SessionItem>;
```

Then for each story, wrap the args in a way that the component gets `style="width: 240px"` if needed, or just accept full-width rendering.

**Step 2: Verify**
Run: `pnpm check`

---

## Task 5: Fix NotifSettings.stories.ts decorator

**Files:**
- Modify: `src/lib/frontend/components/overlays/NotifSettings.stories.ts:7-14`

**Step 1:** Remove the broken decorator:

Change to:
```typescript
const meta = {
	title: "Overlays/NotifSettings",
	component: NotifSettings,
	tags: ["autodocs"],
	// Remove broken decorator
} satisfies Meta<typeof NotifSettings>;
```

**Step 2: Verify**
Run: `pnpm check`

---

## Task 6: Create Storybook health check script

**Files:**
- Create: `scripts/check-storybook-health.mjs`

**Step 1:** Write a Node.js script that:
1. Reads `dist/storybook/index.json` to discover all stories
2. Launches a Playwright browser
3. For each story, navigates to the iframe URL and checks:
   - Did the page load (HTTP 200)?
   - Are there console errors (excluding known noise like `vite-inject-mocker`)?
   - Does `#storybook-root` have children?
   - What are the dimensions of `#storybook-root`?
4. Outputs a summary: pass/warn/fail per story

```javascript
#!/usr/bin/env node
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BASE_URL = process.env.STORYBOOK_URL || "http://localhost:6007";
const indexPath = join(process.cwd(), "dist", "storybook", "index.json");

const data = JSON.parse(readFileSync(indexPath, "utf-8"));
const stories = Object.values(data.entries ?? {}).filter(e => e.type === "story");

console.log(`Checking ${stories.length} stories...\n`);

const browser = await chromium.launch();
const results = { pass: 0, warn: 0, fail: 0, errors: [] };

for (const story of stories) {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	const errors = [];
	page.on("pageerror", (err) => {
		if (!err.message.includes("Unexpected token 'export'")) {
			errors.push(err.message);
		}
	});

	try {
		const resp = await page.goto(
			`${BASE_URL}/iframe.html?id=${story.id}&viewMode=story`,
			{ waitUntil: "domcontentloaded", timeout: 8000 },
		);

		if (!resp || resp.status() >= 400) {
			console.log(`  FAIL  ${story.id} — HTTP ${resp?.status()}`);
			results.fail++;
			results.errors.push({ id: story.id, reason: `HTTP ${resp?.status()}` });
			continue;
		}

		await page.waitForTimeout(800);

		const info = await page.evaluate(() => {
			const root = document.querySelector("#storybook-root");
			if (!root) return { exists: false, width: 0, height: 0, children: 0 };
			const rect = root.getBoundingClientRect();
			return {
				exists: true,
				width: Math.round(rect.width),
				height: Math.round(rect.height),
				children: root.children.length,
			};
		});

		if (errors.length > 0) {
			console.log(`  FAIL  ${story.id} — JS errors: ${errors[0].slice(0, 80)}`);
			results.fail++;
			results.errors.push({ id: story.id, reason: `JS error: ${errors[0].slice(0, 100)}` });
		} else if (!info.exists || info.children === 0) {
			console.log(`  FAIL  ${story.id} — No root or empty`);
			results.fail++;
			results.errors.push({ id: story.id, reason: "Empty #storybook-root" });
		} else if (info.height === 0) {
			console.log(`  WARN  ${story.id} — Zero height (${info.width}x${info.height}, ${info.children} children)`);
			results.warn++;
		} else {
			console.log(`  PASS  ${story.id} — ${info.width}x${info.height}`);
			results.pass++;
		}
	} catch (err) {
		console.log(`  FAIL  ${story.id} — ${err.message.slice(0, 80)}`);
		results.fail++;
		results.errors.push({ id: story.id, reason: err.message.slice(0, 100) });
	} finally {
		await page.close();
	}
}

await browser.close();

console.log(`\n${"=".repeat(60)}`);
console.log(`Results: ${results.pass} pass, ${results.warn} warn, ${results.fail} fail`);
if (results.errors.length > 0) {
	console.log(`\nFailures:`);
	for (const e of results.errors) {
		console.log(`  ${e.id}: ${e.reason}`);
	}
}
process.exit(results.fail > 0 ? 1 : 0);
```

**Step 2:** Add a package.json script:
In `package.json`, add:
```json
"check:storybook": "node scripts/check-storybook-health.mjs"
```

**Step 3: Verify**
Run: `npx http-server dist/storybook -p 6007 -s & sleep 2 && node scripts/check-storybook-health.mjs; pkill -f 'http-server'`

---

## Task 7: Rebuild Storybook and regenerate all snapshots

**Step 1:** Rebuild Storybook:
```bash
pnpm storybook:build
```

**Step 2:** Delete all existing snapshots:
```bash
rm -rf test/visual/components.spec.ts-snapshots/
```

**Step 3:** Generate fresh snapshots (run multiple times if needed due to timeouts — already-captured stories are skipped):
```bash
pnpm test:storybook-visual:update
```

**Step 4:** Count snapshots and verify all non-skipped stories have one:
```bash
ls test/visual/components.spec.ts-snapshots/ | wc -l
```
Expected: ~167 desktop files (175 stories - 8 skipped).

**Step 5:** Run the visual regression suite to confirm all pass:
```bash
pnpm test:storybook-visual
```

---

## Task 8: Final verification

Run full test suite:
```bash
pnpm check && pnpm lint && pnpm test:unit
```

Run health check:
```bash
npx http-server dist/storybook -p 6007 -s & sleep 2 && node scripts/check-storybook-health.mjs; pkill -f 'http-server'
```

Expected: All unit tests pass. Health check shows 0 failures (only warns for intentionally zero-height overlay stories).
