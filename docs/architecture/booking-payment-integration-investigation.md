# Booking-Payment Integration — Investigation Findings

**Status:** In progress (Day 18, 2026-05-23).
**Purpose:** Trace every code path that writes to `public.payments` so the
booking-payment integration's account_transactions trigger handles every
case correctly. This document is the input to the integration's final design.

---

## Why this document exists

On Day 17 (2026-05-21), we designed a trigger for the booking-payment
integration assuming `payments` is written via INSERT + DELETE only.
Just before running migrations, Arif flagged that the booking system
has more flows than we'd mapped — refund, early checkout, extension,
discount.

Day 18's investigation pass confirmed his concern was warranted. The
first scenario alone (refund) revealed an UPDATE path we'd missed
that would silently route money to the wrong daybook bucket. This
document captures findings as the investigation continues.

---

## Code paths that write to `public.payments`

### 1. `recordPayment()` — TS service, `bookingsService.ts:1406`

Called from 5 UI sites (FrontDeskClient × 3, BookingsClient × 2).
INSERTs a payment row with:
- `amount > 0` (positive — guest payment, inflow)
- `method` = one of cash / card / bank_transfer / bkash / nagad / online / other
- `recorded_by` = current user
- `notes` = optional
- `refund_id` = NULL (never refund-linked)

**Trigger response (drafted):** Standard INSERT branch.
`revenue_in`, `to_account_id = bucket(method)`, `amount = NEW.amount`.

### 2. `checkout_booking()` — SQL function, `07-functions.sql:139` (full read 2026-05-23)

Multi-step RPC. Money-movement happens at step 3.5 only:
- If overpayment detected (`paid_amount > effective_total`):
  - INSERT INTO `refunds` with `pre_adjusted = TRUE`, status `pending`.
  - INSERT INTO `payments` with:
    - `amount = -overpayment` (negative)
    - `method = 'other'` (hardcoded — see notes below)
    - `refund_id = <id of the refund row just created>`
    - `notes = 'Auto-refund pre-adjustment — refund row ...'`

**Critical:** this payment row represents money that **has NOT physically left
a bucket yet.** The refund is still `pending`. The negative amount exists
solely to decrement `paid_amount` and satisfy `chk_paid_not_exceed_total`
when `update_booking_total()` runs later in the RPC.

**Method = `'other'`** is intentional — `'other'` is a placeholder. The real
disbursement method is unknown at checkout time. When the refund is later
disbursed, `disburse_refund()` UPDATEs this row's `method` to the actual
method.

### 3. `disburse_refund()` — SQL function, current authoritative version in `2026-05-15-phase11-58a-overpayment-auto-refund.sql` Section 4 (read 2026-05-23)

Branches on `refunds.pre_adjusted`:

**Path A (pre_adjusted = TRUE) — auto-refund disbursement:**
- UPDATE the existing pre-adjustment payment row (matched by `refund_id`):
  - `method` ← actual disbursement method
  - `notes` ← updated
- No INSERT. No `paid_amount` cascade (already decremented at checkout).

**Path B (pre_adjusted = FALSE) — cancellation-refund disbursement:**
- INSERT a new negative payment row with the actual disbursement method.
- `trg_sync_paid_amount` fires, decrements `paid_amount`.

`p_disbursement_method` is restricted to: cash, bkash, nagad, bank_transfer, card.
(5 methods, not 7 — the enum has more values but `disburse_refund` rejects
`online` and `other`.)

### 4-N. Other paths — not yet investigated

