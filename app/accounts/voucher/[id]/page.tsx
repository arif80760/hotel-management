// app/accounts/voucher/[id]/page.tsx
//
// Server wrapper for the voucher print page.
//   - Admin-only role guard (same pattern as cashbook/expense).
//   - Fetches the expense by ID server-side. 404 if not found, not an
//     expense_out, deleted, or booking-derived (per getExpenseById guards).
//   - Passes the resolved expense + category + employee to VoucherClient.
//
// Route: /accounts/voucher/[id]  where [id] is the account_transactions.id
// of a user-recorded expense_out row.

import { redirect, notFound }       from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import VoucherClient                  from "./VoucherClient";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function VoucherPage({ params }: PageProps) {
  const { id } = await params;

  const serverClient = await createSupabaseServerClient();
  const { data: { user } } = await serverClient.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await serverClient
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "admin") redirect("/");

  // Fetch the expense + its category name + (if employee payee) the
  // employee's full name, in one round-trip per dependency. Three small
  // sequential reads — fine for a print page; not hot-path.

  const { data: expRow, error: expErr } = await serverClient
    .from("account_transactions")
    .select("id, type, txn_date, amount, voucher_number, category_id, payee, employee_id, note, booking_payment_id, deleted_at, created_at, created_by")
    .eq("id", id)
    .maybeSingle();

  if (expErr) {
    console.error("[VoucherPage] fetch error:", expErr.message);
    notFound();
  }
  if (!expRow) notFound();
  if (expRow.type !== "expense_out") notFound();
  if (expRow.booking_payment_id !== null) notFound();
  if (expRow.deleted_at !== null) notFound();

  // Resolve category name (always present per CHECK)
  let categoryName: string | null = null;
  if (expRow.category_id) {
    const { data: catRow } = await serverClient
      .from("expense_categories")
      .select("name")
      .eq("id", expRow.category_id)
      .maybeSingle();
    categoryName = catRow?.name ?? null;
  }

  // Resolve employee name (only if payee mode was employee)
  let employeeName: string | null = null;
  if (expRow.employee_id) {
    const { data: empRow } = await serverClient
      .from("employees")
      .select("full_name")
      .eq("id", expRow.employee_id)
      .maybeSingle();
    employeeName = empRow?.full_name ?? null;
  }

  // Resolve recorder name (best-effort; ok if missing — falls back to "—")
  let recordedByName: string | null = null;
  if (expRow.created_by) {
    const { data: recRow } = await serverClient
      .from("employees")
      .select("full_name")
      .eq("auth_user_id", expRow.created_by)
      .maybeSingle();
    recordedByName = recRow?.full_name ?? null;
  }

  const voucherData = {
    id:            expRow.id as string,
    txnDate:       expRow.txn_date as string,
    amount:        typeof expRow.amount === "string" ? parseFloat(expRow.amount) : (expRow.amount as number),
    voucherNumber: (expRow.voucher_number ?? "") as string,
    categoryName,
    employeeName,
    payee:         (expRow.payee ?? null) as string | null,
    note:          (expRow.note ?? null) as string | null,
    recordedByName,
  };

  return <VoucherClient voucher={voucherData} />;
}
