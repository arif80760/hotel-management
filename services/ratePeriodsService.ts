// services/ratePeriodsService.ts
//
// ─── RATE PERIODS (seasonal/event pricing) ───────────────────────────────────
//
// CRUD + lookup for public.rate_periods (2026-08-19-rate-periods.sql).
// Periods change ONLY the booking form's PREFILLED default rate when a room
// is selected — a manually typed rate always wins, the min-rate floor is
// untouched, and existing bookings are never recalculated. Resolution order
// (client-side, in BookingsClient): manual entry > rate period covering the
// row's check-in date > category default price. The server RPCs
// (create_booking_with_rooms etc.) are deliberately untouched — derived
// nights + the total check remain the enforcement point.
//
// Overlap safety lives in the DB: EXCLUDE constraint per category over the
// INCLUSIVE [start_date, end_date] daterange, active periods only — so
// deactivating a period frees its dates. Violations arrive as SQLSTATE
// 23P01 and are mapped to a friendly message here.

import { supabase } from "@/lib/supabase";

export type RatePeriod = {
  id:        string;
  category:  string;   // room_categories.slug (FK)
  startDate: string;   // inclusive
  endDate:   string;   // inclusive
  rate:      number;
  label:     string;   // "Eid Peak", "December High Season"
  isActive:  boolean;
  createdAt: string;
};

type RatePeriodRow = {
  id: string; category: string; start_date: string; end_date: string;
  rate: number | string; label: string; is_active: boolean; created_at: string;
};

const COLS = "id, category, start_date, end_date, rate, label, is_active, created_at";

function mapRow(r: RatePeriodRow): RatePeriod {
  return {
    id: r.id, category: r.category, startDate: r.start_date, endDate: r.end_date,
    rate: Number(r.rate), label: r.label, isActive: r.is_active, createdAt: r.created_at,
  };
}

function friendly(error: { code?: string; message: string }, verb: string): Error {
  if (error.code === "23P01") {
    return new Error(
      "Those dates overlap an existing ACTIVE rate period for this category. " +
      "Deactivate the overlapping period first, or adjust the dates.",
    );
  }
  console.error(`[ratePeriodsService] ${verb} failed:`, error.message, "| code:", error.code);
  return new Error(`Could not ${verb} rate period: ${error.message}`);
}

export async function getRatePeriods(): Promise<RatePeriod[]> {
  const { data, error } = await supabase
    .from("rate_periods").select(COLS)
    .order("start_date", { ascending: false });
  if (error) throw friendly(error, "load");
  return (data as RatePeriodRow[]).map(mapRow);
}

export async function createRatePeriod(input: {
  category: string; startDate: string; endDate: string; rate: number; label: string;
}): Promise<RatePeriod> {
  const { data: auth } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from("rate_periods")
    .insert({
      category:   input.category,
      start_date: input.startDate,
      end_date:   input.endDate,
      rate:       input.rate,
      label:      input.label.trim(),
      created_by: auth?.user?.id ?? null,
    })
    .select(COLS)
    .single();
  if (error) throw friendly(error, "create");
  return mapRow(data as RatePeriodRow);
}

export async function updateRatePeriod(id: string, patch: {
  startDate?: string; endDate?: string; rate?: number; label?: string;
}): Promise<RatePeriod> {
  const row: Record<string, unknown> = {};
  if (patch.startDate !== undefined) row.start_date = patch.startDate;
  if (patch.endDate   !== undefined) row.end_date   = patch.endDate;
  if (patch.rate      !== undefined) row.rate       = patch.rate;
  if (patch.label     !== undefined) row.label      = patch.label.trim();
  const { data, error } = await supabase
    .from("rate_periods").update(row).eq("id", id).select(COLS).single();
  if (error) throw friendly(error, "update");
  return mapRow(data as RatePeriodRow);
}

/** Reactivation can also hit 23P01 if the dates are now taken. */
export async function setRatePeriodActive(id: string, isActive: boolean): Promise<RatePeriod> {
  const { data, error } = await supabase
    .from("rate_periods").update({ is_active: isActive }).eq("id", id).select(COLS).single();
  if (error) throw friendly(error, isActive ? "reactivate" : "deactivate");
  return mapRow(data as RatePeriodRow);
}

/** Pure lookup: the ACTIVE period covering `dateISO` for a category slug
 *  (inclusive both ends — same semantics as the DB constraint). */
export function findRatePeriod(
  periods: RatePeriod[], categorySlug: string, dateISO: string,
): RatePeriod | null {
  if (!categorySlug || !dateISO) return null;
  return periods.find(
    (p) => p.isActive && p.category === categorySlug &&
           p.startDate <= dateISO && dateISO <= p.endDate,
  ) ?? null;
}
