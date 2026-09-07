## Staleness wire-up — final state

### Root cause and what was fixed

The ESLint error on `ReviewPaper.jsx` was not about a missing import or a logic bug. It was a **structural parsing error**: the file contained a stray top-level `return (...)` after the `ReviewPaper` function had already closed.

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

**How it happened:** the file had been refactored from having `ReviewPaper` render the whole panel inline to having it delegate to `PaperPreview`, and in the middle of that edit the `staleBannerText` binding and the main `return (...)` got duplicated / out of place. The result was two top-level items competing for the same body: a function value (`staleBannerText`) and a `return` statement with no enclosing function.

### What a correct shape looks like now

- `ReviewPaper` is one function declaration. Its body ends with a single `return (...)` that renders the review panel.
- `staleBannerText` is hoisted/defined as a **module-level const arrow** that does not rely on any execution context from inside `ReviewPaper`'s return.
- `PaperPreview` is a separate function declaration after `ReviewPaper`.
- The only top-level `return` in that region belongs to `ReviewPaper`.

The version on disk now passes:

```
eslint src/components/ReviewPaper.jsx src/App.jsx src/services/staleness.js
npm test
```

with zero lint errors and 25/25 tests passing in the client suite.

### What the stale feature now does

- Mode B review screen only.
- Stale dot on the question row in the left list.
- Inline banner above question text when that slot is stale.
- Unit change wording: `Unit changed. Regenerate to draw from <unit>.`
- Structural change wording: `Structure changed. Regenerate to update the content.`
- Empty state for newly added items: `Not generated yet`.
- Per-slot `Regenerate` button in the banner clears the flag.
- Global stale notice and stale count near the header.
- Declared-vs-actual totals mismatch shown when paper/section totals drift.
- Download warning when any slot is stale, with the count.
- `staleSlots()` reused from the staleness module; `staleSlots(null, ...)` is the Mode A guard and returns `[]`.
- Fingerprint captured at generate response time, not earlier, so a freshly generated paper is not spuriously stale.

### Report counts

- Client lint + tests: 25 tests, 25 passed, 0 failed.
- Lint: `ReviewPaper.jsx`, `App.jsx`, `staleness.js` all clean.
- The blocking error was the stray top-level `return` after the `ReviewPaper` closing brace.

### Notes for follow-up

If another edit touches the tail of `ReviewPaper.jsx`, the safest check is to confirm that the file contains exactly one top-level `return` in the `ReviewPaper` region and that `staleBannerText` is either:

- a const declared at module scope, or
- otherwise guaranteed to be defined before it is referenced in `PaperPreview`.

That is the only thing that can reintroduce the `return outside of function` failure for this component.
