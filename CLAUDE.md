# CLAUDE.md — Hotel Management System

Last updated: 2026-06-09 (rev 25)

> **rev 19** — Removed the cleaning/maintenance lifecycle from the dashboard Room Board. Checkout now releases a room straight to Available (`checkoutNormal`/`checkoutWithOverride` set the physical room Available and optimistically mark `booking_rooms` Checked Out). `lib/roomStatus.deriveRoomStatusForDate` no longer special-cases Cleaning/Maintenance — the board shows only Available/Reserved/Occupied, derived from bookings; summary/legend trimmed to those three.
>
> **rev 22** — Completed the Cleaning/Maintenance removal end-to-end. `RoomStatus` union narrowed to `Available | Occupied | Reserved`. Removed Cleaning/Maintenance from `RoomsClient` filters/badges/dots, `RoomBoard` STATUS config and `statusCounts` initialiser, `canDeleteRoom` guard, and all three seed rooms. `bookingToRoomStatus["Checked Out"]` changed to `"Available"` (was `"Cleaning"` — the last live write path). DB RPC `2026-06-08-drop-cleaning-checkout-frees-room.sql` backfills and rewires all three checkout RPCs. The KNOWN FOLLOW-UP from rev 19 is now resolved.
>
> **rev 23** — Server-side admin enforcement for the checkout override. New trigger `trg_enforce_override_is_admin` (`fn_enforce_override_is_admin`, SECURITY DEFINER) on `bookings`: when `override_checkout` flips on, the write is rejected unless `auth.uid()` maps to an admin in `profiles`, and `override_by`/`override_at` are stamped server-side rather than trusted from the client. Service-role / no-token contexts (migrations, SQL editor) are exempt. Migration `2026-06-08-enforce-override-admin.sql`. KNOWN FOLLOW-UP: `bookings` RLS still lets any authenticated user update/delete any row — broad role-based RLS hardening remains a separate task.
>
> **rev 24** — Added the no-show booking lifecycle. New `no_show` `booking_status` value and `mark_booking_no_show(uuid)` RPC (flips a confirmed booking and its rooms to `no_show`, keeps the amount paid as a forfeited deposit, and waives the remaining balance via the `additional_discount` fields). Wired end-to-end on the frontend: the `BookingStatus` union, the three DB↔UI status maps, `derivePaymentStatus`, and `deriveRoomStatusForDate` (a no-show room reads Available); a `markBookingNoShow` service fn + HotelContext wrapper; and in `BookingsClient` an amber No Show badge, a No Show filter tab, and a "Mark no-show" action with a confirm modal. The duplicate status-badge maps in `FrontDeskClient` and `app/page.tsx` also got the No Show entry. Analytics RPCs `room_analytics_by_room` and `room_occupancy_trend` now exclude `no_show` so it never inflates occupancy or room revenue. Migrations `2026-06-09-no-show-feature.sql` and `2026-06-09-no-show-exclude-from-analytics.sql`.
>
> **rev 25** — First-tier RLS hardening on bookings. Direct DELETE on `bookings` and `booking_rooms` is now admin-only: added a SECURITY DEFINER `public.is_admin()` helper and replaced the wide-open "Authenticated can delete ..." policies with `USING (public.is_admin())`. SELECT/INSERT/UPDATE stay open to authenticated because the write RPCs (`create_booking_with_rooms`, `add_room_to_booking`, `cancel_booking`, `checkin_booking_atomic`) are SECURITY INVOKER and depend on them; cancellation is a status UPDATE, and no function deletes these rows, so the lock breaks nothing. Migration `2026-06-09-bookings-delete-admin-only.sql`. KNOWN FOLLOW-UP: full role-based hardening (column-level limits on what staff may change; converting the invoker RPCs to SECURITY DEFINER with internal role checks so INSERT/UPDATE can also be tightened) is still open.
> **GiST EXCLUDE constraint**: a `daterange` exclusion constraint would be the ideal DB-level backstop but is deferred to pre-launch test-data cleanup (existing rows with gaps/overlaps would block the constraint creation).

