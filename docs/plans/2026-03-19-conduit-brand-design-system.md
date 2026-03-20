# Conduit Brand Design System Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Implement the Conduit brand identity — 2×10 block grid logo (static + animated), 2×5 inline spinner, loading page, Chakra Petch display font, and neon glow chat styling — on top of the existing Base16 theme system, with brand colors defined once and easily changeable.

**Architecture:** Brand colors (`--brand-a` pink, `--brand-b` cyan) are defined as CSS custom properties in the Tailwind `@theme` block, separate from the Base16 theme system. They stay constant across all user-selected themes. The wordmark text color adapts to the theme's `--color-text`. All components reference brand colors via Tailwind utility classes (`bg-brand-a`, `text-brand-b`, etc.). The 2×10 block grid is a reusable Svelte component with `static`, `animated`, and `fast` modes.

**Tech Stack:** Svelte 5 (runes), Tailwind CSS v4 (`@theme` block), Chakra Petch + JetBrains Mono (Google Fonts), CSS keyframe animations.

---

## Key Design Decisions

### Brand colors are NOT theme colors

The existing theme system maps Base16 palettes to `--color-*` CSS properties. Brand colors are a separate concern:

- `--brand-a: #FF2D7B` (pink) — always this value, regardless of theme
- `--brand-b: #00E5FF` (cyan) — always this value, regardless of theme
- To change the brand, edit TWO hex values in `style.css` (and their corresponding glow rgba values — 4 values total) — everything updates

These are defined in the Tailwind `@theme` block so they generate utility classes (`bg-brand-a`, `text-brand-b`, `shadow-brand-a/15`, etc.) AND are available as raw CSS variables.

### Context % bar colors

