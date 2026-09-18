/**
 * MyPapers — the stored-papers screen.
 *
 * Backed by GET /api/library (a file-backed store — see
 * server/src/services/paper-archive-store.js; there is no MongoDB in this
 * repo). Search, the four filters and the sort all run server-side against the
 * whole collection. The stat cards read GET /api/library/stats.
 *
 * With nothing stored, the table is replaced by an invitation and the stat
 * cards read zero — never invented rows or counts.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { libraryService } from '../services/api.js';
import {
  MyPapersIcon,
  CircleCheckSolid,
  ClockIcon,
  FileLinesIcon,
  EyeIcon,
  DownloadIcon,
  RefreshIcon,
  PencilIcon,
  MoreVerticalIcon,
  ArrowRightIcon,
  CopyIcon,
  TrashIcon,
  CheckCircleIcon,
} from './ui/icons.jsx';

const STATUS_META = {
  generated: { label: 'Generated', cls: 'border-emerald-200 bg-emerald-50 text-emerald-700', Icon: CircleCheckSolid },
  in_progress: { label: 'In Progress', cls: 'border-blue-200 bg-blue-50 text-blue-700', Icon: ClockIcon },
  draft: { label: 'Draft', cls: 'border-gray-200 bg-gray-100 text-gray-500', Icon: ClockIcon },
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};

const selectCls =
  'h-9 w-full appearance-none rounded-lg border border-gray-300 bg-white pl-3 pr-8 text-[12.5px] text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500/40';

function Stat({ tone, Icon, value, label, caption }) {
  const tile = {
    blue: 'bg-blue-50 text-blue-600',
    green: 'bg-emerald-50 text-emerald-600',
    purple: 'bg-purple-50 text-purple-600',
    gray: 'bg-gray-100 text-gray-500',
  }[tone];
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-center gap-3">
        <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${tile}`}>
          <Icon size={20} />
        </span>
        <div>
          <p className="text-[22px] font-bold leading-none text-gray-900">{value}</p>
          <p className="mt-1 text-[12.5px] font-medium text-gray-600">{label}</p>
        </div>
      </div>
      <p className="mt-2 text-[11.5px] text-gray-400">{caption}</p>
    </div>
  );
}

function StatusPill({ status }) {
  const m = STATUS_META[status] || STATUS_META.draft;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${m.cls}`}>
      <m.Icon size={12} />
      {m.label}
    </span>
  );
}

function RowActions({ paper, onOpen, onDownload, onViewAnswerKey }) {
  const { status } = paper;
  const primary =
    status === 'generated'
      ? { label: 'View', Icon: EyeIcon }
      : status === 'in_progress'
      ? { label: 'Continue', Icon: RefreshIcon }
      : { label: 'Edit', Icon: PencilIcon };
  const ready = status !== 'in_progress'; // a draft still has its saved answers
  const chip =
    'inline-flex items-center gap-1.5 rounded-md bg-blue-50 px-2.5 py-1 text-[11.5px] font-medium text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-300';
  return (
    <div className="flex items-center gap-2">
      <button type="button" onClick={() => onOpen(paper)} className={chip}>
        <primary.Icon size={13} />
        {primary.label}
      </button>
      <button
        type="button"
        onClick={() => ready && onDownload(paper)}
        disabled={!ready}
        title={ready ? 'Download PDF' : 'Nothing to download until generation finishes'}
        className={chip}
      >
        <DownloadIcon size={13} />
        Download
      </button>
      <button
        type="button"
        onClick={() => ready && onViewAnswerKey(paper)}
        disabled={!ready}
        title={ready ? 'Review and correct the answer key' : 'Available once generation finishes'}
        className={chip}
      >
        <FileLinesIcon size={13} />
        View Answer Key
      </button>
    </div>
  );
}

/**
 * Row ⋮ menu. The table card (`overflow-hidden`) and its horizontal-scroll
 * wrapper would clip an absolutely-positioned dropdown, so the menu renders in
 * a body portal with fixed coordinates computed from the trigger's live rect:
 * right-aligned under the ⋮, flipped above it near the viewport bottom, and
 * clamped so it never leaves the viewport. Recomputed on every scroll (capture
 * phase catches the table's own scroll container) and window resize.
 */
const MENU_EDGE = 8; // min gap kept between menu and viewport edges