### Role Permissions
| Action | staff | admin |
|---|---|---|
| View all pages | ✅ | ✅ |
| Create booking | ✅ | ✅ |
| Check in / Cancel | ✅ | ✅ |
| Add payment during stay | ✅ | ✅ |
| Add payment before check-in | ❌ | ✅ |
| Normal checkout (paid) | ✅ | ✅ |
| Override checkout (unpaid) | ❌ | ✅ |
| Manage employees | ❌ | ✅ |
| Provision new user accounts | ❌ | ✅ |
| View/manage loans | ❌ | ✅ |

### Guest Find-or-Create
When creating a booking, the service looks up guests by phone number:
1. If found → use existing guest UUID
2. If not found → create minimal profile (name + phone + placeholder email `{phone_digits}.noemail@hotel.local`)

### Employee Provisioning (server-only)
`POST /api/employees/provision` uses the Supabase admin client to atomically create auth.users + employees + profiles with rollback on failure.

---

## 6. Coding Conventions

### File Naming
- Pages: `app/[section]/page.tsx` + `app/[section]/[Section]Client.tsx`
- Services: `services/[entity]Service.ts`
- Contexts: `contexts/[Name]Context.tsx`
- All files: camelCase for variables, PascalCase for components/types

### TypeScript Patterns
- Services define a `*Row` type (DB shape) + `map*()` function (DB→frontend) + optional `to*Payload()` (frontend→DB)
- Enum fields: DB stores lowercase; frontend may use typed string unions
- For Supabase embedded relations (`.select("..., loans(lender_name)")`), the result is **always an array** (`{ lender_name: string }[]`), not a singular object — use `row.loans?.[0]?.lender_name ?? null` in mappers
- **`PaymentMethod`** type: `"cash" | "card" | "bank_transfer" | "bkash" | "nagad"` — use `formatPaymentMethod()` for display

### DB ↔ Frontend Field Mapping
| DB column | Frontend field |
|---|---|
| booking_ref | id |
| room_number | roomNumber |
| price_per_night | price |
| check_in_date | checkIn |
| paid_amount | amountPaid |
| total_guests | totalGuests |
| pack_label | packLabel |
| units_per_pack | unitsPerPack |
| lender_name | lenderName |

### Date Handling
- DB stores ISO dates: `"2026-04-22"`
- UI displays: `"Apr 22, 2026"`
- Always append `T12:00:00` when parsing ISO dates — avoids UTC midnight timezone rollback

### Error Handling Pattern
Every service function logs every field of a `PostgrestError` individually (`.message`, `.details`, `.hint`, `.code`) because browser console collapses objects to `"{}"`. Always throw a proper `Error`, not the raw PostgrestError.

### Optimistic Update Pattern (HotelContext)
```
1. Capture current state for rollback
2. Apply optimistic update to React state immediately
3. Call service function async in background
4. On .catch(): roll back state + log error
```

### HMR Singleton (Supabase client)
```typescript
const g = globalThis as typeof globalThis & { _supabase?: SupabaseClient };
if (!g._supabase) g._supabase = createBrowserClient(...);
export const supabase = g._supabase;
```

### Component State Patterns
- Modal open/close: separate `null | EntityType` state (null = closed, entity = open + pre-filled)
- `checkoutOpenedAt` set when modal opens — never at render time
- Form validation: inline error strings in state, cleared on input change
- Unit toggle: `"pack" | "base"` state, default `"pack"`, reset to `"pack"` on modal close

### Number Input Styling
Use `tabular-nums` class on all currency/number display elements.

### Modal z-index Hierarchy
| Tier | Class | Used for |
|---|---|---|
| z-40 | `z-40` | Toasts, dropdowns, floating panels |
| z-50 | `z-50` | Primary modals |
| z-60 | `z-[60]` | Confirmation dialogs over a primary modal |
| z-70 | `z-[70]` | Critical alerts (reserved) |

### Standalone Document Routes
Pages that must print cleanly are excluded from Sidebar + TopBar via `isStandaloneDocument` in `AppShell.tsx`:
```
/^\/bookings\/[^/]+\/(invoice|reservation)$/
```

---

## 7. Important Rules

### Never Break Existing Flow
- Do not change the booking creation, check-in, check-out, payment, or override flows unless explicitly asked
- Do not remove or rename context functions — other components depend on them
- Do not change DB column names without updating the corresponding service mapping

### Never Redesign UI Unnecessarily
- Improve logic at the logic level, not by restructuring the component tree
- Keep the existing color scheme, spacing, and card layout patterns

