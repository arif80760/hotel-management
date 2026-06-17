// app/bookings/[id]/reservation/page.tsx
//
// Reservation Details / Booking Confirmation page.
// [id] = booking_ref, e.g. "BK-1037"
//
// Use case: staff prints/saves PDF to share with guest as
// a booking confirmation document.
//
// Server component. Fetches booking only — no payment data needed.
// AppShell's isStandaloneDocument regex already covers this route.

import { Fragment }                       from "react";
import { notFound, redirect }            from "next/navigation";
import { createSupabaseServerClient }    from "@/lib/supabaseServer";
import { getBookingByRef,
         getPaymentsByBookingRef }        from "@/services/bookingsService";
import { getRoomCategories }              from "@/services/roomCategoriesService";
import { buildCategoryNameMap,
         displayCategory }                from "@/lib/categoryNames";
import LetterHead                        from "@/components/invoice/LetterHead";
import PrintButtons                      from "@/components/invoice/PrintButtons";
import { formatInvoiceNumber,
         formatInvoiceDate,
         formatTaka }                    from "@/lib/invoiceUtils";
import { formatPaymentMethod }           from "@/lib/mockData";
import { HOTEL_INFO }                    from "@/lib/hotelInfo";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ReservationPage({ params }: Props) {
  const { id } = await params;

  const serverClient = await createSupabaseServerClient();
  const { data: { user } } = await serverClient.auth.getUser();
  if (!user) redirect("/login");

  const [booking, payments] = await Promise.all([
    getBookingByRef(id, serverClient).catch(() => null),
    getPaymentsByBookingRef(id, serverClient).catch(() => []),
  ]);

  if (!booking) notFound();

  // Resolve category slugs to their CURRENT names (renames reflect everywhere).
  const categories = await getRoomCategories(serverClient);
  const nameMap    = buildCategoryNameMap(categories);

  // ── Derived values ───────────────────────────────────────────────────────
  const reservationNumber = formatInvoiceNumber(booking);

  // Booking date: when the reservation was made
  const bookingDate = booking.createdAt
    ? formatInvoiceDate(booking.createdAt)
    : formatInvoiceDate(new Date());    // fallback: today

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

  const earlyDeduction     = booking.earlyDeductionAmount     ?? 0;
  const additionalDiscount = booking.additionalDiscountAmount ?? 0;

  // Estimated total = charges as currently recorded (may change at checkout)
  const estimatedTotal = booking.totalAmount + totalExtraCharges - earlyDeduction - additionalDiscount;

  // Payments — already sorted oldest-first by getPaymentsByBookingRef (.order created_at ASC)
  const totalPaid  = payments.reduce((sum, p) => sum + p.amount, 0);
  // First (advance) payment method label — null if no payments recorded yet
  const firstMethod = payments[0] ? formatPaymentMethod(payments[0].method) : null;

  // Balance remaining as of this document (may change before checkout)
  const balanceDue = estimatedTotal - totalPaid;

  const generatedOn = new Date().toLocaleString("en-US", {
    year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

  return (
    <div className="min-h-screen bg-slate-100 print:bg-white">

      <style>{`
        @page { margin: 12mm; size: A4 portrait; }
        @media print { html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
      `}</style>

      {/* PrintButtons — hidden when printing */}
      <div className="max-w-[210mm] mx-auto py-6 px-4 print:hidden">
        <PrintButtons
          targetId="reservation-document"
          filename={`Reservation-${reservationNumber}`}
        />
      </div>

      {/* ── Reservation document ───────────────────────────────────────────── */}
      <div
        id="reservation-document"
        className="max-w-[210mm] mx-auto bg-white p-12 print:p-0
          shadow-sm print:shadow-none"
      >
        {/* Letterhead */}
        <LetterHead />

        {/* Title + metadata */}
        <div className="flex justify-between items-start py-6">
          <h2 className="text-3xl font-bold tracking-wide text-slate-900">
            RESERVATION DETAILS
          </h2>
          <div className="grid grid-cols-[auto_auto] gap-x-4 gap-y-1 text-[11px]">
            <span className="text-slate-500 uppercase tracking-wide font-semibold">
              Reservation No
            </span>
            <span className="text-slate-900 font-semibold text-right">
              #{reservationNumber}
            </span>
            <span className="text-slate-500 uppercase tracking-wide font-semibold">
              Booking Date
            </span>
            <span className="text-slate-900 font-semibold text-right">
              {bookingDate}
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
              // Compute nights from dates — stored nights column may drift from check_in/check_out.
              const computedNights = Math.round(
                (new Date(room.checkOutISO).getTime() - new Date(room.checkInISO).getTime())
                / 86400000
              );
              return (
                <div key={room.id} className={i > 0 ? "mt-2" : ""}>
                  <p className={`text-[13px] font-semibold ${isCancelled ? "line-through text-slate-400" : "text-slate-900"}`}>
                    Room {room.roomNumber} ({displayCategory(room.roomCategory, nameMap)})
                  </p>
                  <p className={`text-[11px] ${isCancelled ? "line-through text-slate-400" : "text-slate-600"}`}>
                    {room.checkInISO ? formatInvoiceDate(room.checkInISO) : room.checkIn}
                    {" → "}
                    {room.checkOutISO ? formatInvoiceDate(room.checkOutISO) : room.checkOut}
                  </p>
                  <p className={`text-[11px] ${isCancelled ? "line-through text-slate-400" : "text-slate-600"}`}>
                    {computedNights} {computedNights === 1 ? "night" : "nights"}
                  </p>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Reservation Charges table ──────────────────────────────────────── */}
        <table className="w-full text-[12px] mt-6">
          <thead>
            <tr className="border-b-2 border-slate-800">
              <th className="text-left py-2 uppercase tracking-wide text-[10px] font-semibold text-slate-600">
                Reservation Charges
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
              // Compute nights from dates — stored nights column may drift from check_in/check_out.
              const computedNights = Math.round(
                (new Date(room.checkOutISO).getTime() - new Date(room.checkInISO).getTime())
                / 86400000
              );
              const roomSubtotal = room.bookingRate * computedNights;
              return (
                <Fragment key={room.id}>
                  <tr className="border-b border-slate-100">
                    <td className="py-3">
                      <p className={`font-medium ${isCancelled ? "line-through text-slate-400" : "text-slate-900"}`}>
                        Room accommodation
                      </p>
                      <p className={`text-[11px] mt-0.5 ${isCancelled ? "line-through text-slate-400" : "text-slate-500"}`}>
                        Room {room.roomNumber} ({displayCategory(room.roomCategory, nameMap)})
                        {" · "}{computedNights} {computedNights === 1 ? "night" : "nights"}
                        {" × "}{formatTaka(room.bookingRate)}
                      </p>
                    </td>
                    <td className={`py-3 text-right font-medium tabular-nums ${isCancelled ? "line-through text-slate-400" : "text-slate-900"}`}>
                      {formatTaka(roomSubtotal)}
                    </td>
                  </tr>
                  {/* Per-room early checkout deduction — indented sub-row */}
                  {room.earlyNightsDeducted > 0 && room.earlyDeductionAmount > 0 && (
                    <tr className="border-b border-slate-100">
                      <td className="py-3 pl-4">
                        <p className={`font-medium ${isCancelled ? "line-through text-slate-400" : "text-emerald-700"}`}>
                          Early checkout deduction
                        </p>
                        <p className={`text-[11px] mt-0.5 ${isCancelled ? "line-through text-slate-400" : "text-emerald-600"}`}>
                          {room.earlyNightsDeducted}{" "}
                          {room.earlyNightsDeducted === 1 ? "night" : "nights"} deducted
                        </p>
                      </td>
                      <td className={`py-3 text-right font-medium tabular-nums ${isCancelled ? "line-through text-slate-400" : "text-emerald-700"}`}>
                        −{formatTaka(room.earlyDeductionAmount)}
                      </td>
                    </tr>
                  )}
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

            {/* Estimated Total */}
            <tr className="border-t-2 border-slate-800">
              <td className="py-3 text-right font-bold text-slate-900 uppercase text-[11px] tracking-wide">
                Estimated Total
              </td>
              <td className="py-3 text-right font-bold text-slate-900 text-base tabular-nums">
                {formatTaka(estimatedTotal)}
              </td>
            </tr>

          </tbody>
        </table>

        {/* ── Payment summary ───────────────────────────────────────────────
            Shows amount paid so far (advance) and remaining balance.
            Omitted entirely when no payments have been recorded yet.
        ──────────────────────────────────────────────────────────────────── */}
        {totalPaid > 0 && (
          <div className="mt-6">
            <div className="flex justify-between items-center py-3 border-b border-slate-100">
              <p className="text-[12px] text-emerald-700 font-medium">
                Amount Paid{firstMethod && ` · via ${firstMethod}`}
              </p>
              <p className="text-[12px] text-emerald-700 font-semibold tabular-nums">
                {formatTaka(totalPaid)}
              </p>
            </div>
            {balanceDue > 0 && (
              <div className="flex justify-between items-center py-3">
                <p className="text-[12px] text-slate-700 font-medium">Balance Due</p>
                <p className="text-[12px] text-slate-900 font-semibold tabular-nums">
                  {formatTaka(balanceDue)}
                </p>
              </div>
            )}
          </div>
        )}

        {/* ── Footer ────────────────────────────────────────────────────────── */}
        <div className="mt-8 pt-6 border-t-2 border-slate-800 text-center space-y-1.5">
          <p className="text-[13px] font-semibold text-slate-900">
            {HOTEL_INFO.reservationFooterText}
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
