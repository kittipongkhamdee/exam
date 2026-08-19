'use client';
// ConfirmDialog.jsx
//
// A styled stand-in for window.confirm() — a modal card matching the
// app's own look instead of the browser's native (and jarringly
// unstyled) confirm popup. Fully controlled: the caller owns the open
// state and passes onConfirm/onCancel, so it fits the same
// useState-per-component pattern already used throughout this app rather
// than pulling in a global modal library for one use case.

export default function ConfirmDialog({
  open, title, message, confirmLabel = 'ยืนยัน', cancelLabel = 'ยกเลิก',
  danger = false, loading = false, onConfirm, onCancel,
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={loading ? undefined : onCancel}
    >
      <div
        className="bg-white rounded-xl shadow-xl max-w-sm w-full p-5"
        onClick={e => e.stopPropagation()}
      >
        {title && <div className="font-semibold text-gray-900 mb-2">{title}</div>}
        {message && <div className="text-sm text-gray-600 whitespace-pre-line mb-5">{message}</div>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-gray-100 text-gray-900 hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition"
            onClick={onCancel}
            disabled={loading}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={
              "px-4 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed transition " +
              (danger ? 'bg-red-600 hover:bg-red-700' : 'bg-indigo-600 hover:bg-indigo-700')
            }
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? 'กำลังดำเนินการ...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
