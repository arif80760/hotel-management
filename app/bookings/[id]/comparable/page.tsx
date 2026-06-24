// app/bookings/[id]/comparable/page.tsx
//
// Comparable Estimate for a single booking.
// [id] = booking_ref, e.g. "BK-1037"
//
// Server component — fetches the booking and renders a SCALED scenario
// document: every figure (room rate, extras, discount, customer payment)
// is multiplied by pct/100 so the page reads as a self-contained estimate
// at that percentage with NO real values shown anywhere.
//
// NON-DESTRUCTIVE: reads only, never writes. Mirrors the real invoice
// layout (LetterHead / PrintButtons / @page A4) so it feels native, but
// is clearly marked "COMPARABLE ESTIMATE · NOT A TAX INVOICE" and uses an
// "Estimate Ref" (never an invoice number) so it can't be mistaken for the
// official invoice.
//
// Only available for checked-out bookings (booking-level status collapses
// checked_out_early → "Checked Out", so the single check covers both).

import { Fragment }                       from "react";
import { notFound, redirect }            from "next/navigation";
import { createSupabaseServerClient }    from "@/lib/supabaseServer";
import { getBookingByRef }               from "@/services/bookingsService";
import { getRoomCategories }             from "@/services/roomCategoriesService";
import { buildCategoryNameMap,
         displayCategory }               from "@/lib/categoryNames";
import LetterHead                        from "@/components/invoice/LetterHead";
import PrintButtons                      from "@/components/invoice/PrintButtons";
import { formatInvoiceDate,
         formatTaka }                    from "@/lib/invoiceUtils";
import { HOTEL_INFO }                    from "@/lib/hotelInfo";

export const dynamic = "force-dynamic";

interface Props {
  params:       Promise<{ id: string }>;
  searchParams: Promise<{ pct?: string }>;
}

