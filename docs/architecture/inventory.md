# Inventory Architecture

**Status:** Draft, Day 22 (2026-05-31).
**Build order anchor:** docs/architecture/accounts.md §6 lists Inventory as a separate feature; this document is its spec.
**Seam:** accounts.md §4.1 (Expense → Inventory hook-point).

---

## 1. What we're tracking

Two real categories of items move through the hotel:

- **Consumables** — water bottles, toiletries, cleaning supplies, soap, detergent, food/drink stock. Bought in batches, distributed to rooms or used in operations, eventually used up. Stock count decreases through normal use.
- **Durables (fixed items)** — TVs, ACs, beds, curtains, bed sheets, towels, furniture. Bought once, assigned to a specific room (or kept in storage). Stock count only changes on damage, loss, or disposal. Their day-to-day "use" (sheets get washed and reused, AC cools the room) is not tracked.

The split is operational, not philosophical. Bed sheets cycle through laundry constantly but are durable because we don't decrement count on each wash; we decrement only when sheets are damaged or retired.

Both paths flow through the Expense department for purchase. The expense-inventory seam (see §6) is how a purchase entry on the accounts side automatically updates inventory.

---

## 2. The core invariant: stock = sum of movements

The system records **stock movements** (events that change inventory), not "current stock counts."

```
Current stock of any item = SUM of all movement quantities for that item
                            (signed by movement type)
```

This is the same pattern as `account_transactions` for money. The benefit: full audit trail, point-in-time queries ("what was the stock on May 15?"), no chance of a stale `count` column drifting from reality.

**Movement types:**

| Type           | Stock impact | Notes |
| -------------- | ------------ | ----- |
| `purchase`     | + quantity   | unit_price recorded. Optionally linked to an expense row. |
| `issue`        | − quantity   | Consumables only. Optional employee recipient. |
| `damage`       | − quantity   | Durables: also adjusts room assignment. |
| `adjustment`   | ± signed     | Manual correction. **Reason note required.** |
| `transfer`     | 0            | Durables only. Moves count from one room assignment to another. |

Current stock is always derivable; we never let it become canonical.

---

## 3. Tables

### 3.1 `inventory_categories`

Dynamic categorization of items (e.g. "Toiletries", "Electronics", "Linens", "Cleaning", "Furniture"). Same lifecycle pattern as `expense_categories`: rename allowed, soft-deactivate via `is_active = false`, no DELETE because past items reference them.

Distinct from `expense_categories` (purpose of an expense) and `revenue_categories` (source of revenue). An expense in category "Room Supplies" can contain items in inventory categories "Toiletries" + "Cleaning" + "Linens".

### 3.2 `inventory_items`

The canonical thing being tracked. Each row = one product line (e.g. "500ml Water Bottle", "Samsung 1.5-ton AC", "King-size Bed Sheet").

Fields:
- `id UUID PRIMARY KEY`
- `name TEXT NOT NULL` — human-readable, unique-ish but not UNIQUE constraint (case-sensitivity etc.)
- `category_id UUID` FK to `inventory_categories`
- `type TEXT NOT NULL` CHECK in (`'consumable'`, `'durable'`)
- `unit TEXT NOT NULL` CHECK in (`'piece'`, `'kg'`, `'gram'`, `'litre'`, `'millilitre'`, `'metre'`, `'set'`, `'box'`, `'other'`) — unit of measure
- `notes TEXT` — free description (brand, model, supplier hint, etc.)
- `is_active BOOLEAN NOT NULL DEFAULT true`
- `low_stock_threshold NUMERIC(10,2)` — RESERVED for future low-stock alerts; nullable
- `created_at/by`, `updated_at`

### 3.3 `inventory_movements`

Every event that affects stock or assignment. Append-only by convention (no DELETE policy; corrections happen via new `adjustment` movements with reason_note).

Fields:
- `id UUID PK`
- `item_id UUID NOT NULL` FK to `inventory_items` ON DELETE RESTRICT
- `type TEXT NOT NULL` CHECK in (`'purchase'`, `'issue'`, `'damage'`, `'adjustment'`, `'transfer'`)
- `quantity NUMERIC(10,2) NOT NULL` — always positive for purchase/issue/damage; can be positive or negative for adjustment; for transfer it's the count moved (positive).
- `unit_price NUMERIC(10,2)` — set on purchase movements; NULL on others.
- `happened_at TIMESTAMPTZ NOT NULL DEFAULT now()` — when it actually happened (not just inserted).
- `recorded_by UUID` — auth user
- `source_account_transaction_id UUID` FK to `account_transactions` ON DELETE RESTRICT — set only when this movement was created by an expense entry. Phase I-D seam.
- `issued_to_employee_id UUID` FK to `employees` — only for `type='issue'`, optional.
- `from_room_id UUID` FK to `rooms` — only for `type='transfer'` (or `type='damage'` on durables, to record which room the item was in).
- `to_room_id UUID` FK to `rooms` — only for `type='transfer'` (or `type='purchase'` on durables that go straight to a room).
- `reason_note TEXT` — REQUIRED for `type='adjustment'` (CHECK enforces). Optional for others.
- `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`

CHECK constraint enforces type-specific field requirements (see §5).

### 3.4 `inventory_assignments` (durables only)

For each durable item, how many of its units are in which room. A read-model: kept in sync via movements.

Fields:
- `id UUID PK`
- `item_id UUID NOT NULL` FK to `inventory_items`
- `room_id UUID NOT NULL` FK to `rooms`
- `quantity NUMERIC(10,2) NOT NULL DEFAULT 0` — count of this item currently in this room
- `status TEXT NOT NULL DEFAULT 'in_service'` CHECK in (`'in_service'`, `'damaged'`)
- `created_at`, `updated_at`

