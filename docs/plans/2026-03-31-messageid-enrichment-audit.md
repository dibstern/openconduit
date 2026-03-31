# MessageId Enrichment Plan — Audit Synthesis

Dispatched 6 auditors across Tasks 1-6. Tasks 7-8 are cleanup/verification (no code to audit).

## Amend Plan (6)

1. **Task 1 — Mock Translator**: `createMockTranslator()` in `test/helpers/mock-factories.ts:203-210` uses a direct `as` cast and will fail to compile when `getCurrentMessageId` is added to the `Translator` interface. Add `getCurrentMessageId: vi.fn().mockReturnValue(undefined)` to the mock.

2. **Task 2 — Missing documentation tests**: Add tests verifying (a) `message.updated` does NOT populate the tracker (its messageID is nested at `info.id`, not top-level `properties.messageID`), and (b) events with no `messageID` field at all (e.g. `session.status`) are no-ops for tracking.

3. **Task 3 — ENRICHABLE_TYPES comment**: Add a cross-reference comment on `ENRICHABLE_TYPES` pointing to `shared-types.ts` `RelayMessage` so future developers know to update both in sync.

4. **Task 3 — Missing result enrichment test**: The `result` type is in `ENRICHABLE_TYPES` but has no dedicated enrichment test. Add one for when `translateMessageUpdated` produces a result without messageId (when `msg.id` is absent).

5. **Task 4 — Weak override tests**: Both "explicit messageId preserved" tests are tautological: the tracker updates from the same event, so tracker value == event value. The tests pass even if enrichment always overwrites. Add a test of `enrichResult()` directly, or restructure to use different messageIds for tracker vs event.

6. **Task 5 — Missing enrichment-stops-after-reset test**: The reset tests verify `getCurrentMessageId()` returns undefined, but don't verify that enrichment actually stops producing messageId in output. Add: populate messageId -> reset -> translate tool event -> assert output has no messageId.

## Accept (remainder)

- Event ordering is not assumed (extraction runs on every non-removal event) — Task 2 ✓
- No race conditions (synchronous, single-threaded) — Task 2 ✓
- `as RelayMessage` cast is structurally valid for all 8 ENRICHABLE_TYPES — Task 3 ✓
- `!("messageId" in m)` correctly detects unenriched messages (conditional spread never sets key to undefined) — Task 4 ✓
- `dispatchEvent()` extraction correctly parameterizes seenParts — Task 3 ✓
- Reset caller (`session-lifecycle-wiring.ts:62`) followed by rebuild in production — Task 5 ✓
- Existing metamorphic and stateful PBT tests unaffected — Task 5 ✓

## Amendments Applied

| Finding | Task | Amendment |
|---------|------|-----------|
| Mock Translator missing method | Task 1 | Added Step 3a: update `createMockTranslator()` + Step 4a verification |
| Missing documentation tests | Task 2 | Added 2 tests: `message.updated` not tracking, `session.status` no-op |
| ENRICHABLE_TYPES comment | Task 3 | Added cross-reference comment to `shared-types.ts` on the Set |
| Missing result enrichment test | Task 3 | Added `enriches result with tracked messageId when msg.id is absent` test |
| Weak override tests | Task 4 | Restructured: export `enrichResult`, test directly with different fallback vs explicit IDs |
| Missing enrichment-after-reset test | Task 5 | Added `enrichment stops producing messageId in output after reset` test |
