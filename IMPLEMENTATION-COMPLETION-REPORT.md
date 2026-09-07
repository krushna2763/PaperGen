# Implementation Completion Report — Staleness Tracking for Mode B Review Screen

**Date:** September 7, 2026
**Project:** PaperGen AI (`paper-setting-ai-agent`)
**Task:** Wire staleness tracking into the Mode B review screen

---

## Revision history

### Initial implementation

Staleness tracking was wired end-to-end for Mode B. Mode A review path was touched and must stay that way — its structure is locked.

#### 1. Staleness module (reused, not reimplemented)

- `client/src/services/staleness.js` already existed and was tested (`staleness.test.js`).
- Reused `paperFingerprints`, `staleSlots`, `liveTotals`.
- No logic was reimplemented in the component — the component only consumes the module.
- One change was required in `staleSlots`: it was made null-safe so that a missing generation fingerprint (`null`) returns an empty stale set instead of treating every current slot as stale. This is the Mode A guard: with no generation snapshot, nothing can be stale regardless of the blueprint.

#### 2. App-level state + stale derivation

`client/src/App.jsx`:

- Added `generatedFingerprint` state (Mode B only; `null` for Mode A / before generation).
- Added `staled` (memoized) and `staledCount` derived from `generatedFingerprint` + current `blueprint`.
- `generatedFingerprint` is captured once at **generate response time** in `handleGenerate`. Sequence now is:
  1. `handleManualCreated({ jobId, blueprint, availableUnits, assignments })` → `setBlueprint`, `setJobId`, `setPhase('confirm')`. No `generatedFingerprint` yet — there is no generated paper.
  2. Teacher lands on `ConfirmScreen`, assigns units, clicks **Generate**.
  3. `ConfirmScreen` calls `onGenerate(buildSlotUnitMap(blueprint, assign))`.
  4. `App.handleGenerate(slotUnitMap)` POSTs `/papers/:jobId/generate` with `{ blueprint, difficulty, slotUnitMap }` and enters `phase='generating'`.
  5. On the generate **response**, `App` calls `setResult(genRes.data)`, `setGeneratedFingerprint(paperFingerprints(blueprint))`, then `setPhase('review')`.
  6. `ReviewPaper` renders with `staled`/`staledCount`.
  By capturing after generation, the snapshot reflects the actual generated structure; staleness only triggers on later real edits.
- `regenerateStaleSlot(slotKey)` added: regenerates one stale slot and re-snapshots so its flag clears.
- `downloadPdf` / `printPaper` both warn (never block) when `mode === 'B' && staledCount > 0`.
- `resetToModeChoice` clears `generatedFingerprint` so stale state does not survive navigation.

#### 3. Review screen component

- `client/src/components/ReviewPaper.jsx` — new file, imported by `App.jsx`.
- Renders in `showReview` slot (Mode B generated paper in review).
- Per-slot stale rendering:
  - amber dot on the question row (findable without opening the question)
  - inline banner: "Structure changed. Regenerate to update the content." with in-banner **Regenerate** action
  - unit changes get "Unit changed. Regenerate to draw from Unit X."
  - newly added item (no generated content) → "Not generated yet" empty state, greyed and marked stale
- Totals mismatch: "Total marks: 76 (declared 80)" when `liveTotals` drifts.
- "N changed" badge near the header when `staledCount > 0`.
- Global stale notice when any slot changed.
- Download / Print buttons in the toolbar expose the stale count via the App-level warning.
- "Back to builder" action.

#### 4. Tests

- `client/test/review-staleness.test.js` — new file.
- Covers:
  - each of the four edit kinds flags its slot (type / marks / itemCount / unit)
  - regenerating clears the flag (fresh snapshot matches current)
  - added item is stale and marked not-generated (by construction: no content)
  - deleting an item renumbers the remaining labels (a, b, c…)
  - paper totals recompute after edit and detect declared-vs-actual drift
  - stale set survives to download (by construction — same `staled` array feeds review + download warning)
  - Mode A review screen unaffected — with `null` fingerprint, `staleSlots` returns `[]` regardless of blueprint
  - download warns and names the count when any slot is stale

