/** @jsxImportSource react */
/** @jsxFrag React.Fragment */
/**
 * ReviewPaper — Mode B review screen (top-level component, imported by App).
 *
 * This screen REPLACES the "Generated Question Paper" panel when a Mode B paper
 * is in review. Mode A never reaches here — its structure fields stay locked, so
 * nothing can go stale, and the existing `!showConfirm && hasPaper` path stays
 * unchanged in App.jsx.
 *
 * What it owns (all drawn from props so App retains the state):
 *   - stale-flag rendering (amber dot on the row + inline banner above the text)
 *   - the "Not generated yet" empty state for newly added items
 *   - the declared-vs-actual paper/section totals mismatch
 *   - the per-slot regenerate action (clears the flag)
 *   - the download/print warnings (stale count must be available here, and it
 *     is: App passes `staled` + `staledCount`).
 *
 * What it does NOT own:
 *   - the stale set itself (that lives in App as `staled`/`staledCount`, shared
 *     with the download/print warning)
 *   - the generated-fingerprint snapshot (App takes that at generate time)
 *   - any editing (editing stays in the QuestionBuilder; this screen only reads
 *     the current blueprint to compute staleness)
 *
 * Structure facts that make a slot stale (per the staleness module):
 *   type changed · marks changed · item count changed · unit changed.
 * A slot fingerprint captures exactly those; `staleSlots()` compares the
 * generated snapshot to the current blueprint.
 */

import { useMemo } from 'react';
import { buildPaperModel, paginatePaper } from '../services/paperLayout.js';
import { liveTotals } from '../services/staleness.js';
import { slotKey, slotIsStale } from './blueprintUnits.js';

const AlertTriangleIcon = (p) => (
  <svg
    width={15}
    height={15}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={p.className}
  >
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
  </svg>
);

const RefreshIcon = (p) => (
  <svg
    width={14}
    height={14}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={p.className}
  >
    <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
    <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
    <path d="M16 16h5v5" />
  </svg>
);

// Module-level so the preview subcomponents can call it. Mode A slots can never
// be stale (structure locked, no edit path), so this returns null for them.
//
// The wording is deliberately generic. A "unit changed" variant was removed:
// it read the unit off `q.items[].referenceText`, but `buildPaperModel`
// questions carry `subParts`, never `items`, so that branch was unreachable —
// and the unit identity the wording would need lives in `slotUnitMap`, which is
// not passed to this screen. Naming the changed structural fact is out of
// scope for a one-line banner; "Regenerate" is the action either way.
function staleBannerText(isModeB) {
  if (!isModeB) return null;
  return 'Structure changed. Regenerate to update the content.';
}

