import { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { paperService, kbService, libraryService } from './services/api.js';
import AppShell from './components/AppShell.jsx';
import Dashboard from './components/Dashboard.jsx';
import MyPapers from './components/MyPapers.jsx';
import KnowledgeBase from './components/KnowledgeBase.jsx';
import SchoolTemplates from './components/SchoolTemplates.jsx';
import SettingsView from './components/SettingsView.jsx';
import AnswerKeyScreen from './components/AnswerKeyScreen.jsx';
import ConfirmScreen from './components/ConfirmScreen.jsx';
import GenerateChooser from './components/GenerateChooser.jsx';
import GeneratePaperA from './components/GeneratePaperA.jsx';
import PaperDetails from './components/PaperDetails.jsx';
import QuestionBuilder from './components/QuestionBuilder.jsx';
import ReviewPaper from './components/ReviewPaper.jsx';
import GenerationProgressDrawer from './components/GenerationProgressDrawer.jsx';
import { useGenerationSSE } from './services/useGenerationSSE.js';
import { saveActiveJob, getActiveJob, clearActiveJob } from './services/jobRecovery.js';
import { buildPaperModel, paginatePaper } from './services/paperLayout.js';
import { createPaperPdfBlob, paperFileName, createAnswerKeyPdfBlob, answerKeyFileName } from './services/paperPdf.js';
import { DEFAULT_PAPER_FORMAT, PAPER_LAYOUT, optionLabels, templateToFormat } from './services/paperTemplate.js';
import {
  paperFingerprints,
  staleSlots,
} from './services/staleness.js';
import { mergeRegeneratedResult } from './services/regenResult.js';

/* ─────────────────────────────────────────────────────────────
   Constants
───────────────────────────────────────────────────────────── */
const CLASS_OPTIONS = Array.from({ length: 12 }, (_, i) => String(i + 1));
const DEFAULT_SUBJECT = 'General';
const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15 MB

/* ─────────────────────────────────────────────────────────────
   Small helpers
───────────────────────────────────────────────────────────── */

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

const CheckCircleIcon = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="m9 12 2 2 4-4" />
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
  const [_template, setTemplate] = useState(null);

  // Two-step flow: choosing → (Mode A) idle → uploading → analyzing → confirm → generating → review
  //                          → (Mode B) details → building → confirm → generating → review
  // The app lands on 'choosing' (the mode chooser); picking a mode routes into
  // that mode's first screen.
  const [phase, setPhase] = useState('choosing');
  const [mode, setMode] = useState(null); // null | 'A' | 'B'
  const [manualMeta, setManualMeta] = useState({ class: '10', subject: '' });
  const [jobId, setJobId] = useState(null);
  const [availableUnits, setAvailableUnits] = useState([]);
  const [_slotProgress, setSlotProgress] = useState([]);
  const [notesMsg, setNotesMsg] = useState('');
  const [sessionNotesUploads, setSessionNotesUploads] = useState([]);
  const [progress, setProgress] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [initialAssign, setInitialAssign] = useState(null); // Mode B handoff
  const [activeJobId, setActiveJobId] = useState(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);

  const [view, setView] = useState('dashboard');
  const [answerKeyPaper, setAnswerKeyPaper] = useState(null);

  const [sseState, { cancel }] = useGenerationSSE(activeJobId, {
    blueprint,
    onComplete: async () => {
      clearActiveJob();
      if (!activeJobId) return;
      try {
        const statusRes = await paperService.status(activeJobId);
        if (statusRes && statusRes.result) {
          setResult(statusRes.result);
          setGeneratedFingerprint(paperFingerprints(blueprint));
          setPhase('review');
          setView('generate');
          setPageIndex(0);
          setZoom(100);
          try {
            libraryService.create({
              title: `${format?.examTitle || 'Annual Examination'} - ${subject || 'General'}`,
              class: settings.class || '10',
              subject: subject || 'General',
              totalMarks: blueprint?.totalMarks || 80,
              source: mode === 'B' ? 'manual' : 'reference',
              status: 'generated',
              blueprint,
              questions: statusRes.result.questions || [],
              slotUnitMap: {},
              rejectedCount: statusRes.result.rejected?.length || 0,
            }).catch(() => {});
          } catch {
            /* ignore background archiving */
          }
        } else {
          setError('Generation completed, but paper result was not found. Please try again.');
          setPhase('confirm');
        }
      } catch (err) {
        setError(err?.response?.data?.message || err?.message || 'Failed to fetch generated paper.');
        setPhase('confirm');
      }
    },
    onError: (err) => {
      clearActiveJob();
      const msg = err?.message || 'Generation failed. Please review errors and try again.';
      setError(msg);
      setPhase('confirm');
    },
    onCancelled: (data) => {
      clearActiveJob();
      setError(data?.message || 'Paper generation was cancelled.');
      setPhase('confirm');
    },
  });

  // Phase 2 — Milestone M7: Browser Refresh / Job Recovery
  useEffect(() => {
    const recoveredJobId = getActiveJob();
    if (!recoveredJobId) return;

    let isMounted = true;
    paperService.status(recoveredJobId)
      .then((statusRes) => {
        if (!isMounted) return;
        if (statusRes.status === 'running' || statusRes.status === 'queued') {
          setActiveJobId(recoveredJobId);
          setJobId(recoveredJobId);
          setIsDrawerOpen(true);
          setPhase('generating');
          setView('generate');
        } else if (statusRes.status === 'completed') {
          if (statusRes.result) {
            setResult(statusRes.result);
            setPhase('review');
            setView('generate');
            setPageIndex(0);
            setZoom(100);
          }
          clearActiveJob();
        } else if (statusRes.status === 'failed') {
          setError(statusRes.error?.message || statusRes.message || 'Previous generation job failed.');
          clearActiveJob();
        } else if (statusRes.status === 'cancelled') {
          setError('Previous generation job was cancelled.');
          clearActiveJob();
        } else {
          clearActiveJob();
        }
      })
      .catch((err) => {
        if (!isMounted) return;
        clearActiveJob();
        if (err?.response?.status === 404) {
          setError('Previous generation job expired or not found.');
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  // Mode B only: the structure stays editable after generation, so the
  // generated snapshot is captured once and compared to the current blueprint
  // on every render. Reused by the review screen AND the download warning, so
  // it lives here, not in the editor component.
  // `null` until a Mode B paper exists — Mode A papers never go stale.
  const [generatedFingerprint, setGeneratedFingerprint] = useState(null);

  const [pageIndex, setPageIndex] = useState(0);
  const [zoom, setZoom] = useState(100);
  const [_pageH, setPageH] = useState(900);

  // Mode B review + download: stale slots live here so both the review screen
  // and the download warning consume the same set.
  const staled = useMemo(
    () =>
      mode === 'B' && generatedFingerprint && blueprint
        ? staleSlots(generatedFingerprint, paperFingerprints(blueprint))
        : [],
    [mode, generatedFingerprint, blueprint]
  );
  const staledCount = staled.length;

  // Derived phase flags for the two-step flow (analyze → confirm → generate).
  const analyzing = phase === 'uploading' || phase === 'analyzing';
  const generating = phase === 'generating';
  const showConfirm = (phase === 'confirm' || generating) && !!blueprint;
  const showReview = !showConfirm && !!result && !!blueprint;
  const busy = analyzing || generating;
  // Mode B builder screens occupy the left column while active. ('choosing' is
  // its own top-level branch — mode is still null there — so it is not listed.)
  const modeBActive = mode === 'B' && ['details', 'building'].includes(phase);

  /** Mode B: the manual endpoint returned — same shape as analyze. */
  const handleManualCreated = ({ jobId: id, blueprint: bp, availableUnits: units2, assignments }) => {
    setError(null);
    setBlueprint(bp);
    setJobId(id);
    setAvailableUnits(Array.isArray(units2) ? units2 : []);
    setInitialAssign(assignments ?? null);
    setSettings((s) => ({ ...s, class: manualMeta.class || s.class }));
    // Mode B's subject comes from PaperDetails, not a filename — sync it so the
    // generate request and the notes-corpus label are the teacher's subject.
    setSubject(String(manualMeta.subject || '').trim() || DEFAULT_SUBJECT);
    setPhase('confirm');
    // NOTE: generatedFingerprint is NOT set here — see handleGenerate. At this
    // point there is no generated paper, so capturing now would snapshot an empty
    // state and every later unit assignment would look like a change.
  };

  /**
   * Wipe everything that belongs to one mode's run so the other mode starts
   * clean. Called on every mode switch and on "back to the chooser". `format`
   * survives on purpose — it is the paper's visual template (persisted to
   * localStorage), shared by both modes and not a per-run value.
   */
  const clearRunState = () => {
    setFile(null);
    setDragOver(false);
    setBlueprint(null);
    setTemplate(null);
    setJobId(null);
    setAvailableUnits([]);
    setInitialAssign(null);
    setResult(null);
    setGeneratedFingerprint(null);
    setSlotProgress([]);
    setNotesMsg('');
    setSessionNotesUploads([]);
    setProgress('');
    setError(null);
    setSubject(DEFAULT_SUBJECT);
    setPageIndex(0);
    setZoom(100);
    setActiveJobId(null);
    setIsDrawerOpen(false);
  };

  const chooseMode = (m) => {
    clearRunState();
    setMode(m);
    setPhase(m === 'B' ? 'details' : 'idle');
  };

  const resetToModeChoice = () => {
    clearRunState();
    setMode(null);
    setPhase('choosing');
  };

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

  // Per-slot generation progress (server job store) — polling fallback only when SSE is not active.
  useEffect(() => {
    if (phase !== 'generating' || !jobId || activeJobId) return;
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
  }, [phase, jobId, activeJobId]);

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
   *
   * MODE B FINGERPRINT TIMING (task §1):
   *   The generated-structure snapshot is captured HERE, on the generate response,
   *   not in handleManualCreated. Sequence:
   *     1. Mode B builder POSTs /papers/manual → handleManualCreated(
   *          { jobId, blueprint, availableUnits, assignments }
   *        )  → setsBlueprint, setJobId, setPhase('confirm').
   *        NO generatedFingerprint yet — there is no generated paper.
   *     2. Teacher lands on ConfirmScreen, assigns units, clicks Generate.
   *        ConfirmScreen calls onGenerate(buildSlotUnitMap(...)).
   *     3. App calls /papers/:jobId/generate with { blueprint, difficulty,
   *        slotUnitMap }.
   *     4. On the generate RESPONSE, App setsResult(...) AND
   *        setGeneratedFingerprint(paperFingerprints(blueprint)).
   *        From this point on, any later structural edit makes a slot stale.
   *     5. Phase moves to 'review'; ReviewPaper renders with staled/staledCount.
   *
   *   Why not in handleManualCreated: at that point there is no paper at all,
   *   so every later unit assignment would register as a change against an
   *   empty snapshot. By capturing after generation, the snapshot reflects the
   *   ACTUAL generated structure, and staleness only triggers on real edits.
   */
  const handleGenerate = async (slotUnitMap) => {
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
        async: true,
      });

      // Synchronous generation fallback (if server returned 200 OK directly with data)
      if (genRes?.data?.questions) {
        setResult(genRes.data);
        setGeneratedFingerprint(paperFingerprints(blueprint));
        setPhase('review');
        setPageIndex(0);
        setZoom(100);
        setIsDrawerOpen(false);
        return;
      }

      // Async generation: Server returned 202 with jobId
      const serverJobId = genRes?.jobId || jobId;
      saveActiveJob(serverJobId);
      setActiveJobId(serverJobId);
      setIsDrawerOpen(true);
    } catch (err) {
      const data = err?.response?.data;
      // The 422 body carries `errors: [{ slot, message }]`. Show each slot with
      // its message so the teacher can fix the one row named, instead of the
      // "[object Object]" that a bare join produced.
      const lines = Array.isArray(data?.errors)
        ? data.errors
            .map((e) => {
              if (typeof e === 'string') return e;
              if (e && e.message) return e.slot ? `${e.slot}: ${e.message}` : e.message;
              return null;
            })
            .filter(Boolean)
        : [];
      const detail = lines.length > 0 ? `\n• ${lines.join('\n• ')}` : '';
      setError((data?.message || err?.message || 'Generation failed. Please try again.') + detail);
      setPhase('confirm');
      setIsDrawerOpen(false);
    } finally {
      setProgress('');
      setSlotProgress([]);
    }
  };

  /**
   * Mode B only: regenerate ONE stale slot to clear its flag. The teacher may
   * edit several fields in a row, so we never auto-regenerate — each keystroke
   * would cost an LLM call and discard in-progress edits. Regenerate when ready.
   */
  const regenerateStaleSlot = async (slotKey) => {
    if (!jobId || !blueprint || mode !== 'B') return;
    try {
      const genRes = await paperService.generate(jobId, {
        blueprint,
        class: settings.class,
        subject,
        difficulty: settings.difficulty,
        slotUnitMap: { [slotKey]: { unit: null } },
      });
      // The server re-ran the whole paper (there is no single-slot endpoint);
      // its response already carries every slot in order. Render it as-is.
      setResult((prev) => mergeRegeneratedResult(prev, genRes.data));
      // Re-snapshot after the fresh content lands so the flag clears.
      setGeneratedFingerprint(paperFingerprints(blueprint));
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Regeneration failed. Please try again.');
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
      // Track this upload in the session so GeneratePaperA can show it
      setSessionNotesUploads((prev) => [
        ...prev,
        {
          id: `${unit}-${Date.now()}`,
          fileName: newFile.name,
          unit,
          chunkCount: d.indexedCount ?? d.chunkCount ?? null,
          reused: !!d.reused,
        },
      ]);
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
    // Mode B only: warn before downloading while any slot is structurally stale
    // (content written against the old structure). Do not block — a draft is a
    // legitimate thing to want — but do not let it pass unnoticed.
    if (mode === 'B' && staledCount > 0) {
      const confirmed = window.confirm(
        `${staledCount} question${staledCount === 1 ? '' : 's'} ha${staledCount === 1 ? 's' : 've'} changed since generation. ` +
        'The downloaded content will not match the current structure. Download anyway?'
      );
      if (!confirmed) return;
    }
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
    // Same staleness rule as download — a stale paper is a legitimate draft, but
    // it should not print without the teacher seeing the warning.
    if (mode === 'B' && staledCount > 0) {
      const confirmed = window.confirm(
        `${staledCount} question${staledCount === 1 ? '' : 's'} ha${staledCount === 1 ? 's' : 've'} changed since generation. ` +
        'The printed content will not match the current structure. Print anyway?'
      );
      if (!confirmed) return;
    }
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


  const handleOpenPaper = (paper) => {
    if (paper?.questions?.length > 0) {
      setBlueprint(paper.blueprint || null);
      setResult({ questions: paper.questions, rejected: [] });
      setSubject(paper.subject || DEFAULT_SUBJECT);
      setSettings((s) => ({ ...s, class: paper.class || '10' }));
      setMode(paper.source === 'manual' ? 'B' : 'A');
      setPhase('review');
      setView('generate');
      setPageIndex(0);
      setZoom(100);
    } else {
      setView('papers');
    }
  };

  const handleDownloadLibraryPaper = async (paper) => {
    if (!paper?.questions?.length) return;
    try {
      const blob = await createPaperPdfBlob({
        questions: paper.questions,
        blueprint: paper.blueprint,
        settings: { class: paper.class || '10' },
        subject: paper.subject || DEFAULT_SUBJECT,
        format,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = paperFileName(paper.subject || DEFAULT_SUBJECT, { class: paper.class || '10' });
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 100);
    } catch (e) {
      console.error('Failed to download paper from library', e);
    }
  };

  const handleDownloadAnswerKey = async (paper) => {
    if (!paper?.questions?.length) return;
    try {
      const blob = await createAnswerKeyPdfBlob({
        questions: paper.questions,
        blueprint: paper.blueprint,
        settings: { class: paper.class || '10' },
        subject: paper.subject || DEFAULT_SUBJECT,
        format,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = answerKeyFileName(paper.subject || DEFAULT_SUBJECT, { class: paper.class || '10' });
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 100);
    } catch (e) {
      console.error('Failed to download answer key', e);
    }
  };

  return (
    <AppShell
      view={view}
      wide={view === 'generate'}
      onNavigate={(targetView) => {
        if (targetView === 'generate' && view !== 'generate') {
          if (!mode) {
            setPhase('choosing');
          }
        }
        setView(targetView);
      }}
    >
      {view === 'dashboard' && (
        <Dashboard
          onStartModeA={() => {
            chooseMode('A');
            setView('generate');
          }}
          onStartModeB={() => {
            chooseMode('B');
            setView('generate');
          }}
          onNavigate={(target) => {
            if (target === 'generate-a') {
              chooseMode('A');
              setView('generate');
            } else if (target === 'generate-b') {
              chooseMode('B');
              setView('generate');
            } else {
              setView(target);
            }
          }}
          onOpenPaper={handleOpenPaper}
        />
      )}

      {view === 'generate' && phase === 'choosing' && (
        <GenerateChooser
          onSelectA={() => chooseMode('A')}
          onSelectB={() => chooseMode('B')}
          onManageNotes={() => setView('kb')}
        />
      )}

      {view === 'generate' && phase !== 'choosing' && (
        <div className="w-full space-y-4">
          {/* ── Mode breadcrumb bar ── */}
          {mode && (
            <div className="flex items-center justify-between bg-white rounded-xl border border-gray-200 px-4 py-3 shadow-xs">
              <button
                type="button"
                onClick={resetToModeChoice}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-600 hover:text-blue-600 transition-colors"
              >
                <span>← Change generation mode</span>
              </button>
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-blue-600" />
                <span className="text-xs font-semibold text-gray-800">
                  {mode === 'A' ? 'Mode A: Previous Year Paper' : 'Mode B: Custom Question Paper'}
                </span>
              </div>
            </div>
          )}

          {/* ── Mode A: full integrated UI from GeneratePaperA component ── */}
          {mode === 'A' && !showConfirm && !showReview && (
            <GeneratePaperA
              file={file}
              dragOver={dragOver}
              fileInputRef={fileInputRef}
              onPickFile={() => fileInputRef.current?.click()}
              onFileInput={(e) => { selectFile(e.target.files?.[0]); e.target.value = ''; }}
              onDrop={handleDrop}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onClearFile={clearFile}
              onAnalyze={handleAnalyze}
              analyzing={analyzing}
              generating={generating}
              progress={progress}
              elapsed={elapsed}
              blueprint={blueprint}
              format={format}
              classValue={settings.class}
              onClassChange={(v) => setSettings((s) => ({ ...s, class: v }))}
              classOptions={CLASS_OPTIONS}
              subjectValue={subject}
              onSubjectChange={setSubject}
              difficulty={settings.difficulty}
              onDifficultyChange={(d) => setSettings((s) => ({ ...s, difficulty: d }))}
              units={availableUnits}
              sessionNotesUploads={sessionNotesUploads}
              onAddNotes={handleAddNotes}
              notesMsg={notesMsg}
              onGenerate={handleGenerate}
              error={error}
            />
          )}

          {/* ── Mode B: details → builder ── */}
          {modeBActive && (
            <div className="w-full space-y-6">
              <div className="w-full min-w-0 space-y-6">
                {phase === 'details' && (
                  <PaperDetails
                    meta={manualMeta}
                    onChange={setManualMeta}
                    onBack={resetToModeChoice}
                    onNext={() => setPhase('building')}
                  />
                )}
                {phase === 'building' && (
                  <QuestionBuilder
                    paperMeta={manualMeta}
                    onCreated={handleManualCreated}
                    onCancel={() => setPhase('details')}
                  />
                )}
              </div>
            </div>
          )}

          {/* ── Confirm Screen (Mode B after builder, Mode A after analysis) ── */}
          {showConfirm && (
            <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-xs">
              <div className="flex items-center gap-2.5 mb-4">
                <CheckCircleIcon className="text-blue-600" size={19} />
                <h2 className="text-[15px] font-semibold text-gray-900">Review Blueprint &amp; Assign Units</h2>
              </div>
              {error && (
                <div className="flex items-start gap-2.5 bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm mb-4">
                  <AlertIcon size={17} className="shrink-0 mt-0.5" />
                  <span className="whitespace-pre-line">{error}</span>
                </div>
              )}
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
                onGenerate={handleGenerate}
                busy={generating}
                initialAssign={initialAssign}
                source={mode === 'B' ? 'manual' : 'reference'}
              />
              {generating && (
                <div className="mt-3 flex items-center justify-between p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs">
                  <span className="text-blue-900 font-medium">
                    {sseState?.currentMessage || `${Math.round(sseState?.progressPercent || 0)}% completed…`}
                  </span>
                  <button
                    type="button"
                    onClick={() => setIsDrawerOpen(true)}
                    className="font-semibold text-blue-700 hover:text-blue-900 underline cursor-pointer"
                  >
                    View Progress Details
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── Review Paper ── */}
          {showReview && (
            <ReviewPaper
              mode={mode}
              blueprint={blueprint}
              result={result}
              staled={staled}
              staledCount={staledCount}
              regenerateStaleSlot={regenerateStaleSlot}
              onDownload={downloadPdf}
              onPrint={printPaper}
              onOpen={openPdf}
              onBack={resetToModeChoice}
            />
          )}
        </div>
      )}

      {view === 'papers' && (
        answerKeyPaper ? (
          <AnswerKeyScreen
            record={answerKeyPaper}
            format={format}
            onBack={() => setAnswerKeyPaper(null)}
            onSave={async (updatedQs) => {
              try {
                await libraryService.patch(answerKeyPaper.id, { questions: updatedQs });
                setAnswerKeyPaper((p) => ({ ...p, questions: updatedQs, updatedAt: new Date().toISOString() }));
              } catch (e) {
                console.error('Failed to save answer key corrections', e);
              }
            }}
            onDownload={handleDownloadAnswerKey}
          />
        ) : (
          <MyPapers
            onCreateNew={() => {
              resetToModeChoice();
              setView('generate');
            }}
            onOpen={handleOpenPaper}
            onDownload={handleDownloadLibraryPaper}
            onDownloadAnswerKey={handleDownloadAnswerKey}
            onViewAnswerKey={(p) => setAnswerKeyPaper(p)}
          />
        )
      )}

      {view === 'kb' && <KnowledgeBase />}

      {view === 'templates' && <SchoolTemplates />}

      {view === 'settings' && <SettingsView />}

      {/* ── Real-Time Generation Progress Drawer (Phase 2 — M6 & M7) ── */}
      <GenerationProgressDrawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        sseState={sseState}
        onCancel={cancel}
        onViewPaper={() => {
          setIsDrawerOpen(false);
          setPhase('review');
          setView('generate');
        }}
      />
    </AppShell>
  );
}