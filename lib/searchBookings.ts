// lib/searchBookings.ts
//
// ─── IDENTIFIER-AWARE BOOKING SEARCH (client-safe, shared) ──────────────────
//
// One classification + matching helper so every surface that searches
// bookings behaves identically — divergent search behaviour between surfaces
// is its own bug class. Adopted by the Bookings list (2026-08-25); Front
// Desk / Dues search boxes should use THIS module if/when they gain search.
//
// RULES (2026-08-25):
//   • ref / phone queries are EXACT-IDENTIFIER searches — they override any
//     active date-range filter (the caller skips its date predicate).
//   • text queries respect the caller's date filter as before.
//   • A query matching both a ref and a phone prefix ranks ref matches
//     first (rankIdentifierMatches). Structurally near-disjoint anyway:
//     refs never lead with 0, BD phones always do.
//
// Phone normalisation mirrors normalizeBdPhone (lib/sms.ts) — mirrored, not
// imported: sms.ts is server-only by convention. Both sides canonicalise to
// the local 01… form (880 prefix folded) and prefix-match, so partial
// numbers work while typing.

export type BookingSearchClass =
  | { kind: "ref";   refDigits: string }
  | { kind: "phone"; phone01: string }
  | { kind: "text";  q: string };

/** Strip formatting characters people paste into phone/ref searches. */
function digitsOf(raw: string): string {
  return raw.replace(/[\s\-+().]/g, "");
}

/** Canonicalise a digit string to the local 01… form (8801… → 01…). */
function toLocal01(digits: string): string {
  return digits.startsWith("880") ? `0${digits.slice(3)}` : digits;
}

export function classifyBookingSearch(raw: string): BookingSearchClass {
  const q = raw.trim();
  const bk = q.match(/^bk[-\s]?(\d{1,6})$/i);
  if (bk) return { kind: "ref", refDigits: bk[1] };

  const d = digitsOf(q);
  if (/^\d+$/.test(d) && d === q.replace(/[\s\-+().]/g, "")) {
    // Bare digits: BD phone shapes (01…, 8801…, 880…) → phone; else ref.
    if (/^(?:8801?|01)\d*$/.test(d) && d.length >= 2 && (d.startsWith("0") || d.startsWith("880"))) {
      return { kind: "phone", phone01: toLocal01(d) };
    }
    if (/^\d{1,6}$/.test(d)) return { kind: "ref", refDigits: d };
  }
  return { kind: "text", q: q.toLowerCase() };
}

export interface SearchableBooking {
  id:        string;          // "BK-1425"
  guestName: string;
  phone?:    string | null;
}

/** Does this booking match an identifier (ref/phone) classification? */
export function matchesIdentifier(b: SearchableBooking, cls: BookingSearchClass): boolean {
  if (cls.kind === "ref") {
    const refDigits = b.id.replace(/\D/g, "");
    // Prefix match so progressive typing narrows; exact naturally included.
    if (refDigits.startsWith(cls.refDigits)) return true;
    // Bare digits can ALSO be a phone fragment mid-number? No — identifier
    // searches are prefix-anchored by design; ranking handles overlap.
    return toLocal01(digitsOf(b.phone ?? "")).startsWith(cls.refDigits);
  }
  if (cls.kind === "phone") {
    return toLocal01(digitsOf(b.phone ?? "")).startsWith(cls.phone01);
  }
  return false;
}

/** Text match — the pre-existing fuzzy behaviour, centralised. */
export function matchesText(b: SearchableBooking, q: string): boolean {
  return (
    b.id.toLowerCase().includes(q) ||
    b.guestName.toLowerCase().includes(q) ||
    (b.phone ?? "").toLowerCase().includes(q)
  );
}

/** Decision (a): when a bare number matches both refs and phones, refs first. */
export function rankIdentifierMatches<T extends SearchableBooking>(
  matches: T[],
  cls: BookingSearchClass,
): T[] {
  if (cls.kind !== "ref") return matches;
  const isRefHit = (b: T) => b.id.replace(/\D/g, "").startsWith(cls.refDigits);
  return [...matches].sort((a, b) => Number(isRefHit(b)) - Number(isRefHit(a)));
}
