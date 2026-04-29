"use client";

// contexts/HotelContext.tsx
//
// Shared React state for rooms and bookings.
//
// HOW IT WORKS NOW (Supabase connected):
//   • On mount, loadData() fetches rooms + bookings from Supabase once.
//   • Each action function does two things in sequence:
//       1. Optimistic update — mutates local state immediately so the UI
//          responds without waiting for a network round-trip.
//       2. Persist to DB — calls the async service function in the background.
//          Errors are logged to the console; no state rollback for now.
//
// WHY OPTIMISTIC UPDATES:
//   The previous mock-data version was synchronous and instant.
//   Keeping optimistic updates means the UI feels exactly the same to users.
//
// DATA FLOW:
//   Supabase DB  ─(initial load)→  useState  ─(renders)→  UI components
//   UI action    ─(optimistic)──→  useState (immediate)
//              └─(async persist)→  Supabase DB (background)

import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { useAuth } from "@/contexts/AuthContext";
import type {
  MockRoom,
  MockBooking,
  RoomStatus,
  BookingStatus,
  PaymentStatus,
  CheckoutOverride,
} from "@/lib/mockData";

import * as roomsService    from "@/services/roomsService";
import * as bookingsService from "@/services/bookingsService";

// Re-export types and ROOM_CATALOG so other files keep working unchanged.
export type { MockRoom as Room, MockBooking as Booking, RoomStatus, BookingStatus };
export type { PaymentStatus, CheckoutOverride } from "@/lib/mockData";
export { ROOM_CATALOG } from "@/lib/mockData";
// NOTE: ROOM_CATALOG is still exported from mockData for now so the booking form
// can suggest room prices and categories. When the rooms table is stable, replace
// with a derived map from the live `rooms` state.

// ─────────────────────────────────────────────────────────────
// CONTEXT TYPE
// ─────────────────────────────────────────────────────────────
type HotelContextType = {
  rooms:               MockRoom[];
  bookings:            MockBooking[];
  loading:             boolean;           // true while initial data is being fetched
  nextBookingId:       number;
  nextRoomId:          number;
  createBooking:       (b: MockBooking)                                            => void;
  changeBookingStatus: (id: string, status: BookingStatus)                        => void;
  addRoom:             (room: MockRoom)                                            => void;
  updateRoom:          (id: string, updates: Partial<Omit<MockRoom, "id"|"status">>) => void;
  deleteRoom:          (id: string)                                                => void;
  recordPayment:       (id: string, additionalAmount: number, callerRole?: string) => void;
  /** Normal checkout — no outstanding balance. Stores extra charges, early deduction, and additional discount. */
  checkoutNormal: (
    id: string,
    extraChargeAmount: number,
    extraChargeReason: string | null,
    actualCheckoutDate: string,
    earlyNightsDeducted: number,
    earlyDeductionAmount: number,
    additionalDiscountAmount: number,
    additionalDiscountReason: string | null,
  ) => void;
  /** Admin override — checkout despite outstanding balance. Stores override audit, extra charges, early deduction, and additional discount. */
  checkoutWithOverride: (
    id: string,
    overrideReason: string,
    extraChargeAmount?: number,
    extraChargeReason?: string | null,
    actualCheckoutDate?: string,
    earlyNightsDeducted?: number,
    earlyDeductionAmount?: number,
    additionalDiscountAmount?: number,
    additionalDiscountReason?: string | null,
  ) => void;
};

const HotelContext = createContext<HotelContextType | null>(null);

