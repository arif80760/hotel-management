# CLAUDE.md — Hotel Management System

Last updated: 2026-06-21 (rev 32)

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
>
> **rev 27** — Completed the staff-login lifecycle (deprovision + password reset). Two new admin-only server routes share one gate, `lib/requireAdmin.ts` (Bearer token → `auth.getUser` → `profiles.role === 'admin'`; same logic as `provision/route.ts`, which keeps its own inline copy on purpose). `/api/employees/delete` tears the login down in order — `auth.admin.deleteUser` FIRST (relies on `profiles.id → auth.users ON DELETE CASCADE` to drop the profile and `employees.auth_user_id → auth.users ON DELETE SET NULL` so the employees row survives), then deletes the profiles row explicitly, then the employees row; it has a self-delete guard and reports partial failures. **This fixes the bug where deleting an employee left a working login** (the old client-only `employeesService.deleteEmployee` removed just the employees row — now unused). `/api/employees/set-password` calls `auth.admin.updateUserById`; the previously dead edit-mode password field is wired to it (blank = keep current; relabelled "New Password"). `provision/route.ts` hardened: the `profiles` upsert is now FATAL — on failure it rolls back the employee row + auth user so a login is never left with `role = null`. All three routes need `SUPABASE_SERVICE_ROLE_KEY`; no DB migration (existing FKs suffice). KNOWN FOLLOW-UP: employee row-level RLS still allows broad authenticated writes — the delete now goes through the service-role route, but tightening direct table RLS is a separate task.
>
> **rev 28** — Login email sync + smart delete. `set-password` route was replaced by `/api/employees/update-login` (same admin gate), which updates the auth login's **email and/or password** in one `auth.admin.updateUserById` call: the password is set when typed, and the email is synced only when it differs from the auth user's current email (read via `getUserById`; a blank email is never set; `email_confirm: true` keeps it active). The edit-save flow fires this on **every** save of an employee that has a login, always sending the form email — so accounts whose auth email had drifted from the displayed email self-heal on the next save (fixes the divergence where the UI showed one address but login used another). `/api/employees/delete` is now a **smart delete**: when the auth user can't be hard-deleted (FK-referenced by bookings/transactions — "Database error deleting user") it falls back to banning the login (`updateUserById({ ban_duration: '876000h' })`) + setting `employees.is_active = false`; likewise if the employees-row delete is blocked by an FK (e.g. `inventory_movements.issued_to_employee_id` RESTRICT) it deactivates instead. Returns `outcome: 'deleted' | 'deactivated'`; the UI hard-removes the row on `deleted` and restores it greyed-as-inactive on `deactivated`. Hard delete is still used when nothing references the employee. No DB migration. KNOWN FOLLOW-UP: true hard-delete of referenced staff would require revisiting the `auth.users`-referencing FK `ON DELETE` rules.
>
> **rev 29** — Two features: Activity Log + self-service Profile.
> **Activity Log** (`/activity`, admins + managers only): a new `activity_log` table (append-only — `fn_activity_log_immutable` blocks UPDATE/DELETE; visibility via `can_view_activity_log()` = admin OR employee designation in Manager/General Manager) is populated by ONE SECURITY DEFINER trigger `fn_capture_activity()` (migration `2026-06-20-activity-log-capture-triggers.sql`) attached AFTER INS/UPD/DEL to bookings, booking_rooms, payments, refunds, account_transactions, employees, inventory_movements, day_closes. The whole body is wrapped in `BEGIN…EXCEPTION WHEN OTHERS THEN RETURN NULL` so logging can never abort the audited write; only meaningful changes are logged (status transitions, not updated_at/paid_amount churn). **Dedup rule: payment/refund-linked `account_transactions` rows (`booking_payment_id` set) are NOT logged as `cash.*`** — they're already captured at the payments/refunds level, so money isn't double-counted; only manual daybook entries log as `cash.*`. Employee changes by a null actor (service-role admin routes) are skipped (those routes log themselves). UI: `app/activity/ActivityLogClient.tsx` — server-side pagination (25/page with exact count), `entity_type` pill filters, debounced search, custom Dhaka-anchored date range. `AuthContext` exposes `canViewActivityLog` (Effect 3); Sidebar shows the link gated on it.
> **Self-service Profile** (`/profile`, any signed-in user): migration `2026-06-20-profile-self-service.sql` adds `profiles.avatar_url` and a **public `avatars` bucket** with own-folder RLS (`(storage.foldername(name))[1] = auth.uid()::text`). `ProfileClient` lets a user edit their name (writes both `profiles.full_name` and the linked `employees.full_name`), phone (`employees.phone`), avatar (uploads to `avatars/{uid}/{ts}.ext`, stores the path in `profiles.avatar_url`, public URL on read), and password (`supabase.auth.updateUser`). Role/designation/login-email are read-only. NOTE: this is a SECOND photo location — `profiles.avatar_url`→public `avatars` (self-service) is independent of `employees.photo_url`→private `employee-photos` (admin Employees page / `signEmployeePhotos`); the two do not mirror each other. The name edit depends on the live-only `trg_prevent_role_escalation` permitting a `full_name`-only self-update (saveProfile sends only `full_name`, never `role`). Avatars (`ce7147d`): `profiles.avatar_url` now surfaced in the sidebar user widget (self) and the Employees list. `AuthContext.UserProfile` gained `avatarUrl`, resolved in `fetchProfile` (passthrough if already http, else `avatars`-bucket `getPublicUrl`). Employees list render priority: self-service `profiles.avatar_url` → admin `employees.photo_url` (signed) → colored initials; `getAllEmployees` joins `profiles.avatar_url` by `auth_user_id`. Known timing: sidebar avatar resolves at SIGNED_IN, so a `/profile` photo change shows on the page immediately but in the sidebar only on next refresh/login (acceptable).
>
> **rev 30** — Staff-booking RLS launch-blocker fixed, plus consolidation of the auth/activity/profile work. **Staff-booking fix:** `fn_sync_account_transactions()` is now SECURITY DEFINER (`SET search_path = public, pg_temp`) so the automatic payment→`account_transactions` mirror bypasses the admin-only INSERT RLS — staff can now create bookings that include an initial payment. MANUAL daybook entries (direct client INSERT into `account_transactions`) stay admin-only via the unchanged policy. Migration `2026-06-20-account-transactions-sync-definer.sql` (commit `670bb01`). **Already documented above and confirmed shipped:** the Activity Log (rev 29; capture-trigger repo/live dedup correction `76dfff9`), self-service Profile (rev 29), and the employee auth lifecycle — login email-sync on edit via `update-login` and smart-delete (FK-referenced employees are deactivated + login banned rather than hard-deleted; commits `397d0f0`, `5844ba6`, `d3017e2`). NOTE: saving one's own profile while linked to an employee row fires `employee.updated` in the activity log. See the **Pending / TODO** section below for open verification + post-launch items.
>
> **rev 31** — Accounts: expense classification, director remuneration, and in-place edit. **Classification:** `expense_categories.kind` (`text` default `'operating'`; values `'operating' | 'remuneration'` — the original `'owner_draw'` was renamed). `remuneration` = MD/Chairman/Director payment: records as cash-out but is **EXCLUDED from operating-expense/profit totals** (an appropriation of profit), validated at the app layer. The Manage Categories modal has a kind selector + amber badge. Migrations `2026-06-21-expense-category-kind.sql`, `2026-06-21-rename-kind-owner-draw-to-remuneration.sql`. **Remuneration recording lives IN the Expense page** (no separate route/sidebar): an "Add Remuneration" button beside "Add Expense" records via `createExpense` (`payeeMode='employee'`, `employeeId` = director, category resolved by `resolveRemunerationCategoryId()` with `kind='remuneration'`, cash-out from Cash). Recipients = employees whose `designation` ∈ (Chairman, Managing Director, Director). The page has an "Expenses | Remuneration" toggle; the operating-expense list + per-date totals exclude remuneration via a `categoryId→kind` map (unknown/missing kind treated as operating). Commits `531b084`, `2fc0b51`. **In-place EDIT (no delete):** `editExpense(id, input)` in `expensesService` UPDATEs `txn_date/amount/category_id/employee_id|payee/note` + `edited_at`/`edited_by`; voucher preserved; expense_out integrity preserved; guards `type='expense_out'` + `booking_payment_id IS NULL` + `deleted_at IS NULL`. An "Edit" button in the row actions (both views) is **disabled on closed-day rows** (`getDayCloseStatus().lastClosedDate`; closed if `txn_date <= it`) and reuses the Add modals in edit mode, routed by category kind. The inventory seam is create-only (edit skips it). Commit `c92f694`. **INTEGRITY MODEL (correcting the record):** `account_transactions` is **day-close-scoped immutable** via `fn_check_account_transactions_immutability` — open days are freely editable/deletable; only rows on/before the latest `day_closes.close_date` are locked. It is **NOT blanket-immutable.** Void = `deleteTransaction(id)` (sets `deleted_at`/`deleted_by`; the Cashbook trash icon). `updateTransaction` is the in-place editor for `transfer`/`injection`; `editExpense` extends that same pattern to `expense_out`.
>
> **rev 32** — **Profit & Loss statement shipped** (`/accounts/profit-loss`, admin-gated server wrapper + `ProfitLossClient`; commit `c088623`). Period presets (This month / Last month / This year / All time / Custom) using the **same date semantics as the Revenue Report**. **Revenue is computed 1:1 with the Revenue Report:** `getTransactions(filters)` → `type==='revenue_in'` → sum. **Refunds netted:** `expense_out` rows with `bookingPaymentId !== null`, shown as a "Less: Refunds" line. Operating vs remuneration split via the `categoryId→kind` map; operating expenses shown with a by-category breakdown. Statement order: Revenue → less Refunds → **Net Revenue** → less Operating Expenses → **Net Profit** → less Director Remuneration (appropriation of profit) → **Retained Profit**. Sidebar: "Profit & Loss" child under the (admin-only) Accounts group, after Revenue Report. STATUS: built + deployed, compiles clean. **LIVE PARITY CHECK STILL PENDING** — confirm P&L "This month" Revenue equals Revenue Report "This month" Revenue in the running app. Restyled "Midnight" (commit `35c85bb`): dark metric cards + revenue-allocation bar + Space Grotesk numerals. Fonts: `Space_Grotesk` + `Plus_Jakarta_Sans` via `next/font`, scoped to `/accounts/profit-loss` through CSS variables set in `page.tsx` (not global). Pure presentation — compute path unchanged.
>
> **Notification bell** (`2237727`): `components/NotificationBell.tsx` (new), mounted in `TopBar` replacing the old static placeholder. Derives notifications live, NO new table. Fetches `getAllBookings` directly (not `useHotel`, so TopBar stays context-independent); role + user from `useAuth`. Categories (all roles): overdue checkout (`checkOutISO < today && status 'Checked In'`), departures today (`checkOutISO===today && Checked In`), arrivals today (`checkInISO===today && status 'Confirmed'`), payment due (Checked In, payment≠Paid, `amountPaid<totalAmount`, `checkOutISO≤today`), latest 5 bookings (`created_at` desc). Admin-only: low stock (`getInventoryItems` activeOnly + `getStockForAllItems`, qty ≤ `lowStockThreshold`) and day-not-closed (`getDayCloseStatus`, `lastClosedDate < today`, shows `missedDays` backlog). Dates: plain local `todayISO()` + `'YYYY-MM-DD'` string compare (matches cashbook/day-close convention). Red dot/count badge driven by a per-user localStorage marker `notif_seen_<userId>`: stamped = now on open (clears), re-lights on a newer booking `createdAt` or the next day's `startOfToday` for today-items. Links: bookings → `/bookings/<id>/reservation`, low stock → `/inventory`, day-close → `/accounts/cashbook`.

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

