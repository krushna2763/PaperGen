import { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { paperService, kbService } from './services/api.js';
import ConfirmScreen from './components/ConfirmScreen.jsx';
import { buildPaperModel, paginatePaper } from './services/paperLayout.js';
import { createPaperPdfBlob, paperFileName } from './services/paperPdf.js';
import { DEFAULT_PAPER_FORMAT, PAPER_LAYOUT, optionLabels, templateToFormat } from './services/paperTemplate.js';

/* ─────────────────────────────────────────────────────────────
   Constants
───────────────────────────────────────────────────────────── */
const CLASS_OPTIONS = Array.from({ length: 12 }, (_, i) => String(i + 1));
const DEFAULT_SUBJECT = 'General';
const ZOOM_LEVELS = [75, 100, 125, 150];
const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15 MB

/* ─────────────────────────────────────────────────────────────
   Small helpers
───────────────────────────────────────────────────────────── */
function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Best-effort subject derived from the uploaded file name (no UI field).
 * "ENGLISH_Previous_Paper_2024.pdf" → "English" · "sample_class10_science.pdf" → "Science"
 */
function deriveSubject(filename) {
  const stem = String(filename || '').replace(/\.pdf$/i, '');
  const parts = stem.split(/[\s_\-./]+/).filter(Boolean);
  const fillers = new Set([
    'previous', 'prev', 'paper', 'year', 'question', 'questions', 'exam',
    'examination', 'class', 'board', 'cbse', 'icse', 'sample', 'final',
    'term', 'model', 'set', 'qp', 'answer', 'with', 'and', 'of', 'the', 'for',
  ]);
  const word = parts.find((p) => {
    const w = p.toLowerCase();
    return !/\d/.test(p) && w.length >= 3 && !fillers.has(w);
  });
  if (!word) return DEFAULT_SUBJECT;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}



/* ─────────────────────────────────────────────────────────────
   Icons (inline SVG, stroke style)
───────────────────────────────────────────────────────────── */
const Icon = ({ size = 20, className = '', strokeWidth = 2, children }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    {children}
  </svg>
);

const BookOpenIcon = (p) => (
  <Icon {...p}>
    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
  </Icon>
);
const HelpCircleIcon = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
    <path d="M12 17h.01" />
  </Icon>
);
const FileTextIcon = (p) => (
  <Icon {...p}>
    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="16" y1="13" x2="8" y2="13" />
    <line x1="16" y1="17" x2="8" y2="17" />
  </Icon>
);
const CloudUploadIcon = (p) => (
  <Icon {...p}>
    <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
    <path d="M12 13v8" />
    <path d="m8 17 4-4 4 4" />
  </Icon>
);
const TrashIcon = (p) => (
  <Icon {...p}>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <line x1="10" y1="11" x2="10" y2="17" />
    <line x1="14" y1="11" x2="14" y2="17" />
  </Icon>
);
const SlidersIcon = (p) => (
  <Icon {...p}>
    <line x1="21" y1="4" x2="14" y2="4" />
    <line x1="10" y1="4" x2="3" y2="4" />
    <line x1="21" y1="12" x2="12" y2="12" />
    <line x1="8" y1="12" x2="3" y2="12" />
    <line x1="21" y1="20" x2="16" y2="20" />
    <line x1="12" y1="20" x2="3" y2="20" />
    <line x1="14" y1="2" x2="14" y2="6" />
    <line x1="8" y1="10" x2="8" y2="14" />
    <line x1="16" y1="18" x2="16" y2="22" />
  </Icon>
);
const SparklesIcon = (p) => (
  <Icon {...p}>
    <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
    <path d="M20 3v4" />
    <path d="M22 5h-4" />
    <path d="M4 17v2" />
    <path d="M5 18H3" />
  </Icon>
);
const CheckCircleIcon = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="m9 12 2 2 4-4" />
  </Icon>
);
const EyeIcon = (p) => (
  <Icon {...p}>
    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);
const DownloadIcon = (p) => (
  <Icon {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m7 10 5 5 5-5" />
    <path d="M12 15V3" />
  </Icon>
);
const PrinterIcon = (p) => (
  <Icon {...p}>
    <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
    <rect x="6" y="14" width="12" height="8" />
  </Icon>
);
const ChevronUpIcon = (p) => (
  <Icon {...p}>
    <path d="m18 15-6-6-6 6" />
  </Icon>
);
const ChevronDownIcon = (p) => (
  <Icon {...p}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);
const ZoomInIcon = (p) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
    <path d="M11 8v6" />
    <path d="M8 11h6" />
  </Icon>
);
const ZoomOutIcon = (p) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
    <path d="M8 11h6" />
  </Icon>
);
const MoreIcon = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="5" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="12" cy="19" r="1" />
  </Icon>
);
const AlertIcon = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="8" x2="12" y2="12" />
    <line x1="12" y1="16" x2="12.01" y2="16" />
  </Icon>
);

/* ─────────────────────────────────────────────────────────────
   Small presentational components
───────────────────────────────────────────────────────────── */
const Card = ({ children, className = '' }) => (
  <div className={`bg-white rounded-xl border border-gray-200 shadow-sm ${className}`}>{children}</div>
);

const CardHeader = ({ icon, title }) => (
  <div className="flex items-center gap-2.5 px-5 pt-5">
    {icon}
    <h2 className="text-[15px] font-semibold text-gray-900">{title}</h2>
  </div>
);

const ToolbarButton = ({ onClick, title, disabled, children }) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    disabled={disabled}
    className="h-7 w-7 flex items-center justify-center rounded text-gray-300 hover:bg-gray-700 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
  >
    {children}
  </button>
);