| Scenario | Function | Investigated? | Notes |
|---|---|---|---|
| Cancel whole booking (atomic) | `cancel_booking()` (Branch C) | **Yes (2026-05-23)** | INSERT-only into payments. `refund_id` NULL. `pre_adjusted` defaults to FALSE. Trigger fires normally. |
| Cancel per-room (atomic) | `cancel_booking_room()` (Branch C) | **Yes (2026-05-23)** | Same as above. |
| Cancel whole booking (pending refund) | `cancel_booking()` (Branch B) | **Yes (2026-05-23)** | No payment row inserted. Daybook neutral (correct — money hasn't moved). |
| Cancel per-room (pending refund) | `cancel_booking_room()` (Branch B) | **Yes (2026-05-23)** | Same as above. |
| Extend booking room | `extend_booking_room()` RPC (Phase 7) | **Yes (2026-05-23)** | Zero payment writes. Updates booking_rooms + bookings.total_amount only. Guest pays later via `recordPayment`, fires trigger normally. |
| Add room to booking | `add_room_to_booking()` RPC (Phase 7) | **Yes (2026-05-23)** | Zero payment writes. Same pattern as extension — booking_rooms INSERT + update_booking_total only. |
| Apply discount at checkout | step 3.5/3.6 of `checkout_booking` | **Yes** | Only touches payments via overpayment path (the pre-adjustment case already mapped). |
| Apply discount post-booking | Two May-16 migrations | **Yes (2026-05-23)** | Both are revisions of `checkout_booking` itself. Same step 3.5 overpayment INSERT pattern. No new write paths. |
| Update booking (generic) | `updateBooking()` (TS, 877-1339) | **Yes (2026-05-23)** | Zero `.from("payments")` / `.from("refunds")` hits inside line range. Payment-neutral. |
| Create booking with initial payment | `create_booking_with_rooms()` RPC | **Yes (2026-05-23)** | INSERT into payments at booking creation if `p_initial_payment > 0`. `refund_id = NULL`, real method. **Same pattern as `recordPayment()` — normal inflow, trigger fires normally.** |

---

## Architectural picture (so far)

Every write path into `public.payments`:

1. **INSERTs with `refund_id = NULL`** — `recordPayment()` (positive), `create_booking_with_rooms()` initial-payment (positive), Phase 8.6 cancellation Branch C (negative), `disburse_refund` Path B (negative). All have a real `method` that maps to a real bucket. **Trigger fires normally; daybook gets a correctly-bucketed row.** ✓
2. **INSERTs with `refund_id = <uuid>`** — only `checkout_booking()` step 3.5 (pre-adjustment from overpayment, `method = 'other'`). This is the *only* producer of `refund_id`-linked INSERTs. **Trigger should skip — money hasn't physically moved.**
3. **UPDATEs** — only `disburse_refund()` Path A (the matching pre-adjustment row gets its method UPDATEd from `'other'` to actual). **Trigger should fire on this specific UPDATE and write the daybook row at the actual disbursement bucket.**
4. **DELETEs** — only manual SQL Editor cleanup. **Trigger DELETE branch removes the matching daybook row.**

The full discriminator set:
- `INSERT … refund_id IS NULL` → write daybook (the common case)
- `INSERT … refund_id IS NOT NULL` → skip (pre-adjustment, money pending)
- `UPDATE … OLD.refund_id IS NOT NULL AND OLD.method = 'other' AND NEW.method <> 'other'` → write daybook now (disbursement happened)
- `UPDATE` (any other) → skip
- `DELETE` → cascade-delete the matching daybook row

This is the design the trigger needs to implement. As of 2026-05-23,
the investigation is complete — every write path into `public.payments`
has been traced and accounted for. No further unknowns.

---

## Trigger design implications

### What our originally-drafted trigger gets right

- Path B (cancellation refund disbursement): INSERT fires, daybook
  records `expense_out` to the correct bucket. ✓
- Normal `recordPayment()` flow: INSERT fires, daybook records
  `revenue_in` to the correct bucket. ✓
- DELETE coverage: existing trigger DELETE branch removes daybook row.
  Covers manual SQL-editor cleanup of test rows. ✓

### What our originally-drafted trigger gets wrong (Path A)

**At checkout time** (overpayment INSERT, method `'other'`, refund_id set):
- Our trigger writes a daybook `expense_out` row to **Bank** (the `'other'` mapping).
- **Wrong** — money hasn't physically left any bucket. The refund is pending.

**At disbursement time** (`disburse_refund` UPDATEs the row, method `'other'` → `'cash'`):
- Our trigger does **not** fire (we excluded UPDATE).
- Daybook row stays as `expense_out` from Bank.
- **Wrong** — money actually left Cash in Hand.

Result: daybook has the right total outflow but the wrong bucket
attribution, indefinitely. For a daybook whose purpose is bucket-level
truth, that's the failure mode that matters most.

### Proposed fix for Path A

Add UPDATE coverage to the trigger with refund_id-aware logic:

```sql
-- INSERT branch (revised):
IF NEW.refund_id IS NOT NULL THEN
  -- Pre-adjustment row at checkout time. Money hasn't moved.
  -- Skip writing the daybook row — wait for disbursement UPDATE.
  RETURN NEW;
END IF;
-- ... existing INSERT logic for non-refund-linked payments

-- UPDATE branch (new):
-- Fire when a pre-adjustment payment gets its method changed
-- (i.e., disburse_refund flipped method from 'other' to actual).
IF OLD.method <> NEW.method AND NEW.refund_id IS NOT NULL THEN
  v_bucket_id := <bucket from NEW.method>;
  INSERT INTO account_transactions ( ...expense_out, from = v_bucket_id... );
END IF;

-- DELETE branch: unchanged.
```

This handles Path A correctly *and* preserves Path B and the normal
inflow path.

### Resolved questions

**Q1 (resolved 2026-05-23): What if a pre-adjustment refund gets denied (not disbursed)?**
The pre-adjustment payment row stays forever with `method = 'other'`.
The daybook never records the financial event — which is correct,
because no money physically moved. The cash entered Cash in Hand on
the original guest payment (correctly recorded by `recordPayment` →
trigger) and stayed there. Denied refunds are accounting markers for
gift/tip tracking on the refunds table itself, not bucket movements.
Daybook owes nothing here. Interpretation 1.

**Q2 (resolved 2026-05-23): Phase 8.6 atomic-disburse uses `pre_adjusted = FALSE`.**
All four `INSERT INTO refunds` sites in
`2026-05-09-phase8.6-atomic-cancel-with-disbursement.sql` omit the
`pre_adjusted` column entirely. The column's schema default is
`BOOLEAN NOT NULL DEFAULT FALSE` (verified directly in the Phase 11-58a
migration), so all four refund INSERTs land with `pre_adjusted = FALSE`.

The two Phase 8.6 payment INSERTs (Branch C in each cancellation RPC)
also omit `refund_id` from the column list, so it defaults to NULL.

Result: Phase 8.6 payment INSERTs are indistinguishable from
`recordPayment()` outflows from the trigger's point of view —
`refund_id IS NULL`, real `method`, real `recorded_by`. Trigger
fires normally and the daybook gets a correctly-bucketed row.

**Q3 (resolved 2026-05-23): No UPDATE-payments paths exist outside
`disburse_refund` Path A.** Verified definitively via codebase-wide
grep: one `UPDATE public.payments` site exists, on line 569 of
`2026-05-15-phase11-58a-overpayment-auto-refund.sql` — the
`disburse_refund` Path A branch (Section 4). Zero `UPDATE` paths in
`services/` or `app/`. Our trigger's UPDATE branch can narrowly target
this one pattern.

---

## Investigation log

- **2026-05-23, ~midday:** Read `checkout_booking` in full (`07-functions.sql:139`).
  Confirmed step 3.5 overpayment path. Discount semantics (step 3.6) clean —
  discount is just a parameter; doesn't write to payments directly.
- **2026-05-23, ~midday:** Read `disburse_refund` Section 4 in full.
  Confirmed UPDATE-not-INSERT for pre_adjusted=TRUE path. This is the finding
  that blocks the original trigger design.
- **2026-05-23, ~midday:** Resolved Q1 on denied refunds — no daybook trace
  needed (Interpretation 1).
- **2026-05-23, afternoon:** Read Phase 8.6 migration header + four Branch B/C
  slices. Resolved Q2 (`pre_adjusted = FALSE` in all 4 refund INSERTs;
  `refund_id = NULL` in both Branch C payment INSERTs). Resolved Q3 (no UPDATE
  paths to `payments` in Phase 8.6). Architectural picture section added.
- **2026-05-23, afternoon:** Verified extension RPC body (`extend_booking_room`
  Phase 7 version): zero payment writes. Updates booking_rooms + bookings only.
- **2026-05-23, afternoon:** Verified two May-16 discount migrations: both are
  iteration-intermediate revisions of `checkout_booking`'s step 3.5 — no new
  write paths.
- **2026-05-23, afternoon:** Spot-checked `updateBooking` (lines 877-1339):
  zero `.from("payments")` / `.from("refunds")` hits. Payment-neutral.
- **2026-05-23, afternoon:** Spot-checked `add_room_to_booking` (Phase 7
  version): zero payment writes. Same pattern as extension.
- **2026-05-23, afternoon:** Codebase-wide closing-out grep surfaced one
  unaccounted write path: `create_booking_with_rooms` (initial payment INSERT
  at booking creation). Added to the architecture picture as a `refund_id = NULL`
  inflow producer — same flow as `recordPayment`.
- **2026-05-23, late afternoon:** Investigation complete. All payment-write
  paths mapped. Production data shape verified (105 total payment rows: 95
  inflows ৳462,500, 7 outflows ৳-39,500, 2 disbursed pre-adjustments ৳-10,000,
  1 pending pre-adjustment ৳-2,000).

---

## Migration plan

The investigation is complete. The trigger design is final (see "Architectural
picture" section above). Two migration files to draft:

### Migration A (backfill) — revised condition

Backfill all historical payment rows EXCEPT pending pre-adjustments. The
exclusion condition: `WHERE NOT (refund_id IS NOT NULL AND method = 'other')`.

Based on production data shape (1 pending pre-adjustment at the time of
investigation), backfill will produce 104 daybook rows from 105 payment rows.
The 1 excluded row will get its daybook entry later when its refund is
disbursed — at which point the trigger's UPDATE branch fires.

### Migration B (trigger) — revised body

Implements the full discriminator set:
- INSERT with `refund_id IS NULL` → write daybook row (the common case).
- INSERT with `refund_id IS NOT NULL` → skip (pre-adjustment, money pending).
- UPDATE where `OLD.method = 'other' AND NEW.method <> 'other' AND NEW.refund_id IS NOT NULL` → write daybook row using NEW.method bucket (pre-adjustment disbursement).
- DELETE → cascade-delete the matching daybook row by `booking_payment_id`.

**Status:** Migrations to be drafted next, then verbatim-reviewed. Running
deferred to a fresh shift (not end-of-day Saturday).
