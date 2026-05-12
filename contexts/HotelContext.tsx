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
  PaymentMethod,
  CheckoutOverride,
  CreateBookingInput,
  BookingRoom,
  BookingRoomStatus,
} from "@/lib/mockData";

import * as roomsService    from "@/services/roomsService";
import * as bookingsService from "@/services/bookingsService";
import type { UpdateBookingPayload, BulkCheckinResult } from "@/services/bookingsService";

// Re-export types and ROOM_CATALOG so other files keep working unchanged.
export type { MockRoom as Room, MockBooking as Booking, RoomStatus, BookingStatus };
export type { PaymentStatus, CheckoutOverride } from "@/lib/mockData";
export { ROOM_CATALOG } from "@/lib/mockData";
// NOTE: ROOM_CATALOG is still exported from mockData for now so the booking form
// can suggest room prices and categories. When the rooms table is stable, replace
// with a derived map from the live `rooms` state.

// ─────────────────────────────────────────────────────────────
// PRIVATE HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * ISO "YYYY-MM-DD" → display "Apr 22, 2026".
 * Used to build optimistic display dates from CreateBookingInput ISO fields.
 * Appends T12:00:00 to avoid UTC midnight rollback in UTC+ timezones.
 * Same logic as formatDate in BookingsClient — duplicated here to keep
 * HotelContext free of UI-layer imports.
 */
