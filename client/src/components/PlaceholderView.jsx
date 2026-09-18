/**
 * PlaceholderView — honest empty state for views that have no backing store in
 * this build (My papers, Templates, Settings). Each explains why it is empty
 * and points at the flow that does work, instead of showing invented rows.
 */
import { ArrowRightIcon } from './ui/icons.jsx';

export default function PlaceholderView({ title, subtitle, Icon, body, actionLabel, onAction }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[22px] font-bold text-gray-900">{title}</h1>
        {subtitle && <p className="mt-1 text-[14px] text-gray-500">{subtitle}</p>}
      </div>

      <div className="rounded-xl border border-dashed border-gray-300 bg-white px-6 py-16 text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gray-100 text-gray-400">
          <Icon size={26} />
        </span>
        <p className="mx-auto mt-4 max-w-md text-[13px] leading-relaxed text-gray-500">{body}</p>
        {actionLabel && onAction && (
          <button
            type="button"
            onClick={onAction}
            className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-[12.5px] font-semibold text-white hover:bg-blue-700"
          >
            {actionLabel}
            <ArrowRightIcon size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
