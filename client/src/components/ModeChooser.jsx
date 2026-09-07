/**
 * ModeChooser — the entry card: where should the paper's STRUCTURE come from?
 *   Mode A: upload a previous-year paper → blueprint-extractor locks it.
 *   Mode B: build the structure yourself → manual builder → same pipeline.
 */
const Svg = ({ d, size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    {Array.isArray(d) ? d.map((p, i) => <path key={i} d={p} />) : <path d={d} />}
  </svg>
);

const cardBase =
  'flex-1 rounded-xl border bg-white p-5 text-left shadow-sm transition-all hover:shadow-md cursor-pointer';

export default function ModeChooser({ onSelect }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-5">
      <p className="text-[15px] font-semibold text-gray-900">How do you want to set the paper&apos;s structure?</p>
      <p className="mt-1 text-[12.5px] text-gray-500">
        Both paths end at the same review step: assign syllabus units, then generate.
      </p>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <button type="button" onClick={() => onSelect('A')} className={`${cardBase} border-blue-200 hover:border-blue-400`}>
          <div className="flex items-center gap-2">
            <Svg size={18} className="text-blue-600" d={['M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z', 'M14 2v6h6']} />
            <span className="text-[14px] font-semibold text-gray-900">From a previous-year paper</span>
          </div>
          <p className="mt-2 text-[12.5px] text-gray-500">
            Upload a PDF. The reference paper&apos;s question types, marks, item counts and sections are detected and locked automatically.
          </p>
          <p className="mt-2 text-[11.5px] font-medium text-blue-700">Upload a paper →</p>
        </button>

        <button type="button" onClick={() => onSelect('B')} className={`${cardBase} border-emerald-200 hover:border-emerald-400`}>
          <div className="flex items-center gap-2">
            <Svg size={18} className="text-emerald-600" d={['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z']} />
            <span className="text-[14px] font-semibold text-gray-900">Build it myself</span>
          </div>
          <p className="mt-2 text-[12.5px] text-gray-500">
            No reference paper. Choose each question&apos;s type, items, marks, difficulty and topic — question by question.
          </p>
          <p className="mt-2 text-[11.5px] font-medium text-emerald-700">Open the builder →</p>
        </button>
      </div>
    </div>
  );
}
