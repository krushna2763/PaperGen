/**
 * SchoolTemplates — the teacher-facing VISUAL School Template screen.
 *
 *   list mode  : per-school list of saved templates (name · page size ·
 *                orientation · updated) with Create / Preview / Edit /
 *                Duplicate / Delete.
 *   edit mode  : a three-area editor — LEFT section nav, CENTRE live paper
 *                preview (the REAL production renderer via buildPaperHtml in an
 *                iframe), RIGHT the selected section's controls.
 *
 * This screen edits ONLY the visual SchoolTemplate persisted by
 * /api/school-templates. It never touches question structure: no counts,
 * types, marks, sections, difficulty, units or RAG content are editable here
 * or produced by anything it saves. The centre preview uses fixed SAMPLE
 * content that is never saved as a real paper.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { schoolTemplateService } from '../services/api.js';
import { buildPaperHtml } from '../services/paperHtml.js';
import ConfirmDialog from './ConfirmDialog.jsx';
import {
  editorDefault,
  visualFromStored,
  editorStateToVisual,
  templateListRow,
  previewArgs,
  readLogoFile,
  PAGE_SIZES,
  ORIENTATIONS,
  NUMBERING_OPTIONS,
  MARKS_OPTIONS,
  OPTION_LABEL_OPTIONS,
  BORDER_OPTIONS,
  HEADER_TOGGLES,
  STUDENT_FIELDS,
  FONT_FAMILIES,
  LOGO_ACCEPT,
} from '../services/schoolTemplateEditor.js';
import {
  TemplatesIcon,
  PlusIcon,
  PencilIcon,
  CopyIcon,
  TrashIcon,
  EyeIcon,
  SaveIcon,
  UploadCloudIcon,
  XIcon,
  ArrowRightIcon,
  CheckCircleIcon,
} from './ui/icons.jsx';

const FORMAT_STORAGE_KEY = 'papergen:paperFormat';

function storedSchoolName() {
  try {
    const raw = localStorage.getItem(FORMAT_STORAGE_KEY);
    if (raw) return String(JSON.parse(raw)?.schoolName || '').trim();
  } catch { /* ignore */ }
  return '';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};

const inputCls =
  'h-9 w-full rounded-lg border border-gray-300 bg-white px-3 text-[12.5px] text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500/40';
const selectCls =
  'h-9 w-full appearance-none rounded-lg border border-gray-300 bg-white pl-3 pr-8 text-[12.5px] text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500/40';

/* ─────────────────────────────── list ─────────────────────────────────── */