// ─────────────────────────────────────────────────────────────
// PROVIDER
// ─────────────────────────────────────────────────────────────
export function HotelProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();   // real logged-in user — used for override_by audit field

  const [rooms,         setRooms]         = useState<MockRoom[]>([]);
  const [bookings,      setBookings]      = useState<MockBooking[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [nextBookingId, setNextBookingId] = useState<number>(1042);
  const [nextRoomId,    setNextRoomId]    = useState<number>(49);

  // ── Initial data load ──────────────────────────────────────
  // Fetches rooms and bookings from Supabase once when the app starts.
  useEffect(() => {
    async function loadData() {
      try {
        const [fetchedRooms, fetchedBookings] = await Promise.all([
          roomsService.getAllRooms(),
          bookingsService.getAllBookings(),
        ]);
        setRooms(fetchedRooms);
        setBookings(fetchedBookings);

        // Seed nextBookingId from the highest existing booking_ref
        if (fetchedBookings.length > 0) {
          const maxRef = fetchedBookings.reduce((max, b) => {
            const n = parseInt(b.id.replace("BK-", ""), 10);
            return isNaN(n) ? max : Math.max(max, n);
          }, 0);
          if (maxRef > 0) setNextBookingId(maxRef + 1);
        }

        // Seed nextRoomId from the number of existing rooms + 1
        if (fetchedRooms.length > 0) {
          setNextRoomId(fetchedRooms.length + 1);
        }
      } catch (err) {
        console.error("[HotelContext] Failed to load data from Supabase:", err);
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, []);

  // ── Booking actions ─────────────────────────────────────────

  function createBooking(booking: MockBooking) {
    // Capture current room status before the optimistic update so we can
    // restore it if the service layer rejects (e.g. overlap race condition).
    const prevRoomStatus = rooms.find(r => r.roomNumber === booking.roomNumber)?.status;

    // 1. Optimistic: show in UI immediately
    setBookings(prev => [booking, ...prev]);
    setNextBookingId(n => n + 1);
    setRooms(prev =>
      prev.map(r =>
        r.roomNumber === booking.roomNumber ? { ...r, status: "Reserved" as RoomStatus } : r
      )
    );

    // 2. Persist to Supabase in the background.
    // bookingsService.createBooking() runs a DB-level overlap check (Layer C)
    // before the INSERT.  On any failure (including double-booking), we roll
    // back the optimistic update so the phantom booking never stays in the UI.
    bookingsService.createBooking(booking).catch(err => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[HotelContext createBooking] failed — rolling back optimistic update:", msg);

      // Roll back: remove the booking and restore the room status
      setBookings(prev => prev.filter(b => b.id !== booking.id));
      setNextBookingId(n => n - 1);
      if (prevRoomStatus !== undefined) {
        setRooms(prev =>
          prev.map(r =>
            r.roomNumber === booking.roomNumber
              ? { ...r, status: prevRoomStatus }
              : r
          )
        );
      }
    });
  }

  function changeBookingStatus(id: string, newStatus: BookingStatus) {
    const target = bookings.find(b => b.id === id);
    if (!target) return;

    // 1. Optimistic: update booking + stamp timestamps + sync room status
    const now = new Date().toISOString();
    setBookings(prev =>
      prev.map(b => {
        if (b.id !== id) return b;
        const ts: Partial<MockBooking> = {};
        if (newStatus === "Checked In"  && !b.checkedInAt)  ts.checkedInAt  = now;
        if (newStatus === "Checked Out" && !b.checkedOutAt) ts.checkedOutAt = now;
        return { ...b, status: newStatus, ...ts };
      })
    );
    const newRoomStatus = bookingsService.bookingToRoomStatus(newStatus);
    if (newRoomStatus) {
      setRooms(prev =>
        prev.map(r =>
          r.roomNumber === target.roomNumber ? { ...r, status: newRoomStatus } : r
        )
      );
    }
    // 2. Persist to Supabase in the background
    bookingsService.updateBookingStatus(id, newStatus).catch(err =>
      console.error("[changeBookingStatus] Supabase error:", err)
    );
  }

  function recordPayment(id: string, additionalAmount: number, callerRole?: string) {
    // ── Final hard wall — cannot be bypassed regardless of UI state ──
    //
    // Pseudo logic (matches component-level guard):
    //   const canAddPayment = callerRole === "admin" || booking.status === "Checked In"
    //   if (!canAddPayment) block and log
    //
    // This runs on the LIVE bookings state inside the context, so it always
    // reflects the true current status — no stale snapshot can fool it.
    const targetBooking = bookings.find(b => b.id === id);
    if (targetBooking) {
      const canAddPayment = callerRole === "admin" || targetBooking.status === "Checked In";
      if (!canAddPayment) {
        console.log("[recordPayment] blocked before check-in", {
          bookingId: id,
          liveStatus: targetBooking.status,
          callerRole: callerRole ?? "unknown",
        });
        return;   // hard stop — no optimistic update, no Supabase write
      }
      // Admin paying before check-in: allowed, audit log only
      if (callerRole === "admin" && targetBooking.status !== "Checked In") {
        console.warn(
          `[recordPayment] admin payment before check-in — booking ${id}` +
          ` (status: "${targetBooking.status}") — proceeding as admin override`
        );
      }
    }

    // 1. Optimistic: update paid amount + re-derive payment status.
    //    No artificial cap — UI validation ensures amount ≤ finalPayable.
    //    Extra charges can push the total above totalAmount, so capping here
    //    would incorrectly prevent full payment during the checkout flow.
    setBookings(prev =>
      prev.map(b => {
        if (b.id !== id) return b;
        const newPaid   = b.amountPaid + additionalAmount;
        const newStatus = bookingsService.derivePaymentStatus(b.totalAmount, newPaid);
        return { ...b, amountPaid: newPaid, payment: newStatus };
      })
    );
    // 2. Persist to Supabase in the background
    bookingsService.recordPayment(id, additionalAmount).catch(err => {
      console.error("[HotelContext recordPayment] failed:", err instanceof Error ? err.message : err);
    });
  }

  function checkoutNormal(
    id: string,
    extraChargeAmount: number,
    extraChargeReason: string | null,
    actualCheckoutDate: string,
    earlyNightsDeducted: number,
    earlyDeductionAmount: number,
    additionalDiscountAmount: number,
    additionalDiscountReason: string | null,
  ) {
    const target = bookings.find(b => b.id === id);
    if (!target) return;

    // Capture current state so we can roll back if the DB write fails.
    const previousBookings = bookings;
    const previousRooms    = rooms;

    const now        = new Date().toISOString();
    const discountBy = user?.id ?? null;
    setBookings(prev =>
      prev.map(b =>
        b.id === id
          ? {
              ...b,
              status:       "Checked Out" as BookingStatus,
              checkedOutAt: now,
              extraChargeAmount:        extraChargeAmount > 0        ? extraChargeAmount        : undefined,
              extraChargeReason:        extraChargeReason            || undefined,
              actualCheckoutDate:       actualCheckoutDate           || undefined,
              earlyNightsDeducted:      earlyNightsDeducted  > 0     ? earlyNightsDeducted      : undefined,
              earlyDeductionAmount:     earlyDeductionAmount > 0     ? earlyDeductionAmount     : undefined,
              additionalDiscountAmount: additionalDiscountAmount > 0 ? additionalDiscountAmount : undefined,
              additionalDiscountReason: additionalDiscountReason     || undefined,
              additionalDiscountBy:     discountBy                   ?? undefined,
              additionalDiscountAt:     now,
            }
          : b
      )
    );
    setRooms(prev =>
      prev.map(r =>
        r.roomNumber === target.roomNumber ? { ...r, status: "Cleaning" as RoomStatus } : r
      )
    );
    bookingsService.checkoutNormal(
      id,
      extraChargeAmount,
      extraChargeReason,
      actualCheckoutDate,
      earlyNightsDeducted,
      earlyDeductionAmount,
      additionalDiscountAmount,
      additionalDiscountReason,
      discountBy,
    ).catch(err => {
      setBookings(previousBookings);
      setRooms(previousRooms);
      console.error("[HotelContext checkoutNormal] failed — rolled back:", err instanceof Error ? err.message : err);
    });
  }

  function checkoutWithOverride(
    id: string,
    overrideReason: string,
    extraChargeAmount?: number,
    extraChargeReason?: string | null,
    actualCheckoutDate?: string,
    earlyNightsDeducted?: number,
    earlyDeductionAmount?: number,
    additionalDiscountAmount?: number,
    additionalDiscountReason?: string | null,
  ) {
    const target = bookings.find(b => b.id === id);
    if (!target) return;

    // Require a real auth user — never send null as the auditor.
    const overrideBy = user?.id;
    if (!overrideBy) {
      console.error("[HotelContext checkoutWithOverride] blocked — no authenticated user id available.");
      return;
    }

    // Capture current state so we can roll back if the DB write fails.
    const previousBookings = bookings;
    const previousRooms    = rooms;

    const now        = new Date().toISOString();
    const discountBy = user?.id ?? null;
    const override: CheckoutOverride = {
      used:           true,
      reason:         overrideReason.trim() || "No reason provided",
      by:             overrideBy,
      overrideUsedAt: now,
    };
    setBookings(prev =>
      prev.map(b =>
        b.id === id
          ? {
              ...b,
              status:       "Checked Out" as BookingStatus,
              checkedOutAt: now,
              checkoutOverride: override,
              extraChargeAmount:        extraChargeAmount && extraChargeAmount > 0                             ? extraChargeAmount        : undefined,
              extraChargeReason:        extraChargeReason                                                      || undefined,
              actualCheckoutDate:       actualCheckoutDate                                                     ?? undefined,
              earlyNightsDeducted:      earlyNightsDeducted  !== undefined && earlyNightsDeducted  > 0         ? earlyNightsDeducted      : undefined,
              earlyDeductionAmount:     earlyDeductionAmount !== undefined && earlyDeductionAmount > 0         ? earlyDeductionAmount     : undefined,
              additionalDiscountAmount: additionalDiscountAmount !== undefined && additionalDiscountAmount > 0 ? additionalDiscountAmount : undefined,
              additionalDiscountReason: additionalDiscountReason                                               ?? undefined,
              additionalDiscountBy:     discountBy                                                             ?? undefined,
              additionalDiscountAt:     now,
            }
          : b
      )
    );
    setRooms(prev =>
      prev.map(r =>
        r.roomNumber === target.roomNumber ? { ...r, status: "Cleaning" as RoomStatus } : r
      )
    );
    bookingsService.checkoutWithOverride(
      id,
      overrideReason,
      overrideBy,
      extraChargeAmount,
      extraChargeReason,
      actualCheckoutDate,
      earlyNightsDeducted,
      earlyDeductionAmount,
      additionalDiscountAmount,
      additionalDiscountReason,
      discountBy,
    ).catch(err => {
      setBookings(previousBookings);
      setRooms(previousRooms);
      console.error("[HotelContext checkoutWithOverride] failed — rolled back:", err instanceof Error ? err.message : err);
    });
  }

  // ── Room actions ────────────────────────────────────────────

  function addRoom(room: MockRoom) {
    // 1. Optimistic: add the room with a placeholder id so the UI responds instantly.
    setRooms(prev => [...prev, room]);
    setNextRoomId(n => n + 1);

    // 2. Persist to Supabase, then replace the placeholder id with the real UUID.
    //
    // WHY this matters: every subsequent updateRoom / deleteRoom call uses room.id
    // as the Supabase WHERE clause. If the placeholder id stays in state, those calls
    // send "pending-..." to Supabase, which rejects it as an invalid UUID.
    roomsService.addRoom(room)
      .then(savedRoom => {
        // Swap the placeholder out for the real row returned by Supabase.
        // From this point forward, the room in state has a genuine UUID.
        setRooms(prev => prev.map(r => r.id === room.id ? savedRoom : r));
        console.log("[HotelContext addRoom] placeholder replaced with real UUID:", savedRoom.id);
      })
      .catch(err => {
        // Insert failed — roll back the optimistic add so stale data isn't shown.
        setRooms(prev => prev.filter(r => r.id !== room.id));
        console.error("[HotelContext addRoom] failed, rolled back:", err instanceof Error ? err.message : err);
      });
  }

  function updateRoom(id: string, updates: Partial<Omit<MockRoom, "id" | "status">>) {
    // Guard: if somehow a placeholder id slips through, abort immediately.
    // Real Supabase UUIDs are 36 characters (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).
    if (!id || id.startsWith("pending-") || id.startsWith("room-")) {
      console.error("[HotelContext updateRoom] blocked — fake id detected:", id,
        "— room was likely added before Supabase returned the real UUID.");
      return;
    }

    console.log("[HotelContext updateRoom] sending to Supabase, id:", id);

    // 1. Optimistic: update in list immediately
    setRooms(prev =>
      prev.map(r => (r.id === id ? { ...r, ...updates } : r))
    );
    // 2. Persist to Supabase in the background
    roomsService.updateRoom(id, updates).catch(err => {
      console.error("[HotelContext updateRoom] failed:", err instanceof Error ? err.message : err);
    });
  }

  function deleteRoom(id: string) {
    // 1. Optimistic: remove from list immediately
    setRooms(prev => prev.filter(r => r.id !== id));
    // 2. Persist to Supabase in the background
    roomsService.deleteRoom(id).catch(err =>
      console.error("[deleteRoom] Supabase error:", err)
    );
  }

  return (
    <HotelContext.Provider value={{
      rooms,
      bookings,
      loading,
      nextBookingId,
      nextRoomId,
      createBooking,
      changeBookingStatus,
      checkoutNormal,
      checkoutWithOverride,
      addRoom,
      updateRoom,
      deleteRoom,
      recordPayment,
    }}>
      {children}
    </HotelContext.Provider>
  );
}

// ─────────────────────────────────────────────────────────────
// HOOK
// ─────────────────────────────────────────────────────────────
export function useHotel(): HotelContextType {
  const ctx = useContext(HotelContext);
  if (!ctx) throw new Error("useHotel() must be called inside <HotelProvider>");
  return ctx;
}
