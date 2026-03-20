# Mockup Style Alignment Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Align all Svelte components with the designs in `docs/mockups/73-draft-final-addendum.html` and `docs/mockups/68-draft-final.html`, plus fix the breadcrumb double-slash bug.

**Architecture:** 14 tasks: 13 targeted style fixes across 9 component files + 1 mockup HTML fix. All are CSS/class changes — no logic changes. Most can be parallelized since they touch different files.

**Tech Stack:** Svelte 5, Tailwind CSS v4, inline styles

**Parallelization:** Tasks 1-4 can run in parallel (different files). Tasks 5-9 can run in parallel (different files, except 6+7+13 share ToolItem). Tasks 10+11 share ConnectOverlay so must be sequential. Task 14 runs last.

---

### Task 1: Fix breadcrumb double-slash

**Files:**
- Modify: `src/lib/frontend/components/features/SidebarFilePanel.svelte:150-166`
- Modify: `docs/mockups/73-draft-final-addendum.html` (section 24 breadcrumbs — find the double `//` in the breadcrumb HTML and fix to show `/` then `src` then `/` then `lib`)

**Step 1:** In `SidebarFilePanel.svelte`, the breadcrumbs derived starts with `{ label: "/", path: "." }`. When at `src/lib`, rendering produces: `/` (root label) + `/` (separator before "src") = `//src/lib`. Fix by not rendering the separator when `i === 1` and the first crumb is root:

Change lines 152-153:
```svelte
{#if i > 0}
    <span class="text-text-dimmer">/</span>
```
To:
```svelte
{#if i > 0 && breadcrumbs[0]?.label !== "/" || i > 1}
    <span class="text-text-dimmer">/</span>
```

Or simpler: since root is always first, just check `i > 1`:
```svelte
{#if i > 1}
    <span class="text-text-dimmer">/</span>
```