- Healthy: `--brand-b` (cyan)
- Warning: `--color-warning` (theme's base0A amber)
- Danger: `--brand-a` (pink)

### Chat glow styling

Messages use `box-shadow` for the neon glow effect (3px hard accent line + soft diffuse glow). This is CSS-only — no extra DOM elements. User messages glow pink, assistant messages glow cyan.

### Font strategy

- Chakra Petch: display font for wordmark, section titles, and UI labels. Loaded from Google Fonts via `<link>` in `index.html`.
- JetBrains Mono: already used as the monospace font. No change needed.
- Body text: remains the existing mono font stack from the theme system.

---

## Task 1: Add Brand Color Tokens to Tailwind Theme

**Files:**
- Modify: `src/lib/frontend/style.css` (lines 7-64, the `@theme` block)

**Step 1: Add brand color CSS custom properties**

In `style.css`, inside the existing `@theme { }` block, add brand tokens. Place them at the TOP of the block so they're the first thing someone sees when opening the file:

```css
@theme {
  /* ═══ BRAND COLORS ═══
     Change these two values to rebrand the entire app.
     They are constant across all user-selected themes. */
  --color-brand-a: #FF2D7B;       /* pink */
  --color-brand-b: #00E5FF;       /* cyan */
  --color-brand-a-glow: rgba(255, 45, 123, 0.15);
  --color-brand-b-glow: rgba(0, 229, 255, 0.15);

  /* ... existing tokens below ... */
}
```

This generates Tailwind classes: `bg-brand-a`, `text-brand-b`, `shadow-brand-a-glow`, etc.

**Step 2: Add brand glow box-shadow utilities**

After the `@theme` block, add custom utilities:

```css
@utility glow-brand-a {
  box-shadow: -4px 0 16px var(--color-brand-a-glow), -3px 0 0 var(--color-brand-a);
}
@utility glow-brand-b {
  box-shadow: -4px 0 16px var(--color-brand-b-glow), -3px 0 0 var(--color-brand-b);
}
@utility glow-brand-a-strong {
  box-shadow: 0 0 8px rgba(255, 45, 123, 0.4), 0 0 24px rgba(255, 45, 123, 0.15);
}
@utility glow-brand-b-strong {
  box-shadow: 0 0 8px rgba(0, 229, 255, 0.4), 0 0 24px rgba(0, 229, 255, 0.15);
}
```

**Step 3: Add block grid animation keyframes**

Add the keyframes at the TOP LEVEL of `style.css` (NOT inside `@layer base` or `@theme` — Tailwind v4 keyframes go at the top level alongside other at-rules):

```css
@keyframes pixel-cascade-a {
  0%   { opacity: 0.15; }
  20%  { opacity: 1; }
  40%  { opacity: 0.3; }
  60%  { opacity: 0.8; }
  80%  { opacity: 0.15; }
  100% { opacity: 0.5; }
}
@keyframes pixel-cascade-b {
  0%   { opacity: 0.5; }
  25%  { opacity: 0.15; }
  50%  { opacity: 1; }
  75%  { opacity: 0.3; }
  100% { opacity: 0.15; }
}
```

Add corresponding Tailwind animation tokens in the `@theme` block:

```css
  --animate-cascade-a: pixel-cascade-a 2.4s ease-in-out infinite;
  --animate-cascade-b: pixel-cascade-b 2.4s ease-in-out infinite;
  --animate-cascade-a-fast: pixel-cascade-a 1.4s ease-in-out infinite;
  --animate-cascade-b-fast: pixel-cascade-b 1.4s ease-in-out infinite;
```

**Step 4: Run verification**

Run: `pnpm check && pnpm lint`
Expected: PASS (no TypeScript/lint errors)

**Step 5: Commit**

```bash
git add src/lib/frontend/style.css
git commit -m "feat: add brand color tokens and cascade animation keyframes to Tailwind theme"
```

---

## Task 2: Load Chakra Petch Font

**Files:**
- Modify: `src/lib/frontend/index.html`
- Modify: `src/lib/frontend/style.css`

**Step 1: Add Google Fonts link to index.html**

In `src/lib/frontend/index.html`, in the `<head>`, add after the existing meta tags:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@300;400;500;600;700&display=swap" rel="stylesheet">
```

**Step 2: Add font-family token to @theme**

In `style.css`'s `@theme` block:

```css
  --font-brand: 'Chakra Petch', sans-serif;
```

**Step 3: Run verification**

Run: `pnpm check && pnpm lint`
Expected: PASS

**Step 4: Commit**

```bash
git add src/lib/frontend/index.html src/lib/frontend/style.css
git commit -m "feat: add Chakra Petch display font for brand elements"
```

---

## Task 3: Create BlockGrid Component

**Files:**
- Create: `src/lib/frontend/components/shared/BlockGrid.svelte`
- Create: `src/lib/frontend/components/shared/BlockGrid.stories.ts`

**Step 1: Write the Storybook story (test-first)**

```typescript
// src/lib/frontend/components/shared/BlockGrid.stories.ts
import type { Meta, StoryObj } from '@storybook/svelte-vite';
import BlockGrid from './BlockGrid.svelte';

const meta = {
  title: 'Shared/BlockGrid',
  component: BlockGrid,
  tags: ['autodocs'],
  argTypes: {
    cols: { control: { type: 'range', min: 3, max: 10, step: 1 } },
    mode: { control: 'select', options: ['static', 'animated', 'fast'] },
    blockSize: { control: { type: 'range', min: 1, max: 12, step: 0.5 } },
    gap: { control: { type: 'range', min: 0.5, max: 4, step: 0.5 } },
    glow: { control: 'boolean' },
  },
} satisfies Meta<typeof BlockGrid>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Static10: Story = { args: { cols: 10, mode: 'static', blockSize: 3.5, gap: 1.5 } };
export const Animated10: Story = { args: { cols: 10, mode: 'animated', blockSize: 8, gap: 3, glow: true } };
export const Fast5Spinner: Story = { args: { cols: 5, mode: 'fast', blockSize: 2, gap: 0.75 } };
export const Static5: Story = { args: { cols: 5, mode: 'static', blockSize: 3.5, gap: 1.5 } };
export const Animated5: Story = { args: { cols: 5, mode: 'animated', blockSize: 6, gap: 2, glow: true } };
export const Large10Loading: Story = { args: { cols: 10, mode: 'animated', blockSize: 10, gap: 3, glow: true } };
```

**Step 2: Write the BlockGrid component**

```svelte
<!-- src/lib/frontend/components/shared/BlockGrid.svelte -->
<script lang="ts">
  interface Props {
    /** Number of columns (blocks per row). Default 10. */
    cols?: number;
    /** Animation mode: 'static' (frozen gradient), 'animated' (cascade), 'fast' (spinner speed) */
    mode?: 'static' | 'animated' | 'fast';
    /** Block size in px. Default 3.5 */
    blockSize?: number;
    /** Gap between blocks in px. Default 1.5 */
    gap?: number;
    /** Enable glow effect on dark backgrounds. Default false */
    glow?: boolean;
    /** Additional CSS classes */
    class?: string;
  }

  let {
    cols = 10,
    mode = 'static',
    blockSize = 3.5,
    gap = 1.5,
    glow = false,
    class: className = '',
  }: Props = $props();

  // Calculate stagger delay per block based on column count
  // Total stagger spread stays ~1.6s for animated, ~1.0s for fast
  const staggerSpread = $derived(mode === 'fast' ? 1.0 : 1.6);
  const staggerStep = $derived(cols > 1 ? staggerSpread / (cols - 1) : 0);

  // Static opacity: linear gradient L→R for pink, R→L for cyan
  function staticOpacity(index: number, total: number): number {
    return 1 - (index / total) * 0.9; // 1.0 → 0.1
  }

  // Animation duration
  const duration = $derived(mode === 'fast' ? 1.4 : 2.4);
</script>

<div
  class="inline-grid {className}"
  style="grid-template-columns: repeat({cols}, {blockSize}px); grid-template-rows: repeat(2, {blockSize}px); gap: {gap}px;"
  role="img"
  aria-label="Conduit loading indicator"
>
  <!-- Top row: pink (brand-a), cascade L→R -->
  {#each Array(cols) as _, i}
    <div
      style="
        width: {blockSize}px;
        height: {blockSize}px;
        border-radius: {Math.max(0.5, blockSize / 4)}px;
        background: var(--color-brand-a);
        {mode === 'static'
          ? `opacity: ${staticOpacity(i, cols)};`
          : `animation: pixel-cascade-a ${duration}s ease-in-out infinite; animation-delay: ${(i * staggerStep).toFixed(3)}s;`
        }
        {glow && mode !== 'static' ? `filter: drop-shadow(0 0 ${blockSize / 2}px var(--color-brand-a-glow));` : ''}
      "
    ></div>
  {/each}

  <!-- Bottom row: cyan (brand-b), cascade R→L -->
  {#each Array(cols) as _, i}
    <div
      style="
        width: {blockSize}px;
        height: {blockSize}px;
        border-radius: {Math.max(0.5, blockSize / 4)}px;
        background: var(--color-brand-b);
        {mode === 'static'
          ? `opacity: ${staticOpacity(cols - 1 - i, cols)};`
          : `animation: pixel-cascade-b ${duration}s ease-in-out infinite; animation-delay: ${((cols - 1 - i) * staggerStep).toFixed(3)}s;`
        }
        {glow && mode !== 'static' ? `filter: drop-shadow(0 0 ${blockSize / 2}px var(--color-brand-b-glow));` : ''}
      "
    ></div>
  {/each}
</div>
```

**Step 3: Run Storybook to visually verify**

Run: `pnpm storybook`
Navigate to Shared/BlockGrid stories. Verify:
- Static10: 2×10 grid with pink fading L→R, cyan fading R→L
- Animated10: multi-peak cascade wave flowing
- Fast5Spinner: tiny 2×5 grid with fast cascade
- All controls work (cols slider, mode select, etc.)

**Step 4: Run verification**

Run: `pnpm check && pnpm lint`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/frontend/components/shared/BlockGrid.svelte src/lib/frontend/components/shared/BlockGrid.stories.ts
git commit -m "feat: add BlockGrid component with static/animated/fast modes"
```

---

## Task 4: Create ConduitLogo Component

**Files:**
- Create: `src/lib/frontend/components/shared/ConduitLogo.svelte`
- Create: `src/lib/frontend/components/shared/ConduitLogo.stories.ts`

**Step 1: Write the Storybook story**

```typescript
// src/lib/frontend/components/shared/ConduitLogo.stories.ts
import type { Meta, StoryObj } from '@storybook/svelte-vite';
import ConduitLogo from './ConduitLogo.svelte';

const meta = {
  title: 'Shared/ConduitLogo',
  component: ConduitLogo,
  tags: ['autodocs'],
  argTypes: {
    size: { control: 'select', options: ['standard', 'loading', 'sidebar', 'inline'] },
    animated: { control: 'boolean' },
    showText: { control: 'boolean' },
  },
} satisfies Meta<typeof ConduitLogo>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Standard: Story = { args: { size: 'standard', showText: true } };
export const Loading: Story = { args: { size: 'loading', animated: true, showText: true } };
export const Sidebar: Story = { args: { size: 'sidebar', showText: true } };
export const InlineSpinner: Story = { args: { size: 'inline', animated: true, showText: false } };
export const StandardAnimated: Story = { args: { size: 'standard', animated: true, showText: true } };
```

**Step 2: Write the ConduitLogo component**

```svelte
<!-- src/lib/frontend/components/shared/ConduitLogo.svelte -->
<script lang="ts">
  import BlockGrid from './BlockGrid.svelte';

  interface Props {
    /** Size preset */
    size?: 'standard' | 'loading' | 'sidebar' | 'inline';
    /** Enable cascade animation. Default false (static). */
    animated?: boolean;
    /** Show "conduit" text above the grid. Default true. */
    showText?: boolean;
    /** Additional CSS classes */
    class?: string;
  }

  let {
    size = 'standard',
    animated = false,
    showText = true,
    class: className = '',
  }: Props = $props();

  const CONFIGS = {
    standard:  { textSize: 'text-[22px]', blockSize: 3.5, gap: 1.5, cols: 10, gridGap: '4px', glow: true },
    loading:   { textSize: 'text-[28px]', blockSize: 8,   gap: 3,   cols: 10, gridGap: '6px', glow: true },
    sidebar:   { textSize: 'text-[14px]', blockSize: 2,   gap: 1,   cols: 10, gridGap: '3px', glow: false },
    inline:    { textSize: 'text-[13px]', blockSize: 2,   gap: 0.75,cols: 5,  gridGap: '2px', glow: false },
  } as const;

  const config = $derived(CONFIGS[size]);

  const mode = $derived(
    animated
      ? (size === 'inline' ? 'fast' : 'animated')
      : 'static'
  );
</script>

<div
  class="flex flex-col items-center {className}"
  style="gap: {config.gridGap};"
>
  {#if showText}
    <span
      class="font-medium tracking-[0.14em] text-text {config.textSize}"
      style="font-family: var(--font-brand);"
    >
      conduit
    </span>
  {/if}
  <BlockGrid
    cols={config.cols}
    {mode}
    blockSize={config.blockSize}
    gap={config.gap}
    glow={config.glow}
  />
</div>
```

**Step 3: Run Storybook to verify**

Run: `pnpm storybook`
Verify all 5 stories render correctly. The "Standard" story should show "conduit" in Chakra Petch with a static 2×10 grid below. "InlineSpinner" shows just the tiny 2×5 grid with no text.

**Step 4: Run verification**

Run: `pnpm check && pnpm lint`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/frontend/components/shared/ConduitLogo.svelte src/lib/frontend/components/shared/ConduitLogo.stories.ts
git commit -m "feat: add ConduitLogo component with size presets and animation modes"
```

---

## Task 5: Replace ConnectOverlay with New Loading Page

**Files:**
- Modify: `src/lib/frontend/components/overlays/ConnectOverlay.svelte`

**Step 1: Read the existing ConnectOverlay**

Read `ConnectOverlay.svelte` to understand its current structure: the SVG "O" mark, shimmer verbs, connection states, and how it's shown/hidden.

**Step 2: Replace the SVG "O" mark with ConduitLogo**

Replace the existing SVG mark (the `<svg>` with the rectangular O and `<animate>` fill sweep) with:

```svelte
<ConduitLogo size="loading" animated={true} showText={true} />
```

Import at the top:
```svelte
import ConduitLogo from '../shared/ConduitLogo.svelte';
```

Keep the existing verb cycling logic, connection state text, and show/hide behavior unchanged. Just swap the visual mark.

**Step 3: Update verb shimmer gradient to use brand colors**

The existing shimmer uses `--color-accent`. Update the gradient to use brand colors while PRESERVING the shimmer animation properties (`background-size` and `animation`):

```css
background: linear-gradient(
  90deg,
  var(--color-brand-a),
  var(--color-brand-b),
  var(--color-brand-a)
);
background-size: 200% 100%;
-webkit-background-clip: text;
-webkit-text-fill-color: transparent;
background-clip: text;
animation: shimmer-text 3s ease-in-out infinite;
```

Add the shimmer-text keyframe if not already present:
```css
@keyframes shimmer-text {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
```

The `background-size: 200%` and `animation` are essential — without them the gradient is static instead of shimmering.

**Step 4: Verify visually**

Run: `pnpm dev:frontend`
Open `http://localhost:5173`. The connect overlay should show the new logo with animated cascade. Verb text should shimmer in pink→cyan gradient.

**Step 5: Run verification**

Run: `pnpm check && pnpm lint`
Expected: PASS

**Step 6: Commit**

```bash
git add src/lib/frontend/components/overlays/ConnectOverlay.svelte
git commit -m "feat: replace O mark with animated ConduitLogo in connect overlay"
```

---

## Task 6: Replace Inline Spinners with BlockGrid

**Files:**
- Modify: `src/lib/frontend/components/chat/ThinkingBlock.svelte`
- Modify: `src/lib/frontend/components/chat/ToolItem.svelte`
- Modify: `src/lib/frontend/components/chat/ToolGroupCard.svelte`
- Modify: `src/lib/frontend/components/chat/SkillItem.svelte`

**Step 1: Update ThinkingBlock**

In `ThinkingBlock.svelte`, replace the `<Icon name="loader" class="icon-spin" />` spinner with:

```svelte
<BlockGrid cols={5} mode="fast" blockSize={2} gap={0.75} />
```

Import BlockGrid at the top.

**Step 2: Update ToolItem, ToolGroupCard, SkillItem**

IMPORTANT: These components do NOT have a simple `<Icon name="loader">` to replace. They use a CONDITIONAL pattern where a wrapper `<span>` gets a `statusIconClass` that toggles between a spinning loader and a static check icon. The replacement must be conditional:

In ToolItem.svelte, find the running-state spinner (look for `icon-spin` or `animate-spin` or `animate-[pulse-dot` patterns) and wrap it in a conditional:

```svelte
{#if isRunning}
  <BlockGrid cols={5} mode="fast" blockSize={1.5} gap={0.5} class="shrink-0" />
{:else}
  <!-- keep existing Icon for completed/error states -->
  <Icon name={statusIcon} size={14} class={statusIconClass} />
{/if}
```

DO NOT remove the Icon import — it's still needed for non-running states (check, error, etc.).

Use `blockSize: 1.5` and `gap: 0.5` for tool items (slightly smaller than thinking block). Add `class="shrink-0"` to prevent flex shrinking. The `inline-grid` display of BlockGrid may need `vertical-align: middle` or `self-center` to align correctly with adjacent text in the flex row.

**Step 3: Verify visually**

Run: `pnpm dev:frontend`
Start a session, trigger tool calls. The thinking block and running tool indicators should show the 2×5 animated block grid instead of the spinning circle.

**Step 4: Run verification**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/frontend/components/chat/ThinkingBlock.svelte src/lib/frontend/components/chat/ToolItem.svelte src/lib/frontend/components/chat/ToolGroupCard.svelte src/lib/frontend/components/chat/SkillItem.svelte
git commit -m "feat: replace spinning loaders with BlockGrid inline spinner"
```

---

## Task 7: Add Brand Glow to Chat Messages

**Files:**
- Modify: `src/lib/frontend/components/chat/UserMessage.svelte`
- Modify: `src/lib/frontend/components/chat/AssistantMessage.svelte`
- Modify: `src/lib/frontend/components/chat/ThinkingBlock.svelte`
- Modify: `src/lib/frontend/components/chat/ToolGroupCard.svelte`

**Step 1: Read existing message styling**

Read each component to understand current border/shadow styling. Look for `border-l`, `bg-`, and `box-shadow` usage.

**Step 2: Add glow to UserMessage**

IMPORTANT: In UserMessage.svelte, the glow must go on the `.bubble` inner div (the actual message box), NOT the outer container (which is `flex justify-end` full-width). Find the element with the message background/border/rounding and add:
```
class="... glow-brand-a"
```

**Step 3: Add glow to AssistantMessage**

Add to the message body element (not the outer wrapper):
```
class="... glow-brand-b"
```

**Step 4: Update ThinkingBlock glow**

ThinkingBlock has `border-l-3 border-thinking` (note: border-l-3 not border-l-2). There are 3 separate places in the component where this border class appears — update ALL of them. Replace the `border-l-3 border-thinking` classes with `glow-brand-b`. Also change the background from opaque `bg-thinking-bg` to semi-transparent `bg-thinking-bg/80` (user chose semi-transparent so the glow bleeds through).

**Step 5: Update ToolGroupCard**

Completed state ONLY: add `glow-brand-b`. Running state: keep existing amber/warning border (status indicator, not brand). Error state: keep existing error border.

**Step 6: Add role labels**

Check if UserMessage and AssistantMessage already have role labels/headers. If they do, update the color. If they don't, add above the message content:

- User: `<div class="text-[10px] font-mono font-semibold uppercase tracking-wider text-brand-a mb-2">you</div>`
  Note: if the user message is right-aligned, add `text-right` to this label.
- Assistant: `<div class="text-[10px] font-mono font-semibold uppercase tracking-wider text-brand-b mb-2">assistant</div>`

**Step 7: Verify visually**

Run dev server and open a chat. User messages should have pink glow, assistant messages cyan glow.

**Step 8: Run verification**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: PASS

**Step 9: Commit**

```bash
git add src/lib/frontend/components/chat/UserMessage.svelte src/lib/frontend/components/chat/AssistantMessage.svelte src/lib/frontend/components/chat/ThinkingBlock.svelte src/lib/frontend/components/chat/ToolGroupCard.svelte
git commit -m "feat: add neon glow chat styling with brand-a/brand-b left edge"
```

---

## Task 8: Update Sidebar Logo

**Files:**
- Modify: `src/lib/frontend/components/layout/Sidebar.svelte`

**Step 1: Read existing sidebar header**

Find the sidebar header area where the product name or logo is displayed.

**Step 2: Replace with ConduitLogo**

IMPORTANT: The sidebar header uses `flex items-center` (horizontal layout), but ConduitLogo is `flex-col` (vertical — text above grid). For the sidebar, either:
- Use ConduitLogo with a `class="flex-row items-center gap-2"` override to make it horizontal, OR
- Use BlockGrid directly with a separate text span in the existing sidebar flex row

Recommended approach — use the existing sidebar flex row and insert components directly:

```svelte
<div class="flex items-center gap-2">
  <span style="font-family: var(--font-brand);" class="text-sm font-medium tracking-[0.14em] text-text">conduit</span>
  <BlockGrid cols={10} mode="static" blockSize={2} gap={1} />
</div>
```

Import BlockGrid (not ConduitLogo) since the sidebar needs horizontal layout.

**Step 3: Verify visually**

Open dev server. Sidebar should show "conduit" in Chakra Petch with tiny static 2×10 grid to the right, on the same line.

**Step 4: Run verification**

Run: `pnpm check && pnpm lint`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/frontend/components/layout/Sidebar.svelte
git commit -m "feat: use ConduitLogo in sidebar header"
```

---

## Task 9: Update Context % Bar Colors

**Files:**
- Modify: `src/lib/frontend/components/layout/InputArea.svelte`
- Modify: `src/lib/frontend/stores/ui.svelte.ts` (if it computes context bar color)
- Modify: `src/lib/frontend/components/overlays/InfoPanels.svelte` (if it shows context info)

**Step 1: Read ALL context bar implementations**

IMPORTANT: There are THREE separate locations that compute context bar colors. Read all of them:
1. `InputArea.svelte` — the main context bar
2. `ui.svelte.ts` (or similar store) — may compute context color centrally
3. `InfoPanels.svelte` — shows context info with colors

Search for `contextPercent`, `contextColor`, `context.*color`, `80`, `95`, `50` near context-related code.

**Step 2: Standardize thresholds and update ALL locations**

Canonical thresholds (user decision: 80%/50%):
- 0-50% (healthy): `bg-brand-b` (cyan) — `var(--color-brand-b)`
- 50-80% (warning): `bg-warning` (theme amber) — `var(--color-warning)`
- 80-100% (danger): `bg-brand-a` (pink) — `var(--color-brand-a)`

Update ALL THREE locations to use these same thresholds and brand colors. If the store computes the color centrally, update it there and have components read from the store.

**Step 3: Verify visually**

Test with a session that has varying context usage.

**Step 4: Run verification**

Run: `pnpm check && pnpm lint`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/frontend/components/layout/InputArea.svelte src/lib/frontend/stores/ui.svelte.ts src/lib/frontend/components/overlays/InfoPanels.svelte
git commit -m "feat: standardize context % bar colors and thresholds (cyan/amber/pink at 50%/80%)"
```

---

## Task 10: Apply Brand Font to Header

**Files:**
- Modify: `src/lib/frontend/components/layout/Header.svelte`

**Step 1: Read Header component**

Read `Header.svelte` to find where the product name is displayed. Note: the codebase already uses "conduit" (not "openconduit") — this was renamed previously. The task is to apply the brand font (Chakra Petch) to the existing text.

**Step 2: Apply Chakra Petch font to the product name**

Find the product name text in the header and add the brand font styling:

```svelte
<span style="font-family: var(--font-brand);" class="font-medium tracking-[0.14em]">conduit</span>
```

If the header already shows "conduit", just add the `font-family` style. If it shows a dynamic project name, leave that as-is and only brand the "conduit" product name if it appears.

**Step 3: Run verification**

Run: `pnpm check && pnpm lint`
Expected: PASS

**Step 4: Commit**

```bash
git add src/lib/frontend/components/layout/Header.svelte
git commit -m "feat: apply Chakra Petch brand font to header"
```

---

## Task 11: Final Verification

**Step 1: Full build**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: All pass.

**Step 2: Visual review checklist**

Run: `pnpm dev:frontend` and verify each item:

- [ ] Loading page: "conduit" text above animated 2×10 block grid, verb shimmer in pink→cyan
- [ ] Sidebar: "conduit" with static 2×10 grid, Chakra Petch font
- [ ] Chat: user messages have pink glow, assistant have cyan glow, role labels colored
- [ ] Thinking block: 2×5 inline spinner animating, cyan glow border
- [ ] Tool items: 2×5 spinner when running, check icon when complete
- [ ] Context bar: cyan (low), amber (mid), pink (high)
- [ ] Theme switching: change theme in settings — brand colors (pink/cyan) stay constant, text/bg adapt
- [ ] Light themes: wordmark text flips to dark, blocks stay pink/cyan

**Step 3: Storybook verification**

Run: `pnpm storybook`
Verify BlockGrid and ConduitLogo stories all render correctly with different arguments.

**Step 4: Commit any final fixes**

```bash
git add -A
git commit -m "fix: final adjustments from visual review"
```
