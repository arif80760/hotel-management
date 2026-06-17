// lib/categoryNames.ts
//
// Single source for turning a room-category SLUG into its CURRENT display name.
//
// The slug is the stable FK stored on bookings/rooms and returned by the
// analytics / revenue RPCs. Keep the slug in data (badge colours, grouping,
// write-paths all rely on it) and resolve to the name ONLY when rendering text,
// so a category rename shows everywhere without re-stamping old rows. Prices
// stay locked per booking — this only governs the displayed name.

import type { RoomCategory } from "@/services/roomCategoriesService";

/** Build a lookup of lowercased-slug → current category name. */
export function buildCategoryNameMap(categories: RoomCategory[]): Map<string, string> {
  return new Map(categories.map((c) => [c.slug.toLowerCase(), c.name]));
}

/**
 * Resolve a slug — or a capitalized label like "Suite" — to its current name.
 * Lowercases before lookup so it works whether the caller holds the raw slug
 * ("suite") or the capitalized snapshot ("Suite"). Falls back to the input
 * unchanged when the slug isn't in the catalogue (e.g. a deleted category).
 */
export function displayCategory(
  slugOrLabel: string | null | undefined,
  nameMap: Map<string, string>,
): string {
  if (!slugOrLabel) return "";
  return nameMap.get(slugOrLabel.toLowerCase()) ?? slugOrLabel;
}
