# CLI Key Hints Design

## Problem

The CLI's interactive prompts don't show available key bindings. Users must discover arrow keys, enter, escape, etc. by trial and error. Only `promptMultiSelect` has a hint line (`space: toggle · enter: confirm`), and even that is incomplete.

## Solution

Add a built-in dim-text key hint line to every prompt type in `src/lib/cli/prompts.ts`. The hints render below the prompt content, matching the existing `promptMultiSelect` pattern.

## Hint Text Per Prompt

| Prompt | Hint line |
|--------|-----------|
| `promptToggle` | `←→: toggle · y/n: yes/no · enter: confirm` |
| `promptPin` | `0-9: digits · backspace: delete · enter: confirm/skip` |
| `promptText` | `tab: complete · enter: confirm · esc: back` |
| `promptSelect` (with back) | `↑↓: navigate · enter: select · esc: back` |
| `promptSelect` (no back) | `↑↓: navigate · enter: select` |
| `promptMultiSelect` | `↑↓: navigate · space: toggle · a: all · enter: confirm · esc: skip` |

## Implementation

- All changes in `src/lib/cli/prompts.ts`
- Hint format: `  │  ${dim}...${reset}` (same indent/bar prefix as content)
- Each prompt's `lineCount` incremented by 1 for the hint line
- `promptSelect` key hints render below items but above existing `opts.hint` gradient lines
- `promptText` keeps `(esc to go back)` in the title alongside the new footer