### Admin Client Is Server-Only
- `lib/supabaseAdmin.ts` uses the service-role key — NEVER import it in client components
- Only use it in `app/api/` route handlers

### Supabase Embedded Relation Is Always an Array
- `.select("..., loans(lender_name)")` returns `loans: { lender_name: string }[] | null`
- Always use `row.loans?.[0]?.fieldName ?? null` in mappers — never treat as singular object

### Inventory Stock Is Always in Base Units
- Pack quantities are converted to base units **client-side** before any service write
- `toBaseQty` pattern: `upp != null && unit === "pack" ? packQty * upp : packQty`
- Never store pack quantities in `inventory_movements.quantity`

### Resolved Issues
- **[Resolved Day 2 Block 3] `recordPayment()` cap now uses true-due formula**: Mirrors `calcTrueDue()`. Previous naive formula (`total_amount − paid_amount`) silently dropped payments when `extra_charge_amount` existed.

### Known Issues / Technical Debt

#### Synthetic optimistic IDs in checkout guards
Location: `contexts/HotelContext.tsx` — `checkoutNormal` / `checkoutWithOverride`

Optimistic `BookingRoom` entries carry IDs of the form `"optimistic-BK-XXXX-room-i"` and `roomId: ""`. The checkout guard correctly bails when `bookingRoomId` is empty string. However, the guard doesn't produce a friendly "booking is still being saved, please wait" message.

**Future improvement**: `isOptimisticBookingRoom(room: BookingRoom): boolean` predicate.

#### ~~Dashboard occupancy showed 0 while Room Board showed correct counts~~ ✅ Resolved
`DashboardStats` and `page.tsx` were reading `rooms.status` (physical DB column) for Occupied/Available counts. That column lags behind booking state, so the KPI cards and Occupancy-by-Floor showed 0% while the Room Board (which derives status from bookings via `deriveRoomStatusForDate`) showed the true counts. Both dashboard surfaces now call `deriveRoomStatusForDate` from `lib/roomStatus.ts`. The hardcoded `["Floor 1"…"Floor 4"]` floor list was also replaced with a live-derived, numerically-sorted list so all floors show up automatically.

#### Known Bug — fn_sync_payment_status doesn't account for extras
Location: `sql/schema/05-triggers.sql`

Trigger compares `paid_amount >= total_amount` but does NOT include `extra_charge_amount`, `early_deduction_amount`, or `additional_discount_amount`. Fix:
```sql
paid_amount >= (total_amount
                + COALESCE(extra_charge_amount, 0)
                - COALESCE(early_deduction_amount, 0)
                - COALESCE(additional_discount_amount, 0))
```
Priority: Medium.

#### Known Bug — fn_sync_paid_amount doesn't handle UPDATE/DELETE
Location: `sql/schema/05-triggers.sql`

Fires only on INSERT. Direct DB edits of `payments` table will break `bookings.paid_amount`. Currently safe because app code never UPDATEs/DELETEs payment rows.

#### `createLoan` atomicity gap
Two sequential Supabase writes (INSERT loans → INSERT account_transaction). Compensating DELETE on loans row if txn insert fails. Same gap exists for `createBooking` (booking + payment) and expense + inventory purchase movement writes. True fix requires a Postgres RPC wrapping writes in a transaction.

#### Stale "Confirmed" booking handling (planned)
When today > `check_in_date` and status is still `"Confirmed"`. Planned: add `no_show` status enum, `isStaleConfirmed()` helper, stale banner in edit modal, "Mark as No-Show" action.

#### ~~Loans repayment history UI not surfaced~~ ✅ Resolved
`getLoanRepayments()` is now wired up in `LoansClient.tsx` — each loan row expands an inline `RepaymentTimeline` with per-repayment rows and a running balance.

#### Maintenance flag does not block bookings
`room.status === "Maintenance"` is display-only. Booking overlap check ignores room status.

---

## 8. Workflow Notes

### Workflow that works for me

1. New major feature → start a new chat with Claude.ai, paste this CLAUDE.md as the first message
2. Always: ask Claude.ai to plan before Claude Code writes any code
3. Always: review diffs before approving each step
4. Always: test in browser before committing
5. Always: split commits by concern, write professional messages
6. After a feature ships: update CLAUDE.md, commit docs separately
7. When the chat starts feeling slow or off-topic, start a fresh chat. Paste CLAUDE.md at the start of every new chat.

