// app/api/sms/booking-confirmation/route.ts
//
// ─── BOOKING CONFIRMATION SMS (SERVER-ONLY) ──────────────────────────────────
//
// POST { booking_ref: string }
//   → { status: "sent" | "failed" | "skipped", reason? }
//
// Called two ways, same behaviour:
//   1. Fire-and-forget from HotelContext.createBooking AFTER the booking is
//      created — the client never awaits this, so an SMS failure can never
//      fail or delay a booking.
//   2. The manual "Resend SMS" action on the booking row.
//
// Guards (in order): auth (any signed-in profile — staff create bookings);
// env keys (nothing sends until SMS_API_KEY exists — creation-path calls
// return silently, manual resends get a logged 'skipped' so the desk sees
// why); booking exists; zero-guest/test bookings skipped; phone must
// normalise to a BD number. Every real attempt (and every explicit-resend
// skip) is logged to sms_log with the provider's raw response + segment
// count; sms_log writes go through the service-role client (RLS allows no
// authenticated INSERT).

import { NextRequest, NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabaseAdmin";
import {
  getSmsProvider,
  buildBookingConfirmationSms,
  smsSegments,
  normalizeBdPhone,
} from "@/lib/sms";

export const maxDuration = 30;

function embedded<T>(v: T | T[] | null | undefined): T | null {
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export async function POST(req: NextRequest) {
  try {
    // ── Auth: any signed-in profile ──
    const adminClient = getAdminClient();
    const authHeader = req.headers.get("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const { data: { user }, error: jwtError } = await adminClient.auth.getUser(token);
    if (jwtError || !user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const { data: profile } = await adminClient.from("profiles").select("role").eq("id", user.id).single();
    if (!profile) return NextResponse.json({ error: "Forbidden — no profile." }, { status: 403 });

    const body = await req.json().catch(() => null);
    const bookingRef = typeof body?.booking_ref === "string" ? body.booking_ref.trim() : "";
    const isResend = body?.resend === true;
    if (!/^BK-\d+$/.test(bookingRef)) {
      return NextResponse.json({ error: "Provide booking_ref (BK-XXXX)." }, { status: 400 });
    }

    // ── Booking + guest + room count ──
    const { data: bk, error: bkErr } = await adminClient
      .from("bookings")
      .select("id, booking_ref, total_guests, total_amount, extra_charge_amount, additional_discount_amount, paid_amount, check_in_date, check_out_date, status, guests!primary_guest_id(name, phone)")
      .eq("booking_ref", bookingRef)
      .single();
    if (bkErr || !bk) return NextResponse.json({ error: `Booking ${bookingRef} not found.` }, { status: 404 });

    const { count: roomCount } = await adminClient
      .from("booking_rooms")
      .select("id", { count: "exact", head: true })
      .eq("booking_id", bk.id)
      .neq("status", "cancelled");

    const guest = embedded(bk.guests as { name: string; phone: string } | { name: string; phone: string }[] | null);

    const log = async (status: "sent" | "failed" | "skipped", phone: string, message: string, providerResponse: unknown) => {
      const { error } = await adminClient.from("sms_log").insert({
        booking_id: bk.id,
        phone,
        message,
        segments: message ? smsSegments(message) : 1,
        status,
        provider_response: providerResponse ?? null,
      });
      if (error) console.error("[sms] sms_log insert failed:", error.message);
    };

    // ── Skip guards ──
    const provider = getSmsProvider();
    if (!provider) {
      // Nothing sends until env keys exist. Manual resends leave a trace.
      if (isResend) await log("skipped", guest?.phone ?? "—", "", { reason: "not_configured — SMS_API_KEY missing" });
      return NextResponse.json({ status: "skipped", reason: "not_configured" });
    }
    if ((bk.total_guests ?? 0) === 0) {
      return NextResponse.json({ status: "skipped", reason: "zero_guest_booking" });
    }
    const phone = guest?.phone ? normalizeBdPhone(guest.phone) : null;
    if (!phone) {
      await log("skipped", guest?.phone ?? "—", "", { reason: "invalid_or_missing_phone" });
      return NextResponse.json({ status: "skipped", reason: "invalid_phone" });
    }

    // ── Compose + send + log ──
    const effTotal = (bk.total_amount ?? 0) + (bk.extra_charge_amount ?? 0) - (bk.additional_discount_amount ?? 0);
    const message = buildBookingConfirmationSms({
      guestName: guest?.name ?? "Guest",
      bookingRef: bk.booking_ref,
      roomCount: roomCount ?? 1,
      checkIn: bk.check_in_date,
      checkOut: bk.check_out_date,
      total: effTotal,
      paid: bk.paid_amount ?? 0,
    });

    const result = await provider.send(phone, message);
    await log(result.ok ? "sent" : "failed", phone, message, result.providerResponse);

    return NextResponse.json({ status: result.ok ? "sent" : "failed" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[sms] route error:", message);
    return NextResponse.json({ error: `SMS route failed: ${message}` }, { status: 500 });
  }
}
