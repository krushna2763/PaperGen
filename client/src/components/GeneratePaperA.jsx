/**
 * GeneratePaperA — the Mode A "Generate Question Paper" screen: upload a
 * previous-year paper, review the extracted blueprint, assign syllabus units,
 * generate.
 *
 * Visual layout matching the Phase 4 reference UI:
 *   - Top summary stat badges (Class, Subject, Exam Title, Duration, Total Marks, Questions)
 *   - Left Column:  1. Upload Previous Year Paper   3. Paper Settings
 *   - Right Column: 2. Syllabus Notes               4. Question Blueprint
 *   - Expandable Image-Based question row with image preview thumbnail, question details,
 *     green lock confirmation banner, and "View Full Image" lightbox modal.
 *   - Segmented multi-color Marks Distribution by Unit bar.
 */
import { useRef, useState, useEffect, useMemo } from 'react';
import {
  slotKey,
  anyText,
  marksText,
  marksSummaryOf,
  itemLabels,
  itemMarksOf,
  isExpandable,
  isApproximate,
  isMixed,
  deriveSessionUnits,
} from './blueprintUnits.js';
import { useUnitAssignment } from './useUnitAssignment.js';
import { formatMetaValue } from './blueprintMeta.js';
import {
  FileLinesIcon,
  BookOpenIcon,
  SlidersIcon,
  LockIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  UploadCloudIcon,
  TrashIcon,
  CircleCheckSolid,
  CheckCircleIcon,
  BarChartIcon,
  InfoIcon,
  ImageIcon,
  LayersIcon,
  EyeIcon,
  XIcon,
} from './ui/icons.jsx';
import { questionTypeLabel as typeLabel } from '../services/questionTypeLabel.js';
import { normalizeAssetImages } from '../services/paperLayout.js';

const DIFFICULTY_OPTIONS = ['Easy', 'Medium', 'Difficult'];
const UNIT_COLORS = [
  { bg: 'bg-blue-600', dot: 'bg-blue-600', text: 'text-blue-700' },
  { bg: 'bg-emerald-500', dot: 'bg-emerald-500', text: 'text-emerald-700' },
  { bg: 'bg-amber-500', dot: 'bg-amber-500', text: 'text-amber-700' },
  { bg: 'bg-violet-500', dot: 'bg-violet-500', text: 'text-violet-700' },
  { bg: 'bg-sky-500', dot: 'bg-sky-500', text: 'text-sky-700' },
  { bg: 'bg-rose-500', dot: 'bg-rose-500', text: 'text-rose-700' },
];

const fieldClass =
  'h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-[13px] text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors';
const lockedFieldClass =
  'h-10 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 pr-9 text-[13px] text-gray-600';
const rowSelectClass =
  'h-8 rounded-md border border-gray-300 bg-white pl-2.5 pr-7 text-[12.5px] text-gray-800 appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 disabled:bg-gray-50 disabled:text-gray-400';

function Card({ n, Icon, title, subtitle, right, children }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white">
      <div className="flex items-start gap-2.5 px-5 pt-4">
        <span className="mt-0.5 text-gray-400">
          <Icon size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold text-gray-900">
            {n}. {title}
          </h3>
          {subtitle && <p className="mt-0.5 text-[12px] leading-snug text-gray-500">{subtitle}</p>}
        </div>
        {right}
      </div>
      <div className="p-5 pt-4">{children}</div>
    </div>
  );
}

function LockedField({ label, value }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11.5px] font-medium text-gray-500">{label}</span>
      <div className="relative">
        <input
          readOnly
          tabIndex={-1}
          aria-readonly="true"
          value={value ?? ''}
          placeholder="—"
          className={lockedFieldClass}
        />
        <LockIcon size={13} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
      </div>
    </label>
  );
}

function UnitSelect({ value, units, onChange, mixed, disabled, placeholder }) {
  // A locked slot's value is the reference's own detectedUnit VERBATIM
  // (defaultAssign never rewrites it to the pool's own spelling — see
  // blueprintUnits.js), so it may not literally match any `units` entry
  // (e.g. "Unit I" vs an indexed "Unit 1"). Without its own <option>, a
  // controlled <select> whose value matches nothing silently falls back to
  // the browser's first option — showing an arbitrary, WRONG unit for a
  // locked row. Render the real value as its own option instead, so the
  // teacher always sees the actual locked unit, never a substitute.
  const valueStr = value == null ? '' : String(value);
  const hasMatchingOption = mixed || valueStr === '' || units.some((u) => String(u.id) === valueStr);
  return (
    <div className="relative inline-flex">
      <select
        className={rowSelectClass}
        disabled={disabled || units.length === 0}
        value={mixed ? '' : valueStr}
        onChange={(e) => onChange(e.target.value)}
      >
        {mixed && <option value="">Mixed</option>}
        {!mixed && value == null && <option value="">{placeholder || 'Choose unit…'}</option>}
        {!mixed && !hasMatchingOption && <option value={valueStr}>{value}</option>}
        {units.map((u) => (
          <option key={u.id} value={String(u.id)}>
            {u.label}
          </option>
        ))}
      </select>
      <ChevronDownIcon size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-400" />
    </div>
  );
}

