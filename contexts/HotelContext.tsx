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
  recordPayment:       (id: string, additionalAmount: number)                     => void;
  checkoutWithOverride:(id: string, overrideReason: string)                       => void;
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
    // 1. Optimistic: show in UI immediately
    setBookings(prev => [booking, ...prev]);
    setNextBookingId(n => n + 1);
    setRooms(prev =>
      prev.map(r =>
        r.roomNumber === booking.roomNumber ? { ...r, status: "Reserved" as RoomStatus } : r
      )
    );
    // 2. Persist to Supabase in the background
    // bookingsService.createBooking() logs each step individually before
    // throwing a real Error — so the message here is always readable.
    bookingsService.createBooking(booking).catch(err => {
      console.error("[HotelContext createBooking] failed:", err instanceof Error ? err.message : err);
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

  function recordPayment(id: string, additionalAmount: number) {
    // 1. Optimistic: update paid amount + re-derive payment status
    setBookings(prev =>
      prev.map(b => {
        if (b.id !== id) return b;
        const newPaid   = Math.min(b.amountPaid + additionalAmount, b.totalAmount);
        const newStatus = bookingsService.derivePaymentStatus(b.totalAmount, newPaid);
        return { ...b, amountPaid: newPaid, payment: newStatus };
      })
    );
    // 2. Persist to Supabase in the background
    bookingsService.recordPayment(id, additionalAmount).catch(err => {
      console.error("[HotelContext recordPayment] failed:", err instanceof Error ? err.message : err);
    });
  }

  function checkoutWithOverride(id: string, overrideReason: string) {
    const target = bookings.find(b => b.id === id);
    if (!target) return;

    // Require a real auth user — never send null as the auditor.
    // AppShell guarantees HotelProvider only mounts when user is signed in,
    // so this guard is a safety net rather than an expected path.
    const overrideBy = user?.id;
    if (!overrideBy) {
      console.error("[HotelContext checkoutWithOverride] blocked — no authenticated user id available.");
      return;
    }

    // 1. Optimistic: stamp override record + update statuses
    const now = new Date().toISOString();
    const override: CheckoutOverride = {
      used:           true,
      reason:         overrideReason.trim() || "No reason provided",
      by:             overrideBy,   // real auth UUID (not hardcoded "Admin")
      overrideUsedAt: now,
    };
    setBookings(prev =>
      prev.map(b =>
        b.id === id
          ? { ...b, status: "Checked Out" as BookingStatus, checkedOutAt: now, checkoutOverride: override }
          : b
      )
    );
    setRooms(prev =>
      prev.map(r =>
        r.roomNumber === target.roomNumber ? { ...r, status: "Cleaning" as RoomStatus } : r
      )
    );
    // 2. Persist to Supabase in the background
    bookingsService.checkoutWithOverride(id, overrideReason, overrideBy).catch(err => {
      console.error("[HotelContext checkoutWithOverride] failed:", err instanceof Error ? err.message : err);
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
