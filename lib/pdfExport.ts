// Currently unused. Was for the Download PDF button which was removed
// due to html2canvas/oklch incompatibility (html2canvas 1.4.1 does not
// support Tailwind 4's oklch() color space, producing broken PDF output).
// Keeping for potential future use with a server-side PDF approach.

/**
 * Exports an HTML element as a PDF download.
 * Uses html2pdf.js — runs entirely in the browser.
 *
 * Dynamic import avoids SSR issues — html2pdf accesses
 * window/document and cannot run during Next.js build.
 */
export async function exportElementAsPDF(
  element: HTMLElement,
  filename: string,
): Promise<void> {
  const html2pdf = (await import("html2pdf.js")).default;

  return html2pdf()
    .from(element)
    .set({
      margin:      [15, 15, 15, 15],  // mm — ~0.6in, standard letter formatting
      filename,
      image:       { type: "jpeg", quality: 0.95 },
      html2canvas: { scale: 2, useCORS: true },  // scale:2 = retina quality; useCORS for logo
      jsPDF:       { unit: "mm", format: "a4", orientation: "portrait" },
    })
    .save();
}
