# Fix: Navigation Back to Room Board

## Problem
When you click a room from the Room Board → opens Edit modal → close modal → you stay on the Bookings page instead of returning to Room Board.

## Solution
Updated `handleEditCancel()` to detect if you arrived via `?room=` param and navigate back:

```typescript
function handleEditCancel() {
  // If we came from Room Board (?room= param), navigate back there
  if (roomParam) {
    window.location.href = '/';  // Back to Room Board (dashboard)
    return;
  }
  
  setEditTarget(null);
  setEditForm({ ...EMPTY_EDIT_FORM });
  setEditErrors({});
  setEditSaving(false);
}
```

## How It Works
1. **From Room Board**: Click room → URL is `/bookings?room=203` → `roomParam` = "203"
   - Close modal → `handleEditCancel()` detects `roomParam` exists
   - Navigates to `/` (Room Board) ✅

2. **From Bookings Page**: Click Edit on a booking → URL is `/bookings` → `roomParam` = null
   - Close modal → `handleEditCancel()` skips redirect
   - Stays on Bookings page ✅

## What Changed
- Modified `handleEditCancel()` function in BookingsClient.tsx
- All close buttons (X, "Go back", Escape key) now call this function
- Automatic navigation based on origin

## Testing
1. ✅ Click room from Room Board → Edit modal opens
2. ✅ Close modal (X, backdrop, or button) → Returns to Room Board
3. ✅ Click Edit from Bookings list → Edit modal opens
4. ✅ Close modal → Stays on Bookings page
