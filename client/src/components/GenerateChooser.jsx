/**
 * GenerateChooser — the "Generate Question Paper" entry screen.
 * Recreates the exact UI/UX from the reference screenshot:
 *   - Bold page title and subtitle with comfortable whitespace
 *   - Two large creation cards (Mode A & Mode B)
 *   - Card 1: Generate from Previous Year Paper (Recommended badge, PDF art, 3 features with circular icons, blue CTA)
 *   - Card 2: Build My Own Question Paper (Full Control badge, Document art, 3 features with circular icons, purple CTA)
 *   - Bottom information banner: "Make sure your syllabus notes are uploaded before generating a paper." + Manage Notes link
 */
import {
  StarIcon,
  GearIcon,
  ArrowRightIcon,
  FileLinesIcon,
  BrainIcon,
  ShieldCheckIcon,
  PencilIcon,
  BookOpenIcon,
  SlidersIcon,
  PlusIcon,
  InfoIcon,
} from './ui/icons.jsx';

function Feature({ tone, Icon, title, desc }) {
  const isPurple = tone === 'purple';
  const iconCls = isPurple
    ? 'bg-[#f6f0fe] text-[#7c3aed]'
    : 'bg-[#eef4ff] text-[#2563eb]';

  return (
    <div className="flex items-start gap-3.5">
      <span className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${iconCls}`}>
        <Icon size={18} />
      </span>
      <div className="min-w-0">
        <p className="text-[13.5px] font-bold text-gray-900 leading-snug">{title}</p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-gray-500">{desc}</p>
      </div>
    </div>
  );
}

function ModeCard({
  tone,
  badge,
  BadgeIcon,
  art,
  artAlt,
  title,
  subtitle,
  features,
  ButtonIcon,
  buttonLabel,
  onClick,
}) {
  const isPurple = tone === 'purple';
  const badgeCls = isPurple
    ? 'bg-purple-50 text-purple-700 border-purple-200/70'
    : 'bg-blue-50 text-blue-700 border-blue-200/70';
  const btnCls = isPurple
    ? 'bg-[#5B3EE8] hover:bg-[#4E32D4] shadow-purple-500/20 hover:shadow-purple-500/30'
    : 'bg-[#1E6BFF] hover:bg-blue-700 shadow-blue-500/20 hover:shadow-blue-500/30';

  return (
    <div
      onClick={onClick}
      className={`group relative flex flex-col justify-between rounded-3xl border bg-white p-6 sm:p-8 shadow-[0_2px_12px_rgba(0,0,0,0.03)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg cursor-pointer ${
        isPurple ? 'border-purple-100/90 hover:border-purple-200' : 'border-blue-100/90 hover:border-blue-200'
      }`}
    >
      <div>
        {/* Top-Right Badge */}
        <span
          className={`absolute right-6 top-6 inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11.5px] font-semibold ${badgeCls}`}
        >
          <BadgeIcon size={13} />
          {badge}
        </span>

        {/* Card Artwork */}
        <div className="flex items-center justify-center pt-3 pb-2 select-none">
          <img
            src={art}
            alt={artAlt}
            className="h-44 sm:h-48 w-auto max-w-[85%] object-contain transition-transform duration-300 group-hover:scale-[1.02]"
          />
        </div>

        {/* Card Title & Description */}
        <h3 className="mt-3 text-center text-lg sm:text-[21px] font-bold text-gray-900 tracking-tight">
          {title}
        </h3>
        <p className="mx-auto mt-2 max-w-sm text-center text-[12.5px] sm:text-[13px] leading-relaxed text-gray-500">
          {subtitle}
        </p>

        {/* Dashed Divider Line */}
        <div className="my-6 border-t border-dashed border-gray-200" />

        {/* Feature Points */}
        <div className="space-y-4">
          {features.map((f) => (
            <Feature key={f.title} tone={tone} {...f} />
          ))}
        </div>
      </div>

      {/* Primary CTA Button */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        className={`relative mt-8 flex h-12 w-full items-center justify-between rounded-xl px-5 text-[13.5px] font-semibold text-white shadow-md transition-all active:scale-[0.99] ${btnCls}`}
      >
        <span className="flex items-center gap-2.5">
          <ButtonIcon size={17} />
          <span>{buttonLabel}</span>
        </span>
        <ArrowRightIcon size={17} className="transition-transform group-hover:translate-x-0.5" />
      </button>
    </div>
  );
}

export default function GenerateChooser({ onSelectA, onSelectB, onManageNotes }) {
  return (
    <div className="max-w-5xl mx-auto py-2">
      {/* ── Page Header ────────────────────────────────────── */}
      <div className="mb-8 text-left">
        <h1 className="text-2xl sm:text-[28px] font-bold text-gray-900 tracking-tight">
          Generate Question Paper
        </h1>
        <p className="mt-1.5 text-sm sm:text-[15px] text-gray-500">
          Choose how you want to create your question paper.
        </p>
      </div>

      {/* ── Two Creation Option Cards ──────────────────────── */}
      <div className="grid gap-6 sm:gap-7 grid-cols-1 lg:grid-cols-2 items-stretch">
        <ModeCard
          tone="blue"
          badge="Recommended"
          BadgeIcon={StarIcon}
          art="/prevPaper.png"
          artAlt="Previous year question paper converted to new generated question paper"
          title="Generate from Previous Year Paper"
          subtitle="Upload a previous year question paper and let AI create a new paper with the same structure."
          features={[
            {
              Icon: FileLinesIcon,
              title: 'Keeps the same pattern and structure',
              desc: 'Same sections, question types and marks distribution',
            },
            {
              Icon: BrainIcon,
              title: 'AI generates new questions',
              desc: 'Fresh, original questions based on your syllabus notes',
            },
            {
              Icon: ShieldCheckIcon,
              title: 'Saves time',
              desc: 'Best for recreating similar papers every year',
            },
          ]}
          ButtonIcon={FileLinesIcon}
          buttonLabel="Generate from Previous Year Paper"
          onClick={onSelectA}
        />

        <ModeCard
          tone="purple"
          badge="Full Control"
          BadgeIcon={GearIcon}
          art="/BuildOwn.png"
          artAlt="Build your own question paper with custom structure, marks, and units"
          title="Build My Own Question Paper"
          subtitle="Create your own structure, set questions, marks and units, and let AI generate the content."
          features={[
            {
              Icon: PencilIcon,
              title: 'Define your own structure',
              desc: 'Choose question types, number of items and marks',
            },
            {
              Icon: BookOpenIcon,
              title: 'Assign units and topics',
              desc: 'Link each question to specific units from your notes',
            },
            {
              Icon: SlidersIcon,
              title: 'Complete flexibility',
              desc: 'Best for custom papers, unit tests or special requirements',
            },
          ]}
          ButtonIcon={PlusIcon}
          buttonLabel="Build My Own Question Paper"
          onClick={onSelectB}
        />
      </div>

      {/* ── Information Banner ─────────────────────────────── */}
      <div className="mt-8 flex flex-col sm:flex-row items-center justify-between gap-3 rounded-2xl border border-blue-200/90 bg-[#f0f7ff] px-5 py-3.5 shadow-xs text-center sm:text-left">
        <div className="flex items-center gap-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-600">
            <InfoIcon size={16} />
          </span>
          <p className="text-[13px] font-normal text-slate-700">
            Make sure your syllabus notes are uploaded before generating a paper.
          </p>
        </div>
        <button
          type="button"
          onClick={onManageNotes}
          className="inline-flex shrink-0 items-center gap-1 text-[13px] font-semibold text-blue-600 hover:text-blue-700 transition-colors cursor-pointer"
        >
          <span>Manage Notes</span>
          <ArrowRightIcon size={14} />
        </button>
      </div>
    </div>
  );
}
