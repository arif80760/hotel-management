// app/bookings/[id]/invoice-compact/page.tsx
//
// Compact A4 invoice for a single booking.
// [id] = booking_ref, e.g. "BK-1037"
//
// A denser, one-page alternative to the full invoice route. Shows the SAME
// real data (room line items, extras, discount, real payments) — just a
// lighter, tighter layout. Payment detail is summarised into a totals box
// (Total Due / Paid / Balance) instead of full payment-history + refunds
// tables, so the whole document fits comfortably on one page.
//
// Server component. Same auth gate, fetches, category-name resolution,
// LetterHead, PrintButtons and @page A4 print setup as the full invoice.

import { notFound, redirect }            from "next/navigation";
import { createSupabaseServerClient }    from "@/lib/supabaseServer";
import { getBookingByRef,
         getPaymentsByBookingRef }        from "@/services/bookingsService";
import { getRoomCategories }              from "@/services/roomCategoriesService";
import { buildCategoryNameMap,
         displayCategory }                from "@/lib/categoryNames";
import LetterHead                        from "@/components/invoice/LetterHead";
import PrintButtons                      from "@/components/invoice/PrintButtons";
import { calcTrueDue,
         formatInvoiceNumber,
         formatInvoiceDate,
         formatTaka }                    from "@/lib/invoiceUtils";