/* ─────────────────────────────────────────────────────────────
   Standalone paper HTML (used by View Full PDF / Download PDF)
───────────────────────────────────────────────────────────── */
function paperQuestionHtml(q) {
  const qOptions = (q.options || [])
    .map((opt, oi) => `<div class="opt"><span class="opt-label">${optionLabels(q.options.length)[oi]}</span><span>${escapeHtml(opt)}</span></div>`)
    .join('');
  const parts = (q.subParts || [])
    .map((p) => {
      const partOpts = (p.options || [])
        .map((opt, oi) => `<div class="opt opt-sub"><span class="opt-label">${optionLabels(p.options.length)[oi]}</span><span>${escapeHtml(opt)}</span></div>`)
        .join('');
      return `<div class="part"><span class="part-label">${escapeHtml(p.label)}</span><span>${escapeHtml(p.text)}</span></div>${partOpts}`;
    })
    .join('');
  const passage = q.passage ? `<div class="passage">${escapeHtml(q.passage)}</div>` : '';
  const columns = q.columns && q.columns.left.length > 0 && q.columns.right.length > 0
    ? `<div class="match"><div class="match-col">${q.columns.left
        .map((c, i) => `<div class="match-item"><span class="part-label">${String.fromCharCode(97 + (i % 26))})</span><span>${escapeHtml(c)}</span></div>`)
        .join('')}</div><div class="match-col">${q.columns.right
        .map((c, i) => `<div class="match-item"><span class="part-label">${i + 1}.</span><span>${escapeHtml(c)}</span></div>`)
        .join('')}</div></div>`
    : '';
  const choices = (q.choices || [])
    .map((c, ci) => {
      const choiceParts = (c.subParts || [])
        .map((sp) => `<div class="part"><span class="part-label">${escapeHtml(sp.label)}</span><span>${escapeHtml(sp.text)}</span></div>`)
        .join('');
      const orLine = ci < (q.choices || []).length - 1 ? '<div class="or">OR</div>' : '';
      return `<div class="part choice"><span class="part-label">${escapeHtml(c.label)}</span><span>${escapeHtml(c.text)}</span></div>${choiceParts}${orLine}`;
    })
    .join('');
  return `<div class="q"><span class="num">${q.numberText}</span><span class="qtext">${escapeHtml(q.text)}</span>${q.marksText ? `<span class="marks">${escapeHtml(q.marksText)}</span>` : ''}</div>${passage}${parts}${qOptions}${columns}${choices}`;
}

