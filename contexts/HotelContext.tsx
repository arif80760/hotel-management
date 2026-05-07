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
import type { UpdateBookingPayload } from "@/services/bookingsService";

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
      payment:          bookingsService.derivePaymentStatus(input.totalAmount, input.amountPaid),
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
        const newStatus = bookingsService.derivePaymentStatus(b.totalAmount, newPaid);
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
    const roomChanged =
      changes.roomNumber !== undefined &&
      changes.roomNumber !== original.roomNumber;

    setBookings(prev =>
      prev.map(b => {
        if (b.id !== bookingRef) return b;
        const patch: Partial<MockBooking> = {};
        if (changes.guestName    !== undefined) patch.guestName    = changes.guestName;
        if (changes.phone        !== undefined) patch.phone        = changes.phone;
        if (changes.email !== undefined && changes.email.trim() !== "")
          patch.email = changes.email.trim();
        if (changes.roomNumber   !== undefined) patch.roomNumber   = changes.roomNumber;
        if (changes.roomCategory !== undefined)
          patch.roomCategory =
            changes.roomCategory.charAt(0).toUpperCase() + changes.roomCategory.slice(1);
        if (changes.checkInISO !== undefined) {
          patch.checkInISO = changes.checkInISO;
          patch.checkIn    = new Date(`${changes.checkInISO}T12:00:00`)
            .toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        }
        if (changes.checkOutISO !== undefined) {
          patch.checkOutISO = changes.checkOutISO;
          patch.checkOut    = new Date(`${changes.checkOutISO}T12:00:00`)
            .toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        }
        // nights is a DB GENERATED column — never written directly.
        // Derive optimistically from the new dates for immediate UI feedback.
        if (changes.checkInISO !== undefined || changes.checkOutISO !== undefined) {
          const ci = changes.checkInISO  ?? b.checkInISO  ?? "";
          const co = changes.checkOutISO ?? b.checkOutISO ?? "";
          if (ci && co) {
            patch.nights = Math.max(0, Math.round(
              (new Date(co + "T12:00:00").getTime() - new Date(ci + "T12:00:00").getTime()) / 86400000
            ));
          }
        }
        if (changes.totalAmount  !== undefined) {
          patch.totalAmount = changes.totalAmount;
          patch.payment = bookingsService.derivePaymentStatus(changes.totalAmount, b.amountPaid);
        }
        if (changes.fixedRate    !== undefined) patch.fixedRate    = changes.fixedRate   ?? undefined;
        if (changes.bookingRate  !== undefined) patch.bookingRate  = changes.bookingRate ?? undefined;
        if (changes.totalGuests       !== undefined) patch.totalGuests       = changes.totalGuests;
        if (changes.additionalGuests  !== undefined) patch.additionalGuests  = changes.additionalGuests;
        return { ...b, ...patch };
      })
    );

    if (roomChanged) {
      setRooms(prev =>
        prev.map(r => {
          if (r.roomNumber === original.roomNumber) {
            const hasOtherActive = bookings.some(
              b => b.id !== bookingRef &&
                   b.roomNumber === original.roomNumber &&
                   (b.status === "Confirmed" || b.status === "Checked In")
            );
            return { ...r, status: (hasOtherActive ? "Reserved" : "Available") as RoomStatus };
          }
          if (r.roomNumber === changes.roomNumber) {
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
