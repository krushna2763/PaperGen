/**
 * AnswerKeyScreen — review and correct the generated answer key for a stored
 * paper, then download it. Reached from "My Papers → View Answer Key".
 *
 * Left panel: the STUDENT-FACING paper, rendered from buildPaperModel (the same
 * model the PDF export uses). Answers must never appear here — see
 * client/test/paperHtml-no-answers.test.js.
 *
 * Right panel: the editable answer key — per item an answer field, a marks
 * input and, where a question is worth more than a mark, its marking scheme.
 * Edits are the answers generation produced and the teacher corrected here;
 * nothing is re-derived. Saving PATCHes the library record so a paper reopened
 * later keeps the corrections.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildPaperModel, paginatePaper } from '../services/paperLayout.js';
import { classLabel } from '../services/paperTemplate.js';
import { questionTypeLabel } from '../services/questionTypeLabel.js';
import { answersNeedingReview } from '../services/staleness.js';
import { slotKey } from './blueprintUnits.js';
import {
  FileLinesIcon,
  SaveIcon,
  DownloadIcon,
  CircleCheckSolid,
  ChevronDownIcon,
  ChevronRightIcon,
  ZoomInIcon,
  ZoomOutIcon,
  MaximizeIcon,
} from './ui/icons.jsx';

const ZOOMS = [75, 100, 125, 150];
const letter = (i) => String.fromCharCode(97 + i);
const serif = { fontFamily: '"Times New Roman", "Liberation Serif", Georgia, serif' };

function fmtStamp(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/* auto-growing textarea so a long answer wraps and the field grows to fit */
function AutoGrow({ value, onChange, className, placeholder }) {
  const ref = useRef(null);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(fit, [value]);
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value ?? ''}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onInput={fit}
      className={className}
    />
  );
}

/* ── left: student paper preview (from the shared model — no answers) ─────── */
function PaperPreview({ model, title, examLine, cls, subject, totalMarks, duration }) {
  return (
    <div style={{ ...serif, fontSize: 12.5, lineHeight: 1.7, color: '#111' }}>
      <div style={{ textAlign: 'center', fontWeight: 700 }}>
        {title && <p style={{ margin: 0, fontSize: 15 }}>{title}</p>}
        {examLine && <p style={{ margin: '2px 0 0', fontSize: 17 }}>{examLine}</p>}
      </div>
      <div style={{ borderTop: '1px solid #333', margin: '10px 0' }} />
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <div>
          <div>Class: {classLabel(cls) || cls}</div>
          <div>Subject: {subject}</div>
        </div>
        <div style={{ textAlign: 'left' }}>
          <div>Max. Marks: {totalMarks}</div>
          <div>Time: {duration || '—'}</div>
        </div>
      </div>

      {model?.sections?.map((sec) => (
        <div key={sec.label}>
          <div style={{ background: '#f1f3f5', padding: '6px 12px', margin: '18px 0 8px', display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
            <span>{sec.label}</span>
            <span>({sectionMarks(sec)} marks)</span>
          </div>
          {sec.questions.map((q) => <PreviewQ key={q.key} q={q} />)}
        </div>
      ))}
      {(model?.unsectionedQuestions || []).map((q) => <PreviewQ key={q.key} q={q} />)}
    </div>
  );
}

function PreviewQ({ q }) {
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <span style={{ minWidth: 26, fontWeight: 700 }}>{q.numberText}</span>
        <span style={{ flex: 1, fontWeight: 700 }}>{questionTypeLabel(q.type)}</span>
        {q.marks != null && <span style={{ minWidth: 30, textAlign: 'right' }}>({q.marks})</span>}
      </div>
      {q.text && <div style={{ margin: '2px 0 0 26px' }}>{q.text}</div>}
      {q.passage && (
        <div style={{ margin: '6px 0 6px 26px', padding: '6px 10px', background: '#f7f8fa', borderLeft: '2px solid #cbd5e1', textAlign: 'justify' }}>
          {q.passage}
        </div>
      )}
      {(q.subParts || []).map((p, i) => (
        <div key={p.label || i}>
          <div style={{ display: 'flex', gap: 6, margin: '3px 0 0 40px' }}>
            <span style={{ minWidth: 18 }}>{p.label || `${letter(i)})`}</span>
            <span style={{ flex: 1 }}>{p.text}</span>
          </div>
          {(p.options || []).map((opt, oi) => (
            <div key={oi} style={{ display: 'flex', gap: 6, margin: '1px 0 0 62px' }}>
              <span style={{ minWidth: 18 }}>{letter(oi)})</span>
              <span>{opt}</span>
            </div>
          ))}
        </div>
      ))}
      {(q.options || []).map((opt, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, margin: '2px 0 0 40px' }}>
          <span style={{ minWidth: 18 }}>{letter(i)})</span>
          <span>{opt}</span>
        </div>
      ))}
    </div>
  );
}

