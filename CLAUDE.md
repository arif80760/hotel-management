# CLAUDE.md — Hotel Management System

Last updated: 2026-06-08 (rev 19)

> **rev 19** — Removed the cleaning/maintenance lifecycle from the dashboard Room Board. Checkout now releases a room straight to Available (`checkoutNormal`/`checkoutWithOverride` set the physical room Available and optimistically mark `booking_rooms` Checked Out). `lib/roomStatus.deriveRoomStatusForDate` no longer special-cases Cleaning/Maintenance — the board shows only Available/Reserved/Occupied, derived from bookings; summary/legend trimmed to those three. **KNOWN FOLLOW-UP:** the `checkout_booking` DB RPC and the Rooms admin page may still reference cleaning/maintenance physical statuses — harmless to the board (which ignores physical status) but worth retiring if those statuses are fully dropped.

Comprehensive reference for AI assistants and developers working on this codebase.

---

## 1. Project Overview

A full-stack hotel management web application for managing rooms, bookings, check-in/out,
guests, employees, payments, financial accounts (cashbook, expenses, payroll, revenue),
inventory, and loans.

| Item | Value |
|---|---|
| Framework | Next.js 16.2.4 (App Router) |
| UI Library | React 19 |
| Language | TypeScript 5 |
| Styling | Tailwind CSS 4 |
| Backend / DB | Supabase (PostgreSQL + Auth + Storage) |
| Client SDK | @supabase/supabase-js ^2.104.0 |
| Deploy target | Vercel (assumed) |

---

## 2. Folder Structure

```
hotel-management/
├── app/                         # Next.js App Router pages
│   ├── layout.tsx               # Root layout — wraps all pages with AuthProvider + HotelProvider
│   ├── page.tsx                 # Dashboard (redirects to /bookings or /login)
│   ├── login/                   # Login page (email + password, Supabase Auth)
│   ├── bookings/
│   │   └── BookingsClient.tsx   # Full booking management UI — main workhorse (~2500+ lines)
│   ├── front-desk/
│   │   └── FrontDeskClient.tsx  # Simplified daily ops view — check-in/out focused
│   ├── rooms/
│   │   ├── analytics/
│   │   │   ├── page.tsx             # Server wrapper (admin guard) → renders RoomAnalyticsClient
│   │   │   └── RoomAnalyticsClient.tsx  # Room analytics dashboard — KPIs, trend, per-room table
│   │   └── ...                  # Room inventory management
│   ├── guests/                  # Guest profiles
│   ├── employees/               # Employee roster (admin only)
│   ├── profile/                 # Logged-in user profile page
│   ├── inventory/
│   │   └── InventoryClient.tsx  # Full inventory CRUD — items, stock movements, pack/base unit toggle
│   ├── accounts/
│   │   ├── cashbook/
│   │   │   └── CashbookClient.tsx   # Financial ledger — all account transactions, filters, modals
│   │   ├── expense/
│   │   │   └── ExpenseClient.tsx    # Expense recording + inventory purchase seam (pack/base toggle)
│   │   ├── revenue/                 # Revenue management page
│   │   ├── payroll/                 # Payroll page
│   │   └── loans/
│   │       ├── page.tsx             # Server wrapper (admin guard) → renders LoansClient
│   │       ├── LoansClient.tsx      # Read-only loans register (7-column table, outstanding pill)
│   │       └── LoanEntryActions.tsx # Cashbook toolbar widget — "+ Loan received" + "Loan repayment" buttons
│   └── api/
│       └── employees/
│           └── provision/
│               └── route.ts     # POST /api/employees/provision — server-only admin route
│
├── contexts/
│   ├── AuthContext.tsx          # Auth state — user, profile, role, signIn, signOut
│   └── HotelContext.tsx         # Shared rooms + bookings state; all action functions
│
├── services/
│   ├── roomsService.ts              # Supabase CRUD for rooms table
│   ├── roomCategoriesService.ts     # CRUD for room_categories lookup table (dynamic categories)
│   ├── roomAnalyticsService.ts      # Read-only RPCs — room_analytics_by_room + room_occupancy_trend
│   ├── bookingsService.ts           # Supabase CRUD for bookings table (with joins)
│   ├── guestsService.ts             # Supabase CRUD for guests table
│   ├── employeesService.ts          # Supabase CRUD for employees table
│   ├── documentsService.ts          # Supabase Storage + booking_documents table
│   ├── accountsService.ts           # Financial accounts — transactions, balances, types, lender name join
│   ├── inventoryService.ts          # Inventory items + movements CRUD; pack label / units_per_pack fields
│   ├── inventoryCategoriesService.ts# Inventory category lookup CRUD (same pattern)
│   ├── expenseCategoriesService.ts  # Expense category lookup CRUD (find-or-create)
│   ├── revenueCategoriesService.ts  # Revenue category lookup CRUD
│   └── loansService.ts              # Loans CRUD — create loan, list with status, record repayment
│
├── lib/
│   ├── mockData.ts              # Central type definitions + HOTEL_POLICY + MOCK_* seed data
│   ├── supabase.ts              # Supabase browser client (HMR singleton on globalThis)
│   ├── supabaseAdmin.ts         # Supabase service-role admin client (server-only)
│   ├── invoiceUtils.ts          # calcTrueDue() + formatInvoiceDate() — shared between invoice pages
│   └── roomStatus.ts            # localDateToISO, TODAY_ISO, deriveRoomStatusForDate — shared by RoomBoard + Dashboard
│
├── components/
│   ├── Sidebar.tsx              # App navigation sidebar (includes Accounts → Loans link)
│   └── ...                      # Other shared UI components
│
├── sql/                         # All SQL — schema snapshots + migration history
│   ├── schema/                  # Authoritative current-state schema files (keep in sync with DB)
│   │   ├── 00-extensions.sql
│   │   ├── 01-types.sql
│   │   ├── 02-tables.sql
│   │   ├── 03-views.sql
│   │   ├── 04-functions.sql
│   │   ├── 05-indexes.sql
│   │   ├── 06-triggers.sql
│   │   └── 07-rls-policies.sql
│   └── migrations/              # Ordered migration history — apply once in Supabase SQL Editor
│       ├── add_booking_rate_columns.sql
│       ├── add_extra_charge_columns.sql
│       ├── create_booking_documents_table.sql
│       ├── add_early_checkout_and_discount_columns.sql
│       ├── add_payment_method_extras.sql
│       ├── 2026-05-08-multi-room-enum-prep.sql
│       ├── 2026-05-08-multi-room-foundation.sql
│       ├── 2026-05-08-multi-room-foundation-rollback.sql
│       ├── 2026-05-08-multi-room-rpc.sql
│       ├── 2026-05-08-rpc-add-status-param.sql
│       └── 2026-06-02-inventory-multi-unit.sql   # Adds pack_label + units_per_pack to inventory_items
│
├── public/
├── next.config.ts
├── tsconfig.json
└── package.json
```

