/**
 * KnowledgeBase — manage the syllabus-notes corpus (the ONLY grounding source
 * the generator has). Until now these were reachable only from inside the
 * confirm screen; this view gives them a home.
 *
 * Real endpoints: GET /api/kb/units?class=&subject= and POST /api/kb/notes.
 * Both are scoped to a (class, subject) pair — there is no "list everything"
 * endpoint — so this view asks for class + subject first, then shows the units
 * indexed for that pair.
 *
 * Removing indexed notes needs a DELETE /api/kb/notes endpoint that does not
 * exist yet; the remove control is shown disabled rather than faked.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { kbService } from '../services/api.js';
import { KnowledgeBaseIcon, UploadCloudIcon, TrashIcon } from './ui/icons.jsx';

const CLASS_OPTIONS = Array.from({ length: 12 }, (_, i) => String(i + 1));

const fieldClass =
  'h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors';

export default function KnowledgeBase() {
  const [cls, setCls] = useState('');
  const [subject, setSubject] = useState('');
  const [units, setUnits] = useState(null); // null = not loaded, [] = loaded empty
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const [newUnit, setNewUnit] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);

  const ready = cls.trim() !== '' && subject.trim() !== '';

  const load = useCallback(async () => {
    if (!ready) {
      setUnits(null);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await kbService.listUnits({ class: cls.trim(), subject: subject.trim() });
      setUnits(Array.isArray(res?.data) ? res.data : []);
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Could not load units.');
      setUnits(null);
    } finally {
      setLoading(false);
    }
  }, [cls, subject, ready]);

  // Reload whenever the (class, subject) pair changes and both are set.
  useEffect(() => {
    const id = setTimeout(load, 300);
    return () => clearTimeout(id);
  }, [load]);

  const pickFile = () => {
    setMsg('');
    setError('');
    if (!newUnit.trim()) {
      setError('Enter a unit name before choosing a file.');
      return;
    }
    fileRef.current?.click();
  };

  const doUpload = async (file) => {
    if (!file) return;
    setUploading(true);
    setMsg('');
    setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('class', cls.trim());
      form.append('subject', subject.trim());
      form.append('unit', newUnit.trim());
      const res = await kbService.uploadNotes(form);
      const d = res?.data || {};
      setMsg(
        d.reused
          ? `"${newUnit.trim()}" — these exact notes are already indexed (${d.chunkCount ?? '?'} chunks).`
          : `"${newUnit.trim()}" — indexed ${d.indexedCount ?? d.chunkCount ?? '?'} note chunk(s).`
      );
      setNewUnit('');
      await load();
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Notes upload failed.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[22px] font-bold text-gray-900">Knowledge base</h1>
        <p className="mt-1 text-[14px] text-gray-500">
          Syllabus notes are what the generator grounds every question in. Notes are filed by
          class, subject and unit, and reused by every paper that covers that unit.
        </p>
      </div>

      {/* Scope picker */}
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-gray-600">Class</span>
            <select className={`${fieldClass} w-full`} value={cls} onChange={(e) => setCls(e.target.value)}>
              <option value="">Choose class…</option>
              {CLASS_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-gray-600">Subject</span>
            <input
              className={`${fieldClass} w-full`}
              placeholder="e.g. English"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </label>
        </div>
      </div>

      {!ready && (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white px-6 py-12 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-gray-100 text-gray-400">
            <KnowledgeBaseIcon size={22} />
          </span>
          <p className="mt-3 text-[13.5px] font-medium text-gray-700">Pick a class and subject</p>
          <p className="mt-1 text-[12.5px] text-gray-500">Indexed units are listed per class and subject.</p>
        </div>
      )}

      {ready && (
        <div className="rounded-xl border border-gray-200 bg-white">
          <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3.5">
            <h2 className="text-[14px] font-semibold text-gray-900">
              Indexed units
              <span className="ml-2 text-[12px] font-normal text-gray-400">
                Class {cls} · {subject.trim()}
              </span>
            </h2>
            {loading && <span className="text-[12px] text-gray-400">Loading…</span>}
          </div>

          <div className="p-5">
            {error && (
              <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-700">
                {error}
              </div>
            )}
            {msg && (
              <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12.5px] text-emerald-800">
                {msg}
              </div>
            )}

            {units && units.length > 0 ? (
              <ul className="divide-y divide-gray-100">
                {units.map((u) => (
                  <li key={u.id} className="flex items-center justify-between py-2.5">
                    <div className="flex items-center gap-3">
                      <span className="text-[13px] font-medium text-gray-800">{u.label}</span>
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600">
                        {u.chunkCount} chunk{u.chunkCount === 1 ? '' : 's'}
                      </span>
                    </div>
                    <button
                      type="button"
                      disabled
                      title="Removing indexed notes needs a backend endpoint that is not built yet"
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-gray-300"
                    >
                      <TrashIcon size={14} />
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              !loading && (
                <p className="py-6 text-center text-[12.5px] text-gray-500">
                  No notes indexed for Class {cls} · {subject.trim()} yet.
                </p>
              )
            )}

            {/* Add notes */}
            <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-gray-100 pt-4">
              <label className="block">
                <span className="mb-1 block text-[11.5px] font-medium text-gray-500">Unit</span>
                <input
                  className={`${fieldClass} w-44`}
                  placeholder="e.g. Unit 3"
                  value={newUnit}
                  onChange={(e) => setNewUnit(e.target.value)}
                />
              </label>
              <button
                type="button"
                onClick={pickFile}
                disabled={uploading}
                className="inline-flex h-10 items-center gap-2 rounded-lg bg-blue-600 px-4 text-[13px] font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
              >
                <UploadCloudIcon size={16} />
                {uploading ? 'Uploading…' : 'Add notes'}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="application/pdf,.pdf,.txt,.md,.docx"
                className="hidden"
                onChange={(e) => {
                  doUpload(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
              <p className="w-full text-[11.5px] text-gray-400">
                PDF, DOCX, TXT or MD. The unit tag is explicit — it is never read from the file.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