export default async function ComparablePage({ params, searchParams }: Props) {
  const { id } = await params;

  const serverClient = await createSupabaseServerClient();
  const { data: { user } } = await serverClient.auth.getUser();
  if (!user) redirect("/login");

  const booking = await getBookingByRef(id, serverClient).catch(() => null);
  if (!booking) notFound();

  // ── Percentage (default 70, clamp 1–100) ──────────────────────────────────
  const raw  = Number((await searchParams).pct);
  const pct  = Number.isFinite(raw) && raw > 0 && raw <= 100 ? raw : 70;
  const frac = pct / 100;

  // ── Guard: checked-out only ───────────────────────────────────────────────
  if (booking.status !== "Checked Out") {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6">
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 px-8 py-10 max-w-md text-center">
          <p className="text-[14px] font-semibold text-slate-800">
            Comparable estimate is only available for checked-out bookings.
          </p>
          <p className="text-[12px] text-slate-500 mt-2">
            {booking.id} is currently <span className="font-semibold">{booking.status}</span>.
          </p>
        </div>
      </div>
    );
  }

  // Resolve category slugs to their CURRENT names (renames reflect everywhere).
  const categories = await getRoomCategories(serverClient);
  const nameMap    = buildCategoryNameMap(categories);

  // ── Derived values ────────────────────────────────────────────────────────
  const issuedDateISO = booking.actualCheckoutDate ?? booking.checkOutISO;
  const issuedDate    = issuedDateISO ? formatInvoiceDate(issuedDateISO) : booking.checkOut;

  // Rooms sorted by room_number ascending; cancelled rooms excluded entirely.
  const sortedRooms = [...booking.rooms]
    .filter(r => r.status !== "Cancelled")
    .sort((a, b) => {
      const na = parseInt(a.roomNumber, 10);
      const nb = parseInt(b.roomNumber, 10);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a.roomNumber.localeCompare(b.roomNumber);
    });

  // Per-room scaled line values. Scale the RATE itself so no real figure shows.
  const roomLines = sortedRooms.map(room => {
    const scaledRate     = Math.round(room.bookingRate * frac);
    const scaledSubtotal = scaledRate * room.nights;
    return { room, scaledRate, scaledSubtotal };
  });
  const roomsScaledTotal = roomLines.reduce((sum, l) => sum + l.scaledSubtotal, 0);

  // Extras — scaled per line (chronological).
  const sortedExtras = [...booking.extraCharges].sort((a, b) => {
    const ta = a.appliedAt ? new Date(a.appliedAt).getTime() : 0;
    const tb = b.appliedAt ? new Date(b.appliedAt).getTime() : 0;
    return ta - tb;
  });
  const extraLines = sortedExtras.map(extra => ({
    extra,
    scaledAmount: Math.round(extra.amount * frac),
  }));
  const extrasScaledTotal = extraLines.reduce((sum, l) => sum + l.scaledAmount, 0);

  // Discount — scaled.
  const fullDiscount   = booking.additionalDiscountAmount ?? 0;
  const scaledDiscount = Math.round(fullDiscount * frac);

  const estimatedTotal = roomsScaledTotal + extrasScaledTotal - scaledDiscount;

  // ── Adjusted customer payment (settled, no "outstanding/due" language) ─────
  const fullExtras   = sortedExtras.reduce((sum, c) => sum + c.amount, 0);
  const realGross    = booking.totalAmount + fullExtras - fullDiscount;
  const realSettled  = booking.amountPaid >= realGross - 0.5;
  const paidAdjusted = realSettled ? estimatedTotal : Math.round(booking.amountPaid * frac);
  const balance      = estimatedTotal - paidAdjusted;

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
          filename={`Comparable-${booking.id}-${pct}pct`}
        />
      </div>

      {/* ── Estimate document ──────────────────────────────────────────────── */}
      <div
        id="invoice-document"
        className="max-w-[210mm] mx-auto bg-white p-12 print:p-0 shadow-sm print:shadow-none"
      >
        {/* Letterhead */}
        <LetterHead />

        {/* Title + metadata */}
        <div className="flex justify-between items-start py-6">
          <h2 className="text-3xl font-bold tracking-wide text-slate-900">
            COMPARABLE ESTIMATE
          </h2>
          <div className="grid grid-cols-[auto_auto] gap-x-4 gap-y-1 text-[11px]">
            <span className="text-slate-500 uppercase tracking-wide font-semibold">
              Estimate Ref
            </span>
            <span className="text-slate-900 font-semibold text-right">
              {booking.id} · COMP @{pct}%
            </span>
            <span className="text-slate-500 uppercase tracking-wide font-semibold">
              Issue Date
            </span>
            <span className="text-slate-900 font-semibold text-right">
              {issuedDate}
            </span>
          </div>
        </div>

        {/* NOT-A-TAX-INVOICE banner (print-safe) */}
        <div className="mb-6 px-4 py-2.5 bg-amber-50 border border-amber-300 rounded-md">
          <p className="text-[11px] font-semibold text-amber-800 uppercase tracking-wide">
            NOT A TAX INVOICE · Scenario at {pct}% of room value — for internal cross-check only.
          </p>
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
              const roomCheckoutISO = room.actualCheckoutDate ?? room.checkOutISO;
              return (
                <div key={room.id} className={i > 0 ? "mt-2" : ""}>
                  <p className="text-[13px] font-semibold text-slate-900">
                    Room {room.roomNumber} ({displayCategory(room.roomCategory, nameMap)})
                  </p>
                  <p className="text-[11px] text-slate-600">
                    {room.checkInISO ? formatInvoiceDate(room.checkInISO) : room.checkIn}
                    {" → "}
                    {roomCheckoutISO ? formatInvoiceDate(roomCheckoutISO) : room.checkOut}
                  </p>
                  <p className="text-[11px] text-slate-600">
                    {room.nights} {room.nights === 1 ? "night" : "nights"}
                  </p>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Charges table — SCALED ONLY ──────────────────────────────────── */}
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

            {/* Room accommodation — one row per non-cancelled room */}
            {roomLines.map(({ room, scaledRate, scaledSubtotal }) => (
              <Fragment key={room.id}>
                <tr className="border-b border-slate-100">
                  <td className="py-3">
                    <p className="font-medium text-slate-900">Room accommodation</p>
                    <p className="text-[11px] mt-0.5 text-slate-500">
                      Room {room.roomNumber} ({displayCategory(room.roomCategory, nameMap)})
                      {" · "}{room.nights} {room.nights === 1 ? "night" : "nights"}
                      {" × "}{formatTaka(scaledRate)}
                    </p>
                  </td>
                  <td className="py-3 text-right font-medium tabular-nums text-slate-900">
                    {formatTaka(scaledSubtotal)}
                  </td>
                </tr>
              </Fragment>
            ))}

            {/* Extra charges — itemized, scaled */}
            {extraLines.map(({ extra, scaledAmount }) => (
              <tr key={extra.id} className="border-b border-slate-100">
                <td className="py-3">
                  <p className="font-medium text-slate-900">
                    {extra.reason?.trim() || "Extra charge"}
                  </p>
                </td>
                <td className="py-3 text-right text-slate-900 font-medium tabular-nums">
                  {formatTaka(scaledAmount)}
                </td>
              </tr>
            ))}

            {/* Additional discount — scaled */}
            {scaledDiscount > 0 && (
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
                  −{formatTaka(scaledDiscount)}
                </td>
              </tr>
            )}

            {/* Total @pct% */}
            <tr className="border-t-2 border-slate-800">
              <td className="py-3 text-right font-bold text-slate-900 uppercase text-[11px] tracking-wide">
                Total @{pct}%
              </td>
              <td className="py-3 text-right font-bold text-slate-900 text-base tabular-nums">
                {formatTaka(estimatedTotal)}
              </td>
            </tr>

          </tbody>
        </table>

        {/* ── Adjusted payment block ───────────────────────────────────────── */}
        <div className="mt-6 flex justify-end">
          <div className="w-64 space-y-2">
            <div className="flex justify-between items-center text-[12px]">
              <span className="text-slate-500">Payment received (@{pct}%)</span>
              <span className="font-semibold text-slate-900 tabular-nums">{formatTaka(paidAdjusted)}</span>
            </div>
            {balance <= 0 ? (
              <div className="px-4 py-2.5 bg-emerald-50 border-2 border-emerald-300 rounded-md flex justify-between items-center">
                <p className="text-[11px] uppercase tracking-wider font-bold text-emerald-900">
                  Paid in Full
                </p>
                <span className="text-lg font-bold text-emerald-700">✓</span>
              </div>
            ) : (
              <div className="flex justify-between items-center text-[12px] pt-1 border-t border-slate-200">
                <span className="font-semibold text-slate-700">Balance @{pct}%</span>
                <span className="font-bold text-slate-900 tabular-nums">{formatTaka(balance)}</span>
              </div>
            )}
          </div>
        </div>

        {/* ── Footer ───────────────────────────────────────────────────────── */}
        <div className="mt-8 pt-6 border-t-2 border-slate-800 text-center space-y-1.5">
          <p className="text-[11px] text-slate-500 max-w-xl mx-auto">
            This is a comparable estimate, not an official invoice or tax document. Figures are a
            hypothetical scenario at {pct}% and do not reflect amounts billed or paid.
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