function OverflowMenu({ paper, open, onToggle, onRename, onDuplicate, onDelete, onDownloadAnswerKey }) {
  const ready = paper.status !== 'in_progress';
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return undefined;
    }
    const update = () => {
      const t = btnRef.current;
      if (!t) return;
      const r = t.getBoundingClientRect();
      const mw = menuRef.current ? menuRef.current.offsetWidth : 176; // w-44
      const mh = menuRef.current ? menuRef.current.offsetHeight : 132;
      let top = r.bottom + 4;
      if (top + mh > window.innerHeight - MENU_EDGE) {
        top = Math.max(MENU_EDGE, r.top - mh - 4); // near the bottom → flip up
      }
      // Final clamp: keep the menu on screen even if the trigger itself was
      // scrolled out of view between open and measure.
      top = Math.min(Math.max(MENU_EDGE, top), Math.max(MENU_EDGE, window.innerHeight - MENU_EDGE - mh));
      let left = r.right - mw; // right-align with the trigger
      left = Math.min(Math.max(MENU_EDGE, left), window.innerWidth - MENU_EDGE - mw);
      setPos({ top: Math.round(top), left: Math.round(left) });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    const onKey = (e) => { if (e.key === 'Escape') onToggle(null); };
    const onDown = (e) => {
      if (btnRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
      onToggle(null); // click outside closes
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onToggle]);

  const itemCls =
    'flex w-full items-center gap-2 px-3 py-1.5 text-[12px] text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-300';
  const run = (fn) => () => { onToggle(null); fn(paper); };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => onToggle(open ? null : paper.id)}
        className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreVerticalIcon size={16} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            className="fixed z-50 w-44 overflow-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
            style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}
          >
          <button type="button" disabled={!ready} onClick={run(onDownloadAnswerKey)} className={itemCls}>
            <DownloadIcon size={13} /> Download answer key
          </button>
          <button type="button" onClick={run(onDuplicate)} className={itemCls}>
            <CopyIcon size={13} /> Duplicate
          </button>
          <button type="button" onClick={run(onRename)} className={itemCls}>
            <PencilIcon size={13} /> Rename
          </button>
          <button type="button" onClick={run(onDelete)} className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] text-red-600 hover:bg-red-50">
            <TrashIcon size={13} /> Delete
          </button>
          </div>,
          document.body
        )}
    </>
  );
}