---

## 9. Current State

### Complete
- Auth with role-based access (admin / staff)
- Rooms CRUD with live Supabase data
- Bookings full lifecycle (create → check-in → checkout) with Supabase
- Front Desk daily operations view
- Guests module with profiles
- Employees module with server-side provisioning
- Booking documents (upload/preview/delete via Supabase Storage)
- Payments (3-layer enforcement, DB trigger sync)
- Discount/rate system (fixedRate vs bookingRate)
- Admin override checkout with audit fields
- Stay Timing Step 1 + Step 2 (early deduction + additional discount)
- Dynamic Room Board (Block 2) — date-navigable room grid
- Invoice + Reservation Details (Block 3) — printable A4 documents
- Booking Edit (Feature B) — in-place edit, risky-edit confirmation, optimistic update
- **Accounts / Cashbook** — all transaction types, filters by date, soft-delete, balances sidebar, lender name on loan rows
- **Expense recording** — expense modal with category + optional inventory purchase seam (pack/base toggle)
- **Revenue management** — manual revenue entry (`app/accounts/revenue-management/`, hyphenated; `revenueService` + `revenueCategoriesService`, uses the `revenue_category_id` column)
- **Revenue report** — read-only analytics at `/accounts/revenue-report` (admin-guarded): date-range presets, totals/entries/avg-per-day, by-source (Room/Booking + manual categories), by-bucket, daily/monthly trend, transaction list; linked in the sidebar under Accounts
- **Payroll** — payroll entry page
- **Inventory** — full CRUD for items (low-stock threshold, pack config), stock movements (purchase, consumption, adjustment), stock-level display
- **Inventory multi-unit pack support** — `pack_label` + `units_per_pack` on items; box/piece toggle in Add Stock modal and expense purchase seam; base unit conversion before all writes
- **Loans (Stage 6)** — loans register (read-only, 7-column table, outstanding pill), `LoanEntryActions` toolbar widget in cashbook (Loan received + Loan repayment modals), admin-only RLS, lender name surfaced in cashbook rows. Each loan row is now clickable and expands an inline `RepaymentTimeline` panel showing every repayment with date, account paid from, amount (−৳), and running balance after; loaded lazily via `getLoanRepayments()` on first expand.
- **Dynamic Room Categories** — `room_categories` managed lookup table; `roomCategoriesService.ts` (getRoomCategories, createRoomCategory, updateRoomCategoryName, setRoomCategoryActive); `RoomsClient` Manage Categories modal (add, rename, soft-deactivate); category dropdown in room form sourced from DB instead of hardcoded constant; `form.category` now stores slug; category name map used for display
- **Room Analytics** — admin-only dashboard at `/rooms/analytics`; 7 KPI cards (occupancy %, revenue, RevPAR, ADR, avg stay, top room, occupied now); sortable per-room performance table; most/least booked lists; room-type performance table; CSS-bar revenue chart; SVG polyline occupancy trend with daily/monthly auto-granularity; maintenance rooms excluded from occupancy/RevPAR/ADR denominators; date-range presets (Today / Last 7 / Last 30 / This Month / This Year / Custom); powered by `room_analytics_by_room` + `room_occupancy_trend` RPCs via `roomAnalyticsService.ts`

### Pending / Next Steps
- **Transfer modal smoke test** — transfer movement implemented but not browser-tested
- **Loans repayment history UI** — `getLoanRepayments()` exists but not surfaced in the Loans register

### Day 3 (most likely)
- Stay Extension (same-room): extend checkout date, recalculate total, update payment due
- No-show handling: `no_show` status, `isStaleConfirmed()` helper, stale banner, "Mark as No-Show" action

### Day 4 (likely)
- Front Desk dashboard widgets: today's check-ins/check-outs counts, in-house count, today's revenue, outstanding balances, quick actions
- Walk-in booking flow: "Available now" view, quick check-in, cash-first payment focus

### Day 5-6 (planned — visual room showcase block)
- Room photos, descriptions, amenities, bed type, sea view flag
- Visual room cards in Rooms page
- "Book This Room" walk-in flow integration

### Day 7+ (later polish)
- Stay Extension with room-shift
- Guest history view (per-guest booking history, total spend)
- Settings module: DB-backed HOTEL_INFO instead of hardcoded