import { HOTEL_INFO }                    from "@/lib/hotelInfo";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function CompactInvoicePage({ params }: Props) {
  const { id } = await params;

  const serverClient = await createSupabaseServerClient();
  const { data: { user } } = await serverClient.auth.getUser();
  if (!user) redirect("/login");

  const [booking, payments] = await Promise.all([
    getBookingByRef(id, serverClient).catch(() => null),
    getPaymentsByBookingRef(id, serverClient).catch(() => []),
  ]);

  if (!booking) notFound();

  // Resolve category slugs to their CURRENT names.
  const categories = await getRoomCategories(serverClient);
  const nameMap    = buildCategoryNameMap(categories);

  const invoiceNumber = formatInvoiceNumber(booking);

  const issuedDateISO = booking.actualCheckoutDate ?? booking.checkOutISO;
  const issuedDate    = issuedDateISO ? formatInvoiceDate(issuedDateISO) : booking.checkOut;

  // Non-cancelled rooms only — cancelled rooms contribute 0 to the bill.
  const sortedRooms = [...booking.rooms]
    .filter(r => r.status !== "Cancelled")
    .sort((a, b) => {
      const na = parseInt(a.roomNumber, 10);
      const nb = parseInt(b.roomNumber, 10);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a.roomNumber.localeCompare(b.roomNumber);
    });

  const sortedExtras = [...booking.extraCharges].sort((a, b) => {
    const ta = a.appliedAt ? new Date(a.appliedAt).getTime() : 0;
    const tb = b.appliedAt ? new Date(b.appliedAt).getTime() : 0;
    return ta - tb;
  });
  const totalExtraCharges  = sortedExtras.reduce((sum, c) => sum + c.amount, 0);
  const additionalDiscount = booking.additionalDiscountAmount ?? 0;

  // grossBill = total owed for the stay, before payments
  const grossBill   = booking.totalAmount + totalExtraCharges - additionalDiscount;
  // amountPaid is net of refund disbursements (refunds post as negative payments),
  // so totalPaid and outstanding are already refund-adjusted.
  const totalPaid   = payments.reduce((sum, p) => sum + p.amount, 0);
  const outstanding = calcTrueDue(booking);

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
        className="max-w-[210mm] mx-auto bg-white p-8 print:p-0 shadow-sm print:shadow-none"
      >
        {/* Letterhead */}
        <LetterHead />

        {/* Title + metadata — single compact row */}
        <div className="flex justify-between items-end py-4">
          <h2 className="text-2xl font-bold tracking-wide text-slate-900">INVOICE</h2>
          <div className="text-right text-[11px] leading-relaxed">
            <p>
              <span className="text-slate-500 uppercase tracking-wide font-semibold">Invoice No </span>
              <span className="text-slate-900 font-semibold">#{invoiceNumber}</span>
            </p>
            <p>
              <span className="text-slate-500 uppercase tracking-wide font-semibold">Issue Date </span>
              <span className="text-slate-900 font-semibold">{issuedDate}</span>
            </p>
            <p>
              <span className="text-slate-500 uppercase tracking-wide font-semibold">Status </span>
              <span className="text-slate-900 font-semibold">{booking.status}</span>
            </p>
          </div>
        </div>

        {/* Bill To + Stay Details — compact two-column */}
        <div className="grid grid-cols-2 gap-8 py-3 border-y border-slate-200 text-[11px]">
          <div>
            <p className="uppercase tracking-wide text-slate-500 font-semibold mb-1">Bill To</p>
            <p className="text-[12.5px] font-semibold text-slate-900">{booking.guestName}</p>
            <p className="text-slate-600">{booking.phone}</p>
            {booking.email && <p className="text-slate-600">{booking.email}</p>}
          </div>
          <div>
            <p className="uppercase tracking-wide text-slate-500 font-semibold mb-1">Stay</p>
            {sortedRooms.map(room => {
              const roomCheckoutISO = room.actualCheckoutDate ?? room.checkOutISO;
              return (
                <p key={room.id} className="text-slate-700">
                  Room {room.roomNumber} ({displayCategory(room.roomCategory, nameMap)})
                  {" · "}
                  {room.checkInISO ? formatInvoiceDate(room.checkInISO) : room.checkIn}
                  {" → "}
                  {roomCheckoutISO ? formatInvoiceDate(roomCheckoutISO) : room.checkOut}
                  {" · "}{room.nights} {room.nights === 1 ? "night" : "nights"}
                </p>
              );
            })}
          </div>
        </div>

        {/* ── Charges table — compact ──────────────────────────────────────── */}
        <table className="w-full text-[12px] mt-4">
          <thead>
            <tr className="border-b border-slate-300">
              <th className="text-left py-1.5 uppercase tracking-wide text-[10px] font-semibold text-slate-600">
                Description
              </th>
              <th className="text-right py-1.5 uppercase tracking-wide text-[10px] font-semibold text-slate-600 w-28">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedRooms.map(room => {
              const roomSubtotal = room.bookingRate * room.nights;
              return (
                <tr key={room.id} className="border-b border-slate-100">
                  <td className="py-2 text-slate-900">
                    Room {room.roomNumber} ({displayCategory(room.roomCategory, nameMap)})
                    <span className="text-slate-500">
                      {" · "}{room.nights} × {formatTaka(room.bookingRate)}
                    </span>
                  </td>
                  <td className="py-2 text-right font-medium tabular-nums text-slate-900">
                    {formatTaka(roomSubtotal)}
                  </td>
                </tr>
              );
            })}

            {sortedExtras.map(charge => (
              <tr key={charge.id} className="border-b border-slate-100">
                <td className="py-2 text-slate-900">{charge.reason?.trim() || "Extra charge"}</td>
                <td className="py-2 text-right font-medium tabular-nums text-slate-900">
                  {formatTaka(charge.amount)}
                </td>
              </tr>
            ))}

            {additionalDiscount > 0 && (
              <tr className="border-b border-slate-100">
                <td className="py-2 text-emerald-700">
                  Discount
                  {booking.additionalDiscountReason && (
                    <span className="text-emerald-600"> · {booking.additionalDiscountReason}</span>
                  )}
                </td>
                <td className="py-2 text-right font-medium tabular-nums text-emerald-700">
                  −{formatTaka(additionalDiscount)}
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {/* ── Totals box — right-aligned compact summary ───────────────────── */}
        <div className="flex justify-end mt-4">
          <div className="w-64 text-[12px]">
            <div className="flex justify-between py-1.5 border-b border-slate-100">
              <span className="text-slate-500">Total Due</span>
              <span className="font-semibold text-slate-900 tabular-nums">{formatTaka(grossBill)}</span>
            </div>
            <div className="flex justify-between py-1.5 border-b border-slate-100">
              <span className="text-slate-500">Paid</span>
              <span className="font-medium text-slate-700 tabular-nums">{formatTaka(totalPaid)}</span>
            </div>
            {outstanding > 0 ? (
              <div className="flex justify-between items-center mt-2 px-3 py-2 bg-rose-50 border border-rose-200 rounded-md">
                <span className="text-[10px] uppercase tracking-wider font-bold text-rose-900">Balance Due</span>
                <span className="text-[15px] font-bold text-rose-700 tabular-nums">{formatTaka(outstanding)}</span>
              </div>
            ) : totalPaid > 0 ? (
              <div className="flex justify-between items-center mt-2 px-3 py-2 bg-emerald-50 border border-emerald-300 rounded-md">
                <span className="text-[10px] uppercase tracking-wider font-bold text-emerald-900">Paid in Full</span>
                <span className="text-[15px] font-bold text-emerald-700">✓</span>
              </div>
            ) : null}
          </div>
        </div>

        {/* ── Footer ───────────────────────────────────────────────────────── */}
        <div className="mt-8 pt-4 border-t border-slate-300 text-center space-y-1">
          <p className="text-[12px] font-semibold text-slate-900">{HOTEL_INFO.footerText}</p>
          <p className="text-[10px] text-slate-500">{HOTEL_INFO.name} · {HOTEL_INFO.address}</p>
          <p className="text-[10px] text-slate-400">Generated on {generatedOn}</p>
        </div>

      </div>
    </div>
  );
}
