// services/documentsService.ts
//
// Guest document upload, retrieval, and deletion.
//
// STORAGE:  Supabase Storage bucket "guest-documents"
//           Path format: {booking_ref}/{uuid}.{ext}   e.g. BK-1041/abc123.pdf
//
// METADATA: booking_documents table (public schema)
//           Linked to bookings via booking_ref TEXT (e.g. "BK-1041")
//
// PATTERN:  Called directly from BookingsClient which manages its own
//           loading state — no optimistic updates needed for documents.

import { supabase } from "@/lib/supabase";
import type { BookingDocument } from "@/lib/mockData";

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

export const DOCUMENT_TYPES = [
  "National ID Card",
  "Passport",
  "Driving License",
  "Wedding Certificate",
  "Other",
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

const BUCKET = "guest-documents";

// Signed URLs are time-limited; generated fresh on every read so the
// private bucket's files are only viewable by an authenticated session.
const SIGNED_URL_TTL = 60 * 60; // 1 hour

/**
 * Given a list of storage paths, returns a Map of path → signed URL.
 * Fails soft: on error returns an empty map so the UI degrades to
 * "no preview" rather than throwing.
 */
async function signPaths(paths: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const valid = paths.filter(Boolean);
  if (valid.length === 0) return map;

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrls(valid, SIGNED_URL_TTL);

  if (error || !data) {
    logSupabaseError("signPaths / createSignedUrls", error);
    return map;
  }
  for (const item of data) {
    if (item.path && item.signedUrl) map.set(item.path, item.signedUrl);
  }
  return map;
}

// Allowed MIME types — images and PDF only
export const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "application/pdf",
];

export const ALLOWED_EXTENSIONS_LABEL = "JPG, PNG, WEBP, HEIC, GIF, PDF";

// ─────────────────────────────────────────────────────────────
// ERROR HELPER
// ─────────────────────────────────────────────────────────────

/**
 * Logs a Supabase error with its full detail fields, then returns
 * a human-readable string suitable for display in the UI.
 *
 * Supabase errors carry:  message | details | hint | code
 */
function logSupabaseError(tag: string, err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as {
      message?: string;
      details?: string;
      hint?:    string;
      code?:    string;
    };
    console.error(
      `[documentsService] ${tag} →`,
      "\n  message:", e.message ?? "—",
      "\n  details:", e.details ?? "—",
      "\n  hint:   ", e.hint    ?? "—",
      "\n  code:   ", e.code    ?? "—",
    );
    return [
      e.message && `${e.message}`,
      e.details && `(${e.details})`,
      e.hint    && `Hint: ${e.hint}`,
      e.code    && `[${e.code}]`,
    ].filter(Boolean).join(" ") || "Unknown Supabase error";
  }
  console.error(`[documentsService] ${tag} → unexpected error:`, err);
  return String(err) || "Unknown error";
}

// ─────────────────────────────────────────────────────────────
// RAW DB ROW TYPE
// ─────────────────────────────────────────────────────────────
type DocumentRow = {
  id:            string;
  booking_ref:   string;
  document_type: string;
  file_url:      string;
  storage_path:  string;
  file_name:     string;
  file_type:     string;
  note:          string | null;
  uploaded_by:   string | null;
  created_at:    string;
};

function mapDoc(row: DocumentRow): BookingDocument {
  return {
    id:           row.id,
    bookingRef:   row.booking_ref,
    documentType: row.document_type,
    fileUrl:      row.file_url,
    storagePath:  row.storage_path,
    fileName:     row.file_name,
    fileType:     row.file_type,
    note:         row.note        ?? undefined,
    uploadedBy:   row.uploaded_by ?? undefined,
    createdAt:    row.created_at,
  };
}

// ─────────────────────────────────────────────────────────────
// READ
// ─────────────────────────────────────────────────────────────

/**
 * Fetches all documents for a booking from public.booking_documents
 * where booking_ref = bookingRef, ordered newest first.
 */
