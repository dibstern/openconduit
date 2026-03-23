# 12px Rebase Plan — Audit Synthesis

Dispatched 4 auditors across Tasks 1-11. Tasks 1-2 auditor produced no findings (clean). Tasks 3-4, 5-8, and 9-11 produced findings.

## Amend Plan (5)

1. **AgentSelector line 131 `text-[13px]` is in JS but safe to replace.** Plan contradictorily lists it as a target but warns to skip JS contexts. It IS safe — Tailwind scans all strings. Fix: replace it in Task 5, and also update line 131 in Task 11 alongside line 144.

2. **ConduitLogo has `text-[28px]` (line 24) and `text-[14px]` (line 25) not covered by any task.** These have no standard Tailwind equivalent. Fix: add to Task 8 as exceptions, update grep verification to expect 2 remaining arbitrary values.

3. **AssistantMessage lines 175, 182 are JS `className` assignments.** Safe to replace but plan should note this for implementer clarity (like it does for AgentSelector).

4. **ConnectOverlay line 195 is the only compound inline style.** Has gradient/clip CSS alongside font-family. Plan should explicitly flag this line so implementer doesn't accidentally delete the gradient styles.

5. **ThemePicker `isActive` pseudocode references nonexistent variable.** Actual condition is `themeState.currentThemeId === id` via `class:active`.

## Ask User (5)

6. **Silent rem spacing shrinkage (~7.7%).** plan-mode.css has 15 and style.css has 19 rem-based spacing values (padding/margin/gap/border-radius) that will shrink when root goes 13→12px. Accept the shrinkage or also pin to px?

7. **`.file-history-badge` jumps 8.125px → 10px (23% increase).** Uppercase bold badge — 10px will look noticeably larger. Keep at 10px (text-xs) or pin closer to original?

8. **PastePreview thumbnail label jumps 8px → 10px (25% increase).** On a 60×60px thumbnail. Keep at 10px or leave as `text-[8px]` exception?

9. **Dashboard project heading drops 16px → 15px (text-lg).** Intentional 1px decrease?

10. **Page titles increase 22px → 24px (text-2xl).** SetupPage, PinPage, ConduitLogo standard. Intentional 2px increase?

## Accept (informational)

- `font-brand` class generation confirmed valid via `--font-brand` in @theme
- Timeline markers and diff line numbers 8.9→10px is intentional scale consolidation
- text-[12px] → text-base is size-preserving (12=12)
- text-[9px] → text-xs (10px) is minor and safe
- No story files need updating
- ThemePicker CSS property interactions are safe
- AgentSelector portal's non-font inline styles are out of scope
