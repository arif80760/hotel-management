// lib/sms.ts
//
// ─── SMS SENDING (SERVER-ONLY) ───────────────────────────────────────────────
//
// ⚠ Server-only: reads SMS_API_KEY / SMS_SENDER_ID from env (no NEXT_PUBLIC_
// prefix) — import ONLY from app/api/** route handlers.
//
// Provider adapter architecture: SmsProvider is the interface; AlphaSmsProvider
// is the concrete implementation for Alpha SMS (sms.bd), whose API shape was
// verified from their live docs on 2026-08-19:
//   POST https://api.sms.net.bd/sendsms
//   params: api_key (required), msg (required), to (required — 880… or 01X),
//           sender_id (optional, approved sender IDs only)
//   response: {"error": 0, "msg": "...", "data": {"request_id": N}}
//   error !== 0 ⇒ failure. request_id supports their delivery-report endpoint
//   (/report/request/{id}/) if delivery tracing is wanted later.
//
// TEMPLATE (BTRC regulatory constraint, 2026-08-19): SMS content must be at
// least 70% Bangla and include the brand name in every message. The body is
// Bangla script with "Hotel Albatross Resort" verbatim; booking ref, room
// count, dates and amounts stay in Latin digits / ISO-style dates inside the
// Bangla sentence (the same convention the assistant uses). Expected size:
// 2–3 Unicode segments — the segment count is logged to sms_log so cost
// stays visible.

import { HOTEL_INFO } from "@/lib/hotelInfo";

export interface SmsSendResult {
  ok: boolean;
  providerResponse: unknown;   // stored verbatim in sms_log.provider_response
}

export interface SmsProvider {
  /** Send one SMS. Never throws — network/provider failures return ok:false. */
  send(to: string, message: string): Promise<SmsSendResult>;
}

// ── Alpha SMS (sms.bd) ──────────────────────────────────────────────────────

export class AlphaSmsProvider implements SmsProvider {
  constructor(
    private apiKey: string,
    private senderId: string | null,
  ) {}

  async send(to: string, message: string): Promise<SmsSendResult> {
    try {
      const body = new URLSearchParams({ api_key: this.apiKey, to, msg: message });
      if (this.senderId) body.set("sender_id", this.senderId);
      const res = await fetch("https://api.sms.net.bd/sendsms", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json || typeof json.error !== "number") {
        return { ok: false, providerResponse: { http_status: res.status, body: json ?? "unparseable" } };
      }
      return { ok: json.error === 0, providerResponse: json };
    } catch (err) {
      return { ok: false, providerResponse: { transport_error: err instanceof Error ? err.message : String(err) } };
    }
  }
}

/** Provider from env — null when not configured (nothing sends until the
 *  keys exist; callers treat null as skip, never as failure). */
export function getSmsProvider(): SmsProvider | null {
  const apiKey = process.env.SMS_API_KEY;
  if (!apiKey) return null;
  return new AlphaSmsProvider(apiKey, process.env.SMS_SENDER_ID ?? null);
}

// ── Segments (Unicode / UCS-2: 70 chars single, 67 per concatenated part) ──

export function smsSegments(message: string): number {
  const len = [...message].length;
  return len <= 70 ? 1 : Math.ceil(len / 67);
}

// ── Phone normalisation (Alpha accepts 880… or standard 01X) ────────────────

export function normalizeBdPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (/^8801\d{9}$/.test(digits)) return digits;
  if (/^01\d{9}$/.test(digits))   return `880${digits.slice(1)}`;
  return null;
}

// ── Booking confirmation template (Bangla body, Latin figures) ─────────────

export function buildBookingConfirmationSms(b: {
  guestName: string;
  bookingRef: string;
  roomCount: number;
  checkIn: string;    // ISO date
  checkOut: string;   // ISO date
  total: number;
  paid: number;
}): string {
  const taka = (n: number) => Math.round(n).toLocaleString("en-US");
  return (
    `প্রিয় ${b.guestName}, Hotel Albatross Resort-এ আপনার বুকিং নিশ্চিত হয়েছে। ` +
    `বুকিং নং ${b.bookingRef}, রুম ${b.roomCount}টি, ${b.checkIn} থেকে ${b.checkOut}। ` +
    `মোট ৳${taka(b.total)}, জমা ৳${taka(b.paid)}। ` +
    `যোগাযোগ: ${HOTEL_INFO.phone}। ধন্যবাদ।`
  );
}
