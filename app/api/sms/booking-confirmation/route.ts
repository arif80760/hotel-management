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
  smsUnits,
  smsWithinLimit,
  SMS_MAX_CHARS,
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

    const { data: brRows } = await adminClient
      .from("booking_rooms")
      .select("rooms(room_number)")
      .eq("booking_id", bk.id)
      .neq("status", "cancelled");
    const roomNumbers = (brRows ?? [])
      .map((r) => embedded(r.rooms as { room_number: string } | { room_number: string }[] | null)?.room_number)
      .filter((n): n is string => !!n)
      .sort((a, b) => Number(a) - Number(b));

    const guest = embedded(bk.guests as { name: string; phone: string } | { name: string; phone: string }[] | null);

    // Every log outcome is returned to the caller (log_id / log_error) so a
    // failed insert is VISIBLE in the response, not just in server logs —
    // added 2026-08-19 after a confirmed-delivered resend left no row.
    const log = async (
      status: "sent" | "failed" | "skipped",
      phone: string,
      message: string,
      providerResponse: unknown,
    ): Promise<{ log_id?: string; log_error?: string }> => {
      const { data, error } = await adminClient.from("sms_log").insert({
        booking_id: bk.id,
        phone,
        message,
        // Alpha's confirmed billing rule: 180 chars/unit — the log matches billing.
        segments: message ? smsUnits(message) : 1,
        status,
        provider_response: providerResponse ?? null,
      }).select("id").single();
      if (error) {
        // House convention: log every PostgrestError field individually.
        console.error("[sms] sms_log insert FAILED:",
          "message:", error.message, "| details:", error.details,
          "| hint:", error.hint, "| code:", error.code);
        return { log_error: error.message || `insert failed (code ${error.code})` };
      }
      return { log_id: data.id as string };
    };

    // ── Skip guards ──
    const provider = getSmsProvider();
    if (!provider) {
      // Nothing sends until env keys exist. Manual resends leave a trace.
      const l = isResend ? await log("skipped", guest?.phone ?? "-", "", { reason: "not_configured — SMS_API_KEY missing" }) : {};
      return NextResponse.json({ status: "skipped", reason: "not_configured", ...l });
    }
    if ((bk.total_guests ?? 0) === 0) {
      // Manual resends log every skip — the desk must see why nothing sent.
      const l = isResend ? await log("skipped", guest?.phone ?? "-", "", { reason: "zero_guest_booking" }) : {};
      return NextResponse.json({ status: "skipped", reason: "zero_guest_booking", ...l });
    }
    const phone = guest?.phone ? normalizeBdPhone(guest.phone) : null;
    if (!phone) {
      const l = await log("skipped", guest?.phone ?? "-", "", { reason: "invalid_or_missing_phone" });
      return NextResponse.json({ status: "skipped", reason: "invalid_phone", ...l });
    }

    // ── Compose + send + log ──
    // Canonical true due — same columns/formula as the booking detail page:
    // total + extra_charge − additional_discount − paid (early deduction is
    // already inside total_amount; never subtracted again).
    const effTotal = (bk.total_amount ?? 0) + (bk.extra_charge_amount ?? 0) - (bk.additional_discount_amount ?? 0);
    const paid = bk.paid_amount ?? 0;
    const message = buildBookingConfirmationSms({
      guestName: guest?.name ?? "Guest",
      bookingRef: bk.booking_ref,
      roomNumbers: roomNumbers.length ? roomNumbers : ["-"],   // ASCII hyphen — GSM-safe
      checkIn: bk.check_in_date,
      checkOut: bk.check_out_date,
      total: effTotal,
      paid,
      due: effTotal - paid,
    });

    // Hard one-unit ceiling: never send >180 chars (Alpha bills per 180).
    if (!smsWithinLimit(message)) {
      const l = await log("skipped", phone, message, {
        reason: `message_over_${SMS_MAX_CHARS}_chars`,
        length: [...message].length,
      });
      return NextResponse.json({ status: "skipped", reason: "message_too_long", ...l });
    }

    const result = await provider.send(phone, message);
    const l = await log(result.ok ? "sent" : "failed", phone, message, result.providerResponse);

    return NextResponse.json({ status: result.ok ? "sent" : "failed", ...l });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[sms] route error:", message);
    return NextResponse.json({ error: `SMS route failed: ${message}` }, { status: 500 });
  }
}