---

## 3. Database Schema

### `rooms`
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | auto-generated |
| room_number | TEXT UNIQUE | e.g. "101" |
| floor | INTEGER | 1–4 |
| category | TEXT FK → room_categories.slug | lowercase slug; ON UPDATE CASCADE, ON DELETE RESTRICT |
| status | TEXT | lowercase enum: available/reserved/occupied/cleaning/maintenance |
| price_per_night | NUMERIC(10,2) | nightly rate |
| capacity | INTEGER | max guests |
| amenities | TEXT[] | e.g. ["WiFi","TV","Mini Bar"] |
| created_at | TIMESTAMPTZ | default NOW() |
| updated_at | TIMESTAMPTZ | default NOW() |

### `room_categories`
Managed lookup table — replaces the former `room_category` enum (migrated 2026-06-07).
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | auto-generated |
| slug | TEXT UNIQUE NOT NULL | stable FK key: "single", "deluxe", "junior-suite" — never changes |
| name | TEXT NOT NULL | editable display label: "Single", "Deluxe", "Junior Suite" |
| sort_order | SMALLINT NOT NULL | display order; auto-assigned (max+1) on creation |
| is_active | BOOLEAN NOT NULL DEFAULT TRUE | inactive = hidden from room form dropdown; rooms keep their FK intact |
| created_at / updated_at | TIMESTAMPTZ | |

Slug derives from name at creation time via `slugifyCategory()` in `roomCategoriesService.ts`:
`"Junior Suite" → "junior-suite"`. Seeded with 5 values: single/double/deluxe/suite/family.