## Pricing Architecture (updated 2026-06-11 — rev 26)

- `room_categories.price` is the SINGLE SOURCE OF TRUTH for all pricing.
- `rooms.price_per_night` column was DROPPED. Never re-add price to rooms.
- `MockRoom.price` still exists in TypeScript as a placeholder (always 0) for type compatibility — do not read or write it.
- New bookings pull live category price; old bookings/invoices keep their locked amounts (historical accuracy).
- Category slug is the stable FK key in `rooms.category` — never change a slug. Only `name` and `price` are editable (Manage Categories modal in Rooms).
- Category display: rooms store the slug; UI maps slug → `room_categories.name` via catNameMap (exists in both RoomsClient and BookingsClient). Any new UI showing a category must use this map.
- Dropped: `booking_summary` view (stale, single-room era, unused).

---

## Pending / TODO (as of rev 32)

### Accounts — P&L and audit follow-ups
- **P&L live parity verification** (This-month Revenue vs Revenue Report) in the running app — plus, optionally, consider whether the same refund-netting should apply to the Revenue Report for cross-report consistency.
- **Edits not in the Activity Log:** the capture trigger logs `account_transactions` **INSERT only**, not UPDATE — so `editExpense` edits (and `deleteTransaction` voids) aren't recorded. Optional: extend `fn_capture_activity` to log edits (actor + old→new).
- **Minor polish:** the inventory toggle is still rendered (but ignored) in the Expense modal during edit mode; `edited_at`/`edited_by` are stamped but not surfaced as an "edited" indicator on rows.