export async function getDocuments(bookingRef: string): Promise<BookingDocument[]> {
  console.log(`[documentsService] getDocuments → booking_ref="${bookingRef}"`);

  const { data, error } = await supabase
    .from("booking_documents")
    .select("*")
    .eq("booking_ref", bookingRef)
    .order("created_at", { ascending: false });

  if (error) {
    const msg = logSupabaseError("getDocuments", error);
    throw new Error(msg);
  }

  console.log(`[documentsService] getDocuments → ${data?.length ?? 0} row(s) returned`);

  const rows = data as DocumentRow[];
  const docs = rows.map(mapDoc);

  // Replace the stored (now-private) file_url with a fresh signed URL
  // generated from storage_path, so previews work on the private bucket.
  const signed = await signPaths(rows.map(r => r.storage_path));
  for (const doc of docs) {
    doc.fileUrl = signed.get(doc.storagePath) ?? doc.fileUrl;
  }
  return docs;
}

// ─────────────────────────────────────────────────────────────
// UPLOAD
// ─────────────────────────────────────────────────────────────

/**
 * Uploads a file to the guest-documents Storage bucket, then inserts
 * a metadata row into booking_documents.
 *
 * On metadata insert failure the orphaned storage file is removed.
 * Returns the saved BookingDocument on success.
 */
export async function uploadDocument(
  bookingRef:   string,
  file:         File,
  documentType: string,
  note:         string | null,
  uploadedBy:   string | null,
): Promise<BookingDocument> {
  // 1. Build a unique storage path — prevents collisions on same-name re-uploads
  const ext         = file.name.split(".").pop()?.toLowerCase() ?? "bin";
  const storagePath = `${bookingRef}/${crypto.randomUUID()}.${ext}`;

  console.log(`[documentsService] uploadDocument → storage path: ${storagePath}`);

  // 2. Upload file bytes to Storage
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, file, { contentType: file.type, upsert: false });

  if (uploadError) {
    const msg = logSupabaseError("uploadDocument / storage.upload", uploadError);
    throw new Error(msg);
  }

  // 3. Insert metadata row into booking_documents.
  //    file_url holds the storage path (not a public URL) — the bucket is
  //    private, so viewable URLs are signed on read in getDocuments().
  const { data, error: insertError } = await supabase
    .from("booking_documents")
    .insert({
      booking_ref:   bookingRef,
      document_type: documentType,
      file_url:      storagePath,
      storage_path:  storagePath,
      file_name:     file.name,
      file_type:     file.type,
      note:          note       || null,
      uploaded_by:   uploadedBy || null,
    })
    .select()
    .single();

  if (insertError) {
    // Metadata insert failed — remove the orphaned storage file
    await supabase.storage.from(BUCKET).remove([storagePath]);
    const msg = logSupabaseError("uploadDocument / insert metadata", insertError);
    throw new Error(msg);
  }

  console.log(`[documentsService] uploadDocument → metadata saved, id: ${(data as DocumentRow).id}`);

  // Return with a fresh signed URL so the UI can preview immediately.
  const doc = mapDoc(data as DocumentRow);
  const { data: signed } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL);
  if (signed?.signedUrl) doc.fileUrl = signed.signedUrl;
  return doc;
}

// ─────────────────────────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────────────────────────

/**
 * Deletes the storage file then the metadata row.
 * Storage removal is best-effort (file may already be gone).
 * DB row removal throws on failure.
 */
export async function deleteDocument(docId: string, storagePath: string): Promise<void> {
  console.log(`[documentsService] deleteDocument → id=${docId}, path=${storagePath}`);

  // 1. Remove from Storage — non-fatal if already gone
  const { error: storageError } = await supabase.storage
    .from(BUCKET)
    .remove([storagePath]);

  if (storageError) {
    // Log but continue — the metadata row must still be removed
    logSupabaseError("deleteDocument / storage.remove", storageError);
  }

  // 2. Delete the metadata row
  const { error } = await supabase
    .from("booking_documents")
    .delete()
    .eq("id", docId);

  if (error) {
    const msg = logSupabaseError("deleteDocument / delete row", error);
    throw new Error(msg);
  }

  console.log(`[documentsService] deleteDocument → done`);
}
