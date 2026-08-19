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
// TEMPLATE (retuned 2026-08-19 after provider billing confirmed): Alpha bills
// 180 chars/unit at Tk0.64 for GSM text. The template is English, GSM-safe
// only ("Tk", never ৳), tuned to fit ONE unit for typical bookings. The name
// field is GUARDED — non-GSM characters (Bangla script, emoji, exotic
// diacritics) are stripped/transliterated with a "Guest" fallback, because a
// single Unicode character would flip the whole message to UCS-2 and
// multiply the unit count. sms_log.segments stores UNITS by the 180-char
// rule so the log matches Alpha's billing exactly.
// (Supersedes the earlier Bangla-script template; the BTRC-ratio question is
// resolved by Arif in favour of billing reality — see befbc93's message.)

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

// ── Billing units — Alpha's confirmed rule: 180 chars per unit (Tk0.64) ──

export function smsUnits(message: string): number {
  const len = [...message].length;
  return Math.max(1, Math.ceil(len / 180));
}

// ── Phone normalisation (Alpha accepts 880… or standard 01X) ────────────────

export function normalizeBdPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (/^8801\d{9}$/.test(digits)) return digits;
  if (/^01\d{9}$/.test(digits))   return `880${digits.slice(1)}`;
  return null;
}

// ── Name guard: keep the message GSM-7 ──────────────────────────────────────
// One non-GSM char (Bangla script, emoji) flips the WHOLE message to UCS-2
// and multiplies the unit count. Strip diacritics (transliterate é→e etc.),
// then keep a conservative GSM-safe ASCII subset; empty result → "Guest".

export function gsmSafeName(raw: string): string {
  const cleaned = raw
    .normalize("NFD").replace(/[̀-ͯ]/g, "")   // é → e, ñ → n …
    .replace(/[^A-Za-z0-9 .'\-]/g, "")                  // drop everything non-GSM-safe
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length >= 2 ? cleaned.slice(0, 30) : "Guest";
}

// ── Booking confirmation template (English, GSM-safe, 1 unit typical) ──────

function ddMmm(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  const day = String(d.getDate()).padStart(2, "0");
  const mmm = d.toLocaleDateString("en-GB", { month: "short" }).slice(0, 3); // en-GB says "Sept" — force 3 chars
  return `${day} ${mmm}`;
}

export function buildBookingConfirmationSms(b: {
  guestName: string;
  bookingRef: string;
  roomNumbers: string[];   // non-cancelled booking_rooms, comma-joined
  checkIn: string;         // ISO date
  checkOut: string;        // ISO date
  total: number;
  paid: number;
}): string {
  const taka = (n: number) => Math.round(n).toLocaleString("en-US");
  // Local 01X form of the hotel phone (+8801XXXXXXXXX → 01XXXXXXXXX).
  const phone = HOTEL_INFO.phone.replace(/\D/g, "").replace(/^880/, "0");
  return (
    `${gsmSafeName(b.guestName)}, your booking at Hotel Albatross Resort is confirmed. ` +
    `Ref: ${b.bookingRef} Room: ${b.roomNumbers.join(",")} ` +
    `In: ${ddMmm(b.checkIn)} Out: ${ddMmm(b.checkOut)} ` +
    `Total Tk${taka(b.total)} Paid Tk${taka(b.paid)}. Call ${phone}`
  );
}
