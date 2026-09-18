/**
 * ConfirmDialog — a blocking confirm/cancel modal. Used wherever an action is
 * irreversible (e.g. deleting a School Template) so nothing is done silently.
 * Stateless: the parent owns "is it open" and both callbacks.
 */
import { AlertTriangleIcon } from './ui/icons.jsx';

export default function ConfirmDialog({ title, body, confirmLabel = 'Delete', onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-5 shadow-xl">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-50 text-red-600">
            <AlertTriangleIcon size={18} />
          </span>
          <div>
            <p className="text-[14px] font-semibold text-gray-900">{title}</p>
            <p className="mt-1 text-[12.5px] text-gray-600">{body}</p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-lg border border-gray-300 px-3 py-1.5 text-[12.5px] font-medium text-gray-700 hover:bg-gray-50">
            Cancel
          </button>
          <button type="button" onClick={onConfirm} className="rounded-lg bg-red-600 px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-red-700">
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