**Key rule**: `rooms.category` stores the **slug** (lowercase). `roomsService.mapRoom()` capitalises with `cap(slug)` for display. `RoomsClient` form stores slug in `form.category`; `toRoomPayload()` still calls `.toLowerCase()` on it (harmless no-op since slugs are already lowercase).
**Snapshot columns** (`bookings.room_category_at_booking`, `booking_rooms.room_category`) are TEXT with **no FK** — frozen at booking time so history stays truthful even if a category is later renamed or retired.

### `guests`
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | auto-generated |
| name | TEXT | full name |
| email | TEXT UNIQUE | placeholder email used for find-or-create |
| phone | TEXT UNIQUE | used as the lookup key for find-or-create |
| nationality | TEXT | optional |
| notes | TEXT | optional staff notes |
| vip | BOOLEAN | default false |
| created_at | TIMESTAMPTZ | |

### `bookings`
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | internal UUID |
| booking_ref | TEXT UNIQUE | human-readable, e.g. "BK-1041" — generated by DB trigger |
| room_id | UUID FK → rooms.id | |
| primary_guest_id | UUID FK → guests.id | |
| check_in_date | DATE | ISO format: "2026-04-22" |
| check_out_date | DATE | ISO format: "2026-04-25" |
| nights | INTEGER | **GENERATED column** — DB-computed; not directly writable |
| room_category_at_booking | TEXT | lowercase enum — snapshot at booking time |
| total_guests | INTEGER | |
| status | TEXT | lowercase enum: confirmed/checked_in/checked_out/cancelled |
| total_amount | NUMERIC(10,2) | booking_rate × nights |
| paid_amount | NUMERIC(10,2) | summed from payments table by trigger |
| payment_status | TEXT | lowercase: unpaid/partial/paid — maintained by trigger |
| fixed_rate | NUMERIC(10,2) | standard published rate per night (nullable) |
| booking_rate | NUMERIC(10,2) | actual negotiated rate per night (nullable) |
| extra_charge_amount | NUMERIC(10,2) | additional charge at checkout (nullable) |
| extra_charge_reason | TEXT | nullable |
| override_checkout | BOOLEAN | true if admin bypassed payment gate |
| override_reason | TEXT | admin's stated reason (nullable) |
| override_by | UUID | auth.users UUID of admin who overrode (nullable) |
| override_at | TIMESTAMPTZ | when override was performed (nullable) |
| confirmed_at / checked_in_at / checked_out_at / cancelled_at | TIMESTAMPTZ | stamped by trigger |
| actual_checkout_date | DATE | calendar date guest actually vacated |
| early_nights_deducted | INTEGER | max(0, check_out_date − actual_checkout_date) |
| early_deduction_amount | NUMERIC(10,2) | early_nights_deducted × booking_rate |
| additional_discount_amount | NUMERIC(10,2) | ad-hoc discount at checkout (nullable) |
| additional_discount_reason | TEXT | optional reason (nullable) |
| additional_discount_by | UUID | auth.users UUID who applied discount (nullable) |
| additional_discount_at | TIMESTAMPTZ | when discount applied (nullable) |
| last_payment_method | payment_method | nullable — denormalized from most recent payments row |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

### `booking_guests`
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| booking_id | UUID FK → bookings.id | |
| name | TEXT | additional guest full name |
| nationality | TEXT | nullable |
| sort_order | INTEGER | display order |

### `payments`
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| booking_id | UUID FK → bookings.id | |
| amount | NUMERIC(10,2) | must be > 0 |
| method | payment_method enum | NOT NULL |
| recorded_by | UUID | nullable — auth.users UUID of staff |
| notes | TEXT | nullable |
| created_at | TIMESTAMPTZ | |

DB triggers on INSERT automatically update `bookings.paid_amount`, re-derive `bookings.payment_status`, and sync `bookings.last_payment_method`.

### `profiles`
| Column | Type | Notes |
|---|---|---|
| id | UUID PK FK → auth.users.id | 1:1 with auth users |
| full_name | TEXT | display name |
| role | TEXT | "admin" or "staff" |
| created_at | TIMESTAMPTZ | |

### `employees`
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| auth_user_id | UUID FK → auth.users.id | nullable |
| full_name | TEXT | |
| email | TEXT UNIQUE | |
| role | TEXT | "admin" or "staff" |
| department | TEXT | optional |
| phone | TEXT | optional |
| hire_date | DATE | optional |
| is_active | BOOLEAN | default true |
| created_at | TIMESTAMPTZ | |

