"use client";

export type ConfirmTone = "normal" | "warning" | "danger";

export default function ConfirmDialog({
  open, title, message, confirmLabel = "Confirm", cancelLabel = "Cancel",
  tone = "normal", busy = false, onConfirm, onCancel,
}: {
  open: boolean; title: string; message: string;
  confirmLabel?: string; cancelLabel?: string; tone?: ConfirmTone;
  busy?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  if (!open) return null;
  const confirmCls =
    tone === "danger"  ? "bg-rose-600 hover:bg-rose-700"
    : tone === "warning" ? "bg-amber-500 hover:bg-amber-600"
    : "bg-slate-900 hover:bg-slate-700";
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-slate-900/40"
      onClick={busy ? undefined : onCancel}>
      <div className="w-full max-w-sm rounded-2xl bg-white shadow-xl ring-1 ring-slate-200 p-5"
        onClick={e => e.stopPropagation()}>
        <h3 className="text-[15px] font-semibold text-slate-900">{title}</h3>
        <p className="text-[13.5px] text-slate-600 mt-2 leading-snug">{message}</p>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onCancel} disabled={busy}
            className="px-4 py-2 rounded-lg text-[13px] font-medium text-slate-700 bg-white ring-1 ring-slate-200 hover:bg-slate-50 disabled:opacity-60">
            {cancelLabel}
          </button>
          <button onClick={onConfirm} disabled={busy}
            className={`px-4 py-2 rounded-lg text-[13px] font-medium text-white disabled:opacity-60 ${confirmCls}`}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