function TemplateList({ schoolName, setSchoolName, rows, loading, err, onCreate, onEdit, onDuplicate, onDelete }) {
  return (
    <div className="flex min-h-[calc(100vh-8rem)] flex-col">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-bold text-gray-900">School Templates</h1>
          <p className="mt-1 text-[14px] text-gray-500">
            Reusable <span className="font-medium text-gray-700">visual</span> layouts — header, logo, margins, numbering,
            footer, border. They never change a paper's questions, marks or structure.
          </p>
        </div>
        <button
          type="button"
          onClick={onCreate}
          disabled={!schoolName.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2.5 text-[13px] font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
        >
          <PlusIcon size={15} /> Create Template
        </button>
      </div>

      <div className="mt-5 max-w-md">
        <label className="mb-1 block text-[11px] font-medium text-gray-500">School</label>
        <input
          value={schoolName}
          onChange={(e) => setSchoolName(e.target.value)}
          placeholder="Enter your school name to see and create its templates"
          className={inputCls}
        />
        <p className="mt-1 text-[11px] text-gray-400">Templates are saved per school.</p>
      </div>

      {err && <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-[12.5px] text-red-700">{err}</p>}

      <div className="mt-4 flex-1">
        {!schoolName.trim() ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 bg-white px-6 py-20 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gray-100 text-gray-400">
              <TemplatesIcon size={26} />
            </span>
            <p className="mt-4 text-[14px] font-semibold text-gray-800">Name your school first</p>
            <p className="mt-1 max-w-sm text-[12.5px] text-gray-500">Templates are scoped per school, so enter a school name above.</p>
          </div>
        ) : rows.length === 0 && !loading ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 bg-white px-6 py-20 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gray-100 text-gray-400">
              <TemplatesIcon size={26} />
            </span>
            <p className="mt-4 text-[14px] font-semibold text-gray-800">No templates for “{schoolName}” yet</p>
            <p className="mt-1 max-w-sm text-[12.5px] text-gray-500">
              Create one to control how this school's papers look — it is applied at generation time and never changes the questions.
            </p>
            <button type="button" onClick={onCreate} className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-[12.5px] font-semibold text-white hover:bg-blue-700">
              Create your first template <ArrowRightIcon size={14} />
            </button>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            <table className="w-full min-w-[720px] text-left">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50/50 text-[12px] font-semibold text-gray-500">
                  <th className="px-5 py-3">Template</th>
                  <th className="px-3 py-3">Page size</th>
                  <th className="px-3 py-3">Orientation</th>
                  <th className="px-3 py-3">Last updated</th>
                  <th className="px-3 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 text-[12.5px]">
                {rows.length === 0 ? (
                  <tr><td colSpan={5} className="px-5 py-12 text-center text-gray-400">Loading…</td></tr>
                ) : (
                  rows.map((r) => (
                    <tr key={r.id} className="hover:bg-gray-50/60">
                      <td className="px-5 py-3">
                        <button type="button" onClick={() => onEdit(r.id)} className="block text-left font-medium text-blue-600 hover:underline">
                          {r.name}
                        </button>
                        {r.hasLogo && <p className="text-[11px] text-gray-400">with logo</p>}
                      </td>
                      <td className="px-3 py-3 text-gray-700">{r.pageSize}</td>
                      <td className="px-3 py-3 capitalize text-gray-700">{r.orientation}</td>
                      <td className="px-3 py-3 text-gray-500">{fmtDate(r.updatedAt)}</td>
                      <td className="px-3 py-3">
                        <div className="flex items-center justify-end gap-1.5">
                          <IconBtn title="Preview / edit" onClick={() => onEdit(r.id)}><EyeIcon size={14} /></IconBtn>
                          <IconBtn title="Edit" onClick={() => onEdit(r.id)}><PencilIcon size={14} /></IconBtn>
                          <IconBtn title="Duplicate" onClick={() => onDuplicate(r.id)}><CopyIcon size={14} /></IconBtn>
                          <IconBtn title="Delete" danger onClick={() => onDelete(r)}><TrashIcon size={14} /></IconBtn>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function IconBtn({ title, onClick, danger, children }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={
        'rounded-md p-1.5 ' +
        (danger ? 'text-red-500 hover:bg-red-50' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-800')
      }
    >
      {children}
    </button>
  );
}

/* ────────────────────────────── editor ───────────────────────────────── */

const SECTIONS = [
  { key: 'page', label: 'Page' },
  { key: 'header', label: 'Header' },
  { key: 'logo', label: 'Logo' },
  { key: 'student', label: 'Student info' },
  { key: 'numbering', label: 'Numbering & marks' },
  { key: 'footer', label: 'Footer' },
  { key: 'border', label: 'Border' },
  { key: 'instructions', label: 'Instructions' },
];

function Toggle({ label, checked, onChange }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 py-1.5">
      <span className="text-[12.5px] text-gray-700">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={
          'relative h-5 w-9 rounded-full transition-colors ' + (checked ? 'bg-blue-600' : 'bg-gray-300')
        }
      >
        <span className={'absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ' + (checked ? 'translate-x-4' : 'translate-x-0.5')} />
      </button>
    </label>
  );
}

function Field({ label, children, hint }) {
  return (
    <div className="mb-3">
      <label className="mb-1 block text-[11px] font-medium text-gray-500">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-gray-400">{hint}</p>}
    </div>
  );
}

function SelectField({ label, value, onChange, options, hint }) {
  return (
    <Field label={label} hint={hint}>
      <div className="relative">
        <select value={value} onChange={(e) => onChange(e.target.value)} className={selectCls}>
          {options.map((o) => {
            const [v, l] = Array.isArray(o) ? o : [o.value, o.label];
            return <option key={String(v)} value={v}>{l}</option>;
          })}
        </select>
        <svg className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m6 9 6 6 6-6" /></svg>
      </div>
    </Field>
  );
}

function SectionControls({ section, visual, patch }) {
  const v = visual;
  if (section === 'page') {
    return (
      <>
        <SelectField label="Page size" value={v.page.size} onChange={(x) => patch({ page: { ...v.page, size: x } })} options={PAGE_SIZES} />
        <SelectField label="Orientation" value={v.page.orientation} onChange={(x) => patch({ page: { ...v.page, orientation: x } })} options={ORIENTATIONS.map((o) => [o, o[0].toUpperCase() + o.slice(1)])} />
        <SelectField
          label="Body font"
          value={v.font.family}
          onChange={(x) => patch({ font: { ...v.font, family: x } })}
          options={FONT_FAMILIES}
          hint="Applies to the on-screen / HTML preview. The downloadable PDF always uses its embedded serif font."
        />
        <Field label={`Font size — ${v.font.bodySizePt} pt`}>
          <input type="range" min="8" max="16" step="1" value={v.font.bodySizePt} onChange={(e) => patch({ font: { ...v.font, bodySizePt: Number(e.target.value) } })} className="w-full" />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          {['left', 'top', 'right', 'bottom'].map((side) => (
            <Field key={side} label={`Margin ${side} (pt)`}>
              <input
                type="number" min="18" max="160"
                value={v.page.margins[side]}
                onChange={(e) => patch({ page: { ...v.page, margins: { ...v.page.margins, [side]: Number(e.target.value) } } })}
                className={inputCls}
              />
            </Field>
          ))}
        </div>
      </>
    );
  }
  if (section === 'header') {
    return (
      <>
        <p className="mb-2 text-[11px] text-gray-400">Hide any identity row you don't want printed. The values themselves come from the paper, never from this template.</p>
        {HEADER_TOGGLES.map(({ key, label }) => (
          <Toggle key={key} label={label} checked={v.header[key] !== false} onChange={(c) => patch({ header: { ...v.header, [key]: c } })} />
        ))}
        <div className="mt-3 border-t border-gray-100 pt-3">
          <Toggle label="Repeat school name on pages 2+" checked={!!v.header.repeatOnLaterPages} onChange={(c) => patch({ header: { ...v.header, repeatOnLaterPages: c } })} />
          <p className="mt-1 text-[11px] text-gray-400">Running header shows in the PDF only.</p>
        </div>
      </>
    );
  }
  if (section === 'logo') {
    return (
      <>
        <Field label="School logo" hint="PNG / JPEG / WebP / GIF, up to ~1 MB. Stored with the template.">
          {v.header.logo?.dataUri ? (
            <div className="flex items-center gap-3">
              <img src={v.header.logo.dataUri} alt="logo preview" className="h-16 w-auto rounded border border-gray-200 bg-white p-1" />
              <button
                type="button"
                onClick={() => patch({ header: { ...v.header, logo: { ...v.header.logo, dataUri: null } } })}
                className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2.5 py-1.5 text-[12px] font-medium text-gray-700 hover:bg-gray-50"
              >
                <XIcon size={13} /> Remove
              </button>
            </div>
          ) : (
            <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-gray-300 px-3 py-6 text-[12.5px] text-gray-500 hover:border-blue-400 hover:text-blue-600">
              <UploadCloudIcon size={16} /> Upload logo
              <input
                type="file"
                accept={LOGO_ACCEPT}
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  try {
                    const dataUri = await readLogoFile(file);
                    patch({ header: { ...v.header, logo: { ...v.header.logo, dataUri } } });
                  } catch (err) {
                    // surface via the editor's error slot
                    patch({ __logoError: err.message });
                  }
                }}
              />
            </label>
          )}
        </Field>
        {v.header.logo?.dataUri && (
          <Field label={`Logo height — ${v.header.logo.heightPt} pt`}>
            <input type="range" min="12" max="120" step="2" value={v.header.logo.heightPt} onChange={(e) => patch({ header: { ...v.header, logo: { ...v.header.logo, heightPt: Number(e.target.value) } } })} className="w-full" />
          </Field>
        )}
      </>
    );
  }
  if (section === 'student') {
    return (
      <>
        <p className="mb-2 text-[11px] text-gray-400">Blank lines the student fills in, printed under the header.</p>
        {STUDENT_FIELDS.map(({ key, label }) => (
          <Toggle key={key} label={label} checked={!!v.studentInfo[key]} onChange={(c) => patch({ studentInfo: { ...v.studentInfo, [key]: c } })} />
        ))}
      </>
    );
  }
  if (section === 'numbering') {
    return (
      <>
        <SelectField label="Question numbering" value={v.numbering.style} onChange={(x) => patch({ numbering: { style: x } })} options={NUMBERING_OPTIONS} />
        <SelectField label="Marks style" value={v.marks.case || ''} onChange={(x) => patch({ marks: { case: x || null } })} options={MARKS_OPTIONS} hint="Display only — the numeric marks never change." />
        <SelectField label="MCQ option labels" value={v.options.labelStyle} onChange={(x) => patch({ options: { labelStyle: x } })} options={OPTION_LABEL_OPTIONS} />
      </>
    );
  }
  if (section === 'footer') {
    return (
      <>
        <Field label="Footer text" hint="Left/centre of every page's footer.">
          <input value={v.footer.text} onChange={(e) => patch({ footer: { ...v.footer, text: e.target.value } })} maxLength={200} placeholder="e.g. Green Valley School — Confidential" className={inputCls} />
        </Field>
        <Toggle label="Show page numbers" checked={v.footer.showPageNumbers !== false} onChange={(c) => patch({ footer: { ...v.footer, showPageNumbers: c } })} />
      </>
    );
  }
  if (section === 'border') {
    return (
      <>
        <SelectField label="Page border" value={v.border.style} onChange={(x) => patch({ border: { ...v.border, style: x } })} options={BORDER_OPTIONS} />
        {v.border.style !== 'none' && (
          <Field label={`Border inset — ${v.border.marginPt} pt`}>
            <input type="range" min="4" max="48" step="2" value={v.border.marginPt} onChange={(e) => patch({ border: { ...v.border, marginPt: Number(e.target.value) } })} className="w-full" />
          </Field>
        )}
        <p className="text-[11px] text-gray-400">A vector page frame drawn by the renderer — not a background image.</p>
      </>
    );
  }
  if (section === 'instructions') {
    return (
      <>
        <Field label="Instructions heading">
          <input value={v.instructions.heading} onChange={(e) => patch({ instructions: { ...v.instructions, heading: e.target.value } })} maxLength={80} className={inputCls} />
        </Field>
        <Field label="Instruction lines (one per line, max 10)">
          <textarea
            rows={5}
            value={(v.instructions.items || []).join('\n')}
            onChange={(e) => patch({ instructions: { ...v.instructions, items: e.target.value.split(/\n+/).map((s) => s.trim()).filter(Boolean).slice(0, 10) } })}
            className="w-full resize-y rounded-lg border border-gray-300 bg-white px-3 py-2 text-[12.5px] text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
          />
        </Field>
      </>
    );
  }
  return null;
}

function TemplateEditor({ initial, schoolName, onBack, onSaved }) {
  const [name, setName] = useState(initial.name || '');
  const [visual, setVisual] = useState(() => visualFromStored(initial.visual));
  const [section, setSection] = useState('page');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [savedAt, setSavedAt] = useState(null);
  const idRef = useRef(initial.id || null);

  // `patch` merges a partial visual; `__logoError` is a side channel from the
  // logo control so a bad file surfaces without its own state plumbing.
  const patch = useCallback((partial) => {
    if (partial.__logoError !== undefined) { setErr(partial.__logoError); return; }
    setErr('');
    setSavedAt(null);
    setVisual((cur) => ({ ...cur, ...partial }));
  }, []);

  const previewHtml = useMemo(() => {
    try {
      return buildPaperHtml(previewArgs(visual, { schoolName }));
    } catch (e) {
      return `<pre style="color:#b91c1c;padding:16px;font:12px system-ui">Preview error: ${String(e.message || e)}</pre>`;
    }
  }, [visual, schoolName]);

  const save = async () => {
    const clean = name.trim();
    if (!clean) { setErr('Give the template a name.'); return; }
    setSaving(true);
    setErr('');
    try {
      const body = { name: clean, schoolName, visual: editorStateToVisual(visual) };
      const res = idRef.current
        ? await schoolTemplateService.update(idRef.current, body)
        : await schoolTemplateService.save(body);
      const saved = res?.data;
      if (saved?.id) idRef.current = saved.id;
      // Reflect the server's sanitized copy back into the editor so what the
      // teacher sees is exactly what was stored.
      if (saved?.visual) setVisual(visualFromStored(saved.visual));
      setSavedAt(saved?.updatedAt || new Date().toISOString());
      onSaved?.(saved);
    } catch (e) {
      setErr(e?.response?.data?.message || e?.response?.data?.errors?.[0]?.message || e?.message || 'Could not save the template.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-[calc(100vh-8rem)] flex-col">
      {/* top bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 pb-3">
        <div className="flex items-center gap-3">
          <button type="button" onClick={onBack} className="rounded-lg border border-gray-300 px-3 py-1.5 text-[12.5px] font-medium text-gray-700 hover:bg-gray-50">
            ← Templates
          </button>
          <input
            value={name}
            onChange={(e) => { setName(e.target.value); setSavedAt(null); }}
            placeholder="Template name"
            className="h-9 w-64 rounded-lg border border-gray-300 px-3 text-[13px] font-medium text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
          />
          <span className="text-[12px] text-gray-400">{schoolName}</span>
        </div>
        <div className="flex items-center gap-2">
          {savedAt && (
            <span className="inline-flex items-center gap-1 text-[12px] font-medium text-emerald-600">
              <CheckCircleIcon size={14} /> Saved · {fmtDate(savedAt)}
            </span>
          )}
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-blue-700 disabled:bg-gray-300"
          >
            <SaveIcon size={14} /> {saving ? 'Saving…' : 'Save template'}
          </button>
        </div>
      </div>

      {err && <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-[12.5px] text-red-700">{err}</p>}

      {/* three areas */}
      <div className="mt-4 grid flex-1 gap-4 lg:grid-cols-[180px_minmax(0,1fr)_300px]">
        {/* LEFT — section nav */}
        <nav className="space-y-1">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setSection(s.key)}
              aria-current={section === s.key ? 'true' : undefined}
              className={
                'flex w-full items-center rounded-lg px-3 py-2 text-[12.5px] font-medium ' +
                (section === s.key ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-100')
              }
            >
              {s.label}
            </button>
          ))}
        </nav>

        {/* CENTRE — live preview via the real renderer */}
        <div className="flex flex-col overflow-hidden rounded-xl border border-gray-200 bg-gray-100">
          <div className="flex items-center justify-between border-b border-gray-200 bg-white px-3 py-1.5">
            <span className="text-[11.5px] font-medium text-gray-500">Live preview</span>
            <span className="text-[11px] text-gray-400">Sample content — never saved as a paper</span>
          </div>
          <iframe
            title="School template preview"
            srcDoc={previewHtml}
            className="h-[70vh] w-full flex-1 bg-white"
          />
        </div>

        {/* RIGHT — selected section controls */}
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="mb-3 text-[13px] font-semibold text-gray-800">{SECTIONS.find((s) => s.key === section)?.label}</p>
          <SectionControls section={section} visual={visual} patch={patch} />
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────── shell ───────────────────────────────── */

export default function SchoolTemplates() {
  const [schoolName, setSchoolName] = useState(storedSchoolName);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [mode, setMode] = useState('list'); // 'list' | 'edit'
  const [editing, setEditing] = useState(null); // { id?, name, visual }
  const [confirmDel, setConfirmDel] = useState(null); // row

  const load = useCallback(async () => {
    if (!schoolName.trim()) { setRows([]); return; }
    setLoading(true);
    setErr('');
    try {
      const r = await schoolTemplateService.list({ schoolName: schoolName.trim() });
      setRows((Array.isArray(r.data) ? r.data : []).map(templateListRow));
    } catch (e) {
      setErr(e?.response?.data?.message || e?.message || 'Could not load templates.');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [schoolName]);

  useEffect(() => {
    if (mode !== 'list') return undefined;
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load, mode]);

  const openCreate = () => { setEditing({ name: '', visual: editorDefault() }); setMode('edit'); };

  const openEdit = async (id) => {
    setErr('');
    try {
      const r = await schoolTemplateService.get(id);
      const rec = r?.data;
      if (!rec) throw new Error('Template not found.');
      setEditing({ id: rec.id, name: rec.name, visual: rec.visual });
      setMode('edit');
    } catch (e) {
      setErr(e?.response?.data?.message || e?.message || 'Could not open that template.');
    }
  };

  const duplicate = async (id) => {
    setErr('');
    try {
      const r = await schoolTemplateService.get(id);
      const rec = r?.data;
      if (!rec) return;
      await schoolTemplateService.save({ name: `${rec.name} (copy)`, schoolName: schoolName.trim(), visual: rec.visual });
      load();
    } catch (e) {
      setErr(e?.response?.data?.message || e?.message || 'Could not duplicate that template.');
    }
  };

  const doDelete = async () => {
    const row = confirmDel;
    setConfirmDel(null);
    if (!row) return;
    try {
      await schoolTemplateService.delete(row.id);
      load();
    } catch (e) {
      setErr(e?.response?.data?.message || e?.message || 'Could not delete that template.');
    }
  };

  if (mode === 'edit' && editing) {
    return (
      <TemplateEditor
        initial={editing}
        schoolName={schoolName.trim()}
        onBack={() => { setMode('list'); setEditing(null); load(); }}
        onSaved={() => load()}
      />
    );
  }

  return (
    <>
      <TemplateList
        schoolName={schoolName}
        setSchoolName={setSchoolName}
        rows={rows}
        loading={loading}
        err={err}
        onCreate={openCreate}
        onEdit={openEdit}
        onDuplicate={duplicate}
        onDelete={(row) => setConfirmDel(row)}
      />
      {confirmDel && (
        <ConfirmDialog
          title={`Delete “${confirmDel.name}”?`}
          body="This removes the visual template for this school. Papers already generated keep their look; this cannot be undone."
          onConfirm={doDelete}
          onCancel={() => setConfirmDel(null)}
        />
      )}
    </>
  );
}
