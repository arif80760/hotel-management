// app/api/assistant/tools.ts
//
// ─── ASSISTANT QUERY TOOLS (SERVER-ONLY) ─────────────────────────────────────
//
// Fixed set of read-only query tools for the AI assistant. The model NEVER
// writes SQL and NEVER reads a table directly — it can only call these
// functions, each of which has the business rules from CLAUDE.md encoded.
// Executed with the service-role client; the ROUTE is responsible for the
// auth gate before any tool runs (see route.ts).
//
// Step 1 (2026-08-17, design approved by Arif): the two STAFF-SAFE tools —
// check_room_availability and get_day_sheet. Financial tools (admin-only)
// come in a later step and must carry their own rules (remuneration/
// adjustment kinds, refund netting, soft-deletes, central fund).
//
// Business rules encoded here:
//   • Availability overlap mirrors create_booking_with_rooms' guard EXACTLY:
//     blocking statuses ('confirmed','checked_in'), half-open [) ranges,
//     COALESCE(actual_checkout_date, check_out_date) so early departures
//     free the room and same-day turnover is allowed.
//   • Deactivated rooms (is_active = false) are excluded everywhere.
//   • Occupancy is derived from booking_rooms, NEVER rooms.status (the
//     physical column lags booking state — known unreliable).
//   • booking-level truth is booking_rooms, not bookings.room_id (legacy).
//   • "Check-ins today" is ambiguous — the day sheet reports arrivals DUE
//     (check_in_date = date, still confirmed) and ACTUALLY checked in today
//     (checked_in_at within the Dhaka day) as separate labelled lists.
//   • True due = total + extra_charge − additional_discount − paid.
//     early_deduction is already inside total via update_booking_total —
//     never subtracted again.
//   • All dates are Asia/Dhaka wall-clock YYYY-MM-DD strings (the server
//     runs UTC on Vercel — never trust its local "today").
//   • Category identity is the slug; names are user-renameable, so name
//     input from the model is resolved against the live room_categories
//     table, never hardcoded.
//
// Every tool returns { figures..., meta } — meta echoes the resolved
// period/filters/exclusions so the UI can render a receipt the user can
// sanity-check (design §6).
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date in Asia/Dhaka as YYYY-MM-DD (en-CA gives ISO order). */
export function dhakaTodayISO(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dhaka",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function assertISODate(value: unknown, name: string): string {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) {
    throw new Error(`${name} must be an ISO date (YYYY-MM-DD); got: ${String(value)}`);
  }
  return value;
}

/** Blocking statuses — mirror of the DB overlap guard. Whitelist: any future
 *  status defaults to non-blocking, matching the server. */
const BLOCKING_STATUSES = ["confirmed", "checked_in"] as const;

// ─── Tool schemas (sent to the model; strict) ────────────────────────────────

export const TOOL_SCHEMAS = [
  {
    name: "check_room_availability",
    description:
      "Which rooms are free between two dates. Call for ANY question about availability, free/khali rooms, or whether a booking fits given dates. Dhaka-local ISO dates; check_out is the departure day (must be after check_in). Optional category filter — pass the name as said; it's matched against the live category list.",
    strict: true,
    input_schema: {
      type: "object" as const,
      properties: {
        check_in:  { type: "string", description: "Check-in date, YYYY-MM-DD" },
        check_out: { type: "string", description: "Check-out date, YYYY-MM-DD (exclusive — departure day)" },
        category:  { type: ["string", "null"], description: "Optional category name or slug to filter by; null for all categories" },
      },
      required: ["check_in", "check_out", "category"],
      additionalProperties: false,
    },
  },
  {
    name: "get_day_sheet",
    description:
      "Front-desk day sheet for one Dhaka-local date: arrivals due vs actually checked in, departures due vs checked out, in-house guests with rooms and outstanding dues, overdue checkouts, occupancy. Call for check-ins/check-outs, who is in the hotel, occupancy, or in-house dues.",
    strict: true,
    input_schema: {
      type: "object" as const,
      properties: {
        date: { type: "string", description: "The day to report, YYYY-MM-DD (Asia/Dhaka). Use today's date for 'today'." },
      },
      required: ["date"],
      additionalProperties: false,
    },
  },
];

// ─── Row shapes (only the columns we select) ─────────────────────────────────

type RoomRow = { id: string; room_number: string; category: string };
type CategoryRow = { slug: string; name: string; price: number };
type BookingEmbed = {
  booking_ref: string;
  status: string;
  total_amount: number | null;
  paid_amount: number | null;
  extra_charge_amount: number | null;
  additional_discount_amount: number | null;
  guests: { name: string }[] | { name: string } | null;
};
type BookingRoomRow = {
  id: string;
  booking_id: string;
  room_id: string;
  check_in_date: string;
  check_out_date: string;
  actual_checkout_date: string | null;
  status: string;
  checked_in_at: string | null;
  checked_out_at: string | null;
  bookings: BookingEmbed[] | BookingEmbed | null;
};