### Verify live (auth lifecycle + activity log)
- Confirm a deactivated account (Salam) cannot log in; confirm auth email self-heals on the next employee edit; confirm a clean hard-delete of an unreferenced throwaway employee; confirm the Zahid orphan auth-user delete actually ran.
- Activity log: the **manual cash/daybook branch** (`account_transactions` with `booking_payment_id IS NULL`) is the only capture branch not yet exercised live — verify by recording a manual cash entry.

### Known minor issues (non-blocking)
- **Guest-dedup 409:** a `guests` INSERT can hit `guests_email_key` for a returning guest whose email already exists, because matching is on phone, not email. Minor.
- **Profile:** contact email is read-only on `/profile` — optionally make it self-editable.

### Deferred (pre-/post-launch)
- **Test-data cleanup:** wipe transactional/test data to free FK-referenced test employees for true hard-delete and a clean launch slate. Harvest `booking_documents.storage_path` first; do the separate storage-object cleanup (guest-documents + employee-photos + avatars). (See the safe delete order from the schema mapping.)
- **Schema drift backfill:** ~17 live-only objects (incl. `prevent_role_escalation`, the `*_updated_at` triggers + `fn_set_updated_at`, and value CHECK constraints on bookings/employees/profiles/rooms/room_categories) and the live `storage.objects` policies are NOT in tracked SQL — backfill into `sql/` post-launch so the repo matches live.
- **Launch:** Supabase Pro; domain transfer (albatrossresort.com) + fresh public site; soft launch.
- **Post-launch hardening:** middleware/SSR auth; add `WITH CHECK` to the `profiles` UPDATE policy (defense-in-depth alongside `trg_prevent_role_escalation`); audit all `auth.users`-referencing FK `ON DELETE` rules (enables true hard-delete of referenced staff); orphan-avatar cleanup.