function sectionMarks(sec) {
  return sec.questions.reduce((a, q) => a + (Number(q.marks) || 0), 0);
}

/* ── screen ─────────────────────────────────────────────────────────────── */
export default function AnswerKeyScreen({ record, format = {}, onBack, onSave, onDownload, onRegenerateAnswer }) {
  const settings = useMemo(() => ({ class: record?.class, difficulty: 'Medium' }), [record]);
  const subject = record?.subject || '';
  const blueprint = record?.blueprint || null;

  const [qs, setQs] = useState(() => (Array.isArray(record?.questions) ? structuredClone(record.questions) : []));
  const [savedAt, setSavedAt] = useState(record?.updatedAt || null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // Slot index currently regenerating its answer (PHASE 6) — null when idle.
  const [regenBusy, setRegenBusy] = useState(null);

  const model = useMemo(
    () => (qs.length > 0 ? buildPaperModel({ questions: qs, blueprint, settings, subject, format }) : null),
    [qs, blueprint, settings, subject, format]
  );
  const pageCount = useMemo(() => Math.max(1, (model ? paginatePaper(model) : []).length), [model]);
  const [pageIndex, setPageIndex] = useState(0);
  const [zoom, setZoom] = useState(100);

  // Right panel: blueprint slots grouped by section, paired with their
  // generated question (by slotIndex) — the same grouping the review screen uses.
  const bySlot = useMemo(() => {
    const m = new Map();
    qs.forEach((q, i) => m.set(Number.isInteger(q?.slotIndex) ? q.slotIndex : i, { q, i }));
    return m;
  }, [qs]);

  const groups = useMemo(() => {
    const bpq = blueprint?.questions || [];
    const order = [];
    const map = new Map();
    bpq.forEach((bq, i) => {
      const name = bq.sectionName || bq.section || '';
      if (!map.has(name)) { map.set(name, []); order.push(name); }
      map.get(name).push({ bq, slotIdx: i });
    });
    return order.map((name) => {
      const rows = map.get(name);
      return {
        name,
        label: name
          ? (blueprint.sections || []).find((s) => (s.name || '') === name)?.label || name
          : 'Questions',
        marks: rows.reduce((a, r) => a + (Number(r.bq.totalMarks) || 0), 0),
        rows,
      };
    });
  }, [blueprint]);

  const [filter, setFilter] = useState('all');
  const [open, setOpen] = useState(() => new Set(groups.slice(0, 1).map((g) => g.name)));
  useEffect(() => { setOpen(new Set(groups.slice(0, 1).map((g) => g.name))); }, [groups]);

  const visibleGroups = groups.filter((g) => filter === 'all' || g.name === filter);

  /* ── edits ─────────────────────────────────────────── */
  const patchSlot = (slotIdx, patch) => {
    setQs((list) =>
      list.map((q, i) => {
        const idx = Number.isInteger(q?.slotIndex) ? q.slotIndex : i;
        return idx === slotIdx ? { ...q, ...patch } : q;
      })
    );
  };
  const patchItem = (slotIdx, itemIdx, field, value) => {
    const cur = bySlot.get(slotIdx)?.q;
    if (!cur) return;
    const subParts = (cur.subParts || []).map((sp, j) => (j === itemIdx ? { ...sp, [field]: value } : sp));
    patchSlot(slotIdx, { subParts });
  };
  // Only the marking-scheme POINT TEXT is editable here — its per-point marks,
  // like every other mark on this screen, are read-only (they belong to the
  // paper / keyMarks split, not to answer editing).
  const patchSchemePoint = (slotIdx, itemIdx, k, value) => {
    const cur = bySlot.get(slotIdx)?.q;
    if (!cur) return;
    if (itemIdx == null) {
      const markingScheme = (cur.markingScheme || []).map((m, j) => (j === k ? { ...m, point: value } : m));
      patchSlot(slotIdx, { markingScheme });
      return;
    }
    const subParts = (cur.subParts || []).map((sp, j) => {
      if (j !== itemIdx) return sp;
      const markingScheme = (sp.markingScheme || []).map((m, mi) => (mi === k ? { ...m, point: value } : m));
      return { ...sp, markingScheme };
    });
    patchSlot(slotIdx, { subParts });
  };
  // PHASE 6: INTERNAL_CHOICE branch answers — each OR branch keeps its own.
  const patchChoice = (slotIdx, choiceIdx, field, value) => {
    const cur = bySlot.get(slotIdx)?.q;
    if (!cur) return;
    const choices = (cur.choices || []).map((c, j) => (j === choiceIdx ? { ...c, [field]: value } : c));
    patchSlot(slotIdx, { choices });
  };
  // PHASE 6: MATCH pairing key — the left entry is fixed by the question; the
  // teacher edits which right entry it pairs with.
  const patchPair = (slotIdx, i, value) => {
    const cur = bySlot.get(slotIdx)?.q;
    if (!cur) return;
    const lefts = Array.isArray(cur.columns?.left) && cur.columns.left.length > 0
      ? cur.columns.left
      : (cur.answerPairs || []).map((p) => p.left);
    const pairs = (cur.answerPairs || []).slice();
    while (pairs.length < lefts.length) pairs.push({ left: lefts[pairs.length] ?? '', right: '' });
    pairs[i] = { left: lefts[i] ?? pairs[i]?.left ?? '', right: value };
    patchSlot(slotIdx, { answerPairs: pairs });
  };

  // PHASE 6 — answer-review set: slots whose STRUCTURE changed after their
  // answers were written (type / marks / item count / unit), computed from the
  // generate-time fingerprint saved with the paper. Empty (fail-open) for
  // papers that predate the snapshot. An answer EDIT alone never adds a slot.
  const reviewSet = useMemo(
    () => answersNeedingReview(record?.generatedFp ?? record?.generatedFingerprint ?? null, blueprint),
    [record, blueprint]
  );

  // PHASE 6: regenerate ONLY this question's answers through the server's
  // answer-only path. The question text cannot come back changed (the endpoint
  // never returns a replacement question); App merges the new answers onto the
  // current question object.
  const doRegenerateAnswer = async (slotIdx) => {
    if (regenBusy != null || !onRegenerateAnswer) return;
    setRegenBusy(slotIdx);
    setErr('');
    try {
      await onRegenerateAnswer({ slotIndex: slotIdx });
    } catch (e) {
      setErr(e?.response?.data?.message || e?.message || 'Could not regenerate the answer.');
    } finally {
      setRegenBusy(null);
    }
  };

  const save = async () => {
    if (busy) return;
    setBusy(true); setErr('');
    try {
      await onSave(qs);
      setSavedAt(new Date().toISOString());
    } catch (e) {
      setErr(e?.response?.data?.message || e?.message || 'Could not save the answer key.');
    } finally {
      setBusy(false);
    }
  };

  const title = format?.schoolName || model?.header?.titleLines?.[0]?.text || '';
  const examLine = [format?.examTitle, format?.session].filter(Boolean).join(' ') || record?.title || 'Question Paper';
  const totalMarks = record?.totalMarks ?? (blueprint?.questions || []).reduce((a, q) => a + (q.totalMarks || 0), 0);
  const duration = format?.timeAllowed || blueprint?.paper?.duration || '';

  const fieldCls =
    'w-full resize-none overflow-hidden rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-[12.5px] leading-snug text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500/40';

  // Paper-panel scroll: the whole paper is rendered; the pager just scrolls
  // through it, and the page index tracks the real scroll position against
  // paginatePaper's page count.
  const scrollRef = useRef(null);
  const scrollByPage = (dir) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ top: dir * el.clientHeight * 0.9, behavior: 'smooth' });
  };
  const onPaperScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const per = el.scrollHeight / pageCount;
    const idx = per > 0 ? Math.min(pageCount - 1, Math.round(el.scrollTop / per)) : 0;
    setPageIndex(idx);
  };

  return (
    <div>
      {/* back */}
      <button
        type="button"
        onClick={onBack}
        className="mb-3 inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-[12px] font-medium text-gray-600 hover:bg-gray-50"
      >
        <span aria-hidden className="text-[13px] leading-none">←</span> Back to Review
      </button>

      {/* header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-bold text-gray-900">Answer Key</h1>
          <p className="mt-1 text-[14px] text-gray-500">
            View and edit the answers for your question paper. You can modify any answer before downloading.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-[12px] font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            <SaveIcon size={14} />
            {busy ? 'Saving…' : 'Save Changes'}
          </button>
          <button
            type="button"
            onClick={() => onDownload?.(qs)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-[12px] font-semibold text-white hover:bg-blue-700"
          >
            <DownloadIcon size={14} />
            Download Answer Key
          </button>
        </div>
      </div>

      {/* summary bar */}
      <div className="mt-4 flex flex-wrap items-center gap-4 rounded-xl border border-gray-200 bg-white px-5 py-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
          <FileLinesIcon size={18} />
        </span>
        <div className="min-w-0">
          <p className="text-[14px] font-bold text-gray-900">{examLine}</p>
          <p className="text-[12px] text-gray-500">
            Class: <span className="font-medium text-gray-700">{classLabel(record?.class) || record?.class}</span> · Subject:{' '}
            <span className="font-medium text-gray-700">{subject}</span> · Total Marks:{' '}
            <span className="font-medium text-gray-700">{totalMarks}</span> · Duration:{' '}
            <span className="font-medium text-gray-700">{duration || '—'}</span>
          </p>
        </div>
        <div className="ml-auto text-right">
          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
            <CircleCheckSolid size={12} />
            Answer key (Editable)
          </span>
          <p className="mt-0.5 text-[11px] text-gray-400">You can edit any answer before downloading.</p>
          <p className="text-[11px] text-gray-400">Last updated {fmtStamp(savedAt)}</p>
        </div>
      </div>

      {err && <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-[12.5px] text-red-700">{err}</div>}

      {/* two panels */}
      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-2">
        {/* LEFT — paper preview */}
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
          <div className="flex items-center gap-1 border-b border-gray-100 px-3 py-2 text-gray-500">
            <button type="button" onClick={() => scrollByPage(-1)} disabled={pageIndex === 0} className="rounded p-1 hover:bg-gray-100 disabled:opacity-40">
              <ChevronDownIcon size={14} className="rotate-90" />
            </button>
            <button type="button" onClick={() => scrollByPage(1)} disabled={pageIndex >= pageCount - 1} className="rounded p-1 hover:bg-gray-100 disabled:opacity-40">
              <ChevronDownIcon size={14} className="-rotate-90" />
            </button>
            <span className="mx-1 text-[12px] tabular-nums">{pageIndex + 1} / {pageCount}</span>
            <span className="mx-1 h-4 w-px bg-gray-200" />
            <button type="button" onClick={() => setZoom((z) => ZOOMS[Math.max(0, ZOOMS.indexOf(z) - 1)] ?? 75)} className="rounded p-1 hover:bg-gray-100">
              <ZoomOutIcon size={14} />
            </button>
            <button type="button" onClick={() => setZoom((z) => ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(z) + 1)] ?? 150)} className="rounded p-1 hover:bg-gray-100">
              <ZoomInIcon size={14} />
            </button>
            <div className="relative">
              <select
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                className="h-7 appearance-none rounded-md border border-gray-300 bg-white pl-2 pr-6 text-[11.5px] text-gray-600 focus:outline-none"
              >
                {ZOOMS.map((z) => <option key={z} value={z}>{z}%</option>)}
              </select>
              <ChevronDownIcon size={11} className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400" />
            </div>
            <button type="button" onClick={() => onDownload?.(qs)} title="Download the answer key" className="ml-auto rounded p-1 hover:bg-gray-100">
              <MaximizeIcon size={14} />
            </button>
          </div>
          <div
            ref={scrollRef}
            onScroll={onPaperScroll}
            className="h-[calc(100vh-320px)] min-h-[440px] overflow-y-auto overflow-x-hidden bg-gray-100 p-6"
          >
            <div className="mx-auto max-w-[820px] bg-white p-8 shadow-sm" style={{ zoom: zoom / 100 }}>
              <PaperPreview
                model={model}
                title={title}
                examLine={examLine}
                cls={record?.class}
                subject={subject}
                totalMarks={totalMarks}
                duration={duration}
              />
            </div>
          </div>
        </div>

        {/* RIGHT — editable answer key */}
        <div className="flex flex-col overflow-hidden rounded-xl border border-gray-200 bg-white">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
            <span className="text-[13px] font-semibold text-gray-900">Answer Key (Editable)</span>
            <div className="relative">
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="h-7 appearance-none rounded-md border border-gray-300 bg-white pl-2 pr-6 text-[11.5px] text-gray-600 focus:outline-none"
              >
                <option value="all">All Sections</option>
                {groups.filter((g) => g.name).map((g) => (
                  <option key={g.name} value={g.name}>{g.label}</option>
                ))}
              </select>
              <ChevronDownIcon size={11} className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400" />
            </div>
          </div>

          <div className="max-h-[720px] flex-1 overflow-y-auto">
            {visibleGroups.map((g) => {
              const isOpen = open.has(g.name);
              return (
                <div key={g.name || 'nosec'} className="border-b border-gray-100 last:border-0">
                  <button
                    type="button"
                    onClick={() => setOpen((s) => { const n = new Set(s); n.has(g.name) ? n.delete(g.name) : n.add(g.name); return n; })}
                    className="flex w-full items-center justify-between bg-gray-50 px-4 py-2.5 text-left hover:bg-gray-100"
                  >
                    <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-gray-800">
                      {isOpen ? <ChevronDownIcon size={13} className="text-gray-400" /> : <ChevronRightIcon size={13} className="text-gray-400" />}
                      {g.label}
                    </span>
                    <span className="text-[12px] font-medium text-gray-500">({g.marks} marks)</span>
                  </button>

                  {isOpen && (
                    <div className="divide-y divide-gray-100">
                      {g.rows.map(({ bq, slotIdx }) => {
                        const q = bySlot.get(slotIdx)?.q;
                        if (!q) return null;
                        const items = Array.isArray(q.subParts) && q.subParts.length > 0 ? q.subParts : null;
                        const no = `Q${String(bq.label || bq.number || slotIdx + 1).replace(/^Q/i, '')}`;
                        const qKey = slotKey(bq, slotIdx);
                        const needsReview = reviewSet.includes(qKey);
                        return (
                          <div key={qKey} className="px-4 py-3">
                            <div className="mb-2 flex items-center justify-between">
                              <span className="text-[12.5px] font-semibold text-gray-900">
                                {no}.{' '}
                                <span className="font-medium text-gray-600">{questionTypeLabel(bq.type || q.type)}</span>
                              </span>
                              <span className="flex items-center gap-2">
                                {needsReview && (
                                  <span
                                    className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10.5px] font-medium text-amber-700"
                                    title="The question changed after this answer was written."
                                  >
                                    Question changed — review this answer
                                  </span>
                                )}
                                <span className="text-[12px] font-medium text-gray-500">({bq.totalMarks ?? q.marks ?? '—'})</span>
                              </span>
                            </div>
                            {needsReview && (
                              <p className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11.5px] text-amber-700">
                                Structure changed. Review this answer, edit it, or regenerate it.
                              </p>
                            )}
                            {onRegenerateAnswer && (
                              <div className="mb-2">
                                <button
                                  type="button"
                                  onClick={() => doRegenerateAnswer(slotIdx)}
                                  disabled={regenBusy != null}
                                  className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-[11px] font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                                >
                                  {regenBusy === slotIdx ? 'Regenerating…' : 'Regenerate answer'}
                                </button>
                              </div>
                            )}

                            {items ? (
                              <div className="space-y-2.5">
                                {items.map((sp, i) => (
                                  <AnswerRow
                                    key={i}
                                    lbl={`${letter(i)})`}
                                    stored={sp.answer}
                                    onText={(v) => patchItem(slotIdx, i, 'answer', v)}
                                    marks={sp.marks}
                                    scheme={sp.markingScheme}
                                    onSchemePoint={(k, v) => patchSchemePoint(slotIdx, i, k, v)}
                                    fieldCls={fieldCls}
                                  />
                                ))}
                              </div>
                            ) : (q.columns || (Array.isArray(q.answerPairs) && q.answerPairs.length > 0)) ? (
                              <div className="space-y-1.5">
                                {(q.columns?.left?.length ? q.columns.left : (q.answerPairs || []).map((p) => p.left)).map((leftText, i) => (
                                  <div key={i} className="flex items-center gap-2">
                                    <span className="w-5 shrink-0 text-[12px] text-gray-500">{letter(i)})</span>
                                    <span className="flex-1 truncate text-[12px] text-gray-700" title={leftText}>{leftText || '—'}</span>
                                    <span className="text-gray-400">→</span>
                                    <input
                                      value={q.answerPairs?.[i]?.right ?? ''}
                                      onChange={(e) => patchPair(slotIdx, i, e.target.value)}
                                      placeholder="matched item"
                                      className="h-7 flex-1 rounded-md border border-gray-300 bg-white px-2 text-[12px] text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                                    />
                                  </div>
                                ))}
                              </div>
                            ) : Array.isArray(q.choices) && q.choices.length > 0 ? (
                              <div className="space-y-2">
                                {q.choices.map((c, ci) => (
                                  <div key={ci}>
                                    <p className="mb-1 text-[11.5px] font-medium text-gray-600">
                                      {c.label || `Branch ${ci + 1}`}. {c.text}
                                      {ci < q.choices.length - 1 && <span className="ml-2 italic text-gray-400">OR</span>}
                                    </p>
                                    <AnswerRow
                                      lbl=""
                                      stored={c.answer}
                                      onText={(v) => patchChoice(slotIdx, ci, 'answer', v)}
                                      marks={null}
                                      scheme={null}
                                      onSchemePoint={() => {}}
                                      fieldCls={fieldCls}
                                    />
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <AnswerRow
                                lbl=""
                                stored={q.answer}
                                onText={(v) => patchSlot(slotIdx, { answer: v })}
                                marks={bq.totalMarks ?? q.marks}
                                scheme={q.markingScheme}
                                onSchemePoint={(k, v) => patchSchemePoint(slotIdx, null, k, v)}
                                fieldCls={fieldCls}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
            {visibleGroups.length === 0 && (
              <p className="px-4 py-10 text-center text-[12.5px] text-gray-400">No questions in this section.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function AnswerRow({ lbl, stored, onText, marks, scheme, onSchemePoint, fieldCls }) {
  const hasStored = String(stored ?? '').trim().length > 0;
  const marksText = Number.isFinite(Number(marks)) && Number(marks) > 0
    ? `${Number(marks)} mark${Number(marks) === 1 ? '' : 's'}`
    : '—';
  return (
    <div>
      <div className="flex items-start gap-2">
        {lbl && <span className="mt-1.5 w-5 shrink-0 text-[12px] text-gray-500">{lbl}</span>}
        {hasStored ? (
          <AutoGrow value={stored} onChange={onText} className={fieldCls} placeholder="Answer" />
        ) : (
          <span className="mt-1 flex-1 text-[12px] italic text-gray-400" title="This paper predates the answer key — regenerate it to get answers.">
            No answer stored
          </span>
        )}
        {/* marks are read-only here — the teacher edits answers, nothing else */}
        <span className="mt-1.5 shrink-0 text-[12px] tabular-nums text-gray-500">{marksText}</span>
      </div>
      {Array.isArray(scheme) && scheme.length > 0 && (
        <div className={`mt-1.5 space-y-1 ${lbl ? 'ml-7' : ''}`}>
          <p className="text-[10.5px] font-medium uppercase tracking-wide text-gray-400">Marking scheme</p>
          {scheme.map((m, k) => (
            <div key={k} className="flex items-center gap-2">
              <span className="text-gray-300">•</span>
              <input
                value={m.point ?? ''}
                onChange={(e) => onSchemePoint(k, e.target.value)}
                className="h-7 flex-1 rounded-md border border-gray-200 bg-white px-2 text-[11.5px] text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              />
              {Number.isFinite(Number(m.marks)) && Number(m.marks) > 0 && (
                <span className="w-8 shrink-0 text-center text-[11px] tabular-nums text-gray-400">({Number(m.marks)})</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