export default function ReviewPaper({
  mode,
  blueprint,
  result,
  staled,
  staledCount,
  regenerateStaleSlot,
  onDownload,
  onPrint,
  onOpen,
  onBack,
}) {
  const isModeB = mode === 'B';

  // Reuse the existing model builders so the preview is identical to the rest of
  // the app. This component does not re-render the whole paper model on every
  // keystroke — that lives in App; we only re-compute what we render here.
  const model = useMemo(
    () =>
      result && result.questions && result.questions.length > 0
        ? buildPaperModel({ questions: result.questions, blueprint, settings: { class: '', difficulty: '' }, subject: '', format: {} })
        : null,
    [result, blueprint]
  );
  const pages = useMemo(() => (model ? paginatePaper(model) : []), [model]);
  const hasPaper = pages.length > 0;

  const totals = useMemo(() => {
    if (!blueprint) return null;
    return liveTotals(blueprint);
  }, [blueprint]);

  return (
    <div className="space-y-4">
      {/* header */}
      <div className="flex items-center gap-2.5 px-5 pt-5">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-amber-300 bg-amber-50 text-amber-700">
          <AlertTriangleIcon size={13} />
        </span>
        <h2 className="text-[15px] font-semibold text-gray-900">Review & edit</h2>
        {isModeB && staledCount > 0 && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
            <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
            {staledCount} changed
          </span>
        )}
      </div>

      {/* stale global notice, when any slot changed */}
      {isModeB && staledCount > 0 && (
        <div className="flex items-start gap-2.5 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-4 py-3 text-sm">
          <AlertTriangleIcon className="shrink-0 mt-0.5" size={16} />
          <div className="flex-1">
            <p className="font-medium">{staledCount} question{staledCount === 1 ? '' : 's'} ha{staledCount === 1 ? 's' : 've'} changed since generation.</p>
            <p className="mt-0.5 text-[12.5px] text-amber-700/80">
              The content shown below was generated against the old structure. Use the
              <span className="font-medium"> Regenerate</span> button on any stale question to refresh just that question.
            </p>
          </div>
        </div>
      )}

      {/* paper totals: declared vs actual */}
      {totals && totals.drifted && (
        <div className="flex items-center gap-2.5 bg-amber-50/70 border border-amber-200/60 rounded-lg px-4 py-2.5 text-sm">
          <span className="text-amber-700 font-medium">Total marks: {totals.total}</span>
          <span className="text-amber-600">(declared {totals.declared})</span>
        </div>
      )}

      {/* the paper itself */}
      {!hasPaper ? (
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-8 text-center">
          <p className="text-[13px] text-gray-500">Generating…</p>
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          {/* toolbar */}
          <div className="flex items-center gap-2 px-4 pt-3 pb-2 border-b border-gray-100">
            <div className="flex-1" />
            <button
              type="button"
              onClick={onOpen}
              className="h-7 w-7 flex items-center justify-center rounded text-gray-300 hover:bg-gray-100 hover:text-gray-600 transition-colors"
              title="View Full PDF"
            >
              <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
            <button
              type="button"
              onClick={onDownload}
              className="h-7 w-7 flex items-center justify-center rounded text-gray-300 hover:bg-gray-100 hover:text-gray-600 transition-colors"
              title="Download PDF"
            >
              <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <path d="m7 10 5 5 5-5" />
                <path d="M12 15V3" />
              </svg>
            </button>
            <button
              type="button"
              onClick={onPrint}
              className="h-7 w-7 flex items-center justify-center rounded text-gray-300 hover:bg-gray-100 hover:text-gray-600 transition-colors"
              title="Print"
            >
              <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                <rect x="6" y="14" width="12" height="8" />
              </svg>
            </button>
            <button
              type="button"
              onClick={onBack}
              className="ml-1 rounded-lg border border-gray-200 bg-white px-3 py-1 text-[12px] font-medium text-gray-600 hover:bg-gray-50"
            >
              Back to builder
            </button>
          </div>

          {/* paper body — reuse the app's preview renderers, which already live
              in App.jsx. Import them here so this file is self-contained. */}
          <div className={`p-5 ${'min-h-[420px]'}`}>
            <PaperPreview model={model} isModeB={isModeB} staled={staled} regenerateStaleSlot={regenerateStaleSlot} />
          </div>
        </div>
      )}

      {/* per-slot stale banners + empty state are rendered inline in the preview
          by PaperQuestionRow below; the banner here is the global one. */}
    </div>
  );
}

