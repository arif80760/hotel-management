-- sql/migrations/2026-05-31-inventory-schema.sql
-- Phase I-B of Inventory bootstrap.
--
-- ─── STATUS ───────────────────────────────────────────────────
-- APPLIED 2026-05-31 (Day 22) — four new tables (inventory_categories,
-- inventory_items, inventory_movements, inventory_assignments), four
-- ENUM types (item_type, item_unit, movement_type, assignment_status),
-- one CHECK constraint with five-branch CASE on movement type, one
-- assignment quantity CHECK, one (item_id, room_id, status) UNIQUE,
-- 10 partial/regular indexes, RLS on all 4 tables with authenticated
-- read/insert/update policies, touch_updated_at trigger on the three
-- mutable tables (movements is append-only).
--
-- Verified post-apply: all tables exist, all ENUMs created, both
-- CHECKs and the UNIQUE present, all 10 indexes, RLS true on all 4,
-- 3 triggers (movements correctly skipped).
-- ──────────────────────────────────────────────────────────────
--
-- Spec: docs/architecture/inventory.md (Phase I-A, commit 92f6ac5).
--
-- Creates four new tables:
--   1. inventory_categories — dynamic categories (parallel to
--      expense_categories, revenue_categories).
--   2. inventory_items — the canonical product line (consumable or
--      durable, with unit of measure, category, notes).
--   3. inventory_movements — append-only event log of stock changes.
--      Five movement types: purchase, issue, damage, adjustment,
--      transfer. CHECK constraint branches on type for field
--      requirements.
--   4. inventory_assignments — for durables only, tracks which room
--      has which items in what status.
--
-- Plus: indexes, RLS, touch_updated_at triggers, ENUM types for
-- movement_type / item_type / item_unit / assignment_status.
--
-- Pre-verification (done before drafting):
--   - public.rooms exists with id uuid PK (confirmed)
--   - public.employees exists with id uuid (confirmed)
--   - No prior inventory_* tables (confirmed clean slate)
--   - public.account_transactions exists (Day 11 + Day 21 + Day 22 work)
--
-- The expense-inventory seam (Phase I-D) will use
-- inventory_movements.source_account_transaction_id to link a
-- purchase movement to its expense row. The FK is set up here
-- but no row writes the linkage until I-D ships.
-- =============================================================


-- ── ENUMS ─────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'inventory_item_type') THEN
    CREATE TYPE public.inventory_item_type AS ENUM ('consumable', 'durable');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'inventory_item_unit') THEN
    CREATE TYPE public.inventory_item_unit AS ENUM ('piece', 'kg', 'gram', 'litre', 'millilitre', 'metre', 'set', 'box', 'other');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'inventory_movement_type') THEN
    CREATE TYPE public.inventory_movement_type AS ENUM ('purchase', 'issue', 'damage', 'adjustment', 'transfer');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'inventory_assignment_status') THEN
    CREATE TYPE public.inventory_assignment_status AS ENUM ('in_service', 'damaged');
  END IF;
END
$$;


-- ── 1. inventory_categories ───────────────────────────────────