/** Supabase embeds may arrive as array or object — normalise (CLAUDE.md rule). */
function one<T>(v: T[] | T | null): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

function guestName(b: BookingEmbed | null): string {
  const g = b ? one(b.guests as { name: string }[] | { name: string } | null) : null;
  return g?.name ?? "—";
}

/** True due — early_deduction deliberately NOT subtracted (inside total). */
function trueDue(b: BookingEmbed | null): number {
  if (!b) return 0;
  return (b.total_amount ?? 0)
       + (b.extra_charge_amount ?? 0)
       - (b.additional_discount_amount ?? 0)
       - (b.paid_amount ?? 0);
}

// ─── check_room_availability ─────────────────────────────────────────────────

export async function checkRoomAvailability(
  db: SupabaseClient,
  input: { check_in: string; check_out: string; category: string | null },
) {
  const checkIn  = assertISODate(input.check_in, "check_in");
  const checkOut = assertISODate(input.check_out, "check_out");
  if (checkOut <= checkIn) {
    throw new Error(`check_out (${checkOut}) must be after check_in (${checkIn}).`);
  }

  const [{ data: cats, error: catErr }, { data: rooms, error: roomErr }] = await Promise.all([
    db.from("room_categories").select("slug, name, price").eq("is_active", true).order("sort_order"),
    db.from("rooms").select("id, room_number, category").eq("is_active", true),
  ]);
  if (catErr)  throw new Error(`room_categories read failed: ${catErr.message}`);
  if (roomErr) throw new Error(`rooms read failed: ${roomErr.message}`);

  // Resolve the caller's category phrasing against the LIVE table (names are
  // user-renameable; slugs are stable). No match → error listing valid options.
  let filterSlug: string | null = null;
  if (input.category && input.category.trim() !== "") {
    const q = input.category.trim().toLowerCase();
    const match = (cats ?? []).find(
      (c) => c.slug.toLowerCase() === q || c.name.toLowerCase() === q,
    ) ?? (cats ?? []).find(
      (c) => c.name.toLowerCase().includes(q) || q.includes(c.name.toLowerCase()),
    );
    if (!match) {
      throw new Error(
        `Unknown room category "${input.category}". Active categories: ` +
        (cats ?? []).map((c) => c.name).join(", "),
      );
    }
    filterSlug = match.slug;
  }

  // Blocking rows — the exact guard expression: status IN (confirmed, checked_in)
  // AND check_in_date < :check_out AND COALESCE(actual_checkout_date, check_out_date) > :check_in.
  // (Dates are regex-validated above, so interpolation into .or() is safe.)
  const { data: blocking, error: blockErr } = await db
    .from("booking_rooms")
    .select("room_id, check_in_date, check_out_date, actual_checkout_date, status")
    .in("status", [...BLOCKING_STATUSES])
    .lt("check_in_date", checkOut)
    .or(`actual_checkout_date.gt.${checkIn},and(actual_checkout_date.is.null,check_out_date.gt.${checkIn})`);
  if (blockErr) throw new Error(`booking_rooms read failed: ${blockErr.message}`);

  const blockedRoomIds = new Set((blocking ?? []).map((r) => r.room_id));

  const catList = (cats ?? [])
    .filter((c: CategoryRow) => !filterSlug || c.slug === filterSlug)
    .map((c: CategoryRow) => {
      const catRooms = (rooms ?? []).filter((r: RoomRow) => r.category === c.slug);
      const free = catRooms.filter((r) => !blockedRoomIds.has(r.id));
      return {
        category: c.name,
        price_per_night: c.price,
        total_active_rooms: catRooms.length,
        blocked: catRooms.length - free.length,
        free: free.length,
        free_room_numbers: free.map((r) => r.room_number).sort(),
      };
    });

  return {
    categories: catList,
    total_free: catList.reduce((s, c) => s + c.free, 0),
    meta: {
      stay: `${checkIn} to ${checkOut} (${filterSlug ? `category: ${catList[0]?.category ?? filterSlug}` : "all categories"})`,
      rules_applied: [
        "blocking statuses: confirmed, checked_in only (cancelled/no-show never block)",
        "early departures free the room from their actual checkout date",
        "same-day turnover allowed (checkout day = new check-in day)",
        "deactivated rooms excluded",
      ],
      timezone: "Asia/Dhaka",
    },
  };
}

// ─── get_day_sheet ───────────────────────────────────────────────────────────

const BOOKING_EMBED =
  "bookings(booking_ref, status, total_amount, paid_amount, extra_charge_amount, additional_discount_amount, guests(name))";