export default function MyPapers({ onCreateNew, onOpen, onDownload, onDownloadAnswerKey, onViewAnswerKey }) {
  const [stats, setStats] = useState({ total: 0, generated: 0, inProgress: 0, draft: 0 });
  const [rows, setRows] = useState([]);
  const [facets, setFacets] = useState({ classes: [], subjects: [] });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const [q, setQ] = useState('');
  const [fClass, setFClass] = useState('');
  const [fSubject, setFSubject] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [sort, setSort] = useState('recent');
  // One open menu at a time, page-wide (id of the paper whose ⋮ is open).
  const [openMenuId, setOpenMenuId] = useState(null);

  // Changing search/filter/sort reloads the rows → close any open menu.
  useEffect(() => { setOpenMenuId(null); }, [q, fClass, fSubject, fStatus, sort]);

  const refreshStats = useCallback(() => {
    libraryService.stats().then((r) => setStats(r.data || {})).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const r = await libraryService.list({ q, class: fClass, subject: fSubject, status: fStatus, sort });
      setRows(Array.isArray(r.data) ? r.data : []);
      if (r.facets) setFacets(r.facets);
    } catch (e) {
      setErr(e?.response?.data?.message || e?.message || 'Could not load your papers.');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [q, fClass, fSubject, fStatus, sort]);

  useEffect(() => { refreshStats(); }, [refreshStats]);
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const filtering = Boolean(q || fClass || fSubject || fStatus);
  // Show the "create your first paper" invitation only when the store is
  // genuinely empty — never merely because a filter matched nothing, and never
  // because the (separate, advisory) stats call failed.
  const showEmptyInvite = !filtering && rows.length === 0 && stats.total === 0 && !loading;

  const recentCount = useMemo(() => {
    const cut = Date.now() - 30 * 24 * 60 * 60 * 1000;
    return rows.filter((r) => new Date(r.createdAt).getTime() >= cut).length;
  }, [rows]);

  const act = {
    rename: async (p) => {
      const name = window.prompt('Rename paper:', p.title);
      if (!name || !name.trim()) return;
      await libraryService.patch(p.id, { title: name.trim() }).catch(() => {});
      load();
    },
    duplicate: async (p) => {
      await libraryService.duplicate(p.id).catch(() => {});
      refreshStats();
      load();
    },
    delete: async (p) => {
      if (!window.confirm(`Delete "${p.title}"? This cannot be undone.`)) return;
      await libraryService.remove(p.id).catch(() => {});
      refreshStats();
      load();
    },
  };

  return (
    <div className="flex min-h-[calc(100vh-8rem)] flex-col">
      {/* header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-bold text-gray-900">My Papers</h1>
          <p className="mt-1 text-[14px] text-gray-500">View, manage and download your generated question papers.</p>
        </div>
        <button
          type="button"
          onClick={onCreateNew}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2.5 text-[13px] font-semibold text-white hover:bg-blue-700"
        >
          <span className="text-[15px] leading-none">+</span> Create New Paper
        </button>
      </div>

      {/* stat cards */}
      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat tone="blue" Icon={MyPapersIcon} value={stats.total} label="Total Papers" caption={recentCount > 0 ? `+${recentCount} in the last 30 days` : 'All stored papers'} />
        <Stat tone="green" Icon={CheckCircleIcon} value={stats.generated} label="Generated" caption="Ready to use" />
        <Stat tone="purple" Icon={ClockIcon} value={stats.inProgress} label="In Progress" caption="Being generated" />
        <Stat tone="gray" Icon={FileLinesIcon} value={stats.draft} label="Draft" caption="Not completed" />
      </div>

      {/* filter bar */}
      <div className="mt-5 grid gap-3 lg:grid-cols-[1fr_repeat(4,minmax(0,180px))]">
        <div>
          <label className="mb-1 block text-[11px] font-medium text-transparent">Search</label>
          <div className="relative">
            <svg className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
            </svg>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search papers by title, subject, or class…"
              className="h-9 w-full rounded-lg border border-gray-300 bg-white pl-9 pr-3 text-[12.5px] text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            />
          </div>
        </div>
        <FilterSelect label="Class" value={fClass} onChange={setFClass} options={[['', 'All Classes'], ...facets.classes.map((c) => [c, `Class ${c}`])]} />
        <FilterSelect label="Subject" value={fSubject} onChange={setFSubject} options={[['', 'All Subjects'], ...facets.subjects.map((s) => [s, s])]} />
        <FilterSelect label="Status" value={fStatus} onChange={setFStatus} options={[['', 'All Status'], ['generated', 'Generated'], ['in_progress', 'In Progress'], ['draft', 'Draft']]} />
        <FilterSelect label="Sort by" value={sort} onChange={setSort} options={[['recent', 'Recently Created'], ['oldest', 'Oldest First'], ['updated', 'Recently Updated'], ['title', 'Title (A–Z)'], ['marks', 'Total Marks']]} />
      </div>

      {err && <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-[12.5px] text-red-700">{err}</p>}

      {/* table / empty state */}
      <div className="mt-4 flex-1">
        {showEmptyInvite ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 bg-white px-6 py-20 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gray-100 text-gray-400">
              <MyPapersIcon size={26} />
            </span>
            <p className="mt-4 text-[14px] font-semibold text-gray-800">No papers yet</p>
            <p className="mt-1 max-w-sm text-[12.5px] text-gray-500">
              Papers you generate are saved here so you can review, download or duplicate them later.
            </p>
            <button type="button" onClick={onCreateNew} className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-[12.5px] font-semibold text-white hover:bg-blue-700">
              Create your first paper <ArrowRightIcon size={14} />
            </button>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-left">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50/50 text-[12px] font-semibold text-gray-500">
                    <th className="px-5 py-3">Title</th>
                    <th className="px-3 py-3">Class</th>
                    <th className="px-3 py-3">Subject</th>
                    <th className="px-3 py-3">Total Marks</th>
                    <th className="px-3 py-3">Created On</th>
                    <th className="px-3 py-3">Status</th>
                    <th className="px-3 py-3">Actions</th>
                    <th className="w-8 px-2 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 text-[12.5px]">
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-5 py-12 text-center text-[12.5px] text-gray-400">
                        {loading ? 'Loading…' : 'No papers match these filters.'}
                      </td>
                    </tr>
                  ) : (
                    rows.map((p) => (
                      <tr key={p.id} className="hover:bg-gray-50/60">
                        <td className="px-5 py-3">
                          <button type="button" onClick={() => onOpen(p)} className="block text-left font-medium text-blue-600 hover:underline">
                            {p.title}
                          </button>
                          <p className="text-[11px] text-gray-400">
                            {p.source === 'B' ? 'Built from custom structure' : 'Generated from previous year paper'}
                          </p>
                        </td>
                        <td className="px-3 py-3 text-gray-700">{p.class ?? '—'}</td>
                        <td className="px-3 py-3 text-gray-700">{p.subject ?? '—'}</td>
                        <td className="px-3 py-3 tabular-nums text-gray-700">{p.totalMarks ?? '—'}</td>
                        <td className="px-3 py-3 text-gray-500">{fmtDate(p.createdAt)}</td>
                        <td className="px-3 py-3"><StatusPill status={p.status} /></td>
                        <td className="px-3 py-3"><RowActions paper={p} onOpen={onOpen} onDownload={onDownload} onViewAnswerKey={onViewAnswerKey} /></td>
                        <td className="px-2 py-3">
                          <OverflowMenu paper={p} open={openMenuId === p.id} onToggle={setOpenMenuId} onRename={act.rename} onDuplicate={act.duplicate} onDelete={act.delete} onDownloadAnswerKey={onDownloadAnswerKey} />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* footer */}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-gray-200 pt-4 text-[11.5px] text-gray-400">
        <span>
          PaperGen AI <span className="text-gray-300">v1.0.0</span> <span className="text-gray-300">|</span> Smarter Question Papers for a Better Tomorrow
        </span>
        <span>Learn • Teach • Empower</span>
      </div>
    </div>
  );
}

function FilterSelect({ label, value, onChange, options }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium text-gray-500">{label}</label>
      <div className="relative">
        <select value={value} onChange={(e) => onChange(e.target.value)} className={selectCls}>
          {options.map(([v, l]) => (
            <option key={v || '_'} value={v}>{l}</option>
          ))}
        </select>
        <svg className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </div>
    </div>
  );
}
