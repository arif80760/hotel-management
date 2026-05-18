# Accounts — Architecture Document

**Project:** Hotel Albatross Resort
**Status:** DRAFT v2 — for review before build
**Date:** 2026-05-18 (Day 15)
**Build order:** Phase E (admin-only role gate) → Accounts core → Expense → Payroll → Revenue → Loans → (Inventory, separate feature, later)

---

## 1. Purpose and Scope

This is a **mid-range bookkeeping tool for the hotel team**, not professional
accounting software. No double-entry ledger, no chart of accounts, no tax or
statutory modules. It records, in plain terms, the money that moves through
Hotel Albatross Resort and totals it up so a hotel manager can read it.

The mental model is a **cash register / daybook**, not "accounting."

The entire Accounts section is **admin-only**. Staff cannot access it. This
restriction is enforced by Phase E (role-based access control) — see Section 9.

---

## 2. Core Model — Buckets and Transactions

### 2.1 Accounts (money "buckets")

Money lives in four buckets, each with a running balance:

| Bucket        | Spendable by admin? | Notes |
|---------------|---------------------|-------|
| Cash in Hand  | YES                 | The only bucket the admin can spend FROM |
| Bank          | NO                  | Tracked for reporting; admin has no access |
| bKash         | NO                  | Tracked for reporting; admin has no access |
| Nagad         | NO                  | Tracked for reporting; admin has no access |

**Key rule:** The admin can only spend from **Cash in Hand**. Bank, bKash, and
Nagad can RECEIVE money and money can be TRANSFERRED out of them into Cash, but
the admin can never create an expense directly against them. This is a real
hotel policy ("admin has no access to the bank") and the software enforces it —
the expense form only ever offers Cash as the source.

Bank/bKash/Nagad are mostly **track-and-report** buckets: they accumulate so the
hotel can see how much money flowed through each over a day/week/month/year.

### 2.2 Transactions

Every movement of money is a **transaction**. There are **six types**:

| Type            | Effect on buckets | Counts as revenue? | Counts as expense? |
|-----------------|-------------------|--------------------|--------------------|
| Revenue in      | A bucket goes UP  | YES                | no |
| Expense out     | Cash goes DOWN    | no                 | YES |
| Transfer        | One bucket DOWN, another UP | no       | no |
| Injection       | Cash goes UP      | no                 | no |
| Loan received   | Cash goes UP      | no                 | no |
| Loan repayment  | Cash goes DOWN    | no                 | no |

Each transaction has: date, amount, type, the bucket(s) it affects, a
category (for expenses and other-revenue), a note, and optionally an attached
receipt image.

**Why six types and not fewer:** Injection, loan received, and revenue all
move cash UP — but they are NOT the same thing. Revenue is income (counts in
revenue reports). An injection is outside money management adds (not income).
A loan is borrowed money that must be repaid (not income, and the repayment is
not an expense). Tagging them distinctly keeps revenue and expense reports
honest. See Sections 4 and 12.

---

## 3. Revenue

Revenue (money in) has two sources:

### 3.1 Booking revenue — automatic

Every booking payment already exists in the database (`payments` table). The
Accounts feature does **not** re-enter these. It READS them.

**Critical integration rule — bucket mapping by payment method:** every booking
payment lands in the bucket that matches its payment method:

| Booking payment method | Accounts bucket |
|------------------------|-----------------|
| cash                   | Cash in Hand    |
| bank                   | Bank            |
| bkash                  | bKash           |
| nagad                  | Nagad           |

The booking system already records a `method` on each payment; Accounts maps
that method to a bucket automatically. No manual re-entry of booking income.

This is the single most important integration seam in the feature. If a
booking payment does not flow into the correct bucket, Cash in Hand in Accounts
will not match the physical cash and the whole feature loses trust. This seam
must be designed and tested with extra care. See Section 8.

### 3.2 Other revenue — manual entry, dynamic categories

Hotel Albatross earns money outside the booking system: rented restaurant,
rented office space, and other sources. These are entered manually as
"Revenue in" transactions, into whichever bucket received the money.

**Other-revenue sources are dynamic categories**, not a fixed list — see
Section 7.

---

## 4. Expenses

Money out. This is the largest area of NEW data entry — the hotel has expenses
daily (electricity, supplies, maintenance, salaries, and hundreds of item
types).

- An expense is a transaction of type **Expense out**.
- An expense is **always funded from Cash in Hand**. The form does not offer
  any other bucket.
- Every expense has a **category** (dynamic — see Section 7).
- An expense may have a **receipt image** attached (see Section 10).
- Every expense generates a **payment voucher** (see Section 5).

### 4.1 Inventory hook-point (FUTURE — not built now)

Inventory is a separate feature, built later. The seam: when an expense is the
purchase of a stockable product, that purchase should also increase inventory.

**Now:** the expense transaction design must leave room for an optional "this
expense is a product purchase" link, so inventory can plug in later WITHOUT a
schema rebuild. We do not build inventory now — we only avoid walling it out.

---

## 5. Expense Voucher