(The root crumb already renders as `/`, so the first child doesn't need a preceding separator.)

**Step 2:** In the mockup HTML section 24, fix the breadcrumb. Find:
```html
<span style="...font-weight:500;">/</span>
<span style="...text-dimmer;">/ </span>
<span style="...font-weight:500;">src</span>
```
Remove the second `/` span or change it to not show a double slash.

**Step 3: Verify**
Run: `pnpm check && pnpm lint`

---

### Task 2: Fix attach button shape

**Files:**
- Modify: `src/lib/frontend/components/layout/InputArea.svelte:496-503`

**Step 1:** Find the attach button (around line 498-502). Change from 36px transparent circle to 28px bordered square matching mockup:

Change:
```svelte
class="w-9 h-9 rounded-full border-none bg-transparent text-text-muted cursor-pointer flex items-center justify-center transition-[background,color] duration-150 hover:bg-bg-alt hover:text-text"
```
To:
```svelte
class="w-7 h-7 rounded-md border border-border bg-bg-alt text-text-muted cursor-pointer flex items-center justify-center transition-[background,color] duration-150 hover:bg-bg-surface hover:text-text"
```

**Step 2: Verify**
Run: `pnpm check && pnpm lint`

---

### Task 3: Fix send/stop button shape

**Files:**
- Modify: `src/lib/frontend/components/layout/InputArea.svelte:545-562`

**Step 1:** Find the send button (around line 547). Change `w-9 h-9 rounded-full` to `w-8 h-8 rounded-[10px]`.

**Step 2:** Find the stop button (around line 556). Change `w-9 h-9 rounded-full` to `w-8 h-8 rounded-[10px]`.

**Step 3: Verify**
Run: `pnpm check && pnpm lint`

---

### Task 4: Dim resolved permission cards

**Files:**
- Modify: `src/lib/frontend/components/features/PermissionCard.svelte:175-178`

**Step 1:** Find the resolved state wrapper (line 176). Add `opacity-60`:
```svelte
<div class="perm-resolved text-sm py-2 opacity-60">
```

**Step 2: Verify**
Run: `pnpm check && pnpm lint`

---

### Task 5: Add bounce bar track background

**Files:**
- Modify: `src/lib/frontend/components/chat/MessageList.svelte:267`

**Step 1:** Find the bounce bar track div (line 267). Add `bg-bg-alt`:
```svelte
class="h-[3px] rounded-full overflow-hidden bg-bg-alt"
```

**Step 2: Verify**
Run: `pnpm check && pnpm lint`

---

### Task 6: Fix tool name color

**Files:**
- Modify: `src/lib/frontend/components/chat/ToolItem.svelte`

**Step 1:** Find all `tool-name` spans (search for `class="tool-name`). Change `text-text-secondary` to `text-text`.

**Step 2: Verify**
Run: `pnpm check && pnpm lint`

---

### Task 7: Fix tool result box padding

**Files:**
- Modify: `src/lib/frontend/components/chat/ToolItem.svelte`

**Step 1:** Find the result/output container div that has `py-2 px-2.5` (search for the tool result area with `bg-code-bg`). Change padding to `py-3 px-4`.

**Step 2: Verify**
Run: `pnpm check && pnpm lint`

---

### Task 8: Add italic to thinking label

**Files:**
- Modify: `src/lib/frontend/components/chat/ThinkingBlock.svelte`

**Step 1:** Find the streaming label span (around line 61):
```svelte
<span class="text-xs text-brand-b font-medium">{label}…</span>
```
Add `italic`:
```svelte
<span class="text-xs text-brand-b font-medium italic">{label}…</span>
```

**Step 2: Verify**
Run: `pnpm check && pnpm lint`

---

### Task 9: Fix thinking content line-height

**Files:**
- Modify: `src/lib/frontend/components/chat/ThinkingBlock.svelte`

**Step 1:** Find the expanded content div (around line 91) with `leading-[1.55]`. Change to `leading-[1.7]`.

**Step 2: Verify**
Run: `pnpm check && pnpm lint`

---

### Task 10: Add radial glow orb to loading page

**Files:**
- Modify: `src/lib/frontend/components/overlays/ConnectOverlay.svelte:160-165`

**Step 1:** Inside `<div id="connect-overlay"...>` (line 160), after the opening tag but before `<div class="flex flex-col items-center gap-6">`, add a positioned glow orb:
```svelte
<!-- Radial glow orb -->
<div class="absolute w-[400px] h-[400px] rounded-full pointer-events-none" style="top:50%;left:50%;transform:translate(-50%,-50%);background:radial-gradient(circle, rgba(255,45,123,0.08) 0%, rgba(0,229,255,0.05) 40%, transparent 70%);"></div>
```

Make the content wrapper relative so it sits above:
```svelte
<div class="flex flex-col items-center gap-6 relative z-10">
```

**Step 2: Verify**
Run: `pnpm check && pnpm lint`

---

### Task 11: Fix loading page background opacity

**Files:**
- Modify: `src/lib/frontend/components/overlays/ConnectOverlay.svelte:162`

**Step 1:** Change `bg-bg/95` to `bg-bg`:
```svelte
class="connect-overlay fixed inset-0 z-50 flex items-center justify-center bg-bg"
```

**Step 2: Verify**
Run: `pnpm check && pnpm lint`

---

### Task 12: Fix command menu active item background

**Files:**
- Modify: `src/lib/frontend/components/features/CommandMenu.svelte:119`

**Step 1:** Find the active item class. Change `bg-accent-bg hover:bg-accent-bg` to `bg-bg-alt hover:bg-bg-alt`:
```svelte
{i === activeIndex ? 'cmd-item-active bg-bg-alt hover:bg-bg-alt' : ''}
```

**Step 2: Verify**
Run: `pnpm check && pnpm lint`

---

### Task 13: Fix tool result max-height

**Files:**
- Modify: `src/lib/frontend/components/chat/ToolItem.svelte`

**Step 1:** Find the result container with `max-h-[300px]`. Change to `max-h-[200px]`.

**Step 2: Verify**
Run: `pnpm check && pnpm lint`

---

### Task 14: Final verification

Run full test suite:
```bash
pnpm check && pnpm lint && pnpm test:unit
```

Expected: All pass (pre-existing daemon-tls failures are unrelated).