function formatDateDisplay(isoDate: string): string {
  return new Date(`${isoDate}T12:00:00`).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

// ─────────────────────────────────────────────────────────────
// CONTEXT TYPE
// ─────────────────────────────────────────────────────────────
type HotelContextType = {
  rooms:               MockRoom[];
  bookings:            MockBooking[];
  loading:             boolean;           // true while initial data is being fetched
  nextBookingId:       number;
  nextRoomId:          number;
  createBooking:       (input: CreateBookingInput)                                => void;
  changeBookingStatus: (id: string, status: BookingStatus)                        => void;
  addRoom:             (room: MockRoom)                                            => void;
  updateRoom:          (id: string, updates: Partial<Omit<MockRoom, "id"|"status">>) => void;
  deleteRoom:          (id: string)                                                => void;
  /** Flip a Cleaning room back to Available. Intentionally narrow API for now;
   *  a generic updateRoomStatus belongs in the Day 3 housekeeping module. */
  markRoomAvailable:   (roomNumber: string)                                        => Promise<void>;
  recordPayment:       (id: string, additionalAmount: number, method: PaymentMethod, callerRole?: string) => void;
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
    paymentMethod?: PaymentMethod,
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
    paymentMethod?: PaymentMethod,
  ) => void;
  /** Edit a booking's fields. Optimistic update + rollback on service failure. */
  updateBooking: (
    bookingRef: string,
    changes: UpdateBookingPayload,
    original: MockBooking,
  ) => void;
  /** Append a new room to an existing confirmed/checked-in booking. */
  addRoomToBooking: (
    bookingRef:  string,
    roomNumber:  string,
    checkIn:     string,
    checkOut:    string,
    bookingRate: number,
  ) => void;
  /** Cancel a confirmed room or mark a checked-in room as early departure. */
  cancelBookingRoom: (
    bookingRoomId:       string,
    status:              "Cancelled" | "Checked Out Early",
    actualCheckOut?:     string,
    refundAmount?:       number,
    refundReason?:       string,
    // Phase 8.6: atomic disbursement
    disbursementMethod?: PaymentMethod,
    disbursementNotes?:  string,
    disbursedBy?:        string,
  ) => Promise<void>;
  /** Extend a room's check-out date past its current scheduled date. */
  extendBookingRoom: (
    bookingRoomId: string,
    newCheckOut:   string,
  ) => void;
  /** Check in a single confirmed room within a booking. Pass forceFuture=true to bypass the future-date guard (Phase 11 #10). */
  checkinBookingRoom: (bookingRoomId: string, forceFuture?: boolean) => void;
  /** Bulk check in multiple confirmed rooms. Returns the RPC result including any per-room failures. */
  bulkCheckinBookingRooms: (
    roomIds:      string[],
    forceFuture?: boolean,
  ) => Promise<BulkCheckinResult>;
  /**
   * Mark a pending refund as disbursed. Optimistically decrements
   * booking.amountPaid; rolls back on failure.
   */
  disburseRefund: (
    bookingRef:   string,
    refundId:     string,
    refundAmount: number,
    method:       PaymentMethod,
    notes:        string | null,
  ) => Promise<void>;
  /** Mark a pending refund as denied. No booking-level state change. */
  denyRefund: (refundId: string, reason: string) => Promise<void>;
  /**
   * Cancel all confirmed rooms in a booking atomically. Optimistically
   * flips rooms and booking to Cancelled, physical rooms to Available.
   * Rolls back on failure.
   */
  cancelBooking: (
    bookingRef:          string,
    refundAmount?:       number | null,
    refundReason?:       string | null,
    // Phase 8.6: atomic disbursement
    disbursementMethod?: PaymentMethod | null,
    disbursementNotes?:  string | null,
    disbursedBy?:        string | null,
  ) => Promise<void>;
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

  function createBooking(input: CreateBookingInput) {
    // Capture pre-update room statuses for rollback (supports N rooms).
    const prevRoomStatuses = new Map<string, RoomStatus | undefined>(
      input.rooms.map(r => [
        r.roomNumber,
        rooms.find(room => room.roomNumber === r.roomNumber)?.status,
      ]),
    );

    // Build optimistic MockBooking from CreateBookingInput for immediate UI display.
    // rooms[] is populated with synthetic BookingRoom objects so the bookings list
    // and drawer can render immediately. The .then() handler replaces this entire
    // object with the real DB-fetched booking once the service resolves, giving
    // subsequent actions (checkout, edit) the real booking_rooms.id UUIDs.
    const r0 = input.rooms[0];
    const optimisticRooms: BookingRoom[] = input.rooms.map((r, i) => ({
      id:           `optimistic-${input.id}-room-${i}`,
      bookingId:    input.id,
      roomId:       "",                                       // unknown until service resolves
      roomNumber:   r.roomNumber,
      roomCategory: r.roomCategory,
      checkIn:      formatDateDisplay(r.checkIn),
      checkOut:     formatDateDisplay(r.checkOut),
      checkInISO:   r.checkIn,
      checkOutISO:  r.checkOut,
      nights:       r.nights,
      bookingRate:  r.bookingRate,
      status:       "Confirmed" as BookingRoomStatus,
      earlyNightsDeducted:  0,
      earlyDeductionAmount: 0,
    }));

    const optimisticBooking: MockBooking = {
      id:               input.id,
      guestName:        input.primaryGuest.name,
      phone:            input.primaryGuest.phone,
      email:            input.primaryGuest.email,
      guestId:          undefined,
      roomNumber:       r0.roomNumber,
      roomCategory:     r0.roomCategory,
      checkIn:          formatDateDisplay(r0.checkIn),
      checkOut:         formatDateDisplay(r0.checkOut),
      checkInISO:       r0.checkIn,
      checkOutISO:      r0.checkOut,
      nights:           r0.nights,
      status:           input.status,
      payment:          bookingsService.derivePaymentStatus(input.totalAmount, input.amountPaid, input.status),
      totalAmount:      input.totalAmount,
      amountPaid:       input.amountPaid,
      totalGuests:      input.totalGuests,
      additionalGuests: input.additionalGuests,
      fixedRate:        r0.fixedRate   > 0 ? r0.fixedRate   : undefined,
      bookingRate:      r0.bookingRate > 0 ? r0.bookingRate : undefined,
      lastPaymentMethod: input.amountPaid > 0 ? input.amountPaidMethod : undefined,
      rooms:            optimisticRooms,
      extraCharges:     [],
      createdAt:        new Date().toISOString(),
      isNew:            true,
    };

    // 1. Optimistic: show in UI immediately
    setBookings(prev => [optimisticBooking, ...prev]);
    setNextBookingId(n => n + 1);
    setRooms(prev =>
      prev.map(r =>
        prevRoomStatuses.has(r.roomNumber) ? { ...r, status: "Reserved" as RoomStatus } : r
      )
    );

    // 2. Persist to Supabase.
    //    .then() — replace optimistic booking with real once service resolves.
    //              Gives subsequent actions (checkout, edit) the real booking_rooms.id.
    //    .catch() — roll back all optimistic changes on any failure (overlap race,
    //               network error, RPC failure, etc.).
    bookingsService.createBooking(input)
      .then(realBooking => {
        setBookings(prev => prev.map(b => b.id === input.id ? realBooking : b));
      })
      .catch(err => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[HotelContext createBooking] failed — rolling back optimistic update:", msg);

        setBookings(prev => prev.filter(b => b.id !== input.id));
        setNextBookingId(n => n - 1);
        for (const [roomNumber, prevStatus] of prevRoomStatuses) {
          if (prevStatus !== undefined) {
            setRooms(prev =>
              prev.map(r => r.roomNumber === roomNumber ? { ...r, status: prevStatus } : r)
            );
          }
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

        // Cascade booking_rooms.status for confirmed ↔ checked_in transitions.
        // The checkin_booking_atomic RPC does this atomically in the DB; here
        // we mirror it immediately so the edit modal lock state is correct
        // without a full reload.
        // For checkout/cancel the existing RPC paths own the cascade — the
        // authoritative data arrives via the next fetch; we leave those rows
        // alone in the optimistic layer.
        let updatedRooms = b.rooms;
        if (newStatus === "Checked In" || newStatus === "Confirmed") {
          const targetRoomStatus: BookingRoomStatus =
            newStatus === "Checked In" ? "Checked In" : "Confirmed";
          updatedRooms = b.rooms.map(r =>
            // Only cascade rows that are in the expected source state —
            // same guard the RPC uses, so terminal rows (cancelled, etc.) stay.
            (r.status === "Confirmed" || r.status === "Checked In")
              ? { ...r, status: targetRoomStatus }
              : r
          );
        }

        return { ...b, status: newStatus, rooms: updatedRooms, ...ts };
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

  function recordPayment(id: string, additionalAmount: number, method: PaymentMethod, callerRole?: string) {
    // ── Final hard wall — cannot be bypassed regardless of UI state ──
    //
    // Pseudo logic (matches component-level guard):
    //   const canAddPayment = callerRole === "admin" || booking.status === "Checked In"
    //   if (!canAddPayment) block and log
    //
    // This runs on the LIVE bookings state inside the context, so it always
    // reflects the true current status — no stale snapshot can fool it.
    //
    // NOTE: These guards run BEFORE prevBookings is captured so the early-return
    // path never creates a snapshot that could interfere with other state updates.
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

    // Capture state for rollback — after guards so early-returns don't snapshot.
    const prevBookings = bookings;

    // 1. Optimistic: update paid amount, re-derive payment status, and set
    //    lastPaymentMethod immediately so the UI reflects the new method without
    //    waiting for the fn_sync_last_payment_method DB trigger to fire.
    //    No artificial cap — UI validation ensures amount ≤ finalPayable.
    //    Extra charges can push the total above totalAmount, so capping here
    //    would incorrectly prevent full payment during the checkout flow.
    setBookings(prev =>
      prev.map(b => {
        if (b.id !== id) return b;
        const newPaid   = b.amountPaid + additionalAmount;
        const newStatus = bookingsService.derivePaymentStatus(b.totalAmount, newPaid, b.status);
        return { ...b, amountPaid: newPaid, payment: newStatus, lastPaymentMethod: method };
      })
    );
    // 2. Persist to Supabase in the background. Roll back if persist fails —
    //    prevBookings restores amountPaid, payment status, AND lastPaymentMethod.
    bookingsService.recordPayment(id, additionalAmount, method).catch(err => {
      setBookings(prevBookings);
      console.error("[HotelContext recordPayment] failed — rolled back:", err instanceof Error ? err.message : err);
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
    paymentMethod?: PaymentMethod,
  ) {
    const target = bookings.find(b => b.id === id);
    if (!target) return;

    // Guard FIRST — before any state mutation.
    // target.rooms?.[0]?.id: optional chain on rooms handles the case where the booking
    // was loaded from state before Phase 3 (rooms property absent) or was created
    // with old code that didn't insert a booking_rooms row (rooms: []).
    // If no bookingRoomId, bail without touching state — no UI corruption, no DB call.
    const bookingRoomId = target.rooms?.[0]?.id ?? "";
    if (!bookingRoomId) {
      console.error(
        `[HotelContext checkoutNormal] booking ${id} has no booking_rooms row — ` +
        "cannot complete checkout. Refresh the page to reload room data."
      );
      return;
    }

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
              // Set lastPaymentMethod immediately if a modal payment was made at checkout,
              // so the drawer reflects it without waiting for the DB trigger.
              ...(paymentMethod !== undefined && { lastPaymentMethod: paymentMethod }),
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
      bookingRoomId,
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
    paymentMethod?: PaymentMethod,
  ) {
    const target = bookings.find(b => b.id === id);
    if (!target) return;

    // Require a real auth user — never send null as the auditor.
    const overrideBy = user?.id;
    if (!overrideBy) {
      console.error("[HotelContext checkoutWithOverride] blocked — no authenticated user id available.");
      return;
    }

    // Guard FIRST — before any state mutation. Same rationale as checkoutNormal above.
    const bookingRoomId = target.rooms?.[0]?.id ?? "";
    if (!bookingRoomId) {
      console.error(
        `[HotelContext checkoutWithOverride] booking ${id} has no booking_rooms row — ` +
        "cannot complete checkout. Refresh the page to reload room data."
      );
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
              // Set lastPaymentMethod immediately if a modal payment was made at checkout,
              // so the drawer reflects it without waiting for the DB trigger.
              ...(paymentMethod !== undefined && { lastPaymentMethod: paymentMethod }),
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
      bookingRoomId,
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

  function updateBooking(
    bookingRef: string,
    changes: UpdateBookingPayload,
    original: MockBooking,
  ) {
    const prevBookings = bookings;
    const prevRooms    = rooms;

    // Rooms that changed number (for room-status cascade in optimistic update)
    const roomNumberChanges: Array<{ from: string; to: string }> =
      (changes.rooms ?? [])
        .map(rc => {
          const origRoom = original.rooms.find(br => br.id === rc.id);
          if (!origRoom || rc.roomNumber === origRoom.roomNumber) return null;
          return { from: origRoom.roomNumber, to: rc.roomNumber };
        })
        .filter((x): x is { from: string; to: string } => x !== null);

    setBookings(prev =>
      prev.map(b => {
        if (b.id !== bookingRef) return b;
        const patch: Partial<MockBooking> = {};
        // Booking-level fields
        if (changes.guestName    !== undefined) patch.guestName    = changes.guestName;
        if (changes.phone        !== undefined) patch.phone        = changes.phone;
        if (changes.email !== undefined && changes.email.trim() !== "")
          patch.email = changes.email.trim();
        if (changes.totalAmount  !== undefined) {
          // NOTE: total_amount is server-computed from booking_rooms after update
          // (updateBooking Step 5 recompute). This optimistic value is replaced
          // when updateBooking resolves and the booking is patched with the
          // authoritative re-fetched data in the .then() handler below.
          patch.totalAmount = changes.totalAmount;
          patch.payment = bookingsService.derivePaymentStatus(changes.totalAmount, b.amountPaid, b.status);
        }
        if (changes.totalGuests      !== undefined) patch.totalGuests      = changes.totalGuests;
        if (changes.additionalGuests !== undefined) patch.additionalGuests = changes.additionalGuests;

        // Per-room optimistic update — patch matching BookingRoom entries
        if (changes.rooms && changes.rooms.length > 0) {
          patch.rooms = b.rooms.map(br => {
            const rc = changes.rooms!.find(r => r.id === br.id);
            if (!rc) return br;
            const newCheckIn  = rc.checkInISO;
            const newCheckOut = rc.checkOutISO;
            return {
              ...br,
              roomNumber:   rc.roomNumber,
              roomCategory: rc.roomCategory.charAt(0).toUpperCase() + rc.roomCategory.slice(1),
              checkInISO:   newCheckIn,
              checkOutISO:  newCheckOut,
              checkIn:  new Date(`${newCheckIn}T12:00:00`)
                .toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
              checkOut: new Date(`${newCheckOut}T12:00:00`)
                .toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
              nights:      rc.nights,
              bookingRate: rc.bookingRate,
            };
          });
          // Refresh backward-compat shims from rooms[0]
          const r0 = patch.rooms[0];
          if (r0) {
            patch.roomNumber   = r0.roomNumber;
            patch.roomCategory = r0.roomCategory;
            patch.checkInISO   = r0.checkInISO;
            patch.checkOutISO  = r0.checkOutISO;
            patch.checkIn      = r0.checkIn;
            patch.checkOut     = r0.checkOut;
            patch.nights       = patch.rooms.reduce((s, r) => s + r.nights, 0);
          }
        }

        return { ...b, ...patch };
      })
    );

    if (roomNumberChanges.length > 0) {
      setRooms(prev =>
        prev.map(r => {
          const freed = roomNumberChanges.find(rc => rc.from === r.roomNumber);
          const taken = roomNumberChanges.find(rc => rc.to   === r.roomNumber);
          if (freed) {
            const hasOtherActive = bookings.some(
              b => b.id !== bookingRef &&
                   b.rooms.some(br => br.roomNumber === r.roomNumber &&
                     (br.status === "Confirmed" || br.status === "Checked In"))
            );
            return { ...r, status: (hasOtherActive ? "Reserved" : "Available") as RoomStatus };
          }
          if (taken) {
            const newStatus = bookingsService.bookingToRoomStatus(original.status) ?? "Reserved";
            return { ...r, status: newStatus };
          }
          return r;
        })
      );
    }

    bookingsService.updateBooking(bookingRef, changes, original.guestId).catch(err => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[HotelContext updateBooking] failed — rolling back:", msg);
      setBookings(prevBookings);
      setRooms(prevRooms);
    });
  }

  // ── Mid-stay operations (Phase 7) ──────────────────────────

  function addRoomToBooking(
    bookingRef:  string,
    roomNumber:  string,
    checkIn:     string,
    checkOut:    string,
    bookingRate: number,
  ) {
    const target = bookings.find(b => b.id === bookingRef);
    if (!target) return;

    const hotelRoom = rooms.find(r => r.roomNumber === roomNumber);
    const prevRoomStatus = hotelRoom?.status;

    // Compute nights inline (no import needed)
    const nights = Math.max(
      0,
      Math.floor((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86_400_000),
    );

    // Optimistic: append a synthetic BookingRoom so the drawer updates immediately
    const optimisticRoom: BookingRoom = {
      id:           `optimistic-${crypto.randomUUID()}`,
      bookingId:    target.id,
      roomId:       hotelRoom?.id ?? "",
      roomNumber,
      roomCategory: hotelRoom?.category ?? "",
      checkIn:      formatDateDisplay(checkIn),
      checkOut:     formatDateDisplay(checkOut),
      checkInISO:   checkIn,
      checkOutISO:  checkOut,
      nights,
      bookingRate,
      status:       "Confirmed" as BookingRoomStatus,
      earlyNightsDeducted:  0,
      earlyDeductionAmount: 0,
    };
    const newTotal = target.totalAmount + bookingRate * nights;

    setBookings(prev =>
      prev.map(b => b.id !== bookingRef ? b : {
        ...b,
        rooms:       [...b.rooms, optimisticRoom],
        totalAmount: newTotal,
        payment:     bookingsService.derivePaymentStatus(newTotal, b.amountPaid, b.status),
      })
    );
    setRooms(prev =>
      prev.map(r => r.roomNumber === roomNumber ? { ...r, status: "Reserved" as RoomStatus } : r)
    );

    bookingsService.addRoomToBooking(bookingRef, roomNumber, checkIn, checkOut, bookingRate)
      .then(() => bookingsService.getBookingByRef(bookingRef))
      .then(updated => {
        if (!updated) return;
        setBookings(prev => prev.map(b => b.id === bookingRef ? updated : b));
      })
      .catch(err => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[HotelContext addRoomToBooking] failed — rolling back:", msg);
        setBookings(prev => prev.map(b => b.id === bookingRef ? target : b));
        if (hotelRoom && prevRoomStatus !== undefined) {
          setRooms(prev =>
            prev.map(r => r.roomNumber === roomNumber ? { ...r, status: prevRoomStatus } : r)
          );
        }
      });
  }

  function cancelBookingRoom(
    bookingRoomId:       string,
    status:              "Cancelled" | "Checked Out Early",
    actualCheckOut?:     string,
    refundAmount?:       number,
    refundReason?:       string,
    disbursementMethod?: PaymentMethod,
    disbursementNotes?:  string,
    disbursedBy?:        string,
  ) {
    const target = bookings.find(b => b.rooms.some(r => r.id === bookingRoomId));
    if (!target) return Promise.resolve();
    const prevBookings = bookings;

    const dbStatus = status === "Cancelled" ? "cancelled" : "checked_out_early";

    // Optimistic: update the matching room's status
    const updatedRooms = target.rooms.map(r => {
      if (r.id !== bookingRoomId) return r;
      const patch: Partial<BookingRoom> = { status };
      if (actualCheckOut) {
        const earlyNights = Math.max(
          0,
          Math.floor((new Date(r.checkOutISO ?? "").getTime() - new Date(actualCheckOut).getTime()) / 86_400_000),
        );
        patch.checkOutISO  = actualCheckOut;
        patch.checkOut     = formatDateDisplay(actualCheckOut);
        patch.nights       = r.nights - earlyNights;
        patch.earlyNightsDeducted  = earlyNights;
        patch.earlyDeductionAmount = earlyNights * r.bookingRate;
      }
      return { ...r, ...patch };
    });

    // Recompute total excluding cancelled rooms
    const newTotal = updatedRooms
      .filter(r => r.status !== "Cancelled")
      .reduce((s, r) => s + r.bookingRate * r.nights, 0);

    // Derive booking-level status (4-rule per docs/multi-room-design.md § 5)
    const allCancelled  = updatedRooms.every(r => r.status === "Cancelled");
    const anyCheckedIn  = updatedRooms.some(r => r.status === "Checked In");
    const noneActive    = updatedRooms.every(r => r.status !== "Confirmed" && r.status !== "Checked In");
    const newBookingStatus: BookingStatus =
      allCancelled   ? "Cancelled"   :
      anyCheckedIn   ? "Checked In"  :
      noneActive     ? "Checked Out" :
                       "Confirmed";

    setBookings(prev =>
      prev.map(b => b.id !== target.id ? b : {
        ...b,
        rooms:       updatedRooms,
        totalAmount: newTotal,
        payment:     bookingsService.derivePaymentStatus(newTotal, b.amountPaid, newBookingStatus),
        status:      newBookingStatus,
      })
    );

    return bookingsService.cancelBookingRoom(
      bookingRoomId,
      dbStatus as "cancelled" | "checked_out_early",
      actualCheckOut,
      refundAmount       ?? null,
      refundReason       ?? null,
      user?.id           ?? null,
      disbursementMethod ?? null,
      disbursementNotes  ?? null,
      disbursedBy        ?? null,
    )
      .then(() => bookingsService.getBookingByRef(target.id))
      .then(updated => {
        if (!updated) return;
        setBookings(prev => prev.map(b => b.id === target.id ? updated : b));
      })
      .catch(err => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[HotelContext cancelBookingRoom] failed — rolling back:", msg);
        setBookings(prevBookings);
        throw err;
      });
  }

  function extendBookingRoom(
    bookingRoomId: string,
    newCheckOut:   string,
  ) {
    const target = bookings.find(b => b.rooms.some(r => r.id === bookingRoomId));
    if (!target) return;
    const prevBookings = bookings;

    // Optimistic: extend the matching room
    const updatedRooms = target.rooms.map(r => {
      if (r.id !== bookingRoomId) return r;
      const extraNights = Math.max(
        0,
        Math.floor((new Date(newCheckOut).getTime() - new Date(r.checkOutISO ?? "").getTime()) / 86_400_000),
      );
      return {
        ...r,
        checkOutISO: newCheckOut,
        checkOut:    formatDateDisplay(newCheckOut),
        nights:      r.nights + extraNights,
      };
    });

    const newTotal = updatedRooms
      .filter(r => r.status !== "Cancelled")
      .reduce((s, r) => s + r.bookingRate * r.nights, 0);

    setBookings(prev =>
      prev.map(b => b.id !== target.id ? b : {
        ...b,
        rooms:       updatedRooms,
        totalAmount: newTotal,
        payment:     bookingsService.derivePaymentStatus(newTotal, b.amountPaid, b.status),
      })
    );

    bookingsService.extendBookingRoom(bookingRoomId, newCheckOut)
      .then(() => bookingsService.getBookingByRef(target.id))
      .then(updated => {
        if (!updated) return;
        setBookings(prev => prev.map(b => b.id === target.id ? updated : b));
      })
      .catch(err => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[HotelContext extendBookingRoom] failed — rolling back:", msg);
        setBookings(prevBookings);
      });
  }

  function checkinBookingRoom(bookingRoomId: string, forceFuture: boolean = false) {
    const target = bookings.find(b => b.rooms.some(r => r.id === bookingRoomId));
    if (!target) return;
    const prevBookings = bookings;
    const prevRooms    = rooms;

    const now = new Date().toISOString();

    // Optimistic: flip the matching room to Checked In
    const updatedRooms = target.rooms.map(r =>
      r.id !== bookingRoomId
        ? r
        : { ...r, status: "Checked In" as BookingRoomStatus, checkedInAt: now }
    );

    // Derive booking-level status (4-rule per docs/multi-room-design.md § 5)
    const allCancelled = updatedRooms.every(r => r.status === "Cancelled");
    const anyCheckedIn = updatedRooms.some(r => r.status === "Checked In");
    const noneActive   = updatedRooms.every(r => r.status !== "Confirmed" && r.status !== "Checked In");
    const newBookingStatus: BookingStatus =
      allCancelled ? "Cancelled"   :
      anyCheckedIn ? "Checked In"  :
      noneActive   ? "Checked Out" :
                     "Confirmed";

    // Locate the checked-in room in the catalog (for physical-status update)
    const theRoom = updatedRooms.find(r => r.id === bookingRoomId);

    setBookings(prev =>
      prev.map(b => b.id !== target.id ? b : {
        ...b,
        rooms:  updatedRooms,
        status: newBookingStatus,
      })
    );
    if (theRoom) {
      setRooms(prev =>
        prev.map(r =>
          r.roomNumber === theRoom.roomNumber ? { ...r, status: "Occupied" as RoomStatus } : r
        )
      );
    }

    bookingsService.checkinBookingRoom(bookingRoomId, forceFuture)
      .then(() => bookingsService.getBookingByRef(target.id))
      .then(updated => {
        if (!updated) return;
        setBookings(prev => prev.map(b => b.id === target.id ? updated : b));
      })
      .catch(err => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[HotelContext checkinBookingRoom] failed — rolling back:", msg);
        setBookings(prevBookings);
        setRooms(prevRooms);
      });
  }

  async function bulkCheckinBookingRooms(
    roomIds:     string[],
    forceFuture: boolean = false,
  ): Promise<BulkCheckinResult> {
    const result = await bookingsService.bulkCheckinBookingRooms(roomIds, forceFuture);
    if (result.success) {
      const refreshed = await bookingsService.getAllBookings();
      setBookings(refreshed);
    }
    return result;
  }

  // ── Phase 8.5: refund disbursement + whole-booking cancel ──

  function disburseRefund(
    bookingRef:   string,
    refundId:     string,
    refundAmount: number,
    method:       PaymentMethod,
    notes:        string | null,
  ): Promise<void> {
    const target = bookings.find(b => b.id === bookingRef);
    if (!target) return Promise.resolve();
    const prevBookings = bookings;

    // Optimistic: decrement paid_amount by the disbursed refund amount.
    const newAmountPaid = Math.max(0, target.amountPaid - refundAmount);
    setBookings(prev =>
      prev.map(b => b.id !== bookingRef ? b : {
        ...b,
        amountPaid: newAmountPaid,
        payment:    bookingsService.derivePaymentStatus(b.totalAmount, newAmountPaid, b.status),
      })
    );

    return bookingsService.disburseRefund(refundId, method, user?.id ?? "", notes)
      .then(() => bookingsService.getBookingByRef(bookingRef))
      .then(updated => {
        if (updated) setBookings(prev => prev.map(b => b.id === bookingRef ? updated : b));
      })
      .catch(err => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[HotelContext disburseRefund] failed — rolling back:", msg);
        setBookings(prevBookings);
        throw err;
      });
  }

  function denyRefund(refundId: string, reason: string): Promise<void> {
    // No booking-level state change — only the refund row status changes.
    // The Timeline modal handles the optimistic flip and rollback; the
    // context forwards the service call and re-throws so the modal can act.
    return bookingsService.denyRefund(refundId, reason, user?.id ?? "").catch(err => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[HotelContext denyRefund] failed:", msg);
      throw err;   // re-throw — caller (submitDeny) handles rollback + error UI
    });
  }

  function cancelBooking(
    bookingRef:          string,
    refundAmount?:       number | null,
    refundReason?:       string | null,
    disbursementMethod?: PaymentMethod | null,
    disbursementNotes?:  string | null,
    disbursedBy?:        string | null,
  ) {
    const target = bookings.find(b => b.id === bookingRef);
    if (!target) return Promise.resolve();
    const prevBookings = bookings;
    const prevRooms    = rooms;

    // Optimistic: all rooms → Cancelled
    const cancelledRooms = target.rooms.map(r => ({
      ...r,
      status: "Cancelled" as BookingRoomStatus,
    }));

    // Physical rooms → Available
    const cancelledRoomNumbers = new Set(target.rooms.map(r => r.roomNumber));

    // New total = extras only (rooms contribute 0 after cancel, mirrors DB logic)
    const extrasTotal = target.extraCharges.reduce((sum, e) => sum + e.amount, 0);

    setBookings(prev =>
      prev.map(b => b.id !== bookingRef ? b : {
        ...b,
        rooms:       cancelledRooms,
        status:      "Cancelled" as BookingStatus,
        totalAmount: extrasTotal,
        payment:     bookingsService.derivePaymentStatus(extrasTotal, b.amountPaid, "Cancelled"),
      })
    );
    setRooms(prev =>
      prev.map(r =>
        cancelledRoomNumbers.has(r.roomNumber)
          ? { ...r, status: "Available" as RoomStatus }
          : r
      )
    );

    return bookingsService.cancelBooking(
      bookingRef,
      refundAmount       ?? null,
      refundReason       ?? null,
      user?.id           ?? null,
      disbursementMethod ?? null,
      disbursementNotes  ?? null,
      disbursedBy        ?? null,
    )
      .then(() => bookingsService.getBookingByRef(bookingRef))
      .then(updated => {
        if (updated) setBookings(prev => prev.map(b => b.id === bookingRef ? updated : b));
      })
      .catch(err => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[HotelContext cancelBooking] failed — rolling back:", msg);
        setBookings(prevBookings);
        setRooms(prevRooms);
        throw err;
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

  // Intentionally narrow API — only Cleaning → Available today.
  // A generic updateRoomStatus action comes with the Day 3 housekeeping module.
  async function markRoomAvailable(roomNumber: string) {
    setRooms(prev =>
      prev.map(r => r.roomNumber === roomNumber ? { ...r, status: "Available" as const } : r)
    );
    roomsService.setRoomStatus(roomNumber, "Available").catch(err =>
      console.error("[markRoomAvailable] Supabase error:", err)
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
      updateBooking,
      addRoomToBooking,
      cancelBookingRoom,
      extendBookingRoom,
      checkinBookingRoom,
      bulkCheckinBookingRooms,
      disburseRefund,
      denyRefund,
      cancelBooking,
      addRoom,
      updateRoom,
      deleteRoom,
      markRoomAvailable,
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