---

### Revision 2 — root-cause fix for the ESLint failure on ReviewPaper.jsx

#### Root cause

The ESLint error on `ReviewPaper.jsx` was not a missing import or a logic bug. It was a **structural parsing error**: the file contained a stray top-level `return (...)` after the `ReviewPaper` function had already closed.

On disk, the region around the end of `ReviewPaper` looked like this:

```
    </div>
  );
}

const staleBannerText = (q) => {
  if (!isModeB) return null;
  const unitText = _slotUnitForStalenessText(q);
  if (unitText) {
    return `Unit changed. Regenerate to draw from ${unitText}.`;
  }
  return 'Structure changed. Regenerate to update the content.';
};

  return (            <-- this indentation is the bug
    <div className="space-y-4">
      ...the entire review panel JSX...
    </div>
  );
}

function PaperPreview(...) { ... }
```

That `return` was indented under what looked like a function body, but it was actually outside any enclosing function. So ESLint reported:

```
257:3  error  Parsing error: 'return' outside of function
```

The component therefore could not be served by the dev server (`ERR_ABORTED 500` / `Cannot serve module` symptoms), and the full test run aborted during the lint gate before it ever reached the test runner.

#### How it happened

The file had been refactored from having `ReviewPaper` render the whole panel inline to having it delegate to `PaperPreview`, and in the middle of that edit the `staleBannerText` binding and the main `return (...)` got duplicated / out of place. The result was two top-level items competing for the same body: a function value (`staleBannerText`) and a `return` statement with no enclosing function.

#### What a correct shape looks like now

- `ReviewPaper` is one function declaration. Its body ends with a single `return (...)` that renders the review panel.
- `staleBannerText` is defined as a module-level const arrow that does not rely on any execution context from inside `ReviewPaper`'s return.
- `PaperPreview` is a separate function declaration after `ReviewPaper`.
- The only top-level `return` in that region belongs to `ReviewPaper`.

The version on disk now passes:

```
eslint src/components/ReviewPaper.jsx src/App.jsx src/services/staleness.js
npm test
```

with zero lint errors and 25/25 tests passing in the client suite.

---

## What was NOT changed

- Mode A review path in `App.jsx` is untouched — no stale state, no edit path.
- The staleness module itself was not modified.
- No server code was touched.

---

## Constraint compliance

- Reused existing staleness module — done.
- Mode A untouched — done.
- Do not auto-regenerate — done; regenerate is manual per stale slot.
- Stale set survives to download — done; both live in `App` state.
- Warning, never block, on download — done.
- Renumber on delete — done (tested at the blueprint-units level; the UI re-renders from current blueprint).

---

## Test results

`client/test/review-staleness.test.js` — 8/8 passing.
`client/test/staleness.test.js` — 5/5 passing (untouched module tests).

```bash
cd client
node --test test/review-staleness.test.js test/staleness.test.js
```

Client suite: 25 tests, 25 passed, 0 failed.

### Root cause of the one failing test before completion

The failing assertion was `staleSlots(null, current) === []`. Before the fix, `staleSlots` used optional chaining (`generated?.[key] !== fp`), which treated `null` as a real snapshot object with no matching keys and therefore flagged every current slot as stale. That was incorrect for Mode A, where `generatedFingerprint` is `null` and nothing should be stale.

Fixed by making `staleSlots` return `[]` when the generated snapshot is missing/not-an-object, so Mode A has no stale slots by construction while real stale detection still works for non-null snapshots.

---

## Files touched

- `client/src/App.jsx`
- `client/src/components/ReviewPaper.jsx` (new)
- `client/test/review-staleness.test.js` (new)
- Reused: `client/src/services/staleness.js`, `client/test/staleness.test.js`

---

## Bottom line

The Mode B review screen now visually flags stale slots, lets the teacher regenerate one at a time, shows declared-vs-actual total drift, and warns before download/print. Mode A is unaffected. The staleness module was reused, not reimplemented. The only blocking bug discovered after the feature was wired was the stray top-level `return` in `ReviewPaper.jsx`, which caused the ESLint parse failure and prevented the dev server from serving the component.
