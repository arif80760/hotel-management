// app/bookings/[id]/invoice/page.tsx
//
// Invoice page for a single booking.
// [id] = booking_ref, e.g. "BK-1037"
//
// Server component — fetches booking + payment history, renders
// a printable A4-style invoice document.
//
// Issued date  = actualCheckoutDate ?? checkOutISO (stable across re-opens)
// Generated on = new Date() in footer (ephemeral — intentional)
//
// Print notes:
//   @page { margin: 12mm } removes browser default margins so
//   browser print headers/footers have no space to render.
//   Users should also uncheck "Headers and footers" in the print
//   dialog's More settings for fully clean output.

import { Fragment }                       from "react";
import { notFound }                      from "next/navigation";
import { getBookingByRef,
         getPaymentsByBookingRef,
         listRefunds }                    from "@/services/bookingsService";
import LetterHead                        from "@/components/invoice/LetterHead";
import PrintButtons                      from "@/components/invoice/PrintButtons";
import { calcTrueDue,
         formatInvoiceNumber,
         formatInvoiceDate,
         formatTaka }                    from "@/lib/invoiceUtils";
import { HOTEL_INFO }                    from "@/lib/hotelInfo";
import { formatPaymentMethod }           from "@/lib/mockData";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function InvoicePage({ params }: Props) {
  const { id } = await params;

  const [booking, payments, refunds] = await Promise.all([
    getBookingByRef(id).catch(() => null),
    getPaymentsByBookingRef(id).catch(() => []),
    listRefunds(id).catch(() => []),
  ]);

  if (!booking) notFound();

  // ── Derived values ───────────────────────────────────────────────────────
  const invoiceNumber = formatInvoiceNumber(booking);

  // Issued date: booking-level checkout date shown in the Invoice header.
  // Per-room actual_checkout_date is applied in the Stay Details block per room.
  const issuedDateISO = booking.actualCheckoutDate ?? booking.checkOutISO;
  const issuedDate    = issuedDateISO
    ? formatInvoiceDate(issuedDateISO)
    : booking.checkOut;                  // display-string fallback

  // Rooms sorted by room_number ascending (numeric where possible, lexicographic fallback).
  // booking.rooms[] has no guaranteed DB order — sort for deterministic rendering.
  const sortedRooms = [...booking.rooms].sort((a, b) => {
    const na = parseInt(a.roomNumber, 10);
    const nb = parseInt(b.roomNumber, 10);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a.roomNumber.localeCompare(b.roomNumber);
  });

  // Sort itemized extras by applied_at ascending — chronological order matches operator entry sequence.
  const sortedExtras = [...booking.extraCharges].sort((a, b) => {
    const ta = a.appliedAt ? new Date(a.appliedAt).getTime() : 0;
    const tb = b.appliedAt ? new Date(b.appliedAt).getTime() : 0;
    return ta - tb;
  });
  const totalExtraCharges  = sortedExtras.reduce((sum, c) => sum + c.amount, 0);

  const additionalDiscount = booking.additionalDiscountAmount ?? 0;

  // grossBill = total owed for the stay, before payments
  const grossBill   = booking.totalAmount + totalExtraCharges - additionalDiscount;
  // outstanding = what's still owed after all payments recorded
  const outstanding = calcTrueDue(booking);
  const totalPaid   = payments.reduce((sum, p) => sum + p.amount, 0);

  // Disbursed refunds only — pending and denied are operator-internal state.
  // Sorted by disbursedAt ascending (chronological).
  const disbursedRefunds = refunds.filter(r => r.status === "disbursed");
  const sortedRefunds    = [...disbursedRefunds].sort((a, b) => {
    const ta = a.disbursedAt ? new Date(a.disbursedAt).getTime() : 0;
    const tb = b.disbursedAt ? new Date(b.disbursedAt).getTime() : 0;
    return ta - tb;
  });
  const totalRefunded = sortedRefunds.reduce((sum, r) => sum + r.amount, 0);

  const generatedOn = new Date().toLocaleString("en-US", {
    year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

  return (
    <div className="min-h-screen bg-slate-100 print:bg-white">

      {/* @page rule — 12mm page margins push browser print headers/footers out */}
      <style>{`
        @page { margin: 12mm; size: A4 portrait; }
        @media print { html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
      `}</style>

      {/* PrintButtons — above document, hidden when printing */}
      <div className="max-w-[210mm] mx-auto py-6 px-4 print:hidden">
        <PrintButtons
          targetId="invoice-document"
          filename={`Invoice-${invoiceNumber}`}
        />
      </div>

      {/* ── Invoice document ───────────────────────────────────────────────── */}
      <div
        id="invoice-document"
        className="max-w-[210mm] mx-auto bg-white p-12 print:p-0
          shadow-sm print:shadow-none"
      >
        {/* Letterhead */}
        <LetterHead />

        {/* Title + metadata */}
        <div className="flex justify-between items-start py-6">
          <h2 className="text-3xl font-bold tracking-wide text-slate-900">
            INVOICE
          </h2>
          <div className="grid grid-cols-[auto_auto] gap-x-4 gap-y-1 text-[11px]">
            <span className="text-slate-500 uppercase tracking-wide font-semibold">
              Invoice No
            </span>
            <span className="text-slate-900 font-semibold text-right">
              #{invoiceNumber}
            </span>
            <span className="text-slate-500 uppercase tracking-wide font-semibold">
              Issue Date
            </span>
            <span className="text-slate-900 font-semibold text-right">
              {issuedDate}
            </span>
            <span className="text-slate-500 uppercase tracking-wide font-semibold">
              Status
            </span>
            <span className="text-slate-900 font-semibold text-right">
              {booking.status}
            </span>
          </div>
        </div>

        {/* Bill To / Stay Details */}
        <div className="grid grid-cols-2 gap-12 pb-4 border-b border-slate-200">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold mb-2">
              Bill To
            </p>
            <p className="text-[13px] font-semibold text-slate-900">{booking.guestName}</p>
            <p className="text-[11px] text-slate-600">{booking.phone}</p>
            {booking.email && (
              <p className="text-[11px] text-slate-600">{booking.email}</p>
            )}
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold mb-2">
              Stay Details
            </p>
            {sortedRooms.map((room, i) => {
              const isCancelled = room.status === "Cancelled";
              // Per-room checkout: actual departure date if set, else scheduled checkout.
              const roomCheckoutISO = room.actualCheckoutDate ?? room.checkOutISO;
              // Use stored nights — always the correct billable value regardless of checkout timing.
              const computedNights = room.nights;
              return (
                <div key={room.id} className={i > 0 ? "mt-2" : ""}>
                  <p className={`text-[13px] font-semibold ${isCancelled ? "line-through text-slate-400" : "text-slate-900"}`}>
                    Room {room.roomNumber} ({room.roomCategory})
                  </p>
                  <p className={`text-[11px] ${isCancelled ? "line-through text-slate-400" : "text-slate-600"}`}>
                    {room.checkInISO ? formatInvoiceDate(room.checkInISO) : room.checkIn}
                    {" → "}
                    {roomCheckoutISO ? formatInvoiceDate(roomCheckoutISO) : room.checkOut}
                  </p>
                  <p className={`text-[11px] ${isCancelled ? "line-through text-slate-400" : "text-slate-600"}`}>
                    {computedNights} {computedNights === 1 ? "night" : "nights"}
                  </p>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Charges table ─────────────────────────────────────────────────── */}
        <table className="w-full text-[12px] mt-6">
          <thead>
            <tr className="border-b-2 border-slate-800">
              <th className="text-left py-2 uppercase tracking-wide text-[10px] font-semibold text-slate-600">
                Description
              </th>
              <th className="text-right py-2 uppercase tracking-wide text-[10px] font-semibold text-slate-600 w-28">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>

            {/* Room accommodation — one row per room, sorted by room_number */}
            {sortedRooms.map(room => {
              const isCancelled = room.status === "Cancelled";
              // Use stored nights — always the correct billable value regardless of checkout timing.
              const computedNights = room.nights;
              const roomSubtotal = room.bookingRate * computedNights;
              return (
                <Fragment key={room.id}>
                  <tr className="border-b border-slate-100">
                    <td className="py-3">
                      <p className={`font-medium ${isCancelled ? "line-through text-slate-400" : "text-slate-900"}`}>
                        Room accommodation
                      </p>
                      <p className={`text-[11px] mt-0.5 ${isCancelled ? "line-through text-slate-400" : "text-slate-500"}`}>
                        Room {room.roomNumber} ({room.roomCategory})
                        {" · "}{computedNights} {computedNights === 1 ? "night" : "nights"}
                        {" × "}{formatTaka(room.bookingRate)}
                      </p>
                    </td>
                    <td className={`py-3 text-right font-medium tabular-nums ${isCancelled ? "line-through text-slate-400" : "text-slate-900"}`}>
                      {formatTaka(roomSubtotal)}
                    </td>
                  </tr>

                </Fragment>
              );
            })}

            {/* Extra charges — itemized, one row per booking_extra_charges row */}
            {sortedExtras.map(charge => (
              <tr key={charge.id} className="border-b border-slate-100">
                <td className="py-3">
                  <p className="font-medium text-slate-900">
                    {charge.reason?.trim() || "Extra charge"}
                  </p>
                </td>
                <td className="py-3 text-right text-slate-900 font-medium tabular-nums">
                  {formatTaka(charge.amount)}
                </td>
              </tr>
            ))}

            {/* Additional discount */}
            {additionalDiscount > 0 && (
              <tr className="border-b border-slate-100">
                <td className="py-3">
                  <p className="font-medium text-emerald-700">Discount</p>
                  {booking.additionalDiscountReason && (
                    <p className="text-[11px] text-emerald-600 mt-0.5">
                      {booking.additionalDiscountReason}
                    </p>
                  )}
                </td>
                <td className="py-3 text-right text-emerald-700 font-medium tabular-nums">
                  −{formatTaka(additionalDiscount)}
                </td>
              </tr>
            )}

            {/* Total Due */}
            <tr className="border-t-2 border-slate-800">
              <td className="py-3 text-right font-bold text-slate-900 uppercase text-[11px] tracking-wide">
                Total Due
              </td>
              <td className="py-3 text-right font-bold text-slate-900 text-base tabular-nums">
                {formatTaka(grossBill)}
              </td>
            </tr>

          </tbody>
        </table>

        {/* ── Payment history ────────────────────────────────────────────────── */}
        {payments.length > 0 && (
          <div className="mt-8">
            <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold mb-2">
              Payment History
            </p>
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b-2 border-slate-800">
                  <th className="text-left py-2 uppercase tracking-wide text-[10px] font-semibold text-slate-600">
                    Date
                  </th>
                  <th className="text-left py-2 uppercase tracking-wide text-[10px] font-semibold text-slate-600">
                    Method
                  </th>
                  <th className="text-left py-2 uppercase tracking-wide text-[10px] font-semibold text-slate-600">
                    Notes
                  </th>
                  <th className="text-right py-2 uppercase tracking-wide text-[10px] font-semibold text-slate-600 w-28">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {payments.map(p => (
                  <tr key={p.id} className="border-b border-slate-100">
                    <td className="py-2.5 text-slate-700">
                      {formatInvoiceDate(p.createdAt)}
                    </td>
                    <td className="py-2.5 text-slate-700">
                      {formatPaymentMethod(p.method)}
                    </td>
                    <td className="py-2.5 text-slate-500">{p.notes ?? "—"}</td>
                    <td className="py-2.5 text-right text-slate-900 font-medium tabular-nums">
                      {formatTaka(p.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-800">
                  <td colSpan={3} className="py-2.5 font-bold text-slate-900 uppercase text-[11px] tracking-wide">
                    Total Paid
                  </td>
                  <td className="py-2.5 text-right font-bold text-slate-900 tabular-nums">
                    {formatTaka(totalPaid)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {/* ── Refunds ───────────────────────────────────────────────────────── */}
        {sortedRefunds.length > 0 && (
          <div className="mt-8">
            <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold mb-2">
              Refunds
            </p>
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b-2 border-slate-800">
                  <th className="text-left py-2 uppercase tracking-wide text-[10px] font-semibold text-slate-600">
                    Date
                  </th>
                  <th className="text-left py-2 uppercase tracking-wide text-[10px] font-semibold text-slate-600">
                    Method
                  </th>
                  <th className="text-left py-2 uppercase tracking-wide text-[10px] font-semibold text-slate-600">
                    Notes
                  </th>
                  <th className="text-right py-2 uppercase tracking-wide text-[10px] font-semibold text-slate-600 w-28">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedRefunds.map(r => (
                  <tr key={r.id} className="border-b border-slate-100">
                    <td className="py-2.5 text-slate-700">
                      {r.disbursedAt ? formatInvoiceDate(r.disbursedAt) : "—"}
                    </td>
                    <td className="py-2.5 text-slate-700">
                      {r.disbursementMethod ? formatPaymentMethod(r.disbursementMethod) : "—"}
                    </td>
                    <td className="py-2.5 text-slate-500">{r.reason ?? "—"}</td>
                    <td className="py-2.5 text-right text-rose-700 font-medium tabular-nums">
                      −{formatTaka(r.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-800">
                  <td colSpan={3} className="py-2.5 font-bold text-slate-900 uppercase text-[11px] tracking-wide">
                    Total Refunded
                  </td>
                  <td className="py-2.5 text-right font-bold text-rose-700 tabular-nums">
                    −{formatTaka(totalRefunded)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {/* ── Balance banner ──────────────────────────────────────────────────
            Three states:
              outstanding > 0          → rose  "Outstanding Balance"
              outstanding ≤ 0, paid > 0 → emerald "Paid in Full"
              both zero                → render nothing
        ── */}
        {outstanding > 0 && (
          <div className="mt-6 px-6 py-4 bg-rose-50 border border-rose-200 rounded-md
            flex justify-between items-center">
            <p className="text-[11px] uppercase tracking-wider font-bold text-rose-900">
              Outstanding Balance
            </p>
            <p className="text-xl font-bold text-rose-700 tabular-nums">
              {formatTaka(outstanding)}
            </p>
          </div>
        )}
        {outstanding <= 0 && totalPaid > 0 && (
          <div className="mt-6 px-6 py-4 bg-emerald-50 border-2 border-emerald-300 rounded-md
            flex justify-between items-center">
            <p className="text-[11px] uppercase tracking-wider font-bold text-emerald-900">
              Paid in Full
            </p>
            <span className="text-xl font-bold text-emerald-700">✓</span>
          </div>
        )}

        {/* ── Footer ────────────────────────────────────────────────────────── */}
        <div className="mt-8 pt-6 border-t-2 border-slate-800 text-center space-y-1.5">
          <p className="text-[13px] font-semibold text-slate-900">
            {HOTEL_INFO.footerText}
          </p>
          <p className="text-[10px] text-slate-500">
            {HOTEL_INFO.name} · {HOTEL_INFO.address}
          </p>
          <p className="text-[10px] text-slate-400">Generated on {generatedOn}</p>
        </div>

      </div>
    </div>
  );
}
