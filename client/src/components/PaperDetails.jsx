/**
 * PaperDetails — Mode B step 1: class & subject for the manual paper.
 * (These two keys file the notes corpus the paper will be grounded in, so
 * they are asked before the builder opens.)
 */
const CLASS_OPTIONS = Array.from({ length: 12 }, (_, i) => String(i + 1));

const fieldClass =
  'h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors';

export default function PaperDetails({ meta, onChange, onBack, onNext }) {
  const cls = String(meta.class ?? '').trim();
  const subject = String(meta.subject ?? '').trim();
  const ready = cls !== '' && subject !== '';

  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-5">
      <p className="text-[15px] font-semibold text-gray-900">Paper details</p>
      <p className="mt-1 text-[12.5px] text-gray-500">
        Notes for this paper are filed under Class + Subject — the builder&apos;s topic suggestions and
        unit assignments come from the notes indexed for these two.
      </p>
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-[12px] font-medium text-gray-600">Class</span>
          <select className={`${fieldClass} w-full`} value={cls} onChange={(e) => onChange({ ...meta, class: e.target.value })}>
            <option value="">Choose class…</option>
            {CLASS_OPTIONS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] font-medium text-gray-600">Subject</span>
          <input
            className={`${fieldClass} w-full`}
            placeholder="e.g. English"
            value={subject}
            onChange={(e) => onChange({ ...meta, subject: e.target.value })}
          />
        </label>
      </div>
      <div className="mt-4 flex items-center gap-2">
        <button type="button" onClick={onBack} className="h-10 rounded-lg border border-gray-300 px-4 text-[13px] text-gray-600 hover:bg-gray-50">Back</button>
        <button
          type="button"
          onClick={onNext}
          disabled={!ready}
          className="h-10 rounded-lg bg-emerald-700 px-5 text-[13px] font-semibold text-white hover:bg-emerald-800 disabled:opacity-60"
        >
          Open the builder →
        </button>
      </div>
    </div>
  );
}