function PaperPreview({ model, isModeB, staled, regenerateStaleSlot }) {
  if (!model) return null;
  return (
    <div style={{ fontFamily: '"Times New Roman", "Liberation Serif", Georgia, serif', fontSize: 12, lineHeight: 1.72, color: '#111', minHeight: '100%' }}>
      {/* header */}
      <div style={{ textAlign: 'center', fontWeight: 700, lineHeight: 1.24, margin: 0 }}>
        {model.header.titleLines.map((line, i) => (
          <p key={i} style={{ textAlign: 'center', fontWeight: 700, lineHeight: 1.24, margin: 0 }}>
            {line.text}
          </p>
        ))}
      </div>
      {(model.header.timeAllowed || model.header.maximumMarks) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16, lineHeight: 1.24 }}>
          <span>{model.header.timeAllowed ? `Time: ${model.header.timeAllowed}` : ''}</span>
          <span>{model.header.maximumMarks ? `Maximum Marks: ${model.header.maximumMarks}` : ''}</span>
        </div>
      )}
      {model.instructions.length > 0 && (
        <>
          <p style={{ fontWeight: 700, marginTop: 16, lineHeight: 1.24 }}>{model.instructionsHeading || 'General Instructions :'}</p>
          {model.instructions.map((inst, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, lineHeight: 1.24 }}>
              <span style={{ width: 28, textAlign: 'right', flexShrink: 0 }}>{i + 1}.</span>
              <span>{inst}</span>
            </div>
          ))}
        </>
      )}

      {/* sections + questions — render the same model the app uses */}      {model.sections.map((sec) => (
        <div key={sec.label}>
          <div style={{ textAlign: 'center', fontWeight: 700, marginTop: 24, marginBottom: 4 }}>{sec.label}</div>
          {sec.questions.map((q) => (
            <PaperQuestionRow
              key={q.key}
              q={q}
              isModeB={isModeB}
              staled={staled}
              regenerateStaleSlot={regenerateStaleSlot}
              bannerText={staleBannerText(isModeB)}
            />
          ))}
        </div>
      ))}
      {(model.unsectionedQuestions || []).map((_q2) => (
        <PaperQuestionRow
          key={_q2.key}
          q={_q2}
          isModeB={isModeB}
          staled={staled}
          regenerateStaleSlot={regenerateStaleSlot}
          bannerText={staleBannerText(isModeB)}
        />
      ))}
    </div>
  );
}

/** One rendered question, with the stale banner + empty state when relevant. */
function PaperQuestionRow({ q, isModeB, staled, regenerateStaleSlot, bannerText }) {
  const isStale = isModeB && slotIsStale(staled, q);
  const hasGeneratedText = Boolean(q.text && q.text.trim().length > 0);

  return (
    <div style={{ display: 'flex', marginTop: 19, alignItems: 'flex-start' }}>
      {/* stale dot on the row */}
      {isStale && (
        <span
          className="mr-2 shrink-0"
          title="This question's structure has changed since generation"
        >
          <span
            className="inline-block h-2.5 w-2.5 rounded-full bg-amber-400 ring-2 ring-amber-200"
            aria-label="stale"
          />
        </span>
      )}

      <div style={{ flex: 1, textAlign: 'justify' }}>
        {/* stale banner, when relevant */}
        {isStale && (
          <div className="mb-2 flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-[12px] text-amber-800">
            <span className="shrink-0 mt-0.5">
              <AlertTriangleIcon size={14} className="text-amber-600" />
            </span>
            <div className="flex-1">
              <p className="font-medium">
                {bannerText}
              </p>
              <button
                type="button"
                onClick={() => regenerateStaleSlot(slotKey(q))}
                className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-amber-300 bg-white px-2 py-0.5 text-[11px] font-medium text-amber-700 hover:bg-amber-50"
              >
                <RefreshIcon size={11} />
                Regenerate
              </button>
            </div>
          </div>
        )}

        {/* empty state for a freshly added item that has no generated content */}
        {!hasGeneratedText && isStale && (
          <div className="mb-2 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2 text-[12px] text-gray-400">
            <span className="font-medium text-gray-500">Not generated yet</span>
            <span className="ml-1">— add content or regenerate.</span>
          </div>
        )}

        {/* the question itself */}
        <QuestionBody q={q} />
      </div>
    </div>
  );
}

/** Reuse the app's existing question renderer shape (no new rendering logic). */
function QuestionBody({ q }) {
  const parts = (q.subParts || [])
    .map((p) => (
      <div key={p.label} style={{ display: 'flex', gap: 6 }}>
        <span style={{ width: 24, flexShrink: 0 }}>{p.label}</span>
        <span>{p.text}</span>
      </div>
    ));
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-start' }}>
        <span style={{ width: 26, flexShrink: 0 }}>{q.numberText}</span>
        <span style={{ flex: 1, textAlign: 'justify' }}>{q.text}</span>
        {q.marksText && <span style={{ width: 42, textAlign: 'right', flexShrink: 0, marginLeft: 8 }}>{q.marksText}</span>}
      </div>
      {parts}
    </>
  );
}