### `booking_documents`
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| booking_ref | TEXT NOT NULL | TEXT reference — loose-coupled, no UUID FK |
| document_type | TEXT | "Passport" / "National ID Card" / "Driving License" / "Wedding Certificate" / "Other" |
| file_url | TEXT | public URL from Supabase Storage |
| storage_path | TEXT UNIQUE | object key in guest-documents bucket |
| file_name | TEXT | original browser file name |
| file_type | TEXT | MIME type |
| note | TEXT | optional |
| uploaded_by | UUID FK → auth.users.id | nullable — SET NULL on user delete |
| created_at | TIMESTAMPTZ | |

### `booking_rooms`
Added: 2026-05-08 — multi-room junction table.
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| booking_id | UUID FK → bookings.id | ON DELETE CASCADE |
| room_id | UUID FK → rooms.id | ON DELETE RESTRICT |
| check_in_date / check_out_date | DATE | NOT NULL |
| nights | SMALLINT | NOT NULL — stored (not generated) |
| room_category | TEXT | NOT NULL — frozen slug snapshot at booking time (no FK) |
| booking_rate | NUMERIC(10,2) | NOT NULL — negotiated rate per night |
| status | booking_status enum | NOT NULL DEFAULT 'confirmed' |
| actual_checkout_date | DATE | nullable |
| early_nights_deducted | INTEGER | NOT NULL DEFAULT 0 |
| early_deduction_amount | NUMERIC(10,2) | NOT NULL DEFAULT 0 |
| confirmed_at / checked_in_at / checked_out_at / cancelled_at | TIMESTAMPTZ | nullable |
| created_at / updated_at | TIMESTAMPTZ | NOT NULL DEFAULT NOW() |
| UNIQUE (booking_id, room_id) | — | one row per room per booking |

### `booking_extra_charges`
Added: 2026-05-08
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| booking_id | UUID FK → bookings.id | ON DELETE CASCADE |
| booking_room_id | UUID FK → booking_rooms.id | nullable — per-room charge |
| amount | NUMERIC(10,2) | NOT NULL, > 0 |
| reason | TEXT | NOT NULL |
| recorded_by | UUID | nullable |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT NOW() |

### `refunds`
Added: 2026-05-08
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| booking_id | UUID FK → bookings.id | ON DELETE CASCADE |
| amount | NUMERIC(10,2) | NOT NULL, > 0 |
| reason | TEXT | NOT NULL |
| status | TEXT | 'pending' or 'disbursed' DEFAULT 'pending' |
| method | payment_method enum | nullable |
| disbursed_by | UUID | nullable |
| disbursed_at | TIMESTAMPTZ | nullable |
| notes | TEXT | nullable |
| created_at / updated_at | TIMESTAMPTZ | NOT NULL DEFAULT NOW() |

### `accounts`
Financial account buckets (cash, bank, etc.)
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| name | TEXT | e.g. "Cash", "Bank" |
| type | TEXT | e.g. "cash", "bank" |
| created_at | TIMESTAMPTZ | |

Account UUIDs are hardcoded in `ACCOUNT_IDS` constant (used by service + client files):
```typescript
export const ACCOUNT_IDS = {
  cash: "...",   // UUID of the Cash account
  bank: "...",   // UUID of the Bank account
  // ... other buckets
};
```

### `account_transactions`
All financial movements — revenue, expenses, transfers, injections, loans.
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| type | account_txn_type enum | See AccountTxnType below |
| from_account_id | UUID FK → accounts.id | nullable — source account |
| to_account_id | UUID FK → accounts.id | nullable — destination account |
| amount | NUMERIC(12,2) | NOT NULL, > 0 |
| txn_date | DATE | NOT NULL |
| note | TEXT | optional |
| loan_id | UUID FK → loans.id | nullable — links repayment txns to their loan |
| voucher_number | TEXT | `EV-YYYY-NNNN` on user expenses — via `next_voucher_number()` RPC |
| category_id | UUID FK → expense_categories.id | NOT NULL on user expenses (incl. payroll) |
| revenue_category_id | UUID FK → revenue_categories.id | NOT NULL on user revenue rows |
| payee | TEXT | free-text vendor — exclusive with `employee_id` |
| employee_id | UUID FK → employees.id | set on Salary-category expenses (payroll); exclusive with `payee` |
| booking_payment_id | UUID | set on booking-derived rows; NULL on user expenses |
| created_by | UUID | auth.users id of recorder (nullable) |
| deleted_at | TIMESTAMPTZ | nullable — soft-delete pattern |
| created_at | TIMESTAMPTZ | |