UNIQUE constraint on `(item_id, room_id, status)`.

When an AC is purchased and assigned to Room 203: insert a row `(ac_item, room_203, 1, in_service)`.
When an AC is transferred to Room 105: decrement the 203 row, increment (or create) the 105 row.
When an AC is damaged: decrement in_service, increment damaged.

For consumables, this table stays empty.

---

## 4. The Expense-Inventory seam (Phase I-D)

When recording an expense via the Expense entry form (built Day 21), the user can toggle "This is an inventory purchase":

- ON → reveal a sub-form: item picker (autocomplete from `inventory_items`, with "+ Create new item" inline), quantity, unit_price (defaults to expense_amount ÷ quantity but editable).
- OFF → expense saves as a normal non-inventory expense, no movement created.

On submit with the toggle ON, **a single atomic operation** writes:
1. The `account_transactions` row (the expense).
2. The `inventory_movements` row (the purchase), with `source_account_transaction_id` pointing at the expense's UUID.

The two are linked. If the expense is later soft-deleted or edited, the linked movement should be flagged (Day 23+ concern; for now, soft-deleting an expense leaves the movement intact with a note about the orphan).

**Validation:** quantity × unit_price should ≈ expense amount, but they're not forced to match exactly — there can be legitimate reasons for drift (rounding, multi-item expense). Display a warning if mismatched, don't block.

---

## 5. CHECK constraints summary

### On `inventory_items`:
- `type IN ('consumable', 'durable')`
- `unit IN ('piece', 'kg', 'gram', 'litre', 'millilitre', 'metre', 'set', 'box', 'other')`

### On `inventory_movements`:
A CASE constraint branching on `type`:

- `purchase`: quantity > 0, unit_price IS NOT NULL, issued_to_employee_id IS NULL.
- `issue`: quantity > 0, unit_price IS NULL, from_room_id IS NULL, to_room_id IS NULL. issued_to_employee_id optional.
- `damage`: quantity > 0, unit_price IS NULL, issued_to_employee_id IS NULL.
- `adjustment`: quantity can be ANY non-zero (positive or negative), reason_note IS NOT NULL, all room/employee/unit_price fields IS NULL.
- `transfer`: quantity > 0, from_room_id IS NOT NULL, to_room_id IS NOT NULL, from_room_id ≠ to_room_id, unit_price IS NULL, issued_to_employee_id IS NULL.

### On `inventory_assignments`:
- `quantity >= 0`
- UNIQUE `(item_id, room_id, status)`

---

## 6. UI surfaces

**Location:** `app/inventory/` (separate top-level route, not under `app/accounts/`).

Five real screens:

1. **Inventory home (`/inventory`)** — list of all items. Filter by category, search by name. Per-row stock count (computed from movements). For durables, the current room assignments summary.
2. **Item detail (`/inventory/[id]`)** — full movement history for one item, current stock breakdown, assignments table (for durables), action buttons (Issue, Damage, Adjust, Transfer).
3. **Manage Categories modal** — same pattern as expense/revenue categories.
4. **Add Item modal** — name, category, type (consumable/durable), unit, notes.
5. **Movement entry modals** — one per movement type (or one modal with type-selector at top).

Plus, on the Expense entry modal (`app/accounts/expense/`), the "This is an inventory purchase" toggle and its sub-form.

---

## 7. Manual purchase (no expense linkage)

For opening-stock entries ("we already have 50 water bottles when the system goes live") and corrections, the inventory page has an **Add Stock** action that creates a `purchase` movement without a `source_account_transaction_id` and without affecting accounts. Reason note required for this path.

---

## 8. Reports (future, not Phase I)

These are the analytics that fall out naturally once stock movements exist:

- Stock report by item (current count, by category)
- Movement audit log (filter by date, type, item, employee)
- Item issue frequency (which items leave inventory fastest)
- Spend per item / per category (joins movements with their source expense rows for unit_price × quantity)
- Damage reports (which rooms see most damage, which items get damaged most)

None of these are built in Phase I. They're called out so the schema supports them.

---

## 9. Phase plan

- **Phase I-A** (this document)
- **Phase I-B** — schema migration: 4 new tables, FKs, CHECK constraints, RLS, indexes
- **Phase I-C** — services + base inventory page (list, item detail, basic CRUD)
- **Phase I-D** — expense entry integration (the seam)
- **Phase I-E** — handoff

---

## 10. Open questions for the future

- **Item-instance tracking** (Option Z from Day 22 design) — high-value durables with serial numbers, repair history, depreciation. Not in Phase I; revisit if/when the hotel sees enough breakdown to need it.
- **Low-stock alerts** — `low_stock_threshold` column reserved on `inventory_items`. UI to set thresholds + dashboard widget to surface alerts comes after Phase I is in use.
- **Stocktake / physical audit** — periodic count reconciliation with `adjustment` movements when reality differs from book. The schema supports it; the UI doesn't yet.
- **Multi-unit conversion** — when one purchase is in "box of 24" but issued by "piece", we'd want a conversion factor. Today we'd require the user to record the item in pieces from the start. Revisit if mixed-unit items become a real pain.
- **Edit/delete of past movements** — currently movements are append-only; corrections go through `adjustment`. If editing past movements becomes a real need, we'd need versioning or audit columns like account_transactions has (deleted_at, edited_at). Day 23+ concern.
