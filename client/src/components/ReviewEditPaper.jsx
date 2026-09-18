/**
 * ReviewEditPaper — Mode A review-and-edit screen, reached after generation.
 *
 * Three panels: the question list (grouped by the reference paper's sections),
 * a per-question editor, and a live serif preview of the student-facing paper.
 *
 * WHAT A TEACHER MAY CHANGE: a question's wording, its item wording, its
 * difficulty, and which syllabus unit it draws from. That is all.
 *
 * WHAT IS LOCKED (it comes from the uploaded reference paper and is what makes
 * the generated paper match it): question type, total marks, per-item marks,
 * item count, option count, section, and question number. Every locked value is
 * shown read-only on a gray fill with a padlock — never as an input.
 *
 * The preview reuses buildPaperModel / paginatePaper, the same path the pdfmake
 * export uses, so what you see is what downloads. Regenerating one question goes
 * through the Phase 5 single-slot endpoint (only that slot is retrieved for,
 * generated and validated — every other question, including teacher edits,
 * stays untouched); Regenerate All re-runs the whole paper via the App handlers.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildPaperModel, paginatePaper } from '../services/paperLayout.js';
import { slotKey } from './blueprintUnits.js';
import { questionTypeLabel } from '../services/questionTypeLabel.js';
import {
  FileLinesIcon,
  LockIcon,
  ChevronDownIcon,
  RefreshIcon,
  SaveIcon,
  DownloadIcon,
  EyeIcon,
  CircleCheckSolid,
  BoldIcon,
  ItalicIcon,
  UnderlineIcon,
  ListIcon,
  ListOrderedIcon,
  LinkIcon,
  ZoomInIcon,
  ZoomOutIcon,
  MaximizeIcon,
  LightbulbIcon,
  ArrowRightIcon,
  InfoIcon,
  XIcon,
} from './ui/icons.jsx';

const DIFFICULTY_OPTIONS = ['Easy', 'Medium', 'Difficult'];
const NOTE_MAX = 500;

const letter = (i) => String.fromCharCode(97 + i);

function LockedValue({ label, value }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-medium text-gray-500">{label}</p>
      <div className="flex h-9 items-center justify-between rounded-md border border-gray-200 bg-gray-50 px-2.5">
        <span className="truncate text-[12.5px] text-gray-700">{value}</span>
        <LockIcon size={12} className="shrink-0 text-gray-400" />
      </div>
    </div>
  );
}

/* ── left: question list ────────────────────────────────────── */
function QuestionList({ groups, selectedIdx, onSelect, filter, onFilter }) {
  const sectionNames = groups.map((g) => g.name).filter(Boolean);
  return (
    <div className="flex w-[280px] shrink-0 flex-col rounded-xl border border-gray-200 bg-white">
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
        <span className="text-[13px] font-semibold text-gray-900">Questions</span>
        <div className="relative">
          <select
            value={filter}
            onChange={(e) => onFilter(e.target.value)}
            className="h-7 appearance-none rounded-md border border-gray-300 bg-white pl-2 pr-6 text-[11.5px] text-gray-600 focus:outline-none"
          >
            <option value="all">All sections</option>
            {sectionNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <ChevronDownIcon size={12} className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400" />
        </div>
      </div>

      <div className="max-h-[640px] overflow-y-auto py-1">
        {groups.map((g) => (
          <div key={g.name || 'nosec'} className="py-1">
            <div className="flex items-center justify-between px-4 py-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{g.name || 'Questions'}</span>
              <span className="text-[11px] text-gray-400">{g.marks} marks</span>
            </div>
            {g.rows.map((r) => {
              const active = r.idx === selectedIdx;
              return (
                <button
                  key={r.idx}
                  type="button"
                  onClick={() => onSelect(r.idx)}
                  className={`flex w-full items-center gap-2 border-l-2 px-4 py-2 text-left transition-colors ${
                    active ? 'border-blue-600 bg-blue-50' : 'border-transparent hover:bg-gray-50'
                  }`}
                >
                  <span className={`w-7 shrink-0 text-[12px] font-semibold ${active ? 'text-blue-700' : 'text-gray-700'}`}>
                    {r.no}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-gray-600">{r.typeLabel}</span>
                  {r.unit && (
                    <span
                      className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10.5px] font-medium text-gray-500"
                      title={`This question was generated from ${r.unit}`}
                    >
                      {r.unit}
                    </span>
                  )}
                  <span className="shrink-0 text-[11.5px] text-gray-400">({r.marks})</span>
                  {r.flagged && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" title="Unit changed — regenerate" />}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── middle: editor ────────────────────────────────────────── */
function Editor({
  q,
  slot,
  breadcrumb,
  units,
  unitId,
  onUnitChange,
  topic,
  coverage,
  onTopicClear,
  flagged,
  onRegenerateOne,
  regenBusy,
  onText,
  onItemText,
  onItemAnswer,
  onAnswerField,
  images,
  onAddImage,
  onRemoveImage,
  note,
  onNote,
  onNext,
}) {
  const subParts = Array.isArray(q?.subParts) ? q.subParts : [];
  const itemCount = subParts.length || slot?.itemCount || 1;
  const taRef = useRef(null);

  const wrap = (pre, post = pre) => {
    const ta = taRef.current;
    if (!ta) return;
    const { selectionStart: s, selectionEnd: e, value } = ta;
    const next = value.slice(0, s) + pre + value.slice(s, e) + post + value.slice(e);
    onText(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(s + pre.length, e + pre.length);
    });
  };

  return (
    <div className="min-w-0 flex-1 rounded-xl border border-gray-200 bg-white">
      <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3">
        <span className="text-[13px] font-semibold text-gray-900">Edit question</span>
        <span className="text-[11.5px] text-gray-400">{breadcrumb}</span>
      </div>

      <div className="space-y-4 p-5">
        {/* locked structure row */}
        <div>
          <div className="grid grid-cols-3 gap-3">
            <LockedValue label="Question type" value={questionTypeLabel(slot?.type || q?.type)} />
            <LockedValue label="Marks" value={String(slot?.totalMarks ?? q?.marks ?? '—')} />
            <LockedValue label="Items" value={String(itemCount)} />
          </div>
          <p className="mt-1.5 text-[11px] text-gray-400">Structure comes from the reference paper.</p>
        </div>

        {/* editable controls */}
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-gray-600">Difficulty</span>
              <div className="relative">
                <select
                  value={DIFFICULTY_OPTIONS.includes(q?.difficulty) ? q.difficulty : 'Medium'}
                  onChange={(e) => onText(undefined, { difficulty: e.target.value })}
                  className="h-9 w-full appearance-none rounded-md border border-gray-300 bg-white pl-2.5 pr-7 text-[12.5px] text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                >
                  {DIFFICULTY_OPTIONS.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
                <ChevronDownIcon size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-400" />
              </div>
            </label>

            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-gray-600">Unit</span>
              <div className="relative">
                <select
                  value={unitId == null ? '' : String(unitId)}
                  onChange={(e) => onUnitChange(e.target.value || null)}
                  disabled={units.length === 0}
                  className="h-9 w-full appearance-none rounded-md border border-gray-300 bg-white pl-2.5 pr-7 text-[12.5px] text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500/40 disabled:bg-gray-50 disabled:text-gray-400"
                >
                  {unitId == null && <option value="">Choose unit…</option>}
                  {units.map((u) => (
                    <option key={u.id} value={String(u.id)}>
                      {u.label}
                    </option>
                  ))}
                  {/* The question's assigned unit must always be VISIBLE, even
                      when the units list hasn't loaded (or was fetched for a
                      different class/subject) — otherwise the select renders
                      blank and the teacher can't tell what generated it. */}
                  {unitId != null && !units.some((u) => String(u.id) === String(unitId)) && (
                    <option value={String(unitId)}>{String(unitId)}</option>
                  )}
                </select>
                <ChevronDownIcon size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-400" />
              </div>
            </label>
          </div>

          <div>
            <span className="mb-1 block text-[11px] font-medium text-gray-600">Topic</span>
            <div className="flex h-9 items-center gap-2 rounded-md border border-gray-300 bg-white px-2">
              {topic ? (
                <span className="inline-flex min-w-0 items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5 text-[11.5px] text-gray-700">
                  <span className="max-w-[240px] truncate" title={topic}>
                    {topic}
                  </span>
                  <button type="button" onClick={onTopicClear} aria-label="Clear topic" className="shrink-0 text-gray-400 hover:text-gray-600">
                    <XIcon size={11} />
                  </button>
                </span>
              ) : (
                <span className="text-[11.5px] text-gray-400">No topic set</span>
              )}
              {coverage && (
                <span
                  className={`ml-auto shrink-0 whitespace-nowrap text-[10.5px] font-medium ${coverage.matched ? 'text-emerald-600' : 'text-amber-600'}`}
                  title="Coverage of this topic in the selected unit's notes"
                >
                  {coverage.matched ? `${coverage.chunkCount} chunks found` : 'no matching notes'}
                </span>
              )}
            </div>
          </div>
        </div>

        {flagged && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
            <InfoIcon size={14} className="mt-0.5 shrink-0 text-amber-600" />
            <div className="flex-1">
              <p className="font-medium">Unit changed — the content is still from the old unit.</p>
              <button
                type="button"
                onClick={onRegenerateOne}
                disabled={!!regenBusy}
                className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-amber-300 bg-white px-2 py-0.5 text-[11px] font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-50"
              >
                <RefreshIcon size={11} />
                {regenBusy ? 'Regenerating…' : 'Regenerate to use the new unit'}
              </button>
            </div>
          </div>
        )}

        {/* question text */}
        <div>
          <p className="mb-1 text-[11px] font-medium text-gray-600">Question text</p>
          <div className="rounded-lg border border-gray-300">
            <div className="flex items-center gap-0.5 border-b border-gray-200 px-1.5 py-1 text-gray-500">
              {[
                [BoldIcon, () => wrap('**')],
                [ItalicIcon, () => wrap('_')],
                [UnderlineIcon, () => wrap('<u>', '</u>')],
                [ListIcon, () => wrap('\n- ', '')],
                [ListOrderedIcon, () => wrap('\n1. ', '')],
                [LinkIcon, () => wrap('[', '](url)')],
              ].map(([Ic, fn], i) => (
                <button key={i} type="button" onClick={fn} className="rounded p-1 hover:bg-gray-100 hover:text-gray-800">
                  <Ic size={14} />
                </button>
              ))}
            </div>
            <textarea
              ref={taRef}
              rows={5}
              value={q?.text ?? ''}
              onChange={(e) => onText(e.target.value)}
              className="w-full resize-y rounded-b-lg px-3 py-2 text-[12.5px] leading-relaxed text-gray-800 focus:outline-none"
            />
          </div>
        </div>

        {/* figures — teacher-supplied images for this question (Phase 4) */}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-[11px] font-medium text-gray-600">Figures</p>
            <label className="cursor-pointer text-[11px] font-medium text-blue-600 hover:text-blue-700">
              + Add image
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onAddImage(f);
                  e.target.value = '';
                }}
              />
            </label>
          </div>
          {(images || []).length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {images.map((im, i) => (
                <div key={i} className="relative">
                  <img src={im.dataUri} alt={im.alt || ''} className="h-20 w-auto rounded border border-gray-200" />
                  <button
                    type="button"
                    onClick={() => onRemoveImage(i)}
                    className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-gray-700 text-[10px] leading-none text-white"
                    aria-label="Remove image"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-gray-400">No images. Add a diagram or figure to print with this question.</p>
          )}
        </div>

        {/* items */}
        {subParts.length > 0 ? (
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <p className="text-[11px] font-medium text-gray-600">Items</p>
              <span className="text-[11px] text-gray-400">{subParts.length} items</span>
            </div>
            <div className="space-y-2">
              {subParts.map((sp, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-gray-100 text-[11.5px] font-medium text-gray-600">
                    {letter(i)}
                  </span>
                  <input
                    value={sp.text ?? ''}
                    onChange={(e) => onItemText(i, e.target.value)}
                    className="h-9 flex-1 rounded-md border border-gray-300 px-2.5 text-[12.5px] text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                  />
                  <span className="flex h-9 w-10 shrink-0 items-center justify-center rounded-md border border-gray-200 bg-gray-50 text-[12px] text-gray-600">
                    {sp.marks ?? '—'}
                  </span>
                  <span className="shrink-0 text-[11.5px] text-gray-400">mark</span>
                  <LockIcon size={11} className="shrink-0 text-gray-300" />
                </div>
              ))}
            </div>
            <p className="mt-1.5 text-[10.5px] text-gray-400">Item count and per-item marks come from the reference paper.</p>
          </div>
        ) : (
          <p className="rounded-md bg-gray-50 px-3 py-2 text-[11.5px] text-gray-400">Single-part question — no separate items.</p>
        )}

        {/* answer key — visible + editable, NEVER printed on the student paper */}
        <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3">
          <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700">
            Answer key <span className="font-normal normal-case text-amber-600">· does not print on the paper</span>
          </p>
          {subParts.length > 0 ? (
            <div className="space-y-2">
              {subParts.map((sp, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="mt-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded bg-amber-100 text-[11px] font-medium text-amber-700">
                    {letter(i)}
                  </span>
                  <div className="flex-1 space-y-1">
                    <input
                      value={sp.answer ?? ''}
                      placeholder="Answer for this item"
                      onChange={(e) => onItemAnswer(i, 'answer', e.target.value)}
                      className="h-8 w-full rounded-md border border-amber-300 bg-white px-2.5 text-[12.5px] text-gray-800 focus:outline-none focus:ring-2 focus:ring-amber-400/40"
                    />
                    <input
                      value={sp.rationale ?? ''}
                      placeholder="Why (optional)"
                      onChange={(e) => onItemAnswer(i, 'rationale', e.target.value)}
                      className="h-7 w-full rounded-md border border-amber-200 bg-white px-2.5 text-[11.5px] italic text-gray-600 focus:outline-none focus:ring-2 focus:ring-amber-400/40"
                    />
                    {Array.isArray(sp.markingScheme) && sp.markingScheme.length > 0 && (
                      <ul className="ml-1 list-disc pl-4 text-[11px] text-gray-500">
                        {sp.markingScheme.map((m, k) => (
                          <li key={k}>{m.point}{m.marks ? ` (${m.marks})` : ''}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-1.5">
              <textarea
                rows={3}
                value={q?.answer ?? ''}
                placeholder="Model answer"
                onChange={(e) => onAnswerField('answer', e.target.value)}
                className="w-full resize-y rounded-md border border-amber-300 bg-white px-2.5 py-1.5 text-[12.5px] leading-relaxed text-gray-800 focus:outline-none focus:ring-2 focus:ring-amber-400/40"
              />
              <input
                value={q?.rationale ?? ''}
                placeholder="Why (optional)"
                onChange={(e) => onAnswerField('rationale', e.target.value)}
                className="h-7 w-full rounded-md border border-amber-200 bg-white px-2.5 text-[11.5px] italic text-gray-600 focus:outline-none focus:ring-2 focus:ring-amber-400/40"
              />
              {Array.isArray(q?.markingScheme) && q.markingScheme.length > 0 && (
                <div>
                  <p className="mt-1 text-[10.5px] font-medium text-amber-700">Marking scheme</p>
                  <ul className="ml-1 list-disc pl-4 text-[11px] text-gray-500">
                    {q.markingScheme.map((m, k) => (
                      <li key={k}>{m.point}{m.marks ? ` (${m.marks})` : ''}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        {/* teacher notes */}
        <div>
          <p className="mb-1 text-[11px] font-medium text-gray-600">Teacher notes (optional)</p>
          <textarea
            rows={3}
            maxLength={NOTE_MAX}
            value={note}
            onChange={(e) => onNote(e.target.value)}
            placeholder="Add any notes about this question..."
            className="w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-[12.5px] text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
          />
          <div className="mt-1 flex items-center justify-between">
            <span className="flex items-center gap-1 text-[10.5px] text-gray-400">
              <InfoIcon size={11} />
              These notes are private and will never appear on the printed paper.
            </span>
            <span className="text-[10.5px] text-gray-400">
              {note.length}/{NOTE_MAX}
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-gray-100 px-5 py-3">
        <button
          type="button"
          onClick={onRegenerateOne}
          disabled={!!regenBusy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-[12px] font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshIcon size={13} />
          {regenBusy === 'one' ? 'Regenerating…' : 'Regenerate this question'}
        </button>
        <button
          type="button"
          onClick={onNext}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-[12px] font-semibold text-white hover:bg-blue-700"
        >
          Next question
          <ArrowRightIcon size={13} />
        </button>
      </div>
    </div>
  );
}

/* ── right: preview ────────────────────────────────────────── */
const serif = { fontFamily: '"Times New Roman", "Liberation Serif", Georgia, serif' };

function PaperPage({ model }) {
  if (!model) return null;
  return (
    <div style={{ ...serif, fontSize: 12, lineHeight: 1.7, color: '#111' }}>
      <div style={{ textAlign: 'center', fontWeight: 700, lineHeight: 1.3 }}>
        {model.header.titleLines.map((l, i) => (
          <p key={i} style={{ margin: 0 }}>
            {l.text}
          </p>
        ))}
      </div>
      <div style={{ borderTop: '1px solid #333', margin: '10px 0' }} />
      {(model.header.timeAllowed || model.header.maximumMarks) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
          <span>{model.header.timeAllowed ? `Time: ${model.header.timeAllowed}` : ''}</span>
          <span>{model.header.maximumMarks ? `Maximum Marks: ${model.header.maximumMarks}` : ''}</span>
        </div>
      )}
      {model.instructions.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <p style={{ fontWeight: 700, margin: '0 0 2px' }}>{model.instructionsHeading || 'General Instructions :'}</p>
          {model.instructions.map((inst, i) => (
            <div key={i} style={{ display: 'flex', gap: 6 }}>
              <span style={{ minWidth: 20, textAlign: 'right' }}>{i + 1}.</span>
              <span>{inst}</span>
            </div>
          ))}
        </div>
      )}

      {model.sections.map((sec) => (
        <div key={sec.label}>
          <div style={{ textAlign: 'center', fontWeight: 700, marginTop: 18, marginBottom: 6 }}>{sec.label}</div>
          {sec.questions.map((q) => (
            <PreviewQuestion key={q.key} q={q} />
          ))}
        </div>
      ))}
      {(model.unsectionedQuestions || []).map((q) => (
        <PreviewQuestion key={q.key} q={q} />
      ))}
    </div>
  );
}

function PreviewQuestion({ q }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <span style={{ minWidth: 22 }}>{q.numberText}</span>
        <span style={{ flex: 1, textAlign: 'justify', fontWeight: q.subParts?.length ? 600 : 400 }}>{q.text}</span>
        {q.marksText && <span style={{ minWidth: 32, textAlign: 'right' }}>{q.marksText}</span>}
      </div>
      {q.passage && (
        <div style={{ margin: '6px 0 6px 22px', padding: '6px 10px', background: '#f5f7fa', borderLeft: '2px solid #cbd5e1', textAlign: 'justify' }}>
          {q.passage}
        </div>
      )}
      {(q.subParts || []).map((p) => (
        <div key={p.label} style={{ display: 'flex', gap: 6, marginLeft: 22, marginTop: 2 }}>
          <span style={{ minWidth: 18 }}>{p.label}</span>
          <span style={{ flex: 1, textAlign: 'justify' }}>{p.text}</span>
          {p.marksText && <span style={{ minWidth: 28, textAlign: 'right' }}>{p.marksText}</span>}
        </div>
      ))}
    </div>
  );
}

/* ── screen ────────────────────────────────────────────────── */
export default function ReviewEditPaper({
  result,
  blueprint,
  settings,
  subject,
  format,
  units = [],
  slotUnitMap,
  onResultChange,
  onRegenerateAll,
  onRegenerateOne,
  onDownloadPdf,
  onDownloadAnswerKey,
  onOpenFull,
  onCheckCoverage,
  onSave,
}) {
  const questions = useMemo(() => (Array.isArray(result?.questions) ? result.questions : []), [result]);
  const bpQuestions = useMemo(() => blueprint?.questions || [], [blueprint]);

  const bySlot = useMemo(() => {
    const m = new Map();
    questions.forEach((q, i) => m.set(Number.isInteger(q?.slotIndex) ? q.slotIndex : i, q));
    return m;
  }, [questions]);

  const [selectedIdx, setSelectedIdx] = useState(0);
  const [filter, setFilter] = useState('all');
  const [notes, setNotes] = useState({});
  const [unitBySlot, setUnitBySlot] = useState({});
  const [flagged, setFlagged] = useState(() => new Set());
  const [tab, setTab] = useState('live');
  const [pageIndex, setPageIndex] = useState(0);
  const [zoom, setZoom] = useState(100);
  const [lastSaved, setLastSaved] = useState(null);
  const [regenBusy, setRegenBusy] = useState(null); // 'one' | 'all' | null
  const [coverage, setCoverage] = useState({});
  const [err, setErr] = useState('');

  // Seed unit-by-slot from the map used at generate time.
  useEffect(() => {
    const seed = {};
    for (const [k, v] of Object.entries(slotUnitMap || {})) {
      if (v && v.unit != null) seed[k] = v.unit;
    }
    setUnitBySlot(seed);
  }, [slotUnitMap]);

  const model = useMemo(
    () =>
      questions.length > 0
        ? buildPaperModel({ questions, blueprint, settings, subject, format })
        : null,
    [questions, blueprint, settings, subject, format]
  );
  const pages = useMemo(() => (model ? paginatePaper(model) : []), [model]);
  const pageCount = Math.max(1, pages.length);

  // Question list grouped by section (structure = the blueprint).
  const groups = useMemo(() => {
    const order = [];
    const map = new Map();
    bpQuestions.forEach((bq, i) => {
      const name = bq.sectionName || bq.section || '';
      if (!map.has(name)) {
        map.set(name, []);
        order.push(name);
      }
      const gen = bySlot.get(i);
      const marks = bq.totalMarks ?? gen?.marks ?? 0;
      const unitId = unitBySlot[slotKey(bq, i)] ?? null;
      map.get(name).push({
        idx: i,
        no: `Q${bq.label || bq.number || i + 1}`.replace(/^QQ/, 'Q'),
        typeLabel: questionTypeLabel(bq.type || gen?.type),
        marks,
        flagged: flagged.has(slotKey(bq, i)),
        // Which unit this question was generated from — raw id when the units
        // list hasn't loaded, so the mapping is never invisible.
        unit: unitId != null ? (units.find((u) => String(u.id) === String(unitId))?.label ?? String(unitId)) : null,
      });
    });
    return order
      .map((name) => ({
        name,
        rows: map.get(name),
        marks: map.get(name).reduce((a, r) => a + (Number(r.marks) || 0), 0),
      }))
      .filter((g) => filter === 'all' || g.name === filter);
  }, [bpQuestions, bySlot, flagged, filter, unitBySlot, units]);

  const slot = bpQuestions[selectedIdx] || null;
  const selKey = slot ? slotKey(slot, selectedIdx) : `Q${selectedIdx + 1}`;
  const q = bySlot.get(selectedIdx) || null;
  const qId = q?.questionId || selKey;
  const topic = slot?.referenceItems?.[0] || slot?.topic || null;

  // Topic coverage against the selected unit's notes (advisory).
  useEffect(() => {
    const unitId = unitBySlot[selKey];
    const unit = units.find((u) => String(u.id) === String(unitId));
    if (!topic || !unit || !onCheckCoverage) {
      setCoverage((c) => ({ ...c, [selKey]: null }));
      return;
    }
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const res = await onCheckCoverage({ unit: unit.label, topic });
        if (alive) setCoverage((c) => ({ ...c, [selKey]: res?.data || res || null }));
      } catch {
        if (alive) setCoverage((c) => ({ ...c, [selKey]: null }));
      }
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [selKey, topic, unitBySlot, units, onCheckCoverage]);

  const patchQuestion = (patch) => {
    const next = {
      ...result,
      questions: questions.map((qq, i) => {
        const idx = Number.isInteger(qq?.slotIndex) ? qq.slotIndex : i;
        return idx === selectedIdx ? { ...qq, ...patch } : qq;
      }),
    };
    onResultChange(next);
  };
  const onText = (value, extra) => {
    const patch = { ...(extra || {}) };
    if (typeof value === 'string') patch.text = value;
    patchQuestion(patch);
  };
  const onItemText = (i, value) => {
    if (!q) return;
    const subParts = (q.subParts || []).map((sp, j) => (j === i ? { ...sp, text: value } : sp));
    patchQuestion({ subParts });
  };
  // Answer-key edits — the teacher can correct a wrong answer without
  // regenerating. These fields never print on the student paper.
  const onItemAnswer = (i, field, value) => {
    if (!q) return;
    const subParts = (q.subParts || []).map((sp, j) => (j === i ? { ...sp, [field]: value } : sp));
    patchQuestion({ subParts });
  };
  const onAnswerField = (field, value) => patchQuestion({ [field]: value });

  // Figures (Phase 4): teacher-attached image pixels for this question. Stored
  // on `assetImages` and persisted with the paper; the renderers place them
  // between the stem and the sub-parts. Nothing is auto-extracted.
  const onAddImage = (file) => {
    if (!q || !file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUri = String(reader.result || '');
      if (!/^data:image\/(png|jpe?g|webp|gif);base64,/.test(dataUri)) return;
      patchQuestion({ assetImages: [...(q.assetImages || []), { dataUri, alt: file.name || '', itemLabel: null }] });
    };
    reader.readAsDataURL(file);
  };
  const onRemoveImage = (idx) => {
    if (!q) return;
    patchQuestion({ assetImages: (q.assetImages || []).filter((_, i) => i !== idx) });
  };

  const onUnitChange = (unitId) => {
    setUnitBySlot((m) => ({ ...m, [selKey]: unitId }));
    setFlagged((s) => {
      const n = new Set(s);
      n.add(selKey);
      return n;
    });
  };
  const onTopicClear = () => {
    // Topic is a retrieval anchor from the reference slot; clearing it only
    // affects the NEXT regenerate. Reflect it in the blueprint slot in place.
    if (slot) slot.referenceItems = [];
    setCoverage((c) => ({ ...c, [selKey]: null }));
    setFlagged((s) => new Set(s).add(selKey));
  };

  const doRegenerateOne = async () => {
    if (regenBusy) return;
    setRegenBusy('one');
    setErr('');
    try {
      await onRegenerateOne(selKey, unitBySlot[selKey] ?? null, notes[qId] || undefined);
      setFlagged((s) => {
        const n = new Set(s);
        n.delete(selKey);
        return n;
      });
    } catch (e) {
      setErr(e?.response?.data?.message || e?.message || 'Regeneration failed.');
    } finally {
      setRegenBusy(null);
    }
  };
  const doRegenerateAll = async () => {
    if (regenBusy) return;
    if (!window.confirm('Regenerate the whole paper? This re-runs every question and can take 90 seconds or more. Your text edits will be replaced.')) return;
    setRegenBusy('all');
    setErr('');
    try {
      await onRegenerateAll();
      setFlagged(new Set());
    } catch (e) {
      setErr(e?.response?.data?.message || e?.message || 'Regeneration failed.');
    } finally {
      setRegenBusy(null);
    }
  };

  const save = async () => {
    try {
      if (onSave) await onSave();
      setLastSaved(new Date());
    } catch {
      setErr('Could not save changes.');
    }
  };

  const totalMarks = blueprint?.totalMarks ?? bpQuestions.reduce((a, bq) => a + (bq.totalMarks || 0), 0);
  const paperTitle =
    [format?.examTitle, format?.session].filter(Boolean).join(' ') || model?.header?.titleLines?.[1]?.text || 'Question Paper';
  const savedText = lastSaved
    ? lastSaved.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'Not saved yet';

  return (
    <div>
      {/* header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-bold text-gray-900">Review &amp; Edit Question Paper</h1>
          <p className="mt-1 text-[14px] text-gray-500">You can edit or regenerate any question before downloading the final paper.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={doRegenerateAll}
            disabled={!!regenBusy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-[12px] font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshIcon size={14} />
            {regenBusy === 'all' ? 'Regenerating…' : 'Regenerate All'}
          </button>
          <button
            type="button"
            onClick={save}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-[12px] font-medium text-gray-600 hover:bg-gray-50"
          >
            <SaveIcon size={14} />
            Save Changes
          </button>
          <button
            type="button"
            onClick={onDownloadPdf}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-[12px] font-semibold text-white hover:bg-blue-700"
          >
            <DownloadIcon size={14} />
            Download PDF
          </button>
          <button
            type="button"
            onClick={onDownloadAnswerKey}
            title="Open the answer key — answers + marking scheme, editable, with its own download"
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-800 px-3 py-2 text-[12px] font-semibold text-white hover:bg-blue-900"
          >
            <EyeIcon size={14} />
            Answer Key
          </button>
        </div>
      </div>

      {/* summary bar */}
      <div className="mt-4 flex flex-wrap items-center gap-4 rounded-xl border border-gray-200 bg-white px-5 py-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
          <FileLinesIcon size={18} />
        </span>
        <div className="min-w-0">
          <p className="text-[14px] font-bold text-gray-900">{paperTitle}</p>
          <p className="text-[12px] text-gray-500">
            Class {settings?.class} · Subject: {subject} · Total Marks: {totalMarks} · Duration: {format?.timeAllowed || '—'}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-4">
          <div className="text-right">
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
              <CircleCheckSolid size={12} />
              Generated successfully
            </span>
            <p className="mt-0.5 text-[11px] text-gray-400">You can edit any question, marks, or instructions.</p>
          </div>
          <div className="hidden text-right text-[11px] text-gray-400 sm:block">
            <p>Last saved</p>
            <p className="text-gray-500">{savedText}</p>
          </div>
        </div>
      </div>

      {err && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-[12.5px] text-red-700">{err}</div>
      )}

      {/* three panels */}
      <div className="mt-5 flex flex-col gap-5 xl:flex-row xl:items-start">
        <QuestionList groups={groups} selectedIdx={selectedIdx} onSelect={setSelectedIdx} filter={filter} onFilter={setFilter} />

        <Editor
          q={q}
          slot={slot}
          breadcrumb={`${slot?.sectionName || slot?.section || 'Section'} · ${selKey}`}
          units={units}
          unitId={unitBySlot[selKey] ?? null}
          onUnitChange={onUnitChange}
          topic={topic}
          coverage={coverage[selKey]}
          onTopicClear={onTopicClear}
          flagged={flagged.has(selKey)}
          onRegenerateOne={doRegenerateOne}
          regenBusy={regenBusy}
          onText={onText}
          onItemText={onItemText}
          onItemAnswer={onItemAnswer}
          onAnswerField={onAnswerField}
          images={q?.assetImages || []}
          onAddImage={onAddImage}
          onRemoveImage={onRemoveImage}
          note={notes[qId] || ''}
          onNote={(v) => setNotes((n) => ({ ...n, [qId]: v.slice(0, NOTE_MAX) }))}
          onNext={() => setSelectedIdx((i) => Math.min(bpQuestions.length - 1, i + 1))}
        />

        {/* preview */}
        <div className="w-full shrink-0 rounded-xl border border-gray-200 bg-white xl:w-[400px]">
          <div className="flex border-b border-gray-100 px-3 pt-2">
            {[
              ['live', 'Live preview'],
              ['full', 'Full paper'],
            ].map(([k, lbl]) => (
              <button
                key={k}
                type="button"
                onClick={() => (k === 'full' && onOpenFull ? onOpenFull() : setTab(k))}
                className={`border-b-2 px-3 py-2 text-[12px] font-medium transition-colors ${
                  tab === k ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                {lbl}
              </button>
            ))}
          </div>

          <div className="p-3">
            <div className="mx-auto max-h-[560px] overflow-auto rounded border border-gray-200 bg-white p-5 shadow-sm" style={{ width: `${zoom}%` }}>
              <PaperPage model={model} />
            </div>
            <div className="mt-2 flex items-center justify-between text-gray-400">
              <div className="flex items-center gap-1 text-[11.5px]">
                <button
                  type="button"
                  onClick={() => setPageIndex((i) => Math.max(0, i - 1))}
                  className="rounded p-1 hover:bg-gray-100 disabled:opacity-40"
                  disabled={pageIndex === 0}
                >
                  <ChevronDownIcon size={13} className="rotate-90" />
                </button>
                <span className="tabular-nums">
                  {pageIndex + 1} / {pageCount}
                </span>
                <button
                  type="button"
                  onClick={() => setPageIndex((i) => Math.min(pageCount - 1, i + 1))}
                  className="rounded p-1 hover:bg-gray-100 disabled:opacity-40"
                  disabled={pageIndex >= pageCount - 1}
                >
                  <ChevronDownIcon size={13} className="-rotate-90" />
                </button>
              </div>
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => setZoom((z) => Math.max(70, z - 10))} className="rounded p-1 hover:bg-gray-100">
                  <ZoomOutIcon size={14} />
                </button>
                <button type="button" onClick={() => setZoom((z) => Math.min(140, z + 10))} className="rounded p-1 hover:bg-gray-100">
                  <ZoomInIcon size={14} />
                </button>
                <button type="button" onClick={() => onOpenFull && onOpenFull()} className="rounded p-1 hover:bg-gray-100" title="Open full paper">
                  <MaximizeIcon size={14} />
                </button>
              </div>
            </div>
          </div>

          <div className="mx-3 mb-3 flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11.5px] text-emerald-800">
            <LightbulbIcon size={14} className="mt-0.5 shrink-0 text-emerald-600" />
            <div>
              <p className="font-medium">Changes appear in the preview as you type.</p>
              <p className="text-emerald-700">You can also regenerate a single question.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