#### `AccountTxnType` enum (6 values)
| Value | `from` | `to` | Meaning |
|---|---|---|---|
| `revenue_in` | NULL | NOT NULL | Revenue received into an account |
| `expense_out` | NOT NULL | NULL | Expense paid from an account |
| `transfer` | NOT NULL | NOT NULL | Move funds between accounts |
| `injection` | NULL | NOT NULL | Capital injection (owner puts money in) |
| `loan_received` | NULL | NOT NULL | Loan cash received into account |
| `loan_repayment` | NOT NULL | NULL | Loan repaid from account |

### `loans`
Principal-only loans. Status (outstanding/repaid) is **derived client-side** from repayment transactions — not stored.
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| lender_name | TEXT | NOT NULL |
| principal | NUMERIC(12,2) | NOT NULL — original loan amount |
| received_date | DATE | NOT NULL |
| due_date | DATE | nullable |
| note | TEXT | optional |
| deleted_at | TIMESTAMPTZ | nullable — soft delete |
| created_at | TIMESTAMPTZ | |

RLS: `current_user_role() = 'admin'` — loans table is admin-only.

Repayments are tracked via `account_transactions` rows with `type = 'loan_repayment'` and `loan_id` FK pointing to this table.

**Status derivation** (done in `listLoans()`):
```typescript
repaid      = SUM(repayment txns for this loan_id)
outstanding = MAX(0, principal − repaid)
status      = repaid >= principal ? "repaid" : "outstanding"
```

**Atomicity note**: `createLoan` does two sequential Supabase writes (INSERT loans → INSERT account_transaction). No true DB transaction is available via the client SDK. A compensating DELETE on the loans row is issued if the account_transaction INSERT fails.

### `inventory_items`
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| name | TEXT | NOT NULL |
| unit | TEXT | base unit label (e.g. "piece", "kg", "litre") |
| low_stock_threshold | NUMERIC(12,2) | nullable — alert threshold in base units |
| pack_label | TEXT | nullable — display label for a pack (e.g. "box", "carton") |
| units_per_pack | NUMERIC(12,2) | nullable — how many base units per pack; must be > 0 if set |
| deleted_at | TIMESTAMPTZ | nullable — soft delete |
| created_at / updated_at | TIMESTAMPTZ | |

`pack_label` + `units_per_pack` are for items bought in packs (e.g. a box of 24 pieces).
Stock is **always stored in base units**. The pack→base conversion happens client-side before any write.

### `inventory_movements`
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| item_id | UUID FK → inventory_items.id | |
| quantity | NUMERIC(12,2) | positive = stock in, negative = stock out |
| movement_type | TEXT | e.g. "purchase", "consumption", "adjustment" |
| reference | TEXT | optional — e.g. expense ID or note |
| unit_price | NUMERIC(12,2) | nullable — price per base unit at time of purchase |
| created_at | TIMESTAMPTZ | |

### Storage Buckets
| Bucket | Visibility | Used for |
|---|---|---|
| guest-documents | Public | Identity document uploads |

### DB Triggers
| Trigger | Table | Effect |
|---|---|---|
| fn_stamp_booking_timestamps | bookings | Stamps confirmed_at / checked_in_at / checked_out_at / cancelled_at on status change |
| ~~fn_sync_room_status~~ | ~~bookings~~ | **RETIRED 2026-05-08** — replaced by app-layer RPCs |
| fn_sync_paid_amount | payments | Adds payment.amount to bookings.paid_amount on INSERT |
| fn_sync_payment_status | bookings | Re-derives payment_status from paid_amount vs total_amount |
| fn_sync_last_payment_method | payments | On INSERT: copies payments.method to bookings.last_payment_method |

### Enums

#### `payment_method`
7 values: `cash`, `card`, `bank_transfer`, `bkash`, `nagad`, `online`, `other`
- **5 user-selectable**: `cash`, `card`, `bank_transfer`, `bkash`, `nagad`
- **2 legacy / system**: `online`, `other` — may exist in older rows; never shown in UI
- Use `formatPaymentMethod(value)` for safe display of any value including legacy ones

### Analytics RPCs (`sql/schema/07-functions.sql`)
Two read-only functions callable via `supabase.rpc()`, used exclusively by `/rooms/analytics`:

| RPC | Signature | Returns |
|---|---|---|
| `room_analytics_by_room` | `(p_from date, p_to date)` | One row per room: room_id, room_number, floor, category, room_status, price_per_night, bookings, occupied_nights, available_nights, revenue, adr (null when no bookings), revpar, occupancy_pct |
| `room_occupancy_trend` | `(p_from date, p_to date)` | One row per calendar day: day, occupied_rooms, available_rooms, occupancy_pct |

Revenue basis: `booking_rate × nights` (room revenue only; excludes extra charges and checkout discounts — keeps ADR/RevPAR to standard hotel definitions). Both exclude `cancelled` booking_rooms. `room_occupancy_trend.available_rooms` is a snapshot of current `rooms` table (maintenance excluded); it does not time-travel.

### RLS Policies (general pattern)
- All tables: `authenticated` role can SELECT, INSERT, UPDATE, DELETE.
- `profiles`: users can only read/update their own row.
- `loans`: admin only (`current_user_role() = 'admin'`).
- `booking_documents`: authenticated can SELECT/INSERT/DELETE.
- Storage bucket `guest-documents`: authenticated can INSERT and DELETE; public read.

### Key Relationships
```
auth.users ──1:1──> profiles (id = auth.users.id)
auth.users ──1:1──> employees (auth_user_id)
bookings   ──N:1──> rooms  (room_id)
bookings   ──N:1──> guests (primary_guest_id)
bookings   ──1:N──> booking_guests (booking_id)
bookings   ──1:N──> payments (booking_id)
bookings   ──1:N──> booking_rooms (booking_id)
bookings   ──1:N──> booking_extra_charges (booking_id)
bookings   ──1:N──> refunds (booking_id)
booking_rooms ──1:N──> booking_extra_charges (booking_room_id)
booking_documents links to bookings via TEXT booking_ref (loose coupling — no FK)
accounts   ──1:N──> account_transactions (from_account_id / to_account_id)
loans      ──1:N──> account_transactions (loan_id) [repayment txns]
inventory_items ──1:N──> inventory_movements (item_id)
```

---

## 4. Completed Features

| Module | Status | Key Files |
|---|---|---|
| Auth (login/logout, role-based) | ✅ Complete | `contexts/AuthContext.tsx`, `app/login/` |
| Rooms (CRUD, status management) | ✅ Complete | `app/rooms/`, `services/roomsService.ts` |
| Room Categories (dynamic managed lookup) | ✅ Complete | `services/roomCategoriesService.ts`, `app/rooms/RoomsClient.tsx` (Manage Categories modal) |
| Room Analytics (admin dashboard) | ✅ Complete | `app/rooms/analytics/` (admin-only), `services/roomAnalyticsService.ts` |
| Bookings (full lifecycle) | ✅ Complete | `app/bookings/BookingsClient.tsx`, `services/bookingsService.ts` |
| Front Desk (daily ops view) | ✅ Complete | `app/front-desk/FrontDeskClient.tsx` |
| Guests (profiles, VIP, notes) | ✅ Complete | `app/guests/`, `services/guestsService.ts` |
| Employees (roster, provisioning) | ✅ Complete | `app/employees/`, `app/api/employees/provision/route.ts` |
| Documents (upload, preview, delete) | ✅ Complete | `services/documentsService.ts` |
| Payments (3-layer enforcement) | ✅ Complete | `HotelContext.recordPayment()`, `bookingsService.recordPayment()` |
| Discount / rate logic | ✅ Complete | `fixedRate` / `bookingRate` fields on bookings |
| Admin override checkout | ✅ Complete | `HotelContext.checkoutWithOverride()` |
| Stay Timing Step 1 (display) | ✅ Complete | `BookingsClient.tsx`, `FrontDeskClient.tsx` |
| Stay Timing Step 2 (billing) | ✅ Complete | early deduction + additional discount at checkout |
| Payment Method Tracking | ✅ Complete | `lib/mockData.ts`, `services/bookingsService.ts` |
| Booking Edit (Feature B) | ✅ Complete | `app/bookings/BookingsClient.tsx`, `contexts/HotelContext.tsx` |
| Dynamic Room Board (Block 2) | ✅ Complete | `components/RoomBoard.tsx`, `contexts/HotelContext.tsx` |
| Invoice + Reservation Details (Block 3) | ✅ Complete | `app/bookings/[id]/invoice/page.tsx`, `app/bookings/[id]/reservation/page.tsx` |
| Cashbook (financial ledger) | ✅ Complete | `app/accounts/cashbook/CashbookClient.tsx`, `services/accountsService.ts` |
| Expense recording | ✅ Complete | `app/accounts/expense/ExpenseClient.tsx` |
| Revenue management (entry) | ✅ Complete | `app/accounts/revenue-management/`, `services/revenueService.ts` |
| Revenue report (analytics) | ✅ Complete | `app/accounts/revenue-report/RevenueReportClient.tsx` |
| Payroll | ✅ Complete | per-employee salary / advance / bonus payments; each posts through `createExpense` as a Cash `expense_out` tagged "Salary" with a generated `EV-YYYY-NNNN` voucher. Monthly summary, per-type totals, and per-employee history. Payment type is stored as a leading label in the note; the "Salary" category is find-or-created. |
| Inventory (CRUD + movements) | ✅ Complete | `app/inventory/InventoryClient.tsx`, `services/inventoryService.ts` |
| Inventory multi-unit pack support | ✅ Complete | pack_label/units_per_pack, pack↔base toggle in both purchase entry points |
| Loans register + entry (Stage 6) | ✅ Complete | `app/accounts/loans/`, `services/loansService.ts`, `LoanEntryActions.tsx` |

