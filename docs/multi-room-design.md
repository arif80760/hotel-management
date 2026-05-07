# Multi-Room Booking Design Specification

**Status:** Phase 0 — Design complete, implementation not started  
**Created:** 2026-05-07  
**Last updated:** 2026-05-07  

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Real-World Scenarios](#2-real-world-scenarios)
3. [Design Decisions](#3-design-decisions)
4. [Pricing Model](#4-pricing-model)
5. [Status Model](#5-status-model)
6. [Schema Migration Plan](#6-schema-migration-plan)
7. [Type System Plan](#7-type-system-plan)
8. [Service Layer Plan](#8-service-layer-plan)
9. [UI Plan](#9-ui-plan)
10. [Phase Plan with Time Estimates](#10-phase-plan-with-time-estimates)
11. [Risk Register](#11-risk-register)
12. [Test Plan](#12-test-plan)
13. [Out of Scope](#13-out-of-scope)

---

## 1. Executive Summary

### Why this feature exists

The current data model constrains a booking to exactly one room: `bookings.room_id UUID NOT NULL`. In practice, hotel staff regularly accommodate families, travel groups, and corporate parties who book multiple rooms under one name, pay on one bill, and check in and out together. Today, staff create a separate booking per room and manually reconcile. This produces:

- Duplicate guest records (same person entered three times)
- Split payment history (no single view of how much the family has paid)
- Multiple invoices for what is commercially one transaction
- No way to see "this family's three rooms" as a single unit in the booking list or room board

### What it enables — the six scenarios

1. A family books 3 rooms together at time of reservation
2. A guest mid-stay adds a room when a friend arrives unexpectedly
3. A guest mid-stay removes a room when someone leaves early
4. Rooms within one booking carry different nightly rates and separate extra charges
5. One room extends its stay; the other rooms check out on the original date
6. Booking cancellation with audit-tracked refund processing (pending → disbursed workflow)

### What it does NOT do

- **Per-room payment tracking** — a single booking still has one `paid_amount`, one payment ledger
- **Separate invoices per room** — one invoice per booking, itemized by room, but one document
- **Different primary guests per room** — one `primary_guest_id` per booking always
- **Room reassignment mid-stay** — moving a guest from Room 201 to Room 305 is a distinct operation, not add/remove
- **Group bookings across separate reservations** — multi-room is one booking with N rooms, not N bookings linked together
- **Mixed-currency bookings** — all rooms in a booking use BDT; no multi-currency within a single bill
- **Discounts scoped to a specific room** — booking-level discounts only
- **Automatic refund disbursement** — we mark refunds as pending; admin disburses manually
- **Refund as booking credit** — we always issue full money refunds, never credit toward a future stay

### Architecture in one sentence

A `booking_rooms` junction table makes the `bookings` shell the financial and identity unit, and each `booking_rooms` row the stay unit (room, dates, rate, cancellation state). Existing single-room bookings each get one backfill row; `bookings.room_id` is preserved as a transition aid and dropped in a later migration.

### Estimated timeline

~38–55 hours of focused implementation across 12 phases (see Section 10). At 4–6 focused hours per day, expect 7–12 calendar days.

---

## 2. Real-World Scenarios

### Scenario 1 — Family books 3 rooms at reservation

**Initial state:** No booking exists. The Rahman family is checking in for a 3-night wedding anniversary trip.

**User action:** Staff creates one booking for the Rahman family with three rooms.

```
Booking: BK-2001  Guest: Rahman Family  Dates: 2026-07-10 → 2026-07-13  Nights: 3
  Room 201  Deluxe    ৳5,500/night  ×3 = ৳16,500
  Room 104  Double    ৳3,500/night  ×3 = ৳10,500
  Room 107  Double    ৳3,500/night  ×3 = ৳10,500
  ─────────────────────────────────────────────
  Total                              ৳37,500
  Advance paid (cash)                ৳15,000
  Balance due                        ৳22,500
```

**Expected system behavior:**
- One `bookings` row created (BK-2001, total_amount=37,500)
- Three `booking_rooms` rows created (one per room, each with dates + rate)
- Rooms 201, 104, 107 all set to `reserved`
- One `payments` row for ৳15,000

**Final state:**
- Booking BK-2001 status: `confirmed`, payment_status: `partial`
- All three rooms: `reserved`

**Pricing note:** Each room's nights are identical here (shared dates), so total = sum of rates × 3.

---

### Scenario 2 — Mid-stay: add a room when a friend arrives

**Initial state:** BK-2002, Mr. Hasan, Room 301 (Suite), 2026-08-01 → 2026-08-05 (4 nights, ৳9,000/night). Total: ৳36,000. Paid: ৳20,000.

**User action (Day 3, 2026-08-03):** Mr. Hasan's colleague arrives. Staff adds Room 203 (Suite, ৳9,000/night) to the existing booking for the remaining 2 nights.

```
BK-2002 — after addition
  Room 301  Suite  ৳9,000/night  Aug 01–05  4 nights  = ৳36,000  (unchanged)
  Room 203  Suite  ৳9,000/night  Aug 03–05  2 nights  = ৳18,000  (new)
  ─────────────────────────────────────────────────────────────────────
  New total                                             ৳54,000
  Already paid                                          ৳20,000
  New balance                                           ৳34,000
```

**Expected system behavior:**
- New `booking_rooms` row inserted for Room 203 with check_in=Aug 03, check_out=Aug 05
- `bookings.total_amount` updated from ৳36,000 to ৳54,000
- Room 203 set to `occupied` (booking is already checked_in, so this room goes straight to occupied)
- `payment_status` recalculated: partial

**Final state:**
- Booking BK-2002 status: `checked_in`
- Room 301: `occupied`
- Room 203: `occupied`

**Pricing note:** The added room's rate × nights are appended to the booking total. No retroactive charge to the original room.

---

### Scenario 3 — Mid-stay: remove a room when someone leaves early

**Initial state:** BK-2003, Corporate group, 3 rooms, 2026-09-05 → 2026-09-09 (4 nights).

```
  Room 303  Deluxe  ৳5,500/night  ×4 = ৳22,000
  Room 304  Deluxe  ৳5,500/night  ×4 = ৳22,000
  Room 305  Deluxe  ৳5,500/night  ×4 = ৳22,000
  Total                              ৳66,000
  Paid                               ৳30,000
```

**User action (Day 2, 2026-09-07):** Room 305 occupant must leave. Staff removes Room 305 from the booking. Guest has stayed 2 nights (Sep 5–7), so 2 nights are charged. The remaining 2 pre-booked nights (Sep 7–9) are deducted.

```
BK-2003 — after early removal of Room 305
  Room 303  Deluxe  ৳5,500/night  Sep 05–09  4 nights  = ৳22,000  (unchanged)
  Room 304  Deluxe  ৳5,500/night  Sep 05–09  4 nights  = ৳22,000  (unchanged)
  Room 305  Deluxe  ৳5,500/night  Sep 05–07  2 nights  = ৳11,000  (checked out early)
  ──────────────────────────────────────────────────────────────────────────────
  New total                                              ৳55,000
  Early deduction (Room 305, 2 nights)                  ৳11,000  (already reflected above)
  Already paid                                           ৳30,000
  New balance                                            ৳25,000
```

**Expected system behavior:**
- Room 305's `booking_rooms` row updated: check_out_date=Sep 07, actual_checkout_date=Sep 07, early_nights_deducted=2, early_deduction_amount=11,000, status=`checked_out`
- `bookings.total_amount` reduced to ৳55,000
- Room 305 set to `cleaning`
- Rooms 303, 304 remain `occupied`

**Final state:**
- Booking BK-2003 status: `checked_in` (two rooms still active)
- Room 305: `cleaning` (or `available` after turnover)
- Rooms 303, 304: `occupied`

**Pricing note:** The "remove room" operation is effectively an early checkout on that specific room. The minimum-1-night rule applies (since the guest was already checked in and did stay nights).

---

### Scenario 4 — Per-room rates and per-room extra charges

**Initial state:** BK-2004, Corporate booking, 2026-10-01 → 2026-10-03 (2 nights). Two Deluxe rooms, one at negotiated rate.

```
  Room 401  Deluxe  ৳5,500/night (standard)     ×2 = ৳11,000
  Room 402  Deluxe  ৳4,800/night (corporate rate) ×2 = ৳9,600
  Total at booking                                    ৳20,600
  Advance paid                                        ৳10,000
```

**User action (checkout, Oct 3):** Staff adds extras: Room 401 had mini-bar use (৳1,200) and laundry (৳600). Room 402 had no extras.

```
BK-2004 — at checkout
  Room 401  Deluxe  ৳5,500 ×2          = ৳11,000
    Extra: Mini-bar                      = ৳1,200
    Extra: Laundry                       = ৳600
  Room 402  Deluxe  ৳4,800 ×2          = ৳9,600
  ──────────────────────────────────────────────
  Total                                  ৳22,400
  Paid                                   ৳10,000
  Balance due at checkout                ৳12,400
```

**Expected system behavior:**
- Two `booking_extra_charges` rows inserted (both linked to Room 401's `booking_rooms` row)
- `bookings.total_amount` updated to ৳22,400
- Both rooms set to `checked_out` → both rooms `cleaning`
- Booking status: `checked_out`, payment_status: `partial`

**Final state:** Invoice shows Room 401 subtotal (৳11,000 + ৳1,800 extras) and Room 402 subtotal (৳9,600) as separate line-item groups.

---

### Scenario 5 — Partial extension: one room extends, others check out

**Initial state:** BK-2005, Group stay, 2026-11-10 → 2026-11-14 (4 nights).

```
  Room 501  Single  ৳2,500/night  ×4 = ৳10,000
  Room 502  Single  ৳2,500/night  ×4 = ৳10,000
  Total                              ৳20,000
  Paid                               ৳20,000
```

**User action (Nov 14, checkout day):** Room 502 guest wants to stay 2 more nights. Room 501 checks out as planned.

```
BK-2005 — after extension
  Room 501  Single  ৳2,500/night  Nov 10–14  4 nights  = ৳10,000  (checked out)
  Room 502  Single  ৳2,500/night  Nov 10–16  6 nights  = ৳15,000  (extended by 2)
  ──────────────────────────────────────────────────────────────────────────────
  New total                                              ৳25,000
  Already paid                                           ৳20,000
  New balance due                                        ৳5,000
```

**Expected system behavior:**
- Room 501's `booking_rooms` row: status=`checked_out`, checked_out_at=Nov 14. Room 501 → `cleaning`.
- Room 502's `booking_rooms` row: check_out_date updated to Nov 16, nights updated to 6
- `bookings.total_amount` updated to ৳25,000
- Booking status remains `checked_in` (Room 502 still active)
- `payment_status` recalculated: `partial` (was `paid`, now ৳5,000 outstanding)
- Room 502 remains `occupied`

---

### Scenario 6 — Booking cancelled before check-in (full refund)

**Initial state:** BK-3001. Family books Room 201 (Family, ৳4,000/night) for 3 nights, May 15–18. Total: ৳12,000. Advance paid: ৳3,000 via bKash on May 5. Status: `confirmed`.

**User action (May 8, 7 days before check-in):** Family calls to cancel due to schedule change. Staff opens timeline modal → clicks "Cancel Booking". Cancel modal opens with system-suggested full refund.

```
Cancel Booking — BK-3001
  Booking total:   ৳12,000
  Amount paid:     ৳3,000
  Suggested refund: ৳3,000  (full paid amount — pre-check-in policy)
  Reason:          [Family schedule change]
```

**Expected system behavior:**
1. `bookings.status` → `cancelled`
2. `booking_rooms[0].status` → `cancelled`
3. Room 201 → `available` (released by app layer)
4. New `refunds` row created:
   - `amount`: ৳3,000, `reason`: "Family schedule change"
   - `status`: `pending`, `created_at`: NOW(), `created_by`: staff UUID

**Final state:**
- Booking BK-3001 visible in list with `cancelled` badge
- Effective balance display: paid ৳3,000 · refunded ৳0 (pending) · net owed to guest ৳3,000
- Pending refunds queue shows ৳3,000 awaiting disbursement

**Later (May 9) — admin disburses:**

Admin opens Pending Refunds dashboard → selects this refund → "Mark Disbursed" → selects method bKash, confirms ৳3,000.
- `refunds.status` → `disbursed`, `disbursed_at` + `disbursed_by` stamped
- Effective balance: paid ৳3,000 · refunded ৳3,000 · net ৳0

**Pricing note:** Pre-check-in cancellation → 100% of paid amount returned. No partial deduction.

---

### Scenario 7 — Mid-stay per-room cancellation with refund

**Initial state:** BK-3002. Family of 8, 5 nights, May 1–6. All 3 rooms checked in.

```
  Room 201  Family  ৳5,000/night  ×5 = ৳25,000
  Room 202  Family  ৳5,000/night  ×5 = ৳25,000
  Room 203  Family  ৳5,000/night  ×5 = ৳25,000
  Total                              ৳75,000   paid in full at check-in
```

**User action (May 4, end of Day 3):** One family branch must leave. Staff opens timeline modal, sees 3 rooms listed. Clicks "Cancel Early" on Room 202 row.

```
Cancel Room 202 — Early Departure
  Room 202 check-in:       May 1
  Today (Day 3 end):       May 4   → 3 nights used × ৳5,000 = ৳15,000 charged
  Original booking total:  ৳75,000
  Room 202 share:          ৳25,000 / ৳75,000 = 33.3% of booking
  Amount paid for Room 202 (approx.): ৳75,000 paid × 33.3% = ৳25,000
  Charges for nights used:            3 × ৳5,000             = ৳15,000
  Suggested refund:                                             ৳10,000
  Reason: [Guest leaving early - work emergency]
  (Staff may override ৳10,000 to any amount)
```

**Expected system behavior:**
1. `booking_rooms[202].actual_checkout_date` → May 4
2. `booking_rooms[202].status` → `checked_out_early` (see Decision 3.17)
3. `booking_rooms[202].early_nights_deducted` = 2 (unused nights: May 4–6)
4. `booking_rooms[202].early_deduction_amount` = ৳10,000
5. `bookings.total_amount` recalculated: ৳25,000 + ৳15,000 + ৳25,000 = ৳65,000
6. New `refunds` row: ৳10,000, `booking_room_id` = Room 202's row, `status` = `pending`
7. Room 202 → `cleaning`
8. Booking status stays `checked_in` (Rooms 201 + 203 still active)

**Final state:**
- BK-3002 remains `checked_in`; invoice shows Room 202 at 3 nights = ৳15,000
- Pending refund: ৳10,000 for Room 202 early departure

**Pricing note:** Staff can override the suggested ৳10,000. The approximation is documented (see Section 4 — Refund Calculation).

**Status convention note:** Room 202 is marked `checked_out_early` rather than `cancelled` to preserve the fact that it was used for 3 nights. See Decision 3.17.

---

## 3. Design Decisions

All decisions below are **LOCKED**. Rationale is included to prevent relitigating.

---

### 3.1 Per-room dates with shared default — LOCKED

**Decision:** Each `booking_rooms` row stores its own `check_in_date` and `check_out_date`. When all rooms have the same dates (the common case), those fields happen to be identical — there is no "booking-level date" column.

**Rationale:** Scenarios 2, 3, and 5 require different dates per room. Storing dates only on `booking_rooms` makes the model correct for all cases. The "shared default" means the UI pre-fills identical dates when adding a new room to an existing booking, making the common case effortless.

**Implication:** `bookings.check_in_date` and `bookings.check_out_date` will be **dropped** from the `bookings` table as part of the migration. The booking list will derive display dates as `MIN(check_in_date)` and `MAX(check_out_date)` across its rooms.

---

### 3.2 Per-room rates — LOCKED

**Decision:** `booking_rooms.booking_rate NUMERIC(10,2) NOT NULL` stores the negotiated rate for that specific room. There is no booking-level rate column.

**Rationale:** Scenario 4 showed that different rooms in one booking can have different negotiated rates. A single booking-level rate would force all rooms to the same price, which breaks corporate or group rate negotiations. The field `bookings.booking_rate` will be dropped after migration.

---

### 3.3 Extras model: new `booking_extra_charges` table — LOCKED

**Decision:** Extra charges (mini-bar, laundry, damage) move from the `bookings` table (`extra_charge_amount`, `extra_charge_reason` columns) to a new `booking_extra_charges` table. Each row references both `booking_id` and optionally `booking_room_id` (nullable for booking-level charges).

**Rationale:** The current single-column model can't represent multiple distinct charges, can't attribute them to specific rooms, and can't carry itemized descriptions. A separate table gives unlimited charges per room per booking, each with a type and reason.

---

### 3.4 Cancel granularity: per-room — LOCKED

**Decision:** Staff can cancel a single room from an active booking. The booking itself is only cancelled when all its rooms are cancelled.

**Rationale:** Scenario 3 showed that mid-stay removal is effectively an early checkout on one room. The guest relationship (and remaining rooms) continues. Forcing an all-or-nothing cancel would require creating a new booking for the remaining rooms, which destroys payment history and audit trail.

---

### 3.5 Payment allocation: whole-booking — LOCKED

**Decision:** All payments belong to `bookings` (via `payments.booking_id`). There is no per-room payment tracking.

**Rationale:** Staff collect payment from one person (the primary guest) for the whole bill. Splitting payments across rooms would require the app to track which payment covers which room — adding significant complexity with no operational benefit, since the guest pays one amount regardless.

---

### 3.6 Invoice format: itemized per-room — LOCKED

**Decision:** The invoice document shows one section per room (room number, rate × nights, extras for that room), with a booking-level totals section at the bottom.

**Rationale:** Guests want to see a clear breakdown — "Room 201: 3 nights × ৳5,500 = ৳16,500, Mini-bar ৳1,200". A single-line total would be opaque and unmatchable to their room receipts.

---

### 3.7 `bookings.room_id`: keep during transition, drop after — LOCKED

**Decision:** `bookings.room_id` is preserved as NOT NULL throughout the migration. For multi-room bookings, it is set to the first room in the booking (lowest `created_at` in `booking_rooms`). After the app is fully migrated and all code reads from `booking_rooms`, a follow-up migration drops the column.

**Rationale:** Dropping `room_id` in the same migration as adding `booking_rooms` would require simultaneously updating every query that touches `room_id` (400+ callsites). The phased approach lets each layer be migrated independently. The column is documented as deprecated from day one.

---

### 3.8 `fn_sync_room_status`: retire, app layer owns it — LOCKED

**Decision:** The database trigger `fn_sync_room_status` (currently: `AFTER UPDATE OF status ON bookings`) is **dropped**. The service layer becomes solely responsible for setting `rooms.status`.

**Rationale:** With multi-room, the trigger can no longer determine the correct room status from `bookings.status` alone — it would need to know which specific rooms are affected, their individual statuses, and whether other bookings hold them. This is application-domain logic, not a simple column sync. The app layer already manually updates room status in several paths (updateBooking Step 6, createBooking). Centralizing all room-status writes in the service layer is cleaner than maintaining a trigger with growing conditional complexity.

**Migration action:** `DROP TRIGGER trg_sync_room_status ON bookings;` in Phase 2.

---

### 3.9 Atomicity: Postgres RPC for multi-row inserts — LOCKED

**Decision:** All operations that write to multiple tables (create booking with rooms, add room to booking, remove room, extend room) are wrapped in Postgres `LANGUAGE plpgsql` RPC functions called via `supabase.rpc()`. Each RPC uses `BEGIN ... EXCEPTION WHEN OTHERS THEN RAISE; END` so any failure rolls back the entire operation.

**Rationale:** The existing `createBooking` atomicity bug (bookings row inserted but payment fails → phantom booking) exists precisely because the service layer does sequential awaits without a transaction. Multi-room operations touch 3–4 tables; a partial write would be difficult to detect and recover from.

---

### 3.10 Stay extension: subsumed by multi-room — LOCKED

**Decision:** The planned "Stay Extension" feature (previously on the Day 3 roadmap) is not built as a separate feature. Instead, Scenario 5 (partial extension) is implemented as part of multi-room in Phase 8 (`update_booking_room_dates` RPC).

**Rationale:** The operations are structurally identical: updating `check_out_date` on a `booking_rooms` row, recalculating `nights`, and propagating to `bookings.total_amount`. Building a one-room extension first would require refactoring again for multi-room. One implementation serves both.

---

### 3.11 Status model: two levels with sync rules — LOCKED

**Decision:** Both `bookings.status` and `booking_rooms.status` exist and are maintained independently, with deterministic sync rules (see Section 5).

**Rationale:** Staff need to see per-room status ("Room 305 checked out, Rooms 303/304 still occupied") and booking-level status ("this booking is active") simultaneously — in the room board and in the booking list respectively. A single status on only one level would lose information.

---

### 3.12 Pricing: `nights = MAX(1, effective_checkout − checkin)` — LOCKED

**Decision:** The number of chargeable nights for a room is `MAX(1, actual_checkout_date - check_in_date)`. A room that was confirmed and checked in always carries at least 1 night charge, even if the guest departs on the same calendar day they arrived.

**Rationale:** Same-day departure is a legitimate outcome (guest arrives, decides to leave). It would be inconsistent to charge 0 nights. If the booking was only ever `confirmed` and never `checked_in`, and is cancelled before arrival, the minimum-1-night rule does NOT apply — no charge is appropriate for a free cancellation.

---

### 3.13 Schema source of truth: junction table — LOCKED

**Decision:** `booking_rooms` is the authoritative store for all per-stay data (dates, rate, category, status, early-checkout fields). The `bookings` table is the financial and identity shell. Any aggregate needed on `bookings` (total nights, effective date range) is derived from `booking_rooms` at query time.

**Rationale:** Denormalising date or rate summaries onto `bookings` would require triggers to keep them in sync — adding more trigger complexity in the exact area we're already reducing it. SQL aggregates (`MIN`, `MAX`, `SUM`) on a small set of rows per booking are cheap.

---

### 3.14 Cancellation refund policy — LOCKED

**Decision:**
- **Pre-check-in cancellation:** 100% of `paid_amount` is suggested as refund. No deduction.
- **Mid-stay per-room cancellation:** System suggests `paid_attributed_to_room − nights_used × rate`. Staff can override to any amount.
- **Mid-stay whole-booking cancellation:** System suggests `paid_amount − SUM(charges for nights used across all rooms)`. Staff can override.

**Rationale:** A hard no-refund or partial-refund policy requires contractual clarity the hotel hasn't formalised. The "staff can override" model gives the front desk the flexibility they need while the system provides an honest baseline. Pre-check-in full refund is simple enough to apply consistently.

---

### 3.15 Refund tracking model — LOCKED

**Decision:** All refunds are tracked in a new `refunds` table with full audit trail. `bookings.paid_amount` remains **gross** (sum of all payment amounts; never decremented). Effective balance is computed in the app layer: `paid_amount − SUM(disbursed_refund_amounts)`.

**Rationale:** Keeping `paid_amount` stable means the existing trigger chain (`fn_sync_paid_amount`, `fn_sync_payment_status`) is untouched. Refunds are a distinct business event from payment collection — mixing them in the same column would conflate two different flows and complicate audit. Separating them preserves a clean "money in" history and a separate "money out" history.

---

### 3.16 Refund disbursement workflow — LOCKED

**Decision:** Two-step lifecycle. Cancellation creates a `refunds` row with `status = 'pending'`. Admin reviews the pending queue and marks each refund `disbursed` when money is actually returned to the guest, stamping `disbursed_at`, `disbursed_by`, and `disbursement_method`.

**Rationale:** Cancellation (front desk action) and money disbursement (admin action) happen at different times and by different people. A single-step "cancel and instantly mark refunded" would be inaccurate — the guest hasn't received money until admin acts. The two-step model matches the real operational flow.

---

### 3.17 Mid-stay cancelled room status terminology — NEEDS DECISION

**Status:** Design decision required before Phase 1.

**Options:**
- **A) Use `cancelled`** for mid-stay early departure: simple, reuses existing enum. The `actual_checkout_date` field preserves how many nights were used; status alone loses that information.
- **B) Add `checked_out_early`** to `booking_status` enum: explicitly distinguishes "guest used some nights then left" from "guest never arrived." Better for reporting and audit; requires a DB migration to extend the enum.

**Recommendation: Option B.** The distinction is operationally meaningful and appears in invoices, the room board, and the pending refunds queue. The cost (one `ALTER TYPE` statement) is minimal.

**Implementation note:** `booking_rooms.status` uses the `booking_status` enum. Adding `checked_out_early` requires `ALTER TYPE public.booking_status ADD VALUE 'checked_out_early';` as a separate transaction step (PostgreSQL constraint on enum additions in the same transaction).

---

## 4. Pricing Model

### Formula

For a booking:

```
room_subtotal(r)  = r.booking_rate × r.effective_nights
                  where effective_nights = r.actual_checkout_date  -- if checked out early
                                           ?? r.check_out_date
                                           − r.check_in_date
                                           (minimum 1 if status = checked_out or checked_in)

extras_subtotal(r) = SUM(e.amount) for all booking_extra_charges where booking_room_id = r.id

booking_total = SUM(room_subtotal(r) + extras_subtotal(r)) for all non-free-cancelled rooms

true_due = booking_total − paid_amount
```

A room's subtotal is excluded from `booking_total` only if its status is `cancelled` AND it was never `checked_in` (free cancellation). Once checked in, at least 1 night's charge is included.

---

### Worked Examples

**Base case — 3 rooms, same dates, same rate**

```
Room 201  ৳5,500 × 3 = ৳16,500
Room 104  ৳3,500 × 3 = ৳10,500
Room 107  ৳3,500 × 3 = ৳10,500
                       ─────────
booking_total          ৳37,500
paid_amount            ৳15,000
true_due               ৳22,500
```

---

**Per-room rate variation**

```
Room 401  ৳5,500 × 2 = ৳11,000  (standard)
Room 402  ৳4,800 × 2 = ৳9,600   (corporate negotiated)
                        ─────────
booking_total           ৳20,600
```

---

**Mid-stay departure (Room 305 leaves on Day 2 of 4)**

```
Before removal:
  Room 303  ৳5,500 × 4 = ৳22,000
  Room 304  ৳5,500 × 4 = ৳22,000
  Room 305  ৳5,500 × 4 = ৳22,000
  booking_total          ৳66,000

After removal (Room 305 stays Sep 05–07, actual 2 nights):
  Room 303  ৳5,500 × 4 = ৳22,000  (unchanged)
  Room 304  ৳5,500 × 4 = ৳22,000  (unchanged)
  Room 305  ৳5,500 × 2 = ৳11,000  (actual_checkout_date=Sep 07)
  booking_total          ৳55,000   (reduction of ৳11,000)
```

`booking_rooms[305].early_nights_deducted = 2`, `early_deduction_amount = ৳11,000`. `bookings.total_amount` updated to ৳55,000.

---

**Mid-stay addition (Room 203 added on Day 3 of 4)**

```
Before addition:
  Room 301  ৳9,000 × 4 = ৳36,000
  booking_total          ৳36,000

After addition (Room 203 joins Aug 03, booking ends Aug 05):
  Room 301  ৳9,000 × 4 = ৳36,000
  Room 203  ৳9,000 × 2 = ৳18,000  (check_in=Aug 03, check_out=Aug 05)
  booking_total          ৳54,000
```

---

**Partial extension (Room 502 extends 2 nights)**

```
Before extension:
  Room 501  ৳2,500 × 4 = ৳10,000  (Nov 10–14)
  Room 502  ৳2,500 × 4 = ৳10,000  (Nov 10–14)
  booking_total          ৳20,000   paid_amount ৳20,000

After extension:
  Room 501  ৳2,500 × 4 = ৳10,000  (Nov 10–14, checked out)
  Room 502  ৳2,500 × 6 = ৳15,000  (Nov 10–16, check_out_date updated)
  booking_total          ৳25,000
  paid_amount            ৳20,000
  true_due               ৳5,000
  payment_status         partial   (was: paid)
```

---

**Edge case — same-day cancel (min 1 night)**

```
Guest checks in Aug 10 at 11:00, decides to leave at 15:00 same day.
  check_in_date  = Aug 10
  actual_checkout_date = Aug 10
  raw_nights = Aug 10 − Aug 10 = 0
  effective_nights = MAX(1, 0) = 1
  charge = ৳5,500 × 1 = ৳5,500
```

---

**Edge case — free cancellation (never checked in)**

```
Booking created, status = confirmed. Guest calls to cancel before arrival.
All rooms: status = cancelled, checked_in_at IS NULL.
  effective_nights = 0  (minimum-1 rule does NOT apply — was never checked in)
  charge = ৳0 per room
  booking_total = ৳0  (or refund if advance was paid)
```

---

### Refund Calculation

**Pre-check-in cancellation (whole booking):**

```
suggested_refund = paid_amount   (full refund)
```

---

**Mid-stay per-room cancellation (early departure):**

Because payments are booking-level, there is no exact "how much of the ৳X paid was for Room 202." We use a proportional approximation:

```
nights_used          = days_between(check_in_date, today)
room_share_ratio     = room_booking_total / booking_total
                     where room_booking_total = room.nights × room.booking_rate

paid_attributed      = total_paid × room_share_ratio  (approximation)
charges_for_room     = nights_used × room.booking_rate
suggested_refund     = MAX(0, paid_attributed − charges_for_room)
```

Staff can override `suggested_refund` to any amount ≥ 0.

**Worked example (Scenario 7):**

```
Booking total:     ৳75,000     (3 rooms × ৳25,000 each)
Total paid:        ৳75,000     (paid in full)
Room 202 share:    ৳25,000 / ৳75,000 = 33.3%
Paid attributed:   ৳75,000 × 33.3% = ৳25,000
Nights used:       3 nights × ৳5,000 = ৳15,000
Suggested refund:  ৳25,000 − ৳15,000 = ৳10,000
```

If the booking had only ৳50,000 paid at time of cancellation:

```
Paid attributed:   ৳50,000 × 33.3% = ৳16,667
Nights used:       ৳15,000
Suggested refund:  ৳16,667 − ৳15,000 = ৳1,667
```

The UI shows the approximation formula transparently so staff can make an informed override.

---

**Whole-booking mid-stay cancellation:**

```
charges_for_used_rooms = SUM(nights_used × rate) for all checked_in rooms
suggested_refund = MAX(0, paid_amount − charges_for_used_rooms)
```

---

**Effective balance (for display — NOT stored in DB):**

```
gross_paid       = SUM(payments.amount)
total_refunded   = SUM(refunds.amount WHERE status = 'disbursed')
effective_paid   = gross_paid − total_refunded
effective_due    = booking_total − effective_paid
```

`effective_due > 0` means guest owes money. `effective_due < 0` means hotel owes guest (pending disbursement).

---

## 5. Status Model

### Booking-level status (`bookings.status`)

| Status | Meaning |
|---|---|
| `confirmed` | All rooms reserved; no guest has checked in yet |
| `checked_in` | At least one room is currently occupied |
| `checked_out` | All rooms have been checked out (or cancelled) |
| `cancelled` | All rooms were cancelled before any check-in |

### Room-level status (`booking_rooms.status`)

Extends the `booking_status` enum with one additional value (see Decision 3.17). Requires `ALTER TYPE public.booking_status ADD VALUE 'checked_out_early';` in Phase 1 migration.

| Status | Meaning |
|---|---|
| `confirmed` | Room reserved; guest not yet in |
| `checked_in` | Guest currently in this room |
| `checked_out` | Guest completed normal departure on scheduled date |
| `checked_out_early` | Guest departed before scheduled checkout (nights used ≥ 1, unused nights deducted) |
| `cancelled` | Room removed from booking **before check-in** — zero nights used, no charge (free cancellation) |

The distinction between `checked_out_early` and `cancelled` matters for invoicing ("3 nights × ৳5,000") and refund calculation. A `cancelled` room with `checked_in_at IS NULL` contributes ৳0 to `booking_total`. A `checked_out_early` room contributes `nights_used × rate`.

### State transitions — per room

```
  confirmed ──────────────────────────────────► cancelled      (no charge — never used)
      │
      ▼
  checked_in ─────────────────────────────────► checked_out_early (mid-stay departure, min-1 charge, refund possible)
      │
      ▼
  checked_out   (terminal — no transitions out)
```

### State transitions — booking level

```
  confirmed ──────────────────────────────────► cancelled (all rooms cancelled, none checked in)
      │
      │  first room checks in
      ▼
  checked_in ─────────────────────────────────► (cannot be directly cancelled)
      │
      │  last active room checks out or is removed
      ▼
  checked_out   (terminal)
```

### Sync rules (booking status derived from room statuses)

These rules are evaluated by the service layer after any room status change:

| Room statuses across all booking_rooms | → Booking status |
|---|---|
| All `cancelled`, none ever `checked_in` | → `cancelled` |
| At least one `checked_in` | → `checked_in` |
| All rooms are `checked_out`, `checked_out_early`, or `cancelled` (at least one was `checked_in`) | → `checked_out` |
| All `confirmed` (no check-ins, no cancels) | → `confirmed` |

### Edge cases

**All rooms cancelled mid-stay:** Not directly reachable. Once any room is `checked_in`, the booking is `checked_in`. To reach a terminal state, each room must transition to `checked_out`, `checked_out_early`, or (for rooms that were still `confirmed`) `cancelled`.

**Mixed: one confirmed, one checked_in:** Booking = `checked_in`. This happens in Scenario 2 when a room is added mid-stay while another is already checked in — the new room starts as `confirmed` briefly, then immediately transitions to `checked_in`.

**Single-room booking:** Behaves identically to today. One `booking_rooms` row. Booking status = room status.

---

## 6. Schema Migration Plan

### 6.1 New Tables

#### `booking_rooms`

```sql
-- booking_rooms.status uses the booking_status enum, extended with 'checked_out_early'.
-- Run BEFORE creating booking_rooms:
ALTER TYPE public.booking_status ADD VALUE IF NOT EXISTS 'checked_out_early';

CREATE TABLE public.booking_rooms (
  id                     UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id             UUID              NOT NULL
                           REFERENCES public.bookings(id) ON DELETE CASCADE,
  room_id                UUID              NOT NULL
                           REFERENCES public.rooms(id) ON DELETE RESTRICT,

  -- Per-room stay dates
  check_in_date          DATE              NOT NULL,
  check_out_date         DATE              NOT NULL,
  nights                 SMALLINT          NOT NULL,   -- check_out_date − check_in_date

  -- Rate and category captured at booking time
  room_category          public.room_category NOT NULL,
  booking_rate           NUMERIC(10, 2)    NOT NULL,

  -- Per-room lifecycle status
  status                 public.booking_status NOT NULL DEFAULT 'confirmed',

  -- Per-room early checkout fields (mirrors bookings equivalents)
  actual_checkout_date   DATE,
  early_nights_deducted  INTEGER           DEFAULT 0,
  early_deduction_amount NUMERIC(10, 2)    DEFAULT 0,

  -- Per-room lifecycle timestamps
  confirmed_at           TIMESTAMPTZ,
  checked_in_at          TIMESTAMPTZ,
  checked_out_at         TIMESTAMPTZ,
  cancelled_at           TIMESTAMPTZ,

  created_at             TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ       NOT NULL DEFAULT NOW(),

  -- Date sanity
  CONSTRAINT chk_br_dates CHECK (check_out_date > check_in_date),
  -- nights must be positive
  CONSTRAINT chk_br_nights CHECK (nights > 0),
  -- Prevent the same room appearing twice in one booking
  CONSTRAINT uq_booking_room UNIQUE (booking_id, room_id)
);

COMMENT ON TABLE  public.booking_rooms IS 'Per-room stay records for a booking. One row per room per booking. Financial unit remains bookings.';
COMMENT ON COLUMN public.booking_rooms.booking_rate IS 'Negotiated rate per night for this room in this booking';
COMMENT ON COLUMN public.booking_rooms.nights IS 'Computed as check_out_date − check_in_date at write time; update whenever dates change';
COMMENT ON COLUMN public.booking_rooms.early_deduction_amount IS 'early_nights_deducted × booking_rate; deducted from bookings.total_amount on early checkout';

-- Indexes
CREATE INDEX idx_booking_rooms_booking_id ON public.booking_rooms (booking_id);
CREATE INDEX idx_booking_rooms_room_id    ON public.booking_rooms (room_id);
CREATE INDEX idx_booking_rooms_status     ON public.booking_rooms (status);
CREATE INDEX idx_booking_rooms_dates      ON public.booking_rooms (check_in_date, check_out_date);

-- RLS
ALTER TABLE public.booking_rooms ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read booking_rooms"
  ON public.booking_rooms FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert booking_rooms"
  ON public.booking_rooms FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update booking_rooms"
  ON public.booking_rooms FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated can delete booking_rooms"
  ON public.booking_rooms FOR DELETE TO authenticated USING (true);
```

---

#### `booking_extra_charges`

```sql
CREATE TABLE public.booking_extra_charges (
  id              UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      UUID              NOT NULL
                    REFERENCES public.bookings(id) ON DELETE CASCADE,
  booking_room_id UUID
                    REFERENCES public.booking_rooms(id) ON DELETE SET NULL,
  -- NULL booking_room_id = booking-level charge (applies to whole bill)

  amount          NUMERIC(10, 2)    NOT NULL,
  reason          TEXT              NOT NULL,   -- "Mini-bar — 3 soft drinks"
  charge_type     TEXT,                         -- 'mini_bar' | 'laundry' | 'damage' | 'other'

  applied_by      UUID              REFERENCES auth.users(id) ON DELETE SET NULL,
  applied_at      TIMESTAMPTZ       NOT NULL DEFAULT NOW(),

  created_at      TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.booking_extra_charges IS 'Itemized extra charges per booking, optionally attributed to a specific room';
COMMENT ON COLUMN public.booking_extra_charges.booking_room_id IS 'NULL = booking-level charge; non-null = attributed to a specific room';
COMMENT ON COLUMN public.booking_extra_charges.charge_type IS 'Enum-like: mini_bar | laundry | damage | other';

CREATE INDEX idx_bec_booking_id      ON public.booking_extra_charges (booking_id);
CREATE INDEX idx_bec_booking_room_id ON public.booking_extra_charges (booking_room_id);

ALTER TABLE public.booking_extra_charges ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read booking_extra_charges"
  ON public.booking_extra_charges FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert booking_extra_charges"
  ON public.booking_extra_charges FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can delete booking_extra_charges"
  ON public.booking_extra_charges FOR DELETE TO authenticated USING (true);
```

---

### 6.2 Modified Tables — `bookings`

Columns migrated TO `booking_rooms` or `booking_extra_charges` are dropped after backfill is verified. `bookings.room_id` is deprecated but NOT dropped in this migration.

**Before (current columns relevant to this migration):**

```
bookings
  id                           UUID     PK
  booking_ref                  TEXT     UNIQUE NOT NULL
  room_id                      UUID     NOT NULL FK→rooms   ← DEPRECATED (kept for transition)
  primary_guest_id             UUID     NOT NULL FK→guests
  check_in_date                DATE     NOT NULL             ← MOVING TO booking_rooms
  check_out_date               DATE     NOT NULL             ← MOVING TO booking_rooms
  nights                       SMALLINT NOT NULL             ← MOVING TO booking_rooms
  room_category_at_booking     ENUM     NOT NULL             ← MOVING TO booking_rooms
  total_amount                 NUMERIC  NOT NULL
  paid_amount                  NUMERIC  NOT NULL DEFAULT 0
  due_amount                   NUMERIC  NOT NULL DEFAULT 0   (vestigial)
  payment_status               ENUM     NOT NULL
  booking_rate                 NUMERIC  NULL                 ← MOVING TO booking_rooms
  fixed_rate                   NUMERIC  NULL                 ← MOVING TO booking_rooms
  extra_charge_amount          NUMERIC  NULL                 ← MOVING TO booking_extra_charges
  extra_charge_reason          TEXT     NULL                 ← MOVING TO booking_extra_charges
  early_nights_deducted        INTEGER  NULL                 ← MOVING TO booking_rooms
  early_deduction_amount       NUMERIC  NULL                 ← MOVING TO booking_rooms
  actual_checkout_date         DATE     NULL                 ← MOVING TO booking_rooms
  ... (all other columns stay)
```

**After (columns to drop via ALTER TABLE):**

```sql
ALTER TABLE public.bookings
  DROP COLUMN IF EXISTS check_in_date,
  DROP COLUMN IF EXISTS check_out_date,
  DROP COLUMN IF EXISTS nights,
  DROP COLUMN IF EXISTS room_category_at_booking,
  DROP COLUMN IF EXISTS booking_rate,
  DROP COLUMN IF EXISTS fixed_rate,
  DROP COLUMN IF EXISTS fixed_room_rate,      -- legacy alias
  DROP COLUMN IF EXISTS extra_charge,         -- legacy alias
  DROP COLUMN IF EXISTS extra_charge_amount,
  DROP COLUMN IF EXISTS extra_charge_reason,
  DROP COLUMN IF EXISTS charge_type,          -- legacy alias
  DROP COLUMN IF EXISTS early_nights_deducted,
  DROP COLUMN IF EXISTS early_deduction_amount,
  DROP COLUMN IF EXISTS actual_checkout_date;
  -- NOTE: room_id NOT dropped here. Deprecated but kept until Phase 3 complete.
  -- NOTE: due_amount NOT dropped here. Vestigial but harmless.
```

**Columns that STAY on `bookings`:**

```
  id, booking_ref, room_id (deprecated), primary_guest_id
  total_guests, status, total_amount, paid_amount, due_amount (vestigial)
  payment_status, last_payment_method
  discount_amount, discount_percentage (legacy — assess for removal separately)
  additional_discount_amount, additional_discount_reason, additional_discount_by, additional_discount_at
  override_checkout, override_reason, override_by, override_at
  confirmed_at, checked_in_at, checked_out_at, cancelled_at
  created_at, updated_at
```

---

### 6.3 Backfill Strategy

Run in Supabase SQL Editor **before** dropping any columns. Verify counts before proceeding.

```sql
-- Step 1: Populate booking_rooms from existing single-room bookings
INSERT INTO public.booking_rooms (
  booking_id,
  room_id,
  check_in_date,
  check_out_date,
  nights,
  room_category,
  booking_rate,
  status,
  actual_checkout_date,
  early_nights_deducted,
  early_deduction_amount,
  confirmed_at,
  checked_in_at,
  checked_out_at,
  cancelled_at,
  created_at,
  updated_at
)
SELECT
  id                                           AS booking_id,
  room_id,
  check_in_date,
  check_out_date,
  nights,
  room_category_at_booking::public.room_category AS room_category,
  COALESCE(booking_rate, total_amount / NULLIF(nights, 0))
                                               AS booking_rate,
  status,
  actual_checkout_date,
  COALESCE(early_nights_deducted, 0),
  COALESCE(early_deduction_amount, 0),
  confirmed_at,
  checked_in_at,
  checked_out_at,
  cancelled_at,
  created_at,
  updated_at
FROM public.bookings;

-- Step 2: Migrate extra charges from bookings to booking_extra_charges
INSERT INTO public.booking_extra_charges (
  booking_id,
  booking_room_id,
  amount,
  reason,
  charge_type,
  applied_at
)
SELECT
  b.id                            AS booking_id,
  br.id                           AS booking_room_id,  -- link to the just-created room row
  b.extra_charge_amount,
  COALESCE(b.extra_charge_reason, 'Extra charge at checkout'),
  'other'                         AS charge_type,
  COALESCE(b.checked_out_at, b.updated_at)  AS applied_at
FROM public.bookings b
JOIN public.booking_rooms br ON br.booking_id = b.id   -- exactly 1 row per booking post-backfill
WHERE b.extra_charge_amount IS NOT NULL
  AND b.extra_charge_amount > 0;

-- Step 3: Verification (must pass before dropping columns)
DO $$
DECLARE
  v_bookings_count     INTEGER;
  v_booking_rooms_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_bookings_count FROM public.bookings;
  SELECT COUNT(DISTINCT booking_id) INTO v_booking_rooms_count FROM public.booking_rooms;

  IF v_bookings_count <> v_booking_rooms_count THEN
    RAISE EXCEPTION 'Backfill mismatch: bookings=% booking_rooms distinct bookings=%',
      v_bookings_count, v_booking_rooms_count;
  END IF;

  RAISE NOTICE 'Backfill verified: % bookings, % booking_rooms rows',
    v_bookings_count, v_booking_rooms_count;
END;
$$;
```

---

### 6.4 Trigger Changes

| Trigger | Action | Reason |
|---|---|---|
| `trg_sync_room_status` | **DROP** | Multi-room makes this trigger unable to determine correct room state from booking status alone. App layer takes full ownership. |
| `trg_stamp_booking_timestamps` | **KEEP** | Still fires on `bookings.status` changes. Service layer sets `booking_rooms` timestamps separately. |
| `trg_sync_paid_amount` | **KEEP** | Still fires on `payments INSERT`. No change needed. |
| `trg_sync_payment_status` | **KEEP as-is, fix later** | Fires on `bookings.paid_amount` and `total_amount` changes. The extras-blindspot bug exists but is unchanged by this migration. Fix separately. |
| `trg_sync_last_payment_method` | **KEEP** | No change needed. |

```sql
-- Run as part of Phase 2 migration
DROP TRIGGER IF EXISTS trg_sync_room_status ON public.bookings;
DROP FUNCTION IF EXISTS public.fn_sync_room_status();
```

---

### 6.5 RPC Functions

All three are called via `supabase.rpc()`. Each is a Postgres function that runs in a single transaction — partial failures roll back automatically.

#### `create_booking_with_rooms`

```sql
CREATE OR REPLACE FUNCTION public.create_booking_with_rooms(
  p_booking_ref        TEXT,
  p_primary_guest_id   UUID,
  p_total_guests       SMALLINT,
  p_rooms              JSONB,     -- [{room_id, check_in_date, check_out_date, nights, category, rate}]
  p_total_amount       NUMERIC,
  p_initial_payment    NUMERIC    DEFAULT 0,
  p_payment_method     TEXT       DEFAULT NULL,
  p_notes              TEXT       DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql AS $$
DECLARE
  v_booking_id  UUID;
  v_room        JSONB;
  v_first_room_id UUID;
BEGIN
  v_first_room_id := (p_rooms->0->>'room_id')::UUID;

  -- Insert booking shell (room_id = first room for backward compat)
  INSERT INTO public.bookings (
    booking_ref, primary_guest_id, room_id, total_guests,
    status, total_amount, paid_amount, payment_status, confirmed_at
  ) VALUES (
    p_booking_ref, p_primary_guest_id, v_first_room_id, p_total_guests,
    'confirmed', p_total_amount, 0, 'unpaid', NOW()
  )
  RETURNING id INTO v_booking_id;

  -- Insert booking_rooms rows + set each room to reserved
  FOR v_room IN SELECT * FROM jsonb_array_elements(p_rooms) LOOP
    INSERT INTO public.booking_rooms (
      booking_id, room_id, check_in_date, check_out_date, nights,
      room_category, booking_rate, status, confirmed_at
    ) VALUES (
      v_booking_id,
      (v_room->>'room_id')::UUID,
      (v_room->>'check_in_date')::DATE,
      (v_room->>'check_out_date')::DATE,
      (v_room->>'nights')::SMALLINT,
      (v_room->>'category')::public.room_category,
      (v_room->>'rate')::NUMERIC,
      'confirmed',
      NOW()
    );

    UPDATE public.rooms
    SET status = 'reserved'
    WHERE id = (v_room->>'room_id')::UUID;
  END LOOP;

  -- Initial payment if provided
  IF p_initial_payment > 0 AND p_payment_method IS NOT NULL THEN
    INSERT INTO public.payments (booking_id, amount, method)
    VALUES (v_booking_id, p_initial_payment, p_payment_method::public.payment_method);
  END IF;

  RETURN v_booking_id;
END;
$$;
```

#### `add_room_to_booking`

```sql
CREATE OR REPLACE FUNCTION public.add_room_to_booking(
  p_booking_id      UUID,
  p_room_id         UUID,
  p_check_in_date   DATE,
  p_check_out_date  DATE,
  p_nights          SMALLINT,
  p_category        public.room_category,
  p_rate            NUMERIC,
  p_room_status     public.booking_status  -- 'confirmed' or 'checked_in' depending on context
) RETURNS UUID
LANGUAGE plpgsql AS $$
DECLARE
  v_room_row_id  UUID;
  v_room_status  public.room_status;
BEGIN
  INSERT INTO public.booking_rooms (
    booking_id, room_id, check_in_date, check_out_date, nights,
    room_category, booking_rate, status, confirmed_at,
    checked_in_at
  ) VALUES (
    p_booking_id, p_room_id, p_check_in_date, p_check_out_date, p_nights,
    p_category, p_rate, p_room_status, NOW(),
    CASE WHEN p_room_status = 'checked_in' THEN NOW() ELSE NULL END
  )
  RETURNING id INTO v_room_row_id;

  -- Update total_amount on booking
  UPDATE public.bookings
  SET total_amount = total_amount + (p_nights * p_rate),
      room_id = COALESCE(room_id, p_room_id)  -- backward compat: keep first room
  WHERE id = p_booking_id;

  -- Set physical room status
  v_room_status := CASE p_room_status
    WHEN 'confirmed'  THEN 'reserved'::public.room_status
    WHEN 'checked_in' THEN 'occupied'::public.room_status
    ELSE 'reserved'::public.room_status
  END;
  UPDATE public.rooms SET status = v_room_status WHERE id = p_room_id;

  RETURN v_room_row_id;
END;
$$;
```

#### `checkout_booking_room`

```sql
CREATE OR REPLACE FUNCTION public.checkout_booking_room(
  p_booking_room_id        UUID,
  p_actual_checkout_date   DATE,
  p_early_nights_deducted  INTEGER  DEFAULT 0,
  p_deduction_amount       NUMERIC  DEFAULT 0
) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  v_booking_id   UUID;
  v_room_id      UUID;
  v_active_count INTEGER;
BEGIN
  SELECT booking_id, room_id INTO v_booking_id, v_room_id
  FROM public.booking_rooms WHERE id = p_booking_room_id;

  -- Update this room's booking_rooms row
  UPDATE public.booking_rooms
  SET status                 = 'checked_out',
      actual_checkout_date   = p_actual_checkout_date,
      early_nights_deducted  = p_early_nights_deducted,
      early_deduction_amount = p_deduction_amount,
      check_out_date         = p_actual_checkout_date,
      nights                 = nights - p_early_nights_deducted,
      checked_out_at         = NOW(),
      updated_at             = NOW()
  WHERE id = p_booking_room_id;

  -- Deduct from booking total
  IF p_deduction_amount > 0 THEN
    UPDATE public.bookings
    SET total_amount = total_amount - p_deduction_amount
    WHERE id = v_booking_id;
  END IF;

  -- Set physical room to cleaning
  UPDATE public.rooms SET status = 'cleaning' WHERE id = v_room_id;

  -- Advance booking to checked_out if all rooms now done
  SELECT COUNT(*) INTO v_active_count
  FROM public.booking_rooms
  WHERE booking_id = v_booking_id
    AND status IN ('confirmed', 'checked_in');

  IF v_active_count = 0 THEN
    UPDATE public.bookings
    SET status = 'checked_out', checked_out_at = NOW()
    WHERE id = v_booking_id;
  END IF;
END;
$$;
```

---

### 6.6 New Table — `refunds`

```sql
CREATE TABLE public.refunds (
  id                   UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id           UUID              NOT NULL
                         REFERENCES public.bookings(id) ON DELETE CASCADE,
  booking_room_id      UUID
                         REFERENCES public.booking_rooms(id) ON DELETE SET NULL,
  -- NULL = whole-booking refund; non-null = refund for a specific room's early departure

  amount               NUMERIC(10, 2)    NOT NULL CHECK (amount > 0),
  reason               TEXT,

  status               TEXT              NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'disbursed', 'denied')),

  created_at           TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  created_by           UUID              REFERENCES auth.users(id) ON DELETE SET NULL,

  disbursed_at         TIMESTAMPTZ,
  disbursed_by         UUID              REFERENCES auth.users(id) ON DELETE SET NULL,
  disbursement_method  TEXT
                         CHECK (disbursement_method IS NULL OR
                                disbursement_method IN
                                  ('cash', 'bkash', 'nagad', 'bank_transfer', 'card')),

  notes                TEXT
);

COMMENT ON TABLE  public.refunds IS 'Refund records for cancelled bookings or early departures. Two-step lifecycle: status=pending on creation, status=disbursed when admin confirms money returned.';
COMMENT ON COLUMN public.refunds.booking_room_id IS 'NULL = whole-booking refund. Non-null = per-room refund (e.g. early departure Scenario 7).';
COMMENT ON COLUMN public.refunds.amount IS 'Refund amount agreed at time of cancellation. Locked after creation — cannot be edited.';
COMMENT ON COLUMN public.refunds.status IS 'pending: awaiting disbursement | disbursed: money returned to guest | denied: refund rejected by admin';
COMMENT ON COLUMN public.refunds.created_by IS 'Staff member who processed the cancellation';
COMMENT ON COLUMN public.refunds.disbursed_by IS 'Admin who confirmed disbursement';

-- Fast queue query: all pending refunds
CREATE INDEX idx_refunds_booking_id ON public.refunds (booking_id);
CREATE INDEX idx_refunds_status_pending ON public.refunds (status)
  WHERE status = 'pending';   -- partial index — only index the queue rows

ALTER TABLE public.refunds ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read refunds"
  ON public.refunds FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert refunds"
  ON public.refunds FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update refunds"
  ON public.refunds FOR UPDATE TO authenticated USING (true);
```

**Design notes:**
- `amount` is locked at creation — staff agree on a refund amount when cancelling; that figure doesn't change afterward. If the wrong amount was entered, the record is `denied` and a new `refunds` row is created.
- `paid_amount` on `bookings` is **not decremented** when a refund is created or disbursed. Effective balance is computed in the app layer (see Section 4 — Effective Balance and Section 8 — `calcEffectiveBalance`).
- No trigger attached to `refunds`. The `fn_sync_paid_amount` trigger chain is intentionally left unchanged.

---

## 7. Type System Plan

### New types

```typescript
// New: one row per room per booking
interface BookingRoom {
  id:           string;              // booking_rooms.id UUID
  bookingId:    string;              // booking_rooms.booking_id
  roomId:       string;              // booking_rooms.room_id (internal UUID — not exposed in UI)
  roomNumber:   string;              // JOIN from rooms
  roomCategory: string;              // booking_rooms.room_category (capitalised for UI)
  checkIn:      string;              // display: "Jul 10, 2026"
  checkOut:     string;              // display: "Jul 13, 2026"
  checkInISO:   string;              // "2026-07-10"
  checkOutISO:  string;              // "2026-07-13"
  nights:       number;
  bookingRate:  number;              // per night for this room
  status:       BookingStatus;       // room-level status
  // Early checkout
  actualCheckoutDate?:    string;
  earlyNightsDeducted:    number;
  earlyDeductionAmount:   number;
  // Timestamps
  confirmedAt?:   string;
  checkedInAt?:   string;
  checkedOutAt?:  string;
  cancelledAt?:   string;
}

// New: itemized extra charges
interface BookingExtraCharge {
  id:             string;
  bookingId:      string;
  bookingRoomId?: string;   // null = booking-level charge
  roomNumber?:    string;   // denormalised for display (from JOIN)
  amount:         number;
  reason:         string;
  chargeType?:    string;
  appliedAt:      string;
}
```

### Changes to `MockBooking`

```typescript
// ADD
rooms:         BookingRoom[];      // replaces single-room fields
extraCharges:  BookingExtraCharge[];  // replaces extraChargeAmount/Reason

// BECOME COMPUTED SHIMS (read-only getters or derived at mapBooking time)
roomNumber:    string;   // → rooms[0]?.roomNumber ?? ''
roomCategory:  string;   // → rooms[0]?.roomCategory ?? ''
checkIn:       string;   // → rooms[0]?.checkIn ?? ''   (or earliest across rooms)
checkOut:      string;   // → rooms[0]?.checkOut ?? ''  (or latest across rooms)
checkInISO:    string;   // → rooms[0]?.checkInISO ?? ''
checkOutISO:   string;   // → rooms[0]?.checkOutISO ?? ''
nights:        number;   // → Math.max(...rooms.map(r => r.nights))
bookingRate:   number;   // → rooms[0]?.bookingRate ?? 0

// REMOVE (after all consumers are migrated)
extraChargeAmount, extraChargeReason
earlyNightsDeducted, earlyDeductionAmount, actualCheckoutDate
```

### `mapBooking()` changes

The function currently joins `rooms!room_id` (single object). After migration it will join `booking_rooms ( id, room_id, rooms(room_number, category), check_in_date, check_out_date, nights, booking_rate, status, ... )` as an array. The `BOOKING_SELECT` constant in `bookingsService.ts` is the single change point.

### `Refund` type (new)

```typescript
export type RefundStatus = 'pending' | 'disbursed' | 'denied';

export interface Refund {
  id:                 string;
  bookingId:          string;
  bookingRoomId:      string | null;   // null = whole-booking refund

  amount:             number;
  reason:             string | null;

  status:             RefundStatus;

  createdAt:          string;
  createdBy:          string | null;   // auth.users UUID

  disbursedAt:        string | null;
  disbursedBy:        string | null;   // auth.users UUID
  disbursementMethod: PaymentMethod | null;

  notes:              string | null;
}
```

### Type error estimate

Approximately 400+ field accesses on `MockBooking` touch the fields being moved. Backward-compat shims (Phase 3) keep the old property names returning `rooms[0]` data — meaning most callsites will compile and run correctly without changes. The only callsites requiring active updates are those that need to iterate over all rooms (invoice, room-board, checkout flow).

---

## 8. Service Layer Plan

### `createBooking` → `createBookingWithRooms`

- **New signature:** takes array of room specs `{roomId, checkIn, checkOut, nights, category, rate}`
- **Implementation:** calls `supabase.rpc('create_booking_with_rooms', {...})`
- **Old `createBooking` kept** as a single-room wrapper calling `createBookingWithRooms` with a one-element array — allows the booking form to migrate independently

### `updateBooking`

- **Booking-level fields** (guest name, status overrides, discounts): no structural change
- **Room edits** (change rate, change dates on existing room): calls new `update_booking_room` service function → `UPDATE booking_rooms SET ...`
- **Add room mid-stay:** new `addRoomToBooking(bookingId, roomSpec)` → calls `supabase.rpc('add_room_to_booking', ...)`
- **Remove room:** new `removeRoomFromBooking(bookingRoomId, deductionData)` → calls `supabase.rpc('checkout_booking_room', ...)`

### `getBookingByRef` / `getAllBookings`

- Update `BOOKING_SELECT` to include `booking_rooms` with room JOIN:
  ```typescript
  const BOOKING_SELECT = `
    *,
    guests!primary_guest_id ( id, name, phone, email ),
    booking_guests ( name, nationality, sort_order ),
    booking_rooms (
      id, room_id, check_in_date, check_out_date, nights,
      room_category, booking_rate, status,
      actual_checkout_date, early_nights_deducted, early_deduction_amount,
      confirmed_at, checked_in_at, checked_out_at, cancelled_at,
      rooms ( room_number, category )
    ),
    booking_extra_charges ( id, booking_room_id, amount, reason, charge_type, applied_at )
  `;
  ```

### `checkoutNormal` / `checkoutWithOverride`

- **Single-room case:** still works — just passes the one `booking_rooms` row's id to `checkout_booking_room` RPC
- **Multi-room:** UI shows per-room checkout buttons; each calls the same service function with a `booking_room_id`
- `checkoutNormal` gains an optional `bookingRoomId` parameter — if provided, checks out one room; if omitted (legacy), checks out all remaining rooms in the booking

### Conflict detection — updated query

```typescript
// Old: queries bookings.room_id directly
const { data } = await supabase
  .from('bookings')
  .select('booking_ref')
  .eq('room_id', roomId)
  .lt('check_in_date', checkOut)
  .gt('check_out_date', checkIn)
  .in('status', ['confirmed', 'checked_in']);

// New: queries booking_rooms
const { data } = await supabase
  .from('booking_rooms')
  .select('booking_id, bookings!inner(booking_ref)')
  .eq('room_id', roomId)
  .lt('check_in_date', checkOut)
  .gt('check_out_date', checkIn)
  .in('status', ['confirmed', 'checked_in']);
```

### `cancelBooking` / `cancelBookingRoom`

- `cancelBooking`: cancels ALL rooms in the booking (pre-check-in only). Calls `UPDATE booking_rooms SET status='cancelled' WHERE booking_id=... AND status='confirmed'`. Sets `rooms.status = 'available'` for each. Creates a `refunds` row if `paid_amount > 0`.
- `cancelBookingRoom` (NEW): early-departs one `booking_rooms` row. Sets status to `checked_out_early`, updates `actual_checkout_date`, recalculates `bookings.total_amount`. Creates a `refunds` row for the suggested amount. Syncs booking-level status per Section 5 rules.

### Refund service layer (new file: `services/refundsService.ts`)

```typescript
// Create a refund record (called after cancellation is confirmed)
createRefund(input: {
  bookingId:      string;
  bookingRoomId?: string;   // omit for whole-booking refund
  amount:         number;
  reason:         string;
  createdBy:      string;   // auth.users UUID
}): Promise<Refund>

// Fetch all refunds for a booking (for timeline modal + invoice)
getRefundsByBookingId(bookingId: string): Promise<Refund[]>

// Admin: mark a pending refund as disbursed
markRefundDisbursed(refundId: string, input: {
  disbursementMethod: PaymentMethod;
  disbursedBy:        string;   // auth.users UUID
  notes?:             string;
}): Promise<Refund>

// Admin: deny a pending refund (records outcome without disbursing)
denyRefund(refundId: string, input: {
  deniedBy: string;
  notes?:   string;
}): Promise<Refund>
```

### `calcEffectiveBalance` (update to `lib/invoiceUtils.ts`)

```typescript
// Replaces / extends calcTrueDue to account for disbursed refunds.
export function calcEffectiveBalance(
  bookingTotal:    number,   // from bookings.total_amount
  payments:        Payment[],
  refunds:         Refund[],
): number {
  const grossPaid     = payments.reduce((s, p) => s + p.amount, 0);
  const totalRefunded = refunds
    .filter(r => r.status === 'disbursed')
    .reduce((s, r) => s + r.amount, 0);
  const effectivePaid = grossPaid - totalRefunded;
  return bookingTotal - effectivePaid;
  // > 0  = guest owes hotel
  // < 0  = hotel owes guest (pending disbursement exists)
  // = 0  = settled
}
```

`calcTrueDue` (existing) is kept for invoice display where refunds aren't relevant (invoice shows charges, not net balance).

---

## 9. UI Plan

### Add Booking Modal

- **Room picker becomes multi-select.** A list of available rooms with checkboxes, each showing room number, category, and rate. Staff can select 1–N rooms.
- **Rate per room:** each selected room shows an editable rate field (pre-filled from `rooms.price_per_night`).
- **Date per room:** shared dates by default; an "override dates for this room" toggle per row for the uncommon case.
- **Total preview** updates live: `SUM(rate × nights)` across selected rooms.

### Booking List Row

- `roomNumber` field → shows comma-separated room numbers: `201, 104, 107`
- Room count badge for multi-room bookings: `3 rooms`
- No other row layout changes; the booking is still one row

### Edit Booking Modal

- **New "Rooms" section** alongside existing guest/dates/rate section
- Shows a table of current rooms (number, dates, rate, status)
- Action buttons per room: Edit rate/dates | Check Out | Remove (with deduction calculation shown)
- "Add Room" button at the bottom of the rooms table

### Timeline Modal

- **Stay Details section** expands to show per-room breakdown:
  - Each room as a collapsible row: Room 201 · Deluxe · Jul 10–13 · 3 nights · ৳5,500/night
- Total line at the bottom unchanged

### Room Board

- No structural change. Each room cell still represents one physical room.
- A room can now appear in a booking that has other rooms — the booking ref shown in the cell is shared.

### Invoice Page

- **Per-room sections** replace the current single "Room accommodation" line:
  ```
  Room 201 — Deluxe (3 nights × ৳5,500)     ৳16,500
  Room 104 — Double (3 nights × ৳3,500)     ৳10,500
    Extra: Mini-bar                              ৳800
  Room 107 — Double (3 nights × ৳3,500)     ৳10,500
  ─────────────────────────────────────────────────
  Total                                      ৳38,300
  ```
- Payments section unchanged (booking-level)

### Reservation Details Page

- Same structure change as invoice: per-room sections for the charges table.

### New flows

- **Mid-stay add room:** accessed from Edit Booking modal → "Add Room" button → room picker filtered to available rooms for the remaining dates. Calls `add_room_to_booking` on confirm.
- **Mid-stay remove room / early checkout:** accessed from Edit Booking modal → per-room "Check Out Early" button → shows deduction calculation → calls `checkout_booking_room` on confirm.
- **Per-room extension:** accessed from Edit Booking modal → per-room "Extend Stay" button → date picker for new checkout → calls `update_booking_room_dates` on confirm.

### Cancel Booking modal (whole booking)

Accessible from the Edit Booking modal (or Booking List action menu) when `booking.status === 'confirmed'` (pre-check-in).

- Shows summary: booking ref, room(s), total amount, amount paid
- If `paid_amount > 0`: shows a suggested refund amount (= `paid_amount`) with an editable override field and a reason text box. Label: "Amount to refund to guest"
- If `paid_amount === 0`: shows "No payment on record — cancellation has no financial impact"
- Two buttons: **Cancel Booking** (destructive, red) | **Keep Booking**
- On confirm: calls `cancelBooking(bookingId, refundInput?)` → creates `refunds` row if amount > 0 → all rooms → `available` → booking → `cancelled`
- Success toast: "Booking BK-XXXX cancelled" + (if refund created) "Refund of ৳X,XXX marked as pending"

### Cancel Room modal (per-room early departure)

Accessible from Edit Booking modal → per-room row → "Early Check-Out" button when `booking_rooms.status === 'checked_in'`.

- Shows room details: Room 201 · Deluxe · original check-out Jul 15
- Date picker: "Actual departure date" (pre-filled today; must be ≥ check-in date)
- Computed deduction: `deducted_nights × booking_rate = ৳X,XXX` (live as date changes)
- If booking has payments: shows suggested refund amount (= share-ratio attribution × overpayment estimate) with override field and reason text box
- Two buttons: **Confirm Early Check-Out** | **Cancel**
- On confirm: calls `cancelBookingRoom(bookingRoomId, {actualCheckoutDate, deductionAmount, refundInput?})`

### Pending Refunds queue (admin only)

A widget on the **Payments / Finance** page (or a dedicated admin sub-page) showing all refunds with `status = 'pending'`, sorted by `created_at` ascending (oldest first).

Each row shows:
- Booking ref + room (if per-room) + guest name
- Amount · Reason · Date created
- Action button: **Mark Disbursed** (green) | **Deny** (grey)

Visible to admin role only; staff sees a read-only "Refunds pending" count badge.

### Mark Refund Disbursed modal

Opens when admin clicks **Mark Disbursed** on a pending refund row.

- Shows refund details: amount, reason, booking ref
- Dropdown: disbursement method (Cash / bKash / Nagad / Bank Transfer / Card)
- Optional notes field
- Button: **Confirm Disbursement**
- On confirm: calls `markRefundDisbursed(refundId, {disbursementMethod, disbursedBy, notes?})`
- Success toast: "Refund of ৳X,XXX marked as disbursed"

---

## 10. Phase Plan with Time Estimates

Estimates given as **optimistic / expected / pessimistic**. Use **expected** for planning.
Estimates include implementation and in-browser testing. They assume the developer is familiar with the codebase.

| Phase | Description | Opt / Exp / Pess | Notes |
|---|---|---|---|
| **0** | Design spec (this document) | complete | — |
| **1** | Schema migration SQL: write and test backfill in Supabase SQL editor (branch if available) | 2h / 3h / 4h | Longer if Supabase Branch is set up for safety |
| **2** | Apply migration to production DB: run DDL, backfill, verify, drop old columns, drop trigger | 1h / 2h / 2h | Short if Phase 1 SQL is solid; longer if unexpected data issues |
| **3** | Type system + backward-compat shims: add `BookingRoom`, `BookingExtraCharge`, update `MockBooking`, add `rooms[0]` shims, update `mapBooking()` | 3h / 4h / 5h | TypeScript errors from old field accesses will surface here |
| **4** | Service layer: update `BOOKING_SELECT`, rewrite `createBooking`, `updateBooking`, `checkout`, conflict detection | 5h / 7h / 9h | Most complex phase. Range is wide because RPC debugging can be slow |
| **5** | Booking creation UI: multi-room picker, per-room rate fields, live total preview | 3h / 4h / 5h | Design work + interaction detail; state management in form is non-trivial |
| **6** | Booking display + edit: list row, timeline modal, edit modal rooms section (without mid-stay ops) | 4h / 5h / 6h | Mostly rendering work; per-room edit state management adds complexity |
| **7** | Mid-stay operations: add room, remove room (early checkout), RPC wiring, UI flows | 5h / 7h / 9h | Second most complex phase. Status sync edge cases live here |
| **8** | Per-room extension | 2h / 3h / 4h | Simpler after Phase 7 plumbing exists |
| **8.5** | Cancellation + refund flow: `cancelBooking`, `cancelBookingRoom`, `refundsService.ts`, Cancel Booking modal, Cancel Room modal, Pending Refunds queue, Mark Disbursed modal | 3h / 4h / 5h | Builds on Phase 7 cancellation plumbing; mostly new UI components |
| **9** | Invoice + Reservation Details: per-room breakdown rendering | 2h / 2h / 3h | Mostly UI; data is already available from Phase 3+ |
| **10** | Edge cases + comprehensive testing: all 7 scenarios end-to-end, status transitions, free cancellation, refund workflows | 3h / 5h / 6h | Time varies with how many surprises appear |
| **11** | Final commits, push, CLAUDE.md update | 1h / 1h / 1h | — |

**Optimistic total:** ~34h — best case, everything goes smoothly  
**Expected total:** ~47h — use this for planning (a couple of debugging sessions, one RPC rewrite)  
**Pessimistic total:** ~59h — schema migration reveals data issues, status model has edge case bugs

At 5–6 focused hours per day: **6–7 days (optimistic) · 8–10 days (expected) · 10–12 days (pessimistic)**.

---

## 11. Risk Register

### HIGH — Schema migration on production data

**What could go wrong:** The backfill SQL has a bug, a constraint fails mid-run, or data in `bookings` violates assumptions (e.g., `booking_rate` is NULL for old rows, `room_category_at_booking` has an unrecognised value). Partial migration leaves the DB in an inconsistent state.

**Before migration:**
1. Export a full Supabase backup (Dashboard → Database → Backups → Download)
2. Write and test the full migration SQL on a local Postgres instance seeded with a `pg_dump` of production
3. Wrap the entire migration in an explicit transaction: `BEGIN; ... COMMIT;` — if anything fails, Postgres rolls back automatically

**If it happens anyway:**
- Restore from the backup taken in step 1
- Fix the bug in the migration SQL
- Re-run from scratch (idempotent DDL with `IF NOT EXISTS` / `IF EXISTS`)

---

### HIGH — Status sync between booking-level and room-level

**What could go wrong:** The sync rules (Section 5) have an edge case not accounted for. A booking ends up in `checked_in` when all rooms are `checked_out`. Or booking never advances to `checked_out` because one room's status is stuck.

**Before implementation:**
1. Write the sync rules as a pure function in TypeScript (`deriveBookingStatus(rooms: BookingRoom[]) → BookingStatus`) with unit tests
2. The Postgres RPCs duplicate the same logic — keep them in sync manually
3. Build a diagnostic tool (internal admin page) that shows any bookings where `bookings.status ≠ derived status` from room rows

**If it happens anyway:**
- Run a repair query: `UPDATE bookings SET status = ... WHERE id = ...` using the correct derivation
- The pure TypeScript function makes it easy to identify the correct value without guessing

---

### HIGH — 400+ field accesses during type migration

**What could go wrong:** `tsc` surfaces hundreds of errors when `bookings.check_in_date` and friends are removed from `BookingRow`. The app breaks site-wide while migration is in progress.

**Mitigation:**
- Phase 3 adds backward-compat shims BEFORE the service layer changes — the old field names still exist on `MockBooking` as getters returning `rooms[0]` data
- The codebase compiles clean after Phase 3 even though the DB columns are already gone
- Individual callsites are migrated in Phases 4–9 as each feature area is touched
- Never merge a phase that leaves `tsc` with errors

**If it happens anyway:**
- Revert to the last clean commit, add the missing shim, re-run

---

### MEDIUM — HotelContext optimistic updates with multi-room

**What could go wrong:** The optimistic state update in `HotelContext` updates `booking.roomNumber` but not `booking.rooms[]`, leaving the UI showing stale room data after an add/remove operation until a full refetch.

**Mitigation:** For multi-room operations, trigger a targeted re-fetch of the affected booking after the RPC returns, rather than relying on optimistic update + rollback. The optimistic pattern is most valuable for fast status changes (checkout, payment); add/remove are slower operations where a 300ms refetch is acceptable.

---

### MEDIUM — Conflict detection across multiple rooms

**What could go wrong:** Creating a booking with 3 rooms where Room A is available but Room B is already booked. The conflict check runs per-room — the first room passes, the second fails inside the RPC, the whole transaction rolls back cleanly. But the error message is generic.

**Mitigation:** The `create_booking_with_rooms` RPC should check all rooms for conflicts before inserting anything, returning a structured error listing which rooms are unavailable. The UI shows "Room 104 is unavailable for these dates" specifically.

---

### MEDIUM — Refund amount approximation accuracy

**What could go wrong:** The per-room refund suggestion uses `paid_attributed = total_paid × (room_total / booking_total)`. If rooms have very different rates, or if extra charges exist for specific rooms, the approximation may significantly over- or under-suggest the refund amount. Staff may not notice and disburse the wrong amount.

**Mitigation:**
- The amount field is always editable — staff must actively confirm the number
- Add a tooltip on the suggested amount: "Approximated from your payment share. Edit if needed."
- For post-checkout cancellations (partial refunds after extra charges), the service layer should warn when `extra_charge_amount > 0` and suggest manual review

**If it happens anyway:**
- The `refunds` table stores the actual disbursed amount and the reason — there is an audit trail
- A correction can be made by denying the incorrect pending refund and creating a new one with the correct amount (before disbursement)

---

### MEDIUM — No undo for disbursed refunds

**What could go wrong:** Admin clicks "Mark Disbursed" on the wrong refund row, or enters the wrong disbursement method. Once `status = 'disbursed'`, there is no UI to reverse it.

**Mitigation:**
- The Mark Disbursed modal requires explicit confirmation and shows the full refund details before confirming
- Disbursement is a record-keeping action, not a financial transaction — the actual money movement (e.g., bKash transfer) happens outside the app. Marking it disbursed incorrectly is an audit error, not a financial loss.
- If caught quickly, an admin can correct it by direct DB update — document this in the staff manual

**If it happens anyway:**
- Add a "Reopen" action (admin only) that resets `status = 'pending'` and nulls `disbursed_at/by` — deferred to post-launch if needed

---

### LOW — RPC function debugging

**What could go wrong:** A Postgres PL/pgSQL bug in the RPC is hard to debug compared to JavaScript.

**Mitigation:** Test each RPC individually in Supabase SQL Editor with `SELECT create_booking_with_rooms(...)` before wiring to the app. Keep RPC bodies simple — complex business logic stays in the service layer; the RPC is only for atomicity.

---

## 12. Test Plan

### Phase 1–2 (Schema migration)

- [ ] All existing bookings have exactly one `booking_rooms` row (count check)
- [ ] All bookings with `extra_charge_amount > 0` have exactly one `booking_extra_charges` row
- [ ] No booking lost its `total_amount` value
- [ ] `booking_rooms.check_in_date` and `bookings.check_in_date` (before drop) match for all rows
- [ ] Dropped columns are gone; schema matches `sql/schema/02-tables.sql` updated version

### Phase 3 (Types + shims)

- [ ] `tsc --noEmit` passes with zero errors
- [ ] Existing single-room booking display unchanged in browser
- [ ] `booking.roomNumber` returns correct room number via shim
- [ ] `booking.checkInISO` returns correct date via shim

### Phase 4 (Service layer)

- [ ] `createBooking` still works for single-room (backward compat wrapper)
- [ ] `createBookingWithRooms` with 2 rooms creates 1 booking + 2 `booking_rooms` rows
- [ ] Conflict detection correctly rejects overlapping dates for a room already in `booking_rooms`
- [ ] `checkoutNormal` with single room: room → cleaning, booking → checked_out
- [ ] `checkoutNormal` with 2 rooms: first checkout leaves booking in checked_in, second checkout advances to checked_out

### Phase 5–6 (Creation + display)

- [ ] Create booking with 3 rooms: correct total shown, all 3 rooms reserved
- [ ] Booking list row shows "201, 104, 107" room numbers
- [ ] Invoice shows 3 separate room line items with correct subtotals
- [ ] Edit modal shows rooms table; can change rate on a room; total recalculates

### Phase 7 (Mid-stay)

- [ ] Scenario 2: Add Room 203 to BK-2002 mid-stay — total increases, Room 203 goes to occupied
- [ ] Scenario 3: Remove Room 305 from BK-2003 mid-stay — total decreases by correct amount, Room 305 goes to cleaning, booking stays checked_in
- [ ] Adding a room that's already in the booking is rejected with a clear error

### Phase 8 (Extension)

- [ ] Scenario 5: Extend Room 502 by 2 nights — total increases by correct amount, Room 501 checked out, booking stays checked_in
- [ ] Extending a checked-out room is rejected

### Phase 9–10 (Docs + edge cases)

- [ ] All 5 scenarios end-to-end: create → operate → invoice → checkout → correct final state
- [ ] Free cancellation: confirm-then-cancel booking with 3 rooms → total = ৳0, all rooms available
- [ ] Same-day checkout after check-in: 1 night charged, not 0
- [ ] Payment made equal to total → payment_status = paid; then extra charge added → true_due > 0 but payment_status still shows correctly in list (triggers bug — document, don't block)

---

## 13. Out of Scope

These items are explicitly excluded from this implementation. Each would be a standalone feature.

| Item | Why deferred |
|---|---|
| Per-room payment tracking | Adds per-room financial state, receipt splitting, complex payment allocation logic — a separate module. Per-room refund amounts are approximated via share-ratio in this implementation (see Section 4 — Refund Calculation). |
| Separate invoices per room | Depends on per-room payment tracking; no operational request for this yet |
| Mixed-currency bookings | No multi-currency requirement; all rooms in one booking use BDT |
| Different primary guests per room | Would require a guest-per-room relationship and separate check-in/check-out identity flows |
| Group bookings across separate reservations | N linked bookings is a different concept from 1 booking with N rooms; deferred |
| Room reassignment mid-stay | Moving a guest from Room 201 to Room 305 is a swap, not an add/remove; deferred |
| Discounts scoped to a specific room | booking_extra_charges has no "negative amount" row; add a discount_amount column to booking_rooms when needed |
| Housekeeping queue per room | Tracked separately under Intentionally Deferred in CLAUDE.md |
| No-show handling for multi-room | Depends on no-show status enum addition (tracked in CLAUDE.md Known Issues) |
| Pending Refunds admin queue as a dedicated page | Phase 8.5 implements a widget (inline on Finance/Payments page). A dedicated full-page queue with filters, export, and bulk actions is deferred until operational need is confirmed. |
| Refund as credit toward future booking | Requires a credit balance system and a credit-apply step at booking creation — significant scope; deferred |
| Partial damage refunds (refund < damage deposit) | No damage deposit system exists yet; the refund model is designed to accommodate it (bookingRoomId nullable) but the UI and deposit flow are out of scope |
| Automatic refund disbursement via bKash / payment API | Would require bKash Business API integration and webhook handling for disbursement confirmation — a separate payment integration project |

---

*End of design specification. This document should be updated at the start of each phase with any decisions that changed, and marked "Phase N complete" in each section's header once implemented.*
