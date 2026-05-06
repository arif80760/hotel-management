"use client";

// components/invoice/PrintButtons.tsx
//
// Print action button for invoice/reservation documents.
// Client component — uses window.print().
// Hidden entirely when printing (@media print via className).
//
// Note: Download PDF was removed — html2canvas 1.4.1 (bundled by
// html2pdf.js) does not support Tailwind 4's oklch() color space,
// producing broken output. Browser Print → Save as PDF is the
// correct path; it uses the native renderer with full CSS support.

interface PrintButtonsProps {
  /** id of the element to print — reserved for future server-side PDF support */
  targetId: string;
  /** filename without extension — reserved for future PDF export */
  filename: string;
}

export default function PrintButtons({ targetId: _targetId, filename: _filename }: PrintButtonsProps) {
  return (
    <div className="print:hidden">
      <p className="text-[11px] text-slate-500 mb-2">
        Tip: for cleanest output, open <strong>More settings</strong> in the
        print dialog and uncheck <strong>Headers and footers</strong>.
      </p>
      <button
        onClick={() => window.print()}
        className="inline-flex items-center gap-2 px-4 py-2 text-[13px] font-semibold
          text-white bg-amber-500 rounded-lg
          hover:bg-amber-600 transition-colors shadow-sm"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
          <polyline points="6 9 6 2 18 2 18 9"/>
          <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
          <rect x="6" y="14" width="12" height="8"/>
        </svg>
        Print / Save as PDF
      </button>
    </div>
  );
}