---

## 5. Business Rules

### Hotel Stay Timing Policy (`HOTEL_POLICY` in `lib/mockData.ts`)
```typescript
export const HOTEL_POLICY = {
  checkinHour:    12,   // 12:00 PM
  checkinMinute:  0,
  checkoutHour:   11,   // 11:59 AM
  checkoutMinute: 59,
  graceMinutes:   30,   // grace period after scheduled checkout
} as const;
```

### Checkout Gate Formula
```
finalPayable = (totalAmount + extraChargeAmount)
             - earlyDeductionAmount
             - additionalDiscountAmount
             - amountPaid

if finalPayable > 0:
  → staff sees "Add Payment" button
  → admin sees "Override Checkout" button
else:
  → all roles see normal "Checkout" button
```

### Early Checkout Deduction (Stay Timing Step 2)
- `earlyNightsDeducted = max(0, plannedCheckoutDate − actualCheckoutDate)` — calendar days
- `earlyDeductionAmount = earlyNightsDeducted × bookingRate`
- Computed by `calcEarlyDeduction()` in `BookingsClient.tsx` and `FrontDeskClient.tsx`
- Written at checkout: `actual_checkout_date`, `early_nights_deducted`, `early_deduction_amount`

### Additional Discount at Checkout
- Optional ad-hoc discount entered in the "More Discount" section; no role restriction
- Validated: `amt ≤ (totalAmount + extraChargeAmount − earlyDeductionAmount − amountPaid)`
- Written at checkout: `additional_discount_amount`, `additional_discount_reason`, `additional_discount_by`, `additional_discount_at`

### Payment Methods
- **5 user-selectable**: `cash`, `card`, `bank_transfer`, `bkash`, `nagad`
- UI state defaults to `"cash"` — never empty — so a method is always captured
- `formatPaymentMethod(value)` — safe display formatter for **any** value including legacy

### `calcTrueDue()` — Canonical Due-Amount Formula
```typescript
function calcTrueDue(b: {
  totalAmount:               number;
  amountPaid:                number;
  extraChargeAmount?:        number;
  earlyDeductionAmount?:     number;
  additionalDiscountAmount?: number;
}): number {
  return b.totalAmount
    + (b.extraChargeAmount          ?? 0)
    - (b.earlyDeductionAmount       ?? 0)
    - (b.additionalDiscountAmount   ?? 0)
    - b.amountPaid;
}
```
**⚠️ CRITICAL:** Never use the naive `totalAmount − amountPaid`.

### Financial Accounting Rules

#### Account Transaction Types (`AccountTxnType`)
| Type | `from` | `to` | Usage |
|---|---|---|---|
| `revenue_in` | NULL | account | Revenue received |
| `expense_out` | account | NULL | Expense paid |
| `transfer` | account | account | Move between accounts |
| `injection` | NULL | account | Owner capital injection |
| `loan_received` | NULL | account | Loan cash received |
| `loan_repayment` | account | NULL | Loan repaid |

#### Loan Status (derived, never stored)
```
repaid      = SUM of all loan_repayment txns with this loan_id
outstanding = MAX(0, principal − repaid)
status      = "repaid" if repaid >= principal, else "outstanding"
```