function TypeBadge({ type }) {
  const norm = String(type || '').toUpperCase();
  if (norm === 'MIXED') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-pink-200 bg-pink-50 px-2 py-0.5 text-[11.5px] font-medium text-pink-700">
        <LayersIcon size={12} className="text-pink-500" />
        Mixed
      </span>
    );
  }
  if (norm === 'IMAGE_BASED') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11.5px] font-medium text-blue-700">
        <ImageIcon size={12} className="text-blue-500" />
        Image Based
      </span>
    );
  }
  if (norm === 'LONG_ANSWER') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-purple-200 bg-purple-50 px-2 py-0.5 text-[11.5px] font-medium text-purple-700">
        <FileLinesIcon size={12} className="text-purple-500" />
        Long Answer
      </span>
    );
  }
  if (norm === 'SHORT_ANSWER') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11.5px] font-medium text-sky-700">
        Short Answer
      </span>
    );
  }
  if (norm === 'MCQ') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11.5px] font-medium text-emerald-700">
        MCQ
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11.5px] font-medium text-gray-700">
      {typeLabel(type)}
    </span>
  );
}

/* ── Lightbox Modal ─────────────────────────────────────────── */
function LightboxModal({ image, onClose }) {
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (!image) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative max-h-[90vh] max-w-3xl overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <ImageIcon size={18} className="text-blue-600" />
            <h3 className="text-[14.5px] font-semibold text-gray-900">
              {image.title || 'Detected Reference Image'}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            aria-label="Close lightbox"
          >
            <XIcon size={18} />
          </button>
        </div>

        <div className="flex items-center justify-center bg-gray-950 p-6">
          <img
            src={image.src}
            alt={image.title || 'Reference diagram'}
            className="max-h-[65vh] max-w-full rounded object-contain shadow-md"
          />
        </div>

        <div className="flex items-center justify-between border-t border-gray-100 bg-gray-50 px-5 py-3 text-[12px] text-gray-600">
          <span>Position: {image.position || 'Above question'}</span>
          <span>Status: 🔒 Locked to question</span>
        </div>
      </div>
    </div>
  );
}

/* ── Top Summary Cards ──────────────────────────────────────── */
function SummaryBar({ classValue, subjectValue, format, blueprint }) {
  const qCount = blueprint?.totalQuestions ?? blueprint?.questions?.length ?? 0;
  const totalMarks = blueprint?.totalMarks ?? format?.maximumMarks ?? 0;
  const timeAllowed = format?.timeAllowed || '2 hrs 30 mins';
  const examTitle = format?.examTitle || 'Annual Examination';

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
          <BookOpenIcon size={17} />
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-gray-400">Class</p>
          <p className="truncate text-[13.5px] font-semibold text-gray-800">{classValue || '—'}</p>
        </div>
      </div>

      <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
          <BookOpenIcon size={17} />
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-gray-400">Subject</p>
          <p className="truncate text-[13.5px] font-semibold text-gray-800">{subjectValue || '—'}</p>
        </div>
      </div>

      <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
          <FileLinesIcon size={17} />
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-gray-400">Exam Title</p>
          <p className="truncate text-[13px] font-semibold text-gray-800">{examTitle}</p>
        </div>
      </div>

      <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-cyan-50 text-cyan-600">
          <SlidersIcon size={17} />
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-gray-400">Time Allowed</p>
          <p className="truncate text-[13px] font-semibold text-gray-800">{timeAllowed}</p>
        </div>
      </div>

      <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-rose-50 text-rose-600">
          <BarChartIcon size={17} />
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-gray-400">Total Marks</p>
          <p className="truncate text-[13.5px] font-semibold text-gray-800">{totalMarks || '—'}</p>
        </div>
      </div>

      <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
          <FileLinesIcon size={17} />
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-gray-400">No. of Questions</p>
          <p className="truncate text-[13.5px] font-semibold text-gray-800">{qCount || '—'}</p>
        </div>
      </div>
    </div>
  );
}