Every expense generates a **payment voucher** — a formal, professional document
that is the hotel's proof of payment (for a bill, a vendor, a repair). It is
NOT the booking invoice: a booking invoice is money coming IN from a guest; a
voucher is money going OUT, the hotel's record of having paid.

### 5.1 Voucher contents

- **Voucher number** — sequential and unique (e.g. VCH-0001). Stored on the
  expense transaction.
- Date
- **Paid to / payee** name
- **Amount in figures AND in words** (e.g. "Tk 50,000" and "Taka Fifty Thousand
  only") — vouchers conventionally show both
- Category / purpose of the expense
- Payment method (Cash in Hand)
- Hotel letterhead / branding
- "Prepared by" and signature lines

### 5.2 No approval workflow

The voucher is simply **generated** when the expense is recorded. There is no
prepared/approved status cycle — management approval happens verbally, the
software does not model an approver. (Consistent with the rest of the design:
the admin records, management instructs verbally.)

### 5.3 Generation

The voucher is a generated printable document, the same approach as the
existing invoice and reservation pages: an HTML page with print CSS, produced
via the browser print to Save-as-PDF flow.

---

## 6. Payroll

Payroll lives under the Accounts menu (`Accounts > Payroll`) and has its own
screen, but underneath it is **expense machinery**, not a separate engine.

- A salary payment is an **Expense out** transaction, category "Salary",
  linked to an employee record, funded from Cash.
- **No hour tracking, no automated salary calculation, no deductions.** The
  system only RECORDS salary paid.
- Supported variations: regular **salary**, **advance** (money paid to staff
  ahead of salary), and **bonus**.
- The Payroll screen is a salary-focused VIEW: per employee, per month — but
  the records are expense transactions tagged accordingly.
- A salary payment also generates a voucher (Section 5).

---

## 7. Categories (Dynamic)

Both expense categories and other-revenue sources are **dynamic** — not fixed
lists in code.

- There is a section to **create categories**.
- Once created, a category is available for selection.
- The expense form (and the other-revenue form) **autocompletes / suggests**
  from existing categories as the user types.
- If the user types something that is not yet a category, the form lets them
  **create it on the spot** — so expense entry is never blocked by a missing
  category.
- Expense categories and revenue categories are separate sets (an expense
  category like "Maintenance" is not a revenue source).

---

## 8. Integration with the Existing Booking System

The booking system already records `payments` with a `method`. Accounts must:

1. Read booking payments and attribute each to the correct bucket by method
   (mapping in Section 3.1).
2. Do this automatically — no manual re-entry of booking income.
3. Ensure booking payments correctly affect the day they belong to, so the
   daybook and day-close totals are accurate.

**Open design question for the build phase:** decide the exact mechanism — e.g.
booking payments are surfaced into the transaction view via a read/derive
relationship, vs. a trigger that writes a matching accounts transaction row.
This must be resolved carefully during the Accounts-core build; it is the
seam most likely to cause balance drift if done loosely.

---

## 9. Access Control (Phase E dependency)

The entire Accounts section — including Expense, Payroll, Revenue, Loans, the
voucher, and the Accounting tab — is **admin-only**. Staff cannot see or reach
it.

This depends on **Phase E** (role-based access control), built BEFORE Accounts.
Phase E provides: UI gating (staff do not see Accounts nav links and cannot
reach the routes) and server-side enforcement (RLS policies on the accounts
tables restrict access to the admin role via the current_user_role() helper).
UI hiding alone is not security.

Phase E's admin-only enforcement pattern — current_user_role() = 'admin' in RLS
policies — must be applied to every accounts table defined in this document.

Roles: only **Admin** and **Staff**. No third "management" role — management
instructs verbally; the admin records what they are told.

---

## 10. Image Storage (Receipts and Guest Documents)

Receipt images (expenses) and guest documents (ID/passport scans) are both
stored in **Supabase Storage**.

- **Plan:** Supabase Pro, $25/month. Includes 100 GB file storage and 250 GB
  bandwidth. This comfortably covers guest documents + expense receipts for a
  single hotel — storage is not expected to be a cost concern. Storage overage,
  if ever reached, is roughly $0.021/GB/month.
- **Image compression on upload** is built in. Receipts and ID scans only need
  to be legible, not high-resolution. Compression keeps both storage and
  bandwidth low and is applied to all uploaded images.
- Access to stored images respects the access-control model: receipt images
  (Accounts) are admin-only; guest documents follow the booking-section access
  rules.

---

## 11. The Day-Close (Opening / Closing Balance)

### 11.1 Concept

- **Opening balance** = Cash in Hand at the start of a day.
- **Closing balance** = Cash in Hand at the end of a day, after all that day's
  transactions.
- Today's opening balance = yesterday's closing balance. It is a continuous
  daily chain.

### 11.2 Day-close is a manual action

The admin/accountant performs a deliberate **"Close Day"** action each evening.
Closing a day freezes that day's closing balance. It is a real review step —
the close screen shows that day's transactions and totals, not a blind click.

### 11.3 Missed days — sequential catch-up

The accountant sometimes forgets to close for 2, 3, or 4 days.

- The system knows the last closed day.
- If there are unclosed days before the day being worked on, the app warns:
  "Days X, Y, Z are not closed — close them first."
- Closed days MUST be closed **oldest-first, one at a time**, because each
  day's closing balance is the next day's opening balance — they cannot be
  closed out of order.
- Each catch-up close still shows that day's transactions and totals — it is a
  genuine review even when clearing a backlog.

---

## 12. Loans

Loans from third parties to cover costs (e.g. a lift-motor repair).

A loan is two events separated by time, and it is **neither revenue nor
expense** — recording it as such would corrupt those reports.

### 12.1 Loan record

A **Loan** has: lender (who it is from), amount, date taken, amount repaid so
far, and a status: **outstanding** or **repaid**.

### 12.2 Loan transactions

- **Taking a loan** results in a transaction of type **Loan received**: Cash
  goes UP. Not counted as revenue.
- **Repaying a loan** results in a transaction of type **Loan repayment**: Cash
  goes DOWN, linked to the loan record. Not counted as an expense.

### 12.3 Partial repayment

A loan may be repaid in one payment or in several parts. Each repayment
transaction references its loan and reduces the outstanding amount. When the
repayments sum to the full loan amount, the loan status flips to **repaid**.

### 12.4 Loan vs Injection

Both move outside money INTO Cash. The difference is the only thing that
matters: a **loan must be repaid; an injection does not**. The entry screen
must make the user choose clearly which one they are recording.

### 12.5 Loans view

A small screen listing loans and their status — how much the hotel currently
owes and to whom. Built after Revenue Management.

---

## 13. Screens (under `Accounts`, admin-only)

| Screen | Purpose |
|--------|---------|
| Accounting tab / Daybook | Today's opening balance, all transactions today, running closing balance, the Close Day action, sequential catch-up for missed days, and the searchable full transaction history with invoice/voucher links |
| Expense Management | Enter and list expenses (funded from Cash), by dynamic category; optional receipt image; generates a voucher per expense |
| Payroll | Salary / advance / bonus per employee, per month — salary-focused view over Salary-tagged expense transactions |
| Revenue Management | Reporting view: booking revenue (read from payments) + other revenue, by period and by bucket |
| Loans | List of loans and their outstanding/repaid status |
| Categories | Create/manage expense categories and other-revenue categories |

---

## 14. Data Model (Draft — to be finalised at build time)

Indicative only. Exact columns, types, and constraints are finalised when the
Accounts core is built.

**`accounts`** — the four buckets
- id, name (Cash in Hand / Bank / bKash / Nagad), current_balance, is_spendable

**`account_transactions`** — every money movement
- id, date, type (revenue_in / expense_out / transfer / injection /
  loan_received / loan_repayment), amount
- account_id (bucket affected; for transfer: from/to bucket references)
- category_id (nullable — for expenses and other-revenue)
- note, receipt_image_url (nullable)
- voucher_number (nullable — for expense_out transactions)
- payee (nullable — for expense_out / voucher)
- employee_id (nullable — for Salary-type expenses)
- loan_id (nullable — for loan_received / loan_repayment)
- booking_payment_id (nullable — link to existing payments row, if derived
  from a booking payment)
- product_purchase fields (nullable — RESERVED for the future inventory
  hook-point; left open, not used yet)

**`account_categories`** — dynamic categories
- id, name, kind (expense / revenue)

**`loans`**
- id, lender, amount, date_taken, amount_repaid, status (outstanding / repaid)

**`day_closes`** — the day-close chain
- id, close_date, opening_balance, closing_balance, closed_by, closed_at

Booking `payments` — existing table, READ by Accounts; not duplicated.

---

## 15. Build Order

1. **Phase E** — admin-only role-based access control. Prerequisite. DONE.
2. **Accounts core** — buckets, transactions, the daybook, the day-close
   (including sequential catch-up), and the booking-payment integration seam.
3. **Expense Management** — expense entry/list, dynamic categories, receipt
   images, voucher generation.
4. **Payroll** — salary/advance/bonus screen over expense transactions.
5. **Revenue Management** — revenue reporting view.
6. **Loans** — loans list and outstanding tracking.
7. **Inventory** — SEPARATE feature, built later. Plugs into the expense
   product-purchase hook-point reserved in Section 4.1.

---

## 16. Resolved Decisions (Day 15)

- Expense categories: dynamic, created in a Categories section, autocomplete on
  the expense form, create-on-the-spot allowed.
- Other-revenue sources: dynamic categories, same pattern as expenses.
- Booking-payment to bucket: automatic mapping by payment method (Section 3.1).
- Receipt / document image storage: Supabase Pro ($25/mo), with image
  compression on upload. Storage is not a cost concern at hotel scale.
- Expense voucher: generated, no approval workflow (Section 5).

## 17. Open Questions to Resolve During Build

1. The exact booking-payment to bucket mechanism (Section 8) — derive vs.
   trigger-written transaction rows.
2. Voucher number sequence — how the sequential VCH-#### counter is generated
   safely (no gaps/collisions under concurrent use).
3. Exact Supabase Storage bucket structure and access policies for receipts
   vs. guest documents.

---

*End of draft v2.*