#### Revenue (entry + report)
Revenue is `revenue_in` rows on `account_transactions`, in two flavours:
- **Booking/room income** — auto-generated by `fn_sync_account_transactions` when a guest pays (`booking_payment_id` set). Not created or shown by the entry page.
- **Manual/other income** (rent, etc.) — entered via `app/accounts/revenue-management/` → `createRevenue` (`services/revenueService.ts`): `to_account_id` = user-picked bucket, `from_account_id` NULL, `revenue_category_id` (a *separate* column from expenses' `category_id`), `payee` REQUIRED, no voucher, no `employee_id`. `getRevenues` returns only this slice (`booking_payment_id IS NULL`).
- **Revenue report** (`app/accounts/revenue-report/`, admin-guarded) reads ALL `revenue_in` via `getTransactions` (totals, by-bucket, source split, trend) and the manual slice via `getRevenues` (per-category breakdown). The two partitions — `booking_payment_id` set vs null — are complementary, so totals never double-count. Bucket names via `getAccounts`; category names via `getRevenueCategories`. Booking rows in the report are enriched with source detail (guest, booking ref + link, rooms, status, totals, payment method) via `getBookingPaymentMap` in `bookingsService` (payment id → booking_id → booking_ref, two flat selects) joined with `getAllBookings`.

#### Payroll (salary / advance / bonus)
Payroll is not a separate engine — it is expense machinery. Recording a salary, advance, or bonus payment routes through `createExpense` (`services/expensesService.ts`): an `account_transactions` row, `type = 'expense_out'`, funded from Cash in Hand, `category_id` = the "Salary" category, `payeeMode: "employee"` with `employee_id` = `Employee.id` (the UUID, **not** the `EMP-001` code), and an auto-generated `EV-YYYY-NNNN` voucher.
- Payment type is stored as a leading label in `note` (e.g. `"Advance — June rent"`); `parseKind()` in `PayrollClient` reads it back. No schema change required.
- The "Salary" `expense_categories` row is find-or-created on first payment (case-insensitive match).
- Salary payments appear in the Cashbook like any other expense. File: `app/accounts/payroll/PayrollClient.tsx`.

#### Inventory Purchase Seam (expense → inventory)
When recording an expense of type "inventory purchase":
- An `inventory_movement` is created alongside the `account_transaction`
- Stock is **always in base units**; if item has `units_per_pack`, conversion is:
  ```typescript
  baseQty = exInvUnit === "pack" && upp != null ? packQty * upp : packQty
  ```
- Unit price fallback: `amount / baseQty` (price per base unit)
- Both `InventoryClient` (Add Stock) and `ExpenseClient` (expense purchase) use this same pattern

#### Pack / Base Unit Toggle
Items that are purchased in packs (e.g. a box of 24 pieces) have:
- `pack_label` — display name for the pack (e.g. "box")
- `units_per_pack` — numeric conversion factor

When entering stock or an expense purchase for such an item, a `<select>` toggle switches between:
- **Pack mode** (default): user enters number of packs; hint shows `= N units`
- **Base mode**: user enters base units directly

State variable: `stockUnit` (InventoryClient) / `exInvUnit` (ExpenseClient), both `"pack" | "base"`, default `"pack"`, reset on modal close.

Dynamic labels:
- Quantity label: `Quantity (in box)` or `Quantity (in piece)` when pack configured
- Unit price label: `Price per box (৳)` or `Price per piece (৳)` when pack configured

### Three-Layer Payment Enforcement
1. **Layer A (UI)** — "Add Payment" button hidden when conditions not met
2. **Layer B (handler)** — `handleAddPayment()` re-checks before calling context
3. **Layer C (context)** — `recordPayment()` hard-blocks if status check fails

### Three-Layer Double-Booking Prevention
1. **Layer A (UI)** — `useMemo` computes overlap on every keystroke
2. **Layer B (handler)** — `handleSubmit()` re-checks before `createBooking()`
3. **Layer C (service)** — `bookingsService.createBooking()` queries DB for overlaps (Step 2.5 — one query per room, non-fatal on query error)
4. **Layer D (RPC)** — `create_booking_with_rooms` and `add_room_to_booking` each run an in-transaction overlap check and `RAISE EXCEPTION` on conflict; both RPCs **fail closed** (added 2026-06-07 via `2026-06-07-booking-overlap-guard.sql`)

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
