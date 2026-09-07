import { useEffect, useMemo, useState } from 'react';
import {
  emptyQuestion, resizeItemMarks, paperTotal, rowIssues, buildFormPayload, rowsFromTemplate,
  DIFFICULTY_OPTIONS,
} from '../services/manualBlueprint.js';
import { FALLBACK_TYPES, defOf, fieldsFor, isWholeMarks } from '../services/questionTypeFields.js';
import { kbService, manualService, templateService, questionService } from '../services/api.js';

const fieldClass =
  'h-9 rounded-lg border border-gray-300 bg-white px-2.5 text-[13px] text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors';
const smallField = `${fieldClass} w-16`;
const numInput = 'w-16 h-9 rounded-lg border border-gray-300 bg-white px-2 text-[13px] text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500';

const Svg = ({ d, size = 16, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    {Array.isArray(d) ? d.map((p, i) => <path key={i} d={p} />) : <path d={d} />}
  </svg>
);
const Trash = (p) => <Svg d={['M3 6h18', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6']} {...p} />;
const Copy = (p) => <Svg d={['M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2Z', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1']} {...p} />;
const Warn = (p) => <Svg d={['M12 9v4', 'M12 17h.01', 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z']} {...p} />;
const Check = (p) => <Svg d="m9 12 2 2 4-4" {...p} />;
const Save = (p) => <Svg d={['M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z', 'M17 21v-8H7v8', 'M7 3v5h8']} {...p} />;
const Chevron = (p) => <Svg d="m6 9 6 6 6-6" {...p} />;

/**
 * Mode B — QuestionBuilder (step 2 of the manual flow).
 * The teacher defines every question: type (from the registry), item count,
 * per-item marks, topic (combobox: detected suggestions + free text + inline
 * coverage ✓/⚠), difficulty, unit pre-assignment, sections. On submit it posts
 * { blueprint: form } to /papers/manual and hands the analyze-shaped response
 * to the App, which continues into the EXISTING confirm + generate steps.
 */
export default function QuestionBuilder({ paperMeta, onCreated, onCancel }) {
  const cls = String(paperMeta.class ?? '').trim();
  const subject = String(paperMeta.subject ?? '').trim();

  // Registry (server source of truth, offline fallback)
  const [types, setTypes] = useState(FALLBACK_TYPES);
  useEffect(() => {
    let live = true;
    questionService.listTypes()
      .then((res) => { if (live && Array.isArray(res?.data) && res.data.length > 0) setTypes(res.data); })
      .catch(() => { /* fallback list already set */ });
    return () => { live = false; };
  }, []);

  // Units for unit pre-assignment (uploads happen later on the confirm screen)
  const [units, setUnits] = useState([]);
  useEffect(() => {
    let live = true;
    if (!cls || !subject) return undefined;
    kbService.listUnits({ class: cls, subject })
      .then((res) => { if (live) setUnits(Array.isArray(res?.data) ? res.data : []); })
      .catch(() => { /* units are optional here */ });
    return () => { live = false; };
  }, [cls, subject]);

  // Paper details
  const [examTitle, setExamTitle] = useState('');
  const [maximumMarks, setMaximumMarks] = useState('');
  const [duration, setDuration] = useState('');
  const [sections, setSections] = useState([]); // ['SECTION A', ...]
  const [newSection, setNewSection] = useState('');

  // Question rows
  const [rows, setRows] = useState([emptyQuestion(null)]);

  // Templates
  const [templates, setTemplates] = useState([]);
  const [tplName, setTplName] = useState('');
  const [tplMsg, setTplMsg] = useState('');
  useEffect(() => {
    let live = true;
    if (!cls || !subject) return undefined;
    templateService.list({ class: cls, subject })
      .then((res) => { if (live) setTemplates(Array.isArray(res?.data) ? res.data : []); })
      .catch(() => { /* listing templates is optional */ });
    return () => { live = false; };
  }, [cls, subject]);

  // Submission state
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [slotErrors, setSlotErrors] = useState([]);
  const [warnings, setWarnings] = useState([]);

  const total = useMemo(() => paperTotal(rows), [rows]);

  const updateRow = (i, patch) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const changeType = (i, typeId) => {
    const def = defOf(types, typeId);
    setRows((rs) =>
      rs.map((r, idx) => {
        if (idx !== i) return r;
        const whole = isWholeMarks(def);
        return {
          ...r,
          type: typeId,
          itemCount: def?.countMin === 2 && r.itemCount < 2 ? 2 : r.itemCount,
          marksMode: whole ? 'whole' : 'perItem',
          optionCount: def?.optionMode === 'required' ? 4 : r.optionCount,
        };
      })
    );
  };

  const changeItemCount = (i, count) => {
    setRows((rs) =>
      rs.map((r, idx) => {
        if (idx !== i) return r;
        const def = defOf(types, r.type);
        const min = Math.max(1, def?.countMin ?? 1);
        const c = Math.max(min, Math.round(Number(count) || min));
        return { ...r, itemCount: c, itemMarks: resizeItemMarks(r.itemMarks, c, r.uniformMarks) };
      })
    );
  };

  const addRow = () => setRows((rs) => [...rs, emptyQuestion(sections[0] ?? null)]);
  const duplicateRow = (i) => setRows((rs) => [...rs.slice(0, i + 1), { ...rs[i] }, ...rs.slice(i + 1)]);
  const removeRow = (i) => setRows((rs) => (rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs));

  const addSection = () => {
    const name = newSection.trim().toUpperCase();
    if (!name || sections.includes(name)) return;
    setSections((s) => [...s, name]);
    setNewSection('');
  };

  // ── Unit pre-assignment (rows collapse by default: one unit per question) ──
  const [assign, setAssign] = useState({});
  useEffect(() => {
    setAssign((prev) => {
      const next = {};
      rows.forEach((r, i) => {
        const key = `Q${i + 1}`;
        next[key] = prev[key] ?? { unit: units[0]?.id ?? null, items: {} };
      });
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length, units]);

  const assignRow = (i, unitId) => setAssign((m) => ({ ...m, [`Q${i + 1}`]: { unit: unitId, items: {} } }));

  // ── Topic suggestions + inline coverage ──────────────────────────────────
  // Unit for suggestions is the row's assigned unit (or the first unit).
  const [topicsCache, setTopicsCache] = useState({}); // unit -> [{ topic, chunkCount }]
  const [coverage, setCoverage] = useState({}); // `${rowIdx}` -> { matched, chunkCount } | 'pending'

  const unitForRow = (row) => {
    const key = `Q${rows.indexOf(row) + 1}`;
    const a = assign[key];
    return a?.unit ?? units[0]?.id ?? null;
  };

  const loadTopics = async (unit) => {
    if (!unit || topicsCache[unit]) return;
    setTopicsCache((c) => ({ ...c, [unit]: 'pending' }));
    try {
      const res = await kbService.listTopics({ class: cls, subject, unit });
      setTopicsCache((c) => ({ ...c, [unit]: Array.isArray(res?.data) ? res.data : [] }));
    } catch {
      setTopicsCache((c) => ({ ...c, [unit]: [] })); // suggestions are optional; free text always works
    }
  };

  const checkCoverage = async (i, row, topic) => {
    const unit = unitForRow(row);
    if (!topic.trim() || !unit) return;
    setCoverage((c) => ({ ...c, [i]: 'pending' }));
    try {
      const res = await kbService.topicCoverage({ class: cls, subject, unit, topic: topic.trim() });
      setCoverage((c) => ({ ...c, [i]: res?.data ?? { matched: false, chunkCount: 0 } }));
    } catch {
      setCoverage((c) => ({ ...c, [i]: { matched: null, chunkCount: 0 } })); // advisory only
    }
  };

  // ── Templates ─────────────────────────────────────────────────────────────
  const loadTemplate = async (id) => {
    setTplMsg('');
    try {
      const res = await templateService.get(id);
      const tplBp = res?.data?.blueprint;
      if (!tplBp) return;
      const newRows = rowsFromTemplate(tplBp);
      setRows(newRows.length > 0 ? newRows : rows);
      setSections((tplBp.sections || []).map((s) => s.name).filter(Boolean));
      setExamTitle(tplBp.paper?.examTitle || '');
      setMaximumMarks(tplBp.paper?.maximumMarks != null ? String(tplBp.paper.maximumMarks) : '');
      setTplMsg(`Template "${res.data.name}" loaded.`);
    } catch {
      setTplMsg('Could not load that template.');
    }
  };

  const saveAsTemplate = async () => {
    setTplMsg('');
    const name = tplName.trim();
    if (!name) {
      setTplMsg('Give the template a name first.');
      return;
    }
    try {
      await templateService.save({ name, blueprint: buildFormPayload({ paper: paperHeader(), sections: sectionObjs(), questions: rows }) });
      setTplName('');
      setTplMsg('Template saved (structure only — units & topics stay yours to choose each time).');
      const list = await templateService.list({ class: cls, subject });
      setTemplates(Array.isArray(list?.data) ? list.data : []);
    } catch (err) {
      setTplMsg(err?.response?.data?.message || 'Could not save the template.');
    }
  };

  // ── Submit ────────────────────────────────────────────────────────────────
  const paperHeader = () => ({
    class: cls,
    subject,
    examTitle: examTitle || null,
    maximumMarks: maximumMarks !== '' && Number(maximumMarks) > 0 ? Number(maximumMarks) : null,
    duration: duration || null,
  });
  const sectionObjs = () => sections.map((name) => ({ name, title: null, questionNumbers: rows.map((r, i) => (r.section === name ? `Q${i + 1}` : null)).filter(Boolean) }));

  const clientIssues = useMemo(() => {
    const out = [];
    rows.forEach((r, i) => {
      const def = defOf(types, r.type);
      rowIssues(r, def?.countMin ?? 1).forEach((msg) => out.push(`Q${i + 1}: ${msg}`));
      if (def && r.section && !sections.includes(r.section)) out.push(`Q${i + 1}: belongs to undeclared section ${r.section}.`);
    });
    return out;
  }, [rows, sections, types]);

  const submit = async () => {
    if (busy) return;
    setError(null);
    setSlotErrors([]);
    setWarnings([]);
    setBusy(true);
    try {
      const payload = { blueprint: buildFormPayload({ paper: paperHeader(), sections: sectionObjs(), questions: rows }) };
      const res = await manualService.create(payload);
      // Same shape as /papers/analyze → hand straight to the App's confirm step.
      // Pre-seeded unit assignments ride along for the confirm screen.
      onCreated({
        jobId: res.jobId,
        blueprint: res.blueprint,
        availableUnits: Array.isArray(res.availableUnits) ? res.availableUnits : [],
        assignments: Object.fromEntries(
          Object.entries(assign).filter(([, v]) => v?.unit != null)
        ),
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

  return (
    <div className="space-y-4">
      {/* Paper details */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-4">
        <div className="flex items-center justify-between">
          <p className="text-[13px] font-semibold text-gray-900">Paper details</p>
          <span className="text-[12px] text-gray-500">Class {cls} · {subject || '—'}</span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <input className={fieldClass} placeholder="Examination title" value={examTitle} onChange={(e) => setExamTitle(e.target.value)} />
          <input className={fieldClass} placeholder="Maximum marks (declared total)" value={maximumMarks} onChange={(e) => setMaximumMarks(e.target.value)} />
          <input className={fieldClass} placeholder="Duration (e.g. 2hrs 30mins)" value={duration} onChange={(e) => setDuration(e.target.value)} />
          <div className="flex gap-2">
            <input className={`${fieldClass} flex-1`} placeholder="Add section (e.g. SECTION A)" value={newSection} onChange={(e) => setNewSection(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addSection()} />
            <button type="button" onClick={addSection} className="h-9 rounded-lg border border-gray-300 px-3 text-[13px] text-gray-700 hover:bg-gray-50">Add</button>
          </div>
        </div>
        {sections.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {sections.map((s) => (
              <span key={s} className="inline-flex items-center gap-1 rounded-full border border-gray-300 bg-gray-50 px-2.5 py-1 text-[12px] text-gray-700">
                {s}
                <button type="button" onClick={() => setSections((ss) => ss.filter((x) => x !== s))} className="text-gray-400 hover:text-red-500">×</button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Templates */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-4">
        <div className="flex items-center gap-2">
          <Save size={15} className="text-gray-500" />
          <p className="text-[13px] font-semibold text-gray-900">Templates</p>
          <span className="text-[11.5px] text-gray-400">(structure only — units &amp; topics never saved)</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {templates.map((t) => (
            <span key={t.id} className="inline-flex items-center gap-1.5 rounded-full border border-gray-300 bg-gray-50 px-2.5 py-1 text-[12px] text-gray-700">
              <button type="button" onClick={() => loadTemplate(t.id)} className="font-medium hover:underline">{t.name}</button>
              <span className="text-gray-400">·</span>
              <span className="tabular-nums">{t.questionCount}Q / {t.totalMarks}m</span>
              <button type="button" onClick={() => templateService.delete(t.id).then(() => setTemplates((ts) => ts.filter((x) => x.id !== t.id))).catch(() => {})} className="text-gray-400 hover:text-red-500">×</button>
            </span>
          ))}
          {templates.length === 0 && <span className="text-[12px] text-gray-400">No saved templates for this class &amp; subject yet.</span>}
        </div>
        <div className="mt-2 flex gap-2">
          <input className={`${fieldClass} w-56`} placeholder="Save current structure as…" value={tplName} onChange={(e) => setTplName(e.target.value)} />
          <button type="button" onClick={saveAsTemplate} className="h-9 rounded-lg border border-blue-700 px-3 text-[13px] font-medium text-blue-700 hover:bg-blue-50">Save template</button>
        </div>
        {tplMsg && <p className="mt-1.5 text-[12px] text-gray-500">{tplMsg}</p>}
      </div>

      {/* Question rows */}
      <div className="space-y-3">
        {rows.map((row, i) => {
          const def = defOf(types, row.type);
          const whole = isWholeMarks(def);
          const fields = fieldsFor(def);
          const key = `Q${i + 1}`;
          const cov = coverage[i];
          const topics = topicsCache[unitForRow(row)];
          const issues = clientIssues.filter((m) => m.startsWith(`${key}:`));

          return (
            <div key={key} className="rounded-xl border border-gray-200 bg-white shadow-sm p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-9 text-[13px] font-semibold text-gray-800">{key}</span>
                <div className="relative">
                  <select className={`${fieldClass} w-44 appearance-none pr-7`} value={row.type} onChange={(e) => changeType(i, e.target.value)}>
                    <option value="">Choose type…</option>
                    {types.map((t) => (
                      <option key={t.id} value={t.id}>{t.label}</option>
                    ))}
                  </select>
                  <Chevron size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-400" />
                </div>

                {fields.map((f) => (
                  <label key={f.key} className="flex items-center gap-1.5 text-[12px] text-gray-500">
                    {f.label}
                    <input
                      type="number"
                      min={f.min}
                      max={f.max}
                      step={f.step}
                      className={numInput}
                      value={row[f.key] ?? ''}
                      onChange={(e) => (f.key === 'itemCount' ? changeItemCount(i, e.target.value) : updateRow(i, { optionCount: e.target.value === '' ? '' : Number(e.target.value) }))}
                    />
                  </label>
                ))}

                <div className="ml-auto flex items-center gap-2">
                  <select className={`${fieldClass} w-28`} value={row.section ?? ''} onChange={(e) => updateRow(i, { section: e.target.value || null })}>
                    <option value="">No section</option>
                    {sections.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <select className={`${fieldClass} w-24`} value={row.difficulty} onChange={(e) => updateRow(i, { difficulty: e.target.value })}>
                    {DIFFICULTY_OPTIONS.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                  <button type="button" onClick={() => duplicateRow(i)} title="Duplicate" className="h-8 w-8 flex items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-700"><Copy size={15} /></button>
                  <button type="button" onClick={() => removeRow(i)} title="Delete" disabled={rows.length === 1} className="h-8 w-8 flex items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-red-500 disabled:opacity-30"><Trash size={15} /></button>
                </div>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-3">
                {/* Marks: per-item (uniform or per row) or whole-question */}
                {!whole && (
                  <>
                    <label className="flex items-center gap-1.5 text-[12px] text-gray-500">
                      Marks per item
                      <input type="number" min={0.5} step={0.5} className={smallField} value={row.uniformMarks}
                        onChange={(e) => updateRow(i, { uniformMarks: Number(e.target.value) || 1, itemMarks: resizeItemMarks(row.itemMarks, row.itemCount, Number(e.target.value) || 1) })} />
                    </label>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[12px] text-gray-500">Per item:</span>
                      {resizeItemMarks(row.itemMarks, row.itemCount, row.uniformMarks).map((m, mi) => (
                        <input key={mi} type="number" min={0.5} step={0.5} className={smallField} value={m} title={`Item ${String.fromCharCode(97 + mi)} marks`}
                          onChange={(e) => {
                            const v = Number(e.target.value) || 0;
                            const next = [...row.itemMarks];
                            next[mi] = v;
                            updateRow(i, { itemMarks: next });
                          }} />
                      ))}
                    </div>
                  </>
                )}
                {whole && (
                  <label className="flex items-center gap-1.5 text-[12px] text-gray-500">
                    Total marks (whole question)
                    <input type="number" min={1} step={1} className={smallField} value={row.wholeMarks} onChange={(e) => updateRow(i, { wholeMarks: Number(e.target.value) || 1 })} />
                  </label>
                )}

                {/* Unit pre-assignment (confirm screen still enforces before generate) */}
                <label className="ml-auto flex items-center gap-1.5 text-[12px] text-gray-500">
                  Unit
                  <select className={`${fieldClass} w-32`} value={assign[key]?.unit ?? ''} onChange={(e) => assignRow(i, e.target.value ? units.find((u) => String(u.id) === e.target.value)?.id ?? null : null)}>
                    <option value="">Choose on next screen…</option>
                    {units.map((u) => <option key={u.id} value={String(u.id)}>{u.label}</option>)}
                  </select>
                </label>
              </div>

              {/* Topic combobox: detected suggestions + free text + inline coverage */}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  className={`${fieldClass} w-72`} list={`topics-${key}`}
                  placeholder="Topic (suggestions below — or type your own)"
                  value={row.topic}
                  onChange={(e) => updateRow(i, { topic: e.target.value })}
                  onFocus={() => loadTopics(unitForRow(row))}
                />
                <datalist id={`topics-${key}`}>
                  {(Array.isArray(topics) ? topics : []).map((t) => (
                    <option key={t.topic} value={t.topic}>{`${t.topic} (${t.chunkCount} chunks)`}</option>
                  ))}
                </datalist>
                <button
                  type="button"
                  onClick={() => checkCoverage(i, row, row.topic)}
                  disabled={!row.topic.trim()}
                  className="h-9 rounded-lg border border-gray-300 px-3 text-[12px] text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                >
                  Check coverage
                </button>
                {cov === 'pending' && <span className="text-[12px] text-gray-400">checking…</span>}
                {cov && cov !== 'pending' && (
                  cov.matched === true ? (
                    <span className="inline-flex items-center gap-1 text-[12px] text-emerald-700"><Check size={13} /> {cov.chunkCount} chunk{cov.chunkCount === 1 ? '' : 's'} found</span>
                  ) : cov.matched === false ? (
                    <span className="inline-flex items-center gap-1 text-[12px] text-amber-600"><Warn size={13} /> not found in this unit&apos;s notes</span>
                  ) : null
                )}
              </div>

              {issues.length > 0 && (
                <div className="mt-2 space-y-0.5">
                  {issues.map((m) => <p key={m} className="text-[12px] text-amber-600">{m}</p>)}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-4">
        {error && <p className="mb-2 text-[13px] text-red-600">{error}</p>}
        {slotErrors.length > 0 && (
          <div className="mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2">
            <p className="text-[12px] font-medium text-red-700">Fix these before continuing:</p>
            <ul className="mt-1 list-disc pl-5 text-[12px] text-red-700">
              {slotErrors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          </div>
        )}
        {warnings.length > 0 && (
          <div className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
            <ul className="list-disc pl-5 text-[12px] text-amber-800">
              {warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={addRow} className="h-9 rounded-lg border border-gray-300 px-3 text-[13px] text-gray-700 hover:bg-gray-50">+ Add question</button>
          <span className="text-[12px] text-gray-500">{rows.length} question{rows.length === 1 ? '' : 's'} · total <span className="tabular-nums">{total}</span> marks{maximumMarks !== '' && Number(maximumMarks) > 0 && Number(maximumMarks) !== total ? ` (declared ${maximumMarks})` : ''}</span>
          <div className="ml-auto flex gap-2">
            <button type="button" onClick={onCancel} className="h-10 rounded-lg border border-gray-300 px-4 text-[13px] text-gray-600 hover:bg-gray-50">Cancel</button>
            <button type="button" onClick={submit} disabled={busy || rows.some((r) => !r.type)} className="h-10 rounded-lg bg-blue-700 px-5 text-[13px] font-semibold text-white hover:bg-blue-800 disabled:opacity-60">
              {busy ? 'Creating…' : 'Continue to unit assignment'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