/* ── Card 1: upload ──────────────────────────────────────────── */
function UploadCard({
  file,
  dragOver,
  fileInputRef,
  onPickFile,
  onFileInput,
  onDrop,
  onDragOver,
  onDragLeave,
  onClearFile,
  onAnalyze,
  analyzing,
  analyzed,
}) {
  return (
    <Card n="1" Icon={FileLinesIcon} title="Upload Previous Year Paper" subtitle="Upload a PDF file of the previous year question paper to get started.">
      {!file ? (
        <div
          role="button"
          tabIndex={0}
          onClick={onPickFile}
          onKeyDown={(e) => e.key === 'Enter' && onPickFile()}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-9 text-center transition-colors ${
            dragOver ? 'border-blue-600 bg-blue-50' : 'border-blue-300 bg-blue-50/40 hover:bg-blue-50'
          }`}
        >
          <UploadCloudIcon size={34} className="text-blue-500" />
          <p className="mt-2.5 text-[13.5px] font-medium text-gray-800">Drag and drop your PDF here</p>
          <p className="mt-0.5 text-[12px] text-gray-400">or</p>
          <button
            type="button"
            className="mt-2 rounded-lg border border-blue-600 px-3.5 py-1.5 text-[12.5px] font-medium text-blue-700 hover:bg-blue-50"
          >
            Browse files
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-red-100 text-[9px] font-bold text-red-600">
              PDF
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-gray-800">{file.name}</p>
              <p className="text-[11.5px] text-gray-400">{formatSize(file.size)}</p>
            </div>
            {analyzed && <CircleCheckSolid size={18} className="shrink-0 text-emerald-500" />}
            <button
              type="button"
              onClick={onClearFile}
              aria-label="Remove file"
              className="shrink-0 rounded p-1 text-red-500 hover:bg-red-50"
            >
              <TrashIcon size={16} />
            </button>
          </div>

          {!analyzed && (
            <button
              type="button"
              onClick={onAnalyze}
              disabled={analyzing}
              className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-blue-600 text-[13px] font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
            >
              {analyzing ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/60 border-t-white" />
                  Analyzing paper…
                </>
              ) : (
                'Analyze reference paper'
              )}
            </button>
          )}
        </div>
      )}
      <input ref={fileInputRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={onFileInput} />
    </Card>
  );
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ── Card 2: syllabus notes ─────────────────────────────────── */
function NotesCard({ units, sessionNotesUploads = [], onAddNotes, notesMsg, disabled }) {
  const [unit, setUnit] = useState('');
  const [adding, setAdding] = useState(false);
  const fileRef = useRef(null);

  const pick = () => {
    if (!unit.trim()) return;
    fileRef.current?.click();
  };
  const doAdd = async (f) => {
    if (!f || !unit.trim()) return;
    setAdding(true);
    try {
      await onAddNotes(unit.trim(), f);
      setUnit('');
    } finally {
      setAdding(false);
    }
  };

  const count = units.length;
  const pill =
    count > 0 ? (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
        <CheckCircleIcon size={12} />
        {count} unit{count === 1 ? '' : 's'} indexed
      </span>
    ) : (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
        0 units indexed
      </span>
    );

  return (
    <Card
      n="2"
      Icon={BookOpenIcon}
      title="Syllabus Notes"
      subtitle="Upload notes for the same class & subject. These notes provide the syllabus content used to ground generation."
      right={pill}
    >
      <div className={disabled ? 'pointer-events-none opacity-50' : ''}>
        <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-gray-300 bg-gray-50/50 px-6 py-8 text-center">
          <UploadCloudIcon size={30} className="text-gray-400" />
          <p className="mt-2 text-[13px] font-medium text-gray-700">Drag and drop notes here</p>
          <p className="mt-0.5 text-[12px] text-gray-400">or click to upload (PDF, DOC, DOCX)</p>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            <input
              className={`${fieldClass} h-9 w-40`}
              placeholder="Unit (e.g. Unit 3)"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
            />
            <button
              type="button"
              onClick={pick}
              disabled={!unit.trim() || adding}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 text-[12.5px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {adding ? 'Uploading…' : 'Upload Notes'}
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,.pdf,.txt,.md,.docx"
            className="hidden"
            onChange={(e) => {
              doAdd(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>

        {/* Files uploaded via THIS control during the current session — never
            the full historical Qdrant-indexed unit list (that stays the
            source of truth for locking/generation/RAG via `units`/
            `availableUnits`, untouched below; the Knowledge Base page is
            still where all historical documents are visible). Showing the
            global list here read as "these were just uploaded", which they
            weren't. */}
        {sessionNotesUploads && sessionNotesUploads.length > 0 ? (
          <div className="mt-3 space-y-1.5">
            {sessionNotesUploads.map((f) => (
              <div
                key={f.id}
                className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-[11.5px]"
              >
                <FileLinesIcon size={13} className="shrink-0 text-gray-400" />
                <span className="min-w-0 flex-1 truncate font-medium text-gray-700">{f.fileName}</span>
                <span className="shrink-0 text-gray-400">{f.unit}</span>
                {f.chunkCount != null && (
                  <span className="shrink-0 tabular-nums text-gray-400">
                    {f.chunkCount} chunk{f.chunkCount === 1 ? '' : 's'}
                  </span>
                )}
                <span className="shrink-0 inline-flex items-center gap-1 text-emerald-600">
                  <CheckCircleIcon size={12} />
                  {f.reused ? 'Already indexed' : 'Indexed'}
                </span>
              </div>
            ))}
          </div>
        ) : (
          count > 0 && (
            <p className="mt-3 text-[11.5px] text-gray-400">
              {count} unit{count === 1 ? '' : 's'} already indexed for this class &amp; subject from earlier uploads — no
              need to re-upload unless you have new notes.
            </p>
          )
        )}

        {notesMsg && <p className="mt-2 text-[11.5px] text-emerald-700">{notesMsg}</p>}
      </div>
    </Card>
  );
}

/* ── Card 3: paper settings ─────────────────────────────────── */
function SettingsCard({ blueprint, format, classValue, onClassChange, classOptions, subjectValue, _onSubjectChange, difficulty, onDifficultyChange }) {
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? String(v) : '');
  return (
    <Card n="3" Icon={SlidersIcon} title="Paper Settings">
      <p className="-mt-1 mb-3 flex items-center gap-1.5 text-[11.5px] text-gray-400">
        <LockIcon size={12} />
        Read from the reference paper.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1 block text-[11.5px] font-medium text-gray-500">Class</span>
          <div className="relative">
            <select className={`${fieldClass} appearance-none pr-8`} value={classValue} onChange={(e) => onClassChange(e.target.value)}>
              {classOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <ChevronDownIcon size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          </div>
        </label>

        <label className="block">
          <span className="mb-1 block text-[11.5px] font-medium text-gray-500">Subject</span>
          <div className="relative">
            <input className={lockedFieldClass} readOnly value={subjectValue || ''} placeholder="—" />
            <LockIcon size={13} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
          </div>
        </label>

        <LockedField label="Examination Title" value={format?.examTitle} />
        <LockedField label="Academic Session" value={format?.session || '2025 - 26'} />
        <LockedField label="Time Allowed" value={format?.timeAllowed || '2hrs 30mins'} />
        <LockedField label="Maximum Marks" value={num(blueprint?.totalMarks ?? format?.maximumMarks)} />
        <LockedField label="Number of Questions" value={blueprint ? String(blueprint.totalQuestions ?? blueprint.questions?.length ?? '') : ''} />

        <label className="block">
          <span className="mb-1 block text-[11.5px] font-medium text-gray-500">Difficulty level</span>
          <div className="relative">
            <select className={`${fieldClass} appearance-none pr-8`} value={difficulty} onChange={(e) => onDifficultyChange(e.target.value)}>
              {DIFFICULTY_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <ChevronDownIcon size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          </div>
        </label>
      </div>

      <div className="mt-3">
        <span className="mb-1 block text-[11.5px] font-medium text-gray-500">General Instructions</span>
        <div className="relative">
          <textarea
            readOnly
            tabIndex={-1}
            aria-readonly="true"
            rows={3}
            value={Array.isArray(format?.instructions) ? format.instructions.filter(Boolean).map((s, i) => `${i + 1}. ${s}`).join('\n') : '1. All questions are compulsory.\n2. Write all answers in answer script neatly.\n3. Mention question numbers clearly.'}
            placeholder="—"
            className="w-full resize-none rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 pr-9 text-[12.5px] leading-relaxed text-gray-600"
          />
          <LockIcon size={13} className="pointer-events-none absolute right-3 top-3 text-gray-400" />
        </div>
      </div>
    </Card>
  );
}

/* ── Card 4: question blueprint ─────────────────────────────── */
function BlueprintCard({ blueprint, units, dropdownUnits, assignment, onOpenLightbox }) {
  const { assign, expanded, assignWholeQuestion, assignItem, toggleExpand, totals, unassigned, unknownItems, approximate, unassignedKeys } =
    assignment;
  const questions = blueprint?.questions || [];
  // The Unit/Topic dropdown's own selectable options — the CURRENT session's
  // syllabus units only (see GeneratePaperA's sessionUnits). `units` (the
  // full historical Qdrant-indexed list) stays the source for the Marks
  // Distribution legend below, unchanged.
  const selectableUnits = dropdownUnits || units || [];

  // Calculate percentages for Marks Distribution
  const totalMarks = Number(blueprint?.totalMarks) || Object.values(totals).reduce((sum, v) => sum + v, 0) + unassigned || 10;
  const unitList = units || [];

  return (
    <Card
      n="4"
      Icon={FileLinesIcon}
      title="Question Blueprint"
      subtitle="Questions, sections and marks are detected from the reference paper. Assign units for each question."
      right={
        questions.length > 0 ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[11px] font-medium text-emerald-700">
            <CircleCheckSolid size={13} className="text-emerald-500" />
            Structure detected successfully
          </span>
        ) : null
      }
    >
      {questions.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50/50 px-4 py-10 text-center text-[12.5px] text-gray-500">
          Upload a previous year paper and analyze it to see the detected blueprint.
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border border-gray-200">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 text-[11px] font-medium uppercase tracking-wide text-gray-500">
                  <th className="w-8" />
                  <th className="px-2 py-2">Q.No.</th>
                  <th className="px-2 py-2">Question Type</th>
                  <th className="px-2 py-2">Marks</th>
                  <th className="px-2 py-2">Unit / Topic</th>
                  <th className="px-2 py-2 text-center">Status</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 text-[12.5px]">
                {questions.map((q, i) => {
                  const key = slotKey(q, i);
                  const a = assign[key] || { unit: null, items: {} };
                  const labels = itemLabels(q);
                  const isImg = q.type === 'IMAGE_BASED' || (Array.isArray(q.imageAssets) && q.imageAssets.length > 0);
                  const expandable = isExpandable(q) || isImg;
                  const open = expanded.has(key);
                  const mixed = isMixed(q, a);
                  const items = itemMarksOf(q);
                  const rowUnassigned = unassignedKeys.includes(key);
                  const opt = anyText(q);
                  const approx = isApproximate(q);
                  const isLocked = q.isLocked || isImg || q.type === 'MIXED';

                  // Reuses the SAME normalization the PDF renderer already
                  // trusts (paperLayout.js's normalizeAssetImages) — the
                  // existing imageAssets contract (dataUri/data/base64,
                  // real mimeType, multiple images in order), not a second
                  // ad-hoc parser.
                  const normalizedImages = normalizeAssetImages(q);
                  const imgSrc = normalizedImages[0]?.dataUri || null;

                  return (
                    <FragmentRow key={key}>
                      <tr className={rowUnassigned ? 'bg-amber-50/40' : undefined}>
                        <td className="pl-2 align-middle">
                          {expandable ? (
                            <button
                              type="button"
                              onClick={() => toggleExpand(q, key)}
                              className="flex h-7 w-6 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                              title={open ? 'Collapse' : 'Expand details'}
                            >
                              {open ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
                            </button>
                          ) : labels.length > 1 ? (
                            <span
                              className="flex h-7 w-6 items-center justify-center text-gray-300"
                              title="Parts share one stimulus and must use one unit."
                            >
                              <LockIcon size={13} />
                            </span>
                          ) : (
                            <span className="block h-7 w-6" />
                          )}
                        </td>
                        <td className="px-2 py-2 font-medium text-gray-800">{key}</td>
                        <td className="px-2 py-2 text-gray-700">
                          <div className="flex items-center gap-1.5">
                            <TypeBadge type={q.type} />
                            {opt && <span className="text-[11px] text-gray-400">· {opt}</span>}
                            {approx && (
                              <span className="text-amber-500" title="Student answers only some items — per-unit split is approximate">
                                ≈
                              </span>
                            )}
                          </div>
                        </td>
                        <td className={`px-2 py-2 ${marksSummaryOf(q) ? 'text-gray-600' : 'text-amber-600'}`}>
                          {marksSummaryOf(q) || (
                            <span title="The reference paper's printed marks for this question could not be read — nothing was invented.">
                              Marks not detected from reference
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex items-center gap-1.5">
                            {rowUnassigned && <span className="text-[10.5px] font-medium text-amber-600">unassigned</span>}
                            <UnitSelect
                              units={selectableUnits}
                              value={a.unit}
                              mixed={mixed}
                              disabled={isLocked}
                              placeholder={
                                isLocked && q.detectedUnit
                                  ? `Locked: ${q.detectedUnit}`
                                  : undefined
                              }
                              onChange={(v) => assignWholeQuestion(q, key, v)}
                            />
                            {isLocked && <LockIcon size={12} className="text-gray-400 shrink-0" />}
                          </div>
                        </td>
                        <td className="px-2 py-2 text-center">
                          <span className="inline-flex items-center rounded-md border border-gray-200 bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">
                            Locked
                          </span>
                        </td>
                        <td className="pr-2 text-right align-middle">
                          {expandable && (
                            <button
                              type="button"
                              onClick={() => toggleExpand(q, key)}
                              className="text-gray-400 hover:text-gray-600"
                            >
                              {open ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
                            </button>
                          )}
                        </td>
                      </tr>

                      {open && isImg && (
                        <tr className="bg-gray-50/70">
                          <td colSpan={7} className="px-4 py-3">
                            <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                              <div className="grid gap-4 md:grid-cols-2">
                                {/* Left Sub-Card: Detected Image */}
                                <div className="rounded-lg border border-gray-200 bg-gray-50/50 p-3">
                                  <h4 className="text-[12px] font-semibold text-gray-800">
                                    Detected Image <span className="font-normal text-gray-500">(from reference paper)</span>
                                  </h4>
                                  <div className="mt-2.5 flex min-h-[140px] items-center justify-center rounded-lg border border-gray-200 bg-white p-2">
                                    {imgSrc ? (
                                      <img
                                        src={imgSrc}
                                        alt={`Reference visual for ${key}`}
                                        className="max-h-36 max-w-full rounded object-contain"
                                      />
                                    ) : (
                                      <div className="flex flex-col items-center justify-center text-gray-400">
                                        <ImageIcon size={32} />
                                        <span className="mt-1 text-[11.5px]">Reference Diagram</span>
                                      </div>
                                    )}
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => onOpenLightbox({ src: imgSrc || '', title: `Detected Image — ${key}`, position: q.imageLayout?.position })}
                                    disabled={!imgSrc}
                                    className="mt-2.5 flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-blue-200 bg-white text-[12px] font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50"
                                  >
                                    <EyeIcon size={13} />
                                    View Full Image
                                  </button>
                                </div>

                                {/* Right Sub-Card: Question Details */}
                                <div className="space-y-2.5 rounded-lg border border-gray-200 bg-gray-50/50 p-3 text-[12px]">
                                  <h4 className="font-semibold text-gray-800">Question Details</h4>
                                  <div>
                                    <p className="text-[11px] font-medium text-gray-500">Original Question (from reference)</p>
                                    <p className="mt-0.5 text-gray-700 italic">
                                      "{q.instruction || q.text || 'No instruction text was extracted for this question.'}"
                                    </p>
                                  </div>

                                  <div className="grid grid-cols-[130px_1fr] gap-1 text-[11.5px]">
                                    <span className="text-gray-500">Detected Unit / Topic</span>
                                    <span className="font-medium text-gray-800">
                                      : {q.detectedUnit || q.unit
                                        ? `${q.detectedUnit || q.unit}${q.detectedTopic || q.topic ? ` (${q.detectedTopic || q.topic})` : ''}`
                                        : (q.detectedTopic || q.topic || 'Not detected — needs review')}
                                      {q.detectedUnitSource === 'paper' && (
                                        <span className="ml-1 text-[10.5px] font-normal text-gray-400">(inherited from paper header)</span>
                                      )}
                                    </span>

                                    <span className="text-gray-500">Image Position</span>
                                    <span className="font-medium text-gray-800">
                                      : {q.imageLayout?.position || q.imageLayout?.placement || 'Not detected'}
                                    </span>

                                    <span className="text-gray-500">Question Pattern</span>
                                    <span className="font-medium text-gray-800">
                                      : {formatMetaValue(q.pattern)}
                                    </span>

                                    <span className="text-gray-500">Marks</span>
                                    <span className={`font-medium ${marksSummaryOf(q) ? 'text-gray-800' : 'text-amber-600'}`}>
                                      : {marksSummaryOf(q)
                                        ? `${marksSummaryOf(q)}${marksText(q.totalMarks) ? ` — total ${marksText(q.totalMarks)}` : ''}`
                                        : 'Marks not detected from reference'}
                                    </span>

                                    <span className="text-gray-500">Associated Sub-questions</span>
                                    <span className="font-medium text-gray-800">
                                      : {Array.isArray(q.items) && q.items.length > 0
                                        ? q.items.map((it, idx) => {
                                            const label = it.label || String.fromCharCode(97 + idx);
                                            const text = it.referenceText || it.text || `Item ${idx + 1}`;
                                            return `${label}) ${text} (${it.marks != null ? marksText(it.marks) : 'marks not detected'})`;
                                          }).join(', ')
                                        : 'No sub-questions detected'}
                                    </span>
                                  </div>
                                </div>
                              </div>

                              {/* Green Confirmation Banner */}
                              <div className="mt-3 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-800">
                                <CircleCheckSolid size={16} className="shrink-0 text-emerald-500" />
                                <span>
                                  Image successfully linked to <strong>{key}</strong> from the reference paper. Unit/Topic is locked to maintain the original context of the image and question.
                                </span>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}

                      {open && expandable && !isImg &&
                        items.map((it) => (
                          <tr key={`${key}-${it.label}`} className="bg-gray-50/50">
                            <td />
                            <td className="px-2 py-1.5 pl-6 text-gray-400">{it.label})</td>
                            <td className="px-2 py-1.5" />
                            <td className={`px-2 py-1.5 ${it.marks == null ? 'text-amber-500' : 'text-gray-400'}`}>
                              {it.marks == null ? 'marks n/a' : marksText(it.marks)}
                            </td>
                            <td className="px-2 py-1.5" colSpan={3}>
                              <UnitSelect units={selectableUnits} value={a.items[it.label] ?? null} onChange={(v) => assignItem(q, key, it.label, v)} />
                            </td>
                          </tr>
                        ))}
                    </FragmentRow>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Marks Distribution by Unit */}
          <div className="mt-5 rounded-xl border border-gray-200 bg-gray-50/40 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <BarChartIcon size={16} className="text-blue-600" />
                <h4 className="text-[13px] font-semibold text-gray-800">
                  Marks Distribution by Unit{approximate ? ' (approximate)' : ''}
                </h4>
              </div>
              <span className="text-[12.5px] font-bold text-gray-900">
                Total Marks: {totalMarks}
              </span>
            </div>

            {/* Segmented multi-color bar */}
            <div className="mt-3 flex h-6 w-full overflow-hidden rounded-lg bg-gray-200 text-[11px] font-medium text-white shadow-inner">
              {unitList.map((u, idx) => {
                const marks = totals[u.id] || 0;
                const pct = totalMarks > 0 ? Math.round((marks / totalMarks) * 100) : 0;
                if (pct <= 0) return null;
                const color = UNIT_COLORS[idx % UNIT_COLORS.length];
                return (
                  <div
                    key={u.id}
                    className={`flex items-center justify-center ${color.bg} transition-all`}
                    style={{ width: `${pct}%` }}
                    title={`${u.label}: ${marks} marks (${pct}%)`}
                  >
                    <span className="truncate px-1.5">{marks} ({pct}%)</span>
                  </div>
                );
              })}
              {unassigned > 0 && (
                <div
                  className="flex items-center justify-center bg-amber-400 transition-all text-amber-950"
                  style={{ width: `${totalMarks > 0 ? Math.round((unassigned / totalMarks) * 100) : 0}%` }}
                  title={`Unassigned: ${unassigned} marks`}
                >
                  <span className="truncate px-1.5">{unassigned}</span>
                </div>
              )}
            </div>

            {/* Legend below bar */}
            <div className="mt-3 flex flex-wrap items-center gap-4 text-[12px]">
              {unitList.map((u, idx) => {
                const marks = totals[u.id] || 0;
                const pct = totalMarks > 0 ? Math.round((marks / totalMarks) * 100) : 0;
                const color = UNIT_COLORS[idx % UNIT_COLORS.length];
                return (
                  <div key={u.id} className="flex items-center gap-1.5">
                    <span className={`h-2.5 w-2.5 rounded-full ${color.dot}`} />
                    <span className="font-medium text-gray-700">{u.label}</span>
                    <span className="text-gray-400">
                      {marks} marks ({pct}%)
                    </span>
                  </div>
                );
              })}
              {unknownItems > 0 && (
                <div className="flex items-center gap-1.5 text-gray-400">
                  <span className="h-2.5 w-2.5 rounded-full bg-gray-300" />
                  <span>Other: 0 marks (0%)</span>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

/** Table rows can't be React-fragment-wrapped with a key directly in some
 *  lint setups; this keeps the main row + its item rows grouped. */
function FragmentRow({ children }) {
  return <>{children}</>;
}

/* ── Footer ─────────────────────────────────────────────────── */
function Footer({ blueprint, units, assignment, generating, onGenerate }) {
  const { unassignedKeys, buildMap } = assignment;
  const noUnits = units.length === 0;
  const hasBlueprint = (blueprint?.questions?.length ?? 0) > 0;

  const knownUnits = new Set(units.map((u) => String(u.id)));
  const referencedUnits = new Set();
  for (const entry of Object.values(buildMap())) {
    if (entry?.unit != null) referencedUnits.add(String(entry.unit));
    else for (const u of Object.values(entry?.items ?? {})) if (u != null) referencedUnits.add(String(u));
  }
  const missingNotes = [...referencedUnits].filter((id) => !knownUnits.has(id));

  const ready = hasBlueprint && !noUnits && unassignedKeys.length === 0 && missingNotes.length === 0 && !generating;

  let message;
  if (!hasBlueprint) {
    message = 'Upload a previous year paper and analyze it to detect its structure.';
  } else if (noUnits) {
    message = 'No indexed units yet. Add syllabus notes in card 2 before generating.';
  } else if (missingNotes.length > 0) {
    message = `Assigned unit${missingNotes.length === 1 ? '' : 's'} ${missingNotes.join(', ')} ${missingNotes.length === 1 ? 'has' : 'have'} no indexed notes for the selected class & subject. Reassign the slots or upload notes in card 2.`;
  } else if (unassignedKeys.length > 0) {
    message = `Assign a unit to ${unassignedKeys.join(', ')} before generating.`;
  } else {
    message = `Your notes have ${units.length} indexed unit${units.length === 1 ? '' : 's'}. Click the button to generate a new question paper.`;
  }

  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 ${
        ready ? 'border-emerald-200 bg-emerald-50' : 'border-gray-200 bg-gray-50'
      }`}
    >
      <span className={ready ? 'text-emerald-600' : 'text-gray-400'}>
        {ready ? <CircleCheckSolid size={20} /> : <InfoIcon size={18} />}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`text-[12.5px] font-semibold ${ready ? 'text-emerald-800' : 'text-gray-700'}`}>
          {ready ? 'Ready to generate!' : hasBlueprint ? 'Almost there' : 'Start by uploading a paper'}
        </p>
        <p className={`text-[11.5px] ${ready ? 'text-emerald-700' : 'text-gray-500'}`}>{message}</p>
      </div>
      <button
        type="button"
        onClick={() => onGenerate(buildMap())}
        disabled={!ready}
        className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg bg-blue-600 px-4 text-[13px] font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60 shadow-sm"
      >
        {generating ? 'Generating…' : 'Generate Question Paper →'}
      </button>
    </div>
  );
}

