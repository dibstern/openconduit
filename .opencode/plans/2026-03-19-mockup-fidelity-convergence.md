# Mockup Fidelity Convergence Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Get all 26 mockup fidelity pairs to < 10% pixel diff by iteratively fixing the mockup fragment HTML and component CSS.

**Architecture:** Each pair has a mockup fragment HTML file (source of truth for design) and a Storybook story (the actual component). The `mockup-fidelity.spec.ts` Playwright test screenshots both and compares with pixelmatch. Fix fragments to use the same CSS pipeline as Storybook, then fix components to match the fragments.

**Tech Stack:** Playwright, pixelmatch, Storybook 10, Tailwind CSS v4

**Current baseline (26 pairs):**

| Category | Pair | Diff % | Root Cause |
|----------|------|--------|------------|
| PASS | SessionItem Active | 1.2% | ✅ |
| PASS | SessionItem Processing | 1.6% | ✅ |
| PASS | ConnectOverlay Connecting | 0.3% | ✅ |
| ~50% | UserMessage | 50.3% | Fragment structure ≠ component structure |
| ~50% | ToolItem Running/Error/Pending/Grouped | 51-53% | Fragment structure ≠ component structure |
| ~50% | ToolItem Question Running/Answered | 52-56% | Fragment structure ≠ component structure |
| ~50% | PermissionCard Pending | 51% | Fragment structure ≠ component structure |
| >90% | ThinkingBlock Active/Completed | 94-97% | Theme tokens not applied to fragment |
| >90% | ResultBar Full | 97% | Theme tokens not applied to fragment |
| >90% | Header variants | 98.8% | Theme tokens not applied to fragment |
| >90% | InputArea variants | 97-98% | Theme tokens not applied to fragment |
| >90% | SessionItem Inactive | 98.8% | Theme tokens not applied to fragment |

**Root cause analysis:**
1. **>90% diffs:** The fragments render on default browser background (white) because the Storybook CSS applies theme colors via `document.documentElement.style` (JavaScript), not via static CSS. Fragments need the conduit theme token values applied as inline styles on the root element.
2. **~50% diffs:** The fragment HTML structure uses plain `<div>` elements while the component uses Svelte's generated markup with Tailwind classes. The fragments need to use the exact same class names and nesting.

---

### Task 1: Fix theme tokens in all fragments

The biggest issue: fragments load the Storybook CSS file but don't apply the conduit theme's CSS custom properties to `document.documentElement`. The `TOKENS` block in the generator script only sets ROOT-level CSS vars, but the Storybook CSS uses vars like `--color-bg` which are overridden by the theme's inline styles in the real app.

**Fix:** In `scripts/generate-mockup-fragments.mjs`, update the `TOKENS` CSS block to apply ALL conduit theme variables as inline styles on the `<html>` element, matching what `theme-compute.ts` does. The current `TOKENS` block already has most of them, but they need to be on `html` (not `:root`) to match the Storybook specificity. Also ensure the `body` background uses `var(--color-bg)`.

Additionally, the Storybook preview sets `backgrounds.value: "app"` which sets a background color. The fragments should match this.

**Step 1:** Read the compiled Storybook CSS to see how Tailwind utility classes reference the theme vars.

**Step 2:** Update the fragment template to apply theme vars as `style` attribute on `<html>` element:
```html
<html style="--color-bg:#18181B;--color-bg-alt:#27272A;...all 40+ vars...">
```

**Step 3:** Re-run fidelity tests to see improvement.

Expected: >90% diffs should drop significantly (maybe to ~50% like the structural issues).

---

### Task 2: Fix fragment HTML structure to match Svelte output

For each ~50% diff pair, inspect the `test-debug/fidelity/{name}-diff.png` to understand WHERE the pixels differ, then adjust the fragment HTML to match.

The approach for each fragment:
1. Open the Storybook story in a browser at `http://localhost:6007/iframe.html?id=STORY_ID&viewMode=story`
2. Use browser DevTools to inspect the component's ACTUAL rendered HTML structure
3. Copy that HTML structure into the fragment, replacing the current inline-style approximation
4. Re-run the fidelity test for that specific pair

This is the most labor-intensive part but also the most valuable — it ensures the fragment is a true mirror of the component.

---

### Task 3: Iterative convergence loop

After Tasks 1-2, re-run all 26 pairs. For any still > 10%:
1. Check the diff image
2. If the mockup fragment is the source of truth and the component doesn't match → fix the component CSS
3. If the mockup fragment is wrong → fix the fragment
4. Re-run

Repeat until all 26 pairs are < 10%.

---

### Task 4: Final verification

```bash
pnpm storybook:build && node scripts/generate-mockup-fragments.mjs
pnpm test:storybook-visual  # includes fidelity tests
pnpm check && pnpm lint && pnpm test:unit
```

All fidelity tests should pass (< 10% diff). All unit tests should pass.
