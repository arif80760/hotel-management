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
| Cancel whole booking (atomic) | `cancel_booking()` | No | Phase 8.6, 4 refund INSERTs in migration |
| Cancel per-room (atomic) | `cancel_booking_room()` | No | Phase 8.6, same migration |
| Cancel whole booking (pending refund) | `cancel_booking()` (no disbursement params) | Partial — header confirms refund row created, not yet confirmed if payment is INSERTed |
| Cancel per-room (pending refund) | `cancel_booking_room()` | Partial — same |
| Extend booking room | `extendBookingRoom()` → unknown RPC | No | May not touch payments at all |
| Add room to booking | `addRoomToBooking()` | No | Changes total; payments effect unknown |
| Apply discount at checkout | covered above (step 3.5/3.6 of `checkout_booking`) | Yes | Only touches payments via overpayment path |
| Apply discount post-booking | Two May-16 migrations | No | `discount-in-rpc` + `fix-discount-by-type` |
| Update booking (generic) | `updateBooking()` | No | ~460-line function |

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

### Resolved questions about the proposed fix

**Q1: What if a pre-adjustment refund gets denied (not disbursed)?**
*Resolved 2026-05-23:* The pre-adjustment payment row stays forever with
`method = 'other'`. The daybook never records the financial event — which
is correct, because no money physically moved. The cash entered Cash in
Hand on the original guest payment (correctly recorded by `recordPayment`
→ trigger) and stayed there. Denied refunds are accounting markers for
gift/tip tracking on the refunds table itself, not bucket movements.
Daybook owes nothing here. Interpretation 1.

### Open questions about the proposed fix

1. **Cancellation flows with atomic disbursement (Phase 8.6).** When
   `cancel_booking` is called with disbursement params, does it use
   `pre_adjusted = TRUE` or `FALSE`? The trigger's behavior is different
   for each.
2. **Other UPDATE paths.** Are there any code paths that UPDATE `payments`
   for reasons OTHER than refund disbursement? If yes, our UPDATE branch
   needs to ignore them.

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

---

## Next investigation steps

1. **Read Phase 8.6 migration** — `cancel_booking()` and `cancel_booking_room()`,
   both pending-refund and atomic-disbursement branches. Confirm `pre_adjusted`
   value used in each branch.
2. **Read `extendBookingRoom`** — TS wrapper and its RPC. Confirm whether it
   touches `payments` at all.
3. **Read the two May-16 discount migrations** — post-booking discount path,
   if it exists, may write to refunds (and via refunds to payments).
4. **Spot-check `updateBooking`** — large function, but should be a quick scan
   for any `.from("payments")` or `INSERT INTO payments`.
5. **Spot-check `addRoomToBooking`** — same — does it touch payments?

After steps 1-5, the trigger design is final and we can create the migration files.