/* ── Screen ─────────────────────────────────────────────────── */
export default function GeneratePaperA({
  file,
  dragOver,
  fileInputRef,
  onPickFile,
  onFileInput,
  onDrop,
  onDragOver,
  onDragLeave,
  onClearFile,
  onAnalyze,
  analyzing,
  generating,
  progress,
  elapsed,
  blueprint,
  format,
  classValue,
  onClassChange,
  classOptions,
  subjectValue,
  onSubjectChange,
  difficulty,
  onDifficultyChange,
  units,
  sessionNotesUploads,
  onAddNotes,
  notesMsg,
  onGenerate,
  error,
}) {
  // The Unit/Topic dropdown's selectable pool: ONLY units from files
  // explicitly uploaded/selected for THIS Generate Paper session — never the
  // full historical Qdrant-indexed unit list (`units`/`availableUnits`,
  // which stays authoritative for locked-slot evidence checks, RAG and the
  // Knowledge Base page; see useUnitAssignment's `dropdownUnits` param).
  const sessionUnits = useMemo(() => deriveSessionUnits(sessionNotesUploads), [sessionNotesUploads]);
  const assignment = useUnitAssignment(blueprint, units, undefined, sessionUnits);
  const analyzed = (blueprint?.questions?.length ?? 0) > 0;
  const [lightboxImage, setLightboxImage] = useState(null);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-bold text-gray-900">Generate Question Paper</h1>
          <p className="mt-1 text-[13.5px] text-gray-500">
            Upload a previous year paper, set your preferences, and generate a new question paper instantly.
          </p>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-[12.5px] font-medium text-gray-600 hover:bg-gray-50 shadow-sm"
        >
          <BookOpenIcon size={15} />
          View Guide
        </button>
      </div>

      {/* Top summary stats row */}
      {analyzed && (
        <SummaryBar
          classValue={classValue}
          subjectValue={subjectValue}
          format={format}
          blueprint={blueprint}
        />
      )}

      {error && (
        <div className="flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          <InfoIcon size={16} className="mt-0.5 shrink-0" />
          <span className="whitespace-pre-line">{error}</span>
        </div>
      )}

      <div className="grid items-start gap-5 lg:grid-cols-2">
        <div className="space-y-5">
          <UploadCard
            file={file}
            dragOver={dragOver}
            fileInputRef={fileInputRef}
            onPickFile={onPickFile}
            onFileInput={onFileInput}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onClearFile={onClearFile}
            onAnalyze={onAnalyze}
            analyzing={analyzing}
            analyzed={analyzed}
          />

          <SettingsCard
            blueprint={blueprint}
            format={format}
            classValue={classValue}
            onClassChange={onClassChange}
            classOptions={classOptions}
            subjectValue={subjectValue}
            onSubjectChange={onSubjectChange}
            difficulty={difficulty}
            onDifficultyChange={onDifficultyChange}
          />
        </div>

        <div className="space-y-5">
          <NotesCard units={units} sessionNotesUploads={sessionNotesUploads} onAddNotes={onAddNotes} notesMsg={notesMsg} disabled={false} />
          <BlueprintCard
            blueprint={blueprint}
            units={units}
            dropdownUnits={sessionUnits}
            assignment={assignment}
            onOpenLightbox={setLightboxImage}
          />
          <Footer
            blueprint={blueprint}
            units={units}
            assignment={assignment}
            generating={generating}
            onGenerate={onGenerate}
          />
          {generating && progress && (
            <p className="text-[12px] text-gray-500">
              {progress}
              {elapsed > 0 ? ` · ${elapsed}s` : ''}
            </p>
          )}
        </div>
      </div>

      {/* Lightbox Modal */}
      {lightboxImage && (
        <LightboxModal image={lightboxImage} onClose={() => setLightboxImage(null)} />
      )}
    </div>
  );
}

