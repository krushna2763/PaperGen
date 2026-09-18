import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  emptyQuestion, resizeItemMarks, questionTotal, paperTotal, rowIssues, buildFormPayload,
  DIFFICULTY_OPTIONS,
} from '../services/manualBlueprint.js';
import { FALLBACK_TYPES, defOf, isWholeMarks } from '../services/questionTypeFields.js';
import { kbService, manualService, templateService, questionService } from '../services/api.js';
import { questionTypeLabel } from '../services/questionTypeLabel.js';
import { searchKbDocuments, formatKbDate } from '../services/kbDocuments.js';

/**
 * Mode B — QuestionBuilder (step 2 of the manual flow).
 *
 * The teacher defines every question: type (from the server registry), item
 * count, per-item marks, topic (combobox: detected suggestions + free text +
 * inline coverage), difficulty, and a per-item unit assignment. On submit it
 * POSTs { blueprint: form } to /papers/manual and hands the analyze-shaped
 * response to the App, which continues into the EXISTING confirm + generate
 * steps. The hint fields describe what each item covers — the AI writes the
 * actual question from the indexed notes.
 *
 * Presentation over existing behaviour: the form model, the pure helpers in
 * manualBlueprint.js, and the submit contract are unchanged.
 */

const Svg = ({ d, size = 16, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
    {Array.isArray(d) ? d.map((p, i) => <path key={i} d={p} />) : <path d={d} />}
  </svg>
);
const IconBook = (p) => <Svg d={['M4 19.5A2.5 2.5 0 0 1 6.5 17H20', 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z']} {...p} />;
const IconEye = (p) => <Svg d={['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z']} {...p} />;
const IconSave = (p) => <Svg d={['M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z', 'M17 21v-8H7v8', 'M7 3v5h8']} {...p} />;
const IconChevron = (p) => <Svg d="m6 9 6 6 6-6" {...p} />;
const IconChevronR = (p) => <Svg d="m9 18 6-6-6-6" {...p} />;
const IconTrash = (p) => <Svg d={['M3 6h18', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6']} {...p} />;
const IconCopy = (p) => <Svg d={['M9 9h12v12H9z', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1']} {...p} />;
const IconPlus = (p) => <Svg d={['M12 5v14', 'M5 12h14']} {...p} />;
const IconGrip = (p) => <Svg d={['M9 6h.01', 'M9 12h.01', 'M9 18h.01', 'M15 6h.01', 'M15 12h.01', 'M15 18h.01']} {...p} />;
const IconInfo = (p) => <Svg d={['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z', 'M12 16v-4', 'M12 8h.01']} {...p} />;
const IconCheck = (p) => <Svg d="m20 6-11 11-5-5" {...p} />;
const IconWarn = (p) => <Svg d={['M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z', 'M12 9v4', 'M12 17h.01']} {...p} />;
const IconArrow = (p) => <Svg d={['M5 12h14', 'm12 5 7 7-7 7']} {...p} />;
const IconChart = (p) => <Svg d={['M3 3v18h18', 'M7 15l3-4 3 3 4-6']} {...p} />;
const IconBulb = (p) => <Svg d={['M9 18h6', 'M10 22h4', 'M15.1 14a5 5 0 1 0-6.2 0c.7.5 1 1.3 1.1 2h4c.1-.7.4-1.5 1.1-2Z']} {...p} />;
const IconUpload = (p) => <Svg d={['M12 13v8', 'm8 17 4-4 4 4', 'M20 16.7A5 5 0 0 0 18 7h-1.3A8 8 0 1 0 4 15.2']} {...p} />;
const IconSearch = (p) => <Svg d={['M21 21l-4.35-4.35', 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z']} {...p} />;
const IconRefresh = (p) => <Svg d={['M23 4v6h-6', 'M1 20v-6h6', 'M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15']} {...p} />;
const IconClose = (p) => <Svg d={['M18 6L6 18', 'M6 6l12 12']} {...p} />;

const IMAGE_ANSWER_TYPES = [
  { id: 'SHORT_ANSWER', label: 'Short Answer' },
  { id: 'MCQ', label: 'Multiple Choice (MCQ)' },
  { id: 'LONG_ANSWER', label: 'Long Answer' },
  { id: 'FILL_BLANK', label: 'Fill in the Blanks' },
  { id: 'TRUE_FALSE', label: 'True / False' },
  { id: 'DIFFERENCE_BETWEEN', label: 'Difference Between' },
];

const SECTION_TONES = [
  { badge: 'bg-blue-600', head: 'bg-blue-50/70 border-blue-100' },
  { badge: 'bg-emerald-600', head: 'bg-emerald-50/70 border-emerald-100' },
  { badge: 'bg-purple-600', head: 'bg-purple-50/70 border-purple-100' },
  { badge: 'bg-amber-600', head: 'bg-amber-50/70 border-amber-100' },
  { badge: 'bg-sky-600', head: 'bg-sky-50/70 border-sky-100' },
];

const field =
  'h-9 rounded-lg border border-gray-300 bg-white px-2.5 text-[12.5px] text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors';
const select = `${field} appearance-none pr-7`;
const marksInput = 'h-8 w-11 rounded-md border border-gray-300 bg-white text-center text-[12.5px] text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500/40';

const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
const letter = (i) => String.fromCharCode(97 + i);

export default function QuestionBuilder({ paperMeta, onCreated, onCancel, onManageNotes, initialRows = null, initialSections = null, initialTopicByLabel = null, initialAssign = null, isEditMode = false, staleCount = 0, staleSummary = [], onBackToReview = null }) {
  const cls = String(paperMeta.class ?? '').trim();
  const subject = String(paperMeta.subject ?? '').trim();

  /* ── topics: restore the live blueprint's topic anchors into row state ── */
  // keyed by label (Q1, Q2, …); the builder's rows carry `topic` and submit
  // folds it into referenceItems. Applied ONCE, right after mount, against the
  // seeded rows. Rows without a captured topic keep whatever the teacher set.
  const topicsSeededRef = useRef(false);
  useEffect(() => {
    if (topicsSeededRef.current || !initialTopicByLabel) return;
    topicsSeededRef.current = true;
    setRows((rs) => rs.map((r, i) => {
      const t = initialTopicByLabel[`Q${i + 1}`];
      return t != null && !r.topic ? { ...r, topic: t } : r;
    }));
  }, [initialTopicByLabel]);

  /* ── registry (server source of truth, offline fallback) ── */
  const [types, setTypes] = useState(FALLBACK_TYPES);
  useEffect(() => {
    let live = true;
    questionService.listTypes()
      .then((res) => { if (live && Array.isArray(res?.data) && res.data.length > 0) setTypes(res.data); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  /* ── indexed units (label resolution only — NEVER auto-applied) ── */
  // Fetched for (class, subject) so draft re-entry (isEditMode) can resolve
  // the labels of units a paper was ALREADY grounded in. The builder's unit
  // dropdowns never draw from this list directly — only from the explicit
  // source selection below.
  const [sessionUnits, setSessionUnits] = useState([]);
  useEffect(() => {
    let live = true;
    if (!cls || !subject) return undefined;
    kbService.listUnits({ class: cls, subject })
      .then((res) => { if (live) setSessionUnits(Array.isArray(res?.data) ? res.data : []); })
      .catch(() => {});
    return () => { live = false; };
  }, [cls, subject]);

  /* ── sections (exam title / max marks were set on step 1) ── */
  const [sections, setSections] = useState(Array.isArray(initialSections) && initialSections.length > 0 ? initialSections : []); // ['SECTION A', ...]
  const [newSection, setNewSection] = useState('');
  const [pickSection, setPickSection] = useState('');

  /* ── question rows ── */
  // PHASE 3: re-entry seeds the builder from the LIVE blueprint so a teacher
  // returning from Review edits their real structure (not an empty form).
  // NEW papers start EMPTY: no default "Unsectioned Q1" — the teacher adds a
  // section, then questions (spec: sections/questions are explicit steps).
  const [rows, setRows] = useState(() => (Array.isArray(initialRows) && initialRows.length > 0 ? initialRows : []));
  const [openRows, setOpenRows] = useState(() => new Set());
  const [variedRows, setVariedRows] = useState(() => new Set());
  const [collapsedSecs, setCollapsedSecs] = useState(() => new Set());

  /* ── templates (save only — the reference has no picker on this screen) ── */
  const [tplName, setTplName] = useState('');
  const [tplMsg, setTplMsg] = useState('');

  /* ── Add Syllabus Notes — EXPLICIT source selection ──
     The Knowledge Base is a repository, NOT the paper's grounding: nothing is
     used until the teacher picks "Upload from Device" or "Select from
     Knowledge Base". `source` drives everything: unit dropdowns, generation
     readiness, and the compact selected-source banner. NO SOURCE = NO NOTE
     DATA FOR GENERATION (units stay empty; submit stays blocked). */
  const [notesSource, setNotesSource] = useState(null); // null | 'upload' | 'knowledge_base'
  const [notesTab, setNotesTab] = useState('upload'); // which picker body is open
  // KB selection: { id, title, filename, class, subject, units, chunkCount, ingestedAt }
  const [kbDoc, setKbDoc] = useState(null);
  // KB picker state (loaded lazily, ONLY while the teacher is choosing)
  const [kbSearch, setKbSearch] = useState('');
  const [kbDocs, setKbDocs] = useState(null); // null = not loaded, [] = loaded empty
  const [kbLoading, setKbLoading] = useState(false);
  const [kbError, setKbError] = useState('');
  // Device-upload state (one paper may carry several uploaded note files)
  const [uploads, setUploads] = useState([]); // [{ id, fileName, fileSize, unitName, chunkCount, reused }]
  const [uploadUnitName, setUploadUnitName] = useState('');
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadErr, setUploadErr] = useState('');
  const notesFileRef = useRef(null);

  /** EVERY unit dropdown derives from the teacher's explicit source — nothing else.
   *  Draft re-entry exception (spec §18): a paper being EDITED keeps its own
   *  assigned units selectable even before the teacher re-picks a source, so
   *  re-opening a draft never blanks its existing unit assignments. */
  const units = useMemo(() => {
    let fromSource = [];
    if (notesSource === 'knowledge_base' && kbDoc) fromSource = kbDoc.units;
    else if (notesSource === 'upload') {
      // Uploaded files were tagged with explicit unit names at upload time.
      const seen = new Map();
      for (const u of uploads) {
        if (!seen.has(u.unitName)) seen.set(u.unitName, { id: u.unitName, label: u.unitName, chunkCount: u.chunkCount || 0 });
        else seen.get(u.unitName).chunkCount += u.chunkCount || 0;
      }
      fromSource = [...seen.values()];
    }
    const assignedIds = new Set();
    for (const v of Object.values(initialAssign || {})) {
      if (v?.unit != null) assignedIds.add(String(v.unit));
      for (const u of Object.values(v?.items || {})) if (u != null) assignedIds.add(String(u));
    }
    if (assignedIds.size === 0) return fromSource;
    const extras = sessionUnits.filter((u) => assignedIds.has(String(u.id)) && !fromSource.some((f) => String(f.id) === String(u.id)));
    return [...fromSource, ...extras];
  }, [notesSource, kbDoc, uploads, sessionUnits, initialAssign]);

  /** Load KB documents ONLY when the picker is opened (explicit choice). */
  useEffect(() => {
    if (notesSource !== 'knowledge_base' || kbDocs) return;
    let live = true;
    setKbLoading(true);
    kbService.listDocuments({ class: cls, subject })
      .then((res) => { if (live) setKbDocs(Array.isArray(res?.data) ? res.data : []); })
      .catch(() => { if (live) { setKbDocs([]); setKbError('Could not load Knowledge Base notes.'); } })
      .finally(() => { if (live) setKbLoading(false); });
    return () => { live = false; };
  }, [notesSource, cls, subject, kbDocs]);

  /* ── extracted images + topics for Image Based questions ── */
  const [notesImagesData, setNotesImagesData] = useState({ topics: [], images: [], totalImages: 0 });
  const [loadingImages, setLoadingImages] = useState(false);

  useEffect(() => {
    let live = true;
    const hasSource = (notesSource === 'knowledge_base' && !!kbDoc) || (uploads.length > 0);
    
    // Strict source isolation: NO SELECTED NOTES -> NO IMAGE TOPICS -> NO IMAGES
    if (!hasSource) {
      setNotesImagesData({ topics: [], images: [], totalImages: 0 });
      setLoadingImages(false);
      return undefined;
    }

    async function loadImages() {
      let sourceHashes = [];
      if (notesSource === 'knowledge_base' && kbDoc?.id) {
        sourceHashes.push(kbDoc.id);
      } else if (uploads.length > 0) {
        uploads.forEach((u) => {
          if (u.sourceHash) sourceHashes.push(u.sourceHash);
        });

        // Fallback resolution if sourceHash was not in upload object
        if (sourceHashes.length === 0) {
          try {
            const kbList = await kbService.listDocuments({ class: cls, subject });
            const docs = Array.isArray(kbList?.data) ? kbList.data : [];
            for (const u of uploads) {
              const matched = docs.find((d) => d.fileName === u.fileName || d.title === u.fileName);
              if (matched && (matched.id || matched.sourceHash)) {
                sourceHashes.push(matched.id || matched.sourceHash);
              }
            }
          } catch {
            /* ignore */
          }
        }
      }

      if (!live) return;
      if (sourceHashes.length === 0) {
        setNotesImagesData({ topics: [], images: [], totalImages: 0 });
        setLoadingImages(false);
        return;
      }

      setLoadingImages(true);
      const params = {
        sourceHash: sourceHashes.join(','),
      };
      if (cls) params.class = cls;
      if (subject) params.subject = subject;

      try {
        const res = await kbService.listNotesImages(params);
        if (live && res?.data) {
          setNotesImagesData(res.data);
        }
      } catch {
        if (live) setNotesImagesData({ topics: [], images: [], totalImages: 0 });
      } finally {
        if (live) setLoadingImages(false);
      }
    }

    loadImages();
    return () => { live = false; };
  }, [notesSource, kbDoc, uploads, cls, subject]);

  // Clear any selected images/topics if notes source is cleared/removed
  useEffect(() => {
    const hasSource = notesSource === 'knowledge_base' ? !!kbDoc : notesSource === 'upload' ? uploads.length > 0 : false;
    if (!hasSource) {
      setRows((prev) => prev.map((r) => {
        if (r.type === 'IMAGE_BASED' && (r.selectedImage || r.imageTopic)) {
          return { ...r, selectedImage: null, imageAssets: [], imageTopic: '', topic: '' };
        }
        return r;
      }));
    }
  }, [notesSource, kbDoc, uploads]);

  const switchSource = (next) => {
    setNotesSource(next);
    setNotesTab(next === 'knowledge_base' ? 'kb' : 'upload');
    setUploadErr('');
  };

  /** Teacher clicked [Use Notes] on a KB document — it becomes the paper's source. */
  const applyKbDoc = (doc) => {
    setKbDoc(doc || null);
    if (doc) setNotesSource('knowledge_base');
  };

  /** "2.4 MB" / "315 KB" — sizes shown on the uploaded-file cards. */
  const formatSize = (bytes) => {
    if (!bytes) return '';
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const doNotesUpload = async (file) => {
    if (!file) return;
    const unitName = uploadUnitName.trim();
    if (!unitName) { setUploadErr('Enter a unit name before uploading.'); return; }
    if (!cls || !subject) { setUploadErr('Class and subject are required.'); return; }
    setUploadBusy(true); setUploadErr('');
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('class', cls);
      form.append('subject', subject);
      form.append('unit', unitName);
      const res = await kbService.uploadNotes(form);
      const d = res?.data || {};
      setUploads((prev) => [
        ...prev,
        {
          id: `${file.name}-${Date.now()}`,
          fileName: file.name,
          fileSize: file.size,
          unitName,
          chunkCount: d.indexedCount ?? d.chunkCount ?? 0,
          reused: !!d.reused,
          sourceHash: d.sourceHash || '',
        },
      ]);
      setNotesSource('upload');
      setUploadUnitName('');
    } catch (err) {
      setUploadErr(err?.response?.data?.message || err?.message || 'Upload failed.');
    } finally {
      setUploadBusy(false);
    }
  };

  /* ── submission ── */
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [slotErrors, setSlotErrors] = useState([]);
  const [warnings, setWarnings] = useState([]);

  const updateRow = (i, patch) => setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const changeType = (i, typeId) => {
    const def = defOf(types, typeId);
    setRows((rs) => rs.map((r, idx) => {
      if (idx !== i) return r;
      const whole = isWholeMarks(def);
      return {
        ...r,
        type: typeId,
        itemCount: def?.countMin === 2 && r.itemCount < 2 ? 2 : r.itemCount,
        marksMode: whole ? 'whole' : 'perItem',
        optionCount: def?.optionMode === 'required' ? 4 : r.optionCount,
      };
    }));
  };

  const changeItemCount = (i, count) => {
    setRows((rs) => rs.map((r, idx) => {
      if (idx !== i) return r;
      const def = defOf(types, r.type);
      const min = Math.max(1, def?.countMin ?? 1);
      const c = Math.max(min, Math.round(Number(count) || min));
      return { ...r, itemCount: c, itemMarks: resizeItemMarks(r.itemMarks, c, r.uniformMarks) };
    }));
  };

  const addRow = (section = null) => {
    setRows((rs) => {
      setOpenRows((o) => new Set(o).add(rs.length));
      return [...rs, emptyQuestion(section ?? sections[0] ?? null)];
    });
  };
  const duplicateRow = (i) => setRows((rs) => [...rs.slice(0, i + 1), { ...rs[i] }, ...rs.slice(i + 1)]);
  const removeRow = (i) => setRows((rs) => (rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs));

  /** First free name: SECTION A, B, … (used when the teacher types nothing). */
  const nextSectionName = (secs) => {
    for (const l of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const n = `SECTION ${l}`;
      if (!secs.includes(n)) return n;
    }
    return `SECTION ${secs.length + 1}`;
  };

  const addSection = () => {
    // Empty input → auto-name (SECTION A, then B, …). The empty state's button
    // relies on this so one click creates the first section.
    const name = newSection.trim().toUpperCase() || nextSectionName(sections);
    if (sections.includes(name)) return;
    setSections((s) => [...s, name]);
    setNewSection('');
  };

  /* ── per-question / per-item unit assignment ───────────────── */
  const [assign, setAssign] = useState({});
  useEffect(() => {
    setAssign((prev) => {
      const next = {};
      rows.forEach((_, i) => {
        const key = `Q${i + 1}`;
        // PHASE 3: re-entry must PRESERVE the paper's own assignments — the
        // seed preference is (already-set in this session) > (paper's
        // slotUnitMap via initialAssign) > first available unit. Without the
        // paper's map, an untouched slot's unit silently resets to the first
        // unit (or null before units load), corrupting the unit-staleness
        // dimension on the next structural edit.
        const paper = initialAssign?.[key];
        if (prev[key] != null) next[key] = prev[key];
        else if (paper?.unit != null) next[key] = { unit: paper.unit, items: { ...paper.items } };
        else if (paper?.items != null && Object.keys(paper.items).length > 0) next[key] = { unit: null, items: { ...paper.items } };
        else next[key] = { unit: units[0]?.id ?? null, items: {} };
      });
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length, units]);

  const itemUnits = (key, count) => {
    const a = assign[key] || {};
    return Array.from({ length: count }, (_, li) => a.items?.[letter(li)] ?? a.unit ?? null);
  };
  /** Label for a unit id: the selected source's units first, then draft/session history (edit mode). */
  const unitLabel = (id) =>
    units.find((u) => String(u.id) === String(id))?.label
    ?? sessionUnits.find((u) => String(u.id) === String(id))?.label
    ?? null;
  const rowUnitSummary = (key, count) => {
    const vals = itemUnits(key, count);
    if (vals.some((v) => v == null)) return vals.every((v) => v == null) ? 'Unassigned' : 'Mixed units';
    return new Set(vals).size > 1 ? 'Mixed units' : unitLabel(vals[0]);
  };
  const isMixedRow = (key, count) => {
    const vals = itemUnits(key, count);
    return new Set(vals.map(String)).size > 1;
  };
  const setWholeUnit = (key, unitId) => setAssign((m) => ({ ...m, [key]: { unit: unitId || null, items: {} } }));
  const setItemUnit = (key, li, count, unitId) => {
    setAssign((m) => {
      const a = m[key] || { unit: null, items: {} };
      const items = { ...a.items };
      Array.from({ length: count }, (_, k) => { if (items[letter(k)] == null) items[letter(k)] = a.unit ?? null; });
      items[letter(li)] = unitId || null;
      const vals = Array.from({ length: count }, (_, k) => items[letter(k)]);
      const uniform = vals.every((v) => v != null) && new Set(vals.map(String)).size === 1;
      return { ...m, [key]: uniform ? { unit: vals[0], items: {} } : { unit: a.unit, items } };
    });
  };

  /* ── topic suggestions + inline coverage ─────────────────── */
  const [topicsCache, setTopicsCache] = useState({});
  const [coverage, setCoverage] = useState({});
  const unitForRow = (i) => assign[`Q${i + 1}`]?.unit ?? units[0]?.id ?? null;

  const loadTopics = async (unit) => {
    if (!unit || topicsCache[unit]) return;
    setTopicsCache((c) => ({ ...c, [unit]: 'pending' }));
    try {
      const res = await kbService.listTopics({ class: cls, subject, unit });
      setTopicsCache((c) => ({ ...c, [unit]: Array.isArray(res?.data) ? res.data : [] }));
    } catch {
      setTopicsCache((c) => ({ ...c, [unit]: [] }));
    }
  };
  const checkCoverage = async (i, topic) => {
    const unit = unitForRow(i);
    if (!topic.trim() || !unit) return;
    setCoverage((c) => ({ ...c, [i]: 'pending' }));
    try {
      const res = await kbService.topicCoverage({ class: cls, subject, unit, topic: topic.trim() });
      setCoverage((c) => ({ ...c, [i]: res?.data ?? { matched: false, chunkCount: 0 } }));
    } catch {
      setCoverage((c) => ({ ...c, [i]: { matched: null, chunkCount: 0 } }));
    }
  };

  /* ── templates ── */
  const paperHeader = () => ({ class: cls, subject, examTitle: null, maximumMarks: null, duration: null });
  const sectionObjs = () => sections.map((name) => ({
    name, title: null,
    questionNumbers: rows.map((r, i) => (r.section === name ? `Q${i + 1}` : null)).filter(Boolean),
  }));

  const saveAsTemplate = async (nameArg) => {
    setTplMsg('');
    const name = String(nameArg ?? tplName).trim();
    if (!name) { setTplMsg('Give the template a name first.'); return; }
    try {
      await templateService.save({ name, blueprint: buildFormPayload({ paper: paperHeader(), sections: sectionObjs(), questions: rows }) });
      setTplName('');
      setTplMsg('Template saved (structure only — units & topics stay yours to choose each time).');
    } catch (err) {
      setTplMsg(err?.response?.data?.message || 'Could not save the template.');
    }
  };

  /* ── live sidebar totals ─────────────────────────────────── */
  const total = useMemo(() => paperTotal(rows), [rows]);
  const { perUnit, unassigned, firstUnassignedRow } = useMemo(() => {
    const t = {};
    for (const u of units) t[u.id] = 0;
    let un = 0;
    let firstUn = -1;
    rows.forEach((r, i) => {
      const key = `Q${i + 1}`;
      const a = assign[key] || {};
      if (isWholeMarks(defOf(types, r.type))) {
        const m = num(r.wholeMarks);
        const u = a.unit;
        if (u != null && u in t) t[u] += m;
        else { un += m; if (firstUn < 0) firstUn = i; }
        return;
      }
      const marks = resizeItemMarks(r.itemMarks, r.itemCount, r.uniformMarks);
      const uus = itemUnits(key, r.itemCount);
      marks.forEach((m, li) => {
        const u = uus[li];
        if (u != null && u in t) t[u] += num(m);
        else { un += num(m); if (firstUn < 0) firstUn = i; }
      });
    });
    for (const k of Object.keys(t)) t[k] = Math.round(t[k] * 10) / 10;
    return { perUnit: t, unassigned: Math.round(un * 10) / 10, firstUnassignedRow: firstUn };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, assign, units, types]);
  const assignedMarks = Math.round((total - unassigned) * 10) / 10;
  const maxBar = Math.max(1, unassigned, ...Object.values(perUnit));

  const jumpToUnassigned = () => {
    if (firstUnassignedRow < 0) return;
    setOpenRows((o) => new Set(o).add(firstUnassignedRow));
    const sec = rows[firstUnassignedRow]?.section;
    if (sec) setCollapsedSecs((c) => { const n = new Set(c); n.delete(sec); return n; });
    requestAnimationFrame(() => document.getElementById(`qb-row-${firstUnassignedRow}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  };

  /* ── submit ──────────────────────────────────────────────────
   * Per-item hints have no field in the blueprint contract, so they are
   * folded into the question instruction (the generator reads that in the
   * slot spec). True per-item anchoring would need a contract change. */
  const withHints = (rs) =>
    rs.map((r) => {
      const hints = (r.itemHints || [])
        .map((h, i) => (h && h.trim() ? `${letter(i)}) ${h.trim()}` : null))
        .filter(Boolean);
      if (hints.length === 0) return r;
      const instruction = [r.instruction, `Each item should cover — ${hints.join('; ')}`].filter(Boolean).join(' ');
      return { ...r, instruction };
    });

  const submit = async () => {
    if (busy) return;
    setError(null); setSlotErrors([]); setWarnings([]); setBusy(true);
    try {
      const payload = { blueprint: buildFormPayload({ paper: paperHeader(), sections: sectionObjs(), questions: withHints(rows) }) };
      const res = await manualService.create(payload);
      const assignments = Object.fromEntries(
        Object.entries(assign)
          .map(([k, v]) => {
            const items = Object.fromEntries(Object.entries(v?.items || {}).filter(([, u]) => u != null));
            if (Object.keys(items).length) return [k, { items }];
            if (v?.unit != null) return [k, { unit: v.unit }];
            return null;
          })
          .filter(Boolean)
      );
      onCreated({
        jobId: res.jobId,
        blueprint: res.blueprint,
        availableUnits: Array.isArray(res.availableUnits) ? res.availableUnits : [],
        assignments,
      });
    } catch (err) {
      const data = err?.response?.data;
      if (Array.isArray(data?.errors) && data.errors.length > 0) {
        setSlotErrors(data.errors.map((e) => (typeof e === 'string' ? e : `${e.slot ? `${e.slot}: ` : ''}${e.message}`)));
      } else {
        setError(data?.message || err?.message || 'Could not create the paper.');
      }
      if (Array.isArray(data?.warnings) && data.warnings.length > 0) setWarnings(data.warnings.map((w) => w.warning || String(w)));
    } finally {
      setBusy(false);
    }
  };

  /* ── section grouping for render ── */
  const groups = useMemo(() => {
    if (sections.length === 0) return [];
    const named = sections.map((name, i) => ({
      name,
      tone: SECTION_TONES[i % SECTION_TONES.length],
      rows: rows.map((r, idx) => ({ r, idx })).filter(({ r }) => r.section === name),
    }));
    const loose = rows.map((r, idx) => ({ r, idx })).filter(({ r }) => !r.section || !sections.includes(r.section));
    if (loose.length > 0) named.push({ name: null, tone: { badge: 'bg-gray-400', head: 'bg-gray-50 border-gray-100' }, rows: loose });
    return named;
  }, [rows, sections]);

  const sectionMarks = (grpRows) => grpRows.reduce((a, { r }) => a + questionTotal(r), 0);
  // Notes gate: generation is impossible without an explicit source — the CTA
  // stays disabled (with an inline reason) until the teacher picks one.
  const hasNotesSource = (notesSource === 'knowledge_base' && !!kbDoc) || (uploads.length > 0);
  const canSubmit = !busy && hasNotesSource && rows.length > 0 && rows.every((r) => r.type) && sections.length > 0;

  /* ── render ──────────────────────────────────────────────── */
  const showEditBanner = isEditMode && !!onBackToReview;
  return (
    <div>
      {/* edit-mode banner (PHASE 3): teacher returned from Review — structural
          edits here mark affected generated questions stale on submit. */}
      {showEditBanner && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 text-amber-600"><IconWarn size={17} /></span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-amber-900">
                Editing the generated paper's structure
              </p>
              <p className="mt-0.5 text-[12px] text-amber-800">
                This paper has generated questions. Structural changes (type, marks, items, unit, topic) will mark the affected questions for regeneration — nothing is rewritten silently.
              </p>
              {staleCount > 0 && (
                <div className="mt-2 rounded-lg border border-amber-300 bg-white px-3 py-2">
                  <p className="text-[12px] font-semibold text-amber-800">⚠ {staleCount} question{staleCount === 1 ? '' : 's'} need{staleCount === 1 ? 's' : ''} regeneration</p>
                  {staleSummary.length > 0 && (
                    <ul className="mt-1 list-disc pl-5 text-[11.5px] text-amber-700">
                      {staleSummary.slice(0, 8).map((s) => <li key={s}>{s}</li>)}
                    </ul>
                  )}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={onBackToReview}
              className="shrink-0 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-[12px] font-medium text-amber-800 hover:bg-amber-100"
            >
              Back to Review
            </button>
          </div>
        </div>
      )}

      {/* header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-bold text-gray-900">Question Builder</h1>
          <p className="mt-1 text-[14px] text-gray-500">Add questions to your paper and set their properties.</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onManageNotes} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-[12px] font-medium text-gray-600 hover:bg-gray-50">
            <IconEye size={14} /> Preview Blueprint
          </button>
          <button
            type="button"
            onClick={() => {
              const name = (tplName || window.prompt('Name this template (structure only — units and topics are not saved):') || '').trim();
              if (!name) { setTplMsg('Give the template a name first.'); return; }
              setTplName(name);
              saveAsTemplate(name);
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-[12px] font-medium text-gray-600 hover:bg-gray-50"
          >
            <IconSave size={14} /> Save as Template
          </button>
        </div>
      </div>

      {/* step bar */}
      <div className="mt-5 flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-5 py-3">
        {[
          { n: 1, label: 'Paper Details', cap: 'Basic information', state: 'done' },
          { n: 2, label: 'Question Builder', cap: 'Add questions and set properties', state: 'current' },
          { n: 3, label: 'Review & Generate', cap: 'Preview and generate', state: 'todo' },
        ].map((s, i) => (
          <div key={s.n} className="flex flex-1 items-center gap-2">
            <button
              type="button"
              onClick={s.state === 'done' ? onCancel : undefined}
              disabled={s.state !== 'done'}
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold ${
                s.state === 'todo' ? 'bg-gray-100 text-gray-400' : 'bg-blue-600 text-white'
              } ${s.state === 'done' ? 'cursor-pointer hover:bg-blue-700' : ''}`}
            >
              {s.state === 'done' ? <IconCheck size={14} /> : s.n}
            </button>
            <div className="min-w-0">
              <button
                type="button"
                onClick={s.state === 'done' ? onCancel : undefined}
                disabled={s.state !== 'done'}
                className={`block text-left text-[12.5px] font-medium ${s.state === 'todo' ? 'text-gray-400' : 'text-gray-900'} ${s.state === 'done' ? 'hover:text-blue-600 cursor-pointer' : ''}`}
              >
                {s.label}
              </button>
              <p className="text-[11px] text-gray-400">{s.cap}</p>
            </div>
            {i < 2 && <div className="ml-auto hidden h-px w-8 bg-gray-200 sm:block" />}
          </div>
        ))}
      </div>

      {/* 2-column layout */}
      <div className="mt-5 flex flex-col gap-5 xl:flex-row">
        {/* main column */}
        <div className="min-w-0 flex-1 space-y-4">
          {/* ── Add Syllabus Notes — dual-source card ─────────────────── */}
          <div id="qb-notes-section" className="rounded-xl border border-gray-200 bg-white">
            {/* Card header */}
            <div className="border-b border-gray-100 px-5 py-4">
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 text-blue-600"><IconBook size={18} /></span>
                <div>
                  <p className="text-[14px] font-semibold text-gray-900">
                    Add Syllabus Notes <span className="ml-1 text-[11px] font-normal text-red-500">(Required for AI Generation)</span>
                  </p>
                  <p className="text-[12px] text-gray-500">
                    Upload notes from your device or select from your Knowledge Base. These notes provide the content for generating questions.
                  </p>
                </div>
              </div>

              {/* Tabs */}
              <div className="mt-3 flex gap-1 rounded-lg border border-gray-200 bg-gray-50 p-1 w-fit">
                <button
                  type="button"
                  onClick={() => { switchSource('upload'); }}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors ${
                    notesTab === 'upload'
                      ? 'bg-white shadow-sm text-gray-900 border border-gray-200'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  <IconUpload size={13} /> Upload from Device
                </button>
                <button
                  type="button"
                  onClick={() => switchSource('knowledge_base')}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors ${
                    notesTab === 'kb'
                      ? 'bg-white shadow-sm text-gray-900 border border-gray-200'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  <IconBook size={13} /> Select from Knowledge Base
                </button>
              </div>
            </div>

            {/* Tab body */}
            <div className="px-5 py-4">

              {/* ── UPLOAD TAB ── */}
              {notesTab === 'upload' && (
                <div className="space-y-3">
                  <p className="text-[12px] text-gray-500">Upload notes from your device. They will be indexed and become this paper's source.</p>

                  {/* Unit name + file trigger */}
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="block">
                      <span className="mb-1 block text-[11.5px] font-medium text-gray-600">Unit name</span>
                      <input
                        className="h-9 rounded-lg border border-gray-300 bg-white px-2.5 text-[12.5px] text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors w-44"
                        placeholder="e.g. Unit 3"
                        value={uploadUnitName}
                        onChange={(e) => { setUploadUnitName(e.target.value); setUploadErr(''); }}
                      />
                    </label>
                    <button
                      type="button"
                      disabled={uploadBusy || !uploadUnitName.trim()}
                      onClick={() => { setUploadErr(''); notesFileRef.current?.click(); }}
                      className="inline-flex h-9 items-center gap-2 rounded-lg bg-blue-600 px-4 text-[12.5px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                    >
                      <IconUpload size={13} />
                      {uploadBusy ? 'Uploading…' : 'Upload Notes'}
                    </button>
                    <input
                      ref={notesFileRef}
                      type="file"
                      accept="application/pdf,.pdf,.txt,.md,.docx"
                      className="hidden"
                      onChange={(e) => { doNotesUpload(e.target.files?.[0]); e.target.value = ''; }}
                    />
                  </div>
                  <p className="text-[11px] text-gray-400">Accepted formats: PDF, DOCX, TXT, MD · The unit name is always explicit.</p>

                  {uploadErr && (
                    <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
                      <IconWarn size={14} className="shrink-0" /> {uploadErr}
                    </div>
                  )}

                  {/* THIS paper's uploaded files only — the KB repository is NOT shown here. */}
                  {uploads.length > 0 && (
                    <div className="space-y-1.5">
                      {uploads.map((u) => (
                        <div key={u.id} className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2">
                          <span className="shrink-0 text-blue-500">
                            <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                              <polyline points="14 2 14 8 20 8" />
                            </svg>
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[12.5px] font-medium text-gray-800">{u.fileName}</p>
                            <p className="text-[11px] text-gray-400">
                              {u.unitName} · {formatSize(u.fileSize)} · {u.reused ? 'already indexed' : `indexed ${u.chunkCount} chunk${u.chunkCount === 1 ? '' : 's'}`}
                            </p>
                          </div>
                          <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold text-emerald-700">
                            <IconCheck size={12} /> Ready
                          </span>
                          <button
                            type="button"
                            onClick={() => setUploads((prev) => prev.filter((x) => x.id !== u.id))}
                            className="shrink-0 rounded p-1 text-gray-400 hover:bg-white hover:text-red-500"
                            title="Remove from this paper's notes"
                          >
                            <IconTrash size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ── KB TAB ── */}
              {notesTab === 'kb' && (
                <div className="space-y-3">
                  {/* Search bar */}
                  <div className="relative">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
                      </svg>
                    </span>
                    <input
                      className="h-9 w-full rounded-lg border border-gray-300 bg-white pl-9 pr-8 text-[12.5px] text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
                      placeholder="Search notes by title, subject, class or topic…"
                      value={kbSearch}
                      onChange={(e) => setKbSearch(e.target.value)}
                    />
                    {kbSearch && (
                      <button
                        type="button"
                        onClick={() => setKbSearch('')}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                      >
                        <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                      </button>
                    )}
                  </div>

                  {/* Filter badge */}
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-[11px] font-medium text-blue-700">
                      {subject || 'All Subjects'}
                    </span>
                    <span className="text-[11px] text-gray-400">Showing notes indexed for Class {cls} · {subject}</span>
                  </div>

                  {/* Note documents table */}
                  {kbError && (
                    <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
                      <IconWarn size={14} className="shrink-0" /> {kbError}
                    </div>
                  )}
                  {kbLoading ? (
                    <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-8 text-center">
                      <p className="text-[12.5px] text-gray-500">Loading Knowledge Base notes…</p>
                    </div>
                  ) : (() => {
                    const filtered = searchKbDocuments(kbDocs || [], kbSearch, { class: cls, subject });
                    if (filtered.length === 0) {
                      return (
                        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-6 text-center">
                          {kbSearch
                            ? (
                              <>
                                <p className="text-[12.5px] text-gray-500">No notes matching &ldquo;{kbSearch}&rdquo;.</p>
                                <button type="button" onClick={() => setKbSearch('')} className="mt-2 text-[12px] font-medium text-blue-600 hover:underline">Clear search</button>
                              </>
                            ) : (
                              <>
                                <p className="text-[13px] font-medium text-gray-700">No notes found</p>
                                <p className="mt-1 text-[12px] text-gray-500">
                                  No notes are indexed for Class {cls} · {subject}. Switch to the Upload tab to add notes.
                                </p>
                                <button
                                  type="button"
                                  onClick={() => setNotesTab('upload')}
                                  className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-[12px] font-semibold text-white hover:bg-blue-700"
                                >
                                  <IconUpload size={12} /> Upload Notes
                                </button>
                              </>
                            )}
                        </div>
                      );
                    }
                    return (
                      <div className="overflow-hidden rounded-lg border border-gray-200">
                        {/* Table header */}
                        <div className="grid grid-cols-[1fr_110px_60px_76px] gap-2 border-b border-gray-100 bg-gray-50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                          <span>Title</span>
                          <span>Class · Subject</span>
                          <span>Units</span>
                          <span className="text-right">Action</span>
                        </div>
                        {/* Rows */}
                        {filtered.map((d) => (
                          <div
                            key={d.id}
                            className={`grid grid-cols-[1fr_110px_60px_76px] items-center gap-2 border-b border-gray-100 px-3 py-2.5 last:border-b-0 transition-colors ${
                              kbDoc?.id === d.id ? 'bg-emerald-50/60' : 'hover:bg-gray-50'
                            }`}
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="shrink-0 text-blue-500">
                                <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                                  <polyline points="14 2 14 8 20 8" />
                                  <line x1="16" y1="13" x2="8" y2="13" />
                                  <line x1="16" y1="17" x2="8" y2="17" />
                                  <line x1="10" y1="9" x2="8" y2="9" />
                                </svg>
                              </span>
                              <div className="min-w-0">
                                <p className="truncate text-[12.5px] font-medium text-gray-800">{d.title || d.filename || 'Untitled notes'}</p>
                                <p className="text-[11px] text-gray-400">{d.chunkCount} chunks · {formatKbDate(d.ingestedAt)}</p>
                              </div>
                            </div>
                            <span className="text-[11.5px] text-gray-500 truncate">{d.class || cls} · {d.subject || subject}</span>
                            <span className="text-[12px] font-medium text-gray-700">{d.units.length} unit{d.units.length === 1 ? '' : 's'}</span>
                            <div className="flex justify-end">
                              {kbDoc?.id === d.id ? (
                                <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-emerald-700">
                                  <IconCheck size={11} /> Selected
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => applyKbDoc(d)}
                                  className="inline-flex items-center rounded-md border border-blue-600 px-2.5 py-1 text-[11.5px] font-semibold text-blue-700 hover:bg-blue-50 transition-colors"
                                >
                                  Use Notes
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                        {filtered.length > 0 && (
                          <p className="border-t border-gray-100 px-3 py-2 text-center text-[11.5px] text-blue-500">
                            <button type="button" onClick={onManageNotes} className="hover:underline">
                              Manage in Knowledge Base →
                            </button>
                          </p>
                        )}
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* ── Source status banner (no source / selected) ── */}
              {!hasNotesSource ? (
                <div className="mt-3 flex items-center gap-2 rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-3">
                  <span className="shrink-0 text-gray-400"><IconInfo size={15} /></span>
                  <div>
                    <p className="text-[12.5px] font-medium text-gray-700">No syllabus notes selected.</p>
                    <p className="text-[11.5px] text-gray-500">Select notes to provide content for AI generation — existing Knowledge Base notes are never used automatically.</p>
                  </div>
                </div>
              ) : (
                <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3">
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 shrink-0 text-emerald-600"><IconCheck size={16} /></span>
                    <div>
                      <p className="text-[13px] font-semibold text-emerald-900">
                        ✓ {notesSource === 'knowledge_base' ? (kbDoc.title || kbDoc.filename || 'Untitled notes') : uploads[0]?.fileName}
                      </p>
                      <p className="text-[11.5px] text-emerald-700">
                        Source: {notesSource === 'knowledge_base' ? 'Knowledge Base' : 'Uploaded from Device'} · {units.length} unit{units.length === 1 ? '' : 's'} • {notesSource === 'knowledge_base' ? kbDoc.chunkCount : uploads.reduce((a, u) => a + (u.chunkCount || 0), 0)} chunks
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => { if (notesSource === 'knowledge_base') { setKbDoc(null); setNotesSource(null); } else { setUploads([]); setNotesSource(null); } }}
                    className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-emerald-400 bg-white px-3 py-1.5 text-[11.5px] font-medium text-emerald-800 hover:bg-emerald-100 transition-colors"
                  >
                    <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>
                    {notesSource === 'knowledge_base' ? 'Change Notes' : 'Replace'}
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* sections bar (picker/collapse controls only make sense with sections) */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold text-gray-800">Sections</span>
            {sections.length > 0 && (
              <>
                <div className="relative">
                  <select value={pickSection} onChange={(e) => setPickSection(e.target.value)} className={`${select} w-44`}>
                    <option value="">All sections</option>
                    {sections.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <IconChevron size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-400" />
                </div>
                <div className="flex items-center gap-1.5">
                  <input className={`${field} w-40`} placeholder="SECTION D" value={newSection} onChange={(e) => setNewSection(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addSection()} />
                </div>
                <div className="ml-auto flex items-center gap-1.5">
                  <button type="button" onClick={() => setCollapsedSecs(new Set(sections))} className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-[11.5px] font-medium text-gray-600 hover:bg-gray-50">Collapse All</button>
                  <button type="button" onClick={() => setCollapsedSecs(new Set())} className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-[11.5px] font-medium text-gray-600 hover:bg-gray-50">Expand All</button>
                </div>
              </>
            )}
            <button type="button" onClick={addSection} className="inline-flex h-9 items-center gap-1 rounded-lg border border-gray-300 px-2.5 text-[12px] font-medium text-gray-600 hover:bg-gray-50">
              <IconPlus size={13} /> Add Section
            </button>
          </div>

          {/* section blocks — clean empty state before the first section exists */}
          {sections.length === 0 && (
            <div className="rounded-xl border border-dashed border-gray-300 bg-white px-6 py-12 text-center">
              <p className="text-[13.5px] font-medium text-gray-700">No sections added yet</p>
              <p className="mt-1 text-[12.5px] text-gray-500">Create a section to start building your question paper.</p>
              <button type="button" onClick={addSection} className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-[12.5px] font-semibold text-white hover:bg-blue-700">
                <IconPlus size={13} /> Add Section
              </button>
            </div>
          )}
          <div className="space-y-3">
            {groups
              .filter((g) => pickSection === '' || g.name === pickSection)
              .map((g) => {
                const collapsed = g.name && collapsedSecs.has(g.name);
                return (
                  <div key={g.name || 'nosec'} className="overflow-hidden rounded-xl border border-gray-200 bg-white">
                    <div className={`flex items-center gap-3 border-b px-4 py-2.5 ${g.tone.head}`}>
                      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-bold text-white ${g.tone.badge}`}>
                        {g.name ? g.name.replace(/^SECTION\s*/i, '').trim().charAt(0) || '·' : '·'}
                      </span>
                      <span className="text-[13px] font-semibold text-gray-900">{g.name ? (subject ? `${g.name} - ${subject}` : g.name) : 'Unsectioned'}</span>
                      <span className="text-gray-400"><IconInfo size={13} /></span>
                      <span className="ml-auto text-[12px] text-gray-500">Total Marks: {sectionMarks(g.rows)}</span>
                      {g.name && (
                        <>
                          <button type="button" onClick={() => setCollapsedSecs((c) => { const n = new Set(c); n.has(g.name) ? n.delete(g.name) : n.add(g.name); return n; })} className="rounded p-1 text-gray-400 hover:bg-white/60 hover:text-gray-700">
                            {collapsed ? <IconChevronR size={15} /> : <IconChevron size={15} />}
                          </button>
                          <button type="button" onClick={() => { setSections((ss) => ss.filter((x) => x !== g.name)); setRows((rs) => rs.map((r) => (r.section === g.name ? { ...r, section: null } : r))); }} className="rounded p-1 text-gray-400 hover:bg-white/60 hover:text-red-500">
                            <IconTrash size={15} />
                          </button>
                        </>
                      )}
                    </div>

                    {!collapsed && (
                      <div className="space-y-2 p-3">
                        {g.rows.map(({ r, idx }) => (
                          <QuestionRow
                            key={idx}
                            idx={idx}
                            row={r}
                            def={defOf(types, r.type)}
                            types={types}
                            open={openRows.has(idx)}
                            onToggle={() => setOpenRows((o) => { const n = new Set(o); n.has(idx) ? n.delete(idx) : n.add(idx); return n; })}
                            varied={variedRows.has(idx)}
                            onVaried={(v) => setVariedRows((s) => { const n = new Set(s); v ? n.add(idx) : n.delete(idx); return n; })}
                            units={units}
                            assign={assign[`Q${idx + 1}`] || { unit: null, items: {} }}
                            itemUnits={itemUnits(`Q${idx + 1}`, r.itemCount)}
                            isMixed={isMixedRow(`Q${idx + 1}`, r.itemCount)}
                            unitSummary={rowUnitSummary(`Q${idx + 1}`, r.itemCount)}
                            onWholeUnit={(u) => setWholeUnit(`Q${idx + 1}`, u)}
                            onItemUnit={(li, u) => setItemUnit(`Q${idx + 1}`, li, r.itemCount, u)}
                            onSetAll={(u) => setWholeUnit(`Q${idx + 1}`, u)}
                            coverage={coverage[idx]}
                            topics={topicsCache[unitForRow(idx)]}
                            onLoadTopics={() => loadTopics(unitForRow(idx))}
                            onCheckCoverage={(t) => checkCoverage(idx, t)}
                            onChangeType={(t) => changeType(idx, t)}
                            onChangeItemCount={(c) => changeItemCount(idx, c)}
                            onUpdate={(patch) => updateRow(idx, patch)}
                            onDuplicate={() => duplicateRow(idx)}
                            onRemove={() => removeRow(idx)}
                            canRemove={rows.length > 1}
                            notesImagesData={notesImagesData}
                            loadingImages={loadingImages}
                            hasNotesSource={hasNotesSource}
                            onSelectNotes={() => {
                              document.getElementById('qb-notes-section')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            }}
                            kbDoc={kbDoc}
                            uploads={uploads}
                            unitLabel={unitLabel}
                          />
                        ))}
                        <button type="button" onClick={() => addRow(g.name)} className="w-full rounded-lg border border-dashed border-gray-300 py-2 text-[12px] font-medium text-blue-600 hover:bg-blue-50/40">
                          + Add Question{g.name ? ` to ${g.name}` : ''}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
          </div>

          {/* errors */}
          {(error || slotErrors.length > 0 || warnings.length > 0) && (
            <div className="space-y-2">
              {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-700">{error}</p>}
              {slotErrors.length > 0 && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2">
                  <p className="text-[12px] font-medium text-red-700">Fix these before continuing:</p>
                  <ul className="mt-1 list-disc pl-5 text-[12px] text-red-700">{slotErrors.map((e, i) => <li key={i}>{e}</li>)}</ul>
                </div>
              )}
              {warnings.length > 0 && (
                <ul className="list-disc rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 pl-8 text-[12px] text-amber-800">
                  {warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              )}
            </div>
          )}
          {tplMsg && <p className="text-[12px] text-gray-500">{tplMsg}</p>}
        </div>

        {/* ── sidebar ── */}
        <div className="w-full shrink-0 space-y-4 xl:w-[320px]">
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="flex items-center gap-1.5 text-[13px] font-semibold text-gray-900">
              <span className="text-blue-600"><IconChart size={15} /></span>
              Marks per Unit <span className="text-[11px] font-normal text-gray-400">(Live Summary)</span>
            </p>
            <div className="mt-3 space-y-2">
              {units.map((u, i) => (
                <div key={u.id} className="flex items-center gap-2">
                  <span className="w-14 shrink-0 truncate text-[11.5px] text-gray-600">{u.label}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded bg-gray-100">
                    <div className={`h-full ${SECTION_TONES[i % SECTION_TONES.length].badge}`} style={{ width: `${(perUnit[u.id] / maxBar) * 100}%` }} />
                  </div>
                  <span className="w-16 shrink-0 text-right text-[11.5px] tabular-nums text-gray-700">{perUnit[u.id]} marks</span>
                </div>
              ))}
              <div className="flex items-center gap-2 border-t border-gray-100 pt-2">
                <span className="w-14 shrink-0 text-[11.5px] text-gray-500">Unassigned</span>
                <div className="h-2 flex-1 overflow-hidden rounded bg-gray-100">
                  <div className="h-full bg-gray-300" style={{ width: `${(unassigned / maxBar) * 100}%` }} />
                </div>
                <span className="w-16 shrink-0 text-right text-[11.5px] tabular-nums text-gray-500">{unassigned} marks</span>
              </div>
            </div>

            {unassigned > 0 && firstUnassignedRow >= 0 && (
              <button type="button" onClick={jumpToUnassigned} className="mt-3 flex w-full items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-left">
                <div className="flex-1">
                  <p className="text-[12px] font-medium text-blue-800">{unassigned} marks are not assigned to any unit yet.</p>
                  <p className="text-[11px] text-blue-600">Click to go to the first unassigned question.</p>
                </div>
                <IconArrow size={14} className="mt-0.5 shrink-0 text-blue-600" />
              </button>
            )}
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="flex items-center gap-1.5 text-[13px] font-semibold text-gray-900">
              <span className="text-gray-400"><IconBook size={15} /></span> Paper Summary
            </p>
            <dl className="mt-3 space-y-2 text-[12.5px]">
              <div className="flex justify-between"><dt className="text-gray-500">Total Questions</dt><dd className="font-semibold tabular-nums text-gray-800">{rows.length}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Total Marks</dt><dd className="font-semibold tabular-nums text-gray-800">{total}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Assigned Marks</dt><dd className="font-semibold tabular-nums text-gray-800">{assignedMarks}</dd></div>
              <div className={`flex justify-between rounded px-1 ${unassigned > 0 ? 'bg-amber-50' : ''}`}>
                <dt className={unassigned > 0 ? 'font-medium text-amber-900' : 'text-gray-500'}>Unassigned Marks</dt>
                <dd className={`font-semibold tabular-nums ${unassigned > 0 ? 'text-amber-900' : 'text-gray-800'}`}>{unassigned}</dd>
              </div>
            </dl>
          </div>

          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
            <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-emerald-900">
              <IconBulb size={14} className="text-emerald-600" /> Tip
            </p>
            <p className="mt-1 text-[11.5px] text-emerald-800">
              {rows.some((r) => r.type === 'IMAGE_BASED')
                ? (hasNotesSource
                    ? 'For image based questions, select a relevant topic and image from your chosen notes. The AI will generate new questions using the image and your notes.'
                    : 'Select or upload syllabus notes first to unlock image topics and diagrams for your paper.')
                : 'Add hints to guide the AI. You can control the topic coverage by assigning units (and marks) to each question or item.'}
            </p>
            <button type="button" onClick={onManageNotes} className="mt-1.5 text-[11.5px] font-medium text-emerald-700 hover:underline">Learn more</button>
          </div>

          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-3 text-[13px] font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {busy ? 'Creating…' : isEditMode ? 'Apply Structure Changes' : 'Next: Review & Generate'}
            <IconArrow size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────── */
function QuestionRow({
  idx, row, def, types, open, onToggle, varied, onVaried, units,
  assign, itemUnits, isMixed, unitSummary, onWholeUnit, onItemUnit, onSetAll,
  coverage, topics, onLoadTopics, onCheckCoverage,
  onChangeType, onChangeItemCount, onUpdate, onDuplicate, onRemove, canRemove,
  notesImagesData, loadingImages, hasNotesSource, onSelectNotes, kbDoc, uploads, unitLabel,
}) {
  const key = `Q${idx + 1}`;
  const isImageBased = row.type === 'IMAGE_BASED';
  const whole = !isImageBased && isWholeMarks(def);
  const marks = whole ? [] : resizeItemMarks(row.itemMarks, row.itemCount, row.uniformMarks);
  const issues = rowIssues(row, def?.countMin ?? 1);
  const [setAllUnit, setSetAllUnit] = useState('');

  // Image-Based specific local state
  const [topicSearch, setTopicSearch] = useState('');
  const [activeTopic, setActiveTopic] = useState(row.imageTopic || row.selectedImage?.topic || '');
  const [imageSearch, setImageSearch] = useState('');
  const [imageTypeFilter, setImageTypeFilter] = useState('ALL');
  const [imagePage, setImagePage] = useState(1);
  const [bulkMark, setBulkMark] = useState(row.uniformMarks || 1);

  // Sync activeTopic if row already has imageTopic
  useEffect(() => {
    if (row.imageTopic && row.imageTopic !== activeTopic) {
      setActiveTopic(row.imageTopic);
    }
  }, [row.imageTopic, activeTopic]);

  // Available topics filtered by search
  const availableTopics = useMemo(() => {
    if (!hasNotesSource) return [];
    const list = Array.isArray(notesImagesData?.topics) ? notesImagesData.topics : [];
    if (!topicSearch.trim()) return list;
    const q = topicSearch.toLowerCase().trim();
    return list.filter((t) => (t.topic || '').toLowerCase().includes(q));
  }, [hasNotesSource, notesImagesData?.topics, topicSearch]);

  // Helper to match unit raw string/id against paper units
  const matchUnit = useCallback((raw) => {
    if (!raw) return null;
    const cleanRaw = String(raw).trim();
    const match = units.find((u) =>
      String(u.id).toLowerCase() === cleanRaw.toLowerCase() ||
      String(u.label).toLowerCase() === cleanRaw.toLowerCase() ||
      String(u.id).replace(/\D+/g, '') === cleanRaw.replace(/\D+/g, '')
    );
    return match ? match.id : cleanRaw;
  }, [units]);

  // Set default activeTopic if none selected and topics exist
  useEffect(() => {
    if (hasNotesSource && !activeTopic && availableTopics.length > 0) {
      const firstTopicObj = availableTopics[0];
      const firstTopic = firstTopicObj.topic;
      setActiveTopic(firstTopic);
      if (!row.imageTopic) {
        onUpdate({ imageTopic: firstTopic, topic: row.topic || firstTopic });
      }
      if (firstTopicObj.unit && assign.unit == null) {
        const u = matchUnit(firstTopicObj.unit);
        if (u) onWholeUnit(u);
      }
    } else if (!hasNotesSource && activeTopic) {
      setActiveTopic('');
    }
  }, [hasNotesSource, availableTopics, activeTopic, row.imageTopic, row.topic, onUpdate, assign.unit, onWholeUnit, matchUnit]);

  // Available images filtered by topic, search, and type
  const availableImages = useMemo(() => {
    if (!hasNotesSource) return [];
    const all = Array.isArray(notesImagesData?.images) ? notesImagesData.images : [];
    let list = all;
    if (activeTopic) {
      const filtered = list.filter((im) => (im.topic || '').toLowerCase() === activeTopic.toLowerCase());
      if (filtered.length > 0) list = filtered;
    }
    if (imageSearch.trim()) {
      const q = imageSearch.toLowerCase().trim();
      list = list.filter((im) =>
        (im.title || '').toLowerCase().includes(q) ||
        (im.topic || '').toLowerCase().includes(q) ||
        (im.unit || '').toLowerCase().includes(q)
      );
    }
    if (imageTypeFilter !== 'ALL') {
      list = list.filter((im) => (im.imageType || '').toLowerCase() === imageTypeFilter.toLowerCase());
    }
    return list;
  }, [hasNotesSource, notesImagesData?.images, activeTopic, imageSearch, imageTypeFilter]);

  const pageSize = 6;
  const totalPages = Math.max(1, Math.ceil(availableImages.length / pageSize));
  const pageImages = useMemo(() => {
    const start = (imagePage - 1) * pageSize;
    return availableImages.slice(start, start + pageSize);
  }, [availableImages, imagePage]);

  const topicMatchesImage = Boolean(
    hasNotesSource &&
    row.topic &&
    (row.selectedImage?.topic || row.imageTopic || activeTopic) &&
    row.topic.trim().toLowerCase() === (row.selectedImage?.topic || row.imageTopic || activeTopic || '').trim().toLowerCase()
  );

  const setSameForAll = () => {
    onVaried(false);
    onUpdate({ itemMarks: Array.from({ length: row.itemCount }, () => row.uniformMarks || 1) });
  };

  if (!open) {
    return (
      <div id={`qb-row-${idx}`} className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2">
        <button type="button" onClick={onToggle} className="rounded p-0.5 text-gray-400 hover:text-gray-700"><IconChevronR size={14} /></button>
        <span className="w-7 shrink-0 text-[12.5px] font-semibold text-gray-700">{key}</span>
        <span className="w-32 shrink-0 truncate text-[12.5px] text-gray-700">{isImageBased ? 'Image Based' : (def ? (def.label || questionTypeLabel(def.blueprintType)) : 'No type')}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-gray-500">
          {row.itemCount} item{row.itemCount === 1 ? '' : 's'} · {questionTotal(row)} marks · {unitSummary || 'Unassigned'}
        </span>
        <span className="shrink-0 text-[12px] font-medium text-gray-600">Total: {questionTotal(row)}</span>
        <button type="button" onClick={onDuplicate} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"><IconCopy size={14} /></button>
        <button type="button" onClick={onRemove} disabled={!canRemove} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-red-500 disabled:opacity-30"><IconTrash size={14} /></button>
      </div>
    );
  }

  return (
    <div id={`qb-row-${idx}`} className="rounded-lg border border-blue-200 bg-blue-50/20 p-4">
      <div className="flex items-start gap-2.5">
        <span className="mt-1 cursor-grab text-gray-300"><IconGrip size={14} /></span>
        <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-amber-400" title={issues.length ? issues.join('; ') : 'ok'} />
        <span className="mt-0.5 w-7 shrink-0 text-[13px] font-bold text-gray-900">{key}</span>

        <div className="min-w-0 flex-1 space-y-3.5">
          {isImageBased ? (
            /* ════════════════════════════════════════════════════════════════
               MODE B: IMAGE BASED QUESTION CONFIGURATION (REFERENCE UI)
               ════════════════════════════════════════════════════════════════ */
            <div className="space-y-3.5">
              {/* Top Controls: Type, Number of Items, Marks */}
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div className="flex flex-wrap items-end gap-4">
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-medium text-gray-600">Question Type</span>
                    <div className="relative">
                      <select className={`${select} w-44 font-medium text-gray-800`} value={row.type} onChange={(e) => onChangeType(e.target.value)}>
                        <option value="">Choose type…</option>
                        {types.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                      </select>
                      <IconChevron size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-400" />
                    </div>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-medium text-gray-600">Number of Items</span>
                    <div className="relative">
                      <select className={`${select} w-20 font-medium text-gray-800`} value={row.itemCount} onChange={(e) => onChangeItemCount(e.target.value)}>
                        {Array.from({ length: 10 }, (_, n) => n + 1).map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                      <IconChevron size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-400" />
                    </div>
                  </label>
                </div>

                {/* Marks selector */}
                <div className="flex flex-wrap items-center gap-4 text-[12px] text-gray-700">
                  <span className="text-[11px] font-medium text-gray-600">Marks</span>
                  <label className="flex items-center gap-1.5 cursor-pointer font-medium text-gray-800">
                    <input type="radio" name={`marks-${key}`} checked={!varied} onChange={setSameForAll} className="accent-blue-600" />
                    Same for all
                    <input
                      type="number" min={0.5} step={0.5} disabled={varied}
                      className={`${marksInput} ml-1 disabled:bg-gray-50 disabled:text-gray-400`}
                      value={row.uniformMarks}
                      onChange={(e) => {
                        const v = Number(e.target.value) || 1;
                        onUpdate({ uniformMarks: v, itemMarks: Array.from({ length: row.itemCount }, () => v) });
                      }}
                    />
                  </label>
                  <label className="flex flex-wrap items-center gap-1.5 cursor-pointer font-medium text-gray-800">
                    <input type="radio" name={`marks-${key}`} checked={varied} onChange={() => onVaried(true)} className="accent-blue-600" />
                    Different per item
                    {varied && marks.map((m, mi) => (
                      <span key={mi} className="inline-flex items-center gap-1 ml-1 font-normal">
                        <span className="text-[11px] text-gray-400">{letter(mi)})</span>
                        <input
                          type="number" min={0.5} step={0.5} className={marksInput}
                          value={m}
                          onChange={(e) => {
                            const next = [...marks];
                            next[mi] = Number(e.target.value) || 0;
                            onUpdate({ itemMarks: next });
                          }}
                        />
                      </span>
                    ))}
                  </label>
                </div>
              </div>

              {/* Horizontal Divider */}
              <div className="border-t border-gray-200/80" />

              {/* Informational Message Banner (§21) */}
              <div className="flex items-center gap-2.5 rounded-lg border border-blue-200/80 bg-blue-50/70 px-3.5 py-2.5 text-[12px] text-blue-900 shadow-xs">
                <IconInfo size={15} className="shrink-0 text-blue-600" />
                <span>
                  Image-based questions use the selected image together with your syllabus notes to create grounded questions.
                </span>
              </div>

              {/* If no syllabus notes selected: Empty State Card */}
              {!hasNotesSource ? (
                <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50/60 p-8 text-center">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-blue-50 text-blue-600 mb-3 shadow-xs">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                      <rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>
                      <circle cx="9" cy="9" r="2"/>
                      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>
                    </svg>
                  </div>
                  <h4 className="text-[14px] font-semibold text-gray-900">Select syllabus notes first</h4>
                  <p className="mt-1 text-[12px] text-gray-500 max-w-md mx-auto">
                    Upload or select notes to discover image-based topics and images from your own syllabus content.
                  </p>
                  <div className="mt-4">
                    <button
                      type="button"
                      onClick={onSelectNotes}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-[12.5px] font-semibold text-white hover:bg-blue-700 shadow-sm transition-colors"
                    >
                      <IconBook size={14} /> Select Notes
                    </button>
                  </div>
                </div>
              ) : !loadingImages && notesImagesData.totalImages === 0 ? (
                <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50/60 p-8 text-center">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-50 text-amber-600 mb-3 shadow-xs">
                    <IconWarn size={22} />
                  </div>
                  <h4 className="text-[14px] font-semibold text-gray-900">No image-based content found</h4>
                  <p className="mt-1 text-[12px] text-gray-500 max-w-md mx-auto">
                    The selected notes do not contain usable images or diagrams for image-based questions.
                  </p>
                  <div className="mt-4 flex items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={onSelectNotes}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-[12.5px] font-semibold text-white hover:bg-blue-700 shadow-sm transition-colors"
                    >
                      <IconBook size={14} /> Upload Different Notes
                    </button>
                  </div>
                </div>
              ) : (
                /* 3-Column Image Selection Panel */
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5 rounded-xl border border-gray-200 bg-white p-3.5 shadow-xs">
                  {/* Column 1: Image Topic (col-span-3) */}
                  <div className="lg:col-span-3 col-span-12 flex flex-col border-b lg:border-b-0 lg:border-r border-gray-100 pb-3 lg:pb-0 lg:pr-3">
                    <h4 className="text-[12.5px] font-semibold text-gray-800">Image Topic</h4>
                    <div className="relative mt-2">
                      <IconSearch size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                      <input
                        className="h-8 w-full rounded-md border border-gray-300 pl-8 pr-2 text-[12px] text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        placeholder="Search image topics..."
                        value={topicSearch}
                        onChange={(e) => setTopicSearch(e.target.value)}
                      />
                    </div>
                    <div className="mt-2.5 flex-1 max-h-[260px] overflow-y-auto divide-y divide-gray-100 rounded-md border border-gray-200">
                      {availableTopics.map((t) => {
                        const isActive = (activeTopic || '').toLowerCase() === (t.topic || '').toLowerCase();
                        return (
                          <button
                            key={t.topic}
                            type="button"
                            onClick={() => {
                              setActiveTopic(t.topic);
                              setImagePage(1);
                              onUpdate({
                                imageTopic: t.topic,
                                topic: t.topic,
                              });
                              if (t.unit) {
                                const u = matchUnit(t.unit);
                                if (u) onWholeUnit(u);
                              }
                            }}
                            className={`w-full text-left px-3 py-2 text-[12px] transition-colors flex items-center justify-between ${
                              isActive
                                ? 'bg-blue-50 text-blue-700 font-semibold border-l-2 border-blue-600'
                                : 'text-gray-700 hover:bg-gray-50'
                            }`}
                          >
                            <span className="truncate">{t.topic}</span>
                            {t.imageCount != null && (
                              <span className="ml-1 shrink-0 text-[10px] text-gray-400 font-normal">({t.imageCount})</span>
                            )}
                          </button>
                        );
                      })}
                      {availableTopics.length === 0 && (
                        <div className="p-4 text-center text-[11.5px] text-gray-400">
                          {loadingImages ? 'Loading topics…' : 'No image-based topics found.'}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Column 2: Available Images (col-span-5) */}
                  <div className="lg:col-span-5 col-span-12 flex flex-col border-b lg:border-b-0 lg:border-r border-gray-100 pb-3 lg:pb-0 lg:pr-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12.5px] font-semibold text-gray-800">Available Images ({availableImages.length})</span>
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                      <div className="relative flex-1">
                        <IconSearch size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                        <input
                          className="h-8 w-full rounded-md border border-gray-300 pl-8 pr-2 text-[12px] text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
                          placeholder="Search images..."
                          value={imageSearch}
                          onChange={(e) => { setImageSearch(e.target.value); setImagePage(1); }}
                        />
                      </div>
                      <div className="relative shrink-0">
                        <select
                          className={`${select} h-8 text-[11.5px] py-0 pr-6`}
                          value={imageTypeFilter}
                          onChange={(e) => { setImageTypeFilter(e.target.value); setImagePage(1); }}
                        >
                          <option value="ALL">All Types</option>
                          <option value="Diagram">Diagram</option>
                          <option value="Illustration">Illustration</option>
                          <option value="Photograph">Photograph</option>
                          <option value="Chart">Chart</option>
                        </select>
                        <IconChevron size={11} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-400" />
                      </div>
                    </div>

                    {/* Image Grid */}
                    <div className="mt-2.5 grid grid-cols-2 sm:grid-cols-3 gap-2 min-h-[190px]">
                      {pageImages.map((img) => {
                        const isSelected = (row.selectedImage?.id === img.id || (img.dataUri && row.selectedImage?.dataUri === img.dataUri));
                        return (
                          <div
                            key={img.id}
                            onClick={() => {
                              onUpdate({
                                selectedImage: img,
                                imageAssets: [img],
                                imageTopic: img.topic || activeTopic || row.imageTopic,
                                topic: row.topic || img.topic || activeTopic || '',
                              });
                              if (img.unit) {
                                const u = matchUnit(img.unit);
                                if (u) onWholeUnit(u);
                              }
                            }}
                            className={`group relative cursor-pointer rounded-lg border p-1.5 transition-all text-left flex flex-col justify-between ${
                              isSelected
                                ? 'border-blue-600 ring-2 ring-blue-500/20 bg-blue-50/20 shadow-xs'
                                : 'border-gray-200 bg-white hover:border-blue-300 hover:shadow-xs'
                            }`}
                          >
                            {isSelected && (
                              <span className="absolute top-1.5 left-1.5 z-10 flex h-4 w-4 items-center justify-center rounded bg-blue-600 text-white shadow-xs">
                                <IconCheck size={10} />
                              </span>
                            )}
                            <div className="flex h-20 w-full items-center justify-center rounded bg-gray-50/70 p-1 overflow-hidden">
                              {img.dataUri ? (
                                <img src={img.dataUri} alt={img.title || 'Image'} className="max-h-full max-w-full object-contain" />
                              ) : (
                                <span className="text-[10px] text-gray-400">Preview</span>
                              )}
                            </div>
                            <div className="mt-1.5 px-0.5">
                              <p className="truncate text-[11px] font-semibold text-gray-800" title={img.title}>
                                {img.title || 'Diagram'}
                              </p>
                              <p className="truncate text-[10px] text-gray-400">
                                Page {img.pageNumber || '—'} · {img.imageType || 'Diagram'}
                              </p>
                            </div>
                          </div>
                        );
                      })}
                      {pageImages.length === 0 && (
                        <div className="col-span-full flex flex-col items-center justify-center py-8 text-center text-[12px] text-gray-400">
                          <p>{loadingImages ? 'Loading images…' : `No images found${activeTopic ? ` for "${activeTopic}"` : ''}.`}</p>
                        </div>
                      )}
                    </div>

                    {/* Pagination */}
                    {totalPages > 1 && (
                      <div className="mt-2.5 flex items-center justify-center gap-1">
                        <button
                          type="button"
                          disabled={imagePage <= 1}
                          onClick={() => setImagePage((p) => Math.max(1, p - 1))}
                          className="h-6 w-6 rounded border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-30 text-[11px] flex items-center justify-center"
                        >
                          ‹
                        </button>
                        {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                          <button
                            key={p}
                            type="button"
                            onClick={() => setImagePage(p)}
                            className={`h-6 w-6 rounded text-[11.5px] font-medium flex items-center justify-center ${
                              p === imagePage
                                ? 'bg-blue-600 text-white'
                                : 'border border-gray-200 text-gray-600 hover:bg-gray-50'
                            }`}
                          >
                            {p}
                          </button>
                        ))}
                        <button
                          type="button"
                          disabled={imagePage >= totalPages}
                          onClick={() => setImagePage((p) => Math.min(totalPages, p + 1))}
                          className="h-6 w-6 rounded border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-30 text-[11px] flex items-center justify-center"
                        >
                          ›
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Column 3: Selected Image (col-span-4) */}
                  <div className="lg:col-span-4 col-span-12 flex flex-col">
                    <h4 className="text-[12.5px] font-semibold text-gray-800">Selected Image</h4>
                    {row.selectedImage ? (
                      <div className="mt-2 flex flex-col">
                        <div className="flex h-36 w-full items-center justify-center rounded-lg border border-gray-200 bg-gray-50/50 p-2 overflow-hidden">
                          {row.selectedImage.dataUri ? (
                            <img src={row.selectedImage.dataUri} alt={row.selectedImage.title || 'Selected'} className="max-h-full max-w-full object-contain" />
                          ) : (
                            <span className="text-[12px] text-gray-400">Selected Image</span>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            onUpdate({ selectedImage: null, imageAssets: null });
                          }}
                          className="mt-2 inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-300 bg-white py-1.5 text-[11.5px] font-medium text-gray-700 hover:bg-gray-50 shadow-xs"
                        >
                          <IconRefresh size={12} /> Change Image
                        </button>
                        <div className="mt-3 space-y-1 text-[11px] text-gray-600 border-t border-gray-100 pt-2.5">
                          <div>
                            <span className="text-gray-400">Source: </span>
                            <span className="font-medium text-gray-700">{row.selectedImage.source || kbDoc?.title || uploads[0]?.fileName || 'Notes.pdf'}</span>
                          </div>
                          <div>
                            <span className="text-gray-400">Unit: </span>
                            <span className="font-medium text-gray-700">{row.selectedImage.unit || unitLabel(assign.unit) || 'Unit'}</span>
                          </div>
                          <div>
                            <span className="text-gray-400">Topic: </span>
                            <span className="font-medium text-gray-700">{row.selectedImage.topic || row.imageTopic || activeTopic || 'Topic'}</span>
                          </div>
                          <div>
                            <span className="text-gray-400">Page: </span>
                            <span className="font-medium text-gray-700">{row.selectedImage.pageNumber || '1'}</span>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-2 flex h-36 w-full flex-col items-center justify-center rounded-lg border border-dashed border-gray-300 bg-gray-50/40 p-4 text-center">
                        <p className="text-[12px] font-medium text-gray-500">No image selected</p>
                        <p className="mt-0.5 text-[10.5px] text-gray-400">Select an image from the available images.</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Row below panel: Answer Type, Unit, Difficulty */}
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="block">
                  <span className="mb-1 block text-[11px] font-medium text-gray-600">Answer Type</span>
                  <div className="relative">
                    <select
                      className={`${select} w-full`}
                      value={row.answerType || 'SHORT_ANSWER'}
                      onChange={(e) => onUpdate({ answerType: e.target.value })}
                    >
                      {IMAGE_ANSWER_TYPES.map((t) => (
                        <option key={t.id} value={t.id}>{t.label}</option>
                      ))}
                    </select>
                    <IconChevron size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-400" />
                  </div>
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11px] font-medium text-gray-600">Unit</span>
                  <div className="relative">
                    <select
                      className={`${select} w-full`}
                      value={isMixed ? '' : assign.unit == null ? '' : String(assign.unit)}
                      onChange={(e) => onWholeUnit(e.target.value || null)}
                      disabled={!hasNotesSource || units.length === 0}
                    >
                      {isMixed && <option value="">Mixed</option>}
                      {!isMixed && assign.unit == null && (
                        <option value="">{hasNotesSource ? 'Choose unit…' : 'Select notes first…'}</option>
                      )}
                      {units.map((u) => <option key={u.id} value={String(u.id)}>{u.label}</option>)}
                    </select>
                    <IconChevron size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-400" />
                  </div>
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11px] font-medium text-gray-600">Difficulty</span>
                  <div className="relative">
                    <select className={`${select} w-full`} value={row.difficulty} onChange={(e) => onUpdate({ difficulty: e.target.value })}>
                      {DIFFICULTY_OPTIONS.map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                    <IconChevron size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-400" />
                  </div>
                </label>
              </div>

              {/* Topic / Concept (optional) + Teacher Hint (optional) */}
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <span className="mb-1 flex items-center gap-1 text-[11px] font-medium text-gray-600">
                    Topic / Concept (optional) <IconInfo size={11} className="text-gray-300" />
                  </span>
                  <div className="flex h-9 items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-2.5">
                    <input
                      className="min-w-0 flex-1 bg-transparent text-[12px] text-gray-800 placeholder-gray-400 focus:outline-none disabled:opacity-50"
                      placeholder={hasNotesSource ? "e.g. Parts of a plant" : "Select syllabus notes first..."}
                      disabled={!hasNotesSource}
                      value={row.topic || ''}
                      onChange={(e) => onUpdate({ topic: e.target.value })}
                    />
                    {row.topic && (
                      <button
                        type="button"
                        onClick={() => onUpdate({ topic: '' })}
                        className="p-0.5 text-gray-400 hover:text-gray-600"
                      >
                        <IconClose size={12} />
                      </button>
                    )}
                    {topicMatchesImage && (
                      <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] font-medium text-emerald-600">
                        <IconCheck size={12} /> Matches selected image topic
                      </span>
                    )}
                  </div>
                </div>
                <div>
                  <span className="mb-1 flex items-center gap-1 text-[11px] font-medium text-gray-600">
                    Teacher Hint (optional) <IconInfo size={11} className="text-gray-300" />
                  </span>
                  <input
                    className="h-9 w-full rounded-lg border border-gray-300 bg-white px-2.5 text-[12px] text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                    placeholder="e.g. Ask students to identify the labelled parts of the plant."
                    value={row.teacherHint || ''}
                    onChange={(e) => onUpdate({ teacherHint: e.target.value })}
                  />
                </div>
              </div>

              {/* Items block */}
              <div className="rounded-lg border border-gray-200 bg-white p-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex items-center gap-1 text-[12px] font-semibold text-gray-800">
                    Items ({row.itemCount})
                    <IconInfo size={11} className="text-gray-300" />
                  </span>
                  <div className="ml-auto flex items-center gap-1.5">
                    <span className="text-[11px] text-gray-500">Set all to same mark</span>
                    <div className="relative">
                      <select
                        className={`${select} w-20 h-7 text-[11.5px] py-0 pr-5`}
                        value={bulkMark}
                        onChange={(e) => setBulkMark(Number(e.target.value) || 1)}
                      >
                        <option value={0.5}>0.5</option>
                        <option value={1}>1</option>
                        <option value={1.5}>1.5</option>
                        <option value={2}>2</option>
                        <option value={2.5}>2.5</option>
                        <option value={3}>3</option>
                        <option value={4}>4</option>
                        <option value={5}>5</option>
                      </select>
                      <IconChevron size={11} className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400" />
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const next = Array.from({ length: row.itemCount }, () => bulkMark);
                        onUpdate({ uniformMarks: bulkMark, itemMarks: next });
                      }}
                      className="rounded-md border border-blue-600 px-2 py-0.5 text-[11px] font-medium text-blue-700 hover:bg-blue-50"
                    >
                      Apply
                    </button>
                  </div>
                </div>

                <div className="mt-3 space-y-2">
                  {Array.from({ length: row.itemCount }, (_, li) => (
                    <div key={li} className="flex items-center gap-2">
                      <span className="w-5 shrink-0 text-[11.5px] font-semibold text-gray-600">{letter(li)})</span>
                      <input
                        className="h-8 min-w-0 flex-1 rounded-md border border-gray-300 px-2.5 text-[12px] text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                        placeholder={li === 0 ? 'e.g. Which part of the plant absorbs water from the soil?' : 'e.g. Which part of the plant carries water towards the leaves?'}
                        value={(row.itemHints && row.itemHints[li]) || ''}
                        onChange={(e) => {
                          const itemHints = [...(row.itemHints || Array.from({ length: row.itemCount }, () => ''))];
                          itemHints[li] = e.target.value;
                          onUpdate({ itemHints });
                        }}
                      />
                      <div className="relative shrink-0">
                        <select
                          className={`${select} w-24 h-8 text-[11.5px] py-0 pr-6`}
                          value={marks[li] ?? row.uniformMarks ?? 1}
                          onChange={(e) => {
                            const next = [...marks];
                            next[li] = Number(e.target.value) || 1;
                            onUpdate({ itemMarks: next });
                          }}
                        >
                          <option value={0.5}>0.5 mark</option>
                          <option value={1}>1 mark</option>
                          <option value={1.5}>1.5 marks</option>
                          <option value={2}>2 marks</option>
                          <option value={2.5}>2.5 marks</option>
                          <option value={3}>3 marks</option>
                          <option value={4}>4 marks</option>
                          <option value={5}>5 marks</option>
                        </select>
                        <IconChevron size={11} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-400" />
                      </div>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-[11px] text-gray-400">
                  The questions and options will be generated from your selected image and notes.
                </p>
              </div>

              {issues.length > 0 && (
                <div className="space-y-0.5">
                  {issues.map((m) => <p key={m} className="text-[11.5px] text-amber-600">{key}: {m}</p>)}
                </div>
              )}
            </div>
          ) : (
            /* ════════════════════════════════════════════════════════════════
               STANDARD QUESTION CONFIGURATION
               ════════════════════════════════════════════════════════════════ */
            <>
              {/* type + item count */}
              <div className="flex flex-wrap items-end gap-4">
                <label className="block">
                  <span className="mb-1 block text-[11px] font-medium text-gray-600">Question Type</span>
                  <div className="relative">
                    <select className={`${select} w-44`} value={row.type} onChange={(e) => onChangeType(e.target.value)}>
                      <option value="">Choose type…</option>
                      {types.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                    </select>
                    <IconChevron size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-400" />
                  </div>
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11px] font-medium text-gray-600">Number of Items</span>
                  <div className="relative">
                    <select className={`${select} w-20`} value={row.itemCount} onChange={(e) => onChangeItemCount(e.target.value)}>
                      {Array.from({ length: 15 }, (_, n) => n + 1).filter((n) => n >= (def?.countMin ?? 1)).map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                    <IconChevron size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-400" />
                  </div>
                </label>
                {(def?.optionMode === 'required' || def?.optionMode === 'optional') && (
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-medium text-gray-600">{def.optionMode === 'optional' ? 'Word bank' : 'Options / item'}</span>
                    <input type="number" min={2} max={8} className={`${field} w-16 text-center`} value={row.optionCount ?? ''} onChange={(e) => onUpdate({ optionCount: e.target.value === '' ? '' : Number(e.target.value) })} />
                  </label>
                )}
              </div>

              {/* marks */}
              {!whole ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-medium text-gray-600">Marks</span>
                    <label className="flex items-center gap-1.5 text-[12px] text-gray-700">
                      <input type="radio" name={`marks-${key}`} checked={!varied} onChange={setSameForAll} className="accent-blue-600" />
                      Same for all
                      <input
                        type="number" min={0.5} step={0.5} disabled={varied}
                        className={`${marksInput} disabled:bg-gray-50 disabled:text-gray-400`}
                        value={row.uniformMarks}
                        onChange={(e) => {
                          const v = Number(e.target.value) || 1;
                          onUpdate({ uniformMarks: v, itemMarks: Array.from({ length: row.itemCount }, () => v) });
                        }}
                      />
                    </label>
                  </div>
                  <label className="flex flex-wrap items-center gap-2 text-[12px] text-gray-700">
                    <input type="radio" name={`marks-${key}`} checked={varied} onChange={() => onVaried(true)} className="accent-blue-600" />
                    Different per item
                    {varied && marks.map((m, mi) => (
                      <span key={mi} className="inline-flex items-center gap-1">
                        <span className="text-[11px] text-gray-400">{letter(mi)})</span>
                        <input
                          type="number" min={0.5} step={0.5} className={marksInput}
                          value={m}
                          onChange={(e) => {
                            const next = [...marks];
                            next[mi] = Number(e.target.value) || 0;
                            onUpdate({ itemMarks: next });
                          }}
                        />
                      </span>
                    ))}
                  </label>
                </div>
              ) : (
                <label className="flex items-center gap-2 text-[12px] text-gray-700">
                  <span className="text-[11px] font-medium text-gray-600">Total marks (whole question)</span>
                  <input type="number" min={1} step={1} className={marksInput} value={row.wholeMarks} onChange={(e) => onUpdate({ wholeMarks: Number(e.target.value) || 1 })} />
                </label>
              )}

              {/* topic / unit / difficulty */}
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <span className="mb-1 flex items-center gap-1 text-[11px] font-medium text-gray-600">
                    Topic / Concept <IconInfo size={11} className="text-gray-300" />
                  </span>
                  <div className="flex h-9 items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-2">
                    <input
                      className="min-w-0 flex-1 bg-transparent text-[12px] text-gray-800 placeholder-gray-400 focus:outline-none"
                      list={`topics-${key}`}
                      placeholder="Type or pick a topic"
                      value={row.topic}
                      onFocus={onLoadTopics}
                      onChange={(e) => onUpdate({ topic: e.target.value })}
                      onBlur={(e) => e.target.value.trim() && onCheckCoverage(e.target.value)}
                    />
                    <datalist id={`topics-${key}`}>
                      {(Array.isArray(topics) ? topics : []).map((t) => <option key={t.topic} value={t.topic}>{`${t.topic} (${t.chunkCount} chunks)`}</option>)}
                    </datalist>
                    {coverage === 'pending' && <span className="shrink-0 text-[10.5px] text-gray-400">checking…</span>}
                    {coverage && coverage !== 'pending' && coverage.matched === true && (
                      <span className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap text-[10.5px] font-medium text-emerald-600"><IconCheck size={11} /> {coverage.chunkCount} chunks found</span>
                    )}
                    {coverage && coverage !== 'pending' && coverage.matched === false && (
                      <span className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap text-[10.5px] font-medium text-amber-600"><IconWarn size={11} /> not found</span>
                    )}
                  </div>
                </div>
                <label className="block">
                  <span className="mb-1 block text-[11px] font-medium text-gray-600">Unit</span>
                  <div className="relative">
                    <select
                      className={`${select} w-full`}
                      value={isMixed ? '' : assign.unit == null ? '' : String(assign.unit)}
                      onChange={(e) => onWholeUnit(e.target.value || null)}
                      disabled={units.length === 0}
                    >
                      {isMixed && <option value="">Mixed</option>}
                      {!isMixed && assign.unit == null && <option value="">Choose unit…</option>}
                      {units.map((u) => <option key={u.id} value={String(u.id)}>{u.label}</option>)}
                    </select>
                    <IconChevron size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-400" />
                  </div>
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11px] font-medium text-gray-600">Difficulty</span>
                  <div className="relative">
                    <select className={`${select} w-full`} value={row.difficulty} onChange={(e) => onUpdate({ difficulty: e.target.value })}>
                      {DIFFICULTY_OPTIONS.map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                    <IconChevron size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-400" />
                  </div>
                </label>
              </div>

              {/* items block */}
              {!whole && (
                <div className="rounded-lg border border-gray-200 bg-white p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="flex items-center gap-1 text-[12px] font-semibold text-gray-800">
                      Items ({row.itemCount})
                      <span className="text-[11px] font-normal text-gray-400">Hint (optional)</span>
                      <IconInfo size={11} className="text-gray-300" />
                    </span>
                    <div className="ml-auto flex items-center gap-1.5">
                      <span className="text-[11px] text-gray-500">Set all to same unit</span>
                      <div className="relative">
                        <select className={`${select} w-24`} value={setAllUnit} onChange={(e) => setSetAllUnit(e.target.value)}>
                          <option value="">Unit…</option>
                          {units.map((u) => <option key={u.id} value={String(u.id)}>{u.label}</option>)}
                        </select>
                        <IconChevron size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-400" />
                      </div>
                      <button type="button" onClick={() => setAllUnit && onSetAll(setAllUnit)} disabled={!setAllUnit} className="rounded-md border border-blue-600 px-2 py-1 text-[11px] font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-40">Apply</button>
                    </div>
                  </div>

                  <div className="mt-2 space-y-1.5">
                    {Array.from({ length: row.itemCount }, (_, li) => (
                      <div key={li} className="flex items-center gap-2">
                        <span className="w-5 shrink-0 text-[11.5px] text-gray-400">{letter(li)})</span>
                        <input
                          className="h-8 min-w-0 flex-1 rounded-md border border-gray-300 px-2 text-[12px] text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                          placeholder="e.g. definition of adjective, use in a sentence, etc."
                          value={(row.itemHints && row.itemHints[li]) || ''}
                          onChange={(e) => {
                            const itemHints = [...(row.itemHints || Array.from({ length: row.itemCount }, () => ''))];
                            itemHints[li] = e.target.value;
                            onUpdate({ itemHints });
                          }}
                        />
                        <span className="w-14 shrink-0 text-right text-[11.5px] text-gray-500">
                          {marks[li] ?? row.uniformMarks} {(marks[li] ?? row.uniformMarks) === 1 ? 'mark' : 'marks'}
                        </span>
                        <div className="relative shrink-0">
                          <select
                            className={`${select} w-24`}
                            value={itemUnits[li] == null ? '' : String(itemUnits[li])}
                            onChange={(e) => onItemUnit(li, e.target.value || null)}
                            disabled={units.length === 0}
                          >
                            <option value="">Unit…</option>
                            {units.map((u) => <option key={u.id} value={String(u.id)}>{u.label}</option>)}
                          </select>
                          <IconChevron size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-400" />
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-[11px] text-gray-400">Hints guide what each item covers. The questions themselves are generated from your notes.</p>
                </div>
              )}

              {issues.length > 0 && (
                <div className="space-y-0.5">
                  {issues.map((m) => <p key={m} className="text-[11.5px] text-amber-600">{key}: {m}</p>)}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-center gap-1">
          <button type="button" onClick={onToggle} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"><IconChevron size={14} /></button>
          <button type="button" onClick={onDuplicate} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"><IconCopy size={14} /></button>
          <button type="button" onClick={onRemove} disabled={!canRemove} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-red-500 disabled:opacity-30"><IconTrash size={14} /></button>
        </div>
      </div>
    </div>
  );
}