export async function getDaySheet(
  db: SupabaseClient,
  input: { date: string },
) {
  const date = assertISODate(input.date, "date");
  // Dhaka day boundaries as timestamptz instants (server runs UTC).
  const dayStart = `${date}T00:00:00+06:00`;
  const dayEnd   = `${date}T24:00:00+06:00`;

  const roomSelect =
    `id, booking_id, room_id, check_in_date, check_out_date, actual_checkout_date, status, checked_in_at, checked_out_at, ${BOOKING_EMBED}`;

  const [arrivalsDueQ, checkedInTodayQ, departuresDueQ, checkedOutTodayQ, inHouseQ, roomsQ] =
    await Promise.all([
      db.from("booking_rooms").select(roomSelect).eq("status", "confirmed").eq("check_in_date", date),
      db.from("booking_rooms").select(roomSelect).gte("checked_in_at", dayStart).lt("checked_in_at", dayEnd),
      db.from("booking_rooms").select(roomSelect).eq("status", "checked_in").eq("check_out_date", date),
      db.from("booking_rooms").select(roomSelect).gte("checked_out_at", dayStart).lt("checked_out_at", dayEnd)
        .in("status", ["checked_out", "checked_out_early"]),
      db.from("booking_rooms").select(roomSelect).eq("status", "checked_in"),
      db.from("rooms").select("id, room_number, category").eq("is_active", true),
    ]);

  for (const [label, q] of [
    ["arrivals", arrivalsDueQ], ["checked-in-today", checkedInTodayQ],
    ["departures", departuresDueQ], ["checked-out-today", checkedOutTodayQ],
    ["in-house", inHouseQ], ["rooms", roomsQ],
  ] as const) {
    if (q.error) throw new Error(`${label} read failed: ${q.error.message}`);
  }

  const rooms = (roomsQ.data ?? []) as RoomRow[];
  const roomNumber = new Map(rooms.map((r) => [r.id, r.room_number]));

  const line = (r: BookingRoomRow) => {
    const b = one(r.bookings);
    return {
      booking_ref: b?.booking_ref ?? "—",
      guest: guestName(b),
      room: roomNumber.get(r.room_id) ?? "(deactivated room)",
      check_in: r.check_in_date,
      check_out: r.check_out_date,
    };
  };

  const inHouse = (inHouseQ.data ?? []) as BookingRoomRow[];

  // Occupancy: derived from booking_rooms (never rooms.status). Denominator =
  // active rooms only. A checked-in row on a deactivated room is excluded from
  // the numerator so the % can't exceed 100.
  const occupiedActive = new Set(
    inHouse.map((r) => r.room_id).filter((id) => roomNumber.has(id)),
  );

  // Outstanding dues among in-house guests — per BOOKING (not per room), true-due formula.
  const dueByBooking = new Map<string, { booking_ref: string; guest: string; rooms: string[]; due: number }>();
  for (const r of inHouse) {
    const b = one(r.bookings);
    if (!b) continue;
    const existing = dueByBooking.get(r.booking_id);
    if (existing) {
      existing.rooms.push(roomNumber.get(r.room_id) ?? "?");
    } else {
      dueByBooking.set(r.booking_id, {
        booking_ref: b.booking_ref,
        guest: guestName(b),
        rooms: [roomNumber.get(r.room_id) ?? "?"],
        due: trueDue(b),
      });
    }
  }
  const outstandingDues = [...dueByBooking.values()]
    .filter((d) => d.due > 0.01)
    .sort((a, b) => b.due - a.due);

  const overdue = inHouse.filter((r) => r.check_out_date < date).map(line);

  return {
    date,
    arrivals_due:       ((arrivalsDueQ.data ?? []) as BookingRoomRow[]).map(line),
    checked_in_today:   ((checkedInTodayQ.data ?? []) as BookingRoomRow[]).map(line),
    departures_due:     ((departuresDueQ.data ?? []) as BookingRoomRow[]).map(line),
    checked_out_today:  ((checkedOutTodayQ.data ?? []) as BookingRoomRow[]).map(line),
    in_house:           inHouse.map(line),
    overdue_checkouts:  overdue,
    occupancy: {
      occupied_rooms: occupiedActive.size,
      active_rooms: rooms.length,
      percent: rooms.length ? Math.round((occupiedActive.size / rooms.length) * 1000) / 10 : 0,
    },
    outstanding_dues: {
      bookings: outstandingDues,
      total: Math.round(outstandingDues.reduce((s, d) => s + d.due, 0) * 100) / 100,
    },
    meta: {
      date,
      timezone: "Asia/Dhaka",
      rules_applied: [
        "arrivals_due = bookings still Confirmed with check-in on this date; checked_in_today = actually checked in during this Dhaka day (different lists)",
        "occupancy derived from booking rooms, not the physical room-status column; deactivated rooms excluded from both sides",
        "due = total + extra charge − additional discount − paid (early-departure deduction already inside total)",
      ],
    },
  };
}