### Intentionally deferred
- Housekeeping module (cleaning queue, Maintenance set/clear buttons)
- Samsung AC (real vs smoke decision pending)

---

## 10. Common Commands

```bash
# Development
npm run dev          # Start dev server at http://localhost:3000

# Build & Production
npm run build        # Production build (catches type errors)
npm start            # Serve production build

# Type checking (no emit)
npx tsc --noEmit     # Run TypeScript compiler checks only

# Linting
npm run lint         # Run ESLint

# Always prefix shell commands with:
cd /Users/arif80760/hotel-management &&

# Environment variables required in .env.local:
# NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
# NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
# SUPABASE_SERVICE_ROLE_KEY=eyJ...   (server-only — never expose to browser)
```

### Database Migrations (manual)
1. Open Supabase Dashboard → SQL Editor → New query
2. Paste the SQL from `sql/migrations/*.sql`
3. Click Run
4. Keep the `.sql` file in `sql/migrations/` as a record

### Migration History
| Date | File | What it does | Status |
|---|---|---|---|
| pre-2026-05-08 | `add_booking_rate_columns.sql` | Adds `fixed_rate`, `booking_rate` to bookings | ✅ Applied |
| pre-2026-05-08 | `add_extra_charge_columns.sql` | Adds `extra_charge_amount`, `extra_charge_reason` to bookings | ✅ Applied |
| pre-2026-05-08 | `create_booking_documents_table.sql` | Creates `booking_documents` table + storage bucket policies | ✅ Applied |
| pre-2026-05-08 | `add_early_checkout_and_discount_columns.sql` | Adds early-deduction + additional-discount columns to bookings | ✅ Applied |
| pre-2026-05-08 | `add_payment_method_extras.sql` | Adds `bkash`/`nagad` enum values + `last_payment_method` + sync trigger | ✅ Applied |
| 2026-05-08 | `2026-05-08-multi-room-enum-prep.sql` | Adds `checked_out_early` to `booking_status` enum — **run in separate session first** | ✅ Applied |
| 2026-05-08 | `2026-05-08-multi-room-foundation.sql` | Creates `booking_rooms`, `booking_extra_charges`, `refunds`; backfills; drops `fn_sync_room_status` | ✅ Applied |
| 2026-05-08 | `2026-05-08-multi-room-rpc.sql` | Adds RPCs: `create_booking_with_rooms`, `checkout_booking_room`, `checkin_booking_room`, `cancel_booking_room`, `extend_booking_room`, `update_booking_total` | ✅ Applied |
| 2026-05-08 | `2026-05-08-rpc-add-status-param.sql` | Adds `p_status` param to `create_booking_with_rooms` | ✅ Applied |
| 2026-05-08 | `2026-05-08-backfill-stale-checkin-rooms.sql` | Backfills stale check-in room statuses | ✅ Applied |
| 2026-05-08 | `2026-05-08-checkin-cascade-rpc.sql` | Check-in cascade RPC | ✅ Applied |
| 2026-05-08 | `2026-05-08-create-booking-total-cross-check.sql` | Adds total-amount cross-check to `create_booking_with_rooms` | ✅ Applied |
| 2026-05-09 | `2026-05-09-checkin-booking-room-rpc.sql` | Adds/updates `checkin_booking_room` RPC | ✅ Applied |
| 2026-05-09 | `2026-05-09-phase7-rpc-updates.sql` | Phase 7 RPC updates | ✅ Applied |
| 2026-05-17 | `2026-05-17-phase-b1b-rls-lockdown.sql` | Phase B1b: RLS lockdown | ✅ Applied |
| 2026-05-17 | `2026-05-17-phase-d4-drop-anon-select.sql` | Drops anon SELECT policies | ✅ Applied |
| 2026-05-18 | `2026-05-18-accounts-core-stage1.sql` | Creates `accounts` + `account_transactions` tables; `AccountTxnType` enum; `next_voucher_number()` RPC | ✅ Applied |
| 2026-05-18 | `2026-05-18-phase-e1-role-aware-rls.sql` | Role-aware RLS policies | ✅ Applied |
| 2026-05-19 | `2026-05-19-accounts-core-stage2-balances-view.sql` | Adds balances view | ✅ Applied |
| 2026-05-23 | `2026-05-23-booking-payment-integration-backfill.sql` | Backfills `booking_payment_id` on existing account_transactions | ✅ Applied |
| 2026-05-23 | `2026-05-23-booking-payment-integration-trigger.sql` | Adds `fn_sync_account_transactions` trigger — auto-creates `revenue_in` row on payment INSERT | ✅ Applied |
| 2026-05-23 | `2026-05-23-voucher-number-sequence.sql` | Adds voucher number sequence + RPC | ✅ Applied |
| 2026-05-24 | `2026-05-24-account-transactions-soft-delete.sql` | Adds `deleted_at` to `account_transactions` | ✅ Applied |
| 2026-05-24 | `2026-05-24-booking-payment-integration-update-branch-fix.sql` | Fixes UPDATE branch in payment integration trigger | ✅ Applied |
| 2026-05-24 | `2026-05-24-day-close.sql` | Day-close procedure | ✅ Applied |
| 2026-05-29 | `2026-05-29-account-transactions-audit-trail.sql` | Adds audit trail columns to account_transactions | ✅ Applied |
| 2026-05-30 | `2026-05-30-expense-categories-and-integrity.sql` | Creates `expense_categories` table; adds `category_id`, `payee`, `employee_id`, `booking_payment_id`, `created_by` to account_transactions | ✅ Applied |
| 2026-05-30 | `2026-05-30-voucher-rpc-security-definer.sql` | Marks `next_voucher_number()` as SECURITY DEFINER | ✅ Applied |
| 2026-05-31 | `2026-05-31-inventory-schema.sql` | Creates `inventory_categories`, `inventory_items`, `inventory_movements` tables | ✅ Applied |
| 2026-05-31 | `2026-05-31-revenue-categories-and-integrity.sql` | Creates `revenue_categories` table; adds `revenue_category_id` to account_transactions | ✅ Applied |
| 2026-06-02 | `2026-06-02-inventory-multi-unit.sql` | Adds `pack_label` (text) + `units_per_pack` (numeric) to `inventory_items` | ✅ Applied |
| 2026-06-02 | `2026-06-02-loans.sql` | Creates `loans` table; adds `loan_id` to account_transactions; `loan_received`/`loan_repayment` enum values | ✅ Applied |
| 2026-06-07 | `2026-06-07-room-categories-table.sql` | Creates `room_categories` lookup table; seeds with 5 initial values (single/double/deluxe/suite/family) | ✅ Applied |
| 2026-06-07 | `2026-06-07-room-category-enum-to-text.sql` | Converts `rooms.category`, `bookings.room_category_at_booking`, `booking_rooms.room_category` from `room_category` enum → TEXT; adds FK `rooms.category → room_categories(slug)`; rewrites `create_booking_with_rooms` + `add_room_to_booking` to use TEXT param; drops `room_category` enum | ✅ Applied |
| 2026-06-07 | `2026-06-07-room-analytics-rpcs.sql` | Adds `room_analytics_by_room(date, date)` and `room_occupancy_trend(date, date)` read-only RPCs powering `/rooms/analytics` dashboard | ✅ Applied |
| 2026-06-07 | `2026-06-07-booking-overlap-guard.sql` | Adds in-transaction room-overlap guard to `create_booking_with_rooms` and `add_room_to_booking`; both RPCs now fail closed on double-booking | ✅ Applied |
| 2026-06-08 | `2026-06-08-update-booking-total-rooms-only.sql` | Fixes `update_booking_total` to sum `booking_rooms` only (excludes `booking_extra_charges`), preventing a latent double-count where re-running the RPC would have folded the scalar `extra_charge_amount` into `total_amount` and flipped `payment_status` | ✅ Applied |
| 2026-06-08 | `2026-06-08-checkout-early-status-propagation.sql` | `checkout_booking`, `checkout_booking_room`, and `cancel_booking_room` now promote `bookings.status` to `checked_out_early` when any room departed early; `fn_stamp_booking_timestamps` stamps `checked_out_at` on both `checked_out` and `checked_out_early`; frontend `DB_TO_BOOKING_STATUS` maps `checked_out_early → "Checked Out"` | ✅ Applied |
| 2026-06-08 | `2026-06-08-drop-cleaning-checkout-frees-room.sql` | The three checkout RPCs (`checkout_booking`, `checkout_booking_room`, `cancel_booking_room`) now set `rooms.status = 'available'` (was `'cleaning'`); existing cleaning/maintenance rooms backfilled to available | ✅ Applied |
| 2026-06-08 | `2026-06-08-enforce-override-admin.sql` | Adds BEFORE INSERT/UPDATE trigger `trg_enforce_override_is_admin` (+ `fn_enforce_override_is_admin`) on `bookings`: rejects an `override_checkout` flip unless the caller is admin (`profiles.role`), and stamps `override_by`/`override_at` server-side. Service-role / no-token contexts exempt | ✅ Applied |
| 2026-06-09 | `2026-06-09-no-show-feature.sql` | Adds `no_show` `booking_status` value + `mark_booking_no_show(uuid)` RPC: flips a confirmed booking and its rooms to `no_show`, keeps amount paid (deposit forfeited), waives remaining balance via `additional_discount` | ✅ Applied |
| 2026-06-09 | `2026-06-09-no-show-exclude-from-analytics.sql` | `room_analytics_by_room` and `room_occupancy_trend` now filter `status NOT IN ('cancelled','no_show')` so no-shows no longer inflate occupancy or room revenue | ✅ Applied |
| 2026-06-09 | `2026-06-09-bookings-delete-admin-only.sql` | Adds SECURITY DEFINER `is_admin()` helper; restricts direct DELETE on `bookings` + `booking_rooms` to admins (replaces the open authenticated-delete policies). INSERT/SELECT/UPDATE unchanged | ✅ Applied |

