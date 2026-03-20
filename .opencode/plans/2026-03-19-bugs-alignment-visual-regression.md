# Bug Fixes + Style Alignment + Visual Regression Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Fix 3 bugs (theme picker, message widths, debug resize icon), apply 13 mockup style alignments, fix mockup breadcrumb, and expand Storybook visual regression to cover all 166 stories across 41 components.

**Architecture:** Three phases — Phase 1 fixes bugs (3 tasks), Phase 2 aligns styles (13 tasks), Phase 3 builds visual regression infrastructure. Phases 1-2 are parallelizable. Phase 3 depends on Phase 2 completing (golden snapshots must be generated after all style fixes).

**Tech Stack:** Svelte 5, Tailwind CSS v4, Playwright, Storybook 10, pixelmatch

**Verification:** `pnpm check && pnpm lint && pnpm test:unit` after each phase. `pnpm test:storybook-visual` after Phase 3.

---

## Phase 1: Bug Fixes

### Task 1: Fix ThemePicker clipping (move out of sidebar)

**Files:**
- Modify: `src/lib/frontend/components/layout/Sidebar.svelte:290`

**Step 1:** Move `<ThemePicker />` from line 290 (inside the `#sidebar` div) to AFTER the closing `</div>` of the sidebar container (after line 303). The ThemePicker uses `position: fixed` so it renders correctly anywhere in the DOM. Moving it outside the `overflow-hidden` sidebar div prevents clipping.

Change: Remove line 290 (`<ThemePicker />`).

Add after line 303 (after the closing `</div>` of the sidebar):
```svelte
<ThemePicker />
```

**Step 2: Verify**
Run: `pnpm check && pnpm lint`

---

### Task 2: Fix UserMessage width (remove inner max-w-[680px])

**Files:**
- Modify: `src/lib/frontend/components/chat/UserMessage.svelte:18`

**Step 1:** Find the inner card div (line 18):
```svelte
class="bg-bg-surface rounded-[10px] py-4 px-5 relative glow-brand-a max-w-[680px]"
```

Remove `max-w-[680px]`:
```svelte
class="bg-bg-surface rounded-[10px] py-4 px-5 relative glow-brand-a"
```

**Step 2: Verify**
Run: `pnpm check && pnpm lint`

---

### Task 3: Fix DebugPanel resize icon direction

**Files:**
- Modify: `src/lib/frontend/components/debug/DebugPanel.svelte:224-225`

**Step 1:** The SVG grip lines draw `◢` (pointing bottom-right) but the handle is at top-left. Flip the secondary line so the grip draws `◤`:

Change lines 224-225:
```svelte
<line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" stroke-width="1.5" />
<line x1="1" y1="5" x2="5" y2="9" stroke="currentColor" stroke-width="1.5" />
```

To:
```svelte
<line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" stroke-width="1.5" />
<line x1="5" y1="1" x2="9" y2="5" stroke="currentColor" stroke-width="1.5" />
```

**Step 2: Verify**
Run: `pnpm check && pnpm lint`

---

## Phase 2: Style Alignment (13 changes)

These can be parallelized by file. Group by file to minimize conflicts:

**Batch A (InputArea.svelte):** Tasks 4, 5
**Batch B (ToolItem.svelte):** Tasks 8, 9, 15
**Batch C (ThinkingBlock.svelte):** Tasks 10, 11
**Batch D (ConnectOverlay.svelte):** Tasks 12, 13
**Batch E (single-file changes):** Tasks 6, 7, 14, 16, 17

### Task 4: Fix attach button shape

**Files:**
- Modify: `src/lib/frontend/components/layout/InputArea.svelte`

Find the attach button (around line 498). Change from 36px transparent circle to 28px bordered square:

From: `class="w-9 h-9 rounded-full border-none bg-transparent text-text-muted..."`
To: `class="w-7 h-7 rounded-md border border-border bg-bg-alt text-text-muted cursor-pointer flex items-center justify-center transition-[background,color] duration-150 hover:bg-bg-surface hover:text-text"`

