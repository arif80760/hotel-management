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
  return (data as DocumentRow[]).map(mapDoc);
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

  // 3. Get the public URL (bucket must be set to Public in Supabase Dashboard)
  const { data: urlData } = supabase.storage
    .from(BUCKET)
    .getPublicUrl(storagePath);

  console.log(`[documentsService] uploadDocument → public URL: ${urlData.publicUrl}`);

  // 4. Insert metadata row into booking_documents
  const { data, error: insertError } = await supabase
    .from("booking_documents")
    .insert({
      booking_ref:   bookingRef,
      document_type: documentType,
      file_url:      urlData.publicUrl,
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
  return mapDoc(data as DocumentRow);
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
