-- =============================================================
-- BOOKING DOCUMENTS — storage bucket + metadata table
-- =============================================================
--
-- Run the two steps below in order.
-- Step A is done in Supabase Dashboard (no SQL needed).
-- Step B is pasted into Supabase SQL Editor → New query → Run.
--
-- =============================================================
-- STEP A — Create the Storage bucket  (Dashboard → Storage)
-- =============================================================
--
--   1. Open Supabase Dashboard → Storage → New bucket
--   2. Name:    guest-documents
--   3. Public:  YES  (so file_url links work without signed tokens)
--   4. Save
--
--   Then set bucket policies (Dashboard → Storage → guest-documents → Policies):
--
--     Policy 1 — Allow authenticated users to upload:
--       Operation: INSERT
--       Target roles: authenticated
--       Policy: true
--
--     Policy 2 — Allow authenticated users to delete their uploads:
--       Operation: DELETE
--       Target roles: authenticated
--       Policy: true
--
--   (Public read is automatic when the bucket is marked Public.)
--
-- =============================================================
-- STEP B — Create the metadata table  (SQL Editor)
-- =============================================================

CREATE TABLE IF NOT EXISTS booking_documents (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Links to bookings.booking_ref (e.g. 'BK-1041').
  -- TEXT reference instead of UUID FK keeps it loose-coupled.
  booking_ref   TEXT         NOT NULL,

  -- Type selected by staff when uploading
  document_type TEXT         NOT NULL,

  -- Public storage URL — works for direct image/PDF preview in the browser
  file_url      TEXT         NOT NULL,

  -- Object path inside the guest-documents bucket.
  -- Used for deletion: supabase.storage.from('guest-documents').remove([storage_path])
  storage_path  TEXT         NOT NULL UNIQUE,

  -- Original file name as supplied by the browser
  file_name     TEXT         NOT NULL,

  -- MIME type, e.g. 'image/jpeg', 'application/pdf'
  file_type     TEXT         NOT NULL,

  -- Optional staff note about the document
  note          TEXT,

  -- Who uploaded it — nullable so uploads before auth rollout still work
  uploaded_by   UUID         REFERENCES auth.users(id) ON DELETE SET NULL,

  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  booking_documents               IS 'Guest identity documents uploaded during or after booking creation';
COMMENT ON COLUMN booking_documents.booking_ref   IS 'Matches bookings.booking_ref (e.g. BK-1041)';
COMMENT ON COLUMN booking_documents.storage_path  IS 'Object key in the guest-documents Storage bucket';
COMMENT ON COLUMN booking_documents.document_type IS 'National ID Card | Passport | Driving License | Wedding Certificate | Other';

-- Fast per-booking lookup (most common query pattern)
CREATE INDEX IF NOT EXISTS idx_booking_documents_booking_ref
  ON booking_documents (booking_ref);

-- =============================================================
-- ROW-LEVEL SECURITY
-- =============================================================

ALTER TABLE booking_documents ENABLE ROW LEVEL SECURITY;

-- Authenticated staff/admin can read all documents
CREATE POLICY "Authenticated can read booking documents"
  ON booking_documents
  FOR SELECT
  TO authenticated
  USING (true);

-- Authenticated staff/admin can upload documents
CREATE POLICY "Authenticated can insert booking documents"
  ON booking_documents
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Authenticated staff/admin can delete documents
-- (Restrict to admins only by replacing 'true' with a role check if needed,
--  e.g.: (SELECT raw_app_meta_data->>'role' FROM auth.users WHERE id = auth.uid()) = 'admin')
CREATE POLICY "Authenticated can delete booking documents"
  ON booking_documents
  FOR DELETE
  TO authenticated
  USING (true);