---

### Task 5: Fix send/stop button shape

**Files:**
- Modify: `src/lib/frontend/components/layout/InputArea.svelte`

Find send button (around line 547). Change `w-9 h-9 rounded-full` to `w-8 h-8 rounded-[10px]`.
Find stop button (around line 556). Change `w-9 h-9 rounded-full` to `w-8 h-8 rounded-[10px]`.

---

### Task 6: Fix breadcrumb double-slash

**Files:**
- Modify: `src/lib/frontend/components/features/SidebarFilePanel.svelte:152`
- Modify: `docs/mockups/73-draft-final-addendum.html` (section 24 breadcrumbs)

In `SidebarFilePanel.svelte`, change line 152:
```svelte
{#if i > 0}
```
To:
```svelte
{#if i > 1}
```

This skips the separator for the first child after root (since root's label IS `/`).

In the mockup, fix the corresponding breadcrumb HTML to not show `//`.

---

### Task 7: Dim resolved permission cards

**Files:**
- Modify: `src/lib/frontend/components/features/PermissionCard.svelte:176`

Change:
```svelte
<div class="perm-resolved text-sm py-2">
```
To:
```svelte
<div class="perm-resolved text-sm py-2 opacity-60">
```

---

### Task 8: Fix tool name color

**Files:**
- Modify: `src/lib/frontend/components/chat/ToolItem.svelte`

Find all `tool-name` spans. Change `text-text-secondary` to `text-text`.

---

### Task 9: Fix tool result box padding

**Files:**
- Modify: `src/lib/frontend/components/chat/ToolItem.svelte`

Find the result container with `py-2 px-2.5` (near `bg-code-bg`). Change to `py-3 px-4`.

---

### Task 10: Add italic to thinking label

**Files:**
- Modify: `src/lib/frontend/components/chat/ThinkingBlock.svelte`

Find streaming label (around line 61):
```svelte
<span class="text-xs text-brand-b font-medium">{label}…</span>
```
Add `italic`:
```svelte
<span class="text-xs text-brand-b font-medium italic">{label}…</span>
```

---

### Task 11: Fix thinking content line-height

**Files:**
- Modify: `src/lib/frontend/components/chat/ThinkingBlock.svelte`

Find expanded content (around line 91) with `leading-[1.55]`. Change to `leading-[1.7]`.

---

### Task 12: Add radial glow orb to loading page

**Files:**
- Modify: `src/lib/frontend/components/overlays/ConnectOverlay.svelte:160-165`

After the `<div id="connect-overlay"...>` opening tag (line 162), add:
```svelte
<!-- Radial glow orb -->
<div class="absolute w-[400px] h-[400px] rounded-full pointer-events-none" style="top:50%;left:50%;transform:translate(-50%,-50%);background:radial-gradient(circle, rgba(255,45,123,0.08) 0%, rgba(0,229,255,0.05) 40%, transparent 70%);"></div>
```

Change the content wrapper (line 165) to:
```svelte
<div class="flex flex-col items-center gap-6 relative z-10">
```

---

### Task 13: Fix loading page background opacity

**Files:**
- Modify: `src/lib/frontend/components/overlays/ConnectOverlay.svelte:162`

Change `bg-bg/95` to `bg-bg`.

---

### Task 14: Add bounce bar track background

**Files:**
- Modify: `src/lib/frontend/components/chat/MessageList.svelte:267`

Add `bg-bg-alt` to the track div:
```svelte
class="h-[3px] rounded-full overflow-hidden bg-bg-alt"
```

---

### Task 15: Fix tool result max-height

**Files:**
- Modify: `src/lib/frontend/components/chat/ToolItem.svelte`

Find `max-h-[300px]` on the result container. Change to `max-h-[200px]`.

---

### Task 16: Fix command menu active item background

**Files:**
- Modify: `src/lib/frontend/components/features/CommandMenu.svelte:119`

Change `bg-accent-bg hover:bg-accent-bg` to `bg-bg-alt hover:bg-bg-alt`.

---

### Task 17: Phase 2 verification

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: All pass.

---

## Phase 3: Storybook Visual Regression

### Task 18: Expand visual regression spec to auto-discover all stories

**Files:**
- Modify: `test/visual/components.spec.ts`

Replace the entire file with an auto-discovery approach that reads from the built Storybook's `index.json`:

```typescript
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ─── Story Discovery ─────────────────────────────────────────────────────────

interface StoryEntry {
	id: string;
	title: string;
	name: string;
	type: "story" | "docs";
}

function loadStories(): StoryEntry[] {
	const indexPath = join(process.cwd(), "dist", "storybook", "index.json");
	const data = JSON.parse(readFileSync(indexPath, "utf-8"));
	const entries: Record<string, StoryEntry> = data.entries ?? data.stories ?? {};
	return Object.values(entries).filter((e) => e.type === "story");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function freezeAnimations(page: import("@playwright/test").Page) {
	await page.addStyleTag({
		content: `*, *::before, *::after {
			animation-delay: -0.0001s !important;
			animation-duration: 0s !important;
			animation-play-state: paused !important;
			transition-duration: 0s !important;
			transition-delay: 0s !important;
			caret-color: transparent !important;
		}`,
	});
	await page.waitForTimeout(50);
}

async function waitForStoryRender(page: import("@playwright/test").Page) {
	// Wait for fonts
	await page.evaluate(() => document.fonts.ready);
	// Wait for Storybook root to be present
	await page.waitForSelector("#storybook-root", { state: "attached", timeout: 10_000 }).catch(() => {});
	// Extra frame for async renders
	await page.waitForTimeout(300);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

const stories = loadStories();

// Group stories by component title for organized test output
const byTitle = new Map<string, StoryEntry[]>();
for (const story of stories) {
	const existing = byTitle.get(story.title) ?? [];
	existing.push(story);
	byTitle.set(story.title, existing);
}

for (const [title, componentStories] of byTitle) {
	test.describe(title, () => {
		for (const story of componentStories) {
			test(story.name, async ({ page }) => {
				await page.goto(`/iframe.html?id=${story.id}&viewMode=story`);
				await waitForStoryRender(page);
				await freezeAnimations(page);
				await expect(page.locator("#storybook-root")).toHaveScreenshot(
					`${story.id}.png`,
				);
			});
		}
	});
}
```

**Step 2:** Rebuild Storybook to include new BlockGrid/ConduitLogo stories:
```bash
pnpm storybook:build
```

**Step 3:** Generate initial golden snapshots:
```bash
pnpm test:storybook-visual:update
```

This creates ~166 golden PNGs (one per story) in `test/visual/components.spec.ts-snapshots/` for each Playwright project (desktop, mobile).

**Step 4:** Verify the snapshots were generated:
```bash
ls test/visual/components.spec.ts-snapshots/ | wc -l
```
Expected: ~332 files (166 stories × 2 viewports).

**Step 5:** Run the visual regression suite to confirm all pass against the fresh snapshots:
```bash
pnpm test:storybook-visual
```
Expected: All 166 tests pass on both desktop and mobile (332 total).

---

### Task 19: Clean up old proof-of-concept snapshots

**Files:**
- Delete: `test/visual/components.spec.ts-snapshots/App-default-1-desktop-darwin.png`
- Delete: `test/visual/components.spec.ts-snapshots/App-default-1-mobile-darwin.png`

These are from the Phase 0 proof-of-concept and will be replaced by the new `app--default.png` snapshots.

---

### Task 20: Final full verification

Run the complete test suite:
```bash
pnpm check && pnpm lint && pnpm test:unit && pnpm test:storybook-visual
```

Expected: All pass. The Storybook visual tests should show ~332 passing tests (166 stories × 2 viewports).