| 2026-06-09 | `2026-06-09-rls-delete-admin-only.sql` | Restricts direct DELETE on `bookings` and `booking_rooms` to admins; adds `is_admin()` helper (SECURITY DEFINER) | ✅ Applied |
**Key rule:** `2026-05-08-multi-room-enum-prep.sql` must be applied in a **separate SQL Editor session** (new tab) before `2026-05-08-multi-room-foundation.sql`.

---

## 11. Quick Reference — Feature → File to Edit

| Want to change… | Edit… |
|---|---|
| Booking form fields | `app/bookings/BookingsClient.tsx` — form state + form JSX |
| Checkout modal logic | `BookingsClient.tsx` + `FrontDeskClient.tsx` |
| Room status after booking action | `contexts/HotelContext.tsx` + `services/bookingsService.ts` |
| Payment enforcement rules | `contexts/HotelContext.tsx` `recordPayment()` |
| Hotel timing policy | `lib/mockData.ts` `HOTEL_POLICY` |
| Discount display | `BookingsClient.tsx` — billing summary section |
| Employee provisioning | `app/api/employees/provision/route.ts` |
| Document upload/delete | `services/documentsService.ts` |
| Auth / role logic | `contexts/AuthContext.tsx` |
| DB ↔ UI field mapping (rooms) | `services/roomsService.ts` `mapRoom()` |
| Room categories (add/rename/deactivate) | `services/roomCategoriesService.ts` + `app/rooms/RoomsClient.tsx` (Manage Categories modal) |
| Room analytics KPIs / charts | `app/rooms/analytics/RoomAnalyticsClient.tsx` (RPCs via `services/roomAnalyticsService.ts`) |
| DB ↔ UI field mapping (bookings) | `services/bookingsService.ts` `mapBooking()` |
| Account transactions / balances | `services/accountsService.ts` |
| Cashbook UI (ledger, filters) | `app/accounts/cashbook/CashbookClient.tsx` |
| Expense recording + inventory seam | `app/accounts/expense/ExpenseClient.tsx` |
| Revenue / payroll entry | `app/accounts/revenue/` or `app/accounts/payroll/` |
| Loans register (view) | `app/accounts/loans/LoansClient.tsx` |
| Loan entry actions (record received/repay) | `app/accounts/loans/LoanEntryActions.tsx` |
| Inventory items + stock levels | `app/inventory/InventoryClient.tsx` |
| Inventory service (types, CRUD) | `services/inventoryService.ts` |
| Loans service (create, list, repay) | `services/loansService.ts` |
| Pack/base conversion logic | `app/inventory/InventoryClient.tsx` (stockUnit) or `app/accounts/expense/ExpenseClient.tsx` (exInvUnit + toBaseQty) |
| Sidebar navigation | `components/Sidebar.tsx` |
| Supabase client setup | `lib/supabase.ts` (browser) / `lib/supabaseAdmin.ts` (server) |
