-- =============================================================
-- 02-tables.sql
-- All public-schema tables in FK-dependency order.
--
-- Exported: 2026-05-07  (reconstructed from PostgREST OpenAPI
--           spec + existing sql/ migration files + TS types)
--
-- Dependency order:
--   1. rooms            (no FK deps)
--   2. guests           (no FK deps)
--   3. profiles         (refs auth.users)
--   4. employees        (refs auth.users)
--   5. bookings         (refs rooms, guests, auth.users)
--   6. payments         (refs bookings, auth.users)
--   7. booking_guests   (refs bookings, guests)
--   8. booking_documents (no table FK — uses booking_ref text)
-- =============================================================


-- ──────────────────────────────────────────────────────────────
-- 1. rooms
-- Physical hotel rooms.  status is managed by fn_sync_room_status.
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.rooms (
  id              UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  room_number     VARCHAR(10)       NOT NULL UNIQUE,
  floor           SMALLINT          NOT NULL,
  category        public.room_category NOT NULL,
  status          public.room_status   NOT NULL DEFAULT 'available',
  price_per_night NUMERIC(10, 2)    NOT NULL,
  capacity        SMALLINT          NOT NULL DEFAULT 2,
  amenities       TEXT[]            NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.rooms IS 'Physical hotel rooms — one row per room unit';
COMMENT ON COLUMN public.rooms.status IS 'Current occupancy state; maintained by trigger fn_sync_room_status';
COMMENT ON COLUMN public.rooms.amenities IS 'Array of amenity strings, e.g. {WiFi,TV,"Mini Bar"}';


-- ──────────────────────────────────────────────────────────────
-- 2. guests
-- Guest profiles.  One guest row per real person.
-- The primary_guest_id FK on bookings links a booking to its main guest.
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.guests (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL,
  email       TEXT        NOT NULL,   -- may be a placeholder (\d+.noemail@hotel.local)
  phone       TEXT        NOT NULL,
  nationality TEXT,
  notes       TEXT,
  vip         BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.guests IS 'Deduplicated guest profiles';
COMMENT ON COLUMN public.guests.email IS 'Real email or system placeholder <digits>.noemail@hotel.local';
COMMENT ON COLUMN public.guests.vip   IS 'Staff-flagged VIP guest';


-- ──────────────────────────────────────────────────────────────
-- 3. profiles
-- Supabase Auth user extension — one row per auth.users entry.
-- Role values: 'admin' | 'staff' (managed in Supabase Dashboard).
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profiles (
  id         UUID      PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name  TEXT,
  role       TEXT,
  created_at TIMESTAMP              -- NOTE: no time zone (Supabase default)
);

COMMENT ON TABLE  public.profiles IS 'Auth user extension — role and display name for hotel staff';
COMMENT ON COLUMN public.profiles.role IS 'admin | staff';


-- ──────────────────────────────────────────────────────────────
-- 4. employees
-- HR records for hotel staff.  May or may not have a corresponding
-- auth.users login (auth_user_id is nullable).
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.employees (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name         TEXT        NOT NULL,
  email             TEXT,
  phone             TEXT,
  photo_url         TEXT,
  blood_group       TEXT,
  designation       TEXT        NOT NULL,
  can_access_app    BOOLEAN     NOT NULL DEFAULT FALSE,
  app_role          TEXT,                 -- 'admin' | 'staff' | NULL
  employee_id       TEXT,                 -- internal HR code
  joining_date      DATE,
  emergency_contact TEXT,
  address           TEXT,
  notes             TEXT,
  is_active         BOOLEAN     NOT NULL DEFAULT TRUE,
  auth_user_id      UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.employees IS 'Hotel staff HR records; auth_user_id links to app login when present';
COMMENT ON COLUMN public.employees.can_access_app IS 'Whether this employee has an active app login';
COMMENT ON COLUMN public.employees.app_role       IS 'admin | staff — mirrors profiles.role for staff with logins';


-- ──────────────────────────────────────────────────────────────
-- 5. bookings
-- Financial + lifecycle unit for a guest stay.
-- Triggers that update derived columns:
--   fn_sync_room_status      — rooms.status ← booking status
--   fn_stamp_booking_timestamps — confirmed_at / checked_in_at / etc.
--   fn_sync_paid_amount      — paid_amount ← SUM(payments)
--   fn_sync_payment_status   — payment_status ← paid_amount vs total_amount
--   fn_sync_last_payment_method — last_payment_method ← latest payment
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bookings (
  -- ── Identity ────────────────────────────────────────────────
  id                           UUID               PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_ref                  TEXT               NOT NULL UNIQUE,  -- e.g. 'BK-1041'

  -- ── Room & guest links ──────────────────────────────────────
  room_id                      UUID               NOT NULL REFERENCES public.rooms(id)  ON DELETE RESTRICT,
  primary_guest_id             UUID               NOT NULL REFERENCES public.guests(id) ON DELETE RESTRICT,

  -- ── Stay dates ──────────────────────────────────────────────
  check_in_date                DATE               NOT NULL,
  check_out_date               DATE               NOT NULL,
  nights                       SMALLINT           NOT NULL,
  room_category_at_booking     public.room_category NOT NULL,
  total_guests                 SMALLINT           NOT NULL DEFAULT 1,

  -- ── Status ──────────────────────────────────────────────────
  status                       public.booking_status NOT NULL DEFAULT 'confirmed',

  -- ── Financials ──────────────────────────────────────────────
  total_amount                 NUMERIC(10, 2)     NOT NULL,
  paid_amount                  NUMERIC(10, 2)     NOT NULL DEFAULT 0,
  due_amount                   NUMERIC(10, 2)     NOT NULL DEFAULT 0, -- maintained by trigger
  payment_status               public.payment_status NOT NULL DEFAULT 'unpaid',
  last_payment_method          public.payment_method,               -- nullable; set by trigger

  -- Room rate columns (added by migration add_booking_rate_columns.sql)
  fixed_rate                   NUMERIC(10, 2),    -- published rate at time of booking
  booking_rate                 NUMERIC(10, 2),    -- negotiated rate per night

  -- Discount columns (legacy — superseded by additional_discount_amount)
  discount_amount              NUMERIC(10, 2),
  discount_percentage          NUMERIC(5, 2),

  -- Extra charge at checkout (added by migration add_extra_charge_columns.sql)
  extra_charge                 NUMERIC(10, 2),    -- legacy alias; use extra_charge_amount
  extra_charge_amount          NUMERIC(10, 2),
  extra_charge_reason          TEXT,
  charge_type                  TEXT,              -- legacy

  -- Early checkout (added by migration add_early_checkout_and_discount_columns.sql)
  actual_checkout_date         DATE,
  early_nights_deducted        INTEGER DEFAULT 0,
  early_deduction_amount       NUMERIC(10, 2) DEFAULT 0,

  -- Additional discount at checkout
  additional_discount_amount   NUMERIC(10, 2) DEFAULT 0,
  additional_discount_reason   TEXT,
  additional_discount_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  additional_discount_at       TIMESTAMPTZ,

  -- Legacy / rarely used
  fixed_room_rate              NUMERIC(10, 2),    -- older alias for fixed_rate

  -- ── Override ────────────────────────────────────────────────
  override_checkout            BOOLEAN NOT NULL DEFAULT FALSE,
  override_reason              TEXT,
  override_by                  UUID,              -- auth.users UUID (no FK — intentional)
  override_at                  TIMESTAMPTZ,

  -- ── Lifecycle timestamps ─────────────────────────────────────
  -- Set automatically by trigger fn_stamp_booking_timestamps.
  confirmed_at                 TIMESTAMPTZ,
  checked_in_at                TIMESTAMPTZ,
  checked_out_at               TIMESTAMPTZ,
  cancelled_at                 TIMESTAMPTZ,

  -- ── Audit timestamps ────────────────────────────────────────
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.bookings IS 'Core booking record — financial unit for a guest stay';
COMMENT ON COLUMN public.bookings.booking_ref IS 'Human-readable ID, e.g. BK-1041. Unique.';
COMMENT ON COLUMN public.bookings.room_id IS 'FK to rooms.id — the single room for this booking';
COMMENT ON COLUMN public.bookings.paid_amount IS 'Maintained by trigger fn_sync_paid_amount = SUM(payments.amount)';
COMMENT ON COLUMN public.bookings.due_amount  IS 'total_amount - paid_amount; maintained by trigger fn_sync_payment_status';
COMMENT ON COLUMN public.bookings.payment_status IS 'Derived by trigger fn_sync_payment_status from paid vs total';
COMMENT ON COLUMN public.bookings.last_payment_method IS 'Denormalized from most-recent payment; maintained by trigger fn_sync_last_payment_method';
COMMENT ON COLUMN public.bookings.actual_checkout_date IS 'Calendar date the guest actually vacated (may be before check_out_date)';
COMMENT ON COLUMN public.bookings.early_nights_deducted IS 'max(0, check_out_date - actual_checkout_date) in calendar days';
COMMENT ON COLUMN public.bookings.early_deduction_amount IS 'early_nights_deducted × booking_rate — credited back to guest';
COMMENT ON COLUMN public.bookings.additional_discount_amount IS 'Ad-hoc discount applied at checkout by staff or admin';
COMMENT ON COLUMN public.bookings.additional_discount_reason IS 'Optional plain-text reason for the additional discount';
COMMENT ON COLUMN public.bookings.additional_discount_by IS 'auth.users UUID of the person who applied the discount';
COMMENT ON COLUMN public.bookings.additional_discount_at IS 'Timestamp when the additional discount was applied';
COMMENT ON COLUMN public.bookings.fixed_rate IS 'Published/standard room rate per night at time of booking';
COMMENT ON COLUMN public.bookings.booking_rate IS 'Actual negotiated rate per night (may be discounted from fixed_rate)';
COMMENT ON COLUMN public.bookings.extra_charge_amount IS 'Additional charge applied at checkout (damage, mini-bar, laundry, etc.)';
COMMENT ON COLUMN public.bookings.extra_charge_reason IS 'Formatted reason string, e.g. "Mini-bar - 3 soft drinks"';


-- ──────────────────────────────────────────────────────────────
-- 6. payments
-- One row per payment transaction.  Triggers on this table
-- keep bookings.paid_amount, payment_status, and
-- last_payment_method in sync.
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payments (
  id          UUID                  PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  UUID                  NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  amount      NUMERIC(10, 2)        NOT NULL,
  method      public.payment_method NOT NULL,
  recorded_by UUID,                            -- auth.users UUID; nullable for pre-auth rows
  notes       TEXT,
  created_at  TIMESTAMPTZ           NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.payments IS 'Individual payment transactions linked to a booking';
COMMENT ON COLUMN public.payments.booking_id  IS 'FK to bookings.id — CASCADE deletes if booking deleted';
COMMENT ON COLUMN public.payments.recorded_by IS 'auth.users UUID of staff who recorded the payment';


-- ──────────────────────────────────────────────────────────────
-- 7. booking_guests
-- Additional (non-primary) guests on a booking.
-- Sort order determines display order; primary guest is NOT listed here.
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.booking_guests (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID        NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  guest_id   UUID        REFERENCES public.guests(id) ON DELETE SET NULL,
  name       TEXT        NOT NULL,
  nationality TEXT,
  sort_order SMALLINT    NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.booking_guests IS 'Additional guests listed on a booking (excludes primary guest)';
COMMENT ON COLUMN public.booking_guests.guest_id   IS 'Optional link to a guests profile row; NULL if not deduplicated';
COMMENT ON COLUMN public.booking_guests.sort_order IS 'Display order; 0 = first additional guest';


-- ──────────────────────────────────────────────────────────────
-- 8. booking_documents
-- Guest identity documents uploaded during or after booking.
-- Uses booking_ref TEXT (not UUID FK) for loose coupling.
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.booking_documents (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_ref   TEXT        NOT NULL,    -- matches bookings.booking_ref, e.g. 'BK-1041'
  document_type TEXT        NOT NULL,    -- 'National ID Card' | 'Passport' | etc.
  file_url      TEXT        NOT NULL,    -- public storage URL for browser preview
  storage_path  TEXT        UNIQUE,      -- object key in guest-documents bucket
  file_name     TEXT,                    -- original filename from browser
  file_type     TEXT,                    -- MIME type, e.g. 'image/jpeg'
  note          TEXT,                    -- optional staff annotation
  uploaded_by   UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE  public.booking_documents IS 'Guest identity documents uploaded during or after booking creation';
COMMENT ON COLUMN public.booking_documents.booking_ref   IS 'Matches bookings.booking_ref (e.g. BK-1041)';
COMMENT ON COLUMN public.booking_documents.storage_path  IS 'Object key in the guest-documents Storage bucket';
COMMENT ON COLUMN public.booking_documents.document_type IS 'National ID Card | Passport | Driving License | Wedding Certificate | Other';