CREATE TABLE IF NOT EXISTS public.inventory_categories (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT         NOT NULL UNIQUE,
  is_active  BOOLEAN      NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_by UUID,
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.inventory_categories IS
  'Dynamic categories for inventory item classification (Toiletries, Electronics, Linens, Cleaning, Furniture, etc.). Distinct from expense_categories and revenue_categories — items can belong to "Toiletries" while a related expense belongs to "Room Supplies".';

COMMENT ON COLUMN public.inventory_categories.is_active IS
  'Soft-deactivate flag. Past items keep their FK; new items can''t select inactive categories from the form.';


-- ── 2. inventory_items ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.inventory_items (
  id                   UUID                          PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT                          NOT NULL,
  category_id          UUID                          REFERENCES public.inventory_categories(id) ON DELETE RESTRICT,
  type                 public.inventory_item_type    NOT NULL,
  unit                 public.inventory_item_unit    NOT NULL,
  notes                TEXT,
  is_active            BOOLEAN                       NOT NULL DEFAULT true,
  low_stock_threshold  NUMERIC(10,2),
  created_at           TIMESTAMPTZ                   NOT NULL DEFAULT now(),
  created_by           UUID,
  updated_at           TIMESTAMPTZ                   NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.inventory_items IS
  'The canonical product line. Examples: "500ml Water Bottle" (consumable, piece), "Samsung 1.5-ton AC" (durable, piece), "King-size Bed Sheet" (durable, piece). Per inventory.md §3.2: name is unique-ish but not UNIQUE constrained — case/spelling variations are the user''s responsibility, autocomplete helps reduce drift.';

COMMENT ON COLUMN public.inventory_items.type IS
  'consumable: tracked by stock count only, decreased via issue/damage. durable: also tracked per-room via inventory_assignments.';

COMMENT ON COLUMN public.inventory_items.low_stock_threshold IS
  'RESERVED for future low-stock alerts (post-Phase I). Nullable; UI to set thresholds not yet built.';


-- ── 3. inventory_movements ────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.inventory_movements (
  id                            UUID                              PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id                       UUID                              NOT NULL REFERENCES public.inventory_items(id)         ON DELETE RESTRICT,
  type                          public.inventory_movement_type    NOT NULL,
  quantity                      NUMERIC(10,2)                     NOT NULL,
  unit_price                    NUMERIC(10,2),
  happened_at                   TIMESTAMPTZ                       NOT NULL DEFAULT now(),
  recorded_by                   UUID,
  source_account_transaction_id UUID                              REFERENCES public.account_transactions(id) ON DELETE RESTRICT,
  issued_to_employee_id         UUID                              REFERENCES public.employees(id)            ON DELETE RESTRICT,
  from_room_id                  UUID                              REFERENCES public.rooms(id)                ON DELETE RESTRICT,
  to_room_id                    UUID                              REFERENCES public.rooms(id)                ON DELETE RESTRICT,
  reason_note                   TEXT,
  created_at                    TIMESTAMPTZ                       NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.inventory_movements IS
  'Append-only event log of stock changes. Current stock for an item = SUM of all movement quantities, signed by type. Same pattern as account_transactions. Five movement types — see inventory.md §2.';

COMMENT ON COLUMN public.inventory_movements.quantity IS
  'Always positive for purchase/issue/damage/transfer. Can be positive or negative for adjustment. CHECK enforces.';

COMMENT ON COLUMN public.inventory_movements.unit_price IS
  'Set on purchase movements; NULL on others. Required for moving-average cost (future feature) and per-item spend reporting.';

COMMENT ON COLUMN public.inventory_movements.source_account_transaction_id IS
  'The expense-inventory seam (Phase I-D). When a purchase movement originates from an expense entry, this points back to the account_transactions row. NULL for manual purchases (opening stock, corrections) — see inventory.md §7.';


-- ── 4. CHECK constraint on inventory_movements ────────────────
--
-- Five branches enforce type-specific field requirements per
-- inventory.md §5. Not adding NOT VALID; we want existing rows
-- to pass (there are none today, but if any are inserted before
-- this lands, they should fail-fast).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inventory_movements_type_integrity'
  ) THEN
    ALTER TABLE public.inventory_movements
    ADD CONSTRAINT chk_inventory_movements_type_integrity
    CHECK (
      CASE
        -- A. purchase: quantity > 0, unit_price NOT NULL, no employee
        WHEN type = 'purchase' THEN
          quantity > 0
          AND unit_price IS NOT NULL
          AND issued_to_employee_id IS NULL
          AND from_room_id IS NULL
          -- to_room_id allowed (durable purchases can go straight to a room)

        -- B. issue: quantity > 0, no unit_price, no rooms
        WHEN type = 'issue' THEN
          quantity > 0
          AND unit_price IS NULL
          AND from_room_id IS NULL
          AND to_room_id IS NULL
          -- issued_to_employee_id optional

        -- C. damage: quantity > 0, no unit_price, no recipient employee, no to_room
        WHEN type = 'damage' THEN
          quantity > 0
          AND unit_price IS NULL
          AND issued_to_employee_id IS NULL
          AND to_room_id IS NULL
          -- from_room_id allowed (the room where the item broke)

        -- D. adjustment: any non-zero quantity, reason_note REQUIRED, no other fields
        WHEN type = 'adjustment' THEN
          quantity <> 0
          AND reason_note IS NOT NULL
          AND unit_price IS NULL
          AND issued_to_employee_id IS NULL
          AND from_room_id IS NULL
          AND to_room_id IS NULL
          AND source_account_transaction_id IS NULL

        -- E. transfer: quantity > 0, both rooms set and different, no other fields
        WHEN type = 'transfer' THEN
          quantity > 0
          AND from_room_id IS NOT NULL
          AND to_room_id IS NOT NULL
          AND from_room_id <> to_room_id
          AND unit_price IS NULL
          AND issued_to_employee_id IS NULL
          AND source_account_transaction_id IS NULL

        ELSE FALSE  -- defensive: unknown movement type
      END
    );
  END IF;
END
$$;


-- ── 5. inventory_assignments ──────────────────────────────────

CREATE TABLE IF NOT EXISTS public.inventory_assignments (
  id          UUID                                     PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     UUID                                     NOT NULL REFERENCES public.inventory_items(id) ON DELETE RESTRICT,
  room_id     UUID                                     NOT NULL REFERENCES public.rooms(id)           ON DELETE RESTRICT,
  quantity    NUMERIC(10,2)                            NOT NULL DEFAULT 0,
  status      public.inventory_assignment_status       NOT NULL DEFAULT 'in_service',
  created_at  TIMESTAMPTZ                              NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ                              NOT NULL DEFAULT now(),
  CONSTRAINT chk_inventory_assignments_quantity_nonneg CHECK (quantity >= 0)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_inventory_assignments_item_room_status'
  ) THEN
    ALTER TABLE public.inventory_assignments
    ADD CONSTRAINT uq_inventory_assignments_item_room_status
    UNIQUE (item_id, room_id, status);
  END IF;
END
$$;

COMMENT ON TABLE  public.inventory_assignments IS
  'For durables only: which room has how many of which item in what status. Read-model kept in sync via movements (purchase to room → increment; transfer → decrement from / increment to; damage → decrement in_service / increment damaged). Empty for consumables.';

COMMENT ON COLUMN public.inventory_assignments.quantity IS
  'Count currently in this room with this status. Can be 0 (row left in place after items moved out — alternatively could be deleted, app layer decides).';


-- ── 6. Indexes ───────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_inventory_items_category    ON public.inventory_items(category_id)         WHERE category_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_items_active      ON public.inventory_items(is_active)           WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_inventory_items_type        ON public.inventory_items(type);

CREATE INDEX IF NOT EXISTS idx_inventory_movements_item    ON public.inventory_movements(item_id);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_type    ON public.inventory_movements(type);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_source  ON public.inventory_movements(source_account_transaction_id) WHERE source_account_transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_movements_happened_at ON public.inventory_movements(happened_at);

CREATE INDEX IF NOT EXISTS idx_inventory_assignments_item  ON public.inventory_assignments(item_id);
CREATE INDEX IF NOT EXISTS idx_inventory_assignments_room  ON public.inventory_assignments(room_id);

CREATE INDEX IF NOT EXISTS idx_inventory_categories_active ON public.inventory_categories(is_active) WHERE is_active = true;


-- ── 7. updated_at triggers ────────────────────────────────────
-- touch_updated_at() already exists from Phase 4A; reuse.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_touch_inventory_categories') THEN
    CREATE TRIGGER trg_touch_inventory_categories
    BEFORE UPDATE ON public.inventory_categories
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_touch_inventory_items') THEN
    CREATE TRIGGER trg_touch_inventory_items
    BEFORE UPDATE ON public.inventory_items
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_touch_inventory_assignments') THEN
    CREATE TRIGGER trg_touch_inventory_assignments
    BEFORE UPDATE ON public.inventory_assignments
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
  END IF;
END
$$;


-- ── 8. RLS ────────────────────────────────────────────────────

ALTER TABLE public.inventory_categories  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_items       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_movements   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_assignments ENABLE ROW LEVEL SECURITY;

-- Reusable pattern: authenticated read/insert/update, no DELETE.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['inventory_categories', 'inventory_items', 'inventory_movements', 'inventory_assignments'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname='Authenticated can read ' || t) THEN
      EXECUTE format('CREATE POLICY "Authenticated can read %I" ON public.%I FOR SELECT TO authenticated USING (true)', t, t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname='Authenticated can insert ' || t) THEN
      EXECUTE format('CREATE POLICY "Authenticated can insert %I" ON public.%I FOR INSERT TO authenticated WITH CHECK (true)', t, t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname='Authenticated can update ' || t) THEN
      EXECUTE format('CREATE POLICY "Authenticated can update %I" ON public.%I FOR UPDATE TO authenticated USING (true)', t, t);
    END IF;
  END LOOP;
END
$$;


-- =============================================================
-- Verification queries — run AFTER applying:
--
--   -- Q1: all 4 tables exist
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema='public' AND table_name LIKE 'inventory_%'
--   ORDER BY table_name;
--   -- Expected: 4 rows
--
--   -- Q2: ENUMs created
--   SELECT typname FROM pg_type
--   WHERE typname LIKE 'inventory_%'
--   ORDER BY typname;
--   -- Expected: 4 types
--
--   -- Q3: CHECK constraint
--   SELECT conname FROM pg_constraint
--   WHERE conname IN (
--     'chk_inventory_movements_type_integrity',
--     'chk_inventory_assignments_quantity_nonneg',
--     'uq_inventory_assignments_item_room_status'
--   );
--   -- Expected: 3 rows
--
--   -- Q4: indexes
--   SELECT indexname FROM pg_indexes
--   WHERE schemaname='public' AND indexname LIKE 'idx_inventory_%'
--   ORDER BY indexname;
--   -- Expected: ~10 rows
--
--   -- Q5: RLS enabled on all 4
--   SELECT tablename, rowsecurity FROM pg_tables
--   WHERE schemaname='public' AND tablename LIKE 'inventory_%';
--   -- Expected: 4 rows, all rowsecurity=true
--
--   -- Q6: triggers
--   SELECT tgname FROM pg_trigger
--   WHERE tgname LIKE 'trg_touch_inventory_%';
--   -- Expected: 3 rows (categories, items, assignments — not movements)
-- =============================================================