function buildPaperHtml({ questions, blueprint, settings, subject, format, _rejectedCount }) {
  const model = buildPaperModel({ questions, blueprint, settings, subject, format });
  const title = String(subject || DEFAULT_SUBJECT).toUpperCase();

  const body =
    model.sections
      .map((sec) => {
        const qs = sec.questions.map(paperQuestionHtml).join('');
        return `<div class="section-title">${escapeHtml(sec.label)}</div>${qs}`;
      })
      .join('')
    + (model.unsectionedQuestions || []).map(paperQuestionHtml).join('');

  const headerHtml = `
    <div class="school">${model.header.titleLines.map((l) => `<div>${escapeHtml(l.text)}</div>`).join('')}</div>
    <div class="time-row">
      <span>${model.header.timeAllowed ? `Time: ${escapeHtml(model.header.timeAllowed)}` : ''}</span>
      <span>${model.header.maximumMarks ? `Maximum Marks: ${escapeHtml(model.header.maximumMarks)}` : ''}</span>
    </div>
    <div class="gi-title">${escapeHtml(model.instructionsHeading || 'General Instructions :')}</div>
    ${model.instructions.map((inst, i) => `<div class="gi"><span class="gi-num">${i + 1}.</span><span>${escapeHtml(inst)}</span></div>`).join('')}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)} - Question Paper</title>
<style>
  @page { size: A4; margin: 16mm 13mm 16mm 15mm; }
  * { box-sizing: border-box; }
  body { font-family: ${PAPER_LAYOUT.serifCss}; color: #111; margin: 0; font-size: 12pt; line-height: 1.72; }
  .school { text-align: center; font-weight: 700; }
  .time-row { display: flex; justify-content: space-between; margin-top: 14px; }
  .gi-title { font-weight: 700; margin-top: 14px; }
  .gi { display: flex; gap: 8px; line-height: 1.24; margin: 2px 0; }
  .gi-num { width: 26px; text-align: right; }
  .section-title { text-align: center; font-weight: 700; margin: 26px 0 4px; }
  .q { display: flex; align-items: flex-start; margin-top: 20px; }
  .q .num { width: 26px; }
  .q .qtext { flex: 1; }
  .q .marks { margin-left: 12px; }
  .passage { margin: 6px 0 0 26px; text-align: justify; }
  .part { display: flex; gap: 6px; margin-left: 0; }
  .part-label { width: 24px; flex-shrink: 0; }
  .opt { display: flex; gap: 6px; margin-left: 46px; }
  .opt-sub { margin-left: 72px; }
  .opt-label { width: 22px; flex-shrink: 0; }
  .match { display: flex; gap: 20px; margin: 6px 0 4px 26px; }
  .match-col { flex: 1; }
  .match-item { display: flex; gap: 6px; }
  .choice { margin-left: 24px; }
  .or { margin: 2px 0 2px 48px; font-style: italic; }
</style>
</head>
<body>
${headerHtml}
${body}
</body>
</html>`;
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ─────────────────────────────────────────────────────────────
   Paper-format (template) persistence — each school keeps its look.
───────────────────────────────────────────────────────────── */
const FORMAT_STORAGE_KEY = 'papergen:paperFormat';

function loadStoredFormat() {
  try {
    const raw = localStorage.getItem(FORMAT_STORAGE_KEY);
    if (raw) return { ...DEFAULT_PAPER_FORMAT, ...JSON.parse(raw) };
  } catch {
    /* ignore corrupted storage */
  }
  return { ...DEFAULT_PAPER_FORMAT };
}/* ─────────────────────────────────────────────────────────────
   Paper preview renderers (screen = same model as the real PDF)
───────────────────────────────────────────────────────────── */
const paperCss = { fontFamily: PAPER_LAYOUT.serifCss, fontSize: 12, lineHeight: 1.72, color: '#111', minHeight: '100%' };
const paperStyles = {
  headerLine: { textAlign: 'center', fontWeight: 700, lineHeight: 1.24, margin: 0 },
  timeRow: { display: 'flex', justifyContent: 'space-between', marginTop: 16, lineHeight: 1.24 },
  giTitle: { fontWeight: 700, marginTop: 16, lineHeight: 1.24 },
  gi: { display: 'flex', gap: 6, lineHeight: 1.24 },
  giNum: { width: 28, textAlign: 'right', flexShrink: 0 },
  sectionTitle: { textAlign: 'center', fontWeight: 700, marginTop: 24, marginBottom: 4 },
  q: { display: 'flex', marginTop: 19, alignItems: 'flex-start' },
  qNum: { width: 26, flexShrink: 0 },
  qText: { flex: 1, textAlign: 'justify' },
  qMarks: { width: 42, textAlign: 'right', flexShrink: 0, marginLeft: 8 },
  passage: { textAlign: 'justify', marginTop: 4, marginBottom: 4, marginLeft: 26 },
  part: { display: 'flex', gap: 6 },
  partLabel: { width: 24, flexShrink: 0 },
  opt: { display: 'flex', gap: 6, marginLeft: 44 },
  optLabel: { width: 22, flexShrink: 0 },
  pageNum: { textAlign: 'center', marginTop: 26, fontSize: 11, color: '#333' },
};

function PaperHeader({ model }) {
  return (
    <div>
      {model.header.titleLines.map((line, i) => (
        <p key={i} style={paperStyles.headerLine}>
          {line.text}
        </p>
      ))}
      {(model.header.timeAllowed || model.header.maximumMarks) && (
        <div style={paperStyles.timeRow}>
          <span>{model.header.timeAllowed ? `Time: ${model.header.timeAllowed}` : ''}</span>
          <span>{model.header.maximumMarks ? `Maximum Marks: ${model.header.maximumMarks}` : ''}</span>
        </div>
      )}
      {model.instructions.length > 0 && (
        <>
          <p style={paperStyles.giTitle}>{model.instructionsHeading || 'General Instructions :'}</p>
          {model.instructions.map((inst, i) => (
            <div key={i} style={paperStyles.gi}>
              <span style={paperStyles.giNum}>{i + 1}.</span>
              <span>{inst}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function OptionRow({ opt, oi, count, sub = false, style: labelStyle = 'roman' }) {
  return (
    <div style={sub ? { ...paperStyles.opt, marginLeft: 72 } : paperStyles.opt}>
      <span style={paperStyles.optLabel}>{optionLabels(count, labelStyle)[oi]}</span>
      <span>{opt}</span>
    </div>
  );
}

function PaperQuestion({ q, optionStyle = 'roman' }) {
  return (
    <div>
      <div style={paperStyles.q}>
        <span style={paperStyles.qNum}>{q.numberText}</span>
        <span style={paperStyles.qText}>{q.text}</span>
        {q.marksText && <span style={paperStyles.qMarks}>{q.marksText}</span>}
      </div>
      {q.passage && <div style={paperStyles.passage}>{q.passage}</div>}
      {q.subParts.map((part, i) => (
        <div key={`part-${i}`}>
          <div style={paperStyles.part}>
            <span style={paperStyles.partLabel}>{part.label}</span>
            <span>{part.text}</span>
          </div>
          {(part.options || []).map((opt, oi) => (
            <OptionRow key={`popt-${oi}`} opt={opt} oi={oi} count={part.options.length} sub style={optionStyle} />
          ))}
        </div>
      ))}
      {q.options.map((opt, i) => (
        <OptionRow key={`opt-${i}`} opt={opt} oi={i} count={q.options.length} style={optionStyle} />
      ))}
      {q.columns && q.columns.left.length > 0 && q.columns.right.length > 0 && (
        <div style={{ display: 'flex', gap: 20, marginLeft: 26, marginTop: 4 }}>
          <div style={{ flex: 1 }}>
            {q.columns.left.map((c, i) => (
              <div key={`cl-${i}`} style={paperStyles.part}>
                <span style={paperStyles.partLabel}>{String.fromCharCode(97 + (i % 26))})</span>
                <span>{c}</span>
              </div>
            ))}
          </div>
          <div style={{ flex: 1 }}>
            {q.columns.right.map((c, i) => (
              <div key={`cr-${i}`} style={paperStyles.part}>
                <span style={paperStyles.partLabel}>{i + 1}.</span>
                <span>{c}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {q.choices.map((choice, ci) => (
        <div key={`choice-${ci}`}>
          <div style={{ ...paperStyles.part, marginLeft: 24 }}>
            <span style={paperStyles.partLabel}>{choice.label}</span>
            <span>{choice.text}</span>
          </div>
          {(choice.subParts || []).map((sp, j) => (
            <div key={`csp-${j}`} style={paperStyles.part}>
              <span style={paperStyles.partLabel}>{sp.label}</span>
              <span>{sp.text}</span>
            </div>
          ))}
          {ci < q.choices.length - 1 && (
            <div style={{ margin: '2px 0 2px 48px', fontStyle: 'italic' }}>OR</div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   App
───────────────────────────────────────────────────────────── */

export default function App() {
  const [file, setFile] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [settings, setSettings] = useState({ class: '10', difficulty: 'Medium', questionCount: 5 });
  const [subject, setSubject] = useState(DEFAULT_SUBJECT);
  const [format, setFormat] = useState(loadStoredFormat);
  // LOCKED structural blueprint of the uploaded reference paper (server-extracted).
  // When present, generation preserves the reference structure (types, marks,
  // item counts, sections) and only regenerates CONTENT.
  const [blueprint, setBlueprint] = useState(null);
  // UNIVERSAL visual template of the uploaded reference (server template analyzer).
  // Auto-fills the paper header/instructions format below; blueprint ≠ template
  // (structure vs visual) — they stay separate states.
  const [template, setTemplate] = useState(null);

  // Two-step flow: idle → uploading → analyzing → confirm → generating → review
  const [phase, setPhase] = useState('idle');
  const [jobId, setJobId] = useState(null);
  const [availableUnits, setAvailableUnits] = useState([]);
  const [slotProgress, setSlotProgress] = useState([]);
  const [notesMsg, setNotesMsg] = useState('');
  const [progress, setProgress] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const [pageIndex, setPageIndex] = useState(0);
  const [zoom, setZoom] = useState(100);
  const [pageH, setPageH] = useState(900);

  // Derived phase flags for the two-step flow (analyze → confirm → generate).
  const analyzing = phase === 'uploading' || phase === 'analyzing';
  const generating = phase === 'generating';
  const showConfirm = (phase === 'confirm' || generating) && !!blueprint;
  const busy = analyzing || generating;

  const fileInputRef = useRef(null);
  const pageRef = useRef(null);

  // Persist the last-used paper format so each school's look is reused.
  useEffect(() => {
    try {
      localStorage.setItem(FORMAT_STORAGE_KEY, JSON.stringify(format));
    } catch {
      /* storage full/blocked — ignore */
    }
  }, [format]);

  const model = useMemo(
    () =>
      result && result.questions && result.questions.length > 0
        ? buildPaperModel({ questions: result.questions, blueprint, settings, subject, format })
        : null,
    [result, blueprint, settings, subject, format]
  );
  // Dev diagnostics (never secrets): blueprint vs rendered structure/order.
  useEffect(() => {
    if (!model || !blueprint) return;
    console.log('[Render] blueprintSections:', (blueprint.sections || []).map((s) => s.name || s.title));
    console.log('[Render] blueprintQuestionOrder:', (blueprint.questions || []).map((q) => q.label || q.number));
    console.log('[Render] rendererSections:', model.sections.map((s) => s.label));
    console.log('[Render] rendererQuestionOrder:', [
      ...model.sections.flatMap((s) => s.questions),
      ...model.unsectionedQuestions,
    ].map((q) => q.numberText));
    if (model.layoutWarnings && model.layoutWarnings.length > 0) {
      console.warn('[Render] layoutWarnings:', model.layoutWarnings);
    }
  }, [model, blueprint]);
  const pages = useMemo(() => (model ? paginatePaper(model) : []), [model]);
  const hasPaper = pages.length > 0;

  // Live elapsed timer while the pipeline runs (analyze or generate)
  useEffect(() => {
    if (!busy) return;
    const start = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed(Math.round((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [busy]);

  // Per-slot generation progress (server job store) — best-effort polling.
  useEffect(() => {
    if (phase !== 'generating' || !jobId) return;
    let stopped = false;
    const poll = async () => {
      try {
        const res = await paperService.status(jobId);
        if (!stopped && Array.isArray(res.slots)) setSlotProgress(res.slots);
      } catch (_e) {
        /* progress is cosmetic; never fail generation because of it */
      }
    };
    poll();
    const id = setInterval(poll, 4000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [phase, jobId]);

  // Measure the current page height so zoom scaling keeps the wrapper sized correctly
  useLayoutEffect(() => {
    if (pageRef.current) setPageH(pageRef.current.offsetHeight);
  }, [pageIndex, zoom, result]);

  const selectFile = (selected) => {
    setError(null);
    if (!selected) return;
    if (!/\.pdf$/i.test(selected.name)) {
      setError('Only PDF files are supported. Please choose a PDF file.');
      return;
    }
    if (selected.size > MAX_FILE_SIZE) {
      setError('This file exceeds the 15 MB maximum size.');
      return;
    }
    setFile(selected);
    setSubject(deriveSubject(selected.name));
    setResult(null);
    setBlueprint(null);
    setTemplate(null);
    setJobId(null);
    setAvailableUnits([]);
    setSlotProgress([]);
    setPhase('idle');
    setNotesMsg('');
    setPageIndex(0);
    setZoom(100);
  };

  const clearFile = () => {
    setFile(null);
    setError(null);
    setResult(null);
    setBlueprint(null);
    setTemplate(null);
    setJobId(null);
    setAvailableUnits([]);
    setSlotProgress([]);
    setPhase('idle');
    setNotesMsg('');
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    selectFile(e.dataTransfer?.files?.[0]);
  };

  /**
   * STEP 1 — Analyze: upload the PDF, ingest it into the past-paper corpus
   * (embed + index into Qdrant, skipped when this exact PDF is already there),
   * then POST /papers/analyze to get { jobId, blueprint, availableUnits }.
   * Generation does NOT happen here — the teacher first reviews the locked
   * blueprint and assigns units on the confirm screen.
   */
  const handleAnalyze = async () => {
    if (busy) return;
    setError(null);

    if (!file) {
      setError('Please upload a previous-year question paper (PDF) first.');
      return;
    }

    setResult(null);
    setBlueprint(null);
    setTemplate(null);
    setJobId(null);
    setAvailableUnits([]);
    setSlotProgress([]);
    setPageIndex(0);
    setZoom(100);
    setPhase('uploading');

    try {
      // 1) Upload PDF to Cloudinary
      setProgress('Uploading PDF…');
      const uploadRes = await paperService.upload(file);
      const fileUrl = uploadRes.data.file.url;
      const sourceDocumentId = uploadRes.data.file.publicId;

      // 1b) Content hash (SHA-256 of the PDF bytes) → source reuse: if this
      // exact PDF is already embedded+indexed in Qdrant, skip re-ingestion.
      let sourceHash = null;
      try {
        const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
        sourceHash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
      } catch (_e) {
        sourceHash = null; // hash is an optimization; never block the flow on it
      }
      const alreadyIndexed = sourceHash
        ? (await paperService.checkIndexed({ sourceHash })).data?.indexed === true
        : false;

      // 2) Extract structured questions (server auto-falls back to local OCR
      // for scanned PDFs). Also yields the reference visual template.
      setProgress('Extracting questions…');
      const extractRes = await paperService.extractQuestions({ fileUrl });
      const questions = Array.isArray(extractRes.data.questions) ? extractRes.data.questions : [];
      const usedOcr = extractRes.data?.extractionMethod === 'ocr';

      // No recognizable questions → nothing to ground the past-paper corpus on
      // and nothing for /analyze to build a blueprint from. Stop with a clear
      // message instead of firing a doomed embed call (which 400s on []).
      if (questions.length === 0) {
        setError(
          'No questions could be read from this PDF. It needs standard question numbering ' +
          '(e.g. "Q1.", "1.", "Section A"). Try a clearer previous-year paper.'
        );
        setPhase('idle');
        return;
      }

      // UNIVERSAL visual TEMPLATE of the reference: auto-fill the paper header /
      // instructions format from it (structure stays blueprint-driven). Only
      // applied when the server detected values; teacher edits always win later.
      const tpl = extractRes.data?.template ?? null;
      setTemplate(tpl && (tpl.header || tpl.instructions || tpl.options) ? tpl : null);
      if (tpl) setFormat((f) => templateToFormat(tpl, f));

      // 3-4) Embed + index (skipped entirely when this PDF is already in the store)
      if (alreadyIndexed) {
        setProgress('Source paper already indexed — skipping embedding.');
      } else {
        setProgress(usedOcr
          ? `Scanned paper detected — ${questions.length} question(s) extracted via OCR. Embedding…`
          : `Embedding ${questions.length} questions…`);
        const embedRes = await paperService.embedQuestions({ questions, fileUrl, sourceHash });

        setProgress('Indexing questions…');
        await paperService.indexQuestions({
          questions: embedRes.data.questions,
          sourceDocumentId,
          sourceHash,
          class: settings.class,
          subject,
          fileUrl,
        });
      }

      // 5) Analyze: locked blueprint + syllabus unit list for the confirm step.
      setProgress('Analyzing reference paper…');
      const analysis = await paperService.analyze({ fileUrl, class: settings.class, subject });
      if (!analysis?.blueprint || !Array.isArray(analysis.blueprint.questions) || analysis.blueprint.questions.length === 0) {
        setError('Could not extract a usable structure from this paper. Try a clearer PDF.');
        setPhase('idle');
        return;
      }
      setBlueprint(analysis.blueprint);
      setJobId(analysis.jobId);
      setAvailableUnits(Array.isArray(analysis.availableUnits) ? analysis.availableUnits : []);
      setPhase('confirm');
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Something went wrong. Please try again.');
      setPhase('idle');
    } finally {
      setProgress('');
    }
  };

  /**
   * STEP 2 — Generate: POST /papers/:jobId/generate with the (possibly
   * teacher-corrected) blueprint, difficulty and the slotUnitMap built on the
   * confirm screen. Everything travels in the body — no server-side state.
   */
  const handleConfirmGenerate = async (slotUnitMap) => {
    if (!jobId || !blueprint) return;
    setError(null);
    setPhase('generating');
    setProgress('Generating questions with AI…');

    try {
      const genRes = await paperService.generate(jobId, {
        blueprint,
        class: settings.class,
        subject,
        difficulty: settings.difficulty,
        slotUnitMap,
      });
      setResult(genRes.data);
      setPhase('review');
      setPageIndex(0);
      setZoom(100);
    } catch (err) {
      const data = err?.response?.data;
      // 422 = slotUnitMap contract failure — show which slots to fix and stay
      // on the confirm screen so the teacher can correct them.
      const detail = Array.isArray(data?.errors) && data.errors.length > 0
        ? ` (${data.errors.slice(0, 3).join('; ')})`
        : '';
      setError((data?.message || err?.message || 'Generation failed. Please try again.') + detail);
      setPhase('confirm');
    } finally {
      setProgress('');
      setSlotProgress([]);
    }
  };

  /** Upload notes for one syllabus unit, then refresh the unit list. */
  const handleAddNotes = async (unit, newFile) => {
    if (!newFile) return;
    const cls = String(settings.class).trim();
    const subj = String(subject).trim();
    if (!subj) {
      setError('Set the Subject in Paper Settings before uploading notes — notes are filed under (class, subject, unit).');
      return;
    }
    setNotesMsg('');
    const form = new FormData();
    form.append('file', newFile);
    form.append('class', cls);
    form.append('subject', subj);
    form.append('unit', unit);
    try {
      const res = await kbService.uploadNotes(form);
      const d = res?.data || {};
      setNotesMsg(
        d.reused
          ? `"${unit}" — these exact notes are already indexed (${d.chunkCount ?? '?'} chunks).`
          : `"${unit}" — indexed ${d.indexedCount ?? d.chunkCount ?? '?'} note chunk(s) for Class ${cls} · ${subj}.`
      );
      const list = await kbService.listUnits({ class: cls, subject: subj });
      setAvailableUnits(Array.isArray(list.data) ? list.data : []);
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Notes upload failed. Please try again.');
    }
  };

  const paperBlobArgs = () => ({ questions: result.questions, blueprint, settings, subject, format });

  const openPdf = async () => {
    if (!hasPaper) return;
    try {
      setError(null);
      const blob = await createPaperPdfBlob(paperBlobArgs());
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch {
      setError('Could not generate the PDF. Please try again.');
    }
  };

  const downloadPdf = async () => {
    if (!hasPaper) return;
    try {
      setError(null);
      const blob = await createPaperPdfBlob(paperBlobArgs());
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = paperFileName(subject, settings);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch {
      setError('Could not generate the PDF. Please try again.');
    }
  };

  const printPaper = () => {
    if (!hasPaper) return;
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(buildPaperHtml({ questions: result.questions, blueprint, settings, subject, format, rejectedCount: result.rejected?.length ?? 0 }));
    doc.close();
    setTimeout(() => {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
      setTimeout(() => document.body.removeChild(iframe), 2000);
    }, 150);
  };

  const zoomIndex = ZOOM_LEVELS.indexOf(zoom);

  const fieldInputClass =
    'w-full h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors';

  return (
    <div className="min-h-screen bg-[#f8f9fa]">
      {/* ── Header ─────────────────────────────────────────── */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-indigo-200 bg-indigo-50">
              <BookOpenIcon className="text-indigo-600" size={19} />
            </div>
            <div>
              <p className="text-[15px] font-bold text-gray-900 leading-tight">PaperGen AI</p>
              <p className="text-xs text-gray-500 leading-tight">AI Question Paper Generator</p>
            </div>
          </div>
          <a href="#" className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 transition-colors">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-gray-300">
              <HelpCircleIcon size={15} />
            </span>
            Help
          </a>
        </div>
      </header>

      {/* ── Main ───────────────────────────────────────────── */}
      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-gray-900">Create New Question Paper</h1>
          <p className="mt-2 text-gray-500">
            Upload a previous-year question paper and generate a new question paper instantly.
          </p>
        </div>

        <div className="grid grid-cols-12 gap-6 items-start">
          {/* ── Left column ────────────────────────────────── */}
          <div className="col-span-12 lg:col-span-5 space-y-6">
            {/* 1. Upload */}
            <Card>
              <CardHeader icon={<FileTextIcon className="text-gray-500" size={19} />} title="1. Upload Previous Year Paper" />
              <p className="px-5 pt-1.5 text-[13px] text-gray-500">
                Upload a PDF file of the previous year question paper to get started.
              </p>

              <div className="p-5">
                {!file ? (
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => fileInputRef.current?.click()}
                    onKeyDown={(e) => e.key === 'Enter' && fileInputRef.current?.click()}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOver(true);
                    }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={handleDrop}
                    className={`border-2 border-dashed rounded-xl flex flex-col items-center justify-center py-10 px-6 text-center cursor-pointer transition-colors ${
                      dragOver ? 'border-blue-600 bg-blue-50' : 'border-blue-500 bg-[#f0f6ff] hover:bg-blue-50'
                    }`}
                  >
                    <CloudUploadIcon className="text-blue-500" size={42} strokeWidth={1.5} />
                    <p className="mt-3 text-[15px] font-medium text-gray-800">Drag &amp; drop your PDF here</p>
                    <p className="mt-1 text-sm text-gray-400">or</p>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        fileInputRef.current?.click();
                      }}
                      className="mt-3 bg-blue-700 hover:bg-blue-800 text-white text-sm font-medium px-5 py-2 rounded-lg transition-colors"
                    >
                      Choose PDF
                    </button>
                    <p className="mt-3 text-xs text-gray-400">PDF only • Maximum 15 MB</p>
                  </div>
                ) : (
                  <div className="flex items-center gap-3 border border-gray-200 rounded-lg bg-white px-3.5 py-3">
                    <FileTextIcon className="text-red-500 shrink-0" size={20} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-800 truncate">{file.name}</p>
                      <p className="text-xs text-gray-500">{formatSize(file.size)}</p>
                    </div>
                    <button
                      type="button"
                      onClick={clearFile}
                      title="Remove file"
                      className="text-red-500 hover:text-red-600 p-1 rounded transition-colors"
                    >
                      <TrashIcon size={18} />
                    </button>
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/pdf,.pdf"
                  className="hidden"
                  onChange={(e) => {
                    selectFile(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
              </div>
            </Card>

            {/* 2. Paper Settings */}
            <Card>
              <CardHeader icon={<SlidersIcon className="text-gray-500" size={19} />} title="2. Paper Settings" />
              <div className="p-5">
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="block text-[13px] font-medium text-gray-700 mb-1.5">Class</label>
                    <div className="relative">
                      <select
                        value={settings.class}
                        onChange={(e) => setSettings((s) => ({ ...s, class: e.target.value }))}
                        className={`${fieldInputClass} appearance-none pr-8`}
                      >
                        {CLASS_OPTIONS.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                      <ChevronDownIcon
                        size={15}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[13px] font-medium text-gray-700 mb-1.5">Subject</label>
                    <input
                      type="text"
                      value={subject}
                      onChange={(e) => setSubject(e.target.value)}
                      placeholder="e.g. Cloud Computing"
                      className={fieldInputClass}
                    />
                  </div>
                  <div>
                    <label className="block text-[13px] font-medium text-gray-700 mb-1.5">Number of Questions</label>
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={settings.questionCount}
                      onChange={(e) => {
                        const val = e.target.value;
                        setSettings((s) => ({
                          ...s,
                          questionCount: val === '' ? 1 : Math.min(20, Math.max(1, parseInt(val, 10) || 1)),
                        }));
                      }}
                      className={fieldInputClass}
                    />
                  </div>
                </div>

                <p className="mt-3 text-xs text-gray-500">
                  {blueprint
                    ? `Reference paper detected — structure (${blueprint.totalQuestions} question${blueprint.totalQuestions === 1 ? '' : 's'}, ${blueprint.totalMarks ?? '?'} marks) is locked to the uploaded paper.`
                    : 'You can generate between 1 to 20 questions.'}
                </p>
                {template && template.header && (template.header.schoolName || template.header.examTitle) && (
                  <p className="mt-1 text-[11.5px] text-emerald-700">
                    Reference template detected — paper header &amp; instructions auto-filled below
                    {template.header.schoolName ? ` from “${template.header.schoolName}”` : ''}; edit any field to override.
                  </p>
                )}

                {/* ── Exam paper format (dynamic template) ─────────── */}
                <div className="mt-5 border-t border-gray-100 pt-4">
                  <div className="flex items-center justify-between">
                    <label className="text-[13px] font-medium text-gray-700">Exam paper header &amp; format</label>
                    <button
                      type="button"
                      onClick={() => setFormat({ ...DEFAULT_PAPER_FORMAT })}
                      className="text-[12px] text-blue-700 hover:underline"
                    >
                      Reset to defaults
                    </button>
                  </div>
                  <p className="mt-0.5 text-[11.5px] text-gray-400">
                    Shown on the generated paper &amp; remembered for next time. Leave School blank to hide it.
                  </p>
                  <div className="mt-2.5 grid grid-cols-2 gap-3">
                    <div className="col-span-2">
                      <label className="block text-[11.5px] font-medium text-gray-500 mb-1">School / Institution name</label>
                      <input
                        type="text"
                        placeholder="e.g. Army Public School Shillong"
                        value={format.schoolName}
                        onChange={(e) => setFormat((f) => ({ ...f, schoolName: e.target.value }))}
                        className={fieldInputClass}
                      />
                    </div>
                    <div>
                      <label className="block text-[11.5px] font-medium text-gray-500 mb-1">Examination title</label>
                      <input
                        type="text"
                        placeholder="e.g. Annual Examination"
                        value={format.examTitle}
                        onChange={(e) => setFormat((f) => ({ ...f, examTitle: e.target.value }))}
                        className={fieldInputClass}
                      />
                    </div>
                    <div>
                      <label className="block text-[11.5px] font-medium text-gray-500 mb-1">Academic session</label>
                      <input
                        type="text"
                        placeholder="e.g. 2024-25"
                        value={format.session}
                        onChange={(e) => setFormat((f) => ({ ...f, session: e.target.value }))}
                        className={fieldInputClass}
                      />
                    </div>
                    <div>
                      <label className="block text-[11.5px] font-medium text-gray-500 mb-1">Time allowed</label>
                      <input
                        type="text"
                        placeholder="e.g. 2hrs 30mins"
                        value={format.timeAllowed}
                        onChange={(e) => setFormat((f) => ({ ...f, timeAllowed: e.target.value }))}
                        className={fieldInputClass}
                      />
                    </div>
                    <div>
                      <label className="block text-[11.5px] font-medium text-gray-500 mb-1">Maximum marks</label>
                      <input
                        type="text"
                        placeholder="Auto (sum of marks)"
                        value={format.maximumMarks}
                        onChange={(e) => setFormat((f) => ({ ...f, maximumMarks: e.target.value }))}
                        className={fieldInputClass}
                      />
                    </div>
                    <div className="col-span-2">
                      <label className="block text-[11.5px] font-medium text-gray-500 mb-1">General instructions (one per line)</label>
                      <textarea
                        rows={3}
                        value={(format.instructions || []).join('\n')}
                        onChange={(e) => setFormat((f) => ({ ...f, instructions: e.target.value.split(/\n+/) }))}
                        className={`${fieldInputClass} h-auto py-2 resize-y`}
                      />
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleAnalyze}
                  disabled={busy}
                  className="mt-4 w-full h-11 inline-flex items-center justify-center gap-2 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-sm font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {analyzing ? (
                    <>
                      <span className="h-4 w-4 rounded-full border-2 border-white/60 border-t-white animate-spin" />
                      Analyzing paper…
                    </>
                  ) : (
                    <>
                      <SparklesIcon size={17} />
                      Analyze Reference Paper
                    </>
                  )}
                </button>

                {busy && (
                  <p className="mt-3 text-xs text-gray-500 flex items-center gap-2">
                    <span className="inline-block h-3 w-3 rounded-full border-2 border-blue-600 border-t-transparent animate-spin" />
                    {progress} {elapsed > 0 && `• ${elapsed}s`}
                  </p>
                )}
              </div>
            </Card>
          </div>

          {/* ── Right column ───────────────────────────────── */}
          <div className="col-span-12 lg:col-span-7">
            <Card className="min-h-[420px]">                <div className="flex items-center gap-2.5 px-5 pt-5">
                  {showConfirm ? (
                    <>
                      <CheckCircleIcon className="text-blue-600" size={19} />
                      <h2 className="text-[15px] font-semibold text-gray-900">3. Review Blueprint &amp; Assign Units</h2>
                    </>
                  ) : (
                    <>
                      <CheckCircleIcon className="text-green-600" size={19} />
                      <h2 className="text-[15px] font-semibold text-gray-900">3. Generated Question Paper</h2>
                    </>
                  )}
                </div>

                <div className="p-5">
                  {error && (
                    <div className="flex items-start gap-2.5 bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">
                      <AlertIcon size={17} className="shrink-0 mt-0.5" />
                      <span>{error}</span>
                    </div>
                  )}

                  {showConfirm && (
                    <div className="mt-4">
                      <p className="mb-2 text-[12px] text-gray-500">
                        Notes for this paper are filed under <span className="font-medium text-gray-700">Class {settings.class} · {subject || '(set a subject)'}</span>.
                        Upload notes for the same class &amp; subject or they will not appear.
                      </p>
                      {notesMsg && (
                        <p className="mb-2 rounded-md bg-emerald-50 border border-emerald-200 px-3 py-1.5 text-[12px] text-emerald-800">
                          {notesMsg}
                        </p>
                      )}
                      <ConfirmScreen
                        blueprint={blueprint}
                        units={availableUnits}
                        difficulty={settings.difficulty}
                        onDifficultyChange={(d) => setSettings((s) => ({ ...s, difficulty: d }))}
                        onAddNotes={handleAddNotes}
                        onGenerate={handleConfirmGenerate}
                        busy={generating}
                      />
                      {generating && slotProgress.length > 0 && (
                        <p className="mt-3 text-xs text-gray-500">
                          {slotProgress.filter((s) => s.state === 'accepted').length}/{slotProgress.length} question(s) accepted…
                        </p>
                      )}
                    </div>
                  )}

                  {!showConfirm && hasPaper && (
                  <>
                    <div className="flex items-center gap-2 bg-[#d1fae5] text-[#065f46] rounded-lg px-4 py-3 text-sm font-medium">
                      <CheckCircleIcon size={18} />
                      Your question paper has been generated successfully!
                    </div>
                    {result.rejected && result.rejected.length > 0 && (
                      <p className="mt-2 text-xs text-gray-500">
                        Note: {result.rejected.length} question(s) could not pass validation and were omitted.
                      </p>
                    )}

                    <div className="mt-4 flex justify-end gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          setResult(null);
                          setPhase('confirm');
                        }}
                        className="inline-flex items-center gap-2 border border-gray-300 text-gray-600 hover:bg-gray-50 rounded-lg px-4 py-2 text-sm font-medium transition-colors"
                      >
                        Back to Blueprint
                      </button>
                      <button
                        type="button"
                        onClick={openPdf}
                        className="inline-flex items-center gap-2 border border-blue-700 text-blue-700 hover:bg-blue-50 rounded-lg px-4 py-2 text-sm font-medium transition-colors"
                      >
                        <EyeIcon size={16} />
                        View Full PDF
                      </button>
                      <button
                        type="button"
                        onClick={downloadPdf}
                        className="inline-flex items-center gap-2 bg-blue-700 hover:bg-blue-800 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors"
                      >
                        <DownloadIcon size={16} />
                        Download PDF
                      </button>
                    </div>

                    {/* ── PDF-style viewer ─────────────────── */}
                    <div className="mt-4 rounded-xl overflow-hidden border border-gray-200">
                      <div className="bg-gray-800 h-11 flex items-center justify-between px-3">
                        <div className="flex items-center">
                          <FileTextIcon className="text-gray-400" size={17} />
                          <div className="h-4 w-px bg-gray-600 mx-2.5" />
                          <ToolbarButton title="Previous page" disabled={pageIndex === 0} onClick={() => setPageIndex((i) => Math.max(0, i - 1))}>
                            <ChevronUpIcon size={16} />
                          </ToolbarButton>
                          <ToolbarButton
                            title="Next page"
                            disabled={pageIndex >= pages.length - 1}
                            onClick={() => setPageIndex((i) => Math.min(pages.length - 1, i + 1))}
                          >
                            <ChevronDownIcon size={16} />
                          </ToolbarButton>
                          <div className="h-4 w-px bg-gray-600 mx-2.5" />
                          <span className="text-[13px] text-gray-300 tabular-nums">
                            {pageIndex + 1} / {pages.length}
                          </span>
                        </div>

                        <div className="flex items-center">
                          <ToolbarButton title="Zoom out" disabled={zoomIndex <= 0} onClick={() => setZoom(ZOOM_LEVELS[Math.max(0, zoomIndex - 1)])}>
                            <ZoomOutIcon size={15} />
                          </ToolbarButton>
                          <span className="text-[13px] text-gray-300 tabular-nums w-12 text-center">{zoom}%</span>
                          <ToolbarButton
                            title="Zoom in"
                            disabled={zoomIndex >= ZOOM_LEVELS.length - 1}
                            onClick={() => setZoom(ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, zoomIndex + 1)])}
                          >
                            <ZoomInIcon size={15} />
                          </ToolbarButton>
                        </div>

                        <div className="flex items-center">
                          <ToolbarButton title="Download PDF" onClick={downloadPdf}>
                            <DownloadIcon size={15} />
                          </ToolbarButton>
                          <ToolbarButton title="Print" onClick={printPaper}>
                            <PrinterIcon size={15} />
                          </ToolbarButton>
                          <ToolbarButton title="More">
                            <MoreIcon size={15} />
                          </ToolbarButton>
                        </div>
                      </div>

                      <div className="bg-gray-200 overflow-auto flex justify-center p-6" style={{ height: 520 }}>
                        <div style={{ width: (640 * zoom) / 100, height: (pageH * zoom) / 100 }}>
                          <div
                            ref={pageRef}
                            style={{
                              width: 640,
                              minHeight: 860,
                              transform: `scale(${zoom / 100})`,
                              transformOrigin: 'top left',
                            }}
                            className="bg-white shadow-lg"
                          >
                            <div style={{ padding: '46px 40px 40px 42px', ...paperCss }}>
                              {pages[pageIndex]?.header && model && <PaperHeader model={model} />}
                              {pages[pageIndex]?.items.map((item, idx) =>
                                item.kind === 'section' ? (
                                  <div key={`sec-${idx}`} style={paperStyles.sectionTitle}>
                                    {item.label}
                                  </div>
                                ) : (
                                  <PaperQuestion key={item.q.key || idx} q={item.q} optionStyle={format.mcqOptionLabelStyle || 'roman'} />
                                )
                              )}
                              {pages.length > 1 && <div style={paperStyles.pageNum}>{pageIndex + 1}</div>}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </>
                )}

                  {!showConfirm && !hasPaper && !error && (
                    <div className="mt-5 border-2 border-dashed border-gray-300 rounded-xl flex flex-col items-center justify-center py-16 px-6 text-center">
                      <FileTextIcon className="text-gray-300" size={44} strokeWidth={1.5} />
                      <p className="mt-3 text-sm text-gray-500">Your generated question paper will appear here.</p>
                    </div>
                  )}
                </div>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}