// components/invoice/LetterHead.tsx
//
// Hotel branding header. Three-column layout:
//   logo | name + address (flex-1) | contact right-aligned
//
// Heavy border-b-2 border-slate-800 anchors it as the
// document's top separator. Used by invoice and reservation-details.

import Image from "next/image";
import { HOTEL_INFO } from "@/lib/hotelInfo";

export default function LetterHead() {
  return (
    <div className="flex items-center justify-between gap-6 pb-4 border-b-2 border-slate-800">

      {/* Logo */}
      <div className="relative w-20 h-20 flex-shrink-0">
        <Image
          src={HOTEL_INFO.logoPath}
          alt={`${HOTEL_INFO.name} logo`}
          fill
          className="object-contain"
          priority
        />
      </div>

      {/* Hotel name + address — center column */}
      <div className="flex-1">
        <h1 className="text-xl font-bold text-slate-900 leading-tight">
          {HOTEL_INFO.name}
        </h1>
        <p className="text-[11px] text-slate-600 mt-1 leading-tight">
          {HOTEL_INFO.address}
        </p>
      </div>

      {/* Contact — right-aligned */}
      <div className="text-right text-[11px] text-slate-600 space-y-0.5">
        <p>{HOTEL_INFO.phone}</p>
        <p>{HOTEL_INFO.email}</p>
        <p>{HOTEL_INFO.website}</p>
      </div>

    </div>
  );
}
