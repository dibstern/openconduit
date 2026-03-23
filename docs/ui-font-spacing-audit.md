# UI Font Sizing & Spacing Audit

> Comprehensive analysis of every font size, font weight, line-height, letter-spacing, spacing value, and font family used across the conduit frontend. Purpose: identify inconsistencies and establish a path toward a unified design system.

---

## Table of Contents

1. [Foundations](#1-foundations)
2. [Font Size Inventory](#2-font-size-inventory)
3. [Font Weight Inventory](#3-font-weight-inventory)
4. [Line-Height Inventory](#4-line-height-inventory)
5. [Letter-Spacing Inventory](#5-letter-spacing-inventory)
6. [Font Family Inventory](#6-font-family-inventory)
7. [Spacing Inventory (Padding, Margin, Gap)](#7-spacing-inventory)
8. [Component-Level Patterns](#8-component-level-patterns)
9. [Inconsistencies & Observations](#9-inconsistencies--observations)
10. [Recommendations](#10-recommendations)

---

## 1. Foundations

### Styling Approach
- **Tailwind CSS v4** (CSS-first configuration via `@tailwindcss/vite`)
- No `tailwind.config.js` -- all customization in `style.css` `@theme {}` block
- Components use Tailwind utility classes directly in markup
- 5 components have scoped `<style>` blocks (UserMessage, SetupPage, PermissionNotification, ThemePicker, Toast)
- Some components use inline `style=` attributes for dynamic or brand-font values

### Root Baseline (`style.css:191-196`)
| Property | Value | Notes |
|---|---|---|
| `font-family` | `var(--font-sans)` | Identical to `--font-mono` -- entire UI is monospace |
| `font-size` | `13px` | Hard-coded pixel root, not `rem` |
| `line-height` | `1.5` | Unitless multiplier |

### Font Stacks (`@theme {}`)
| Token | Value |
|---|---|
| `--font-mono` | `"JetBrains Mono", "Berkeley Mono", "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace` |
| `--font-sans` | Identical to `--font-mono` |
| `--font-brand` | `"Chakra Petch", sans-serif` |

### Rem Calculation Note
Since the root font-size is `13px`, Tailwind's `rem`-based utilities resolve as:
- `text-xs` (0.75rem) = **9.75px**
- `text-sm` (0.875rem) = **11.375px**
- `text-base` (1rem) = **13px**
- `text-lg` (1.125rem) = **14.625px**
- `text-xl` (1.25rem) = **16.25px**
- `text-2xl` (1.5rem) = **19.5px**
- `text-5xl` (3rem) = **39px**

---

## 2. Font Size Inventory

### Complete Scale (smallest to largest)

Every distinct font-size value used across the entire UI:

| Value | Equivalent | Tailwind Class | Where Used |
|---|---|---|---|
| 8px | -- | `text-[8px]` | PastePreview thumbnail name |
| 9px | -- | `text-[9px]` | SubagentBackBar ESC badge, SessionList date groups, SettingsPanel CCS detecting |
| 9.75px | 0.75rem | `text-xs` | ~30+ components (see below) |
| 10px | -- | `text-[10px]` | Header instance badge, InputArea context %, Sidebar version, FileTreeNode collapsed hint, ModelSelector badges/cost, ProjectSwitcher instance header, SessionItem fork, TerminalPanel font label, TodoOverlay chevron/icons, SettingsPanel section headers, DebugPanel toolbar |
| 11px | -- | `text-[11px]` | AssistantMessage code headers/label, DiffView gutters, FileTreeNode size/loading, FileViewer font label, ModelSelector provider header, PastePreview remove btn, ProjectSwitcher headers/error, SessionItem meta, SessionList headers/actions, SidebarFilePanel label, TerminalPanel responsive/font btns, TodoOverlay count, StepHeader counter, ConnectOverlay attempts, DashboardPage version, DebugPanel base text |
| 11.375px | 0.875rem | `text-sm` | ~25+ components (see below) |
| 12px | -- | `text-[12px]` | SubagentBackBar arrow, ModelSelector variant options, ProjectSwitcher add input, TodoOverlay header, ThemePicker items (scoped CSS) |
| 13px | -- | `text-[13px]` | AssistantMessage/UserMessage body, SystemMessage, ThinkingBlock, CommandMenu name/desc, FileMenu paths, FileTreeNode entries, FileViewer path, ModelSelector items, PermissionCard/Notification title, ProjectSwitcher project names, QuestionCard title, SessionContextMenu items, SessionItem text, Sidebar action buttons, TodoOverlay items, ConfirmModal/RewindBanner buttons, StatusBox, DashboardPage subtitle/code, PinPage error, SetupPage subtitle, SettingsPanel theme names |
| 13px | 1rem | `text-base` | InputArea textarea, FileViewer font buttons, QrModal title area |
| 14px | 0.875rem | `plan-mode.css` | Plan banner, plan card title, plan approval buttons |
| 14px | -- | `text-[14px]` | ThemePicker checkmark (scoped CSS) |
| 14.625px | 1.125rem | `text-lg` | SettingsPanel header, StepHeader title |
| 15px | -- | `text-[15px]` | Header project name, PinPage placeholder |
| 16px | -- | `text-[16px]` | DashboardPage project card name |
| 16.25px | 1.25rem | `text-xl` | ImageLightbox close, StepDone heading |
| 19.5px | 1.5rem | `text-2xl` | DashboardPage page title, PinPage PIN input |
| 22px | -- | `text-[22px]` | PinPage title, SetupPage title, ConduitLogo (standard) |
| 28px | -- | `text-[28px]` | ConduitLogo (loading) |
| 39px | 3rem | `text-5xl` | StepDone checkmark |

### Font Size by Semantic Role

| Role | Values Used | Consistency |
|---|---|---|
| **Page titles** | `text-2xl` (19.5px), `text-[22px]`, `text-xl` (16.25px) | Mixed -- 3 different sizes |
| **Section headings** | `text-lg` (14.625px), `text-[15px]`, `text-[16px]` | Mixed -- 3 different sizes |
| **Body text** | `text-[13px]`, `text-sm` (11.375px), `text-base` (13px) | `text-[13px]` and `text-base` resolve to same px but via different mechanisms |
| **Role labels** (You/Assistant) | `text-[11px]` | Consistent |
| **Small labels / metadata** | `text-xs` (9.75px), `text-[10px]`, `text-[11px]` | Three competing "small" sizes |
| **Tiny / badge text** | `text-[8px]`, `text-[9px]`, `text-[10px]` | Three competing "tiny" sizes |
| **Code** | `text-[13px]`, `text-xs`, `text-[0.87em]` | Mixed |
| **Buttons (CTA)** | `text-sm` (11.375px), `text-[13px]` | Two sizes for similar elements |
| **Menu items** | `text-[13px]`, `text-xs` | Two sizes |
| **Section headers (uppercase)** | `text-[10px]`, `text-[11px]`, `text-[9px]` | Three sizes for same pattern |

### `text-xs` Users (0.75rem / 9.75px)

The most widely used text size class across the codebase:

- Chat: MessageList markers, ResultBar, SkillItem header/subtitle, ThinkingBlock labels, ToolGroupCard header, ToolGroupItem rows/tags, ToolItem subtitle/tags
- Layout: Header right section/dropdown, Sidebar (update link implied)
- Features: AgentSelector trigger, CommandMenu responsive, DiffView filename/stats/toggles/viewer, FileMenu responsive, FileViewer truncation, ModelSelector trigger, PermissionCard labels/inputs, QuestionCard labels/descriptions, SessionItem rename, SessionList bulk-delete/search/empty, SidebarFilePanel breadcrumbs, TerminalPanel tabs/status
- Overlays: Banners, InfoPanels data rows, ConnectOverlay error/escape, RewindBanner hints, SettingsPanel various, DebugPanel title
- Setup: StepCertificate/StepPwa/StepTailscale hints and badges
- Pages: DashboardPage path/stats

### `text-sm` Users (0.875rem / 11.375px)

Second most widely used:

- Layout: InputArea attach menu items, Sidebar brand name
- Features: FileViewer loading/binary, PermissionCard/QuestionCard buttons/resolved, SidebarFilePanel loading/empty, TerminalPanel close
- Overlays: ConfirmModal text, ConnectOverlay/RewindBanner/Toast text, SettingsPanel tabs/items, QrModal URL
- Setup: All instruction body text, all CTA buttons
- Pages: DashboardPage loading, PinPage subtitle/button

### `text-[13px]` Users (arbitrary 13px)

Third most common, notably overlapping with `text-base` (which is also 13px at root):

- Chat: AssistantMessage body, UserMessage body, SystemMessage, ThinkingBlock text, ToolItem question labels
- Layout: Sidebar action buttons
- Features: CommandMenu name/desc, FileMenu paths, FileTreeNode entries, FileViewer path, ModelSelector items, PermissionCard title, ProjectSwitcher project names, QuestionCard title, SessionContextMenu items, SessionItem text, TodoOverlay items
- Overlays: ConfirmModal/RewindBanner action buttons, SettingsPanel theme names
- Setup: StatusBox, StepPush/StepPwa notice boxes
- Pages: DashboardPage subtitle/code, PinPage error, SetupPage subtitle

---

## 3. Font Weight Inventory

| Weight | Tailwind Class | CSS Value | Where Used |
|---|---|---|---|
| normal | `font-normal` | 400 | CommandMenu args, ModelSelector default label, TodoOverlay count, plan-mode banner hint |
| medium | `font-medium` | 500 | AgentSelector trigger, CommandMenu name, DiffView stats/active toggle, ModelSelector trigger/badge, PermissionCard/QuestionCard titles/buttons, SettingsPanel tabs/items, SidebarFilePanel active breadcrumb, TerminalPanel new-btn, TodoOverlay header, ConnectOverlay status, ThemePicker active (scoped CSS), ConduitLogo text, Header instance badge, Sidebar brand name/update link, RewindBanner bar, Toast, plan-mode.css implicit |
| semibold | `font-semibold` | 600 | AssistantMessage/UserMessage role labels, DiffView markers, Header project name/client badge, InputArea context %, ModelSelector provider header, ProjectSwitcher headers/project active, SessionList headers/date groups, SidebarFilePanel label, QuestionCard question header, SettingsPanel heading/section headers, StepHeader counter/title, StepDone heading/buttons, all setup CTA buttons, InfoPanels titles, Banners version, DebugPanel title, QrModal title/URL copied, DashboardPage title/project name, PinPage title/button, plan-mode.css title/banner/button, ThemePicker headers (scoped CSS), md-content headings/strong |
| bold | `font-bold` | 700 | ModelSelector checkmarks, ProjectSwitcher count badge, TodoOverlay status marks, StepCertificate/StepPwa/StepTailscale numbered badges, AgentSelector check (inline), highlight-theme.css strong/section |

### Weight by Semantic Role

| Role | Weight Used | Consistency |
|---|---|---|
| Page/section headings | `font-semibold` | Consistent |
| Interactive labels/triggers | `font-medium` | Consistent |
| Uppercase section headers | `font-semibold` | Consistent |
| Role labels (You/Assistant) | `font-semibold` | Consistent |
| Checkmarks/badges | `font-bold` | Consistent |
| CTA buttons | `font-semibold` | Consistent |
| Body text | Unset (inherits normal) | Consistent |

---

## 4. Line-Height Inventory

| Value | Tailwind Class | Where Used |
|---|---|---|
| 1 | `leading-none` | Header client badge, PastePreview remove btn, TerminalPanel tab close, TodoOverlay status marks, DebugPanel close btn, Banner dismiss btn, InfoPanel close btn |
| 1.2 | `leading-[1.2]` | PastePreview thumbnail name |
| 1.3 | `leading-[1.3]` | AgentSelector portal description (inline), TodoOverlay description, md-content headings |
| 1.4 | `leading-[1.4]` | InputArea textarea, ModelSelector items, AgentSelector portal items (inline), TodoOverlay subject |
| 1.5 | root default | html/body base, diff-split-view |
| 1.55 | `leading-[1.55]` | ThinkingBlock streaming text, FileViewer gutter/code, md-content pre code |
| 1.625 | `leading-relaxed` | QuestionCard warning, StepCertificate/StepPwa/StepTailscale instructions, SettingsPanel command blocks, DebugPanel base, StepHeader description |
| 1.7 | `leading-[1.7]` | AssistantMessage body, UserMessage body, ThinkingBlock expanded, PlanMode markdown |
| normal | `leading-normal` | DiffView unified/split, ProjectSwitcher count badge, ConfirmModal text |
| tight | `leading-tight` | ProjectSwitcher "Projects" label |

### Line-Height by Semantic Role

| Role | Values Used | Consistency |
|---|---|---|
| **Chat message body** | `leading-[1.7]` | Consistent |
| **Code/pre blocks** | `leading-[1.55]` | Consistent |
| **Input textarea** | `leading-[1.4]` | Single use |
| **Thinking text (streaming)** | `leading-[1.55]` | -- |
| **Thinking text (expanded)** | `leading-[1.7]` | Different from streaming |
| **Menu items** | `leading-[1.4]` | Consistent where specified |
| **Instruction body text** | `leading-relaxed` | Consistent |
| **Todo items** | `leading-[1.4]` subject, `leading-[1.3]` description | Different values |
| **Close/dismiss buttons** | `leading-none` | Consistent |
| **Diff views** | `leading-normal` | Consistent |

---

## 5. Letter-Spacing Inventory

| Value | Tailwind Class | Where Used |
|---|---|---|
| 0.05em | scoped CSS | ThemePicker section headers |
| 0.08em | `tracking-[0.08em]` | Header project name |
| 0.14em | `tracking-[0.14em]` | Sidebar brand name, ConduitLogo text |
| 0.3px | `tracking-[0.3px]` | SessionList date group labels |
| 0.5px | `tracking-[0.5px]` | ModelSelector provider header, ProjectSwitcher headers, SessionList "Sessions", SidebarFilePanel "File Browser" |
| 1px | `tracking-[1px]` | StepHeader step counter |
| 1.5px | `tracking-[1.5px]` | AssistantMessage "Assistant" label, UserMessage "You" label |
| 12px | `tracking-[12px]` | PinPage PIN input (digit spacing) |
| wide | `tracking-wide` | SubagentBackBar back button, SettingsPanel instances header |
| wider | `tracking-wider` | SubagentBackBar ESC badge |
| widest | `tracking-widest` | SettingsPanel appearance section headers |

### Letter-Spacing by Semantic Role

| Role | Values Used | Consistency |
|---|---|---|
| **Uppercase section headers** | `tracking-[0.5px]`, `tracking-widest`, `tracking-wide`, `tracking-[1px]`, `tracking-[0.3px]` | Highly inconsistent -- 5+ different values for the same pattern |
| **Brand text** | `tracking-[0.14em]`, `tracking-[0.08em]` | Two values |
| **Role labels** | `tracking-[1.5px]` | Consistent |

---

## 6. Font Family Inventory

| Font | Application Method | Where Used |
|---|---|---|
| `--font-sans` (= mono stack) | Root CSS `html, body` | Everywhere by default |
| `font-mono` (Tailwind class) | Explicit class | AssistantMessage label, UserMessage label, ThinkingBlock text, ToolGroupItem/ToolItem results/tags, SkillItem name, InputArea context %, CommandMenu name, DiffView all, FileMenu paths, FileTreeNode, FileViewer path/gutter/code, PermissionCard tool name/input, QuestionCard header/answer, SessionContextMenu items, ProjectSwitcher add input, TerminalPanel font btns, DebugPanel, md-content code, DashboardPage paths, SettingsPanel commands, QrModal URL |
| `font-sans` (Tailwind class) | Explicit class | InputArea textarea, MessageList scroll btn, PermissionCard buttons, QuestionCard buttons/input, DiffView toggle btns, TerminalPanel tabs/new-btn/close |
| `font-brand` (Tailwind class) | Not used -- always inline | -- |
| `var(--font-brand)` | Inline `style=` | Header project name, Sidebar brand/actions/update/version, InputArea attach items, AgentSelector trigger, ModelSelector trigger/dropdown, ProjectSwitcher trigger/dropdown, SessionItem title/meta, SessionList labels/search/empty/date-groups, ConnectOverlay status, SettingsPanel header/tabs/cards/hints, ConduitLogo text, DashboardPage title |

### Key Issue: Brand Font Application

`var(--font-brand)` is always applied via inline `style=` attribute rather than a Tailwind utility class. There is a `--font-brand` token in `@theme` and Tailwind generates a `font-brand` utility, but it is never used in markup. Instead, every instance uses `style="font-family: var(--font-brand);"`.

---

## 7. Spacing Inventory

### 7a. Content Max-Width

| Value | Where Used |
|---|---|
| `max-w-[760px]` | ALL chat messages (AssistantMessage, UserMessage, SystemMessage, ThinkingBlock, ToolGroupCard, ToolItem, SkillItem, ResultBar, MessageList permission/question wrappers), InputArea wrappers, PermissionCard, QuestionCard |
| `max-w-[320px]` | PermissionNotification, ProjectSwitcher dropdown |
| `max-w-[300px]` | (not found -- 320 used instead) |
| `max-w-[180px]` | ProjectSwitcher current name |
| `max-w-[160px]` | AgentSelector trigger |
| `max-w-[120px]` | ModelSelector trigger, TerminalPanel tab label |

### 7b. Horizontal Padding Patterns

| Pattern | Value | Where Used |
|---|---|---|
| **Chat message containers** | `px-5` (1.25rem / 20px) | AssistantMessage, UserMessage, SystemMessage, ThinkingBlock, ToolGroupCard, ToolItem, SkillItem, ResultBar |
| **Header** | `px-5` (1.25rem / 20px) | Header bar |
| **Input area outer** | `px-4` (1rem / 16px) | InputArea, responsive `max-md:px-3` |
| **Sidebar header** | `px-3` (0.75rem / 12px) | Sidebar header |
| **Sidebar footer** | `px-3.5` (0.875rem / 14px) | Sidebar footer |
| **Sidebar actions** | `px-2.5` (0.625rem / 10px) | Sidebar action buttons |
| **Card inner** | `px-5` or `px-3` | Varies: message cards use px-5, tool cards use px-3 |
| **Tool/skill headers** | `px-3` (0.75rem / 12px) | ThinkingBlock, ToolGroupCard, ToolItem, SkillItem |
| **Dropdown menu items** | `px-3` to `px-3.5` | Header dropdown, CommandMenu, FileMenu, ModelSelector, ProjectSwitcher, SessionContextMenu |
| **Modal dialogs** | `px-6` (1.5rem / 24px) | ConfirmModal, RewindBanner modal |
| **Info panels** | `px-3` (0.75rem / 12px) | InfoPanels header/body |
| **Settings panel** | `px-5` (1.25rem / 20px) | SettingsPanel header/content |
| **Setup CTA buttons** | `px-6` (1.5rem / 24px) | All setup step buttons |

### 7c. Vertical Padding Patterns

| Pattern | Value | Where Used |
|---|---|---|
| **Chat message cards** | `py-4` (1rem / 16px) | AssistantMessage, UserMessage inner cards |
| **Header** | `py-3` (0.75rem / 12px) | Header bar |
| **Input area outer** | `py-2` (0.5rem / 8px) | InputArea, responsive `max-md:py-1.5` |
| **Input row** | `py-1.5` (0.375rem / 6px) | InputArea input-row |
| **Tool/skill headers** | `py-2` (0.5rem / 8px) | ThinkingBlock, ToolGroupCard, ToolItem, SkillItem |
| **List items (sidebar)** | `py-1.5` (0.375rem / 6px) | SessionItem, Sidebar action buttons |
| **Dropdown items** | `py-1.5` to `py-2` | Varies by component |
| **Modal dialogs** | `py-5` (1.25rem / 20px) | ConfirmModal, RewindBanner modal |
| **Settings sections** | `py-4` (1rem / 16px) | SettingsPanel notification/debug cards |
| **Setup CTA buttons** | `py-3` (0.75rem / 12px) | All setup step buttons |
| **Banner bars** | `py-2` (0.5rem / 8px) | Banners, RewindBanner (py-2.5) |
| **Tabs** | `py-2` (0.5rem / 8px) | SettingsPanel tabs, TerminalPanel tabs (py-1.5) |

### 7d. Gap Patterns

| Value | Where Used |
|---|---|
| `gap-px` (1px) | Sidebar session actions |
| `gap-0.5` (2px) | SidebarFilePanel header btns, TodoOverlay option content, QuestionCard option content |
| `gap-[2px]` (2px) | AgentSelector trigger, ModelSelector trigger, ThemePicker swatches |
| `gap-1` (4px) | InputArea bottom row, SessionItem, TerminalPanel tabs, DiffView toggle bar, QuestionCard options, Header project badge |
| `gap-1.5` (6px) | Header right section, SubagentBackBar responsive, ThinkingBlock header, SkillItem/ToolItem subtitle, PermissionCard always-allow, ProjectSwitcher instance header/add form, SessionList select actions, SetupPage progress, SettingsPanel commands/hints, ConnectOverlay instance btns |
| `gap-2` (8px) | Header main/left/dropdown, InputArea context/attach, Sidebar logo/actions/update, SubagentBackBar, SystemMessage, ToolGroupItem, ToolItem question options, MessageList loading, DiffView split, PermissionCard buttons, QuestionCard buttons/options, ProjectSwitcher items/project, SessionContextMenu, SettingsPanel buttons, RewindBanner, Banners, InfoPanels status, DebugPanel status, StatusBox, StepCertificate/StepDone/StepPush/StepTailscale, DashboardPage project name |
| `gap-2.5` (10px) | ToolGroupCard/ToolItem/SkillItem headers, InputArea attach menu, ProjectSwitcher project items, RewindBanner radio, SettingsPanel scenario |
| `gap-3` (12px) | DiffView stats, ConnectOverlay column/buttons, Sidebar setup instructions, SettingsPanel notification icon row |
| `gap-4` (16px) | DebugPanel status metrics, SettingsPanel notification/debug cards, QrModal dialog |

### 7e. Margin Patterns

| Pattern | Value | Where Used |
|---|---|---|
| **Content centering** | `mx-auto` | ALL chat containers, InputArea, PermissionCard, QuestionCard |
| **Between chat messages** | `mb-3` (0.75rem) | AssistantMessage, UserMessage, MessageList wrappers |
| **Between tool items** | `my-1.5` (0.375rem) | ThinkingBlock, ToolGroupCard, SkillItem |
| **Role label below** | `mb-2` (0.5rem) | AssistantMessage "Assistant", UserMessage "You" |
| **Result bar** | `mt-1 mb-5` | ResultBar |
| **Modal/dialog spacing** | `mb-4` to `mb-5` | ConfirmModal text, RewindBanner heading, setup instructions |
| **Setup heading spacing** | `mb-1` to `mb-2` | StepHeader title, StepDone heading, SetupPage/PinPage title |
| **Page footer** | `mt-10` | DashboardPage version |

### 7f. Recurring Button Sizes

| Pattern | Dimensions | Where Used |
|---|---|---|
| **Icon buttons (small)** | `w-7 h-7` (28px) | AssistantMessage copy/fork, InputArea attach, FileViewer actions |
| **Icon buttons (tiny)** | `w-6 h-6` (24px) | SessionList header actions, SidebarFilePanel actions, SessionItem more |
| **Send/stop buttons** | `w-8 h-8` (32px) | InputArea send/stop |
| **Font size control** | `w-[44px] h-[44px]` | FileViewer font buttons |
| **Status dots** | `w-1.5 h-1.5` (6px) | Header, ProjectSwitcher |
| **Connection dot** | `w-[7px] h-[7px]` | Header status, SessionItem processing |

### 7g. Border Radius Patterns

| Value | Where Used |
|---|---|
| `rounded-[10px]` | Chat message cards, InputArea send/stop, attach menu, ModelSelector/AgentSelector trigger |
| `rounded-3xl` | InputArea input-row |
| `rounded-xl` (12px) | md-content pre blocks, AgentSelector portal dropdown |
| `rounded-lg` (8px) | Tool result blocks, diff-split-view, file-history-view |
| `rounded-md` (6px) | Sidebar buttons, header icon buttons, sidebar toggle, input attach button, project items |
| `rounded-[6px]` | md-content inline code |
| `rounded-[9px]` | Header client count badge (pill) |
| `rounded-[4px]` / `rounded` | DiffView toggle buttons, rewind markers, small badges |
| `rounded-full` | Status dots, resize handle pills, toggle knobs |

---

## 8. Component-Level Patterns

### Chat Messages (AssistantMessage, UserMessage)

```
Container:  max-w-[760px] mx-auto mb-3 px-5
Card:       py-4 px-5 rounded-[10px]
Role label: text-[11px] font-mono font-semibold uppercase tracking-[1.5px] mb-2
Body text:  text-[13px] leading-[1.7]
```

### Tool/Skill Items

```
Container:  max-w-[760px] mx-auto my-1.5 px-5
Header btn: text-xs py-2 px-3 gap-2.5 w-full
Name:       font-medium
Subtitle:   text-xs italic gap-1.5 py-0.5 px-3 pl-4
Result:     font-mono text-xs py-2 px-2.5 max-h-[300px]
Tags:       text-[11px] px-1.5 py-0.5
```

### Sidebar Action Buttons

```
Button:     text-[13px] py-1.5 px-2.5 gap-2 w-full rounded-md
Font:       var(--font-brand) via inline style
```

### Sidebar Session Items

```
Link:       text-[13px] py-1.5 px-2.5 gap-1
Title font: var(--font-brand) via inline style
Meta:       text-[11px]
```

### Uppercase Section Headers

```
Pattern:    uppercase font-semibold tracking-[0.5px]
Size:       text-[11px] (SessionList, ProjectSwitcher, SidebarFilePanel)
            text-[10px] (SettingsPanel, ProjectSwitcher instance groups)
            text-[9px]  (SessionList date groups)
```

### Modal Dialogs

```
Card:       py-5 px-6
Body text:  text-sm
Buttons:    text-[13px] py-1.5 px-4
Action btn: font-medium
```

### Setup Pages

```
Title:      text-[22px] font-semibold
Subtitle:   text-[13px]
Body:       text-sm leading-relaxed
CTA:        text-sm font-semibold px-6 py-3 gap-2
Hints:      text-xs
```

### Info Panels

```
Header:     text-xs font-semibold px-3 py-2
Body:       text-xs px-3 py-2 gap-1
Close btn:  text-sm leading-none p-0
```

### Settings Panel

```
Title:      text-lg font-semibold px-5 py-3
Tabs:       text-sm font-medium px-3 py-2
Content:    p-5
Section:    text-[10px] font-semibold tracking-widest uppercase
Items:      text-sm
Hints:      text-xs
```

### Dropdown Menus

```
Container:  py-1 to py-1.5
Items:      py-1.5 to py-2, px-3 to px-3.5
Text:       text-[13px] or text-xs
```

---

## 9. Inconsistencies & Observations

### Critical Inconsistencies

#### 1. `text-[13px]` vs `text-base` Collision
Both resolve to 13px (since root is 13px), but `text-[13px]` is an arbitrary value while `text-base` uses Tailwind's scale. They're used interchangeably:
- `text-[13px]`: Message bodies, sidebar actions, menu items (~30 components)
- `text-base`: InputArea textarea, FileViewer font buttons, QrModal (3 uses)

#### 2. Three Competing "Small Text" Sizes
- `text-xs` (9.75px) -- used in ~30+ components
- `text-[10px]` -- used in ~12 components
- `text-[11px]` -- used in ~17 components

These three sizes are often used for the same semantic role (metadata, badges, labels) with no clear rule for when to use which.

#### 3. Five Different Uppercase Section Header Styles
Components using the "uppercase semibold section header" pattern use different sizes and tracking:

| Component | Size | Tracking |
|---|---|---|
| SessionList "Sessions" | `text-[11px]` | `tracking-[0.5px]` |
| SessionList date groups | `text-[9px]` | `tracking-[0.3px]` |
| ProjectSwitcher "Projects" | `text-[11px]` | `tracking-[0.5px]` |
| ProjectSwitcher instance headers | `text-[10px]` | `tracking-[0.5px]` |
| SidebarFilePanel "File Browser" | `text-[11px]` | `tracking-[0.5px]` |
| ModelSelector providers | `text-[11px]` | `tracking-[0.5px]` |
| SettingsPanel appearance | `text-[10px]` | `tracking-widest` |
| SettingsPanel instances | `text-xs` | `tracking-wide` |
| StepHeader counter | `text-[11px]` | `tracking-[1px]` |

#### 4. Brand Font Application Method
`var(--font-brand)` is applied via inline `style=` in ~30+ places, never via Tailwind's `font-brand` utility class. This creates maintenance burden and makes it impossible to override via Tailwind's responsive/state variants.

#### 5. Button Size Inconsistency
- Setup CTA buttons: `text-sm font-semibold px-6 py-3`
- Modal action buttons: `text-[13px] font-medium py-1.5 px-4`
- Permission/Question action buttons: `text-sm font-medium px-4 py-2 min-h-[48px]` or `min-h-12`
- Plan approval buttons: `0.875rem font-weight:600 0.5rem 1.5rem` (via CSS, not Tailwind)

#### 6. Tool Result Area Inconsistency
- SkillItem/ToolGroupItem: `py-2 px-2.5 max-h-[300px]`
- ToolItem generic: `py-3 px-4 max-h-[200px]` (different padding AND max-height)

#### 7. Line-Height Variance for Similar Content
- Chat message bodies: `leading-[1.7]`
- Thinking block streaming: `leading-[1.55]`
- Thinking block expanded: `leading-[1.7]`
- TodoOverlay subject: `leading-[1.4]`
- TodoOverlay description: `leading-[1.3]`
- InputArea textarea: `leading-[1.4]`
- Code/pre blocks: `leading-[1.55]`

#### 8. Dropdown Item Padding Variance
- CommandMenu/FileMenu: `py-2 px-3.5`
- ModelSelector: `py-1.5 px-3.5`
- ProjectSwitcher: `px-3 py-2.5`
- SessionContextMenu: `py-2 px-3`
- Header instance dropdown: `px-3 py-1.5`
- SettingsPanel tabs: `px-3 py-2`

#### 9. AgentSelector Portal Uses Inline Styles
AgentSelector creates its dropdown via `innerHTML` with inline CSS (`font-size:13px; padding:6px 14px; gap:8px; line-height:1.4;`) rather than Tailwind classes, making it impossible to maintain consistently with the rest of the UI.

#### 10. ThemePicker Uses Scoped CSS Instead of Tailwind
All of ThemePicker's font/spacing is in scoped `<style>` with raw pixel/em values rather than Tailwind classes, creating a parallel styling system.

### Minor Inconsistencies

- **Header min-height**: `min-h-[48px]` vs PermissionCard/QuestionCard buttons using `min-h-[48px]` / `min-h-12` (both are 48px but expressed differently)
- **Rounded corners**: Chat cards use `rounded-[10px]` while most other containers use `rounded-lg` (8px) or `rounded-xl` (12px)
- **DashboardPage project name**: `text-[16px]` -- unique size not used anywhere else
- **PinPage title**: `text-[22px]` matches SetupPage, but DashboardPage uses `text-2xl` (19.5px)
- **Sidebar horizontal padding** varies: `px-1`, `px-2`, `px-2.5`, `px-3`, `px-3.5` all used in different parts

---

## 10. Recommendations

### Establish a Reduced Font Size Scale

Proposed mapping from current values to a consistent scale:

| Role | Current (mixed) | Proposed | Tailwind |
|---|---|---|---|
| Tiny badges | 8px, 9px, 9.75px | **10px** | `text-[10px]` |
| Small labels/meta | 9.75px, 10px, 11px | **11px** | `text-[11px]` |
| Body / UI text | 11.375px, 13px | **13px** | `text-[13px]` or `text-base` (pick one) |
| Headings (section) | 14px, 14.625px, 15px | **15px** | `text-[15px]` or custom token |
| Headings (page) | 16px, 16.25px, 19.5px, 22px | **20px** and **24px** | `text-xl` / `text-2xl` (adjust root or use arbitrary) |

### Standardize Uppercase Section Headers

Create a single pattern:
```
text-[11px] font-semibold uppercase tracking-[0.5px] text-text-muted
```

### Use `font-brand` Utility Instead of Inline Styles

Replace all `style="font-family: var(--font-brand);"` with the Tailwind `font-brand` class (already generated by the `@theme` block).

### Standardize Button Tiers

| Tier | Pattern |
|---|---|
| CTA / Primary | `text-sm font-semibold px-6 py-3 rounded-[10px]` |
| Secondary / Modal | `text-[13px] font-medium px-4 py-2 rounded-md` |
| Inline / Small | `text-xs font-medium px-3 py-1.5 rounded-md` |

### Standardize Dropdown Menu Items

```
py-2 px-3.5 text-[13px]
```

### Standardize Gap Scale

| Use | Value |
|---|---|
| Tight (inline badges) | `gap-1` |
| Standard (flex rows) | `gap-2` |
| Spacious (card sections) | `gap-3` |
| Wide (page sections) | `gap-4` |

### Standardize Line-Height for Content Tiers

| Tier | Value |
|---|---|
| Body text / messages | `leading-[1.7]` |
| Code blocks | `leading-[1.55]` |
| UI labels / menus | `leading-[1.4]` |
| Compact / badges | `leading-none` |

### Migrate AgentSelector Portal and ThemePicker to Tailwind

Replace inline CSS and scoped CSS with Tailwind utility classes to ensure consistency with the rest of the UI.
