import { useEffect, useMemo, useRef, useState } from 'react';
import {
  slotKey,
  anyText,
  marksText,
  itemLabels,
  itemMarksOf,
  isExpandable,
  isApproximate,
  lockReason,
  isMixed,
  defaultAssign,
  buildSlotUnitMap,
  runningTotals,
  unassignedList,
} from './blueprintUnits.js';

/* ─────────────────────────────────────────────────────────────
   Confirm screen — blueprint review + per-question unit assignment.

   Sits between `analyzing` and `generating` in the App state machine.
   Question types, item counts and marks are READ-ONLY: they come from the
   reference paper. The teacher edits only the unit dropdowns and difficulty.
───────────────────────────────────────────────────────────── */

const DIFFICULTY_OPTIONS = ['Easy', 'Medium', 'Difficult'];

const selectClass =
  'w-full h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-800 appearance-none pr-8 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors';
const fieldClass =
  'h-9 rounded-lg border border-gray-300 bg-white px-3 text-[13px] text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors';
const rowSelectClass =
  'h-8 rounded-md border border-gray-300 bg-white pl-2 pr-7 text-[13px] text-gray-800 appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 disabled:bg-gray-50 disabled:text-gray-400';

const Svg = ({ d, size = 16, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    {Array.isArray(d) ? d.map((p, i) => <path key={i} d={p} />) : <path d={d} />}
  </svg>
);
const ChevronDown = (p) => <Svg d="m6 9 6 6 6-6" {...p} />;
const ChevronRight = (p) => <Svg d="m9 18 6-6-6-6" {...p} />;
const InfoIcon = (p) => <Svg d={['M12 16v-4', 'M12 8h.01', 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z']} {...p} />;
const AlertIcon = (p) => <Svg d={['M12 9v4', 'M12 17h.01', 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z']} {...p} />;
const LockIcon = (p) => <Svg d={['M5 11h14v10H5z', 'M8 11V7a4 4 0 0 1 8 0v4']} {...p} />;
const UploadIcon = (p) => <Svg d={['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm17 8-5-5-5 5', 'M12 3v12']} {...p} />;

const SectionCard = ({ title, children }) => (
  <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
    {title && <div className="px-4 pt-3.5 pb-2 text-[13px] font-semibold text-gray-900">{title}</div>}
    <div className="px-4 pb-4">{children}</div>
  </div>
);

/** One unit <select>, used at question level and item level. */
function UnitSelect({ value, units, onChange, mixed }) {
  return (
    <div className="relative inline-flex">
      <select
        className={rowSelectClass}
        disabled={units.length === 0}
        value={mixed ? '' : value == null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value)}
      >
        {mixed && <option value="">Mixed</option>}
        {!mixed && value == null && <option value="">Choose unit…</option>}
        {units.map((u) => (
          <option key={u.id} value={String(u.id)}>
            {u.label}
          </option>
        ))}
      </select>
      <ChevronDown size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-400" />
    </div>
  );
}

export default function ConfirmScreen({
  blueprint,
  units = [],
  difficulty,
  onDifficultyChange,
  onAddNotes,
  onGenerate,
  busy = false,
  initialAssign = null, // Mode B: unit assignments pre-seeded in the builder
  source = 'reference', // 'reference' (Mode A, uploaded paper) | 'manual' (Mode B, teacher-built)
}) {
  const fromReference = source !== 'manual';
  const questions = blueprint?.questions || [];
  const coerceId = (raw) => {
    const hit = units.find((u) => String(u.id) === String(raw));
    return hit ? hit.id : null;
  };

  // Assignment state — re-seeded when a different blueprint arrives; edits
  // within one blueprint (one jobId) are preserved.
  const [assign, setAssign] = useState(() => defaultAssign(blueprint, units));
  const [expanded, setExpanded] = useState(() => new Set());
  const seededFor = useRef(null);
  useEffect(() => {
    const stamp = blueprint?.jobId || JSON.stringify(questions.map((q, i) => slotKey(q, i))) + '|' + units.map((u) => u.id).join(',');
    if (seededFor.current === stamp) return;
    seededFor.current = stamp;
    // Mode B handoff: the builder's pre-assignments win when a row's unit is
    // present in the unit list; everything else falls back to the default.
    setAssign((prev) => {
      const base = defaultAssign(blueprint, units);
      if (prev && Object.keys(prev).length > 0 && initialAssign == null) return prev;
      if (initialAssign == null) return base;
      const merged = { ...base };
      for (const [k, v] of Object.entries(initialAssign)) {
        if (v?.unit != null && merged[k]) merged[k] = { ...merged[k], unit: v.unit, items: {} };
      }
      return merged;
    });
    setExpanded(new Set());
  }, [blueprint, units]); // eslint-disable-line react-hooks/exhaustive-deps

  const setQ = (key, updater) =>
    setAssign((m) => ({ ...m, [key]: updater(m[key] || { unit: null, items: {} }) }));

  const seedItems = (q, unit) => Object.fromEntries(itemLabels(q).map((l) => [l, unit ?? null]));

  const assignWholeQuestion = (q, key, rawVal) => {
    const v = rawVal === '' ? null : coerceId(rawVal);
    setQ(key, () => ({ unit: v, items: expanded.has(key) ? seedItems(q, v) : {} }));
  };

  const assignItem = (q, key, label, rawVal) => {
    const v = rawVal === '' ? null : coerceId(rawVal);
    setQ(key, (a) => {
      const items = { ...seedItems(q, a.unit), ...a.items, [label]: v };
      const vals = itemLabels(q).map((l) => items[l]);
      const uniform = vals.every((x) => x != null) && new Set(vals).size === 1;
      return { unit: uniform ? vals[0] : a.unit, items };
    });
  };

  const toggleExpand = (q, key) => {
    setExpanded((s) => {
      const n = new Set(s);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
    setQ(key, (a) => (Object.keys(a.items).length ? a : { ...a, items: seedItems(q, a.unit) }));
  };

  const { totals, unassigned, unknownItems, approximate } = useMemo(
    () => runningTotals(blueprint, assign, units),
    [blueprint, assign, units]
  );
  const unassignedKeys = useMemo(() => unassignedList(blueprint, assign), [blueprint, assign]);
  const maxBar = Math.max(1, unassigned, ...Object.values(totals));
  const warnings = useMemo(
    () =>
      (blueprint?.blueprintWarnings || [])
        .map((w) => (typeof w === 'string' ? w : [w.label, w.warning].filter(Boolean).join(': ')))
        .filter(Boolean),
    [blueprint]
  );

  const noUnits = units.length === 0;
  const canGenerate = !busy && !noUnits && unassignedKeys.length === 0;

  /* ── Notes upload ────────────────────────────────────────── */
  const fileInputs = useRef({});
  const newFileInput = useRef(null);
  const [addingId, setAddingId] = useState(null);
  const [newUnit, setNewUnit] = useState('');
  const doAdd = async (unitId, file) => {
    if (!file || !onAddNotes || !String(unitId).trim()) return;
    setAddingId(unitId);
    try {
      await onAddNotes(String(unitId).trim(), file);
    } finally {
      setAddingId(null);
      setNewUnit('');
    }
  };

  return (
    <div className="space-y-4">
      {/* 1 ── Blueprint summary ──────────────────────────────── */}
      <SectionCard>
        <div className="flex items-center justify-between">
          <div className="flex items-baseline gap-3 text-sm text-gray-800">
            <span className="font-semibold">{blueprint.totalQuestions ?? questions.length}</span>
            <span className="text-gray-500">questions</span>
            <span className="font-semibold">{(blueprint.sections || []).length}</span>
            <span className="text-gray-500">sections</span>
            <span className="font-semibold">{blueprint.totalMarks ?? '—'}</span>
            <span className="text-gray-500">marks</span>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full border border-gray-300 bg-gray-50 px-2 py-0.5 text-[11px] font-medium text-gray-600">
            <LockIcon size={12} /> LOCKED
          </span>
        </div>
        <p className="mt-2 text-[12px] text-gray-500">
          {fromReference
            ? 'Question types, item counts and marks come from the reference paper and cannot be edited here.'
            : 'Question types, item counts and marks are as you set them in the builder and are locked for generation.'}
        </p>
        {warnings.length > 0 && (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
            <p className="flex items-center gap-1.5 text-[12px] font-medium text-amber-800">
              <AlertIcon size={14} />{' '}
              {fromReference
                ? 'The reference paper did not parse cleanly — check before generating:'
                : 'Check these before generating:'}
            </p>
            <ul className="mt-1 list-disc pl-6 text-[12px] text-amber-800">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}
      </SectionCard>

      {/* 2 ── Notes ─────────────────────────────────────────── */}
      <SectionCard title="Syllabus notes">
        {noUnits ? (
          <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50/50 px-4 py-4 text-center">
            <UploadIcon size={22} className="mx-auto text-amber-500" />
            <p className="mt-1.5 text-[13px] font-medium text-gray-800">No notes indexed for this class &amp; subject</p>
            <p className="mt-0.5 text-[12px] text-gray-500">
              Generation draws its content from indexed notes. Upload notes for at least one unit to continue.
            </p>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {units.map((u) => (
              <span
                key={u.id}
                className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[12px] text-emerald-800"
              >
                {u.label}
                <span className="text-emerald-500">·</span>
                <span className="tabular-nums">{u.chunkCount} chunk{u.chunkCount === 1 ? '' : 's'}</span>
                <span className="text-emerald-300">·</span>
                <button
                  type="button"
                  onClick={() => fileInputs.current[u.id]?.click()}
                  disabled={addingId === u.id}
                  className="font-medium hover:underline disabled:opacity-50"
                >
                  {addingId === u.id ? 'uploading…' : 'add'}
                </button>
                <input
                  ref={(el) => (fileInputs.current[u.id] = el)}
                  type="file"
                  accept="application/pdf,.pdf,.txt,.md,.docx"
                  className="hidden"
                  onChange={(e) => {
                    doAdd(u.id, e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
              </span>
            ))}
          </div>
        )}

        {/* add notes for a (new) unit */}
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
          <input
            className={`${fieldClass} w-40`}
            placeholder="Unit (e.g. Unit 3)"
            value={newUnit}
            onChange={(e) => setNewUnit(e.target.value)}
          />
          <button
            type="button"
            disabled={!newUnit.trim() || addingId === '__new__'}
            onClick={() => newFileInput.current?.click()}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-blue-700 px-3 text-[13px] font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50"
          >
            <UploadIcon size={14} />
            {addingId === '__new__' ? 'uploading…' : 'Add notes'}
          </button>
          <input
            ref={newFileInput}
            type="file"
            accept="application/pdf,.pdf,.txt,.md,.docx"
            className="hidden"
            onChange={(e) => {
              setAddingId('__new__');
              doAdd(newUnit, e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>
      </SectionCard>

      {/* 3 ── Question list ─────────────────────────────────── */}
      <SectionCard title="Assign a unit to every question">
        <div className="divide-y divide-gray-100">
          {questions.map((q, i) => {
            const key = slotKey(q, i);
            const a = assign[key] || { unit: null, items: {} };
            const labels = itemLabels(q);
            const expandable = isExpandable(q);
            const open = expanded.has(key);
            const mixed = isMixed(q, a);
            const items = itemMarksOf(q);
            const rowUnassigned = unassignedKeys.includes(key);
            const opt = anyText(q);
            const approx = isApproximate(q);

            return (
              <div key={key} className="py-2">
                <div className="flex items-center gap-2">
                  {expandable ? (
                    <button
                      type="button"
                      onClick={() => toggleExpand(q, key)}
                      className="flex h-6 w-6 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                      title={open ? 'Collapse' : 'Assign units per item'}
                    >
                      {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                    </button>
                  ) : labels.length > 1 ? (
                    <span className="flex h-6 w-6 items-center justify-center text-gray-300" title={lockReason(q)}>
                      <InfoIcon size={14} />
                    </span>
                  ) : (
                    <span className="h-6 w-6" />
                  )}

                  <span className="w-12 shrink-0 text-[13px] font-medium text-gray-800">{key}</span>
                  <span className="w-24 shrink-0 text-[12px] text-gray-500">
                    {opt || ''}
                    {approx && <span className="ml-1 text-amber-500" title="Student answers only some items — per-unit split is approximate">≈</span>}
                  </span>
                  <span className="w-16 shrink-0 text-[12px] text-gray-500">
                    {marksText(q.totalMarks) || 'marks n/a'}
                  </span>

                  <div className="ml-auto flex items-center gap-2">
                    {rowUnassigned && <span className="text-[11px] font-medium text-amber-600">unassigned</span>}
                    <UnitSelect units={units} value={a.unit} mixed={mixed} onChange={(v) => assignWholeQuestion(q, key, v)} />
                  </div>
                </div>

                {open && expandable && (
                  <div className="mt-1.5 space-y-1.5 pl-14">
                    {items.map((it) => (
                      <div key={it.label} className="flex items-center gap-2">
                        <span className="w-8 text-[12px] text-gray-500">{it.label})</span>
                        <span className={`w-16 text-[12px] ${it.marks == null ? 'text-amber-500' : 'text-gray-400'}`}>
                          {it.marks == null ? 'marks n/a' : marksText(it.marks)}
                        </span>
                        <div className="ml-auto">
                          <UnitSelect
                            units={units}
                            value={a.items[it.label] ?? null}
                            onChange={(v) => assignItem(q, key, it.label, v)}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </SectionCard>

      {/* 4 ── Running totals ────────────────────────────────── */}
      <SectionCard title={`Marks per unit (live)${approximate ? ' — approximate' : ''}`}>
        <div className="space-y-1.5">
          {units.map((u) => (
            <div key={u.id} className="flex items-center gap-3">
              <span className="w-24 shrink-0 truncate text-[12px] text-gray-600">{u.label}</span>
              <div className="h-2 flex-1 overflow-hidden rounded bg-gray-100">
                <div className="h-full bg-blue-600" style={{ width: `${(totals[u.id] / maxBar) * 100}%` }} />
              </div>
              <span className="w-16 shrink-0 text-right text-[12px] tabular-nums text-gray-700">
                {approximate ? '≈ ' : ''}
                {totals[u.id]}
              </span>
            </div>
          ))}
          {unassigned > 0 && (
            <div className="flex items-center gap-3 pt-1">
              <span className="w-24 shrink-0 text-[12px] font-medium text-amber-600">unassigned</span>
              <div className="h-2 flex-1 overflow-hidden rounded bg-gray-100">
                <div className="h-full bg-amber-400" style={{ width: `${(unassigned / maxBar) * 100}%` }} />
              </div>
              <span className="w-16 shrink-0 text-right text-[12px] tabular-nums text-amber-700">{unassigned}</span>
            </div>
          )}
        </div>
        {(unknownItems > 0 || approximate) && (
          <p className="mt-2 text-[11.5px] text-gray-500">
            {unknownItems > 0 && `${unknownItems} item(s) have no recorded marks and are not counted. `}
            {approximate && 'Rows marked ≈ are "answer any N" — the student picks which items count, so those unit totals are a range.'}
          </p>
        )}
      </SectionCard>

      {/* footer ─────────────────────────────────────────────── */}
      <div className="flex items-end gap-3 border-t border-gray-200 pt-4">
        <div className="w-40">
          <label className="mb-1 block text-[12px] font-medium text-gray-600">Difficulty</label>
          <div className="relative">
            <select className={selectClass} value={difficulty} onChange={(e) => onDifficultyChange(e.target.value)}>
              {DIFFICULTY_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <ChevronDown size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          </div>
        </div>

        <div className="flex-1">
          <button
            type="button"
            disabled={!canGenerate}
            onClick={() => onGenerate(buildSlotUnitMap(blueprint, assign))}
            className="h-11 w-full rounded-lg bg-blue-700 text-sm font-semibold text-white transition-colors hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? 'Generating…' : 'Generate Question Paper'}
          </button>
          {noUnits ? (
            <p className="mt-1.5 text-[12px] text-amber-600">Upload notes for at least one unit before generating.</p>
          ) : unassignedKeys.length > 0 ? (
            <p className="mt-1.5 text-[12px] text-amber-600">
              Assign a unit to {unassignedKeys.join(', ')} before generating.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
