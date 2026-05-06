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

import { notFound }                      from "next/navigation";
import { getBookingByRef,
         getPaymentsByBookingRef }        from "@/services/bookingsService";
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

  const [booking, payments] = await Promise.all([
    getBookingByRef(id).catch(() => null),
    getPaymentsByBookingRef(id).catch(() => []),
  ]);

  if (!booking) notFound();

  // ── Derived values ───────────────────────────────────────────────────────
  const reservationNumber = formatInvoiceNumber(booking);

  // Booking date: when the reservation was made
  const bookingDate = booking.createdAt
    ? formatInvoiceDate(booking.createdAt)
    : formatInvoiceDate(new Date());    // fallback: today

  const roomRate = booking.bookingRate
    ?? (booking.nights > 0 ? Math.round(booking.totalAmount / booking.nights) : 0);

  const extraCharge        = booking.extraChargeAmount        ?? 0;
  const earlyDeduction     = booking.earlyDeductionAmount     ?? 0;
  const additionalDiscount = booking.additionalDiscountAmount ?? 0;

  // Estimated total = charges as currently recorded (may change at checkout)
  const estimatedTotal = booking.totalAmount + extraCharge - earlyDeduction - additionalDiscount;

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
            <p className="text-[13px] font-semibold text-slate-900">
              Room {booking.roomNumber} ({booking.roomCategory})
            </p>
            <p className="text-[11px] text-slate-600">
              {booking.checkInISO ? formatInvoiceDate(booking.checkInISO) : booking.checkIn}
              {" → "}
              {booking.checkOutISO ? formatInvoiceDate(booking.checkOutISO) : booking.checkOut}
            </p>
            <p className="text-[11px] text-slate-600">
              {booking.nights} {booking.nights === 1 ? "night" : "nights"}
            </p>
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

            {/* Room accommodation */}
            <tr className="border-b border-slate-100">
              <td className="py-3">
                <p className="font-medium text-slate-900">Room accommodation</p>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Room {booking.roomNumber} ({booking.roomCategory})
                  {" · "}{booking.nights} {booking.nights === 1 ? "night" : "nights"}
                  {" × "}{formatTaka(roomRate)}
                </p>
              </td>
              <td className="py-3 text-right text-slate-900 font-medium tabular-nums">
                {formatTaka(booking.totalAmount)}
              </td>
            </tr>

            {/* Extra charges */}
            {extraCharge > 0 && (
              <tr className="border-b border-slate-100">
                <td className="py-3">
                  <p className="font-medium text-slate-900">Extra charges</p>
                  {booking.extraChargeReason && (
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      {booking.extraChargeReason}
                    </p>
                  )}
                </td>
                <td className="py-3 text-right text-slate-900 font-medium tabular-nums">
                  {formatTaka(extraCharge)}
                </td>
              </tr>
            )}

            {/* Early checkout deduction */}
            {earlyDeduction > 0 && (
              <tr className="border-b border-slate-100">
                <td className="py-3">
                  <p className="font-medium text-emerald-700">
                    Early checkout deduction
                  </p>
                  {booking.earlyNightsDeducted && (
                    <p className="text-[11px] text-emerald-600 mt-0.5">
                      {booking.earlyNightsDeducted}{" "}
                      {booking.earlyNightsDeducted === 1 ? "night" : "nights"} deducted
                    </p>
                  )}
                </td>
                <td className="py-3 text-right text-emerald-700 font-medium tabular-nums">
                  −{formatTaka(earlyDeduction)}
                </td>
              </tr>
            )}

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
